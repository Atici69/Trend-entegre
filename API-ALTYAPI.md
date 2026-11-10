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
- `GET /api/v1/marketplaces/status`: Altı pazaryerinin gerekli kimlik bilgilerinin sunucuda tanımlı olup olmadığını gösterir. Gizli değerleri döndürmez.

## Güvenlik
- `.env` Git'e gönderilmez; yalnızca boş değişken adları `.env.example` içinde bulunur.
- API anahtarları ön yüzde saklanmamalı ve tarayıcıya gönderilmemelidir.
- HTTPS zorunlu olmalıdır.
- `CORS_ORIGINS` yalnızca gerçek ön yüz alan adlarını içermelidir.
- Gerçek API bağlantısı, ilgili pazaryerinin resmi API kimlik doğrulama/istek akışı ayrıca uygulanıp test edilince aktif sayılır.

## Aşamalı entegrasyon
Sıra: Trendyol → Hepsiburada → n11 → Amazon SP-API → Pazarama → Ozon.
Her adaptör için kimlik doğrulama testi, ürün aktarımı, stok/fiyat güncelleme ve sipariş okuma ayrı ayrı geliştirilecek. Bu başlangıç sürümü henüz pazaryerlerine istek göndermez; yalnızca güvenli sunucu temelini ve yapılandırma kontrolünü sağlar.
