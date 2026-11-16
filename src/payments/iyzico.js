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
  'eticaret-baslangic': { name: 'E-Ticaret Başlangıç', annualNet: 1788000 },
  'eticaret-buyume': { name: 'E-Ticaret Büyüme', annualNet: 3588000 },
  'eticaret-profesyonel': { name: 'E-Ticaret Profesyonel', annualNet: 7188000 },
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

function returnUrl(status, planId, orderId) {
  const base = process.env.IYZIPAY_RETURN_URL?.trim();
  if (!base) return null;
  try {
    const url = new URL(base);
    url.searchParams.set('payment', status);
    if (planId) url.searchParams.set('plan', planId);
    if (orderId) url.searchParams.set('order', orderId);
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

  // Store checkout: prices and stock are always read from Firestore, never trusted from the browser.
  app.post('/api/v1/orders', requireVerifiedUser, async (req, res) => {
    try {
      const buyer = req.body?.buyer || {};
      const name = String(buyer.name || '').trim().slice(0, 120);
      const phone = String(buyer.phone || '').trim().slice(0, 30);
      const address = String(buyer.address || '').trim().slice(0, 600);
      const city = String(buyer.city || '').trim().slice(0, 60);
      const district = String(buyer.district || '').trim().slice(0, 60);
      const identityNumber = String(buyer.identityNumber || '').trim();
      const zipCode = String(buyer.zipCode || '').trim().slice(0, 20);
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (name.length < 3 || address.length < 8 || city.length < 2 || district.length < 2) {
        return res.status(400).json({ error: 'Ad soyad, il, ilçe ve teslimat adresi zorunludur.' });
      }
      if (!/^\d{10,11}$/.test(identityNumber)) return res.status(400).json({ error: 'T.C. kimlik veya vergi numarası 10 ya da 11 rakam olmalıdır.' });
      const normalizedPhone = phone.replace(/[\s()-]/g, '');
      const iyziPhone = normalizedPhone.startsWith('+90') ? normalizedPhone : '+90' + normalizedPhone.replace(/^0/, '');
      if (!/^\\+90\d{10}$/.test(iyziPhone)) return res.status(400).json({ error: 'Telefonu 05XXXXXXXXX biçiminde girin.' });
      if (!items.length || items.length > 100) return res.status(400).json({ error: 'Sepetinizde geçerli ürün bulunamadı.' });
      const unique = new Map();
      for (const item of items) {
        const id = String(item?.product_id || '').trim();
        const quantity = Number(item?.quantity);
        if (!id || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) return res.status(400).json({ error: 'Sepet ürün veya adet bilgisi geçersiz.' });
        unique.set(id, (unique.get(id) || 0) + quantity);
      }
      if ([...unique.values()].some(q => q > 10)) return res.status(400).json({ error: 'Bir üründen en fazla 10 adet sipariş verebilirsiniz.' });
      const db = req.db;
      const snapshots = await Promise.all([...unique.keys()].map(id => db.collection('catalog_products').doc(id).get()));
      const orderItems = [];
      let totalMinor = 0;
      for (let i = 0; i < snapshots.length; i++) {
        const snap = snapshots[i], quantity = unique.get([...unique.keys()][i]);
        if (!snap.exists) return res.status(409).json({ error: 'Sepetinizde artık bulunmayan bir ürün var. Sayfayı yenileyin.' });
        const product = snap.data();
        const priceMinor = Math.round(Number(product.sale_price) * 100);
        if (product.status !== 'active' || !Number.isFinite(priceMinor) || priceMinor < 1) return res.status(409).json({ error: 'Sepetinizde satışa kapalı veya fiyatı geçersiz bir ürün var.' });
        if (Number(product.stock || 0) < quantity) return res.status(409).json({ error: (product.name || 'Ürün') + ' için yeterli stok bulunmuyor.' });
        orderItems.push({ product_id: snap.id, name: String(product.name || '').slice(0, 200), sku: String(product.sku || '').slice(0, 80), quantity, unit_price_minor: priceMinor, line_total_minor: priceMinor * quantity });
        totalMinor += priceMinor * quantity;
      }
      if (totalMinor < 1 || totalMinor > 500000000) return res.status(400).json({ error: 'Sipariş toplamı geçersiz.' });
      const now = new Date().toISOString();
      const orderRef = db.collection('orders').doc();
      const orderNumber = 'TE-' + Date.now().toString(36).toUpperCase();
      const email = String(buyer.email || req.user.email).trim().slice(0, 160);
      await orderRef.create({
        order_number: orderNumber,
        user_id: req.user.uid, email, provider: 'iyzico', status: 'pending_payment',
        payment_status: 'pending', currency: 'TRY', total_minor: totalMinor, total: totalMinor / 100,
        buyer: { name, phone: iyziPhone, email, address, city, district, identity_number: identityNumber, zip_code: zipCode },
        items: orderItems, created_at: now, updated_at: now,
      });
      res.status(201).json({ order: { id: orderRef.id, order_number: orderNumber, total: totalMinor / 100, currency: 'TRY' } });
    } catch (error) {
      console.error('Store order creation failed:', error?.message || 'Unknown error');
      res.status(500).json({ error: 'Sipariş oluşturulamadı. Lütfen tekrar deneyin.' });
    }
  });

  app.post('/api/v1/payments/iyzico/orders/:orderId/initialize', requireVerifiedUser, async (req, res) => {
    const client = iyzicoClient();
    if (!client) return res.status(503).json({ error: 'iyzico ödeme ayarları hazır değil.' });
    if (!process.env.IYZIPAY_CALLBACK_URL?.trim()) return res.status(503).json({ error: 'Ödeme geri dönüş adresi ayarlı değil.' });
    try {
      const orderRef = req.db.collection('orders').doc(String(req.params.orderId));
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
      const order = orderSnap.data();
      if (order.user_id !== req.user.uid) return res.status(403).json({ error: 'Bu sipariş size ait değil.' });
      if (order.status !== 'pending_payment' || order.payment_status !== 'pending') return res.status(409).json({ error: 'Bu sipariş için ödeme başlatılamaz.' });
      const totalMinor = Number(order.total_minor);
      if (!Number.isSafeInteger(totalMinor) || totalMinor < 1) return res.status(400).json({ error: 'Sipariş tutarı geçersiz.' });
      const attemptId = randomUUID();
      const buyer = order.buyer;
      const nameParts = String(buyer.name).trim().split(/\s+/);
      const surname = nameParts.length > 1 ? nameParts.pop() : 'Musteri';
      const name = nameParts.join(' ') || surname;
      const address = { contactName: buyer.name, city: buyer.city, country: 'Turkey', address: buyer.address, zipCode: buyer.zip_code || '00000' };
      const basketItems = order.items.map(item => ({
        id: String(item.product_id).slice(0, 64), name: String(item.name).slice(0, 100),
        category1: 'Katalog Ürünü', category2: 'Fiziksel Ürün',
        itemType: Iyzipay.BASKET_ITEM_TYPE.PHYSICAL,
        price: money(item.line_total_minor),
      }));
      const request = {
        locale: Iyzipay.LOCALE.TR, conversationId: attemptId,
        price: money(totalMinor), paidPrice: money(totalMinor),
        currency: Iyzipay.CURRENCY.TRY, basketId: attemptId,
        paymentGroup: Iyzipay.PAYMENT_GROUP.PRODUCT,
        callbackUrl: process.env.IYZIPAY_CALLBACK_URL.trim(), enabledInstallments: [1],
        buyer: {
          id: req.user.uid.slice(0, 64), name: name.slice(0, 50), surname: surname.slice(0, 50),
          gsmNumber: buyer.phone, email: order.email, identityNumber: buyer.identity_number,
          registrationAddress: buyer.address, ip: String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 45),
          city: buyer.city, country: 'Turkey', zipCode: buyer.zip_code || '00000',
        },
        billingAddress: { ...address, district: buyer.district },
        shippingAddress: { ...address, district: buyer.district },
        basketItems,
      };
      const result = await call(client.checkoutFormInitialize, 'create', request);
      if (result.status !== 'success' || !result.token || !result.paymentPageUrl) {
        console.error('iyzico store checkout initialize failed:', result.errorCode || result.errorMessage || result.status);
        return res.status(502).json({ error: 'iyzico güvenli ödeme sayfası oluşturulamadı.' });
      }
      await req.db.collection('payment_attempts').doc(hash(result.token)).create({
        uid: req.user.uid, email: req.user.email, provider: 'iyzico', type: 'store_order',
        order_id: orderRef.id, order_number: order.order_number,
        net_amount_minor: totalMinor, vat_amount_minor: 0, gross_amount_minor: totalMinor,
        amount: totalMinor / 100, currency: 'TRY', checkout_token_hash: hash(result.token),
        provider_conversation_id: attemptId, status: 'pending',
        created_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp(),
      });
      res.json({ provider: 'iyzico', paymentPageUrl: result.paymentPageUrl, totals: { total: money(totalMinor), currency: 'TRY' } });
    } catch (error) {
      console.error('iyzico store checkout error:', error?.message || 'Unknown error');
      res.status(502).json({ error: 'Ödeme başlatılamadı. Lütfen tekrar deneyin.' });
    }
  });

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
        const url = returnUrl('success', attempt.plan_id, attempt.order_id);
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
        const url = returnUrl('failed', attempt.plan_id, attempt.order_id);
        return url ? res.redirect(303, url) : res.status(200).send('Ödeme tamamlanmadı.');
      }

      if (attempt.type === 'store_order') {
        const orderRef = firebase.db.collection('orders').doc(String(attempt.order_id || ''));
        const orderSnap = await orderRef.get();
        if (!orderSnap.exists || orderSnap.data().user_id !== attempt.uid) return res.status(404).send('Sipariş kaydı bulunamadı.');
        if (orderSnap.data().payment_status === 'paid') {
          const url = returnUrl('success', null, attempt.order_id);
          return url ? res.redirect(303, url) : res.status(200).send('Sipariş ödemesi zaten doğrulandı.');
        }
        if (Number(orderSnap.data().total_minor) !== attempt.gross_amount_minor) return res.status(409).send('Ödeme tutarı siparişle eşleşmedi.');
        const paymentRef = firebase.db.collection('payments').doc(String(result.paymentId));
        await firebase.db.runTransaction(async transaction => {
          const freshOrder = await transaction.get(orderRef);
          if (!freshOrder.exists || freshOrder.data().payment_status === 'paid') return;
          const order = freshOrder.data();
          if (order.status !== 'pending_payment' || order.user_id !== attempt.uid || Number(order.total_minor) !== paidMinor) throw new Error('Sipariş ödeme doğrulaması başarısız.');
          const productRefs = order.items.map(item => firebase.db.collection('catalog_products').doc(String(item.product_id)));
          const productSnaps = [];
          for (const ref of productRefs) productSnaps.push(await transaction.get(ref));
          for (let i = 0; i < productSnaps.length; i++) {
            const snap = productSnaps[i], item = order.items[i];
            if (!snap.exists || snap.data().status !== 'active' || Number(snap.data().stock || 0) < Number(item.quantity)) throw new Error('Ödeme alındı ancak stok doğrulaması başarısız; yönetici incelemesi gerekli.');
          }
          productSnaps.forEach((snap, i) => transaction.update(productRefs[i], {
            stock: Number(snap.data().stock || 0) - Number(order.items[i].quantity),
            updated_at: new Date().toISOString(),
          }));
          transaction.set(paymentRef, {
            customer_id: attempt.uid, user_id: attempt.uid, provider: 'iyzico',
            provider_reference: String(result.paymentId), provider_conversation_id: attempt.provider_conversation_id,
            status: 'paid', payment_type: 'store_order', order_id: attempt.order_id,
            amount: attempt.gross_amount_minor / 100, currency: 'TRY',
            created_at: FieldValue.serverTimestamp(), paid_at: FieldValue.serverTimestamp(),
          });
          transaction.update(orderRef, {
            status: 'paid', payment_status: 'paid', provider_payment_id: String(result.paymentId),
            paid_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp(),
          });
          transaction.set(attemptRef, {
            status: 'paid', provider_payment_id: String(result.paymentId),
            provider_status: result.paymentStatus, paid_at: FieldValue.serverTimestamp(),
            updated_at: FieldValue.serverTimestamp(),
          }, { merge: true });
        });
        const url = returnUrl('success', null, attempt.order_id);
        return url ? res.redirect(303, url) : res.status(200).send('Sipariş ödemesi doğrulandı.');
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

  // Admin-only recovery for a captured test payment whose browser callback was missed.
  app.post('/api/v1/payments/iyzico/reconcile-test', async (req, res) => {
    try {
      const authHeader = req.headers.authorization || '';
      const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
      const firebase = firebaseServices();
      if (!firebase || !bearer) return res.status(401).json({ error: 'Yönetici oturumu doğrulanamadı.' });
      const decoded = await firebase.auth.verifyIdToken(bearer);
      const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);
      if (!decoded.email || !adminEmails.includes(decoded.email.toLowerCase())) return res.status(403).json({ error: 'Bu işlem yalnızca yöneticiler içindir.' });

      const paymentId = String(req.body?.paymentId || '').trim();
      const conversationId = String(req.body?.conversationId || '').trim();
      if (!/^\d{6,20}$/.test(paymentId) || !conversationId || conversationId.length > 80) {
        return res.status(400).json({ error: 'Geçerli ödeme ve konuşma numarası gerekli.' });
      }

      const matches = await firebase.db.collection('payment_attempts')
        .where('provider_conversation_id', '==', conversationId).limit(2).get();
      if (matches.size !== 1) return res.status(404).json({ error: 'Ödeme denemesi bulunamadı veya tekil değil.' });
      const attemptDoc = matches.docs[0];
      const attempt = attemptDoc.data();
      if (attempt.provider !== 'iyzico' || attempt.is_test_payment !== true) {
        return res.status(403).json({ error: 'Bu kurtarma işlemi yalnızca test ödemeleri içindir.' });
      }
      if (attempt.status === 'paid' && attempt.provider_payment_id === paymentId) {
        const existingPaymentRef = firebase.db.collection('payments').doc(paymentId);
        await existingPaymentRef.set({
          paid_at: FieldValue.serverTimestamp(),
          payment_date: FieldValue.serverTimestamp(),
        }, { merge: true });
        return res.json({ ok: true, alreadyProcessed: true, status: 'paid', dateUpdated: true });
      }

      const client = iyzicoClient();
      if (!client) return res.status(503).json({ error: 'iyzico bağlantısı hazır değil.' });
      const result = await call(client.payment, 'retrieve', {
        locale: Iyzipay.LOCALE.TR,
        conversationId: randomUUID(),
        paymentId,
        paymentConversationId: conversationId,
      });
      const paidMinor = Math.round(Number(result.paidPrice) * 100);
      const confirmed = result.status === 'success'
        && result.paymentStatus === 'SUCCESS'
        && Number(result.fraudStatus) === 1
        && String(result.paymentId) === paymentId
        && result.currency === 'TRY'
        && paidMinor === attempt.gross_amount_minor
        && result.basketId === conversationId;
      if (!confirmed) {
        console.error('iyzico test payment reconciliation mismatch:', {
          status: result.status, paymentStatus: result.paymentStatus,
          fraudStatus: result.fraudStatus, paymentId: result.paymentId,
          currency: result.currency, basketId: result.basketId,
        });
        return res.status(409).json({ error: 'iyzico ödeme bilgileri kayıtla eşleşmedi; hiçbir kayıt değiştirilmedi.' });
      }

      const paymentRef = firebase.db.collection('payments').doc(paymentId);
      await firebase.db.runTransaction(async (transaction) => {
        const existingPayment = await transaction.get(paymentRef);
        if (existingPayment.exists) {
          const existing = existingPayment.data();
          if (String(existing.provider_reference) !== paymentId || existing.user_id !== attempt.uid) {
            throw new Error('Payment ID başka bir kullanıcı kaydıyla eşleşiyor.');
          }
          transaction.set(paymentRef, {
            paid_at: existing.paid_at || FieldValue.serverTimestamp(),
            payment_date: existing.payment_date || FieldValue.serverTimestamp(),
            created_at: existing.created_at || FieldValue.serverTimestamp(),
          }, { merge: true });
        } else {
          transaction.create(paymentRef, {
            customer_id: attempt.uid, user_id: attempt.uid, provider: 'iyzico',
            provider_reference: paymentId, provider_conversation_id: conversationId,
            status: 'paid', plan_id: attempt.plan_id, package_name: attempt.plan_name,
            payment_type: 'test_product', net_amount: attempt.net_amount_minor / 100,
            vat_amount: attempt.vat_amount_minor / 100, amount: attempt.gross_amount_minor / 100,
            currency: 'TRY', created_at: FieldValue.serverTimestamp(),
            paid_at: FieldValue.serverTimestamp(), payment_date: FieldValue.serverTimestamp(),
          });
        }
        transaction.set(attemptDoc.ref, {
          status: 'paid', provider_payment_id: paymentId,
          provider_status: result.paymentStatus, paid_at: FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      return res.json({ ok: true, status: 'paid', paymentId, amount: attempt.gross_amount_minor / 100, testPayment: true });
    } catch (error) {
      console.error('iyzico test payment reconciliation failed:', error?.message || 'Unknown error');
      return res.status(500).json({ error: 'Ödeme kurtarma işlemi tamamlanamadı.' });
    }
  });
}
