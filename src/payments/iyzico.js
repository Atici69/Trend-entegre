import Iyzipay from 'iyzipay';
import { createHash, randomUUID } from 'node:crypto';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const PLANS = {
  'tek-pazaryeri': { name: 'Tek Pazaryeri', annualNet: 958800 },
  'coklu-pazaryeri': { name: 'Çoklu Pazaryeri', annualNet: 5998800 },
  'full-paket': { name: 'Full Paket', annualNet: 11998800 },
  'buybox-pro': { name: 'Buybox Pro', annualNet: 2878800 },
  'eticaret-baslangic': { name: 'E-Ticaret Başlangıç', annualNet: 1700000 },
  'eticaret-buyume': { name: 'E-Ticaret Büyüme', annualNet: 3500000 },
  'eticaret-profesyonel': { name: 'E-Ticaret Profesyonel', annualNet: 7100000 },
  'test-product-3-tl': { name: 'Test Ürünü 1', netAmount: 250, vatAmount: 50, grossAmount: 300, testOnly: true },
  'test-product-5-tl': { name: 'Test Ürünü 2', netAmount: 417, vatAmount: 83, grossAmount: 500, testOnly: true },
};

const money = (minor) => (minor / 100).toFixed(2);
const hash = (value) => createHash('sha256').update(value).digest('hex');

function firebaseServices() {
  try {
    if (!getApps().length) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (!raw) return null;
      const serviceAccount = JSON.parse(raw);
      initializeApp({ credential: cert(serviceAccount), projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id });
    }
    return { auth: getAuth(), db: getFirestore() };
  } catch (error) {
    console.error('Firebase Admin initialization failed:', error?.message || 'Unknown error');
    return null;
  }
}

function iyzicoClient() {
  const apiKey = process.env.IYZIPAY_API_KEY?.trim();
  const secretKey = process.env.IYZIPAY_SECRET_KEY?.trim();
  const uri = (process.env.IYZIPAY_URI || 'https://sandbox-api.iyzipay.com').trim();
  return apiKey && secretKey ? new Iyzipay({ apiKey, secretKey, uri }) : null;
}

function call(resource, method, payload) {
  return new Promise((resolve, reject) => resource[method](payload, (error, result) => error ? reject(error) : resolve(result || {})));
}

function returnUrl(status, planId) {
  const base = process.env.IYZIPAY_RETURN_URL?.trim();
  if (!base) return null;
  try {
    const url = new URL(base);
    url.searchParams.set('payment', status);
    if (planId) url.searchParams.set('plan', planId);
    return url.toString();
  } catch { return null; }
}

