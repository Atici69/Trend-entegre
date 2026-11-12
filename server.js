import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { marketplaceStatus } from './src/marketplaces/index.js';
import { testHepsiburadaConnection } from './src/marketplaces/hepsiburada.js';
import { registerIyzicoRoutes } from './src/payments/iyzico.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const allowedOrigins = [...new Set([
  'https://atici69.github.io',
  'http://localhost:3000',
  ...(process.env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean),
])];

app.disable('x-powered-by');
// Trust the single reverse proxy used by Render so rate limiting can read client IPs safely.
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  },
}));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api/v1/auth', rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api/v1/admin', rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));

function firebasePublicConfig() {
  return {
    apiKey: process.env.FIREBASE_API_KEY?.trim(),
    authDomain: process.env.FIREBASE_AUTH_DOMAIN?.trim(),
    projectId: process.env.FIREBASE_PROJECT_ID?.trim(),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET?.trim(),
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID?.trim(),
    appId: process.env.FIREBASE_APP_ID?.trim(),
  };
}
function getFirebaseAdmin() {
  try {
    if (getApps().length) return { auth: getAuth(), db: getFirestore() };
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) return null;
    const serviceAccount = JSON.parse(raw);
    initializeApp({ credential: cert(serviceAccount), projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id });
    return { auth: getAuth(), db: getFirestore() };
  } catch (error) {
    console.error('Firebase Admin initialization failed:', error?.message || 'Unknown error');
    return null;
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'trend-entegre-api', timestamp: new Date().toISOString() });
});


app.post('/api/v1/auth/register', async (req, res) => {
  try {
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const firebase = getFirebaseAdmin();
    if (!firebase || !token) {
      return res.status(401).json({ error: 'Kullanıcı oturumu doğrulanamadı.' });
    }

    const decoded = await firebase.auth.verifyIdToken(token);
    const email = decoded.email?.trim().toLowerCase();
    const fullName = String(req.body?.full_name || decoded.name || '').trim().slice(0, 120);
    const phone = String(req.body?.phone || '').trim().slice(0, 30);
    if (!decoded.uid || !email || fullName.length < 2) {
      return res.status(400).json({ error: 'Geçerli kullanıcı adı ve e-posta bilgisi gerekli.' });
    }

    const userRef = firebase.db.collection('users').doc(decoded.uid);
    const customerRef = firebase.db.collection('customers').doc(decoded.uid);
    const previousUser = await userRef.get();
    const previousCustomer = await customerRef.get();
    const previousData = previousUser.exists ? previousUser.data() : {};
    const previousCustomerData = previousCustomer.exists ? previousCustomer.data() : {};
    const now = new Date().toISOString();
    const createdAt = previousData.created_at || previousCustomerData.created_at || now;
    const role = previousData.role || 'customer';
    const status = previousData.status || 'active';
    // Preserve customer details already saved by the admin panel when syncing auth data.
    const resolvedPhone = phone || String(previousCustomerData.phone || previousData.phone || '').trim().slice(0, 30);
    const companyName = String(req.body?.company_name || previousCustomerData.company_name || previousData.company_name || '').trim().slice(0, 160);

    const userData = {
      uid: decoded.uid,
      full_name: fullName,
      email,
      role,
      status,
      email_verified: Boolean(decoded.email_verified),
      ...(resolvedPhone ? { phone: resolvedPhone } : {}),
      ...(companyName ? { company_name: companyName } : {}),
      created_at: createdAt,
      updated_at: now,
    };
    const batch = firebase.db.batch();
    batch.set(userRef, userData, { merge: true });
    if (role === 'customer') {
      batch.set(customerRef, {
        user_id: decoded.uid,
        full_name: fullName,
        email,
        ...(resolvedPhone ? { phone: resolvedPhone } : {}),
        ...(companyName ? { company_name: companyName } : {}),
        status,
        created_at: createdAt,
        updated_at: now,
      }, { merge: true });
    }
    await batch.commit();
    return res.json({ ok: true, uid: decoded.uid, role });
  } catch (error) {
    console.error('Customer registration sync failed:', error?.message || 'Unknown error');
    return res.status(401).json({ error: 'Kullanıcı kaydı doğrulanamadı veya Firestore kaydı yazılamadı.' });
  }
});

app.get('/api/v1/admin/config', (_req, res) => {
  const config = firebasePublicConfig();
  const enabled = Object.values(config).every(Boolean) && Boolean(process.env.ADMIN_EMAILS?.trim()) && Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim());
  res.status(200).json(enabled ? { enabled: true, firebaseConfig: config } : { enabled: false });
});

