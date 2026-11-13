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

app.get('/api/v1/admin/ads', requireAdmin, async (req, res) => {
  try {
    const snapshot = await req.firestore.collection('ad_campaigns').get();
    const campaigns = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    res.json({ slots: adSlots, campaigns });
  } catch (error) {
    console.error('Admin ads list failed:', error?.message || 'Unknown error');
    res.status(503).json({ error: 'Reklam kayıtları alınamadı.' });
  }
});
function validateAdPayload(body, partial = false) {
  const allowed = ['slot_id','advertiser_name','advertiser_email','title','description','image_url','target_url','starts_at','ends_at','price','billing_period','status'];
  const payload = cleanPayload(body, allowed);
  if (!partial || Object.hasOwn(payload, 'slot_id')) if (!adSlotIds.has(payload.slot_id)) return { error: 'Geçerli bir reklam alanı seçin.' };
  if (!partial || Object.hasOwn(payload, 'title')) if (!payload.title || String(payload.title).length > 120) return { error: 'Reklam başlığı zorunludur (en fazla 120 karakter).' };
  if (!partial || Object.hasOwn(payload, 'advertiser_name')) if (!payload.advertiser_name || String(payload.advertiser_name).length > 160) return { error: 'Reklam veren firma / kişi bilgisi zorunludur.' };
  if (Object.hasOwn(payload, 'advertiser_email') && payload.advertiser_email && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(payload.advertiser_email)) return { error: 'Reklam veren e-posta adresini kontrol edin.' };
  if (Object.hasOwn(payload, 'image_url')) { const url = safeAdUrl(payload.image_url); if (url === null) return { error: 'Görsel adresi http veya https olmalıdır.' }; payload.image_url = url; }
  if (Object.hasOwn(payload, 'target_url')) { const url = safeAdUrl(payload.target_url); if (url === null) return { error: 'Hedef bağlantı http veya https olmalıdır.' }; payload.target_url = url; }
  if (!partial || Object.hasOwn(payload, 'starts_at')) if (!payload.starts_at || !Number.isFinite(Date.parse(payload.starts_at))) return { error: 'Başlangıç tarihi geçerli olmalıdır.' };
  if (!partial || Object.hasOwn(payload, 'ends_at')) if (!payload.ends_at || !Number.isFinite(Date.parse(payload.ends_at))) return { error: 'Bitiş tarihi geçerli olmalıdır.' };
  if (payload.starts_at && payload.ends_at && Date.parse(payload.ends_at) <= Date.parse(payload.starts_at)) return { error: 'Bitiş tarihi başlangıç tarihinden sonra olmalıdır.' };
  if (Object.hasOwn(payload, 'price') && (!Number.isFinite(Number(payload.price)) || Number(payload.price) < 0)) return { error: 'Reklam fiyatı sıfır veya daha büyük olmalıdır.' };
  if (Object.hasOwn(payload, 'billing_period') && !['daily','period'].includes(payload.billing_period)) return { error: 'Geçersiz ücretlendirme dönemi.' };
  if (Object.hasOwn(payload, 'status') && !['draft','pending','approved','paused','expired'].includes(payload.status)) return { error: 'Geçersiz reklam durumu.' };
  return { payload };
}
app.post('/api/v1/admin/ads', requireAdmin, async (req, res) => {
  const checked = validateAdPayload(req.body || {});
  if (checked.error) return res.status(400).json({ error: checked.error });
  try {
    const now = new Date().toISOString();
    const payload = { ...checked.payload, status: checked.payload.status || 'draft', impressions: 0, clicks: 0, created_at: now, updated_at: now, created_by: req.adminUser.email };
    const ref = await req.firestore.collection('ad_campaigns').add(payload);
    await audit(req, 'create', 'ad_campaigns', ref.id, { slot_id: payload.slot_id });
    res.status(201).json({ item: { id: ref.id, ...payload } });
  } catch (error) {
    console.error('Admin ad create failed:', error?.message || 'Unknown error');
    res.status(503).json({ error: 'Reklam kaydı oluşturulamadı.' });
  }
});
app.patch('/api/v1/admin/ads/:id', requireAdmin, async (req, res) => {
  const checked = validateAdPayload(req.body || {}, true);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!Object.keys(checked.payload).length) return res.status(400).json({ error: 'Güncellenecek alan bulunamadı.' });
  try {
    const ref = req.firestore.collection('ad_campaigns').doc(req.params.id);
    const current = await ref.get();
    if (!current.exists) return res.status(404).json({ error: 'Reklam bulunamadı.' });
    const patch = { ...checked.payload, updated_at: new Date().toISOString() };
    await ref.update(patch);
    await audit(req, 'update', 'ad_campaigns', req.params.id, { fields: Object.keys(patch) });
    const updated = await ref.get();
    res.json({ item: { id: updated.id, ...updated.data() } });
  } catch (error) {
    console.error('Admin ad update failed:', error?.message || 'Unknown error');
    res.status(503).json({ error: 'Reklam güncellenemedi.' });
  }
});


