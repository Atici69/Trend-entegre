import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { marketplaceStatus } from './src/marketplaces/index.js';
import { registerTrendyolRoutes } from './src/marketplaces/trendyol.js';
import { testHepsiburadaConnection } from './src/marketplaces/hepsiburada.js';
import { registerIyzicoRoutes } from './src/payments/iyzico.js';
import * as XLSX from 'xlsx';
import { downloadXml, parseProducts, clampProductLimit } from './src/xml/feed-service.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const allowedOrigins = [...new Set([
  'https://atici69.github.io',
  'http://localhost:3000',
  ...(process.env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean),
])];

app.disable('x-powered-by');
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
app.use('/api/v1/orders', rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false }));

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
    const now = new Date().toISOString();
    const createdAt = previousData.created_at || (previousCustomer.exists ? previousCustomer.data().created_at : null) || now;
    const role = previousData.role || 'customer';
    const status = previousData.status || 'active';

    const userData = {
      uid: decoded.uid,
      full_name: fullName,
      email,
      role,
      status,
      email_verified: Boolean(decoded.email_verified),
      ...(phone ? { phone } : {}),
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
        ...(phone ? { phone } : {}),
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


// Customer-owned billing profile: each signed-in user can read and update only their own record.
async function requireCustomer(req, res, next) {
  try {
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const firebase = getFirebaseAdmin();
    if (!firebase || !token) return res.status(401).json({ error: 'Oturum doğrulanamadı.' });
    const decoded = await firebase.auth.verifyIdToken(token);
    if (!decoded.uid || decoded.email_verified !== true) return res.status(403).json({ error: 'E-posta doğrulaması gerekli.' });
    req.customerUser = { uid: decoded.uid, email: decoded.email || '' };
    req.customerDb = firebase.db;
    next();
  } catch { return res.status(401).json({ error: 'Oturum doğrulanamadı.' }); }
}

app.get('/api/v1/customer/profile', requireCustomer, async (req, res) => {
  try {
    const [userSnap, customerSnap] = await Promise.all([
      req.customerDb.collection('users').doc(req.customerUser.uid).get(),
      req.customerDb.collection('customers').doc(req.customerUser.uid).get(),
    ]);
    const user = userSnap.exists ? userSnap.data() : {};
    const customer = customerSnap.exists ? customerSnap.data() : {};
    const profile = { ...customer, ...user };
    res.json({ profile: {
      full_name: profile.full_name || '', phone: profile.phone || '', company_name: profile.company_name || '',
      company_type: profile.company_type || '', tax_office: profile.tax_office || '', tax_number: profile.tax_number || '',
      city: profile.city || '', district: profile.district || '', address: profile.address || '', zip_code: profile.zip_code || '',
      billing_profile_completed: profile.billing_profile_completed === true,
    } });
  } catch (error) {
    console.error('Customer profile read failed:', error?.message || 'Unknown error');
    res.status(503).json({ error: 'Profil bilgileri şu anda alınamadı.' });
  }
});

app.put('/api/v1/customer/profile', requireCustomer, async (req, res) => {
  const b = req.body || {};
  const allowed = ['full_name','phone','company_name','company_type','tax_office','tax_number','city','district','address','zip_code'];
  const profile = Object.fromEntries(allowed.map(key => [key, String(b[key] || '').trim()]));
  if (profile.full_name.length < 2 || !profile.phone || !profile.company_type || !profile.city || !profile.district || !profile.address || !profile.zip_code || !profile.tax_number) {
    return res.status(400).json({ error: 'Zorunlu profil alanlarını tamamlayın.' });
  }
  if (!['sole_proprietor','limited','joint_stock','other'].includes(profile.company_type)) return res.status(400).json({ error: 'Geçersiz şirket türü.' });
  const expectedTaxLength = profile.company_type === 'sole_proprietor' ? 11 : 10;
  if (!(expectedTaxLength === 11 ? /^\d{11}$/.test(profile.tax_number) : /^\d{10}$/.test(profile.tax_number))) return res.status(400).json({ error: profile.company_type === 'sole_proprietor' ? 'Şahıs işletmesi için 11 haneli T.C. kimlik numarası girin.' : 'Şirketler için 10 haneli vergi numarası girin.' });
  if (profile.company_type !== 'sole_proprietor' && !profile.tax_office) return res.status(400).json({ error: 'Vergi dairesi alanını doldurun.' });
  const now = new Date().toISOString();
  const data = { ...profile, email: req.customerUser.email, billing_profile_completed: true, billing_profile_updated_at: now, updated_at: now };
  try {
    const batch = req.customerDb.batch();
    batch.set(req.customerDb.collection('users').doc(req.customerUser.uid), { ...data, uid: req.customerUser.uid }, { merge: true });
    batch.set(req.customerDb.collection('customers').doc(req.customerUser.uid), { ...data, user_id: req.customerUser.uid, status: 'active' }, { merge: true });
    await batch.commit();
    res.json({ ok: true, profile: data });
  } catch (error) {
    console.error('Customer profile save failed:', error?.message || 'Unknown error');
    res.status(503).json({ error: 'Profil kaydedilemedi. Lütfen tekrar deneyin.' });
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
registerTrendyolRoutes(app, requireAdmin);
app.post('/api/v1/marketplaces/hepsiburada/test', requireAdmin, async (_req, res) => {
  const result = await testHepsiburadaConnection();
  res.status(result.ok ? 200 : result.status === 'not_configured' ? 424 : 502).json(result);
});


function normalizeProfitMargin(value) {
  const margin = Number(value);
  if (!Number.isFinite(margin) || margin < 0 || margin > 1000) throw new Error('Kâr oranı 0 ile 1000 arasında bir yüzde olmalıdır.');
  return Math.round(margin * 100) / 100;
}
function priceNumber(value) {
  let raw = String(value ?? '').trim().replace(/[^0-9,.-]/g, '');
  if (!raw || !/\d/.test(raw)) return null;
  const comma = raw.lastIndexOf(','), dot = raw.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    raw = comma > dot ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
  } else if (comma >= 0) raw = raw.replace(',', '.');
  else if (dot >= 0 && /^-?\d{1,3}(\.\d{3})+$/.test(raw)) raw = raw.replace(/\./g, '');
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function applyProfitMargin(products, marginValue) {
  const margin = normalizeProfitMargin(marginValue ?? 0);
  return products.map(product => {
    const costText = String(product['Fiyat'] ?? '').trim(), cost = priceNumber(costText);
    const result = { ...product, 'Alış Fiyatı': costText, 'Kâr Oranı (%)': margin,
      'Satış Fiyatı': cost === null ? '' : (Math.round((cost * (1 + margin / 100) + Number.EPSILON) * 100) / 100).toFixed(2) };
    delete result['Fiyat'];
    return result;
  });
}


// Product catalog: public reads only active products; every write is admin-only.
function catalogText(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function catalogProduct(body, previous = {}) {
  const name = catalogText(body.name ?? previous.name, 180);
  const category = catalogText(body.category ?? previous.category, 100);
  const description = catalogText(body.description ?? previous.description, 5000);
  const imageUrl = catalogText(body.image_url ?? previous.image_url, 2048);
  const sku = catalogText(body.sku ?? previous.sku, 100);
  const stock = Number(body.stock ?? previous.stock ?? 0);
  const cost = Number(body.cost_price ?? previous.cost_price ?? 0);
  const margin = Number(body.margin_percent ?? previous.margin_percent ?? 0);
  const status = catalogText(body.status ?? previous.status ?? 'draft', 20);
  const marginChanged = body.margin_percent !== undefined && Number(body.margin_percent) !== Number(previous.margin_percent ?? 0);
  const saleInput = body.sale_price;
  let price = saleInput !== undefined && saleInput !== null && String(saleInput).trim() !== ''
    ? Number(saleInput)
    : (marginChanged || previous.sale_price === undefined ? null : Number(previous.sale_price));
  if (price === null) price = Math.round((cost * (1 + margin / 100) + Number.EPSILON) * 100) / 100;
  if (!name || !Number.isFinite(stock) || stock < 0 || !Number.isFinite(cost) || cost < 0 ||
      !Number.isFinite(margin) || margin < 0 || margin > 1000 ||
      !Number.isFinite(price) || price < 0 || !['draft','active','archived'].includes(status)) {
    throw new Error('Ürün adı, fiyat, stok, kâr oranı veya yayın durumu geçersiz.');
  }
  if (imageUrl) {
    let parsed;
    try { parsed = new URL(imageUrl); } catch { throw new Error('Görsel adresi geçersiz.'); }
    if (!['https:','http:'].includes(parsed.protocol)) throw new Error('Görsel adresi HTTP veya HTTPS olmalıdır.');
  }
  return { name, category, description, image_url: imageUrl, sku, stock,
    cost_price: Math.round(cost * 100) / 100, margin_percent: Math.round(margin * 100) / 100,
    sale_price: Math.round(price * 100) / 100, status, updated_at: new Date().toISOString() };
}

app.get('/api/v1/catalog/products', async (req, res) => {
  try {
    const firebase = getFirebaseAdmin();
    if (!firebase) return res.status(503).json({ error: 'Katalog şu anda kullanılamıyor.' });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 48, 1), 100);
    const snapshot = await firebase.db.collection('catalog_products').where('status', '==', 'active').limit(limit).get();
    const products = snapshot.docs.map(doc => {
      const p = doc.data();
      return { id: doc.id, name: p.name, category: p.category || '', description: p.description || '',
        image_url: p.image_url || '', sku: p.sku || '', stock: p.stock || 0,
        sale_price: p.sale_price || 0, currency: p.currency || 'TRY' };
    });
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ products });
  } catch (error) {
    console.error('Public catalog read failed:', error?.message || 'Unknown error');
    res.status(503).json({ error: 'Ürünler şu anda alınamıyor.' });
  }
});

// Customer orders: prices and product availability are always re-read on the server.
app.post('/api/v1/orders', requireCustomer, async (req, res) => {
  try {
    const firebase = getFirebaseAdmin();
    if (!firebase) return res.status(503).json({ error: 'Sipariş servisi şu anda kullanılamıyor.' });
    const buyer = req.body?.buyer || {};
    const name = catalogText(buyer.name, 120);
    const phone = catalogText(buyer.phone, 30).replace(/[\s()-]/g, '');
    const email = catalogText(buyer.email, 160).toLowerCase();
    const address = catalogText(buyer.address, 600);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (name.length < 2 || !/^\+?[0-9]{10,14}$/.test(phone) || address.length < 8) {
      return res.status(400).json({ error: 'Ad soyad, geçerli telefon ve teslimat adresi zorunludur.' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'E-posta adresi geçerli değil.' });
    }
    if (!items.length || items.length > 20) return res.status(400).json({ error: 'Sepette 1 ile 20 arasında farklı ürün bulunmalıdır.' });
    const normalized = new Map();
    for (const item of items) {
      const id = catalogText(item?.product_id, 180);
      const quantity = Number(item?.quantity);
      if (!id || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
        return res.status(400).json({ error: 'Ürün veya adet bilgisi geçersiz. Ürün başına en fazla 10 adet sipariş verilebilir.' });
      }
      normalized.set(id, (normalized.get(id) || 0) + quantity);
    }
    if ([...normalized.values()].some(quantity => quantity > 10)) {
      return res.status(400).json({ error: 'Bir üründen en fazla 10 adet sipariş verebilirsiniz.' });
    }

    const orderRef = firebase.db.collection('catalog_orders').doc();
    const result = await firebase.db.runTransaction(async (transaction) => {
      const productRefs = [...normalized.keys()].map(id => firebase.db.collection('catalog_products').doc(id));
      const snapshots = await Promise.all(productRefs.map(ref => transaction.get(ref)));
      const orderItems = [];
      let totalMinor = 0;
      snapshots.forEach((snapshot, index) => {
        const quantity = [...normalized.values()][index];
        if (!snapshot.exists) throw new Error('Sepetinizdeki bir ürün artık bulunamıyor. Kataloğu yenileyin.');
        const product = snapshot.data();
        if (product.status !== 'active') throw new Error('Sepetinizdeki bir ürün artık satışta değil.');
        const stock = Math.max(0, Number(product.stock || 0));
        if (stock < quantity) throw new Error((product.name || 'Ürün') + ' için yeterli stok bulunmuyor.');
        const unitMinor = Math.round(Number(product.sale_price || 0) * 100);
        if (!Number.isSafeInteger(unitMinor) || unitMinor <= 0) throw new Error((product.name || 'Ürün') + ' için satış fiyatı geçersiz.');
        const lineMinor = unitMinor * quantity;
        if (!Number.isSafeInteger(lineMinor) || !Number.isSafeInteger(totalMinor + lineMinor)) throw new Error('Sipariş tutarı hesaplanamadı.');
        totalMinor += lineMinor;
        transaction.update(productRefs[index], { stock: stock - quantity, updated_at: new Date().toISOString() });
        orderItems.push({
          product_id: snapshot.id, name: catalogText(product.name, 180),
          sku: catalogText(product.sku, 100), quantity,
          unit_price_minor: unitMinor, line_total_minor: lineMinor,
          currency: catalogText(product.currency || 'TRY', 8),
        });
      });
      const order = {
        order_number: orderRef.id.slice(-10).toUpperCase(),
        status: 'new', payment_status: 'not_started', stock_reserved: true,
        payment_method: 'pending_manual_confirmation',
        uid: req.customerUser.uid,
        buyer: { name, phone, email: req.customerUser.email || email, address },
        items: orderItems, item_count: orderItems.reduce((sum, item) => sum + item.quantity, 0),
        total_minor: totalMinor, currency: 'TRY',
        created_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp(),
      };
      transaction.create(orderRef, order);
      return { id: orderRef.id, order_number: order.order_number, total: (totalMinor / 100).toFixed(2), currency: 'TRY' };
    });
    res.status(201).json({ ok: true, order: result, message: 'Sipariş talebiniz alındı. Ödeme ve teslimat için sizinle iletişime geçeceğiz.' });
  } catch (error) {
    const message = error.message || 'Sipariş kaydedilemedi.';
    const clientError = /bulunamıyor|satışta değil|stok bulunmuyor|fiyatı geçersiz|tutarı hesaplanamadı/.test(message);
    res.status(clientError ? 409 : 400).json({ error: message });
  }
});

app.get('/api/v1/customer/orders', requireCustomer, async (req, res) => {
  try {
    const snapshot = await req.customerDb.collection('catalog_orders')
      .where('uid', '==', req.customerUser.uid).limit(50).get();
    const orders = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id, order_number: data.order_number, status: data.status,
        payment_status: data.payment_status, payment_method: data.payment_method,
        items: Array.isArray(data.items) ? data.items.map(item => ({
          name: item.name, quantity: item.quantity,
          unit_price_minor: item.unit_price_minor, line_total_minor: item.line_total_minor,
        })) : [],
        item_count: data.item_count, total_minor: data.total_minor, currency: data.currency || 'TRY',
        created_at: data.created_at?.toDate?.()?.toISOString?.() || null,
      };
    }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    res.json({ orders });
  } catch (error) {
    console.error('Customer orders read failed:', error?.message || 'Unknown error');
    res.status(503).json({ error: 'Sipariş geçmişiniz şu anda alınamıyor.' });
  }
});

