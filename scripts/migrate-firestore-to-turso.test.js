import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_MIGRATION_COLLECTIONS,
  parseMigrationArgs,
  toSqlTimestamp,
} from './migrate-firestore-to-turso.js';

test('migration allowlist matches the core application collections', () => {
  assert.deepEqual(APP_MIGRATION_COLLECTIONS, [
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

test('migration defaults to dry-run and bounded pagination', () => {
  assert.deepEqual(parseMigrationArgs([]), { apply: false, pageSize: 250 });
  assert.deepEqual(parseMigrationArgs(['--apply', '--page-size', '100']), {
    apply: true,
    pageSize: 100,
  });
});

test('migration rejects unsafe or unknown command-line arguments', () => {
  assert.throws(() => parseMigrationArgs(['--unknown']), /Bilinmeyen parametre/);
  assert.throws(() => parseMigrationArgs(['--page-size', '0']), /sayfa boyutu/);
  assert.throws(() => parseMigrationArgs(['--page-size', '401']), /sayfa boyutu/);
});

test('migration converts Firestore timestamps and keeps a safe fallback', () => {
  const timestamp = { toDate: () => new Date('2026-11-17T12:00:00.000Z') };
  assert.equal(toSqlTimestamp(timestamp, 'fallback'), '2026-11-17T12:00:00.000Z');
  assert.equal(toSqlTimestamp('2026-11-17T12:00:00Z', 'fallback'), '2026-11-17T12:00:00.000Z');
  assert.equal(toSqlTimestamp('not-a-date', 'fallback'), 'fallback');
});
