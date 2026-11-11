import Iyzipay from 'iyzipay';
import { createHash, randomUUID } from 'node:crypto';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const PLAN_NAMES = {
  'tek-pazaryeri': 'Tek Pazaryeri',
  'coklu-pazaryeri': 'Çoklu Pazaryeri',
  'full-paket': 'Full Paket',
  'buybox-pro': 'Buybox Pro',
};

function getPlanConfig() {
  try {
    const raw = process.env.IYZIPAY_SUBSCRIPTION_PLANS_JSON;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    console.error('IYZIPAY_SUBSCRIPTION_PLANS_JSON is not valid JSON.');
    return {};
  }
}

function getFirebaseServices() {
  try {
    if (!getApps().length) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (!raw) return null;
      const serviceAccount = JSON.parse(raw);
      initializeApp({
        credential: cert(serviceAccount),
        projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id,
      });
    }
    return { auth: getAuth(), db: getFirestore() };
  } catch (error) {
    console.error('Firebase Admin initialization failed:', error?.message || 'Unknown error');
    return null;
  }
}

function getIyzicoClient() {
  const apiKey = process.env.IYZIPAY_API_KEY?.trim();
  const secretKey = process.env.IYZIPAY_SECRET_KEY?.trim();
  const uri = (process.env.IYZIPAY_URI || 'https://sandbox-api.iyzipay.com').trim();
  if (!apiKey || !secretKey) return null;
  return new Iyzipay({ apiKey, secretKey, uri });
}

function callIyzico(resource, method, payload) {
  return new Promise((resolve, reject) => {
    resource[method](payload, (error, result) => {
      if (error) return reject(error);
      return resolve(result || {});
    });
  });
}

