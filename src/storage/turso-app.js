import { getTursoClient } from './turso-xml.js';

export const APP_COLLECTIONS = Object.freeze([
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

const allowedCollections = new Set(APP_COLLECTIONS);

function assertCollection(collection) {
  const name = String(collection || '');
  if (!allowedCollections.has(name)) {
    throw new Error('Unsupported application collection.');
  }
  return name;
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('Application record must be an object.');
  }
  return record;
}

export async function ensureAppSchema(db = getTursoClient()) {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS app_records (
      collection_name TEXT NOT NULL,
      id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (collection_name, id)
    );
    CREATE INDEX IF NOT EXISTS idx_app_records_collection_updated
      ON app_records(collection_name, updated_at DESC);
  `);
}

function mapRecord(row) {
  const data = JSON.parse(String(row.data_json));
  return { id: String(row.id), ...data };
}

export async function getAppRecord(collection, id, db = getTursoClient()) {
  const name = assertCollection(collection);
  await ensureAppSchema(db);
  const result = await db.execute({
    sql: 'SELECT id, data_json FROM app_records WHERE collection_name = ? AND id = ?',
    args: [name, String(id)],
  });
  return result.rows[0] ? mapRecord(result.rows[0]) : null;
}

export async function listAppRecords(collection, options = {}, db = getTursoClient()) {
  const name = assertCollection(collection);
  await ensureAppSchema(db);
  const limit = Math.min(Math.max(Number.parseInt(options.limit, 10) || 100, 1), 1000);
  const result = await db.execute({
    sql: 'SELECT id, data_json FROM app_records WHERE collection_name = ? ORDER BY updated_at DESC LIMIT ?',
    args: [name, limit],
  });
  return result.rows.map(mapRecord);
}

export async function putAppRecord(collection, id, record, options = {}, db = getTursoClient()) {
  const name = assertCollection(collection);
  const recordId = String(id || '').trim();
  if (!recordId) throw new TypeError('Application record ID is required.');
  const incoming = normalizeRecord(record);
  await ensureAppSchema(db);

  const existing = options.merge === false ? null : await getAppRecord(name, recordId, db);
  const now = new Date().toISOString();
  const data = { ...(existing || {}), ...incoming };
  delete data.id;
  const createdAt = String(data.created_at || existing?.created_at || now);
  const updatedAt = String(data.updated_at || now);

  await db.execute({
    sql: `INSERT INTO app_records(collection_name, id, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(collection_name, id) DO UPDATE SET
        data_json = excluded.data_json,
        updated_at = excluded.updated_at`,
    args: [name, recordId, JSON.stringify(data), createdAt, updatedAt],
  });
  return { id: recordId, ...data };
}

export async function deleteAppRecord(collection, id, db = getTursoClient()) {
  const name = assertCollection(collection);
  await ensureAppSchema(db);
  const result = await db.execute({
    sql: 'DELETE FROM app_records WHERE collection_name = ? AND id = ?',
    args: [name, String(id)],
  });
  return Number(result.rowsAffected || 0) > 0;
}
