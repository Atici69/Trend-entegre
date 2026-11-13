import { auth } from "./firebase-auth.js?v=20261113-mobile-nav1";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

const API_BASE_URL = "https://trend-entegre.onrender.com";
const syncedUsers = new Set();

async function syncCustomer(user) {
  // Do not sync the temporary account state before profile details are saved and email is verified.
  if (!user.emailVerified) return;
  if (syncedUsers.has(user.uid)) return;
  syncedUsers.add(user.uid);
  try {
    const token = await user.getIdToken();
    const response = await fetch(`${API_BASE_URL}/api/v1/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        full_name: (localStorage.getItem("trendPendingCustomerName") || user.displayName || user.email?.split("@")[0] || "Müşteri").trim(),
        phone: localStorage.getItem("trendPendingCustomerPhone") || ""
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Firestore kayıt eşitlemesi başarısız.");
    localStorage.removeItem("trendPendingCustomerPhone");
    localStorage.removeItem("trendPendingCustomerName");
    window.dispatchEvent(new CustomEvent("trend-customer-sync", { detail: { ok: true, uid: user.uid } }));
  } catch (error) {
    syncedUsers.delete(user.uid);
    console.error("Trend-Entegre müşteri kaydı eşitlenemedi:", error);
    window.dispatchEvent(new CustomEvent("trend-customer-sync", {
      detail: { ok: false, message: error.message }
    }));
  }
}

onAuthStateChanged(auth, (user) => {
  if (user) syncCustomer(user);
});

window.addEventListener("trend-customer-sync", (event) => {
  if (event.detail?.ok) return;
  const message = document.getElementById("authMessage");
  if (!message) return;
  message.textContent = "Hesabınız açıldı ancak yönetim kaydı henüz eşitlenemedi. E-posta doğrulamasından sonra tekrar giriş yapın. " + (event.detail?.message || "");
  message.className = "auth-message show error";
});
