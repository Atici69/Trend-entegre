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


const resourceConfig = {
  customers: {
    columns: 'id,full_name,company_name,email,phone,status,notes,created_at,updated_at',
    search: ['full_name','company_name','email','phone'],
    create: ['full_name','company_name','email','phone','status','notes'],
    update: ['full_name','company_name','email','phone','status','notes'],
    required: ['full_name','email'],
    statuses: ['active','inactive','suspended'],
  },
  subscriptions: {
    columns: 'id,customer_id,package_name,status,starts_at,ends_at,amount,currency,created_at',
    search: ['package_name','status'],
    create: ['customer_id','package_name','status','starts_at','ends_at','amount','currency'],
    update: ['customer_id','package_name','status','starts_at','ends_at','amount','currency'],
    required: ['package_name'],
    statuses: ['trial','active','past_due','cancelled','expired','pending'],
  },
  dealers: {
    columns: 'id,parent_dealer_id,company_name,contact_name,email,commission_rate,status,created_at',
    search: ['company_name','contact_name','email'],
    create: ['parent_dealer_id','company_name','contact_name','email','commission_rate','status'],
    update: ['parent_dealer_id','company_name','contact_name','email','commission_rate','status'],
    required: ['company_name','email'],
    statuses: ['pending','active','inactive','suspended'],
  },
  payments: {
    columns: 'id,customer_id,subscription_id,provider,provider_reference,amount,currency,status,paid_at,created_at',
    search: ['provider','provider_reference','status'],
    create: [],
    update: [],
    required: [],
    statuses: ['pending','paid','failed','refunded'],
  },
};
function cleanPayload(body, allowed) {
  const out = {};
  for (const key of allowed) if (Object.hasOwn(body || {}, key)) {
    const value = body[key];
    out[key] = typeof value === 'string' ? value.trim() || null : value;
  }
  return out;
}
async function audit(req, action, resource, id, metadata = {}) {
  if (!req.supabaseAdmin) return;
  const { error } = await req.supabaseAdmin.from('admin_audit_logs').insert({
    admin_user_id: req.adminUser.id, admin_email: req.adminUser.email,
    action, resource_type: resource, resource_id: id || null, metadata,
  });
  if (error) console.error('Admin audit write failed:', error.message);
}
for (const [resource, config] of Object.entries(resourceConfig)) {
  app.get('/api/v1/admin/' + resource, requireAdmin, async (req, res) => {
    if (!req.supabaseAdmin) return res.status(503).json({ error: 'Veritabanı sunucu anahtarı yapılandırılmamış.' });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 100);
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const search = String(req.query.search || '').trim().slice(0, 120);
    let query = req.supabaseAdmin.from(resource).select(config.columns, { count: 'exact' })
      .order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
    if (search) query = query.or(config.search.map((field) => field + '.ilike.%' + search.replace(/[,%()]/g, '') + '%').join(','));
    const { data, error, count } = await query;
    if (error) {
      console.error('Admin list ' + resource + ' error:', error.message);
      return res.status(503).json({ error: resource === 'payments' ? 'Ödeme kayıtları alınamadı.' : 'Kayıtlar alınamadı. Veritabanı şemasını kontrol edin.' });
    }
    res.json({ items: data || [], total: count || 0, page, limit });
  });
  if (config.create.length) app.post('/api/v1/admin/' + resource, requireAdmin, async (req, res) => {
    if (!req.supabaseAdmin) return res.status(503).json({ error: 'Veritabanı sunucu anahtarı yapılandırılmamış.' });
    const payload = cleanPayload(req.body, config.create);
    for (const field of config.required) if (!payload[field]) return res.status(400).json({ error: field + ' alanı zorunludur.' });
    if (payload.status && !config.statuses.includes(payload.status)) return res.status(400).json({ error: 'Geçersiz kayıt durumu.' });
    if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin.' });
    if (payload.amount !== undefined && payload.amount !== null && (!Number.isFinite(Number(payload.amount)) || Number(payload.amount) < 0)) return res.status(400).json({ error: 'Tutar sıfır veya daha büyük olmalıdır.' });
    if (payload.commission_rate !== undefined && payload.commission_rate !== null && (!Number.isFinite(Number(payload.commission_rate)) || Number(payload.commission_rate) < 0 || Number(payload.commission_rate) > 100)) return res.status(400).json({ error: 'Komisyon oranı 0-100 arasında olmalıdır.' });
    const { data, error } = await req.supabaseAdmin.from(resource).insert(payload).select(config.columns).single();
    if (error) {
      console.error('Admin create ' + resource + ' error:', error.message);
      return res.status(400).json({ error: 'Kayıt oluşturulamadı. E-posta benzersizliği ve zorunlu alanları kontrol edin.' });
    }
    await audit(req, 'create', resource, data.id);
    res.status(201).json({ item: data });
  });
  if (config.update.length) app.patch('/api/v1/admin/' + resource + '/:id', requireAdmin, async (req, res) => {
    if (!req.supabaseAdmin) return res.status(503).json({ error: 'Veritabanı sunucu anahtarı yapılandırılmamış.' });
    const payload = cleanPayload(req.body, config.update);
    if (!Object.keys(payload).length) return res.status(400).json({ error: 'Güncellenecek alan bulunamadı.' });
    if (payload.status && !config.statuses.includes(payload.status)) return res.status(400).json({ error: 'Geçersiz kayıt durumu.' });
    if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin.' });
    if (payload.amount !== undefined && payload.amount !== null && (!Number.isFinite(Number(payload.amount)) || Number(payload.amount) < 0)) return res.status(400).json({ error: 'Tutar sıfır veya daha büyük olmalıdır.' });
    if (payload.commission_rate !== undefined && payload.commission_rate !== null && (!Number.isFinite(Number(payload.commission_rate)) || Number(payload.commission_rate) < 0 || Number(payload.commission_rate) > 100)) return res.status(400).json({ error: 'Komisyon oranı 0-100 arasında olmalıdır.' });
    const { data, error } = await req.supabaseAdmin.from(resource).update({ ...payload, ...(resource === 'customers' ? { updated_at: new Date().toISOString() } : {}) }).eq('id', req.params.id).select(config.columns).maybeSingle();
    if (error) return res.status(400).json({ error: 'Kayıt güncellenemedi. Alanları kontrol edin.' });
    if (!data) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
    await audit(req, 'update', resource, data.id, { fields: Object.keys(payload) });
    res.json({ item: data });
  });
  if (resource !== 'payments') app.delete('/api/v1/admin/' + resource + '/:id', requireAdmin, async (req, res) => {
    if (!req.supabaseAdmin) return res.status(503).json({ error: 'Veritabanı sunucu anahtarı yapılandırılmamış.' });
    const statusField = resource === 'subscriptions' ? 'status' : 'status';
    const inactiveStatus = resource === 'subscriptions' ? 'cancelled' : 'inactive';
    const { data, error } = await req.supabaseAdmin.from(resource).update({ [statusField]: inactiveStatus, ...(resource === 'customers' ? { updated_at: new Date().toISOString() } : {}) }).eq('id', req.params.id).select('id').maybeSingle();
    if (error) return res.status(400).json({ error: 'Kayıt pasife alınamadı.' });
    if (!data) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
    await audit(req, 'deactivate', resource, data.id);
    res.json({ ok: true });
  });
}

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
