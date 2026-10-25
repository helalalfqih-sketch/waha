import { WebhookSender } from '@waha/modules/waha-webhook/WebhookPlugin.sender';
import {
  WEBHOOK_ALLOWED_ORIGINS_ENV,
  WEBHOOK_ALLOWED_PRIVATE_ORIGINS_ENV,
  WEBHOOK_DESTINATION_ERROR,
} from '@waha/modules/waha-webhook/WebhookUrlPolicy';
import { WAHAEvents } from '@waha/structures/enums.dto';
import { WebhookConfig } from '@waha/structures/webhooks.config.dto';
import { LoggerBuilder } from '@waha/utils/logging';

describe('WebhookSender security', () => {
  beforeEach(() => {
    delete process.env[WEBHOOK_ALLOWED_ORIGINS_ENV];
    delete process.env[WEBHOOK_ALLOWED_PRIVATE_ORIGINS_ENV];
  });

  it('uses verified TLS, guarded DNS, no redirects, and no ambient proxy', () => {
    const sender = new InspectableWebhookSender(
      createLoggerBuilder(),
      createConfig('https://hooks.example.com/events'),
    );
    const security = sender.inspectSecurityOptions();

    expect(security.rejectUnauthorized).toBe(true);
    expect(security.httpLookup).toEqual(expect.any(Function));
    expect(security.httpsLookup).toEqual(expect.any(Function));
    expect(security.maxRedirects).toBe(0);
    expect(security.proxy).toBe(false);
  });

  it('rejects private destinations before constructing an Axios client', () => {
    try {
      new InspectableWebhookSender(
        createLoggerBuilder(),
        createConfig('https://169.254.169.254/latest/meta-data'),
      );
      throw new Error('Expected webhook destination to be rejected');
    } catch (error) {
      expect(error).toMatchObject({ code: WEBHOOK_DESTINATION_ERROR });
    }
  });

  it('rejects an authority-overriding custom Host header', () => {
    const config = createConfig('https://hooks.example.com/events');
    config.customHeaders = [{ name: 'hOsT', value: 'internal.example' }];

    expect(
      () => new InspectableWebhookSender(createLoggerBuilder(), config),
    ).toThrow('A custom Host webhook header is not allowed');
  });

  it('keeps private HTTP compatibility behind a server-owned exact opt-in', () => {
    process.env[WEBHOOK_ALLOWED_PRIVATE_ORIGINS_ENV] = 'http://localhost:5000';

    expect(
      () =>
        new InspectableWebhookSender(
          createLoggerBuilder(),
          createConfig('http://localhost:5000/bot'),
        ),
    ).not.toThrow();
  });
});

class InspectableWebhookSender extends WebhookSender {
  inspectSecurityOptions() {
    return {
      httpLookup: this.agents.http.options.lookup,
      httpsLookup: this.agents.https.options.lookup,
      maxRedirects: this.axios.defaults.maxRedirects,
      proxy: this.axios.defaults.proxy,
      rejectUnauthorized: this.agents.https.options.rejectUnauthorized,
    };
  }
}

function createConfig(url: string): WebhookConfig {
  return {
    url: url,
    events: [WAHAEvents.MESSAGE],
  };
}

function createLoggerBuilder(): LoggerBuilder {
  const logger = {
    child: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  };
  return {
    child: jest.fn(() => logger as any),
  };
}