app.get('/api/v1/admin/catalog/orders', requireAdmin, async (req, res) => {
  try {
    const snapshot = await req.firestore.collection('catalog_orders').orderBy('created_at', 'desc').limit(100).get();
    const orders = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id, order_number: data.order_number, status: data.status,
        payment_status: data.payment_status, buyer: data.buyer,
        items: data.items, item_count: data.item_count,
        total_minor: data.total_minor, currency: data.currency,
        created_at: data.created_at?.toDate?.()?.toISOString?.() || null,
      };
    });
    res.json({ orders });
  } catch (error) {
    console.error('Catalog orders read failed:', error?.message || 'Unknown error');
    res.status(503).json({ error: 'Siparişler alınamadı.' });
  }
});

app.patch('/api/v1/admin/catalog/orders/:id', requireAdmin, async (req, res) => {
  try {
    const status = catalogText(req.body?.status, 20);
    if (!['confirmed', 'cancelled', 'fulfilled'].includes(status)) {
      return res.status(400).json({ error: 'Geçersiz sipariş durumu.' });
    }
    const ref = req.firestore.collection('catalog_orders').doc(req.params.id);
    const result = await req.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error('Sipariş bulunamadı.');
      const order = snapshot.data();
      if (status === 'cancelled' && order.payment_status === 'pending') throw new Error('Ödeme işlemi devam eden sipariş iptal edilemez. Önce ödeme sonucunu bekleyin.');
      if (order.status === 'fulfilled' && status !== 'fulfilled') throw new Error('Tamamlanan siparişin durumu değiştirilemez.');
      if (order.status === 'cancelled' && status !== 'cancelled') throw new Error('İptal edilen sipariş yeniden açılamaz.');
      if (status === 'fulfilled' && order.status !== 'confirmed') throw new Error('Önce siparişi onaylamalısınız.');
      if (status === 'cancelled' && order.stock_reserved) {
        const items = Array.isArray(order.items) ? order.items : [];
        const productRefs = items.map(item => req.firestore.collection('catalog_products').doc(item.product_id));
        const productSnapshots = await Promise.all(productRefs.map(productRef => transaction.get(productRef)));
        productSnapshots.forEach((productSnapshot, index) => {
          if (!productSnapshot.exists) return;
          const currentStock = Math.max(0, Number(productSnapshot.data().stock || 0));
          transaction.update(productRefs[index], {
            stock: currentStock + Number(items[index].quantity || 0),
            updated_at: new Date().toISOString(),
          });
        });
      }
      transaction.update(ref, {
        status, stock_reserved: status === 'cancelled' ? false : Boolean(order.stock_reserved),
        updated_at: FieldValue.serverTimestamp(),
      });
      return { id: ref.id, status };
    });
    await audit(req, 'update', 'catalog_order', ref.id, { status });
    res.json({ ok: true, ...result });
  } catch (error) {
    const message = error.message || 'Sipariş durumu güncellenemedi.';
    res.status(message === 'Sipariş bulunamadı.' ? 404 : 400).json({ error: message });
  }
});

