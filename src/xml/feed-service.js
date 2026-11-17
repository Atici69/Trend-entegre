import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const MAX_XML_BYTES = 25 * 1024 * 1024;
const MAX_PRODUCTS = 5000;
const PRODUCT_TAGS = new Set(['product', 'item', 'urun', 'entry', 'offer', 'productitem']);
const parser = new XMLParser({
  ignoreAttributes: true,
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  trimValues: true,
  allowBooleanAttributes: false,
});

function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const p = address.split('.').map(Number);
    const [a, b] = p;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0));
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:') || normalized === '::1' || normalized === '::' ||
        normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
        normalized.startsWith('fea') || normalized.startsWith('feb') ||
        normalized.startsWith('fc') || normalized.startsWith('fd') ||
        normalized.startsWith('ff') || normalized.startsWith('2001:db8:')) return false;
    const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff;
  }
  return false;
}

async function resolvePublicHost(hostname) {
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new Error('Özel veya yerel ağ adreslerine erişim engellendi.');
    return [{ address: hostname, family: isIP(hostname) }];
  }
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(record => !isPublicAddress(record.address))) {
    throw new Error('XML adresi güvenli bir genel IP adresine çözülmedi.');
  }
  return records;
}

function requestOnce(url, addressRecords) {
  return new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const selected = addressRecords[0];
    const req = https.request(url, {
      method: 'GET',
      headers: { Accept: 'application/xml,text/xml,application/rss+xml,application/atom+xml,*/*;q=0.5', 'User-Agent': 'TrendEntegre-XML/1.0' },
      servername: isIP(hostname) ? undefined : hostname,
      lookup: (_host, options, callback) => {
        if (options?.all) callback(null, addressRecords);
        else callback(null, selected.address, selected.family);
      },
    }, response => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        resolve({ redirect: response.headers.location || null });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error('XML sunucusu HTTP ' + status + ' yanıtı verdi.'));
        return;
      }
      const declaredLength = Number(response.headers['content-length'] || 0);
      if (declaredLength > MAX_XML_BYTES) {
        response.resume();
        reject(new Error('XML dosyası 25 MB sınırını aşıyor.'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_XML_BYTES) {
          response.destroy(new Error('XML dosyası 25 MB sınırını aşıyor.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    req.setTimeout(15000, () => req.destroy(new Error('XML bağlantısı zaman aşımına uğradı.')));
    req.on('error', reject);
    req.end();
  });
}

export async function downloadXml(source) {
  let url;
  try { url = new URL(String(source || '').trim()); } catch { throw new Error('Geçerli bir XML adresi girin.'); }
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
      throw new Error('Güvenlik için yalnızca HTTPS (443) XML adresleri kabul edilir.');
    }
    const records = await resolvePublicHost(url.hostname);
    const result = await requestOnce(url, records);
    if (result.body !== undefined) return result.body;
    if (!result.redirect || redirects === 3) throw new Error('XML yönlendirmesi geçersiz veya çok fazla.');
    url = new URL(result.redirect, url);
  }
  throw new Error('XML kaynağı indirilemedi.');
}

function normalizeXmlKey(value) {
  return String(value ?? '')
    .split(':').pop()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[^a-z0-9]/g, '');
}

function textValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = textValue(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    for (const key of ['#text', 'value', 'Value', 'url', 'href', 'src']) {
      if (value[key] !== undefined) {
        const found = textValue(value[key]);
        if (found) return found;
      }
    }
    return '';
  }
  return String(value).trim();
}

function findField(product, aliases) {
  const wanted = new Set(aliases.map(normalizeXmlKey));
  const stack = [product];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    for (const [key, value] of Object.entries(current)) {
      if (wanted.has(normalizeXmlKey(key))) {
        const found = textValue(value);
        if (found) return found;
      }
    }
    for (const value of Object.values(current)) if (value && typeof value === 'object') stack.push(value);
  }
  return '';
}

function inferProductCategory(name) {
  const value = normalizeXmlKey(name);
  const rules = [
    ['Bileklik', ['bileklik', 'kunye']],
    ['Kolye', ['kolye', 'kolyeucu']],
    ['Küpe', ['kupe']],
    ['Yüzük', ['yuzuk']],
    ['Halhal', ['halhal']],
    ['Broş', ['bros']],
    ['Takı Seti', ['tak seti', 'takim seti', 'set tak']],
    ['Saat', ['saat']],
  ];
  for (const [category, keywords] of rules) {
    if (keywords.some(keyword => value.includes(normalizeXmlKey(keyword)))) return category;
  }
  return '';
}

