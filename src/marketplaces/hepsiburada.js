const AUTH_URL = 'https://api.hepsiburada.com/v3/auth';

export async function testHepsiburadaConnection() {
  const clientId = process.env.HEPSIBURADA_CLIENT_ID?.trim();
  const clientSecret = process.env.HEPSIBURADA_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    return {
      ok: false,
      status: 'not_configured',
      message: 'Hepsiburada Client ID ve Client Secret sunucu ortam değişkenlerinde tanımlı değil.',
    };
  }

  let response;
  try {
    response = await fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    return {
      ok: false,
      status: 'network_error',
      message: error?.name === 'TimeoutError'
        ? 'Hepsiburada kimlik doğrulama isteği zaman aşımına uğradı.'
        : 'Hepsiburada API adresine ulaşılamadı.',
    };
  }

  if (!response.ok) {
    // Do not return provider response bodies: they may contain sensitive diagnostics.
    return {
      ok: false,
      status: 'authentication_failed',
      httpStatus: response.status,
      message: response.status === 401 || response.status === 403
        ? 'Kimlik bilgileri geçersiz veya API yetkisi tanımlı değil.'
        : 'Hepsiburada kimlik doğrulama isteği başarısız oldu.',
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: 'invalid_response',
      message: 'Hepsiburada geçerli bir JSON kimlik doğrulama yanıtı döndürmedi.',
    };
  }

  if (!payload?.access_token) {
    return {
      ok: false,
      status: 'invalid_response',
      message: 'Hepsiburada yanıtında erişim belirteci bulunamadı.',
    };
  }

  return {
    ok: true,
    status: 'connected',
    tokenType: payload.token_type || 'Bearer',
    expiresIn: Number.isFinite(Number(payload.expires_in)) ? Number(payload.expires_in) : null,
    message: 'Hepsiburada kimlik doğrulaması başarılı.',
  };
}