app.get('/api/v1/admin/catalog/products', requireAdmin, async (req, res) => {
  try {
    const snapshot = await req.firestore.collection('catalog_products').get();
    const products = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a,b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    res.json({ products });
  } catch { res.status(503).json({ error: 'Katalog ürünleri alınamadı.' }); }
});

app.post('/api/v1/admin/catalog/products', requireAdmin, async (req, res) => {
  try {
    const product = catalogProduct(req.body || {});
    const now = new Date().toISOString();
    const ref = await req.firestore.collection('catalog_products').add({
      ...product, source: 'manual', created_at: now, created_by: req.adminUser.id,
    });
    await audit(req, 'create', 'catalog_product', ref.id, { name: product.name });
    res.status(201).json({ product: { id: ref.id, ...product } });
  } catch (error) { res.status(400).json({ error: error.message || 'Ürün kaydedilemedi.' }); }
});

app.patch('/api/v1/admin/catalog/products/:id', requireAdmin, async (req, res) => {
  try {
    const ref = req.firestore.collection('catalog_products').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Ürün bulunamadı.' });
    const product = catalogProduct(req.body || {}, snap.data());
    await ref.update(product);
    await audit(req, 'update', 'catalog_product', ref.id, { name: product.name });
    res.json({ product: { id: ref.id, ...snap.data(), ...product } });
  } catch (error) { res.status(400).json({ error: error.message || 'Ürün güncellenemedi.' }); }
});

