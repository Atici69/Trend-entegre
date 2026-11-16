import { createClient } from '@libsql/client';

/**
 * Creates a short-lived Turso client from server-side environment variables.
 * This helper is intentionally separate from Firebase; no existing data is migrated.
 */
export function createTursoClient() {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) {
    throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be configured.');
  }
  if (!url.startsWith('libsql://') && !url.startsWith('https://')) {
    throw new Error('TURSO_DATABASE_URL must use libsql:// or https://.');
  }
  return createClient({ url, authToken });
}
