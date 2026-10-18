import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DbConfigError, loadDbConfig } from '../src/db/config.ts';
import { StoreError, redact, registerSecret, toStoreError } from '../src/db/errors.ts';

const URL_OK = 'postgres://engine:Sup3rSecretPw@db.internal:5432/engine';

test('loadDbConfig: defaults, overrides, and range checks', () => {
  const c = loadDbConfig({ DATABASE_URL: URL_OK });
  assert.deepEqual([c.poolMax, c.idleTimeoutMs, c.connectionTimeoutMs, c.statementTimeoutMs], [10, 30_000, 5_000, 15_000]);
  assert.equal(loadDbConfig({ DATABASE_URL: URL_OK, PG_POOL_MAX: '3' }).poolMax, 3);
  for (const bad of ['0', '101', '1.5', 'x']) assert.throws(() => loadDbConfig({ DATABASE_URL: URL_OK, PG_POOL_MAX: bad }), DbConfigError);
});

test('loadDbConfig errors never contain the connection string or password', () => {
  for (const env of [{}, { DATABASE_URL: 'mysql://u:Sup3rSecretPw@h/db' }, { DATABASE_URL: 'postgres://u:Sup3rSecretPw@h/db', PG_POOL_MAX: 'nope' }]) {
    try {
      loadDbConfig(env);
      assert.fail('should throw');
    } catch (e) {
      assert.ok(e instanceof DbConfigError);
      assert.doesNotMatch(e.message, /Sup3rSecretPw|mysql/);
    }
  }
});

test('redaction removes URLs and registered secrets from every error', () => {
  loadDbConfig({ DATABASE_URL: URL_OK }); // registers URL + password
  assert.equal(redact('connect failed for postgres://engine:Sup3rSecretPw@db.internal:5432/engine'), 'connect failed for [redacted-url]');
  assert.equal(redact('password Sup3rSecretPw rejected'), 'password [redacted] rejected');
  registerSecret('another-secret-value');
  const e = toStoreError(Object.assign(new Error('boom another-secret-value at postgresql://u:p@h/d'), { code: 'XX000' }));
  assert.ok(e instanceof StoreError);
  assert.equal(e.code, 'XX000');
  assert.doesNotMatch(e.message + (e.stack ?? ''), /another-secret-value|postgresql:\/\//);
  assert.equal(e.cause, undefined);
});
