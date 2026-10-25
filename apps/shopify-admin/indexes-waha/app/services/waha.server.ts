import { assertAllowedShop } from './shop-policy.server';

export type WahaSessionStatus =
  | 'STOPPED'
  | 'STARTING'
  | 'SCAN_QR_CODE'
  | 'PASSKEY_REQUIRED'
  | 'PASSKEY_CONFIRMATION_REQUIRED'
  | 'WORKING'
  | 'FAILED';

export interface WahaSessionAccount {
  id: string;
  lid?: string;
  jid?: string;
  pushName: string;
}

export interface WahaSession {
  name: string;
  status: WahaSessionStatus;
  config?: Record<string, unknown>;
  me?: WahaSessionAccount;
  assignedWorker?: string;
  presence?: 'online' | 'offline' | null;
  timestamps?: {
    activity: number | null;
  };
}

export interface WahaQr {
  data: Uint8Array;
  contentType: string;
}

export class WahaRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'WahaRequestError';
    this.status = status;
  }
}

const FETCH_TIMEOUT_MS = 10_000;
const ALLOWED_PRIVATE_HTTP_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  'waha',
  'host.docker.internal',
]);

function getWahaConfig() {
  const baseUrlValue = process.env.WAHA_BASE_URL;
  const apiKey = process.env.WAHA_API_KEY;
  if (!baseUrlValue || !apiKey) {
    throw new WahaRequestError('WAHA server configuration is incomplete');
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    throw new WahaRequestError('WAHA server configuration is invalid');
  }

  if (
    (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') ||
    baseUrl.username ||
    baseUrl.password
  ) {
    throw new WahaRequestError('WAHA server configuration is invalid');
  }

  if (
    baseUrl.protocol === 'http:' &&
    !ALLOWED_PRIVATE_HTTP_HOSTS.has(baseUrl.hostname.toLowerCase())
  ) {
    throw new WahaRequestError('WAHA server configuration is invalid');
  }

  baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/, '')}/`;
  baseUrl.search = '';
  baseUrl.hash = '';

  const sessionName = process.env.WAHA_SESSION_NAME?.trim() || 'default';
  return {
    apiKey: apiKey,
    baseUrl: baseUrl,
    sessionName: sessionName,
  };
}

async function requestWaha<T>(
  path: string,
  init: RequestInit,
  readResponse: (response: Response) => Promise<T>,
): Promise<T> {
  const config = getWahaConfig();
  const controller = new AbortController();
  const timeout = setTimeout(function abortRequest() {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  const headers = new Headers(init.headers);
  headers.set('X-Api-Key', config.apiKey);

  try {
    const response = await fetch(new URL(path, config.baseUrl), {
      ...init,
      headers: headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new WahaRequestError('WAHA request failed', response.status);
    }
    return await readResponse(response);
  } catch (error) {
    if (error instanceof WahaRequestError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new WahaRequestError('WAHA request timed out');
    }
    throw new WahaRequestError('WAHA server is unavailable');
  } finally {
    clearTimeout(timeout);
  }
}

async function readSession(response: Response): Promise<WahaSession> {
  try {
    return (await response.json()) as WahaSession;
  } catch {
    throw new WahaRequestError('WAHA returned an invalid response');
  }
}

function getSessionPath(action?: string): string {
  const config = getWahaConfig();
  const session = encodeURIComponent(config.sessionName);
  if (action) {
    return `api/sessions/${session}/${action}`;
  }
  return `api/sessions/${session}`;
}

export async function getWahaSession(
  shop: string,
): Promise<WahaSession | null> {
  assertAllowedShop(shop);
  try {
    return await requestWaha(getSessionPath(), {}, readSession);
  } catch (error) {
    if (error instanceof WahaRequestError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function createWahaSession(shop: string): Promise<WahaSession> {
  const normalizedShop = assertAllowedShop(shop);
  const config = getWahaConfig();
  return requestWaha(
    'api/sessions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: config.sessionName,
        start: true,
        config: {
          metadata: {
            source: 'shopify',
            shop: normalizedShop,
          },
        },
      }),
    },
    readSession,
  );
}

async function controlWahaSession(
  shop: string,
  action: 'start' | 'stop' | 'restart',
): Promise<WahaSession> {
  assertAllowedShop(shop);
  return requestWaha(
    getSessionPath(action),
    {
      method: 'POST',
    },
    readSession,
  );
}

export function startWahaSession(shop: string): Promise<WahaSession> {
  return controlWahaSession(shop, 'start');
}

export function stopWahaSession(shop: string): Promise<WahaSession> {
  return controlWahaSession(shop, 'stop');
}

export function restartWahaSession(shop: string): Promise<WahaSession> {
  return controlWahaSession(shop, 'restart');
}

export async function getWahaQr(shop: string): Promise<WahaQr> {
  assertAllowedShop(shop);
  const config = getWahaConfig();
  const session = encodeURIComponent(config.sessionName);
  return requestWaha(
    `api/${session}/auth/qr`,
    {
      headers: {
        Accept: 'image/png',
      },
    },
    async function readQr(response: Response): Promise<WahaQr> {
      const maxQrBytes = 512 * 1024;
      const contentType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== 'image/png') {
        throw new WahaRequestError('WAHA returned an invalid QR response');
      }
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxQrBytes) {
        throw new WahaRequestError('WAHA returned an oversized QR response');
      }
      const data = new Uint8Array(await response.arrayBuffer());
      const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
      if (
        data.byteLength > maxQrBytes ||
        data.byteLength < pngSignature.length ||
        !pngSignature.every((byte, index) => data[index] === byte)
      ) {
        throw new WahaRequestError('WAHA returned an invalid QR image');
      }
      return {
        data: data,
        contentType: 'image/png',
      };
    },
  );
}