const adSlots = [
  { id: 'home_top', name: 'Ana sayfa üst banner', page: 'Ana sayfa', position: 'Üst bölüm' },
  { id: 'home_slider', name: 'Ana sayfa slider', page: 'Ana sayfa', position: 'Slider' },
  { id: 'home_bottom', name: 'Ana sayfa alt banner', page: 'Ana sayfa', position: 'Alt bölüm' },
  { id: 'between_packages', name: 'Paketler arası reklam', page: 'Paketler', position: 'Paket kartları arası' },
  { id: 'product_category', name: 'Ürün / kategori sponsorluğu', page: 'Ürün ve kategori', position: 'Kategori üstü' },
  { id: 'buybox_promo', name: 'BuyBox tanıtım alanı', page: 'BuyBox', position: 'BuyBox bölümü' },
  { id: 'customer_dashboard', name: 'Müşteri paneli', page: 'Müşteri paneli', position: 'Panel içi' },
  { id: 'dealer_dashboard', name: 'Bayi paneli', page: 'Bayi paneli', position: 'Panel içi' },
  { id: 'guide_content', name: 'Rehber / içerik sayfaları', page: 'Rehber ve yardım', position: 'İçerik arası' },
  { id: 'help_content', name: 'Yardım sayfaları', page: 'Yardım merkezi', position: 'İçerik altı' },
  { id: 'package_selection', name: 'Paket seçim sayfası', page: 'Paket seçimi', position: 'Paketlerden önce' },
  { id: 'xml_content', name: 'XML ürün merkezi', page: 'XML merkezi', position: 'İçerik alanı' },
];
const adSlotIds = new Set(adSlots.map((slot) => slot.id));
function safeAdUrl(value, required = false) {
  const raw = String(value || '').trim();
  if (!raw && !required) return '';
  try {
    const url = new URL(raw);
    return ['https:', 'http:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}
function publicAdCampaign(doc) {
  const data = doc.data();
  const now = Date.now();
  const start = Date.parse(data.starts_at || '');
  const end = Date.parse(data.ends_at || '');
  if (data.status !== 'approved' || !Number.isFinite(start) || !Number.isFinite(end) || start > now || end < now) return null;
  return {
    id: doc.id, slot_id: data.slot_id, title: data.title || '', description: data.description || '',
    image_url: data.image_url || '', target_url: data.target_url || '', advertiser_name: data.advertiser_name || '',
  };
}
app.get('/api/v1/ads/:slot', async (req, res) => {
  const slot = String(req.params.slot || '');
  if (!adSlotIds.has(slot)) return res.status(404).json({ error: 'Reklam alanı bulunamadı.' });
  try {
    const snapshot = await getFirestore().collection('ad_campaigns').where('slot_id', '==', slot).where('status', '==', 'approved').limit(30).get();
    const campaigns = snapshot.docs.map(publicAdCampaign).filter(Boolean);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ campaigns });
  } catch (error) {
    console.error('Public ad read failed:', error?.message || 'Unknown error');
    res.status(503).json({ campaigns: [] });
  }
});
app.post('/api/v1/ads/:id/:event', async (req, res) => {
  const { id, event } = req.params;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !['impression', 'click'].includes(event)) return res.status(400).json({ error: 'Geçersiz reklam ölçümü.' });
  try {
    const ref = getFirestore().collection('ad_campaigns').doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().status !== 'approved') return res.status(404).json({ error: 'Reklam bulunamadı.' });
    await ref.update({ [event === 'click' ? 'clicks' : 'impressions']: FieldValue.increment(1), updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (error) {
    console.error('Ad metric update failed:', error?.message || 'Unknown error');
    res.status(503).json({ error: 'Reklam ölçümü kaydedilemedi.' });
  }
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
    const marketplaceItems = marketplaceStatus();
    const configuredMarketplaces = marketplaceItems.filter((item) => item.configured).length;
    const iyzicoConfigured = Boolean(
      process.env.IYZIPAY_API_KEY?.trim()
      && process.env.IYZIPAY_SECRET_KEY?.trim()
      && process.env.IYZIPAY_CALLBACK_URL?.trim()
    );
    const iyzicoEnvironment = (process.env.IYZIPAY_URI || 'https://sandbox-api.iyzipay.com').includes('sandbox') ? 'Sandbox test ortamı' : 'Canlı ortam';
    res.json({
      counts: {
        customers: snapshots[0].size,
        activeSubscriptions,
        dealers: snapshots[2].size,
        payments: snapshots[3].size,
      },
      systems: {
        auth: { status: 'connected', detail: 'Yönetici oturumu sunucu tarafından doğrulandı.' },
        database: { status: 'connected', detail: 'Firestore sorgusu başarıyla tamamlandı.' },
        iyzico: { status: iyzicoConfigured ? 'configured' : 'pending', detail: iyzicoConfigured ? iyzicoEnvironment + ' · API ayarları tanımlı' : 'API anahtarı veya callback ayarı eksik.' },
        marketplaces: {
          status: configuredMarketplaces === 0 ? 'pending' : configuredMarketplaces === marketplaceItems.length ? 'configured' : 'partial',
          detail: configuredMarketplaces + '/' + marketplaceItems.length + ' pazaryeri için kimlik bilgileri tanımlı; canlı bağlantı ayrıca test edilmelidir.',
        },
        xml: { status: 'development', detail: 'XML dönüştürme ve aktarım motoru henüz tamamlanmadı.' },
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
        // Customer documents are keyed by the Firebase Auth UID in this project.
        // Always sync to that same UID; a stale/mismatched customer.user_id must not redirect the write.
        const userId = req.params.id;
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