export function registerIyzicoRoutes(app) {
  app.get('/api/v1/payments/iyzico/status', (_req, res) => {
    const configured = Boolean(iyzicoClient() && process.env.IYZIPAY_CALLBACK_URL?.trim() && firebaseServices());
    res.json({ provider: 'iyzico', configured, environment: (process.env.IYZIPAY_URI || '').includes('sandbox') ? 'sandbox' : 'production', paymentModel: 'annual-one-time', vatRate: 20, installmentCount: 1 });
  });

  async function requireVerifiedUser(req, res, next) {
    try {
      const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
      const firebase = firebaseServices();
      if (!firebase || !token) return res.status(401).json({ error: 'Ödeme için giriş yapmalısınız.' });
      const decoded = await firebase.auth.verifyIdToken(token);
      if (!decoded.uid || !decoded.email || decoded.email_verified !== true) return res.status(403).json({ error: 'Ödeme öncesinde e-posta adresinizi doğrulayın.' });
      req.user = { uid: decoded.uid, email: decoded.email };
      req.db = firebase.db;
      next();
    } catch { return res.status(401).json({ error: 'Oturum doğrulanamadı.' }); }
  }

  app.post('/api/v1/payments/iyzico/initialize', requireVerifiedUser, async (req, res) => {
    const client = iyzicoClient();
    const planId = String(req.body?.planId || '');
    const plan = PLANS[planId];
    if (!client) return res.status(503).json({ error: 'iyzico ödeme ayarları hazır değil.' });
    if (!plan) return res.status(400).json({ error: 'Geçersiz paket seçimi.' });
    if (plan.testOnly) {
      const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);
      if (!adminEmails.includes(req.user.email.toLowerCase())) return res.status(403).json({ error: 'Test ürünlerini yalnızca yetkili yönetici hesabı satın alabilir.' });
    }
    if (!process.env.IYZIPAY_CALLBACK_URL?.trim()) return res.status(503).json({ error: 'Ödeme geri dönüş adresi ayarlı değil.' });

    const c = req.body?.customer || {};
    const required = ['name', 'surname', 'gsmNumber', 'identityNumber', 'city', 'district', 'address', 'zipCode'];
    if (required.some((key) => typeof c[key] !== 'string' || !c[key].trim())) return res.status(400).json({ error: 'Fatura bilgileri eksik. Ad, soyad, telefon, T.C./vergi numarası ve fatura adresini tamamlayın.' });
    const phone = c.gsmNumber.trim().replace(/[\s()-]/g, '');
    if (!/^\+90\d{10}$/.test(phone)) return res.status(400).json({ error: 'Telefonu +905XXXXXXXXX biçiminde girin.' });
    const identity = c.identityNumber.trim();
    if (!/^\d{10,11}$/.test(identity)) return res.status(400).json({ error: 'T.C. kimlik veya vergi numarası 10 ya da 11 rakam olmalıdır.' });

    const net = plan.testOnly ? plan.netAmount : plan.annualNet;
    const vat = plan.testOnly ? plan.vatAmount : Math.round(net * 0.20);
    const gross = plan.testOnly ? plan.grossAmount : net + vat;
    const attemptId = randomUUID();
    const buyerName = c.name.trim().slice(0, 50);
    const buyerSurname = c.surname.trim().slice(0, 50);
    const fullAddress = c.address.trim().slice(0, 400);
    const city = c.city.trim().slice(0, 50);
    const district = c.district.trim().slice(0, 50);
    const zipCode = c.zipCode.trim().slice(0, 20);
    const contactName = `${buyerName} ${buyerSurname}`;
    const address = { contactName, city, country: 'Turkey', address: fullAddress, zipCode };
    const request = {
      locale: Iyzipay.LOCALE.TR,
      conversationId: attemptId,
      price: money(gross),
      paidPrice: money(gross),
      currency: Iyzipay.CURRENCY.TRY,
      basketId: attemptId,
      paymentGroup: Iyzipay.PAYMENT_GROUP.PRODUCT,
      callbackUrl: process.env.IYZIPAY_CALLBACK_URL.trim(),
      enabledInstallments: [1],
      buyer: {
        id: req.user.uid.slice(0, 64),
        name: buyerName,
        surname: buyerSurname,
        gsmNumber: phone,
        email: req.user.email,
        identityNumber: identity,
        registrationAddress: fullAddress,
        ip: String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 45),
        city,
        country: 'Turkey',
        zipCode,
      },
      billingAddress: { ...address, district },
      shippingAddress: { ...address, district },
      basketItems: [
        { id: planId, name: plan.testOnly ? plan.name : `${plan.name} - 12 Aylık Lisans`, category1: 'Yazılım', category2: plan.testOnly ? 'Test Ürünü' : 'Yıllık Lisans', itemType: Iyzipay.BASKET_ITEM_TYPE.VIRTUAL, price: money(net) },
        { id: 'KDV20', name: 'KDV (%20)', category1: 'Vergi', category2: 'KDV', itemType: Iyzipay.BASKET_ITEM_TYPE.VIRTUAL, price: money(vat) },
      ],
    };

    try {
      const result = await call(client.checkoutFormInitialize, 'create', request);
      if (result.status !== 'success' || !result.token || !result.paymentPageUrl) {
        console.error('iyzico checkout initialize failed:', result.errorCode || result.errorMessage || result.status);
        return res.status(502).json({ error: 'iyzico ödeme sayfası oluşturulamadı. Lütfen daha sonra tekrar deneyin.' });
      }
      await req.db.collection('payment_attempts').doc(hash(result.token)).create({
        uid: req.user.uid, email: req.user.email, provider: 'iyzico',
        plan_id: planId, plan_name: plan.name, is_test_payment: Boolean(plan.testOnly), net_amount_minor: net,
        vat_amount_minor: vat, gross_amount_minor: gross, amount: gross / 100,
        currency: 'TRY', checkout_token_hash: hash(result.token),
        provider_conversation_id: attemptId, status: 'pending',
        billing_name: contactName, billing_phone: phone, billing_identity: identity,
        billing_address: { city, district, address: fullAddress, zipCode },
        created_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp(),
      });
      res.json({ provider: 'iyzico', paymentPageUrl: result.paymentPageUrl, totals: { net: money(net), vat: money(vat), total: money(gross), currency: 'TRY' } });
    } catch (error) {
      console.error('iyzico checkout initialize error:', error?.message || 'Unknown error');
      res.status(502).json({ error: 'Ödeme başlatılamadı. Bilgileri kontrol edip tekrar deneyin.' });
    }
  });

  app.post('/api/v1/payments/iyzico/callback', async (req, res) => {
    const token = String(req.body?.token || req.query?.token || '').trim();
    if (!token || token.length > 512) return res.status(400).send('Geçersiz ödeme bildirimi.');
    const firebase = firebaseServices();
    const client = iyzicoClient();
    if (!firebase || !client) return res.status(503).send('Ödeme doğrulama servisi hazır değil.');
    const attemptRef = firebase.db.collection('payment_attempts').doc(hash(token));
    try {
      const snap = await attemptRef.get();
      if (!snap.exists) return res.status(404).send('Ödeme kaydı bulunamadı.');
      const attempt = snap.data();
      if (attempt.status === 'paid') {
        const url = returnUrl('success', attempt.plan_id);
        return url ? res.redirect(303, url) : res.status(200).send('Ödeme zaten doğrulandı.');
      }
      const result = await call(client.checkoutForm, 'retrieve', { locale: Iyzipay.LOCALE.TR, conversationId: attempt.provider_conversation_id, token });
      const paidMinor = Math.round(Number(result.paidPrice) * 100);
      const confirmed = result.status === 'success'
        && result.paymentStatus === 'SUCCESS'
        && result.currency === 'TRY'
        && paidMinor === attempt.gross_amount_minor
        && result.basketId === attempt.provider_conversation_id;
      if (!confirmed) {
        await attemptRef.set({ status: 'failed', provider_status: String(result.paymentStatus || result.status || 'unconfirmed'), updated_at: FieldValue.serverTimestamp() }, { merge: true });
        const url = returnUrl('failed', attempt.plan_id);
        return url ? res.redirect(303, url) : res.status(200).send('Ödeme tamamlanmadı.');
      }

      if (attempt.is_test_payment === true) {
        const paymentRef = firebase.db.collection('payments').doc(String(result.paymentId));
        const batch = firebase.db.batch();
        batch.create(paymentRef, {
          customer_id: attempt.uid, user_id: attempt.uid, provider: 'iyzico',
          provider_reference: String(result.paymentId), provider_conversation_id: attempt.provider_conversation_id,
          status: 'paid', plan_id: attempt.plan_id, package_name: attempt.plan_name,
          payment_type: 'test_product', net_amount: attempt.net_amount_minor / 100,
          vat_amount: attempt.vat_amount_minor / 100, amount: attempt.gross_amount_minor / 100,
          currency: 'TRY', created_at: FieldValue.serverTimestamp(),
        });
        batch.set(attemptRef, {
          status: 'paid', provider_payment_id: String(result.paymentId),
          provider_status: result.paymentStatus, paid_at: FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp(),
        }, { merge: true });
        await batch.commit();
        const url = returnUrl('success', attempt.plan_id);
        return url ? res.redirect(303, url) : res.status(200).send('Test ürünü ödemesi doğrulandı.');
      }

      const now = new Date();
      const expiry = new Date(now);
      expiry.setFullYear(expiry.getFullYear() + 1);
      const paymentRef = firebase.db.collection('payments').doc(String(result.paymentId));
      const subscriptionRef = firebase.db.collection('subscriptions').doc(attempt.uid);
      const batch = firebase.db.batch();
      batch.create(paymentRef, {
        customer_id: attempt.uid, user_id: attempt.uid, provider: 'iyzico',
        provider_reference: String(result.paymentId), provider_conversation_id: attempt.provider_conversation_id,
        status: 'paid', plan_id: attempt.plan_id, package_name: attempt.plan_name,
        net_amount: attempt.net_amount_minor / 100, vat_amount: attempt.vat_amount_minor / 100,
        amount: attempt.gross_amount_minor / 100, currency: 'TRY',
        created_at: FieldValue.serverTimestamp(),
      });
      batch.set(subscriptionRef, {
        customer_id: attempt.uid, user_id: attempt.uid, package_id: attempt.plan_id,
        package_name: attempt.plan_name, provider: 'iyzico',
        provider_reference: String(result.paymentId), status: 'active',
        amount: attempt.gross_amount_minor / 100, currency: 'TRY',
        starts_at: now.toISOString(), ends_at: expiry.toISOString(),
        renewal_type: 'manual', auto_renew: false,
        created_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp(),
      });
      batch.set(firebase.db.collection('users').doc(attempt.uid), {
        subscription: { package_id: attempt.plan_id, package_name: attempt.plan_name, status: 'active', starts_at: now.toISOString(), ends_at: expiry.toISOString(), renewal_type: 'manual', auto_renew: false, updated_at: FieldValue.serverTimestamp() },
      }, { merge: true });
      batch.set(attemptRef, {
        status: 'paid', provider_payment_id: String(result.paymentId),
        provider_status: result.paymentStatus, paid_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      }, { merge: true });
      await batch.commit();
      const url = returnUrl('success', attempt.plan_id);
      return url ? res.redirect(303, url) : res.status(200).send('Ödeme doğrulandı. 12 aylık üyeliğiniz etkinleştirildi.');
    } catch (error) {
      console.error('iyzico callback verification failed:', error?.message || 'Unknown error');
      const url = returnUrl('error');
      return url ? res.redirect(303, url) : res.status(502).send('Ödeme doğrulaması tamamlanamadı.');
    }
  });
}
