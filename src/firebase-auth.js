import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, signOut,
  updateProfile, onAuthStateChanged, reload
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
export const auth = getAuth(app);
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

const loginRequestedFromNavigation = new URLSearchParams(window.location.search).get('giris') === '1';

const persistenceReady = setPersistence(auth, browserLocalPersistence).catch((error) => {
  console.error('Firebase oturum kalıcılığı ayarlanamadı:', error);
  throw error;
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

if (loginRequestedFromNavigation) {
  setMode("login");
  openModal();
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete("giris");
  window.history.replaceState({}, "", cleanUrl.toString());
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
    await persistenceReady;
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
      await reload(credential.user);
      const refreshedUser = auth.currentUser || credential.user;
      if (!refreshedUser.emailVerified) {
        await signOut(auth);
        showMessage("E-posta adresiniz henüz doğrulanmamış. Gelen kutunuzdaki en son Trend-Entegre doğrulama bağlantısına tıklayın. Yeni e-posta otomatik gönderilmedi.", "error");
        return;
      }
      showMessage("Giriş başarılı. Hesabınız hazır.");
      closeModal();
      await ensureBillingProfile(refreshedUser);
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
    ensureBillingProfile(user).catch(error => console.warn("Fatura profili kontrolü:", error));
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
const cityInput=document.getElementById('billCity');
const districtInput=document.getElementById('billDistrict');
const addressInput=document.getElementById('billAddress');
const cityOptions=document.getElementById('billCityOptions');
const districtOptions=document.getElementById('billDistrictOptions');
const addressOptions=document.getElementById('billAddressOptions');
let geoTimer=null,geoSequence=0;
const geoCache=new Map();
const trFeature=f=>{const p=f?.properties||{};return String(p.countrycode||'').toUpperCase()==='TR'||/^(turkey|türkiye)$/i.test(String(p.country||''));};
const geoLabel=f=>{const p=f.properties||{};return [p.name,p.street,p.housenumber,p.district,p.city,p.state].filter((v,i,a)=>v&&a.indexOf(v)===i).join(', ');};
async function geoSearch(query,layer){
 const key=layer+'|'+query.toLocaleLowerCase('tr-TR');
 if(geoCache.has(key))return geoCache.get(key);
 const params=new URLSearchParams({q:query,lang:'tr',limit:'8'});
 if(layer)params.set('layer',layer);
 const response=await fetch('https://photon.komoot.io/api/?'+params.toString(),{headers:{Accept:'application/json'}});
 if(!response.ok)throw new Error('Adres önerileri şu anda alınamadı.');
 const json=await response.json();
 const features=(json.features||[]).filter(trFeature);
 geoCache.set(key,features);
 return features;
}
function fillOptions(list,features){list.replaceChildren(...features.map(f=>{const option=document.createElement('option');option.value=geoLabel(f);return option;}));}
function scheduleGeo(input,list,layer,queryBuilder,onSelect){
 input.addEventListener('input',()=>{
  clearTimeout(geoTimer);const query=queryBuilder(input.value);const seq=++geoSequence;
  if(query.trim().length<2){list.replaceChildren();return;}
  geoTimer=setTimeout(async()=>{
   try{const results=await geoSearch(query,layer);if(seq!==geoSequence)return;fillOptions(list,results);
    const chosen=results.find(f=>geoLabel(f)===input.value.trim());
    if(chosen&&onSelect)onSelect(chosen);
   }catch(error){console.warn('Adres önerisi alınamadı:',error);}
  },350);
 });
 input.addEventListener('change',async()=>{
  const query=queryBuilder(input.value);
  try{const results=await geoSearch(query,layer);const chosen=results.find(f=>geoLabel(f)===input.value.trim())||results[0];if(chosen&&onSelect)onSelect(chosen);}catch(error){console.warn(error);}
 });
}
function applyAddressFeature(feature){
 const p=feature.properties||{};
 const province=p.state||p.county||p.city||'';
 const district=p.district||p.county||(p.city&&p.city!==province?p.city:'');
 if(province)cityInput.value=province;
 if(district)districtInput.value=district;
 const street=[p.suburb,p.street,p.housenumber].filter(Boolean).join(' ');
 if(street)addressInput.value=street;
 if(p.postcode)document.getElementById('billZip').value=p.postcode;
}
scheduleGeo(cityInput,cityOptions,'locality',v=>v,f=>{const p=f.properties||{};cityInput.value=p.state||p.city||p.name||cityInput.value;});
scheduleGeo(districtInput,districtOptions,'district',v=>[cityInput.value,v].filter(Boolean).join(' '),f=>{const p=f.properties||{};districtInput.value=p.district||p.name||districtInput.value;});
scheduleGeo(addressInput,addressOptions,'street',v=>[cityInput.value,districtInput.value,v].filter(Boolean).join(' '),applyAddressFeature);
const checkoutMoney = value => new Intl.NumberFormat('tr-TR',{style:'currency',currency:'TRY'}).format(Number(value));
function closeCheckout(){checkoutModal.classList.remove('open');checkoutModal.setAttribute('aria-hidden','true');}
document.getElementById('checkoutClose').addEventListener('click',closeCheckout);
document.getElementById('checkoutCancel').addEventListener('click',closeCheckout);
checkoutModal.addEventListener('click',event=>{if(event.target===checkoutModal)closeCheckout();});
checkoutForm.addEventListener('submit',async event=>{
 event.preventDefault();
 const user=auth.currentUser;
 if(!user||!user.emailVerified){closeCheckout();setMode('login');openModal();showMessage('Siparişi tamamlamak için giriş yapıp e-posta adresinizi doğrulayın.','error');return;}
 if(checkoutPaymentUrl){
  try{
   const paymentUrl=new URL(checkoutPaymentUrl);
   if(paymentUrl.protocol!=='https:')throw new Error('Güvenli olmayan ödeme adresi engellendi.');
   if(Capacitor.isNativePlatform()){
    await Browser.open({url:paymentUrl.toString()});
   }else{
    window.location.assign(paymentUrl.toString());
   }
  }catch(error){
   checkoutError.textContent=error.message||'iyzico ödeme sayfası açılamadı. Lütfen tekrar deneyin.';
   checkoutError.classList.add('show');
  }
  return;
 }
 checkoutError.classList.remove('show');checkoutError.textContent='';
 checkoutSubmit.disabled=true;checkoutSubmit.textContent='Hazırlanıyor…';
 try{
  const data=Object.fromEntries(new FormData(checkoutForm).entries());
  data.name=String(data.name||'').trim();data.surname=String(data.surname||'').trim();
  data.gsmNumber=String(data.gsmNumber||'').trim();data.identityNumber=String(data.identityNumber||'').trim();data.taxOffice=savedBillingProfile?.tax_office||'';data.companyType=savedBillingProfile?.company_type||'';
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
window.addEventListener('trend:purchase',async event=>{
 checkoutPlanId=String(event.detail?.planId||'');
 const isTestProduct=checkoutPlanId.startsWith('test-product-');
 document.getElementById('checkoutLead').textContent=isTestProduct?'Gerçek karttan tek seferlik test çekimi için fatura bilgilerinizi kontrol edin.':'Yıllık paket satın alımınızı tamamlamak için fatura bilgilerinizi girin. Ödeme kredi kartından tek çekim alınır.';
 document.getElementById('checkoutNetLabel').textContent=isTestProduct?'Test ürünü bedeli':'Yıllık paket bedeli';
 document.getElementById('checkoutTermNote').textContent=isTestProduct?'Bu ödeme tek seferliktir; abonelik, paket süresi veya otomatik yenileme başlatmaz.':'12 aylık kullanım hakkı. Otomatik yenileme yapılmaz; sonraki yıl yenileme sizin onayınızla gerçekleştirilir.';
 checkoutPaymentUrl='';
 checkoutForm.reset();checkoutSummary.classList.remove('show');checkoutError.classList.remove('show');checkoutError.textContent='';
 checkoutSubmit.disabled=false;checkoutSubmit.textContent='Ödeme tutarını hesapla';
 const user=auth.currentUser;
 if(!user||!user.emailVerified){setMode('login');openModal();showMessage('Sipariş için önce giriş yapıp e-posta adresinizi doğrulayın.','error');return;}
 if(!savedBillingProfile?.billing_profile_completed){await ensureBillingProfile(user);if(!savedBillingProfile?.billing_profile_completed)return;}
 const parts=(user.displayName||'').trim().split(/\s+/);
 document.getElementById('billName').value=parts.shift()||'';
 document.getElementById('billSurname').value=parts.join(' ');
 if(savedBillingProfile?.billing_profile_completed){
  document.getElementById('billName').value=(savedBillingProfile.full_name||user.displayName||'').split(/\\s+/)[0]||'';
  document.getElementById('billSurname').value=(savedBillingProfile.full_name||user.displayName||'').split(/\\s+/).slice(1).join(' ');
  document.getElementById('billCompany').value=savedBillingProfile.company_name||'';
  document.getElementById('billPhone').value=savedBillingProfile.phone||'';
  document.getElementById('billIdentity').value=savedBillingProfile.tax_number||'';
  cityInput.value=savedBillingProfile.city||'';districtInput.value=savedBillingProfile.district||'';
  addressInput.value=savedBillingProfile.address||'';
  document.getElementById('billZip').value=savedBillingProfile.zip_code||'';
 }
 checkoutModal.classList.add('open');checkoutModal.setAttribute('aria-hidden','false');
});
const profileModal=document.getElementById('profileModal');
const profileForm=document.getElementById('profileForm');
const profileSave=document.getElementById('profileSave');
const profileError=document.getElementById('profileError');
const profileType=document.getElementById('profileCompanyType');
const profileTaxOffice=document.getElementById('profileTaxOffice');
const profileTaxOfficeWrap=document.getElementById('profileTaxOfficeWrap');
const profileTaxNumber=document.getElementById('profileTaxNumber');
const profileTaxNumberLabel=document.getElementById('profileTaxNumberLabel');
let savedBillingProfile=null;
let profileCheckUid='';
function updateProfileTaxFields(){
 const sole=profileType.value==='sole_proprietor';
 profileTaxNumber.maxLength=sole?11:10;
 profileTaxNumber.minLength=sole?11:10;
 profileTaxNumberLabel.textContent=sole?'T.C. kimlik numarası (11 hane) *':'Vergi numarası (10 hane) *';
 profileTaxOfficeWrap.style.display=sole?'none':'block';
 profileTaxOffice.required=!sole;
}
profileType.addEventListener('change',updateProfileTaxFields);
async function profileRequest(method='GET',body){
 const user=auth.currentUser;if(!user)throw new Error('Önce giriş yapmalısınız.');
 const token=await user.getIdToken(true);
 const response=await fetch('https://trend-entegre.onrender.com/api/v1/customer/profile',{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const result=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(result.error||'Profil işlemi tamamlanamadı.');
 return result;
}
function fillProfileForm(profile){
 const map={full_name:'profileFullName',phone:'profilePhone',company_name:'profileCompany',company_type:'profileCompanyType',tax_office:'profileTaxOffice',tax_number:'profileTaxNumber',city:'profileCity',district:'profileDistrict',address:'profileAddress',zip_code:'profileZip'};
 for(const [key,id] of Object.entries(map))document.getElementById(id).value=profile?.[key]||'';
 updateProfileTaxFields();
}
function openProfile(profile){
 fillProfileForm(profile||{});
 profileError.classList.remove('show');profileError.textContent='';
 profileModal.classList.add('open');profileModal.setAttribute('aria-hidden','false');
}
async function ensureBillingProfile(user){
 if(!user||!user.emailVerified||profileCheckUid===user.uid)return;
 profileCheckUid=user.uid;
 try{
  const result=await profileRequest();
  savedBillingProfile=result.profile||{};
  if(!savedBillingProfile.billing_profile_completed)openProfile(savedBillingProfile);
 }catch(error){
  profileCheckUid='';
  showMessage('Firma/fatura profili kontrol edilemedi: '+error.message,'error');
 }
}
profileForm.addEventListener('submit',async event=>{
 event.preventDefault();profileError.classList.remove('show');profileSave.disabled=true;profileSave.textContent='Kaydediliyor…';
 try{
  const data=Object.fromEntries(new FormData(profileForm).entries());
  for(const key of Object.keys(data))data[key]=String(data[key]||'').trim();
  if(data.company_type==='sole_proprietor'){data.tax_office='';}
  const result=await profileRequest('PUT',data);
  savedBillingProfile={...result.profile,billing_profile_completed:true};
  profileModal.classList.remove('open');profileModal.setAttribute('aria-hidden','true');
  showMessage('Firma ve fatura profiliniz kaydedildi. Artık siparişlerde otomatik kullanılacak.');
 }catch(error){profileError.textContent=error.message||'Profil kaydedilemedi.';profileError.classList.add('show');}
 finally{profileSave.disabled=false;profileSave.textContent='Profili kaydet';}
});
const paymentResult=new URLSearchParams(window.location.search).get('payment');if(paymentResult){const messages={success:'Ödemeniz doğrulandı. 12 aylık üyeliğiniz etkinleştirildi.',failed:'Ödeme tamamlanmadı.',error:'Ödeme sonucu doğrulanamadı. Destek ekibiyle iletişime geçin.'};alert(messages[paymentResult]||'Ödeme sonucu alındı.');const clean=new URL(window.location.href);clean.searchParams.delete('payment');clean.searchParams.delete('plan');window.history.replaceState({},'',clean.toString());}
