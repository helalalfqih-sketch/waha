import {
  changeDatabasePsql,
  parsePsql,
  stringifyPsql,
} from '@waha/core/storage/psql/PsqlConnectionConfig';

describe('PsqlConnectionConfig', () => {
  it.each([
    undefined,
    'allow',
    'prefer',
    'require',
    'verify-ca',
    'verify-full',
    'no-verify',
  ])(
    'enables certificate and hostname verification for sslmode=%s',
    (sslmode) => {
      const suffix = sslmode ? `?sslmode=${sslmode}` : '';
      const config = parsePsql(
        `postgresql://user:password@db.example.com:5432/waha${suffix}`,
      );

      expect(config.ssl).toEqual({ rejectUnauthorized: true });
    },
  );

  it('preserves explicit plaintext mode for local deployments', () => {
    const config = parsePsql(
      'postgresql://user:password@localhost:5432/waha?sslmode=disable',
    );

    expect(config.ssl).toBe(false);
    expect(stringifyPsql(config)).toContain('sslmode=disable');
  });

  it('normalizes the sslmode value before applying the policy', () => {
    const config = parsePsql(
      'postgresql://user:password@localhost:5432/waha?sslmode=DISABLE',
    );

    expect(config.ssl).toBe(false);
  });

  it('serializes enabled TLS as verify-full for external consumers', () => {
    const config = parsePsql(
      'postgresql://user:password@db.example.com:5432/waha?sslmode=require',
    );
    const sessionConfig = changeDatabasePsql(config, 'waha_gows_default');
    const serialized = stringifyPsql(sessionConfig);

    expect(new URL(serialized).searchParams.getAll('sslmode')).toEqual([
      'verify-full',
    ]);
    expect(parsePsql(serialized).ssl).toEqual({ rejectUnauthorized: true });
  });

  it.each(['postgres:', 'postgresql:'])(
    'accepts the %s URL scheme',
    (protocol) => {
      const config = parsePsql(
        `${protocol}//user:password@db.example.com:5432/waha`,
      );

      expect(config.host).toBe('db.example.com');
      expect(config.ssl).toEqual({ rejectUnauthorized: true });
    },
  );

  it('rejects non-PostgreSQL URLs', () => {
    expect(() => parsePsql('https://db.example.com/waha')).toThrow(
      'Invalid postgresql url',
    );
  });

  it('rejects duplicate or unknown sslmode values', () => {
    expect(() =>
      parsePsql(
        'postgresql://user:password@db.example.com/waha?sslmode=verify-full&sslmode=disable',
      ),
    ).toThrow('PostgreSQL URL must contain at most one sslmode');
    expect(() =>
      parsePsql(
        'postgresql://user:password@db.example.com/waha?sslmode=unknown',
      ),
    ).toThrow('PostgreSQL URL contains an unsupported sslmode');
  });
});
