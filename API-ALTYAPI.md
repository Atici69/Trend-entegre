# Trend-Entegre API altyapısı

## Gereksinimler
- Node.js 20 veya üzeri
- npm

## Yerel çalıştırma
1. `npm install`
2. `.env.example` dosyasını `.env` olarak kopyalayın.
3. Gerçek API bilgilerini yalnızca yerel `.env` dosyanıza veya hosting sağlayıcısının Secret/Environment ayarlarına girin.
4. `npm run dev`

## Uç noktalar
- `GET /health`: Servis sağlık kontrolü.
- `GET /api/v1/marketplaces/status`: Pazaryerlerinin gerekli kimlik bilgilerinin sunucuda tanımlı olup olmadığını gösterir. Gizli değerleri döndürmez.
- `POST /api/v1/marketplaces/hepsiburada/test`: Hepsiburada OAuth kimlik doğrulamasını salt okunur şekilde test eder. Kimlik bilgileri yalnızca sunucu ortam değişkenlerinden alınır.

## Hepsiburada bağlantı testi
Developer Portal'dan alınan SIT/test `Client ID` ve `Client Secret` değerlerini sunucuda `HEPSIBURADA_CLIENT_ID` ve `HEPSIBURADA_CLIENT_SECRET` olarak tanımlayın. Test endpoint'i `https://api.hepsiburada.com/v3/auth` adresine `client_credentials` grant türüyle istek gönderir. Erişim belirteci istemciye döndürülmez veya kalıcı olarak saklanmaz; yalnızca kimlik doğrulamanın başarılı olup olmadığı bildirilir.

## Güvenlik
- `.env` Git'e gönderilmez; yalnızca boş değişken adları `.env.example` içinde bulunur.
- API anahtarları ön yüzde saklanmamalı ve tarayıcıya gönderilmemelidir.
- HTTPS zorunlu olmalıdır.
- `CORS_ORIGINS` yalnızca gerçek ön yüz alan adlarını içermelidir.
- Kimlik bilgileri veya sağlayıcı yanıt gövdeleri loglara yazılmamalıdır.

## Aşamalı entegrasyon
Sıra: Trendyol → Hepsiburada → n11 → Amazon SP-API → Pazarama → Ozon.
Her adaptör için kimlik doğrulama testi, ürün aktarımı, stok/fiyat güncelleme ve sipariş okuma ayrı ayrı geliştirilecek. Hepsiburada için bu aşamada yalnızca OAuth bağlantı testi bulunur; ürün, stok ve sipariş işlemleri henüz uygulanmamıştır.
