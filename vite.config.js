import { defineConfig } from "vite";

// Relative asset paths support both the GitHub Pages project URL
// (/Trend-entegre/) and Capacitor's local WebView filesystem.
export default defineConfig({
  base: "./",
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