app.delete('/api/v1/admin/catalog/products/:id', requireAdmin, async (req, res) => {
  try {
    const ref = req.firestore.collection('catalog_products').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Ürün bulunamadı.' });
    await ref.delete();
    await audit(req, 'delete', 'catalog_product', ref.id);
    res.json({ ok: true });
  } catch { res.status(503).json({ error: 'Ürün silinemedi.' }); }
});

app.post('/api/v1/admin/catalog/import-xml', requireAdmin, async (req, res) => {
  try {
    const feedId = catalogText(req.body?.feed_id, 160);
    if (!feedId) return res.status(400).json({ error: 'Önce kayıtlı bir XML kaynağı seçin.' });
    const feedRef = req.firestore.collection('xml_feeds').doc(feedId);
    const feedSnap = await feedRef.get();
    if (!feedSnap.exists) return res.status(404).json({ error: 'XML kaynağı bulunamadı.' });
    const feed = feedSnap.data();
    const sourceProducts = parseProducts(await downloadXml(feed.url));
    const margin = normalizeProfitMargin(feed.margin_percent ?? 0);
    const existingSnapshot = await req.firestore.collection('catalog_products').where('source_feed_id', '==', feedId).get();
    const existingByExternalId = new Map(existingSnapshot.docs.map(doc => [String(doc.data().external_id || ''), doc.data()]));
    const writer = req.firestore.bulkWriter();
    let imported = 0;
    for (let index = 0; index < sourceProducts.length; index += 1) {
      const source = sourceProducts[index];
      const name = catalogText(source['Ürün Adı'], 180);
      if (!name) continue;
      const externalId = catalogText(source['Ürün ID'] || source.SKU || (name + '-' + index), 180);
      const key = encodeURIComponent(externalId).replace(/%/g, '_').slice(0, 500);
      const id = feedId + '_' + key;
      const old = existingByExternalId.get(externalId) || {};
      const cost = priceNumber(source['Fiyat']);
      const sale = cost === null ? Number(old.sale_price || 0) : Math.round((cost * (1 + margin / 100) + Number.EPSILON) * 100) / 100;
      const data = {
        name, sku: catalogText(source.SKU,100), barcode: catalogText(source['Barkod'],100),
        brand: catalogText(source['Marka'],120), category: catalogText(source['Kategori'],100),
        description: catalogText(source['Açıklama'],5000), image_url: catalogText(source['Görsel URL'],2048),
        stock: Math.max(0, Number(priceNumber(source['Stok']) ?? old.stock ?? 0)),
        cost_price: cost === null ? Number(old.cost_price || 0) : cost,
        margin_percent: margin, sale_price: sale,
        currency: catalogText(source['Para Birimi'] || 'TRY',8),
        source: 'xml', source_feed_id: feedId, source_feed_name: catalogText(feed.name,100),
        external_id: externalId, status: old.status || 'draft',
        updated_at: new Date().toISOString(), created_at: old.created_at || new Date().toISOString(),
      };
      writer.set(req.firestore.collection('catalog_products').doc(id), data, { merge: true });
      imported += 1;
    }
    await writer.close();
    await audit(req, 'import_xml', 'catalog', feedId, { imported, parsed: sourceProducts.length });
    res.json({ imported, parsed: sourceProducts.length, margin_percent: margin,
      message: 'XML ürünleri kataloğa taslak olarak aktarıldı. Yayına almak için ürün durumunu Satışta yapın.' });
  } catch (error) { res.status(400).json({ error: error.message || 'XML ürünleri kataloğa aktarılamadı.' }); }
});