async function requireAdmin(req, res, next) {
  try {
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const firebase = getFirebaseAdmin();
    const allowedEmails = process.env.ADMIN_EMAILS?.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean) || [];
    if (!firebase || !allowedEmails.length || !token) return res.status(401).json({ error: 'Yönetici oturumu doğrulanamadı.' });
    const decoded = await firebase.auth.verifyIdToken(token);
    const email = decoded.email?.toLowerCase();
    if (!email || !allowedEmails.includes(email)) return res.status(403).json({ error: 'Bu hesap yönetici erişim listesinde bulunmuyor.' });
    req.adminUser = { id: decoded.uid, email: decoded.email };
    req.firestore = firebase.db;
    return next();
  } catch (error) {
    console.error('Admin auth error:', error?.message || 'Unknown error');
    return res.status(401).json({ error: 'Yönetici oturumu doğrulanamadı.' });
  }
}

app.get('/api/v1/admin/session', requireAdmin, (req, res) => {
  res.json({ ok: true, user: req.adminUser });
});

const resourceConfig = {
  customers: {
    search: ['full_name','company_name','email','phone'],
    create: ['full_name','company_name','email','phone','status','notes'],
    update: ['full_name','company_name','email','phone','status','notes'],
    required: ['full_name','email'],
    statuses: ['active','inactive','suspended'],
  },
  subscriptions: {
    search: ['package_name','status'],
    create: ['customer_id','package_name','status','starts_at','ends_at','amount','currency'],
    update: ['customer_id','package_name','status','starts_at','ends_at','amount','currency'],
    required: ['package_name'],
    statuses: ['trial','active','past_due','cancelled','expired','pending'],
  },
  dealers: {
    search: ['company_name','contact_name','email'],
    create: ['parent_dealer_id','company_name','contact_name','email','commission_rate','status'],
    update: ['parent_dealer_id','company_name','contact_name','email','commission_rate','status'],
    required: ['company_name','email'],
    statuses: ['pending','active','inactive','suspended'],
  },
  payments: {
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
  try {
    await req.firestore.collection('admin_audit_logs').add({
      admin_user_id: req.adminUser.id, admin_email: req.adminUser.email,
      action, resource_type: resource, resource_id: id || null, metadata,
      created_at: new Date().toISOString(),
    });
  } catch (error) { console.error('Admin audit write failed:', error?.message || 'Unknown error'); }
}

app.get('/api/v1/admin/overview', requireAdmin, async (req, res) => {
  try {
    const names = ['customers', 'subscriptions', 'dealers', 'payments'];
    const snapshots = await Promise.all(names.map((name) => req.firestore.collection(name).get()));
    const activeSubscriptions = snapshots[1].docs.filter((doc) => doc.data().status === 'active').length;
    res.json({
      counts: {
        customers: snapshots[0].size,
        activeSubscriptions,
        dealers: snapshots[2].size,
        payments: snapshots[3].size,
      },
    });
  } catch (error) {
    console.error('Admin overview Firestore error:', error?.message || 'Unknown error');
    res.status(503).json({ error: 'Firestore veritabanı okunamadı. Firebase yapılandırmasını kontrol edin.' });
  }
});

for (const [resource, config] of Object.entries(resourceConfig)) {
  app.get('/api/v1/admin/' + resource, requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 100);
      const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
      const search = String(req.query.search || '').trim().toLocaleLowerCase('tr-TR').slice(0, 120);
      const snapshot = await req.firestore.collection(resource).get();
      let items = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      items.sort((a, b) => String(b.created_at || b.createdAt || '').localeCompare(String(a.created_at || a.createdAt || '')));
      if (search) items = items.filter((item) => config.search.some((field) => String(item[field] ?? '').toLocaleLowerCase('tr-TR').includes(search)));
      const total = items.length;
      items = items.slice((page - 1) * limit, page * limit);
      res.json({ items, total, page, limit });
    } catch (error) {
      console.error('Admin list ' + resource + ' error:', error?.message || 'Unknown error');
      res.status(503).json({ error: 'Kayıtlar Firestore üzerinden alınamadı.' });
    }
  });

  if (config.create.length) app.post('/api/v1/admin/' + resource, requireAdmin, async (req, res) => {
    const payload = cleanPayload(req.body, config.create);
    for (const field of config.required) if (!payload[field]) return res.status(400).json({ error: field + ' alanı zorunludur.' });
    if (payload.status && !config.statuses.includes(payload.status)) return res.status(400).json({ error: 'Geçersiz kayıt durumu.' });
    if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin.' });
    if (payload.amount !== undefined && payload.amount !== null && (!Number.isFinite(Number(payload.amount)) || Number(payload.amount) < 0)) return res.status(400).json({ error: 'Tutar sıfır veya daha büyük olmalıdır.' });
    if (payload.commission_rate !== undefined && payload.commission_rate !== null && (!Number.isFinite(Number(payload.commission_rate)) || Number(payload.commission_rate) < 0 || Number(payload.commission_rate) > 100)) return res.status(400).json({ error: 'Komisyon oranı 0-100 arasında olmalıdır.' });
    try {
      const now = new Date().toISOString();
      const ref = await req.firestore.collection(resource).add({ ...payload, created_at: now, ...(resource === 'customers' ? { updated_at: now } : {}) });
      const doc = await ref.get();
      await audit(req, 'create', resource, ref.id);
      res.status(201).json({ item: { id: ref.id, ...doc.data() } });
    } catch (error) {
      console.error('Admin create ' + resource + ' error:', error?.message || 'Unknown error');
      res.status(400).json({ error: 'Kayıt oluşturulamadı.' });
    }
  });

  if (config.update.length) app.patch('/api/v1/admin/' + resource + '/:id', requireAdmin, async (req, res) => {
    const payload = cleanPayload(req.body, config.update);
    if (!Object.keys(payload).length) return res.status(400).json({ error: 'Güncellenecek alan bulunamadı.' });
    if (payload.status && !config.statuses.includes(payload.status)) return res.status(400).json({ error: 'Geçersiz kayıt durumu.' });
    if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin.' });
    if (payload.amount !== undefined && payload.amount !== null && (!Number.isFinite(Number(payload.amount)) || Number(payload.amount) < 0)) return res.status(400).json({ error: 'Tutar sıfır veya daha büyük olmalıdır.' });
    if (payload.commission_rate !== undefined && payload.commission_rate !== null && (!Number.isFinite(Number(payload.commission_rate)) || Number(payload.commission_rate) < 0 || Number(payload.commission_rate) > 100)) return res.status(400).json({ error: 'Komisyon oranı 0-100 arasında olmalıdır.' });
    try {
      const ref = req.firestore.collection(resource).doc(req.params.id);
      const existing = await ref.get();
      if (!existing.exists) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
      await ref.update({ ...payload, ...(resource === 'customers' ? { updated_at: new Date().toISOString() } : {}) });
      const updated = await ref.get();
      if (resource === 'customers') {
        const customer = updated.data();
        const userId = customer.user_id || req.params.id;
        const userFields = {};
        for (const field of ['full_name', 'email', 'phone', 'company_name', 'status']) {
          if (Object.hasOwn(customer, field)) userFields[field] = customer[field];
        }
        if (Object.keys(userFields).length) {
          await req.firestore.collection('users').doc(userId).set({
            ...userFields,
            updated_at: new Date().toISOString(),
          }, { merge: true });
        }
      }
      await audit(req, 'update', resource, req.params.id, { fields: Object.keys(payload) });
      res.json({ item: { id: updated.id, ...updated.data() } });
    } catch (error) {
      res.status(400).json({ error: 'Kayıt güncellenemedi. Alanları kontrol edin.' });
    }
  });

  if (resource !== 'payments') app.delete('/api/v1/admin/' + resource + '/:id', requireAdmin, async (req, res) => {
    const inactiveStatus = resource === 'subscriptions' ? 'cancelled' : 'inactive';
    try {
      const ref = req.firestore.collection(resource).doc(req.params.id);
      const existing = await ref.get();
      if (!existing.exists) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
      await ref.update({ status: inactiveStatus, ...(resource === 'customers' ? { updated_at: new Date().toISOString() } : {}) });
      await audit(req, 'deactivate', resource, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: 'Kayıt pasife alınamadı.' });
    }
  });
}

app.get('/api/v1/marketplaces/status', requireAdmin, (_req, res) => {
  res.json({ marketplaces: marketplaceStatus() });
});
app.post('/api/v1/marketplaces/hepsiburada/test', requireAdmin, async (_req, res) => {
  const result = await testHepsiburadaConnection();
  res.status(result.ok ? 200 : result.status === 'not_configured' ? 424 : 502).json(result);
});

registerIyzicoRoutes(app);

app.use((err, _req, res, _next) => {
  if (err?.message === 'Origin is not allowed by CORS') return res.status(403).json({ error: 'Origin not allowed' });
  console.error('API error:', err?.message || 'Unknown error');
  return res.status(500).json({ error: 'Internal server error' });
});
app.listen(port, () => console.log(`Trend-Entegre API listening on port ${port}`));