function safeReturnUrl(status, reference) {
  const base = process.env.IYZIPAY_RETURN_URL?.trim();
  if (!base) return null;
  try {
    const url = new URL(base);
    url.searchParams.set('payment', status);
    if (reference) url.searchParams.set('reference', reference);
    return url.toString();
  } catch {
    return null;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validAddress(address) {
  return address && typeof address === 'object'
    && typeof address.address === 'string' && address.address.trim().length >= 5
    && typeof address.city === 'string' && address.city.trim()
    && typeof address.zipCode === 'string' && address.zipCode.trim();
}

export function registerIyzicoRoutes(app) {
  app.get('/api/v1/payments/iyzico/status', (_req, res) => {
    const client = getIyzicoClient();
    const plans = getPlanConfig();
    res.json({
      provider: 'iyzico',
      configured: Boolean(client && process.env.IYZIPAY_CALLBACK_URL?.trim() && getFirebaseServices()),
      environment: (process.env.IYZIPAY_URI || 'https://sandbox-api.iyzipay.com').includes('sandbox') ? 'sandbox' : 'production',
      availablePlans: Object.keys(plans).filter((key) => plans[key]?.referenceCode && PLAN_NAMES[key]),
    });
  });

  async function requireFirebaseUser(req, res, next) {
    try {
      const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
      const firebase = getFirebaseServices();
      if (!firebase || !token) return res.status(401).json({ error: 'Ödeme için Firebase kullanıcı oturumu gerekli.' });
      const decoded = await firebase.auth.verifyIdToken(token);
      if (!decoded.uid || !decoded.email) return res.status(401).json({ error: 'Doğrulanmış e-posta adresi gerekli.' });
      req.firebaseUser = { uid: decoded.uid, email: decoded.email };
      req.firestore = firebase.db;
      next();
    } catch {
      return res.status(401).json({ error: 'Kullanıcı oturumu doğrulanamadı.' });
    }
  }

  app.post('/api/v1/payments/iyzico/subscription/initialize', requireFirebaseUser, async (req, res) => {
    const client = getIyzicoClient();
    const plans = getPlanConfig();
    const planId = String(req.body?.planId || '');
    const plan = plans[planId];
    if (!client) return res.status(503).json({ error: 'iyzico sunucu ayarları henüz tamamlanmadı.' });
    if (!plan?.referenceCode || !PLAN_NAMES[planId]) return res.status(400).json({ error: 'Geçerli ve etkin bir abonelik paketi seçin.' });
    if (!process.env.IYZIPAY_CALLBACK_URL?.trim()) return res.status(503).json({ error: 'iyzico geri dönüş adresi yapılandırılmadı.' });

    const customer = req.body?.customer || {};
    const address = customer.billingAddress;
    if (
      typeof customer.name !== 'string' || !customer.name.trim()
      || typeof customer.surname !== 'string' || !customer.surname.trim()
      || typeof customer.gsmNumber !== 'string' || !/^\+[1-9]\d{7,14}$/.test(customer.gsmNumber.trim())
      || typeof customer.identityNumber !== 'string' || !/^\d{10,11}$/.test(customer.identityNumber.trim())
      || !validAddress(address)
    ) {
      return res.status(400).json({ error: 'Ad, soyad, telefon, kimlik/vergi numarası ve fatura adresi eksiksiz girilmelidir.' });
    }

    const attemptId = randomUUID();
    const billingAddress = {
      contactName: `${customer.name.trim()} ${customer.surname.trim()}`,
      city: address.city.trim(),
      district: String(address.district || address.city).trim(),
      country: 'Turkey',
      address: address.address.trim(),
      zipCode: address.zipCode.trim(),
    };
    const request = {
      locale: 'tr',
      conversationId: attemptId,
      callbackUrl: process.env.IYZIPAY_CALLBACK_URL.trim(),
      pricingPlanReferenceCode: plan.referenceCode,
      subscriptionInitialStatus: 'ACTIVE',
      customer: {
        name: customer.name.trim(),
        surname: customer.surname.trim(),
        identityNumber: customer.identityNumber.trim(),
        email: req.firebaseUser.email,
        gsmNumber: customer.gsmNumber.trim(),
        billingAddress,
        shippingAddress: billingAddress,
      },
    };

    try {
      const result = await callIyzico(client.subscriptionCheckoutForm, 'initialize', request);
      if (result.status !== 'success' || !result.token || !result.checkoutFormContent) {
        console.error('iyzico subscription initialization was not successful:', result.errorCode || result.errorMessage || result.status);
        return res.status(502).json({ error: 'iyzico ödeme formu oluşturulamadı. Lütfen daha sonra tekrar deneyin.' });
      }

      await req.firestore.collection('payment_attempts').doc(sha256(result.token)).set({
        uid: req.firebaseUser.uid,
        email: req.firebaseUser.email,
        provider: 'iyzico',
        plan_id: planId,
        plan_name: PLAN_NAMES[planId],
        amount: Number(plan.amount || 0),
        currency: 'TRY',
        checkout_token_hash: sha256(result.token),
        provider_conversation_id: attemptId,
        status: 'pending',
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      });

      return res.json({
        provider: 'iyzico',
        checkoutFormContent: result.checkoutFormContent,
        token: result.token,
        paymentPageUrl: result.paymentPageUrl || null,
      });
    } catch (error) {
      console.error('iyzico subscription initialization failed:', error?.message || 'Unknown error');
      return res.status(502).json({ error: 'Ödeme başlatılamadı. iyzico ayarlarını kontrol edin.' });
    }
  });

  app.post('/api/v1/payments/iyzico/callback', async (req, res) => {
    const token = String(req.body?.token || req.query?.token || '').trim();
    if (!token || token.length > 512) return res.status(400).send('Geçersiz ödeme bildirimi.');

    const firebase = getFirebaseServices();
    const client = getIyzicoClient();
    if (!firebase || !client) return res.status(503).send('Ödeme doğrulama servisi hazır değil.');

    const attemptRef = firebase.db.collection('payment_attempts').doc(sha256(token));
    try {
      const attemptSnapshot = await attemptRef.get();
      if (!attemptSnapshot.exists) return res.status(404).send('Ödeme kaydı bulunamadı.');
      const attempt = attemptSnapshot.data();
      if (attempt.status === 'active') {
        const existingUrl = safeReturnUrl('success', attempt.plan_id);
        return existingUrl ? res.redirect(303, existingUrl) : res.status(200).send('Ödeme daha önce doğrulandı.');
      }

      const result = await callIyzico(client.subscriptionCheckoutForm, 'retrieve', { checkoutFormToken: token });
      const subscriptionReferenceCode = result.subscriptionReferenceCode;
      const isConfirmed = result.status === 'success'
        && Boolean(subscriptionReferenceCode)
        && !['UNPAID', 'CANCELED', 'EXPIRED'].includes(result.subscriptionStatus);

      if (!isConfirmed) {
        await attemptRef.set({
          status: result.status === 'success' ? 'pending' : 'failed',
          provider_status: String(result.subscriptionStatus || result.status || 'unknown'),
          updated_at: FieldValue.serverTimestamp(),
        }, { merge: true });
        const failureUrl = safeReturnUrl('failed', attempt.plan_id);
        return failureUrl ? res.redirect(303, failureUrl) : res.status(200).send('Ödeme henüz doğrulanamadı.');
      }

      const now = new Date();
      const nextBilling = new Date(now);
      nextBilling.setMonth(nextBilling.getMonth() + 1);
      const subscriptionData = {
        customer_id: attempt.uid,
        user_id: attempt.uid,
        package_id: attempt.plan_id,
        package_name: attempt.plan_name,
        provider: 'iyzico',
        provider_reference: subscriptionReferenceCode,
        customer_reference: result.customerReferenceCode || null,
        status: 'active',
        amount: attempt.amount,
        currency: attempt.currency || 'TRY',
        starts_at: now.toISOString(),
        next_billing_at: nextBilling.toISOString(),
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      };

      const batch = firebase.db.batch();
      const subscriptionRef = firebase.db.collection('subscriptions').doc(attempt.uid);
      batch.set(subscriptionRef, subscriptionData, { merge: true });
      batch.set(attemptRef, {
        status: 'active',
        provider_reference: subscriptionReferenceCode,
        provider_status: result.subscriptionStatus || 'ACTIVE',
        subscription_id: subscriptionRef.id,
        updated_at: FieldValue.serverTimestamp(),
      }, { merge: true });
      batch.set(firebase.db.collection('users').doc(attempt.uid), {
        subscription: {
          package_id: attempt.plan_id,
          package_name: attempt.plan_name,
          status: 'active',
          provider: 'iyzico',
          provider_reference: subscriptionReferenceCode,
          updated_at: FieldValue.serverTimestamp(),
        },
      }, { merge: true });
      await batch.commit();

      const successUrl = safeReturnUrl('success', attempt.plan_id);
      return successUrl ? res.redirect(303, successUrl) : res.status(200).send('Ödeme doğrulandı. Aboneliğiniz etkinleştirildi.');
    } catch (error) {
      console.error('iyzico callback verification failed:', error?.message || 'Unknown error');
      const failureUrl = safeReturnUrl('error');
      return failureUrl ? res.redirect(303, failureUrl) : res.status(502).send('Ödeme doğrulaması tamamlanamadı.');
    }
  });
}