app.get('/api/v1/admin/xml/feeds', requireAdmin, async (req, res) => {
  try {
    const snapshot = await req.firestore.collection('xml_feeds').get();
    const feeds = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    res.json({ feeds });
  } catch (error) {
    console.error('Admin XML feed list failed:', error?.message || 'Unknown error');
    res.status(503).json({ error: 'XML kaynakları alınamadı. Firestore okuma hatası: ' + (error?.message || 'Bilinmeyen hata') });
  }
});

app.post('/api/v1/admin/xml/preview', requireAdmin, async (req, res) => {
  try {
    let url = String(req.body?.url || '').trim();
    if (req.body?.feed_id) {
      const saved = await req.firestore.collection('xml_feeds').doc(String(req.body.feed_id)).get();
      if (!saved.exists) return res.status(404).json({ error: 'Kayıtlı XML kaynağı bulunamadı.' });
      url = saved.data().url;
    }
    const xml = await downloadXml(url);
    const products = parseProducts(xml);
    const margin = normalizeProfitMargin(req.body?.marginPercent ?? 0);
    const pricedProducts = applyProfitMargin(products, margin);
    res.json({ totalProducts: pricedProducts.length, marginPercent: margin, preview: pricedProducts.slice(0, 10) });
  } catch (error) {
    res.status(400).json({ error: error.message || 'XML kaynağı okunamadı.' });
  }
});

