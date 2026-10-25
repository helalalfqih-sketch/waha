import { LookupAddress } from 'node:dns';
import { LookupFunction } from 'node:net';

import {
  createWebhookLookup,
  isPublicNetworkAddress,
  readWebhookDestinationPolicy,
  ResolveAll,
  validateWebhookDestination,
  WEBHOOK_ALLOWED_ORIGINS_ENV,
  WEBHOOK_ALLOWED_PRIVATE_ORIGINS_ENV,
  WEBHOOK_DESTINATION_ERROR,
  webhookUrlForLog,
} from '@waha/modules/waha-webhook/WebhookUrlPolicy';

describe('WebhookUrlPolicy', () => {
  it('allows public HTTPS destinations by default', () => {
    const destination = validateWebhookDestination(
      'https://hooks.example.com/events?tenant=one',
      readWebhookDestinationPolicy({}),
    );

    expect(destination.url.origin).toBe('https://hooks.example.com');
    expect(destination.allowNonPublicAddress).toBe(false);
  });

  it.each([
    'http://hooks.example.com/events',
    'ftp://hooks.example.com/events',
    'https://user:password@hooks.example.com/events',
    'https://127.0.0.1/events',
    'https://2130706433/events',
    'https://0177.0.0.1/events',
    'https://0x7f000001/events',
    'https://[::1]/events',
    'https://[::ffff:127.0.0.1]/events',
    'https://metadata.google.internal/events',
    'https://localhost./events',
  ])('rejects unsafe destination %s before creating a request', (url) => {
    expectDestinationRejected(url, readWebhookDestinationPolicy({}));
  });

  it('enforces an exact public origin allowlist', () => {
    const policy = readWebhookDestinationPolicy({
      [WEBHOOK_ALLOWED_ORIGINS_ENV]: 'https://hooks.example.com',
    });

    expect(
      validateWebhookDestination('https://hooks.example.com/events', policy).url
        .pathname,
    ).toBe('/events');
    expectDestinationRejected('https://hooks.example.com.evil/events', policy);
    expectDestinationRejected('https://hooks.example.com:8443/events', policy);
  });

  it('requires a server-owned private origin opt-in for local webhooks', () => {
    const policy = readWebhookDestinationPolicy({
      [WEBHOOK_ALLOWED_ORIGINS_ENV]: 'https://hooks.example.com',
      [WEBHOOK_ALLOWED_PRIVATE_ORIGINS_ENV]: 'http://localhost:5000',
    });
    const destination = validateWebhookDestination(
      'http://localhost:5000/bot',
      policy,
    );

    expect(destination.allowNonPublicAddress).toBe(true);
    expectDestinationRejected('http://localhost:5001/bot', policy);
  });

  it.each([
    'https://hooks.example.com/path',
    'https://user@hooks.example.com',
    'https://hooks.example.com?token=value',
    'http://hooks.example.com',
  ])('rejects malformed public allowlist origin %s', (origin) => {
    expect(() =>
      readWebhookDestinationPolicy({
        [WEBHOOK_ALLOWED_ORIGINS_ENV]: origin,
      }),
    ).toThrow();
  });

  it.each([
    ['8.8.8.8', true],
    ['2606:4700:4700::1111', true],
    ['::ffff:8.8.8.8', true],
    ['10.0.0.1', false],
    ['100.64.0.1', false],
    ['127.0.0.1', false],
    ['169.254.169.254', false],
    ['192.168.1.1', false],
    ['::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:0:10.0.0.1', false],
    ['64:ff9b::7f00:1', false],
    ['1000::1', false],
    ['2001:40::1', false],
    ['2001:80::1', false],
    ['2001:100::1', false],
    ['2001:100:0:1::1', false],
    ['2001:101::1', false],
    ['2001:1ff::1', false],
    ['2001:200::1', true],
    ['4000::1', false],
    ['fc00::1', false],
    ['fe80::1', false],
    ['ff02::1', false],
    ['not-an-address', false],
  ])('classifies %s as public=%s', (address, expected) => {
    expect(isPublicNetworkAddress(address)).toBe(expected);
  });

  it('returns vetted public DNS answers in both callback shapes', async () => {
    const addresses = [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    const lookup = createWebhookLookup(false, resolveWith(addresses));

    await expect(runLookup(lookup, false)).resolves.toEqual({
      address: '8.8.8.8',
      family: 4,
    });
    await expect(runLookup(lookup, true)).resolves.toEqual(addresses);
  });

  it('rejects private and mixed DNS answers', async () => {
    const privateLookup = createWebhookLookup(
      false,
      resolveWith([{ address: '10.0.0.1', family: 4 }]),
    );
    const mixedLookup = createWebhookLookup(
      false,
      resolveWith([
        { address: '8.8.8.8', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]),
    );

    await expect(runLookup(privateLookup, false)).rejects.toMatchObject({
      code: WEBHOOK_DESTINATION_ERROR,
    });
    await expect(runLookup(mixedLookup, true)).rejects.toMatchObject({
      code: WEBHOOK_DESTINATION_ERROR,
    });
  });

  it('fails closed when DNS returns no addresses or an error', async () => {
    const emptyLookup = createWebhookLookup(false, resolveWith([]));
    const errorLookup = createWebhookLookup(false, function resolveAll(
      _hostname,
      _options,
      callback,
    ): void {
      const error = new Error('DNS failed') as NodeJS.ErrnoException;
      error.code = 'ENOTFOUND';
      callback(error, []);
    });

    await expect(runLookup(emptyLookup, false)).rejects.toMatchObject({
      code: WEBHOOK_DESTINATION_ERROR,
    });
    await expect(runLookup(errorLookup, false)).rejects.toMatchObject({
      code: 'ENOTFOUND',
    });
  });

  it('logs only the webhook origin, not path or query credentials', () => {
    expect(
      webhookUrlForLog(
        'https://hooks.example.com/events?token=secret#fragment',
      ),
    ).toBe('https://hooks.example.com');
  });
});

function expectDestinationRejected(
  url: string,
  policy: ReturnType<typeof readWebhookDestinationPolicy>,
): void {
  try {
    validateWebhookDestination(url, policy);
    throw new Error('Expected webhook destination to be rejected');
  } catch (error) {
    expect(error).toMatchObject({ code: WEBHOOK_DESTINATION_ERROR });
  }
}

function resolveWith(addresses: LookupAddress[]): ResolveAll {
  return function resolveAll(_hostname, _options, callback): void {
    callback(null, addresses);
  };
}

function runLookup(
  lookup: LookupFunction,
  all: boolean,
): Promise<string | LookupAddress[] | { address: string; family: number }> {
  return new Promise((resolve, reject) => {
    lookup('hooks.example.com', { all: all }, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }
      if (Array.isArray(address)) {
        resolve(address);
        return;
      }
      resolve({ address: address, family: family });
    });
  });
}
