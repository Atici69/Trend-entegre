import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';
import { getTursoClient } from '../src/storage/turso-xml.js';
import { APP_COLLECTIONS, ensureAppSchema } from '../src/storage/turso-app.js';

export const DEFAULT_PAGE_SIZE = 250;
export const MAX_PAGE_SIZE = 400;
export const APP_MIGRATION_COLLECTIONS = APP_COLLECTIONS;

export function parseMigrationArgs(argv = []) {
  let apply = false;
  let pageSize = DEFAULT_PAGE_SIZE;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--page-size') {
      const value = Number.parseInt(argv[index + 1], 10);
      if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
        throw new Error(`--page-size 1 ile ${MAX_PAGE_SIZE} arasında olmalıdır.`);
      }
      pageSize = value;
      index += 1;
      continue;
    }
    throw new Error(`Bilinmeyen parametre: ${arg}`);
  }

  return { apply, pageSize };
}

export function toSqlTimestamp(value, fallback) {
  let date = value;
  if (value && typeof value.toDate === 'function') date = value.toDate();
  if (date instanceof Date && Number.isFinite(date.getTime())) return date.toISOString();
  if (typeof date === 'string' && Number.isFinite(Date.parse(date))) {
    return new Date(date).toISOString();
  }
  return fallback;
}

function getFirebaseDb() {
  if (getApps().length) return getFirestore();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON tanımlı değil.');
  const serviceAccount = JSON.parse(raw);
  initializeApp({
    credential: cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id,
  });
  return getFirestore();
}

export async function migrateCollection({
  firestore,
  turso = null,
  collection,
  dryRun = true,
  pageSize = DEFAULT_PAGE_SIZE,
  now = () => new Date().toISOString(),
}) {
  if (!APP_MIGRATION_COLLECTIONS.includes(collection)) {
    throw new Error('Taşımaya izin verilmeyen koleksiyon.');
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error('Geçersiz sayfa boyutu.');
  }
  if (!dryRun && !turso) throw new Error('Uygulama modu için Turso bağlantısı gerekli.');

  let query = firestore.collection(collection)
    .orderBy(FieldPath.documentId())
    .limit(pageSize);
  let count = 0;

  while (true) {
    const snapshot = await query.get();
    if (snapshot.empty) break;

    if (!dryRun) {
      const statements = snapshot.docs.map((doc) => {
        const data = doc.data();
        const timestamp = now();
        const createdAt = toSqlTimestamp(data.created_at ?? data.createdAt, timestamp);
        const updatedAt = toSqlTimestamp(data.updated_at ?? data.updatedAt, createdAt);
        return {
          sql: `INSERT INTO app_records(collection_name, id, data_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(collection_name, id) DO UPDATE SET
              data_json = excluded.data_json,
              updated_at = excluded.updated_at`,
          args: [collection, doc.id, JSON.stringify(data), createdAt, updatedAt],
        };
      });
      await turso.batch(statements, 'write');
    }

    count += snapshot.size;
    const lastDocument = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < pageSize) break;
    query = firestore.collection(collection)
      .orderBy(FieldPath.documentId())
      .startAfter(lastDocument)
      .limit(pageSize);
  }

  return { collection, records: count, written: dryRun ? 0 : count, dryRun };
}

export async function runMigration({ apply = false, pageSize = DEFAULT_PAGE_SIZE, logger = console } = {}) {
  const firestore = getFirebaseDb();
  const turso = apply ? getTursoClient() : null;
  if (turso) await ensureAppSchema(turso);

  const results = [];
  for (const collection of APP_MIGRATION_COLLECTIONS) {
    const result = await migrateCollection({
      firestore,
      turso,
      collection,
      dryRun: !apply,
      pageSize,
    });
    results.push(result);
    logger.log(`${result.collection}: ${result.records} kayıt${apply ? ' Turso’ya yazıldı' : ' bulundu (dry-run)'}.`);
  }

  const total = results.reduce((sum, item) => sum + item.records, 0);
  logger.log(`Toplam: ${total} kayıt. ${apply ? 'Turso yazımı tamamlandı.' : 'Hiçbir veri yazılmadı; yalnızca sayım yapıldı.'}`);
  return results;
}

const isDirectRun = process.argv[1]
  && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  try {
    const options = parseMigrationArgs(process.argv.slice(2));
    if (options.apply) {
      console.warn('UYARI: Bu işlem Firestore verilerini silmez; Turso kayıtlarını aynı belge kimliğiyle ekler/günceller.');
      console.warn('Canlı yazmaların kaybolmaması için uygulama yazmalarını durdurup son delta aktarımını ayrıca planlayın.');
    } else {
      console.log('DRY-RUN: Firestore okunacak; Turso’ya hiçbir veri yazılmayacak.');
    }
    await runMigration(options);
  } catch (error) {
    console.error('Firestore → Turso aktarımı başarısız:', error?.message || error);
    process.exitCode = 1;
  }
}
