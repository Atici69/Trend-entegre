const API_BASE_URL = 'https://oms-external-sit.hepsiburada.com';

export async function testHepsiburadaConnection() {
  const merchantId = process.env.HEPSIBURADA_MERCHANT_ID?.trim();
  const secretKey = process.env.HEPSIBURADA_SECRET_KEY?.trim();
  const userAgent = process.env.HEPSIBURADA_USER_AGENT?.trim();

  if (!merchantId || !secretKey || !userAgent) {
    return {
      ok: false,
      status: 'not_configured',
      message: 'Hepsiburada Merchant ID, Secret Key ve User-Agent sunucu ortam değişkenlerinde tanımlı olmalıdır.',
    };
  }

  const authorization = Buffer.from(`${merchantId}:${secretKey}`, 'utf8').toString('base64');
  const url = new URL(`/orders/merchantid/${encodeURIComponent(merchantId)}`, API_BASE_URL);
  url.searchParams.set('limit', '1');
  url.searchParams.set('offset', '0');

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${authorization}`,
        'User-Agent': userAgent,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    return {
      ok: false,
      status: 'network_error',
      message: error?.name === 'TimeoutError'
        ? 'Hepsiburada SIT bağlantı isteği zaman aşımına uğradı.'
        : 'Hepsiburada SIT API adresine ulaşılamadı.',
    };
  }

  const responseText = await response.text();
  let responseData = null;
  try {
    responseData = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseData = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status === 401 || response.status === 403
        ? 'authentication_failed'
        : 'request_failed',
      httpStatus: response.status,
      message: response.status === 401 || response.status === 403
        ? 'Basic Auth bilgileri geçersiz veya test servisinde yetki tanımlı değil.'
        : 'Hepsiburada SIT bağlantı kontrolü başarısız oldu.',
    };
  }

  const orderItems = Array.isArray(responseData?.items)
    ? responseData.items
    : Array.isArray(responseData)
      ? responseData
      : null;
  const totalCount = Number.isFinite(Number(responseData?.totalCount))
    ? Number(responseData.totalCount)
    : null;

  return {
    ok: true,
    status: 'connected',
    environment: 'SIT',
    httpStatus: response.status,
    orderItemsReturned: orderItems?.length ?? null,
    totalOrderItems: totalCount,
    message: orderItems
      ? orderItems.length > 0
        ? 'Hepsiburada SIT bağlantısı başarılı; sipariş kalemi verisi alındı.'
        : 'Hepsiburada SIT bağlantısı başarılı; bu yanıtta sipariş kalemi bulunamadı.'
      : 'Hepsiburada SIT bağlantısı başarılı; yanıt alındı ancak sipariş sayısı okunamadı.',
  };
}
