import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

import {
  authorizeToolCall,
  buildPolicy,
  filterConnectedSessionsResult,
} from './policy.mjs';

const listenHost = process.env.MCP_GATEWAY_HOST ?? '0.0.0.0';
const listenPort = Number(process.env.MCP_GATEWAY_PORT ?? '3001');
const wahaBaseUrl = process.env.WAHA_BASE_URL ?? 'http://waha:3000';
const sendSession = process.env.WAHA_SEND_SESSION ?? 'indexs';
const keyFile = process.env.WAHA_ADMIN_KEY_FILE ?? '/run/secrets/waha-admin-api-key';
const maxRequestBytes = 2 * 1024 * 1024;
const catalogTtlMs = 60_000;

const adminKey = (await readFile(keyFile, 'utf8')).trim();
if (!adminKey) {
  throw new Error('WAHA admin key file is empty');
}

let catalogCache = null;
let catalogExpiresAt = 0;

function sseResponse(payload) {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function parseBackendPayload(body, contentType) {
  if (contentType.includes('application/json')) {
    return JSON.parse(body);
  }
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) {
      continue;
    }
    return JSON.parse(line.slice(5).trim());
  }
  throw new Error('WAHA MCP returned no JSON-RPC payload');
}

async function postToWaha(payload) {
  const response = await fetch(`${wahaBaseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'X-Api-Key': adminKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(115_000),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`WAHA MCP request failed with HTTP ${response.status}`);
  }
  if (!body) {
    return null;
  }
  return parseBackendPayload(body, response.headers.get('content-type') ?? '');
}

async function getPolicy() {
  const now = Date.now();
  if (catalogCache && now < catalogExpiresAt) {
    return catalogCache;
  }
  const payload = await postToWaha({
    jsonrpc: '2.0',
    id: 'gateway-catalog',
    method: 'tools/list',
    params: {},
  });
  const tools = payload?.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error('WAHA MCP tools catalog is unavailable');
  }
  catalogCache = buildPolicy(tools, sendSession);
  catalogExpiresAt = now + catalogTtlMs;
  return catalogCache;
}

async function getWorkingSessions() {
  const response = await fetch(`${wahaBaseUrl}/api/sessions?all=true`, {
    headers: {
      'X-Api-Key': adminKey,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`WAHA sessions request failed with HTTP ${response.status}`);
  }
  const sessions = await response.json();
  return new Set(
    sessions
      .filter((session) => session?.status === 'WORKING')
      .map((session) => session.name),
  );
}

async function readRequestBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestBytes) {
      throw new Error('Request body is too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeJsonRpcError(response, id, code, message, statusCode = 200) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/event-stream',
  });
  response.end(
    sseResponse({
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        code: code,
        message: message,
      },
    }),
  );
}

async function handleMcp(request, response) {
  let message;
  try {
    const rawBody = await readRequestBody(request);
    message = JSON.parse(rawBody);
  } catch (error) {
    writeJsonRpcError(response, null, -32700, error.message, 400);
    return;
  }

  try {
    if (message.method === 'tools/list') {
      const policy = await getPolicy();
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
      });
      response.end(
        sseResponse({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: policy.exposedTools,
          },
        }),
      );
      return;
    }

    if (message.method === 'tools/call') {
      const policy = await getPolicy();
      const workingSessions = await getWorkingSessions();
      const toolName = message.params?.name;
      const args = message.params?.arguments ?? {};
      const authorization = authorizeToolCall(
        toolName,
        args,
        policy,
        workingSessions,
        sendSession,
      );
      if (!authorization.allowed) {
        writeJsonRpcError(response, message.id, -32602, authorization.reason);
        return;
      }
      let payload = await postToWaha(message);
      if (toolName === 'sessions-list') {
        payload = filterConnectedSessionsResult(payload);
      }
      response.writeHead(200, {
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
      });
      response.end(sseResponse(payload));
      return;
    }

    const payload = await postToWaha(message);
    if (payload === null) {
      response.writeHead(202);
      response.end();
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/event-stream',
    });
    response.end(sseResponse(payload));
  } catch (error) {
    console.error('MCP gateway request failed', {
      method: message?.method,
      error: error.message,
    });
    writeJsonRpcError(response, message?.id, -32603, 'Restricted gateway error');
  }
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('ok');
    return;
  }
  if (request.method === 'GET' && request.url === '/readyz') {
    try {
      await getPolicy();
      await getWorkingSessions();
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('ready');
    } catch {
      response.writeHead(503, { 'Content-Type': 'text/plain' });
      response.end('not ready');
    }
    return;
  }
  if (request.method === 'POST' && request.url === '/mcp') {
    await handleMcp(request, response);
    return;
  }
  response.writeHead(404, { 'Content-Type': 'text/plain' });
  response.end('not found');
});

server.listen(listenPort, listenHost, () => {
  console.log(`Restricted WAHA MCP gateway listening on ${listenHost}:${listenPort}`);
});

