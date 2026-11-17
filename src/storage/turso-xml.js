import { createClient } from '@libsql/client';
import { randomUUID } from 'node:crypto';

let clientPromise;

export function getTursoClient() {
  if (!process.env.TURSO_DATABASE_URL?.trim() || !process.env.TURSO_AUTH_TOKEN?.trim()) {
    throw new Error('Turso bağlantı ayarları tanımlı değil.');
  }
  if (!clientPromise) {
    clientPromise = Promise.resolve(createClient({
      url: process.env.TURSO_DATABASE_URL.trim(),
      authToken: process.env.TURSO_AUTH_TOKEN.trim(),
    }));
  }
  return clientPromise;
}

export async function ensureXmlSchema(client) {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS xml_feeds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'url',
      products_stored INTEGER NOT NULL DEFAULT 0,
      products_count INTEGER NOT NULL DEFAULT 0,
      margin_percent REAL NOT NULL DEFAULT 0,
      last_tested_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT
    );
    CREATE TABLE IF NOT EXISTS xml_feed_products (
      feed_id TEXT NOT NULL,
      product_index INTEGER NOT NULL,
      product_json TEXT NOT NULL,
      PRIMARY KEY (feed_id, product_index),
      FOREIGN KEY (feed_id) REFERENCES xml_feeds(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_xml_feeds_created_at ON xml_feeds(created_at);
  `);
}

export async function importXmlFeedToTurso(feed, products = []) {
  const client = await getTursoClient();
  await ensureXmlSchema(client);
  const id = String(feed.id || randomUUID());
  const metadata = {
    id,
    name: String(feed.name || 'XML kaynağı'),
    url: String(feed.url || ''),
    file_name: String(feed.file_name || ''),
    source_type: String(feed.source_type || 'url'),
    products_stored: feed.products_stored === true || feed.source_type === 'upload' ? 1 : 0,
    products_count: Number(feed.products_count || products.length || 0),
    margin_percent: Number(feed.margin_percent || 0),
    last_tested_at: feed.last_tested_at || null,
    created_at: feed.created_at || new Date().toISOString(),
    updated_at: feed.updated_at || new Date().toISOString(),
    created_by: feed.created_by || null,
  };
  await client.execute({
    sql: `INSERT INTO xml_feeds
      (id,name,url,file_name,source_type,products_stored,products_count,margin_percent,last_tested_at,created_at,updated_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,url=excluded.url,file_name=excluded.file_name,source_type=excluded.source_type,
      products_stored=excluded.products_stored,products_count=excluded.products_count,
      margin_percent=excluded.margin_percent,last_tested_at=excluded.last_tested_at,
      updated_at=excluded.updated_at,created_by=excluded.created_by`,
    args: [metadata.id, metadata.name, metadata.url, metadata.file_name, metadata.source_type,
      metadata.products_stored, metadata.products_count, metadata.margin_percent, metadata.last_tested_at,
      metadata.created_at, metadata.updated_at, metadata.created_by],
  });

  if (products.length) {
    const statements = products.map((product, index) => ({
      sql: `INSERT INTO xml_feed_products (feed_id,product_index,product_json) VALUES (?,?,?)
        ON CONFLICT(feed_id,product_index) DO UPDATE SET product_json=excluded.product_json`,
      args: [id, index, JSON.stringify(product)],
    }));
    for (let offset = 0; offset < statements.length; offset += 500) {
      await client.batch(statements.slice(offset, offset + 500), 'write');
    }
  }
  return { id, products_count: metadata.products_count };
}

export async function listTursoXmlFeeds() {
  const client = await getTursoClient();
  await ensureXmlSchema(client);
  const result = await client.execute('SELECT * FROM xml_feeds ORDER BY created_at DESC');
  return result.rows.map(row => ({
    id: String(row.id), name: String(row.name), url: String(row.url || ''),
    file_name: String(row.file_name || ''), source_type: String(row.source_type || 'url'),
    products_stored: Number(row.products_stored) === 1, products_count: Number(row.products_count || 0),
    margin_percent: Number(row.margin_percent || 0), last_tested_at: row.last_tested_at || null,
    created_at: String(row.created_at), updated_at: String(row.updated_at), created_by: row.created_by || null,
  }));
}

export async function getTursoXmlFeed(feedId) {
  const client = await getTursoClient();
  await ensureXmlSchema(client);
  const result = await client.execute({ sql: 'SELECT * FROM xml_feeds WHERE id = ?', args: [String(feedId)] });
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id), name: String(row.name), url: String(row.url || ''),
    file_name: String(row.file_name || ''), source_type: String(row.source_type || 'url'),
    products_stored: Number(row.products_stored) === 1, products_count: Number(row.products_count || 0),
    margin_percent: Number(row.margin_percent || 0), last_tested_at: row.last_tested_at || null,
    created_at: String(row.created_at), updated_at: String(row.updated_at), created_by: row.created_by || null,
  };
}

export async function getTursoXmlProducts(feedId) {
  const client = await getTursoClient();
  await ensureXmlSchema(client);
  const result = await client.execute({
    sql: 'SELECT product_json FROM xml_feed_products WHERE feed_id = ? ORDER BY product_index',
    args: [String(feedId)],
  });
  return result.rows.map(row => JSON.parse(String(row.product_json)));
}
