const API_BASE_URL = 'https://apigw.trendyol.com';

function getCredentials() {
  const supplierId = process.env.TRENDYOL_SUPPLIER_ID?.trim();
  const apiKey = process.env.TRENDYOL_API_KEY?.trim();
  const apiSecret = process.env.TRENDYOL_API_SECRET?.trim();
  if (!supplierId || !apiKey || !apiSecret) return null;
  if (!/^\d+$/.test(supplierId)) return null;
  return { supplierId, apiKey, apiSecret };
}

function authHeaders(credentials) {
  const token = Buffer.from(`${credentials.apiKey}:${credentials.apiSecret}`, 'utf8').toString('base64');
  return {
    Authorization: `Basic ${token}`,
    'User-Agent': `${credentials.supplierId} - SelfIntegration`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

async function trendyolRequest(path, query = {}) {
  const credentials = getCredentials();
  if (!credentials) {
    return { ok: false, status: 'not_configured', message: 'Trendyol Supplier ID, API Key ve API Secret Render ortam değişkenlerinde eksik veya hatalı.' };
  }

  const url = new URL(path.replace(':sellerId', encodeURIComponent(credentials.supplierId)), API_BASE_URL);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: authHeaders(credentials),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    return {
      ok: false,
      status: 'network_error',
      message: error?.name === 'TimeoutError' ? 'Trendyol API isteği zaman aşımına uğradı.' : 'Trendyol API sunucusuna ulaşılamadı.',
    };
  }

  const bodyText = await response.text();
  let data = null;
  try { data = bodyText ? JSON.parse(bodyText) : {}; } catch { data = { message: 'Trendyol API geçerli JSON yanıtı döndürmedi.' }; }

  if (!response.ok) {
    const status = response.status === 401 || response.status === 403
      ? 'authentication_failed'
      : response.status === 429 ? 'rate_limited' : 'request_failed';
    return {
      ok: false,
      status,
      httpStatus: response.status,
      message: response.status === 401
        ? 'API Key veya API Secret doğrulanamadı. Render ortam değişkenlerini kontrol edin.'
        : response.status === 403
          ? 'Trendyol isteği yetkilendirmedi. User-Agent veya API erişim yetkisini kontrol edin.'
          : response.status === 429
            ? 'Trendyol istek limiti aşıldı. Biraz bekleyip tekrar deneyin.'
            : 'Trendyol API isteği başarısız oldu.',
    };
  }
  return { ok: true, httpStatus: response.status, data };
}

export async function testTrendyolConnection() {
  const credentials = getCredentials();
  if (!credentials) {
    return { ok: false, status: 'not_configured', message: 'Trendyol Supplier ID, API Key ve API Secret Render ortam değişkenlerinde tanımlanmalıdır.' };
  }
  const result = await trendyolRequest('/integration/product/sellers/:sellerId/products/approved', { page: 0, size: 1 });
  if (!result.ok) return result;
  return {
    ok: true,
    status: 'connected',
    httpStatus: result.httpStatus,
    supplierId: credentials.supplierId,
    productCount: Number(result.data?.totalElements || 0),
    message: 'Trendyol API bağlantısı başarılı.',
  };
}

export async function getTrendyolProducts({ page = 0, size = 20 } = {}) {
  const safePage = Math.max(0, Math.min(9999, Number.parseInt(page, 10) || 0));
  const safeSize = Math.max(1, Math.min(100, Number.parseInt(size, 10) || 20));
  const result = await trendyolRequest('/integration/product/sellers/:sellerId/products/approved', { page: safePage, size: safeSize });
  if (!result.ok) return result;
  return { ok: true, httpStatus: result.httpStatus, products: Array.isArray(result.data?.content) ? result.data.content : [], totalElements: Number(result.data?.totalElements || 0), totalPages: Number(result.data?.totalPages || 0), page: safePage, size: safeSize };
}

export async function getTrendyolOrders({ status = 'Created', page = 0, size = 50 } = {}) {
  const allowedStatuses = new Set(['Created', 'Picking', 'Invoiced', 'Shipped', 'Cancelled', 'Delivered', 'UnDelivered', 'Returned', 'AtCollectionPoint', 'UnPacked', 'UnSupplied', 'Awaiting', 'Verified']);
  const safeStatus = allowedStatuses.has(status) ? status : 'Created';
  const safePage = Math.max(0, Math.min(9999, Number.parseInt(page, 10) || 0));
  const safeSize = Math.max(1, Math.min(200, Number.parseInt(size, 10) || 50));
  const result = await trendyolRequest('/integration/order/sellers/:sellerId/v2/orders', {
    status: safeStatus,
    page: safePage,
    size: safeSize,
    orderByField: 'PackageLastModifiedDate',
    orderByDirection: 'DESC',
  });
  if (!result.ok) return result;
  return { ok: true, httpStatus: result.httpStatus, orders: Array.isArray(result.data?.content) ? result.data.content : [], totalElements: Number(result.data?.totalElements || 0), totalPages: Number(result.data?.totalPages || 0), page: safePage, size: safeSize };
}


export async function searchTrendyolBrands(name) {
  const query = String(name || '').trim().slice(0, 100);
  if (!query) return { ok: false, status: 'invalid_query', message: 'Marka arama metni gerekli.' };
  const result = await trendyolRequest('/integration/product/brands/by-name', { name: query });
  if (!result.ok) return result;
  const brands = Array.isArray(result.data) ? result.data : Array.isArray(result.data?.brands) ? result.data.brands : [];
  return { ok: true, brands: brands.map(item => ({ id: item.id, name: item.name, luxe: Boolean(item.luxe) })) };
}

export async function searchTrendyolCategories(name) {
  const query = String(name || '').trim().slice(0, 100);
  if (!query) return { ok: false, status: 'invalid_query', message: 'Kategori arama metni gerekli.' };
  const result = await trendyolRequest('/integration/product/product-categories', { name: query });
  if (!result.ok) return result;
  return { ok: true, categories: result.data?.categories || result.data || [] };
}

export async function getTrendyolCategoryAttributes(categoryId) {
  const id = String(categoryId || '').trim();
  if (!/^\\d+$/.test(id)) return { ok: false, status: 'invalid_category', message: 'Geçerli Trendyol kategori ID gerekli.' };
  const result = await trendyolRequest(`/integration/product/categories/${encodeURIComponent(id)}/attributes`);
  if (!result.ok) return result;
  return { ok: true, attributes: result.data?.categoryAttributes || [], category: { id: result.data?.id || Number(id), name: result.data?.name || result.data?.displayName || '' } };
}


export async function createTrendyolProducts(items) {
  const credentials = getCredentials();
  if (!credentials) return { ok: false, status: 'not_configured', message: 'Trendyol API kimlik bilgileri Render ortamında eksik.' };
  if (!Array.isArray(items) || !items.length || items.length > 1000) {
    return { ok: false, status: 'invalid_items', message: 'Tek istekte 1 ile 1000 arasında ürün gönderilebilir.' };
  }
  const url = new URL(`/integration/product/sellers/${encodeURIComponent(credentials.supplierId)}/v2/products`, API_BASE_URL);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(credentials),
      body: JSON.stringify({ items }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    return { ok: false, status: 'network_error', message: error?.name === 'TimeoutError' ? 'Trendyol ürün aktarımı zaman aşımına uğradı.' : 'Trendyol ürün aktarım servisine ulaşılamadı.' };
  }
  const bodyText = await response.text();
  let data = null;
  try { data = bodyText ? JSON.parse(bodyText) : {}; } catch { data = { message: 'Trendyol API geçerli JSON yanıtı döndürmedi.' }; }
  if (!response.ok) {
    return { ok: false, status: response.status === 401 || response.status === 403 ? 'authentication_failed' : 'request_failed', httpStatus: response.status, message: data?.message || data?.errors?.[0]?.message || 'Trendyol ürün aktarım isteğini reddetti.' };
  }
  return { ok: true, httpStatus: response.status, data };
}

export async function getTrendyolBatchRequestResult(batchRequestId) {
  const id = String(batchRequestId || '').trim();
  if (!id || id.length > 120 || !/^[a-zA-Z0-9-]+$/.test(id)) {
    return { ok: false, status: 'invalid_batch_id', message: 'Geçerli bir Trendyol batchRequestId gerekli.' };
  }
  const result = await trendyolRequest(`/integration/product/sellers/:sellerId/products/batch-requests/${encodeURIComponent(id)}`);
  if (!result.ok) return result;
  return { ok: true, data: result.data };
}
