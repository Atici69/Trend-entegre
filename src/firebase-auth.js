import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, signOut,
  updateProfile, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAaHp6NRiMkEGn2IBwfCaS7gxMrkJoqslU",
  authDomain: "trend-entegre.firebaseapp.com",
  databaseURL: "https://trend-entegre-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "trend-entegre",
  storageBucket: "trend-entegre.firebasestorage.app",
  messagingSenderId: "520870169459",
  appId: "1:520870169459:web:a0bd95ab18a1c6c4089306",
  measurementId: "G-TQ95GZG15Y"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const $ = (id) => document.getElementById(id);
const modal = $("authModal");
const form = $("authForm");
const nameInput = $("authName");
const phoneInput = $("authPhone");
const emailInput = $("authEmail");
const passwordInput = $("authPassword");
const submitButton = $("authSubmitBtn");
const message = $("authMessage");
let mode = "login";

setPersistence(auth, browserLocalPersistence).catch((error) => {
  console.error('Firebase oturum kalıcılığı ayarlanamadı:', error);
});

function showMessage(text, type = "ok") {
  message.textContent = text;
  message.className = `auth-message show ${type}`;
}
function clearMessage() {
  message.textContent = "";
  message.className = "auth-message";
}
function setMode(nextMode) {
  mode = nextMode;
  const registering = mode === "register";
  $("authLoginTab").classList.toggle("active", !registering);
  $("authRegisterTab").classList.toggle("active", registering);
  nameInput.hidden = !registering;
  nameInput.required = registering;
  phoneInput.hidden = false;
  phoneInput.style.display = registering ? "block" : "none";
  phoneInput.required = false;
  passwordInput.autocomplete = registering ? "new-password" : "current-password";
  submitButton.textContent = registering ? "Hesap oluştur" : "Giriş yap";
  $("authResetBtn").hidden = registering;
  $("authSubtitle").textContent = registering
    ? "Ücretsiz hesabını oluştur. E-posta adresini doğrulaman gerekecek."
    : "Hesabına güvenli şekilde giriş yap.";
  clearMessage();
}
function openModal() {
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}
function closeModal() {
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  clearMessage();
}

$("authOpenBtn").addEventListener("click", () => {
  setMode(auth.currentUser ? "login" : "login");
  openModal();
});
$("authCloseBtn").addEventListener("click", closeModal);
modal.addEventListener("click", (event) => {
  if (event.target === modal) closeModal();
});
$("authLoginTab").addEventListener("click", () => setMode("login"));
$("authRegisterTab").addEventListener("click", () => setMode("register"));

function friendlyError(error) {
  const messages = {
    "auth/email-already-in-use": "Bu e-posta adresiyle zaten hesap var. Giriş yapmayı deneyin.",
    "auth/invalid-email": "E-posta adresini kontrol edin.",
    "auth/weak-password": "Şifre en az 6 karakter olmalı.",
    "auth/invalid-credential": "E-posta veya şifre hatalı.",
    "auth/user-not-found": "Bu e-posta ile kayıtlı hesap bulunamadı.",
    "auth/too-many-requests": "Çok fazla deneme yapıldı. Bir süre sonra tekrar deneyin.",
    "auth/network-request-failed": "Bağlantı kurulamadı. İnternet bağlantınızı kontrol edin.",
    "auth/operation-not-allowed": "Firebase'de E-posta/Şifre giriş yöntemi etkin değil."
  };
  return messages[error?.code] || "İşlem tamamlanamadı. Bilgileri kontrol edip tekrar deneyin.";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessage();
  submitButton.disabled = true;
  submitButton.textContent = "İşleniyor…";
  try {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (mode === "register") {
      const fullName = nameInput.value.trim();
      const phone = phoneInput.value.trim();
      if (fullName.length < 2) throw new Error("Lütfen adınızı ve soyadınızı girin.");
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(credential.user, { displayName: fullName });
      localStorage.setItem("trendPendingCustomerName", fullName);
      if (phone) localStorage.setItem("trendPendingCustomerPhone", phone);
      await sendEmailVerification(credential.user);
      await signOut(auth);
      setMode("login");
      emailInput.value = email;
      showMessage("Hesabınız oluşturuldu. Giriş yapmadan önce e-posta kutunuza gönderdiğimiz doğrulama bağlantısına tıklayın.");
    } else {
      const credential = await signInWithEmailAndPassword(auth, email, password);
      if (!credential.user.emailVerified) {
        await sendEmailVerification(credential.user);
        await signOut(auth);
        showMessage("E-posta adresiniz henüz doğrulanmamış. Yeni doğrulama bağlantısı gönderdik; e-postanızı kontrol edin.", "error");
        return;
      }
      showMessage("Giriş başarılı. Hesabınız hazır.");
      closeModal();
    }
  } catch (error) {
    showMessage(error.message && !error.code ? error.message : friendlyError(error), "error");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = mode === "register" ? "Hesap oluştur" : "Giriş yap";
  }
});

