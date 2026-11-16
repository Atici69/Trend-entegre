import { downloadXml, parseProducts } from '../xml/feed-service.js';

const API_BASE = 'https://apigw.trendyol.com';
const text = value => String(value ?? '').trim();
const normalize = value => text(value).toLocaleLowerCase('tr-TR')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const numeric = value => {
  const raw = text(value).replace(/[^0-9,.-]/g, '');
  if (!raw) return null;
  const comma = raw.lastIndexOf(','), dot = raw.lastIndexOf('.');
  const normalized = comma >= 0 && dot >= 0
    ? (comma > dot ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, ''))
    : comma >= 0 ? raw.replace(',', '.')
    : dot >= 0 && /^-?\d{1,3}(\.\d{3})+$/.test(raw) ? raw.replace(/\./g, '') : raw;
  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
};
const asArray = value => Array.isArray(value) ? value : value ? [value] : [];

function config() {
  const supplierId = text(process.env.TRENDYOL_SUPPLIER_ID);
  const apiKey = text(process.env.TRENDYOL_API_KEY);
  const apiSecret = text(process.env.TRENDYOL_API_SECRET);
  if (!supplierId || !apiKey || !apiSecret) {
    throw new Error('Trendyol bağlantısı yapılandırılmamış. Sunucu ortamında TRENDYOL_SUPPLIER_ID, TRENDYOL_API_KEY ve TRENDYOL_API_SECRET tanımlanmalıdır.');
  }
  return {
    supplierId, base: text(process.env.TRENDYOL_API_BASE_URL) || API_BASE,
    authorization: 'Basic ' + Buffer.from(apiKey + ':' + apiSecret).toString('base64'),
    userAgent: text(process.env.TRENDYOL_USER_AGENT) || supplierId + ' - SelfIntegration',
  };
}

