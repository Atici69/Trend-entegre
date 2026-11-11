import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import { marketplaceStatus } from './src/marketplaces/index.js';
import { testHepsiburadaConnection } from './src/marketplaces/hepsiburada.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000')
  .split(',').map((origin) => origin.trim()).filter(Boolean);

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  },
}));
app.use(express.json({ limit: '256kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api/v1/admin', rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'trend-entegre-api', timestamp: new Date().toISOString() });
});

// The Supabase URL and anon key are public client configuration, never service secrets.
app.get('/api/v1/admin/config', (_req, res) => {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  const adminEmails = process.env.ADMIN_EMAILS?.split(',').map((email) => email.trim()).filter(Boolean) || [];
  const enabled = Boolean(supabaseUrl && anonKey && adminEmails.length);
  res.status(200).json(enabled ? { enabled: true, supabaseUrl, anonKey } : { enabled: false });
});

function getSupabaseClients() {
  const url = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;
  return {
    auth: createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } }),
    admin: process.env.SUPABASE_SERVICE_ROLE_KEY
      ? createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
      : null,
  };
}

async function requireAdmin(req, res, next) {
  try {
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const clients = getSupabaseClients();
    const allowedEmails = process.env.ADMIN_EMAILS?.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean) || [];
    if (!clients || !allowedEmails.length || !token) return res.status(401).json({ error: 'Yönetici oturumu doğrulanamadı.' });
    const { data, error } = await clients.auth.auth.getUser(token);
    if (error || !data?.user?.email || !allowedEmails.includes(data.user.email.toLowerCase())) {
      return res.status(403).json({ error: 'Bu hesap yönetici erişim listesinde bulunmuyor.' });
    }
    req.adminUser = { id: data.user.id, email: data.user.email };
    req.supabaseAdmin = clients.admin;
    return next();
  } catch (error) {
    console.error('Admin auth error:', error?.message || 'Unknown error');
    return res.status(401).json({ error: 'Yönetici oturumu doğrulanamadı.' });
  }
}

app.get('/api/v1/admin/session', requireAdmin, (req, res) => {
  res.json({ ok: true, user: req.adminUser });
});

app.get('/api/v1/admin/overview', requireAdmin, async (req, res) => {
  if (!req.supabaseAdmin) return res.status(503).json({ error: 'Veritabanı sunucu anahtarı yapılandırılmamış.' });
  try {
    const tables = ['customers', 'subscriptions', 'dealers', 'payments'];
    const results = await Promise.all(tables.map((table) =>
      req.supabaseAdmin.from(table).select('id', { count: 'exact', head: true })
    ));
    const failed = results.find((result) => result.error);
    if (failed) {
      console.error('Admin overview database error:', failed.error.message);
      return res.status(503).json({ error: 'Veritabanı tabloları hazır değil. supabase/migrations SQL dosyasını uygulayın.' });
    }
    const activeSubscriptions = await req.supabaseAdmin.from('subscriptions')
      .select('id', { count: 'exact', head: true }).eq('status', 'active');
    if (activeSubscriptions.error) return res.status(503).json({ error: 'Abonelik tablosu okunamadı.' });
    res.json({
      counts: {
        customers: results[0].count ?? 0,
        activeSubscriptions: activeSubscriptions.count ?? 0,
        dealers: results[2].count ?? 0,
        payments: results[3].count ?? 0,
      },
    });
  } catch (error) {
    console.error('Admin overview error:', error?.message || 'Unknown error');
    res.status(500).json({ error: 'Yönetim özeti alınamadı.' });
  }
});

// Marketplace status reveals only whether server-side credentials exist.
app.get('/api/v1/marketplaces/status', requireAdmin, (_req, res) => {
  res.json({ marketplaces: marketplaceStatus() });
});

// Read-only SIT authentication handshake. Credentials stay in server environment variables.
app.post('/api/v1/marketplaces/hepsiburada/test', requireAdmin, async (_req, res) => {
  const result = await testHepsiburadaConnection();
  res.status(result.ok ? 200 : result.status === 'not_configured' ? 424 : 502).json(result);
});

app.use((err, _req, res, _next) => {
  if (err?.message === 'Origin is not allowed by CORS') return res.status(403).json({ error: 'Origin not allowed' });
  console.error('API error:', err?.message || 'Unknown error');
  return res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => console.log(`Trend-Entegre API listening on port ${port}`));