app.post('/api/v1/admin/xml/feeds', requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 100);
  const url = String(req.body?.url || '').trim().slice(0, 2048);
  if (name.length < 2 || !url) return res.status(400).json({ error: 'Kaynak adı ve XML adresi gereklidir.' });
  try {
    const xml = await downloadXml(url);
    const products = parseProducts(xml);
    const marginPercent = normalizeProfitMargin(req.body?.marginPercent ?? 0);
    const now = new Date().toISOString();
    const ref = await req.firestore.collection('xml_feeds').add({
      name, url, products_count: products.length, margin_percent: marginPercent, last_tested_at: now,
      created_at: now, updated_at: now, created_by: req.adminUser.id,
    });
    await audit(req, 'create', 'xml_feed', ref.id, { name, products_count: products.length });
    res.status(201).json({ feed: { id: ref.id, name, url, products_count: products.length, margin_percent: marginPercent, last_tested_at: now } });
  } catch (error) {
    res.status(400).json({ error: error.message || 'XML kaynağı kaydedilemedi.' });
  }
});

app.patch('/api/v1/admin/xml/feeds/:id', requireAdmin, async (req, res) => {
  try {
    const marginPercent = normalizeProfitMargin(req.body?.marginPercent);
    const ref = req.firestore.collection('xml_feeds').doc(req.params.id);
    const existing = await ref.get();
    if (!existing.exists) return res.status(404).json({ error: 'XML kaynağı bulunamadı.' });
    await ref.update({ margin_percent: marginPercent, updated_at: new Date().toISOString() });
    await audit(req, 'update_margin', 'xml_feed', req.params.id, { margin_percent: marginPercent });
    res.json({ ok: true, margin_percent: marginPercent });
  } catch (error) { res.status(400).json({ error: error.message || 'Kâr oranı kaydedilemedi.' }); }
});

