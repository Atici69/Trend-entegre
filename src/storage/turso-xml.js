import { createClient } from '@libsql/client';

let client;
export function getTursoClient() {
  if (!process.env.TURSO_DATABASE_URL?.trim() || !process.env.TURSO_AUTH_TOKEN?.trim()) {
    throw new Error('TURSO_DATABASE_URL ve TURSO_AUTH_TOKEN tanımlı değil.');
  }
  if (!client) client = createClient({
    url: process.env.TURSO_DATABASE_URL.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN.trim(),
  });
  return client;
}

export async function ensureXmlSchema(db = getTursoClient()) {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS xml_feeds (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL DEFAULT '', source_type TEXT NOT NULL DEFAULT 'url',
      products_stored INTEGER NOT NULL DEFAULT 0, products_count INTEGER NOT NULL DEFAULT 0,
      margin_percent REAL NOT NULL DEFAULT 0, discount_percent REAL NOT NULL DEFAULT 0,
      last_tested_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT
    );
    CREATE TABLE IF NOT EXISTS xml_feed_products (
      feed_id TEXT NOT NULL, product_index INTEGER NOT NULL, product_json TEXT NOT NULL,
      PRIMARY KEY (feed_id, product_index),
      FOREIGN KEY (feed_id) REFERENCES xml_feeds(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_xml_feeds_created_at ON xml_feeds(created_at);
    CREATE TABLE IF NOT EXISTS xml_storage_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const columns = await db.execute('PRAGMA table_info(xml_feeds)');
  if (!columns.rows.some(row => row.name === 'discount_percent')) {
    await db.execute('ALTER TABLE xml_feeds ADD COLUMN discount_percent REAL NOT NULL DEFAULT 0');
  }
}

export async function saveTursoXmlFeed(feed, products = undefined) {
  const db = getTursoClient();
  await ensureXmlSchema(db);
  const now = new Date().toISOString();
  const f = {
    id: String(feed.id), name: String(feed.name || 'XML kaynağı'),
    url: String(feed.url || ''), file_name: String(feed.file_name || ''),
    source_type: String(feed.source_type || (feed.upload_type === 'file' ? 'upload' : 'url')),
    products_stored: products !== undefined || feed.products_stored === true ? 1 : 0,
    products_count: Number(feed.products_count ?? products?.length ?? 0),
    margin_percent: Number(feed.margin_percent || 0), discount_percent: Number(feed.discount_percent || 0),
    last_tested_at: feed.last_tested_at || null, created_at: feed.created_at || now,
    updated_at: feed.updated_at || now, created_by: feed.created_by || null,
  };
  await db.execute({
    sql: `INSERT INTO xml_feeds
      (id,name,url,file_name,source_type,products_stored,products_count,margin_percent,discount_percent,last_tested_at,created_at,updated_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,file_name=excluded.file_name,
      source_type=excluded.source_type,products_stored=excluded.products_stored,
      products_count=excluded.products_count,margin_percent=excluded.margin_percent,
      discount_percent=excluded.discount_percent,last_tested_at=excluded.last_tested_at,
      updated_at=excluded.updated_at,created_by=excluded.created_by`,
    args: [f.id,f.name,f.url,f.file_name,f.source_type,f.products_stored,f.products_count,
      f.margin_percent,f.discount_percent,f.last_tested_at,f.created_at,f.updated_at,f.created_by],
  });
  if (products !== undefined) {
    await db.execute({sql:'DELETE FROM xml_feed_products WHERE feed_id=?',args:[f.id]});
    for (let i=0;i<products.length;i+=400) {
      const batch = products.slice(i,i+400).map((p,j)=>({
        sql:'INSERT INTO xml_feed_products(feed_id,product_index,product_json) VALUES(?,?,?)',
        args:[f.id,i+j,JSON.stringify(p)],
      }));
      if (batch.length) await db.batch(batch,'write');
    }
  }
  return f;
}

function mapFeed(row) {
  return {
    id:String(row.id), name:String(row.name), url:String(row.url || ''),
    file_name:String(row.file_name || ''), source_type:String(row.source_type || 'url'),
    products_stored:Number(row.products_stored)===1, products_count:Number(row.products_count || 0),
    margin_percent:Number(row.margin_percent || 0), discount_percent:Number(row.discount_percent || 0),
    last_tested_at:row.last_tested_at || null, created_at:String(row.created_at),
    updated_at:String(row.updated_at), created_by:row.created_by || null,
    upload_type:row.source_type==='upload'?'file':undefined,
  };
}
export async function listTursoXmlFeeds() {
  const db=getTursoClient(); await ensureXmlSchema(db);
  const r=await db.execute('SELECT * FROM xml_feeds ORDER BY created_at DESC');
  return r.rows.map(mapFeed);
}
export async function getTursoXmlFeed(id) {
  const db=getTursoClient(); await ensureXmlSchema(db);
  const r=await db.execute({sql:'SELECT * FROM xml_feeds WHERE id=?',args:[String(id)]});
  return r.rows[0]?mapFeed(r.rows[0]):null;
}
export async function getTursoXmlProducts(id) {
  const db=getTursoClient(); await ensureXmlSchema(db);
  const r=await db.execute({sql:'SELECT product_json FROM xml_feed_products WHERE feed_id=? ORDER BY product_index',args:[String(id)]});
  return r.rows.map(row=>JSON.parse(String(row.product_json)));
}
export async function updateTursoXmlFeed(id, updates) {
  const db=getTursoClient(); await ensureXmlSchema(db);
  const allowed=['margin_percent','discount_percent','updated_at'];
  const entries=Object.entries(updates).filter(([k])=>allowed.includes(k));
  if (!entries.length) return;
  await db.execute({sql:'UPDATE xml_feeds SET '+entries.map(([k])=>k+'=?').join(',')+' WHERE id=?',
    args:[...entries.map(([,v])=>v),String(id)]});
}
export async function deleteTursoXmlFeed(id) {
  const db=getTursoClient(); await ensureXmlSchema(db);
  await db.batch([
    {sql:'DELETE FROM xml_feed_products WHERE feed_id=?',args:[String(id)]},
    {sql:'DELETE FROM xml_feeds WHERE id=?',args:[String(id)]},
  ],'write');
}

export async function isLegacyXmlMigrationDone() {
  const db=getTursoClient(); await ensureXmlSchema(db);
  const r=await db.execute({sql:"SELECT value FROM xml_storage_state WHERE key='firestore_xml_v1'",args:[]});
  return r.rows[0]?.value === 'done';
}
export async function markLegacyXmlMigrationDone() {
  const db=getTursoClient(); await ensureXmlSchema(db);
  await db.execute({sql:"INSERT INTO xml_storage_state(key,value) VALUES('firestore_xml_v1','done') ON CONFLICT(key) DO UPDATE SET value='done'",args:[]});
}
