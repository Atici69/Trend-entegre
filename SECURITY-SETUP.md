# Firebase güvenlik kuralları

Bu depodaki kurallar tarayıcıdan Firestore ve Realtime Database erişimini varsayılan olarak reddeder. Mevcut web istemcisinde Firebase Authentication kullanılıyor; uygulama verileri sunucu tarafındaki Firebase Admin SDK üzerinden okunup yazılıyor. Admin SDK, Firebase Security Rules kurallarını atlar; API uç noktalarının kendi kimlik doğrulama ve yetkilendirme kontrolleri devam etmelidir.

## Yayınlama

Yetkili proje yöneticisi önce Firebase Console'da doğru projenin `trend-entegre` olduğunu doğrulamalı, ardından Firebase CLI ile:

```bash
firebase deploy --project trend-entegre --only firestore:rules,database
```

Yayınlamadan sonra giriş/kayıt akışı ve sunucu API'si test edilmelidir. Tarayıcıdan doğrudan veri erişimi ileride gerekirse, genel erişim açmak yerine kullanıcı UID'si ve belge sahipliğine dayalı dar kapsamlı kurallar yazılmalıdır.

## Konsol kontrolleri

- Authentication > Settings > Authorized domains: yalnızca kullanılan alan adlarını tutun.
- Google Cloud Console > APIs & Services > Credentials: web API anahtarına doğru HTTP referrer ve API kısıtlamaları uygulayın; Firebase Auth akışını test etmeden kısıtlamaları daraltmayın.
- Render Environment: Firebase Admin servis hesabı ve diğer gizli anahtarlar yalnızca sunucuda tutulmalı.
- Daha önce paylaşılmış olabilecek iyzico gizli anahtarları, hesap sahibi tarafından iyzico panelinden yenilenmeli.
- GitHub Secret Scanning ve Push Protection etkinleştirilmeli.

Bu dosyalar Firebase Console veya Render ayarlarını kendiliğinden değiştirmez. Kurallar, doğru projeye deploy edilene kadar etkin değildir.