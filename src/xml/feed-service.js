import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const MAX_XML_BYTES = 25 * 1024 * 1024;
const MAX_PRODUCTS = 5000;
const PRODUCT_TAGS = new Set(['product', 'item', 'urun', 'ürün', 'entry', 'offer', 'productitem']);
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

function textValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return textValue(value[0]);
  if (typeof value === 'object') {
    for (const key of ['#text', 'value', 'Value']) if (value[key] !== undefined) return textValue(value[key]);
    return '';
  }
  return String(value).trim();
}

function findField(product, aliases) {
  const wanted = new Set(aliases.map(x => x.toLocaleLowerCase('tr-TR')));
  const stack = [product];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    for (const [key, value] of Object.entries(current)) {
      if (wanted.has(key.toLocaleLowerCase('tr-TR'))) {
        const found = textValue(value);
        if (found) return found;
      }
    }
    for (const value of Object.values(current)) if (value && typeof value === 'object') stack.push(value);
  }
  return '';
}

function collectProducts(node, found = []) {
  if (!node || typeof node !== 'object' || found.length >= MAX_PRODUCTS) return found;
  for (const [key, value] of Object.entries(node)) {
    if (PRODUCT_TAGS.has(key.toLocaleLowerCase('tr-TR'))) {
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

export function parseProducts(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw new Error('XML dosyası boş.');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Güvenlik nedeniyle DTD ve özel XML varlıkları kabul edilmez.');
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new Error('XML biçimi geçersiz. Etiketleri ve XML yapısını kontrol edin.');
  const parsed = parser.parse(xml);
  const raw = collectProducts(parsed);
  if (!raw.length) throw new Error('Ürün kayıtları bulunamadı. Ürün etiketleri product, item, urun veya offer olmalıdır.');
  const products = raw.map((item, index) => ({
    'Ürün ID': findField(item, ['id', 'product_id', 'productid']),
    'Ürün Adı': findField(item, ['name', 'title', 'product_name', 'productname', 'urunadi', 'ürünadı', 'baslik']),
    'SKU': findField(item, ['sku', 'stock_code', 'stockcode', 'model', 'stok_kodu']),
    'Barkod': findField(item, ['barcode', 'gtin', 'ean', 'barcode_number']),
    'Marka': findField(item, ['brand', 'manufacturer', 'marka', 'marka_baslik']),
    'Kategori': findField(item, ['category', 'category_name', 'kategori']),
    'Fiyat': findField(item, ['price', 'sale_price', 'selling_price', 'fiyat']),
    'Para Birimi': findField(item, ['currency', 'currency_code', 'parabirimi', 'kur_tipi']),
    'Stok': findField(item, ['quantity', 'stock', 'stock_quantity', 'qty', 'stok']),
    'Görsel URL': findField(item, ['image', 'image_url', 'picture', 'picture_url', 'gorsel', 'urun_resim_1']),
    'Açıklama': findField(item, ['description', 'short_description', 'aciklama', 'açıklama', 'kisa_aciklama']),
  }));
  return products;
}

export function clampProductLimit(value, available) {
  if (String(value) === 'all') return Math.min(available, MAX_PRODUCTS);
  const count = Number.parseInt(value, 10);
  if (![10, 30, 100, 1000, 5000].includes(count)) throw new Error('Ürün adedi 10, 30, 100, 1000, 5000 veya tümü olmalıdır.');
  return Math.min(count, available, MAX_PRODUCTS);
}
