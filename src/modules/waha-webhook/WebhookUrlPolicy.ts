import {
  lookup as systemLookup,
  LookupAddress,
  LookupAllOptions,
} from 'node:dns';
import { BlockList, isIP, LookupFunction } from 'node:net';

export const WEBHOOK_ALLOWED_ORIGINS_ENV = 'WAHA_WEBHOOK_ALLOWED_ORIGINS';
export const WEBHOOK_ALLOWED_PRIVATE_ORIGINS_ENV =
  'WAHA_WEBHOOK_ALLOWED_PRIVATE_ORIGINS';
export const WEBHOOK_DESTINATION_ERROR = 'EWEBHOOKDESTINATION';

export interface WebhookDestinationPolicy {
  allowedOrigins: ReadonlySet<string> | null;
  allowedPrivateOrigins: ReadonlySet<string>;
}

export interface ValidatedWebhookDestination {
  allowNonPublicAddress: boolean;
  url: URL;
}

export type ResolveAll = (
  hostname: string,
  options: LookupAllOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
) => void;

const NON_PUBLIC_ADDRESSES = buildNonPublicAddressList();
const IPV4_MAPPED_ADDRESSES = buildIpv4MappedAddressList();
const GLOBAL_UNICAST_IPV6_ADDRESSES = buildGlobalUnicastIpv6AddressList();

export function readWebhookDestinationPolicy(
  env: NodeJS.ProcessEnv = process.env,
): WebhookDestinationPolicy {
  return {
    allowedOrigins: parseOriginList(
      env[WEBHOOK_ALLOWED_ORIGINS_ENV],
      WEBHOOK_ALLOWED_ORIGINS_ENV,
      false,
      true,
    ),
    allowedPrivateOrigins:
      parseOriginList(
        env[WEBHOOK_ALLOWED_PRIVATE_ORIGINS_ENV],
        WEBHOOK_ALLOWED_PRIVATE_ORIGINS_ENV,
        true,
        false,
      ) ?? new Set<string>(),
  };
}

export function validateWebhookDestination(
  value: string,
  policy: WebhookDestinationPolicy = readWebhookDestinationPolicy(),
): ValidatedWebhookDestination {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw webhookDestinationError('Webhook URL is invalid');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw webhookDestinationError('Webhook URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw webhookDestinationError('Webhook URL must not contain credentials');
  }

  const privateOriginAllowed = policy.allowedPrivateOrigins.has(url.origin);
  if (
    policy.allowedOrigins &&
    !policy.allowedOrigins.has(url.origin) &&
    !privateOriginAllowed
  ) {
    throw webhookDestinationError('Webhook origin is not allowed');
  }
  if (url.protocol !== 'https:' && !privateOriginAllowed) {
    throw webhookDestinationError('Webhook URL must use HTTPS');
  }

  const hostname = stripIpv6Brackets(url.hostname);
  if (isLocalHostname(hostname) && !privateOriginAllowed) {
    throw webhookDestinationError(
      'Webhook URL resolves to a non-public address',
    );
  }
  if (
    isIP(hostname) !== 0 &&
    !isPublicNetworkAddress(hostname) &&
    !privateOriginAllowed
  ) {
    throw webhookDestinationError(
      'Webhook URL resolves to a non-public address',
    );
  }

  return {
    allowNonPublicAddress: privateOriginAllowed,
    url: url,
  };
}

export function createWebhookLookup(
  allowNonPublicAddress: boolean,
  resolveAll: ResolveAll = defaultResolveAll,
): LookupFunction {
  return function webhookLookup(hostname, options, callback): void {
    resolveAll(
      hostname,
      {
        ...options,
        all: true,
      },
      (error, addresses) => {
        if (error) {
          callback(error, '', 0);
          return;
        }
        if (addresses.length === 0) {
          callback(
            webhookDestinationError('Webhook hostname did not resolve'),
            '',
            0,
          );
          return;
        }
        if (
          !allowNonPublicAddress &&
          addresses.some((address) => !isPublicNetworkAddress(address.address))
        ) {
          callback(
            webhookDestinationError(
              'Webhook hostname resolved to a non-public address',
            ),
            '',
            0,
          );
          return;
        }

        if (options.all) {
          callback(null, addresses);
          return;
        }
        const address = addresses[0];
        callback(null, address.address, address.family);
      },
    );
  };
}

export function isPublicNetworkAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address);
  const family = isIP(normalized);
  if (family === 4) {
    return !NON_PUBLIC_ADDRESSES.check(normalized, 'ipv4');
  }
  if (family === 6) {
    if (IPV4_MAPPED_ADDRESSES.check(normalized, 'ipv6')) {
      return !NON_PUBLIC_ADDRESSES.check(normalized, 'ipv6');
    }
    return (
      GLOBAL_UNICAST_IPV6_ADDRESSES.check(normalized, 'ipv6') &&
      !NON_PUBLIC_ADDRESSES.check(normalized, 'ipv6')
    );
  }
  return false;
}

export function isWebhookDestinationError(error: any): boolean {
  return (
    error?.code === WEBHOOK_DESTINATION_ERROR ||
    error?.cause?.code === WEBHOOK_DESTINATION_ERROR
  );
}

export function webhookUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return '[invalid webhook URL]';
  }
}

function defaultResolveAll(
  hostname: string,
  options: LookupAllOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
): void {
  systemLookup(hostname, options, callback);
}

function parseOriginList(
  value: string | undefined,
  environmentName: string,
  allowHttp: boolean,
  nullable: boolean,
): ReadonlySet<string> | null {
  if (!value?.trim()) {
    return nullable ? null : new Set<string>();
  }

  const origins = new Set<string>();
  for (const entry of value.split(',')) {
    const candidate = entry.trim();
    if (!candidate) {
      throw new Error(`${environmentName} contains an empty origin`);
    }

    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error(`${environmentName} contains an invalid origin`);
    }

    const protocolAllowed =
      url.protocol === 'https:' || (allowHttp && url.protocol === 'http:');
    if (
      !protocolAllowed ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error(`${environmentName} must contain exact origins only`);
    }
    origins.add(url.origin);
  }
  return origins;
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.home.arpa')
  );
}

function webhookDestinationError(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = WEBHOOK_DESTINATION_ERROR;
  return error;
}

function buildNonPublicAddressList(): BlockList {
  const blockList = new BlockList();
  const ipv4Subnets: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  for (const [network, prefix] of ipv4Subnets) {
    blockList.addSubnet(network, prefix, 'ipv4');
  }

  const ipv6Subnets: Array<[string, number]> = [
    ['::', 96],
    ['::ffff:0:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    // IETF protocol assignments contain both globally reachable exceptions and
    // reserved/special-purpose space. Treat the entire block conservatively so
    // a newly assigned exception cannot silently become an SSRF destination.
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20],
    ['5f00::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ];
  for (const [network, prefix] of ipv6Subnets) {
    blockList.addSubnet(network, prefix, 'ipv6');
  }
  return blockList;
}

function buildIpv4MappedAddressList(): BlockList {
  const blockList = new BlockList();
  blockList.addSubnet('::ffff:0:0', 96, 'ipv6');
  return blockList;
}

function buildGlobalUnicastIpv6AddressList(): BlockList {
  const blockList = new BlockList();
  blockList.addSubnet('2000::', 3, 'ipv6');
  return blockList;
}