app.delete('/api/v1/admin/xml/feeds/:id', requireAdmin, async (req, res) => {
  try {
    const ref = req.firestore.collection('xml_feeds').doc(req.params.id);
    const existing = await ref.get();
    if (!existing.exists) return res.status(404).json({ error: 'XML kaynağı bulunamadı.' });
    await ref.delete();
    await audit(req, 'delete', 'xml_feed', req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: 'XML kaynağı silinemedi.' });
  }
});

app.post('/api/v1/admin/xml/export', requireAdmin, async (req, res) => {
  try {
    let url = String(req.body?.url || '').trim();
    let fileName = 'urunler';
    let savedMarginForExport = 0;
    if (req.body?.feed_id) {
      const saved = await req.firestore.collection('xml_feeds').doc(String(req.body.feed_id)).get();
      if (!saved.exists) return res.status(404).json({ error: 'Kayıtlı XML kaynağı bulunamadı.' });
      url = saved.data().url;
      savedMarginForExport = saved.data().margin_percent ?? 0;
      fileName = String(saved.data().name || fileName).replace(/[^a-z0-9-_]+/gi, '-').slice(0, 50) || fileName;
    }
    const xml = await downloadXml(url);
    const products = parseProducts(xml);
    const pricedProducts = applyProfitMargin(products, savedMarginForExport);
    const count = clampProductLimit(req.body?.limit ?? 'all', pricedProducts.length);
    const selected = pricedProducts.slice(0, count);
    const format = String(req.body?.format || 'xlsx').toLowerCase();
    if (!['xlsx', 'csv', 'xml'].includes(format)) return res.status(400).json({ error: 'Çıktı biçimi XLSX, CSV veya XML olmalıdır.' });
    let buffer, contentType, extension;
    if (format === 'xlsx') {
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(selected);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Ürünler');
      buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      extension = 'xlsx';
    } else if (format === 'csv') {
      const safeRows = selected.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
        const text = String(value ?? '');
        const first = text.charCodeAt(0);
        return [key, [61, 43, 45, 64, 9, 13].includes(first) ? "'" + text : text];
      })));
      const worksheet = XLSX.utils.json_to_sheet(safeRows);
      buffer = Buffer.from(XLSX.utils.sheet_to_csv(worksheet, { FS: ';' }), 'utf8');
      contentType = 'text/csv; charset=utf-8';
      extension = 'csv';
    } else {
      const escapeXml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
      const records = selected.map((row, index) => '<product><id>' + escapeXml(row['Ürün ID'] || index + 1) +
        '</id><name>' + escapeXml(row['Ürün Adı']) + '</name><sku>' + escapeXml(row.SKU) +
        '</sku><barcode>' + escapeXml(row.Barkod) + '</barcode><brand>' + escapeXml(row.Marka) +
        '</brand><category>' + escapeXml(row.Kategori) + '</category><price>' + escapeXml(row['Satış Fiyatı']) +
        '</price><cost_price>' + escapeXml(row['Alış Fiyatı']) + '</cost_price><stock>' + escapeXml(row.Stok) +
        '</stock><image>' + escapeXml(row['Görsel URL']) + '</image><description>' + escapeXml(row.Açıklama) +
        '</description></product>').join('');
      buffer = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><products>' + records + '</products>', 'utf8');
      contentType = 'application/xml; charset=utf-8';
      extension = 'xml';
    }
    await audit(req, 'export', 'xml_feed', req.body?.feed_id || null, { exported_products: selected.length, format });
    const downloadName = fileName + '.' + extension;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'attachment; filename="download.' + extension + '"; filename*=UTF-8\'\'' + encodeURIComponent(downloadName));
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Excel dosyası oluşturulamadı.' });
  }
});

registerIyzicoRoutes(app);

app.use((err, _req, res, _next) => {
  if (err?.message === 'Origin is not allowed by CORS') return res.status(403).json({ error: 'Origin not allowed' });
  console.error('API error:', err?.message || 'Unknown error');
  return res.status(500).json({ error: 'Internal server error' });
});
app.listen(port, () => console.log(`Trend-Entegre API listening on port ${port}`));