function resolveProductCategory(item) {
  const sourceCategory = findField(item, ['category', 'category_name', 'product_type', 'kategori', 'kategori_baslik']);
  const genericCategories = new Set(['', 'katalog', 'genel', 'urunler', 'urun', 'products', 'product']);
  if (!genericCategories.has(normalizeXmlKey(sourceCategory))) return sourceCategory;
  const productName = findField(item, ['name', 'title', 'product_name', 'productname', 'urunadi', 'ürünadı', 'baslik', 'product_title']);
  return inferProductCategory(productName) || sourceCategory || 'Katalog';
}

function collectProducts(node, found = []) {
  if (!node || typeof node !== 'object' || found.length >= MAX_PRODUCTS) return found;
  for (const [key, value] of Object.entries(node)) {
    if (PRODUCT_TAGS.has(normalizeXmlKey(key))) {
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        if (item && typeof item === 'object' && found.length < MAX_PRODUCTS) found.push(item);
      }
      continue;
    }
    if (value && typeof value === 'object') collectProducts(value, found);
  }
  return found;
}

function hasForbiddenXmlDeclarations(xml) {
  // DTD markup is forbidden, but the same characters inside comments or CDATA
  // are ordinary text and must not cause a false positive.
  const markup = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '');
  return /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(markup);
}

export function parseProducts(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw new Error('XML dosyası boş.');
  if (hasForbiddenXmlDeclarations(xml)) throw new Error('Güvenlik nedeniyle DTD ve özel XML varlıkları kabul edilmez.');
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new Error('XML biçimi geçersiz. Etiketleri ve XML yapısını kontrol edin.');
  const parsed = parser.parse(xml);
  const raw = collectProducts(parsed);
  if (!raw.length) throw new Error('Ürün kayıtları bulunamadı. Ürün etiketleri product, item, urun veya offer olmalıdır.');
  const products = raw.map((item, index) => ({
    'Ürün ID': findField(item, ['id', 'product_id', 'productid', 'item_id', 'urun_kodu', 'urunkodu', 'product_code']),
    'Ürün Adı': findField(item, ['name', 'title', 'product_name', 'productname', 'urunadi', 'ürünadı', 'baslik', 'product_title']),
    'SKU': findField(item, ['sku', 'stock_code', 'stockcode', 'model', 'stok_kodu', 'merchant_sku', 'seller_sku']),
    'Barkod': findField(item, ['barcode', 'gtin', 'ean', 'ean13', 'upc', 'barcode_number', 'barkod']),
    'Marka': findField(item, ['brand', 'manufacturer', 'marka', 'marka_baslik']),
    'Kategori': resolveProductCategory(item),
    'Fiyat': findField(item, ['price', 'sale_price', 'selling_price', 'regular_price', 'list_price', 'fiyat']),
    'Para Birimi': findField(item, ['currency', 'currency_code', 'parabirimi', 'kur_tipi']),
    'Stok': findField(item, ['quantity', 'stock', 'stock_quantity', 'available_quantity', 'inventory', 'qty', 'stok', 'stok_adedi']),
    // Varsayılan kargo desisi: tedarikçi XML'inde değer yoksa 1 kabul edilir.
    'Desi': findField(item, ['desi', 'dimensional_weight', 'dimensionalweight', 'cargo_des', 'kargo_desi']) || '1',
    'KDV Oranı': findField(item, ['vat_rate', 'vatrate', 'kdv', 'kdv_orani', 'kdvorani']),
    'Menşei': findField(item, ['origin', 'country_of_origin', 'countryoforigin', 'origin_code', 'menşei', 'mensei', 'ulke_kodu']),
    'Görsel URL': findField(item, ['image', 'image_url', 'image_link', 'main_image', 'picture', 'picture_url', 'gorsel', 'urun_resim_1']),
    'Açıklama': findField(item, ['description', 'short_description', 'long_description', 'aciklama', 'açıklama', 'kisa_aciklama']),
  }));
  return products;
}

export function clampProductLimit(value, available) {
  if (String(value) === 'all') return Math.min(available, MAX_PRODUCTS);
  const count = Number.parseInt(value, 10);
  if (![10, 30, 100, 1000, 5000].includes(count)) throw new Error('Ürün adedi 10, 30, 100, 1000, 5000 veya tümü olmalıdır.');
  return Math.min(count, available, MAX_PRODUCTS);
}
