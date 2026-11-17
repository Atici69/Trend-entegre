import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_COLLECTIONS, putAppRecord } from './turso-app.js';

test('Turso application storage exposes the planned collection allowlist', () => {
  assert.deepEqual(APP_COLLECTIONS, [
    'users',
    'customers',
    'subscriptions',
    'dealers',
    'payments',
    'admin_audit_logs',
    'catalog_products',
    'catalog_orders',
    'ad_campaigns',
  ]);
});

test('Turso application storage rejects unknown collections', async () => {
  await assert.rejects(
    putAppRecord('unexpected_collection', 'record-1', { label: 'test' }),
    /Unsupported application collection/,
  );
});

test('Turso application storage rejects empty IDs and non-object records', async () => {
  await assert.rejects(
    putAppRecord('users', '', { email: 'test@example.com' }),
    /record ID is required/,
  );
  await assert.rejects(
    putAppRecord('users', 'user-1', []),
    /record must be an object/,
  );
});
