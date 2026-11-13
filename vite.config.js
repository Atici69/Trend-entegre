import { defineConfig } from "vite";

// Capacitor paketine web uygulamasının tüm kullanıcı sayfalarını dahil et.
// Ödeme kurtarma aracı yalnızca web tarafında kalır; mobil uygulamaya eklenmez.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        admin: "admin/index.html",
        xmlMerkezi: "xml-merkezi.html",
        legal: "legal.html"
      }
    }
  }
});
