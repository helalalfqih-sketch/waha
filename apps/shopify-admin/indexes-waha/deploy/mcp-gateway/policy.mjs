const SAFE_READ_PREFIXES = [
  'calls-',
  'channels-',
  'chats-',
  'contacts-',
  'groups-',
  'labels-',
  'lids-',
  'presence-',
  'profile-',
  'sessions-',
];

const SAFE_READ_NAMES = new Set(['ping', 'server-status', 'server-version']);

const SEND_TOOL_NAMES = new Set([
  'forward-message',
  'new-message-id',
  'send-buttons',
  'send-buttons-reply',
  'send-contact-vcard',
  'send-event-message',
  'send-file',
  'send-image',
  'send-link-custom-preview',
  'send-list',
  'send-location',
  'send-poll',
  'send-poll-vote',
  'send-seen',
  'send-sticker',
  'send-text',
  'send-video',
  'send-voice',
  'set-reaction',
  'set-star',
  'start-typing',
  'stop-typing',
]);

export function isSafeReadTool(tool) {
  if (tool?.annotations?.readOnlyHint !== true) {
    return false;
  }
  if (SAFE_READ_NAMES.has(tool.name)) {
    return true;
  }
  return SAFE_READ_PREFIXES.some((prefix) => tool.name.startsWith(prefix));
}

export function buildPolicy(tools, sendSession) {
  const readToolNames = new Set();
  const exposedTools = [];
  for (const tool of tools) {
    if (isSafeReadTool(tool)) {
      readToolNames.add(tool.name);
      exposedTools.push(tool);
      continue;
    }
    if (!SEND_TOOL_NAMES.has(tool.name)) {
      continue;
    }
    exposedTools.push({
      ...tool,
      description: `${tool.description} Sending is restricted to WAHA session '${sendSession}'.`,
    });
  }
  return {
    exposedTools: exposedTools,
    readToolNames: readToolNames,
  };
}

export function authorizeToolCall(
  toolName,
  args,
  policy,
  workingSessions,
  sendSession,
) {
  const requestedSession = args?.session;
  if (policy.readToolNames.has(toolName)) {
    if (requestedSession && !workingSessions.has(requestedSession)) {
      return {
        allowed: false,
        reason: `Session '${requestedSession}' is not connected.`,
      };
    }
    return { allowed: true };
  }
  if (!SEND_TOOL_NAMES.has(toolName)) {
    return {
      allowed: false,
      reason: `Tool '${toolName}' is not exposed by the restricted gateway.`,
    };
  }
  if (requestedSession !== sendSession) {
    return {
      allowed: false,
      reason: `Sending is restricted to session '${sendSession}'.`,
    };
  }
  if (!workingSessions.has(sendSession)) {
    return {
      allowed: false,
      reason: `Sending session '${sendSession}' is not connected.`,
    };
  }
  return { allowed: true };
}

export function filterConnectedSessionsResult(payload) {
  const content = payload?.result?.content;
  if (!Array.isArray(content)) {
    return payload;
  }
  for (const item of content) {
    if (item?.type !== 'text' || typeof item.text !== 'string') {
      continue;
    }
    try {
      const document = JSON.parse(item.text);
      const sessions = Array.isArray(document)
        ? document
        : JSON.parse(document.response);
      if (!Array.isArray(sessions)) {
        continue;
      }
      const connectedSessions = sessions.filter(
        (session) => session?.status === 'WORKING',
      );
      if (Array.isArray(document)) {
        item.text = JSON.stringify(connectedSessions);
      } else {
        document.response = JSON.stringify(connectedSessions);
        item.text = JSON.stringify(document);
      }
    } catch {
      continue;
    }
  }
  return payload;
}