$("authResetBtn").addEventListener("click", async () => {
  const email = emailInput.value.trim();
  if (!email) {
    showMessage("Şifre sıfırlama bağlantısı için önce e-posta adresinizi yazın.", "error");
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    showMessage("Şifre sıfırlama bağlantısı e-posta adresinize gönderildi.");
  } catch (error) {
    showMessage(friendlyError(error), "error");
  }
});

$("authLogoutBtn").addEventListener("click", async () => {
  await signOut(auth);
  showMessage("Oturum kapatıldı.");
});

onAuthStateChanged(auth, (user) => {
  const label = $("authUserLabel");
  const button = $("authOpenBtn");
  const logout = $("authLogoutBtn");
  if (user && user.emailVerified) {
    label.textContent = user.displayName || user.email;
    button.textContent = "Hesabım";
    logout.hidden = false;
  } else {
    label.textContent = "";
    button.textContent = "Giriş / Kayıt";
    logout.hidden = true;
  }
});


const checkoutModal = document.getElementById('checkoutModal');
const checkoutForm = document.getElementById('checkoutForm');
const checkoutSubmit = document.getElementById('checkoutSubmit');
const checkoutError = document.getElementById('checkoutError');
const checkoutSummary = document.getElementById('checkoutSummary');
let checkoutPlanId = '';
let checkoutPaymentUrl = '';
const checkoutMoney = value => new Intl.NumberFormat('tr-TR',{style:'currency',currency:'TRY'}).format(Number(value));
function closeCheckout(){checkoutModal.classList.remove('open');checkoutModal.setAttribute('aria-hidden','true');}
document.getElementById('checkoutClose').addEventListener('click',closeCheckout);
document.getElementById('checkoutCancel').addEventListener('click',closeCheckout);
checkoutModal.addEventListener('click',event=>{if(event.target===checkoutModal)closeCheckout();});
checkoutForm.addEventListener('submit',async event=>{
 event.preventDefault();
 const user=auth.currentUser;
 if(!user||!user.emailVerified){closeCheckout();setMode('login');openModal();showMessage('Siparişi tamamlamak için giriş yapıp e-posta adresinizi doğrulayın.','error');return;}
 if(checkoutPaymentUrl){window.location.assign(checkoutPaymentUrl);return;}
 checkoutError.classList.remove('show');checkoutError.textContent='';
 checkoutSubmit.disabled=true;checkoutSubmit.textContent='Hazırlanıyor…';
 try{
  const data=Object.fromEntries(new FormData(checkoutForm).entries());
  data.name=String(data.name||'').trim();data.surname=String(data.surname||'').trim();
  data.gsmNumber=String(data.gsmNumber||'').trim();data.identityNumber=String(data.identityNumber||'').trim();
  data.city=String(data.city||'').trim();data.district=String(data.district||'').trim();
  data.address=String(data.address||'').trim();data.zipCode=String(data.zipCode||'').trim();
  const token=await user.getIdToken(true);
  const response=await fetch('https://trend-entegre.onrender.com/api/v1/payments/iyzico/initialize',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({planId:checkoutPlanId,customer:data})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||'Ödeme başlatılamadı.');
  checkoutPaymentUrl=result.paymentPageUrl;
  document.getElementById('checkoutNet').textContent=checkoutMoney(result.totals.net);
  document.getElementById('checkoutVat').textContent=checkoutMoney(result.totals.vat);
  document.getElementById('checkoutTotal').textContent=checkoutMoney(result.totals.total);
  checkoutSummary.classList.add('show');
  checkoutSubmit.textContent='iyzico ile güvenli ödemeye geç';
 }catch(error){
  checkoutError.textContent=error.message||'İşlem tamamlanamadı. Bilgileri kontrol edip tekrar deneyin.';
  checkoutError.classList.add('show');
 }finally{checkoutSubmit.disabled=false;}
});
window.addEventListener('trend:purchase',event=>{
 checkoutPlanId=String(event.detail?.planId||'');
 checkoutPaymentUrl='';
 checkoutForm.reset();checkoutSummary.classList.remove('show');checkoutError.classList.remove('show');checkoutError.textContent='';
 checkoutSubmit.disabled=false;checkoutSubmit.textContent='Ödeme tutarını hesapla';
 const user=auth.currentUser;
 if(!user||!user.emailVerified){setMode('login');openModal();showMessage('Sipariş için önce giriş yapıp e-posta adresinizi doğrulayın.','error');return;}
 const parts=(user.displayName||'').trim().split(/\s+/);
 document.getElementById('billName').value=parts.shift()||'';
 document.getElementById('billSurname').value=parts.join(' ');
 checkoutModal.classList.add('open');checkoutModal.setAttribute('aria-hidden','false');
});
const paymentResult=new URLSearchParams(window.location.search).get('payment');if(paymentResult){const messages={success:'Ödemeniz doğrulandı. 12 aylık üyeliğiniz etkinleştirildi.',failed:'Ödeme tamamlanmadı.',error:'Ödeme sonucu doğrulanamadı. Destek ekibiyle iletişime geçin.'};alert(messages[paymentResult]||'Ödeme sonucu alındı.');const clean=new URL(window.location.href);clean.searchParams.delete('payment');clean.searchParams.delete('plan');window.history.replaceState({},'',clean.toString());}
