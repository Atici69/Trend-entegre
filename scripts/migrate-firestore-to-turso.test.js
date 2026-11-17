import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_MIGRATION_COLLECTIONS,
  parseMigrationArgs,
  toSqlTimestamp,
  migrateCollection,
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


function fakeFirestore(docs) {
  return {
    collection(name) {
      return {
        orderBy() { return this; },
        limit() { return this; },
        async get() {
          return { empty: docs.length === 0, size: docs.length, docs };
        },
      };
    },
  };
}

test('dry-run counts records without issuing Turso writes', async () => {
  const docs = [
    { id: 'customer-1', data: () => ({ full_name: 'Ada' }) },
    { id: 'customer-2', data: () => ({ full_name: 'Grace' }) },
  ];
  let writes = 0;
  const result = await migrateCollection({
    firestore: fakeFirestore(docs),
    turso: { batch: async () => { writes += 1; } },
    collection: 'customers',
    dryRun: true,
    pageSize: 10,
  });
  assert.deepEqual(result, { collection: 'customers', records: 2, written: 0, dryRun: true });
  assert.equal(writes, 0);
});

test('apply mode upserts the source document IDs and JSON payloads', async () => {
  const docs = [{ id: 'customer-9', data: () => ({ full_name: 'Ada' }) }];
  let batch;
  const result = await migrateCollection({
    firestore: fakeFirestore(docs),
    turso: { batch: async (statements, mode) => { batch = { statements, mode }; } },
    collection: 'customers',
    dryRun: false,
    pageSize: 10,
    now: () => '2026-11-17T12:00:00.000Z',
  });
  assert.equal(result.written, 1);
  assert.equal(batch.mode, 'write');
  assert.equal(batch.statements[0].args[0], 'customers');
  assert.equal(batch.statements[0].args[1], 'customer-9');
  assert.deepEqual(JSON.parse(batch.statements[0].args[2]), { full_name: 'Ada' });
});
