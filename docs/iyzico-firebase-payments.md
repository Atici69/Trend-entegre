# Trend-Entegre iyzico + Firebase ödeme kurulumu

Bu dal, iyzico abonelik Checkout Form akışını Express API'ye ekler. Ödeme anahtarları yalnızca Render sunucu ortam değişkenlerinde tutulur; tarayıcıya veya mobil uygulamaya gönderilmez.

## Render Environment değişkenleri

Aşağıdaki değerleri Render servisinin **Environment** bölümüne ekleyin:

- `FIREBASE_PROJECT_ID`: Firebase projesinin Project ID değeri.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: Firebase Console > Project settings > Service accounts bölümünden oluşturulan servis hesabı JSON içeriğinin tamamı. Bu değer gizlidir.
- `IYZIPAY_API_KEY`: iyzico API anahtarı.
- `IYZIPAY_SECRET_KEY`: iyzico güvenlik anahtarı.
- `IYZIPAY_URI`: İlk testlerde `https://sandbox-api.iyzipay.com`; canlıya geçerken iyzico'nun verdiği production API adresi.
- `IYZIPAY_CALLBACK_URL`: Render API adresi + `/api/v1/payments/iyzico/callback`.
- `IYZIPAY_RETURN_URL`: Kullanıcının ödeme sonrası döneceği Trend-Entegre web adresi.
- `IYZIPAY_SUBSCRIPTION_PLANS_JSON`: iyzico panelinde önceden oluşturulmuş abonelik fiyat planlarının referans kodları.

Örnek plan yapılandırması (referans kodlarını iyzico panelindeki gerçek değerlerle değiştirin):

```json
{
  "tek-pazaryeri": { "referenceCode": "IYZICO_PLAN_REFERENCE_1", "amount": 799 },
  "coklu-pazaryeri": { "referenceCode": "IYZICO_PLAN_REFERENCE_2", "amount": 4999 },
  "full-paket": { "referenceCode": "IYZICO_PLAN_REFERENCE_3", "amount": 9999 },
  "buybox-pro": { "referenceCode": "IYZICO_PLAN_REFERENCE_4", "amount": 2399 }
}
```

Plan referans kodları ve tutarları iyzico panelindeki fiyat planlarıyla birebir aynı olmalıdır. İstemciden gelen fiyat kabul edilmez; sunucu yalnızca bu sunucu yapılandırmasındaki plan kodunu kullanır.

## API uç noktaları

- `GET /api/v1/payments/iyzico/status`: Sağlayıcı, test/canlı ortamı ve yapılandırılmış plan kimliklerini (gizli anahtarları değil) bildirir.
- `POST /api/v1/payments/iyzico/subscription/initialize`: Firebase Authentication ID token'ı `Authorization: Bearer <token>` başlığıyla ister. Gövdede `planId` ve müşteri/fatura bilgileri bulunur. Başarılı yanıtta iyzico Checkout Form içeriği ve token döner.
- `POST /api/v1/payments/iyzico/callback`: iyzico callback token'ını sunucu tarafında sorgular. Yalnızca iyzico doğrulaması başarılı ve abonelik referans kodu mevcutsa Firestore aboneliğini etkinleştirir.

## Firestore koleksiyonları

- `payment_attempts`: Bekleyen/başarılı/başarısız ödeme denemeleri. Checkout token'ı düz metin değil SHA-256 özeti olarak tutulur.
- `subscriptions`: Kullanıcı başına etkin abonelik ve iyzico abonelik referansı.
- `users`: Kullanıcının aktif paket özeti.

## Güvenli devreye alma sırası

1. iyzico panelinde abonelik ürünlerini ve aylık fiyat planlarını oluşturun.
2. Firebase Authentication'da e-posta doğrulaması etkin kullanıcı hesabı oluşturma akışını tamamlayın.
3. Render'a servis hesabı ve iyzico sandbox değişkenlerini ekleyin.
4. `GET /api/v1/payments/iyzico/status` yanıtında `configured: true` ve dört planı görün.
5. Sandbox testini tamamlamadan production API adresi veya canlı anahtar kullanmayın.
6. Canlı anahtarlar daha önce sohbet içinde paylaşıldıysa iyzico panelinden iptal edip yenilerini oluşturun.

**Önemli:** Tanıtım sayfasına Firebase e-posta/şifre kayıt ve giriş arayüzü eklendi. Yeni hesaplarda e-posta doğrulaması zorunludur. Ödeme API'si yalnızca Firebase ID token'ı ve doğrulanmış e-posta kabul eder. iyzico Checkout Form'un paket seçimi ve müşteri/fatura formuyla arayüze bağlanması, Render ortam değişkenlerinin eklenmesi ve sandbox testleri hâlâ tamamlanmalıdır; canlı ödeme etkin değildir.
