import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getTursoClient } from '../storage/turso-xml.js';

const SESSION_HOURS = 8;
const hash = value => createHash('sha256').update(String(value)).digest();
const secureEqual = (left, right) => timingSafeEqual(hash(left), hash(right));
const allowedAdminEmails = () => (process.env.ADMIN_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);

export function isTursoAdminAuthConfigured() {
  return Boolean(process.env.TURSO_DATABASE_URL?.trim() && process.env.TURSO_AUTH_TOKEN?.trim() &&
    process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 12 && allowedAdminEmails().length);
}
export async function ensureAdminAuthSchema(client) {
  await client.execute(`CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions(expires_at);`);
}
export async function createAdminSession(emailInput, password) {
  if (!isTursoAdminAuthConfigured()) throw new Error('Yönetici giriş ayarları eksik.');
  const email = String(emailInput || '').trim().toLowerCase();
  const emailAllowed = allowedAdminEmails().includes(email);
  const passwordValid = secureEqual(password || '', process.env.ADMIN_PASSWORD);
  if (!emailAllowed || !passwordValid) return null;
  const client = await getTursoClient();
  await ensureAdminAuthSchema(client);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_HOURS * 60 * 60 * 1000);
  const token = randomBytes(32).toString('base64url');
  await client.execute({sql:'DELETE FROM admin_sessions WHERE expires_at <= ?',args:[now.toISOString()]});
  await client.execute({sql:'INSERT INTO admin_sessions (token_hash,email,created_at,expires_at) VALUES (?,?,?,?)',
    args:[hash(token).toString('hex'),email,now.toISOString(),expires.toISOString()]});
  return {token,email,expiresAt:expires.toISOString()};
}
export async function verifyAdminSession(token) {
  if (!token || !isTursoAdminAuthConfigured()) return null;
  const client = await getTursoClient();
  await ensureAdminAuthSchema(client);
  const result = await client.execute({sql:'SELECT email,expires_at FROM admin_sessions WHERE token_hash=? LIMIT 1',
    args:[hash(token).toString('hex')]});
  const row = result.rows[0];
  if (!row || Date.parse(String(row.expires_at)) <= Date.now()) {
    if (row) await revokeAdminSession(token);
    return null;
  }
  const email = String(row.email || '').toLowerCase();
  if (!allowedAdminEmails().includes(email)) { await revokeAdminSession(token); return null; }
  return {id:email,email,expiresAt:String(row.expires_at)};
}
export async function revokeAdminSession(token) {
  if (!token) return;
  const client = await getTursoClient();
  await ensureAdminAuthSchema(client);
  await client.execute({sql:'DELETE FROM admin_sessions WHERE token_hash=?',args:[hash(token).toString('hex')]});
}