async function trendyolRequest(path, options = {}) {
  const cfg = config();
  const response = await fetch(cfg.base + path, {
    method: options.method || 'GET',
    headers: {
      Authorization: cfg.authorization,
      'User-Agent': cfg.userAgent,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(25000),
  });
  const bodyText = await response.text();
  let data = {};
  try { data = bodyText ? JSON.parse(bodyText) : {}; } catch { data = { message: bodyText.slice(0, 500) }; }
  if (!response.ok) {
    const message = data?.message || data?.error || data?.errors?.[0]?.message ||
      'Trendyol API HTTP ' + response.status + ' yanıtı verdi.';
    throw new Error(String(message).slice(0, 500));
  }
  return data;
}

async function getFeed(db, feedId) {
  const id = text(feedId);
  if (!id || id.length > 160) throw new Error('Geçerli bir XML kaynağı seçin.');
  const snap = await db.collection('xml_feeds').doc(id).get();
  if (!snap.exists) throw new Error('Kayıtlı XML kaynağı bulunamadı.');
  const feed = snap.data();
  const products = parseProducts(await downloadXml(feed.url));
  return { id, feed, products };
}

function categoryList(data) {
  return asArray(data?.categories || data?.content || data).filter(item => item && typeof item === 'object');
}
function flattenCategories(data) {
  const result = [];
  const visit = (items, parent = '') => {
    for (const item of asArray(items)) {
      if (!item || typeof item !== 'object') continue;
      const name = item.name || item.displayName || '';
      const path = parent ? parent + ' / ' + name : name;
      const children = item.subCategories || item.subcategories || item.children || [];
      if (children.length) visit(children, path);
      else if (item.id) result.push({ id: item.id, name, path });
    }
  };
  visit(data?.categories || data);
  return result;
}
function titleColor(product) {
  const title = normalize(product['Ürün Adı']);
  const colors = [
    ['rose gold', 'Rose Gold'], ['rosegold', 'Rose Gold'], ['gümüş', 'Gümüş'],
    ['gumus', 'Gümüş'], ['altın', 'Altın'], ['altin', 'Altın'], ['gold', 'Altın'],
    ['kırmızı', 'Kırmızı'], ['kirmizi', 'Kırmızı'], ['mavi', 'Mavi'],
    ['siyah', 'Siyah'], ['beyaz', 'Beyaz'], ['pembe', 'Pembe'],
    ['yeşil', 'Yeşil'], ['yesil', 'Yeşil'], ['mor', 'Mor'], ['sarı', 'Sarı'],
    ['sari', 'Sarı'], ['lacivert', 'Lacivert'], ['turkuaz', 'Turkuaz'],
    ['kahverengi', 'Kahverengi'],
  ];
  const found = colors.find(([key]) => (' ' + title + ' ').includes(' ' + normalize(key) + ' '));
  return found?.[1] || '';
}
function titleSize(product) {
  const title = text(product['Ürün Adı']).toLocaleUpperCase('tr-TR');
  const match = title.match(/(?:^|[^A-Z])(XXXL|XXL|XXS|XL|XS|S|M|L)(?:$|[^A-Z])/);
  if (match) return match[1];
  if (/TEK EBAT|STANDART BEDEN|STANDART EBAT/i.test(title)) return 'Tek Ebat';
  return '';
}
function sourceValue(product, attributeName) {
  const name = normalize(attributeName);
  if (/web color|web rengi/.test(name)) return text(product['Web Color'] || product['Renk'] || titleColor(product));
  if (/renk|color/.test(name)) return text(product['Renk'] || product['Web Color'] || titleColor(product));
  if (/beden|size|olcu/.test(name)) return text(product['Beden'] || titleSize(product));
  if (/marka|brand/.test(name)) return text(product['Marka']);
  if (/materyal|malzeme|material/.test(name)) return text(product['Materyal']);
  if (/cinsiyet|gender/.test(name)) return text(product['Cinsiyet']);
  return '';
}
function parseAttributeValues(data) {
  return asArray(data?.content || data?.attributeValues || data?.values || data).map(item => ({
    id: item.attributeValueId ?? item.id,
    value: item.attributeValue ?? item.name ?? item.value ?? '',
  })).filter(item => item.id !== undefined && text(item.value));
}
async function attributeValueList(categoryId, attributeId) {
  const data = await trendyolRequest('/integration/product/categories/' +
    encodeURIComponent(categoryId) + '/attributes/' + encodeURIComponent(attributeId) + '/values?size=1000&page=0');
  return parseAttributeValues(data);
}
async function makeAttributes(product, categoryId, mapping, cache) {
  if (!cache.categories.has(categoryId)) {
    cache.categories.set(categoryId, trendyolRequest('/integration/product/product-categories/' +
      encodeURIComponent(categoryId) + '/attributes').then(data =>
        asArray(data?.categoryAttributes || data?.attributes)));
  }
  const definitions = await cache.categories.get(categoryId);
  const required = definitions.filter(item => item.required);
  const configured = asArray(mapping.attributes);
  const result = [];
  const errors = [];
  for (const definition of definitions) {
    const attribute = definition.attribute || definition;
    const attributeId = String(attribute.id ?? definition.attributeId ?? '');
    if (!attributeId) continue;
    const saved = configured.find(item => String(item.attributeId) === attributeId);
    let raw = saved?.customAttributeValue || saved?.attributeValue || '';
    if (!raw) raw = sourceValue(product, attribute.name || '');
    if (!raw) {
      if (definition.required) errors.push('Zorunlu özellik eksik: ' + (attribute.name || attributeId));
      continue;
    }
    if (saved?.attributeValueId) {
      result.push({ attributeId: Number(attributeId), attributeValueId: Number(saved.attributeValueId) });
      continue;
    }
    if (definition.allowCustom === true || definition.allowCustomValue === true) {
      result.push({ attributeId: Number(attributeId), customAttributeValue: raw.slice(0, 50) });
      continue;
    }
    const cacheKey = categoryId + ':' + attributeId;
    if (!cache.values.has(cacheKey)) {
      cache.values.set(cacheKey, attributeValueList(categoryId, attributeId).catch(() => []));
    }
    const values = await cache.values.get(cacheKey);
    const wanted = normalize(raw);
    const matched = values.find(item => normalize(item.value) === wanted);
    if (matched) result.push({ attributeId: Number(attributeId), attributeValueId: Number(matched.id) });
    else if (definition.required) errors.push((attribute.name || 'Özellik') + ': "' + raw + '" Trendyol değer listesinde eşleşmedi.');
  }
  for (const definition of required) {
    const id = String((definition.attribute || definition).id ?? definition.attributeId ?? '');
    if (id && !result.some(item => String(item.attributeId) === id) &&
        !errors.some(error => error.includes((definition.attribute || definition).name || id))) {
      errors.push('Zorunlu özellik eşleştirilmedi: ' + ((definition.attribute || definition).name || id));
    }
  }
  return { result, errors, definitions };
}
function productBaseErrors(product, mapping, marginPercent = 0) {
  const errors = [];
  const barcode = text(product['Barkod']);
  const title = text(product['Ürün Adı']);
  const stock = numeric(product['Stok']);
  const basePrice = numeric(product['Satış Fiyatı'] || product['Fiyat']);
  const price = basePrice === null ? null : Math.round((basePrice * (1 + marginPercent / 100) + Number.EPSILON) * 100) / 100;
  const image = text(product['Görsel URL']);
  const vat = numeric(product['KDV'] || process.env.TRENDYOL_DEFAULT_VAT_RATE);
  if (!barcode) errors.push('Barkod eksik.');
  else if (barcode.length > 40) errors.push('Barkod 40 karakteri aşıyor.');
  if (!title) errors.push('Ürün adı eksik.');
  if (!mapping?.categoryId) errors.push('Trendyol alt kategori eşleştirmesi eksik.');
  if (!mapping?.brandId) errors.push('Trendyol marka eşleştirmesi eksik.');
  if (stock === null || stock < 0) errors.push('Stok bilgisi eksik veya geçersiz.');
  if (price === null || price <= 0) errors.push('Satış fiyatı eksik veya geçersiz.');
  if (!text(product['Açıklama'])) errors.push('Ürün açıklaması eksik.');
  if (!/^https:\/\//i.test(image)) errors.push('HTTPS ürün görseli eksik.');
  if (vat === null || ![0, 1, 10, 20].includes(vat)) errors.push('Geçerli KDV oranı eksik (ürün XML alanı veya TRENDYOL_DEFAULT_VAT_RATE).');
  return errors;
}

async function buildValidation(db, feedId) {
  const { id, feed, products } = await getFeed(db, feedId);
  const mappingSnap = await db.collection('trendyol_feed_mappings').doc(id).get();
  const mappings = mappingSnap.exists ? asArray(mappingSnap.data().mappings) : [];
  const byCategory = new Map(mappings.map(item => [normalize(item.sourceCategory), item]));
  const rows = [];
  const payloads = [];
  const cache = { categories: new Map(), values: new Map() };
  for (const product of products) {
    const sourceCategory = text(product['Kategori']);
    const mapping = byCategory.get(normalize(sourceCategory));
    const marginPercent = Number(feed.margin_percent || 0);
    const errors = productBaseErrors(product, mapping, marginPercent);
    let attributes = [];
    if (mapping?.categoryId) {
      try {
        const mapped = await makeAttributes(product, mapping.categoryId, mapping, cache);
        attributes = mapped.result;
        errors.push(...mapped.errors);
      } catch (error) { errors.push('Kategori özellikleri alınamadı: ' + error.message); }
    }
    const ready = errors.length === 0;
    rows.push({
      title: text(product['Ürün Adı']), sku: text(product.SKU), barcode: text(product['Barkod']),
      ready, errors, warnings: [],
    });
    if (ready) {
      const basePrice = numeric(product['Satış Fiyatı'] || product['Fiyat']);
      const price = Math.round((basePrice * (1 + Number(feed.margin_percent || 0) / 100) + Number.EPSILON) * 100) / 100;
      const stock = numeric(product['Stok']);
      const vatRate = numeric(product['KDV'] || process.env.TRENDYOL_DEFAULT_VAT_RATE);
      const image = text(product['Görsel URL']);
      payloads.push({
        barcode: text(product['Barkod']).slice(0, 40),
        title: text(product['Ürün Adı']).slice(0, 100),
        productMainId: (text(product.SKU) || text(product['Ürün ID']) || text(product['Barkod'])).slice(0, 40),
        brandId: Number(mapping.brandId),
        categoryId: Number(mapping.categoryId),
        quantity: Math.floor(stock),
        stockCode: text(product.SKU).slice(0, 100),
        description: text(product['Açıklama']).slice(0, 30000),
        currencyType: 'TRY',
        listPrice: price,
        salePrice: price,
        vatRate,
        images: [{ url: image }],
        attributes,
      });
    }
  }
  const blocked = rows.filter(row => !row.ready).length;
  return {
    total: rows.length, ready: rows.length - blocked, blocked, warnings: 0,
    rows, payloads, feedName: text(feed.name),
    note: blocked ? 'Eksik alanlar tamamlanmadan gönderim yapılamaz.' : 'Tüm zorunlu alanlar kontrol edildi. Gönderim için onay bekleniyor.',
  };
}
export function registerTrendyolRoutes(app, requireAdmin) {
  app.get('/api/v1/marketplaces/trendyol/brands', requireAdmin, async (req, res) => {
    try {
      const name = text(req.query.name);
      const data = await trendyolRequest('/integration/product/brands?name=' + encodeURIComponent(name) + '&size=20&page=0');
      res.json({ brands: asArray(data?.brands || data?.content || data).map(item => ({ id: item.id ?? item.brandId, name: item.name ?? item.brandName })).filter(item => item.id !== undefined) });
    } catch (error) { res.status(502).json({ error: error.message }); }
  });
  app.get('/api/v1/marketplaces/trendyol/categories', requireAdmin, async (req, res) => {
    try {
      const data = await trendyolRequest('/integration/product/product-categories');
      const query = normalize(req.query.name);
      const categories = flattenCategories(data);
      const filtered = query ? categories.filter(item => normalize(item.path).includes(query) || normalize(item.name).includes(query)) : categories;
      res.json({ categories: filtered.slice(0, 100) });
    } catch (error) { res.status(502).json({ error: error.message }); }
  });
  app.get('/api/v1/marketplaces/trendyol/categories/:id/attributes', requireAdmin, async (req, res) => {
    try {
      const data = await trendyolRequest('/integration/product/product-categories/' + encodeURIComponent(req.params.id) + '/attributes');
      res.json(data);
    } catch (error) { res.status(502).json({ error: error.message }); }
  });
  app.get('/api/v1/marketplaces/trendyol/feed-mappings', requireAdmin, async (req, res) => {
    try {
      const { id, products } = await getFeed(req.firestore, req.query.feed_id);
      const snap = await req.firestore.collection('trendyol_feed_mappings').doc(id).get();
      const saved = snap.exists ? asArray(snap.data().mappings) : [];
      const savedByCategory = new Map(saved.map(item => [normalize(item.sourceCategory), item]));
      const categories = [...new Set(products.map(item => text(item['Kategori'])).filter(Boolean))].map(sourceCategory => ({
        sourceCategory, mapping: savedByCategory.get(normalize(sourceCategory)) || null,
      }));
      res.json({ categories });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post('/api/v1/marketplaces/trendyol/feed-mappings', requireAdmin, async (req, res) => {
    try {
      const feedId = text(req.body?.feed_id);
      if (!feedId) return res.status(400).json({ error: 'XML kaynağı seçilmelidir.' });
      const mappings = asArray(req.body?.mappings).map(item => ({
        sourceCategory: text(item.sourceCategory).slice(0, 160),
        categoryId: text(item.categoryId),
        brandId: text(item.brandId),
        brandName: text(item.brandName).slice(0, 120),
        attributes: asArray(item.attributes).slice(0, 100),
      }));
      if (!mappings.length || mappings.some(item => !item.sourceCategory || !/^\d+$/.test(item.categoryId) || !/^\d+$/.test(item.brandId))) {
        return res.status(400).json({ error: 'Her kaynak kategori için geçerli Trendyol kategori ve marka seçin.' });
      }
      await req.firestore.collection('trendyol_feed_mappings').doc(feedId).set({
        feed_id: feedId, mappings, updated_at: new Date().toISOString(), updated_by: req.adminUser.id,
      });
      res.json({ saved: mappings.length });
    } catch (error) { res.status(400).json({ error: error.message || 'Eşleştirmeler kaydedilemedi.' }); }
  });
  app.post('/api/v1/marketplaces/trendyol/validate-feed', requireAdmin, async (req, res) => {
    try {
      const report = await buildValidation(req.firestore, req.body?.feed_id);
      res.json({ total: report.total, ready: report.ready, blocked: report.blocked, warnings: report.warnings, rows: report.rows, note: report.note });
    } catch (error) { res.status(400).json({ error: error.message || 'Trendyol ön kontrolü yapılamadı.' }); }
  });
  app.post('/api/v1/marketplaces/trendyol/publish-feed', requireAdmin, async (req, res) => {
    try {
      if (req.body?.confirm_publish !== true) return res.status(400).json({ error: 'Gönderim onayı gerekli.' });
      const report = await buildValidation(req.firestore, req.body?.feed_id);
      if (!report.total || report.blocked > 0) {
        return res.status(409).json({ error: 'Ürünler gönderilemez. Ön kontrolde ' + report.blocked + ' eksik ürün var.' });
      }
      const cfg = config();
      const data = await trendyolRequest('/integration/product/sellers/' + encodeURIComponent(cfg.supplierId) + '/v2/products', {
        method: 'POST', body: { items: report.payloads },
      });
      const batchRequestId = data.batchRequestId || data.batch_request_id || '';
      if (!batchRequestId) return res.status(502).json({ error: 'Trendyol gönderim isteğini aldı ancak Batch ID dönmedi. Mağaza panelinden kontrol edin.' });
      res.json({ ok: true, batchRequestId, itemCount: report.payloads.length, message: 'Ürünler Trendyol kuyruğuna iletildi. Yayına çıkma durumu Batch ID ile takip edilmelidir.' });
    } catch (error) { res.status(502).json({ error: error.message || 'Trendyol aktarımı başlatılamadı.' }); }
  });
  app.get('/api/v1/marketplaces/trendyol/batches/:id', requireAdmin, async (req, res) => {
    try {
      const cfg = config();
      const data = await trendyolRequest('/integration/product/sellers/' + encodeURIComponent(cfg.supplierId) +
        '/v2/products/batch-requests/' + encodeURIComponent(req.params.id));
      res.json(data);
    } catch (error) { res.status(502).json({ error: error.message || 'Batch sonucu alınamadı.' }); }
  });
}
