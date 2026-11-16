# Trend-Entegre API ve yönetici paneli

## Gereksinimler
- Node.js 20 veya üzeri
- npm
- Supabase projesi (Auth + Postgres)
- Node destekleyen bir API barındırma servisi

## Yerel çalıştırma
1. `npm install`
2. `.env.example` dosyasını `.env` olarak kopyalayın.
3. Supabase URL, anon key, service-role key ve ADMIN_EMAILS değerlerini yalnızca sunucu ortam değişkenlerine girin.
4. Supabase Auth bölümünde yönetici hesabını oluşturun; `ADMIN_EMAILS` listesine aynı e-posta adresini ekleyin.
5. `supabase/migrations/202611110001_admin_foundation.sql` dosyasını Supabase SQL Editor üzerinden uygulayın.
6. `npm start`

## Yönetici güvenliği
- `GET /api/v1/admin/config`: Sadece Supabase URL ve anon key gibi istemcide paylaşılabilen yapılandırmayı verir.
- `GET /api/v1/admin/session`: Bearer token'ı Supabase Auth ile doğrular ve e-posta adresinin `ADMIN_EMAILS` listesinde olmasını zorunlu tutar.
- `GET /api/v1/admin/overview`: Doğrulanmış yönetici oturumu ile müşteri, aktif abonelik, bayi ve ödeme sayılarını döndürür.
- Panel parolayı saklamaz. Erişim belirteci yalnızca sekme oturumu boyunca sessionStorage'da tutulur.
- Yönetici hesabı panelden kaydedilemez; hesap Supabase Auth üzerinden önceden oluşturulmalıdır.
- `SUPABASE_SERVICE_ROLE_KEY` hiçbir koşulda tarayıcıya gönderilmez. Yalnızca API sunucusunda kullanılır.

## Veritabanı
İlk yönetim tabloları `supabase/migrations/202611110001_admin_foundation.sql` içindedir. SQL dosyasını Supabase SQL Editor'da uygulayın. Tablolar RLS ile korunur; istemci rollerine doğrudan erişim verilmez. Sunucu, JWT ve yönetici izin listesini doğruladıktan sonra service-role anahtarıyla işlem yapar.

## Hosting
GitHub Pages statik dosyaları sunar; Node.js API veya Postgres çalıştırmaz. API ayrı bir Node hosting ortamında çalışmalıdır. Hosting ortamında `.env.example` içindeki değişkenleri tanımlayın. `CORS_ORIGINS` içine `https://atici69.github.io` adresini ekleyin.

## Pazaryeri uç noktaları
- `GET /api/v1/marketplaces/status`: Sunucuda kimlik bilgilerinin tanımlı olup olmadığını gösterir; sırları döndürmez.
- `POST /api/v1/marketplaces/hepsiburada/test`: Salt okunur SIT bağlantı testi.

Pazaryeri anahtarlarını HTML, GitHub veya tarayıcı koduna eklemeyin.

## Yönetici veri modülleri
Tüm aşağıdaki uç noktalar Supabase Auth JWT ve `ADMIN_EMAILS` listesi ile korumalıdır:
- `GET /api/v1/admin/customers`: sayfalı müşteri listesi ve arama.
- `POST /api/v1/admin/customers`, `PATCH /api/v1/admin/customers/:id`: müşteri oluşturma ve düzenleme.
- `DELETE /api/v1/admin/customers/:id`: kaydı silmeden pasife alma.
- `GET/POST/PATCH/DELETE /api/v1/admin/subscriptions`: abonelik yönetimi; DELETE iptal durumuna alır.
- `GET/POST/PATCH/DELETE /api/v1/admin/dealers`: bayi yönetimi; DELETE pasife alır.
- `GET /api/v1/admin/payments`: ödeme kayıtlarını salt okunur listeler. Gerçek tahsilat/iade ödeme sağlayıcısı entegrasyonu olmadan yapılmaz.
- Yönetici oluşturma, güncelleme ve pasife alma işlemleri `admin_audit_logs` tablosuna yazılır.

## Android APK oluşturma
Depoda Capacitor Android platformu yapılandırılmıştır. GitHub Actions `Android APK build` iş akışı debug APK üretir ve Actions artifact olarak saklar. APK'yı indirmek için başarılı iş akışındaki Artifacts bölümünü açın. Debug APK test ve doğrudan kurulum içindir; Google Play yayını için Android release imzası ve Play Console süreci ayrıca tamamlanmalıdır.
