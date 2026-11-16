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

function orderReturnUrl(status, orderNumber) {
  const base = (process.env.IYZIPAY_ORDER_RETURN_URL || process.env.IYZIPAY_RETURN_URL || '').trim();
  if (!base) return null;
  try {
    const url = new URL(base);
    url.searchParams.set('payment', status);
    url.searchParams.set('purchase', 'catalog');
    if (orderNumber) url.searchParams.set('order', orderNumber);
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
    if (!process.env.IYZIPAY_CALLBACK_URL?.trim()) return res.status(503).json({ error: 'Ödeme geri dönüş adresi ayarlı değil.' });

    const c = req.body?.customer || {};
    const required = ['name', 'surname', 'gsmNumber', 'identityNumber', 'city', 'district', 'address', 'zipCode'];
    if (required.some((key) => typeof c[key] !== 'string' || !c[key].trim())) return res.status(400).json({ error: 'Fatura bilgileri eksik. Ad, soyad, telefon, T.C./vergi numarası ve fatura adresini tamamlayın.' });
    const phone = c.gsmNumber.trim().replace(/[\s()-]/g, '');
    if (!/^\+90\d{10}$/.test(phone)) return res.status(400).json({ error: 'Telefonu +905XXXXXXXXX biçiminde girin.' });
    const identity = c.identityNumber.trim();
    if (!/^\d{10,11}$/.test(identity)) return res.status(400).json({ error: 'T.C. kimlik veya vergi numarası 10 ya da 11 rakam olmalıdır.' });

    const net = plan.annualNet;
    const vat = Math.round(net * 0.20);
    const gross = net + vat;
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
        { id: planId, name: `${plan.name} - 12 Aylık Lisans`, category1: 'Yazılım', category2: 'Yıllık Lisans', itemType: Iyzipay.BASKET_ITEM_TYPE.VIRTUAL, price: money(net) },
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
        plan_id: planId, plan_name: plan.name, net_amount_minor: net,
        vat_amount_minor: vat, gross_amount_minor: gross, amount: gross / 100,
        currency: 'TRY', checkout_token_hash: hash(result.token),
        provider_conversation_id: attemptId, status: 'pending',
        billing_name: contactName, billing_company: String(c.companyName || '').trim().slice(0, 120), billing_company_type: String(c.companyType || '').trim(), billing_tax_office: String(c.taxOffice || '').trim().slice(0, 120), billing_phone: phone, billing_identity: identity,
        billing_address: { city, district, address: fullAddress, zipCode },
        created_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp(),
      });
      res.json({ provider: 'iyzico', paymentPageUrl: result.paymentPageUrl, totals: { net: money(net), vat: money(vat), total: money(gross), currency: 'TRY' } });
    } catch (error) {
      console.error('iyzico checkout initialize error:', error?.message || 'Unknown error');
      res.status(502).json({ error: 'Ödeme başlatılamadı. Bilgileri kontrol edip tekrar deneyin.' });
    }
  });

  app.post('/api/v1/payments/iyzico/orders/:orderId/initialize', requireVerifiedUser, async (req, res) => {
    const client = iyzicoClient();
    if (!client) return res.status(503).json({ error: 'iyzico ödeme ayarları hazır değil.' });
    if (!process.env.IYZIPAY_CALLBACK_URL?.trim()) return res.status(503).json({ error: 'Ödeme geri dönüş adresi ayarlı değil.' });
    const orderId = String(req.params.orderId || '').trim();
    if (!orderId || orderId.length > 180) return res.status(400).json({ error: 'Sipariş numarası geçersiz.' });

    try {
      const orderRef = req.db.collection('catalog_orders').doc(orderId);
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
      const order = orderSnap.data();
      if (order.uid !== req.user.uid) return res.status(403).json({ error: 'Bu sipariş için ödeme başlatamazsınız.' });
      if (order.payment_status === 'paid') return res.status(409).json({ error: 'Bu siparişin ödemesi zaten tamamlanmış.' });
      if (order.payment_status === 'pending') return res.status(409).json({ error: 'Bu sipariş için bir ödeme işlemi zaten başlatılmış. Sonucu bekleyin; ödeme ekranı kapanmışsa destek ekibiyle iletişime geçin.' });
      if (order.status !== 'new') return res.status(409).json({ error: 'Yalnızca yeni durumdaki siparişler ödenebilir.' });
      const items = Array.isArray(order.items) ? order.items : [];
      const totalMinor = Number(order.total_minor);
      if (!items.length || !Number.isSafeInteger(totalMinor) || totalMinor <= 0) return res.status(400).json({ error: 'Sipariş tutarı geçersiz.' });
      if (items.some(item => item.currency !== 'TRY' || !Number.isSafeInteger(Number(item.line_total_minor)) || Number(item.line_total_minor) <= 0)) {
        return res.status(400).json({ error: 'Bu siparişteki ürünlerin para birimi veya tutarı online ödemeye uygun değil. Destek ekibiyle iletişime geçin.' });
      }
      if (items.reduce((sum, item) => sum + Number(item.line_total_minor), 0) !== totalMinor) {
        return res.status(409).json({ error: 'Sipariş toplamı doğrulanamadı.' });
      }

      const profileSnap = await req.db.collection('users').doc(req.user.uid).get();
      const profile = profileSnap.exists ? profileSnap.data() : {};
      const fullName = String(profile.full_name || order.buyer?.name || '').trim();
      const nameParts = fullName.split(/\s+/).filter(Boolean);
      const buyerName = (nameParts.shift() || 'Müşteri').slice(0, 50);
      const buyerSurname = (nameParts.join(' ') || ' ').trim().slice(0, 50) || 'Müşteri';
      const rawPhone = String(profile.phone || order.buyer?.phone || '').trim();
      const digits = rawPhone.replace(/\D/g, '');
      const phone = digits.startsWith('90') && digits.length === 12 ? '+' + digits
        : digits.startsWith('0') && digits.length === 11 ? '+9' + digits
        : digits.length === 10 ? '+90' + digits : '';
      const identity = String(profile.tax_number || '').trim();
      const city = String(profile.city || '').trim().slice(0, 50);
      const district = String(profile.district || '').trim().slice(0, 50);
      const addressText = String(profile.address || order.buyer?.address || '').trim().slice(0, 400);
      const zipCode = String(profile.zip_code || '').trim().slice(0, 20);
      if (profile.billing_profile_completed !== true || !/^\+90\d{10}$/.test(phone) || !/^\d{10,11}$/.test(identity) || !city || !district || addressText.length < 5 || !zipCode) {
        return res.status(400).json({ error: 'Kartla ödeme için Hesabım bölümündeki fatura bilgilerinizi tamamlayın.' });
      }

      const attemptId = randomUUID();
      const contactName = (buyerName + ' ' + buyerSurname).trim();
      const address = { contactName, city, country: 'Turkey', address: addressText, zipCode };
      const request = {
        locale: Iyzipay.LOCALE.TR,
        conversationId: attemptId,
        price: money(totalMinor),
        paidPrice: money(totalMinor),
        currency: Iyzipay.CURRENCY.TRY,
        basketId: attemptId,
        paymentGroup: Iyzipay.PAYMENT_GROUP.PRODUCT,
        callbackUrl: process.env.IYZIPAY_CALLBACK_URL.trim(),
        enabledInstallments: [1],
        buyer: {
          id: req.user.uid.slice(0, 64), name: buyerName, surname: buyerSurname,
          gsmNumber: phone, email: req.user.email, identityNumber: identity,
          registrationAddress: addressText,
          ip: String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 45),
          city, country: 'Turkey', zipCode,
        },
        billingAddress: { ...address, district },
        shippingAddress: { ...address, district },
        basketItems: items.map((item, index) => ({
          id: String(item.product_id || ('product-' + index)).slice(0, 64),
          name: String(item.name || 'Ürün').slice(0, 100),
          category1: 'Mağaza Ürünü',
          category2: 'Fiziksel Ürün',
          itemType: Iyzipay.BASKET_ITEM_TYPE.PHYSICAL,
          price: money(Number(item.line_total_minor)),
        })),
      };

      const result = await call(client.checkoutFormInitialize, 'create', request);
      if (result.status !== 'success' || !result.token || !result.paymentPageUrl) {
        console.error('iyzico catalog checkout initialize failed:', result.errorCode || result.errorMessage || result.status);
        return res.status(502).json({ error: 'iyzico ödeme sayfası oluşturulamadı. Lütfen daha sonra tekrar deneyin.' });
      }

      const attemptRef = req.db.collection('payment_attempts').doc(hash(result.token));
      await req.db.runTransaction(async transaction => {
        const currentSnap = await transaction.get(orderRef);
        if (!currentSnap.exists || currentSnap.data().uid !== req.user.uid) throw new Error('Sipariş artık bulunamıyor.');
        const current = currentSnap.data();
        if (current.payment_status === 'paid') throw new Error('Bu siparişin ödemesi zaten tamamlanmış.');
        if (current.payment_status === 'pending') throw new Error('Bu sipariş için bir ödeme işlemi zaten başlatılmış.');
        if (current.status !== 'new' || Number(current.total_minor) !== totalMinor) throw new Error('Sipariş ödeme için uygun durumda değil.');
        transaction.create(attemptRef, {
          type: 'catalog_order', uid: req.user.uid, email: req.user.email,
          order_id: orderId, order_number: order.order_number,
          provider: 'iyzico', gross_amount_minor: totalMinor, currency: 'TRY',
          checkout_token_hash: hash(result.token), provider_conversation_id: attemptId,
          status: 'pending', created_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp(),
        });
        transaction.update(orderRef, {
          payment_status: 'pending', payment_method: 'iyzico',
          payment_attempt_id: hash(result.token), payment_attempt_started_at: FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp(),
        });
      });
      res.json({
        provider: 'iyzico', paymentPageUrl: result.paymentPageUrl,
        order: { order_number: order.order_number, total: money(totalMinor), currency: 'TRY' },
      });
    } catch (error) {
      const message = error.message || 'Ödeme başlatılamadı.';
      const known = /Sipariş artık bulunamıyor|zaten tamamlanmış|uygun durumda değil/.test(message);
      res.status(known ? 409 : 502).json({ error: message });
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
        const url = attempt.type === 'catalog_order'
          ? orderReturnUrl('success', attempt.order_number)
          : returnUrl('success', attempt.plan_id);
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
        if (attempt.type === 'catalog_order' && attempt.order_id) {
          const orderRef = firebase.db.collection('catalog_orders').doc(attempt.order_id);
          await firebase.db.runTransaction(async transaction => {
            const orderSnap = await transaction.get(orderRef);
            if (orderSnap.exists && orderSnap.data().payment_attempt_id === hash(token) && orderSnap.data().payment_status !== 'paid') {
              transaction.update(orderRef, { payment_status: 'failed', updated_at: FieldValue.serverTimestamp() });
            }
          });
          const url = orderReturnUrl('failed', attempt.order_number);
          return url ? res.redirect(303, url) : res.status(200).send('Mağaza siparişi ödemesi tamamlanmadı.');
        }
        const url = returnUrl('failed', attempt.plan_id);
        return url ? res.redirect(303, url) : res.status(200).send('Ödeme tamamlanmadı.');
      }

      if (attempt.type === 'catalog_order') {
        const orderRef = firebase.db.collection('catalog_orders').doc(attempt.order_id);
        const paymentRef = firebase.db.collection('payments').doc(String(result.paymentId));
        await firebase.db.runTransaction(async transaction => {
          const orderSnap = await transaction.get(orderRef);
          if (!orderSnap.exists) throw new Error('Ödeme yapılan sipariş bulunamadı.');
          const order = orderSnap.data();
          if (order.uid !== attempt.uid || Number(order.total_minor) !== attempt.gross_amount_minor || order.currency !== 'TRY') {
            throw new Error('Ödeme siparişiyle tutarı eşleşmedi.');
          }
          if (order.payment_attempt_id !== hash(token)) throw new Error('Bu ödeme denemesi artık geçerli değil.');
          if (order.status !== 'new' || order.stock_reserved !== true) throw new Error('Sipariş ödeme için artık uygun durumda değil.');
          if (order.payment_status === 'paid') {
            transaction.set(attemptRef, {
              status: 'paid', provider_payment_id: String(result.paymentId),
              provider_status: result.paymentStatus, paid_at: FieldValue.serverTimestamp(),
              updated_at: FieldValue.serverTimestamp(),
            }, { merge: true });
            return;
          }
          transaction.set(paymentRef, {
            customer_id: attempt.uid, user_id: attempt.uid, order_id: attempt.order_id,
            provider: 'iyzico', provider_reference: String(result.paymentId),
            provider_conversation_id: attempt.provider_conversation_id,
            status: 'paid', amount: attempt.gross_amount_minor / 100, currency: 'TRY',
            created_at: FieldValue.serverTimestamp(),
          });
          transaction.update(orderRef, {
            payment_status: 'paid', payment_method: 'iyzico',
            payment_provider_reference: String(result.paymentId),
            status: 'confirmed', paid_at: FieldValue.serverTimestamp(),
            updated_at: FieldValue.serverTimestamp(),
          });
          transaction.set(attemptRef, {
            status: 'paid', provider_payment_id: String(result.paymentId),
            provider_status: result.paymentStatus, paid_at: FieldValue.serverTimestamp(),
            updated_at: FieldValue.serverTimestamp(),
          }, { merge: true });
        });
        const url = orderReturnUrl('success', attempt.order_number);
        return url ? res.redirect(303, url) : res.status(200).send('Mağaza siparişi ödemesi doğrulandı.');
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
