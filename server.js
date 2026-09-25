
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const app = express();
const PORT = process.env.PORT || 3000;
const root = __dirname;
// V39: Varsayılan veri yolu doğrudan repo klasörüdür.
// Yalnızca gerçekten bir Render Persistent Disk kullanıyorsan SHAZ_PERSIST_DIR ver.
const requestedPersistDir = (process.env.SHAZ_PERSIST_DIR||'').trim();
let persistRoot = root;
if(requestedPersistDir){
  try{
    fs.mkdirSync(requestedPersistDir,{recursive:true});
    fs.accessSync(requestedPersistDir,fs.constants.W_OK);
    persistRoot=requestedPersistDir;
  }catch(e){
    console.warn('SHAZ_PERSIST_DIR kullanılamadı; repo klasörü kullanılacak.');
    persistRoot=root;
  }
}
const dataDir = path.join(persistRoot,'data');
const uploadDir = path.join(persistRoot,'uploads');
fs.mkdirSync(dataDir,{recursive:true});
fs.mkdirSync(uploadDir,{recursive:true});
// İlk kullanımda repodaki başlangıç JSON'larını kalıcı alana yalnızca bir kez kopyala.
for(const name of ['settings.json','catalog.json','orders.json','users.json','customers.json','addresses.json','favorites.json','marketing_consents.json','legal_documents.json','legal_documents_backup.json','legal_acceptances.json','phone_verifications.json','password_resets.json','coupons.json','new_member_coupon_templates.json','account_login_attempts.json','account_state.enc']){
  const dst=path.join(dataDir,name);
  const seed=path.join(root,'data',name);
  if(!fs.existsSync(dst) && fs.existsSync(seed)) fs.copyFileSync(seed,dst);
}
console.log('SHAZ veri dizini:',persistRoot);
app.use(express.json({limit:'5mb'}));
app.use(express.urlencoded({extended:true}));
app.use('/uploads', express.static(uploadDir,{maxAge:'7d'}));

// Yeni sürümlerde telefonların eski JS/CSS'i tutup sipariş isteğini eski kodla göndermesini engelle.
app.use((req,res,next)=>{
  if (/\.(?:html?|js|css)$/i.test(req.path) || req.path==='/' || req.path==='/admin') {
    res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma','no-cache');
    res.setHeader('Expires','0');
  }
  next();
});
function brandAsset(){
  const cfg=readJson('settings.json',{}),raw=String(cfg.logoUrl||'/uploads/shaz-logo-transparent.png').trim();
  if(/^https?:\/\//i.test(raw))return {remote:raw};
  const clean=raw.replace(/^\/+/,''),candidates=[path.join(persistRoot,clean),path.join(root,'public',clean),path.join(root,clean)];
  const file=candidates.find(f=>fs.existsSync(f)&&fs.statSync(f).isFile());return {file,raw};
}
app.get('/api/brand-image',(req,res)=>{const a=brandAsset();if(a.remote)return res.redirect(302,a.remote);if(a.file){res.setHeader('Cache-Control','public, max-age=86400');return res.sendFile(a.file)}res.status(404).end()});
async function sendBrandPng(req,res,size){
  try{const a=brandAsset();if(a.remote)return res.redirect(302,a.remote);if(!a.file)return res.status(404).end();const buf=await sharp(a.file).resize(size,size,{fit:'contain',background:{r:255,g:255,b:255,alpha:0}}).png().toBuffer();res.type('png').set('Cache-Control','public, max-age=604800').send(buf)}catch(e){console.error('favicon üretimi:',e);res.status(500).end()}
}
app.get('/favicon.ico',(req,res)=>sendBrandPng(req,res,64));
app.get('/favicon-32.png',(req,res)=>sendBrandPng(req,res,32));
app.get('/favicon-64.png',(req,res)=>sendBrandPng(req,res,64));
app.get('/favicon-192.png',(req,res)=>sendBrandPng(req,res,192));
app.get('/apple-touch-icon.png',(req,res)=>sendBrandPng(req,res,180));
app.get('/social-card.png',async(req,res)=>{
  try{const a=brandAsset();if(a.remote)return res.redirect(302,a.remote);if(!a.file)return res.status(404).end();const logo=await sharp(a.file).resize(520,220,{fit:'inside',withoutEnlargement:true}).png().toBuffer();const card=await sharp({create:{width:1200,height:630,channels:4,background:{r:255,g:255,b:255,alpha:1}}}).composite([{input:logo,gravity:'center'}]).png().toBuffer();res.type('png').set('Cache-Control','public, max-age=604800').send(card)}catch(e){console.error('sosyal kart üretimi:',e);res.status(500).end()}
});
app.use(express.static(path.join(root,'public'),{etag:false,lastModified:false}));

// ---------- SEO: robots, sitemap ve gerçek ürün URL'leri ----------
const SHAZ_ORIGIN='https://shaz.com.tr';
function seoSlugPart(value){
  return String(value||'').trim().toLocaleLowerCase('tr-TR')
    .replaceAll('ı','i').replaceAll('ğ','g').replaceAll('ü','u').replaceAll('ş','s').replaceAll('ö','o').replaceAll('ç','c')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}
function productSeoSlug(product){
  const base=seoSlugPart(product?.name||'urun')||'urun';
  const code=seoSlugPart(product?.internalCode||'').replace(/^shaz-?/,'');
  return code?`${base}-${code}`:`${base}-${seoSlugPart(product?.id||'urun')}`;
}
function escapeXml(value){
  return String(value??'').replace(/[<>&'"]/g,ch=>({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[ch]));
}
function escapeHtmlAttr(value){
  return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
app.get('/robots.txt',(req,res)=>{
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /hesabim\nSitemap: ${SHAZ_ORIGIN}/sitemap.xml\n`);
});
app.get('/sitemap.xml',(req,res)=>{
  const catalog=readJson('catalog.json',{products:[]});
  const urls=[`${SHAZ_ORIGIN}/`,...(catalog.products||[]).filter(p=>p&&!p.hidden).map(p=>`${SHAZ_ORIGIN}/urun/${encodeURIComponent(productSeoSlug(p))}`)];
  const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(url=>`  <url><loc>${escapeXml(url)}</loc></url>`).join('\n')}\n</urlset>`;
  res.type('application/xml').send(xml);
});
app.get('/urun/:slug',(req,res)=>{
  const catalog=readJson('catalog.json',{products:[]});
  const product=(catalog.products||[]).find(p=>p&&!p.hidden&&productSeoSlug(p)===String(req.params.slug||''));
  if(!product)return res.status(404).type('text/plain').send('Ürün bulunamadı');
  const indexPath=path.join(root,'public','index.html');
  let html=fs.readFileSync(indexPath,'utf8');
  const title=`${String(product.name||'SHAZ Ürün').trim()} | SHAZ`;
  const rawDesc=String(product.description||product.subtitle||(Array.isArray(product.features)?product.features.filter(Boolean).join(', '):'')||'SHAZ erkek aksesuarı').trim();
  const desc=rawDesc.slice(0,160);
  const canonical=`${SHAZ_ORIGIN}/urun/${encodeURIComponent(productSeoSlug(product))}`;
  const image=String(product.image||((product.images||[])[0])||'').trim();
  const absoluteImage=image?(image.startsWith('http')?image:`${SHAZ_ORIGIN}${image.startsWith('/')?'':'/'}${image}`):'';
  html=html
    .replace(/<title>[^<]*<\/title>/,`<title>${escapeHtmlAttr(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/,`<meta name="description" content="${escapeHtmlAttr(desc)}">`)
    .replace(/<link rel="canonical" href="[^"]*">/,`<link rel="canonical" href="${escapeHtmlAttr(canonical)}">`)
    .replace(/<meta property="og:type" content="[^"]*">/,`<meta property="og:type" content="product">`)
    .replace(/<meta property="og:title" content="[^"]*">/,`<meta property="og:title" content="${escapeHtmlAttr(title)}">`)
    .replace(/<meta property="og:description" content="[^"]*">/,`<meta property="og:description" content="${escapeHtmlAttr(desc)}">`)
    .replace(/<meta property="og:url" content="[^"]*">/,`<meta property="og:url" content="${escapeHtmlAttr(canonical)}">`);
  if(absoluteImage)html=html.replace('</head>',`<meta property="og:image" content="${escapeHtmlAttr(absoluteImage)}">\n</head>`);
  res.type('html').send(html);
});

// ---------- Yönetici güvenliği ----------
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_COOKIE = 'shaz_admin_session';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

if(!ADMIN_USER || !ADMIN_PASSWORD || !SESSION_SECRET){
  console.warn('UYARI: ADMIN_USER, ADMIN_PASSWORD veya SESSION_SECRET eksik. /admin güvenlik için kapalı kalacak.');
}

const parseCookies=req=>{
  const out={};
  String(req.headers.cookie||'').split(';').forEach(part=>{
    const i=part.indexOf('=');
    if(i>0) out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());
  });
  return out;
};
const safeEqual=(a,b)=>{
  const aa=Buffer.from(String(a)); const bb=Buffer.from(String(b));
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
};
const signSession=issuedAt=>{
  const payload=String(issuedAt);
  const sig=crypto.createHmac('sha256',SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
};
const validSession=req=>{
  if(!SESSION_SECRET)return false;
  const token=parseCookies(req)[SESSION_COOKIE];
  if(!token)return false;
  const [issued,sig]=token.split('.');
  if(!issued||!sig)return false;
  const ts=Number(issued);
  if(!Number.isFinite(ts) || Date.now()-ts>SESSION_MAX_AGE_MS || ts>Date.now()+60000)return false;
  const expected=crypto.createHmac('sha256',SESSION_SECRET).update(issued).digest('hex');
  return safeEqual(sig,expected);
};
const requireAdmin=(req,res,next)=>{
  if(validSession(req))return next();
  if(req.path.startsWith('/api/'))return res.status(401).json({ok:false,message:'Yönetici girişi gerekli.'});
  return res.redirect('/admin/login');
};

// Basit brute-force sınırlaması: IP başına 15 dakikada en fazla 8 başarısız giriş.
const loginAttempts=new Map();
const LOGIN_WINDOW=15*60*1000, LOGIN_MAX=8;
const loginKey=req=>String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
const isLoginBlocked=key=>{
  const now=Date.now(), x=loginAttempts.get(key);
  if(!x)return false;
  if(now-x.start>LOGIN_WINDOW){loginAttempts.delete(key);return false}
  return x.count>=LOGIN_MAX;
};
const registerLoginFailure=key=>{
  const now=Date.now(), x=loginAttempts.get(key);
  if(!x||now-x.start>LOGIN_WINDOW)loginAttempts.set(key,{count:1,start:now});
  else{x.count++;loginAttempts.set(key,x)}
};

const readJson=(name,fallback)=>{try{return JSON.parse(fs.readFileSync(path.join(dataDir,name),'utf8'))}catch(e){return fallback}};
const writeJson=(name,data)=>fs.writeFileSync(path.join(dataDir,name),JSON.stringify(data,null,2),'utf8');

// ---------- v153 müşteri hesabı: ortak backend/data katmanı ----------
const USER_SESSION_COOKIE='shaz_user_session';
const USER_SESSION_SECRET=(process.env.USER_SESSION_SECRET||SESSION_SECRET||'').trim();
const USER_SESSION_MAX_AGE_MS=30*24*60*60*1000;
const PHONE_VERIFICATION_REQUIRED=String(process.env.PHONE_VERIFICATION_REQUIRED||'false').toLowerCase()==='true';
const SMS_PROVIDER=String(process.env.SMS_PROVIDER||'verimor').toLowerCase();
const GOOGLE_CLIENT_ID=String(process.env.GOOGLE_CLIENT_ID||'').trim();
const APPLE_CLIENT_ID=String(process.env.APPLE_CLIENT_ID||'').trim();
const APPLE_REDIRECT_URI=String(process.env.APPLE_REDIRECT_URI||'').trim();
const RESEND_API_KEY=String(process.env.RESEND_API_KEY||'').trim();
const PASSWORD_RESET_FROM=String(process.env.PASSWORD_RESET_FROM||'SHAZ <noreply@shaz.com.tr>').trim();
const PUBLIC_BASE_URL=String(process.env.PUBLIC_BASE_URL||'https://shaz.com.tr').replace(/\/$/,'');
const accountLoginAttempts=new Map();
for(const [name,fallback] of Object.entries({
  'users.json':[],'customers.json':[],'addresses.json':[],'favorites.json':[],'marketing_consents.json':[],'legal_acceptances.json':[],'phone_verifications.json':[],'password_resets.json':[],'new_member_coupon_templates.json':[],'account_login_attempts.json':{},'legal_documents_backup.json':[],
  'legal_documents.json':[
    {type:'MEMBERSHIP',version:'1',title:'Üyelik Sözleşmesi',content:'',active:true},
    {type:'KVKK',version:'1',title:'KVKK Aydınlatma Metni',content:'',active:true},
    {type:'PRIVACY',version:'1',title:'Gizlilik Politikası',content:'',active:true},
    {type:'COOKIE',version:'1',title:'Çerez Politikası',content:'',active:true},
    {type:'PRE_INFORMATION',version:'1',title:'Ön Bilgilendirme Formu',content:'',active:true},
    {type:'DISTANCE_SALES',version:'1',title:'Mesafeli Satış Sözleşmesi',content:'',active:true}
  ]
})){
  const f=path.join(dataDir,name);if(!fs.existsSync(f))writeJson(name,fallback);
}
const normalizeAccountPhone=value=>{const d=String(value||'').replace(/\D/g,'');if(/^5\d{9}$/.test(d))return '0'+d;if(/^05\d{9}$/.test(d))return d;if(/^905\d{9}$/.test(d))return '0'+d.slice(2);return ''};
const normalizeEmail=value=>String(value||'').trim().toLowerCase();
function normalizeAccountAddressPart(value,type){
  let text=String(value||'').trim();
  const rx=type==='neighborhood'?/\s+(mahallesi|mahalle|mah\.?|mh\.?)$/iu:type==='avenue'?/\s+(caddesi|cadde|cad\.?|cd\.?)$/iu:/\s+(sokağı|sokak|sok\.?|sk\.?)$/iu;
  text=text.replace(rx,'').trim();
  return text?`${text} ${type==='neighborhood'?'MH.':type==='avenue'?'CD.':'SK.'}`:'';
}
function validBirthDateIso(value){
  const m=String(value||'').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return false;
  const y=Number(m[1]),mo=Number(m[2]),d=Number(m[3]),dt=new Date(Date.UTC(y,mo-1,d));
  if(dt.getUTCFullYear()!==y||dt.getUTCMonth()!==mo-1||dt.getUTCDate()!==d)return false;
  const today=new Date(),age=today.getUTCFullYear()-y-(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate())<Date.UTC(today.getUTCFullYear(),mo-1,d)?1:0);
  return y>=1900&&age>=0&&age<=120;
}
function passwordHash(password,salt=crypto.randomBytes(16).toString('hex')){const hash=crypto.scryptSync(String(password),salt,64).toString('hex');return {salt,hash}}
function passwordMatches(password,user){if(!user?.passwordSalt||!user?.passwordHash)return false;const test=crypto.scryptSync(String(password),user.passwordSalt,64).toString('hex');return safeEqual(test,user.passwordHash)}
const PROFILE_NAME_COOLDOWN_MS=30*24*60*60*1000;
const PROFILE_PHONE_COOLDOWN_MS=7*24*60*60*1000;
const PROFILE_VERIFY_TTL_MS=30*60*1000;
function profileChangeMeta(u){const m=(u&&u.profileChangeMeta&&typeof u.profileChangeMeta==='object')?u.profileChangeMeta:{};return {nameChangedAt:m.nameChangedAt||null,phoneChangedAt:m.phoneChangedAt||null,emailChangedAt:m.emailChangedAt||null,birthDateUserChangeCount:Number(m.birthDateUserChangeCount||0)}}
function profileWaitMs(at,period){const t=at?new Date(at).getTime():0;return t?Math.max(0,t+period-Date.now()):0}
function humanWait(ms){const d=Math.floor(ms/86400000),h=Math.floor((ms%86400000)/3600000),m=Math.ceil((ms%3600000)/60000);return [d?`${d} gün`:'' ,h?`${h} saat`:'' ,(!d&&!h&&m)?`${m} dakika`:'' ].filter(Boolean).join(' ')||'kısa bir süre'}
function pushProfileHistory(u,field,oldValue,newValue,source='account'){const oldText=String(oldValue??''),newText=String(newValue??'');if(oldText===newText)return;u.profileChangeHistory=Array.isArray(u.profileChangeHistory)?u.profileChangeHistory:[];u.profileChangeHistory.push({at:new Date().toISOString(),field,oldValue:oldText,newValue:newText,source});}
function publicUser(u){if(!u)return null;const meta=profileChangeMeta(u);return {id:u.id,customerId:u.customerId,firstName:u.firstName,lastName:u.lastName,email:u.email,phone:normalizeAccountPhone(u.phone)||u.phone,birthDate:u.birthDate||'',phoneVerifiedAt:u.phoneVerifiedAt||null,smsMarketingConsent:!!u.smsMarketingConsent,emailMarketingConsent:!!u.emailMarketingConsent,createdAt:u.createdAt,authProviders:Array.isArray(u.authProviders)?u.authProviders:(u.passwordHash?['password']:[]),profileChangeMeta:meta,profileRules:{nameWaitMs:profileWaitMs(meta.nameChangedAt,PROFILE_NAME_COOLDOWN_MS),phoneWaitMs:profileWaitMs(meta.phoneChangedAt,PROFILE_PHONE_COOLDOWN_MS),birthDateChangeAvailable:meta.birthDateUserChangeCount<1},pendingEmailChange:u.pendingEmailChange?{email:u.pendingEmailChange.email,requestedAt:u.pendingEmailChange.requestedAt,expiresAt:u.pendingEmailChange.expiresAt}:null,pendingPhoneChange:u.pendingPhoneChange?{phone:u.pendingPhoneChange.phone,requestedAt:u.pendingPhoneChange.requestedAt,expiresAt:u.pendingPhoneChange.expiresAt}:null}}
function signUserSession(user){if(!USER_SESSION_SECRET)return '';const payload=Buffer.from(JSON.stringify({uid:user.id,iat:Date.now(),v:Number(user.authVersion||1)})).toString('base64url');const sig=crypto.createHmac('sha256',USER_SESSION_SECRET).update(payload).digest('base64url');return payload+'.'+sig}
function accountUserFromReq(req){if(!USER_SESSION_SECRET)return null;const token=parseCookies(req)[USER_SESSION_COOKIE];if(!token)return null;const [payload,sig]=token.split('.');if(!payload||!sig)return null;const exp=crypto.createHmac('sha256',USER_SESSION_SECRET).update(payload).digest('base64url');if(!safeEqual(sig,exp))return null;let data;try{data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'))}catch{return null}if(!data.uid||Date.now()-Number(data.iat||0)>USER_SESSION_MAX_AGE_MS)return null;const u=readJson('users.json',[]).find(x=>x.id===data.uid);if(!u||u.disabled||Number(u.authVersion||1)!==Number(data.v||1))return null;return u}
function setUserSession(res,user,req){const secure=process.env.NODE_ENV==='production'||String(req.headers['x-forwarded-proto']||'').includes('https');const token=signUserSession(user);res.setHeader('Set-Cookie',`${USER_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${USER_SESSION_MAX_AGE_MS/1000}${secure?'; Secure':''}`)}
function clearUserSession(res,req){const secure=process.env.NODE_ENV==='production'||String(req.headers['x-forwarded-proto']||'').includes('https');res.setHeader('Set-Cookie',`${USER_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure?'; Secure':''}`)}
function requireUser(req,res,next){const u=accountUserFromReq(req);if(!u)return res.status(401).json({ok:false,message:'Giriş yapmanız gerekiyor.'});req.accountUser=u;next()}
function sameOriginGuard(req,res,next){if(['GET','HEAD','OPTIONS'].includes(req.method))return next();const origin=String(req.headers.origin||'');const host=String(req.headers.host||'');if(origin){try{if(new URL(origin).host!==host)return res.status(403).json({ok:false,message:'Geçersiz istek kaynağı.'})}catch{return res.status(403).json({ok:false,message:'Geçersiz istek kaynağı.'})}}next()}
const accountRateKey=req=>String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
const ACCOUNT_LOGIN_MAX_ATTEMPTS=5;
function accountLoginDeviceId(req){const raw=String(req.body?.deviceId||req.headers['x-shaz-device-id']||'').trim();return /^[A-Za-z0-9._:-]{8,120}$/.test(raw)?raw:accountRateKey(req)}
function accountLoginAttemptKey(req){return accountLoginDeviceId(req)}
function readAccountLoginAttempts(){const x=readJson('account_login_attempts.json',{});return x&&typeof x==='object'&&!Array.isArray(x)?x:{}}
function writeAccountLoginAttempts(x){writeJson('account_login_attempts.json',x)}
function accountAttemptState(key){const now=Date.now(),all=readAccountLoginAttempts(),x=all[key]||{count:0,blockedUntil:0,lastFailureAt:0,lockCount:0};if(x.blockedUntil&&now>=x.blockedUntil){x.count=0;x.blockedUntil=0;all[key]=x;writeAccountLoginAttempts(all)}return x}
function accountFailKey(key){const now=Date.now(),all=readAccountLoginAttempts(),x=all[key]||{count:0,blockedUntil:0,lastFailureAt:0,lockCount:0};if(x.blockedUntil&&now>=x.blockedUntil){x.count=0;x.blockedUntil=0}x.count=Math.min(ACCOUNT_LOGIN_MAX_ATTEMPTS,Number(x.count||0)+1);x.lastFailureAt=now;if(x.count>=ACCOUNT_LOGIN_MAX_ATTEMPTS){x.lockCount=Number(x.lockCount||0)+1;x.blockedUntil=now+(x.lockCount>=2?5:3)*60*1000;x.count=ACCOUNT_LOGIN_MAX_ATTEMPTS}all[key]=x;writeAccountLoginAttempts(all);return Math.max(0,ACCOUNT_LOGIN_MAX_ATTEMPTS-x.count)}
function clearAccountLoginAttempts(key){const all=readAccountLoginAttempts();delete all[key];writeAccountLoginAttempts(all)}
function accountBlockedMessage(key){const x=accountAttemptState(key),remainingMs=Math.max(0,Number(x.blockedUntil||0)-Date.now()),secs=Math.max(1,Math.ceil(remainingMs/1000)),mins=Math.ceil(secs/60);return `5 hatalı giriş hakkınız doldu. ${mins} dakika sonra tekrar deneyin.`}
function consentIp(req){return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim()}
function readLegalDocuments(){
  let docs=readJson('legal_documents.json',[]);const backup=readJson('legal_documents_backup.json',[]);
  const hasText=arr=>Array.isArray(arr)&&arr.some(d=>String(d?.content||'').trim());
  if(!hasText(docs)&&hasText(backup)){docs=backup;writeJson('legal_documents.json',docs)}
  return Array.isArray(docs)?docs:[];
}
function currentLegalDoc(type){return readLegalDocuments().find(d=>d.type===type&&d.active!==false)||null}
function legalHash(doc){return crypto.createHash('sha256').update(String(doc?.content||'')).digest('hex')}
function personalizationSnapshots(items){const out=[];(items||[]).forEach((item,itemIndex)=>{(item.writes||[]).forEach(w=>out.push({itemIndex,productId:item.product?.id||'',productName:item.product?.name||'',fieldType:'write',placement:w.position||'',customerValue:w.text||'',fee:Number(w.fee||0)}));(item.photoCustomizations||[]).forEach(p=>out.push({itemIndex,productId:item.product?.id||'',productName:item.product?.name||'',fieldType:'photo',placement:p.position||'',customerValue:p.note||'',uploadedImageReference:p.url||p.imageUrl||'',fee:Number(p.fee||0)}))});return out}
// Gelecekte Verimor açıldığında provider burada değiştirilecek; şu an SMS gönderilmez.
const SmsVerificationProvider={sendOtp:async()=>{throw new Error('SMS OTP şu an kapalı.')},verifyOtp:async()=>false};


const stripLegacyStockRecords=catalog=>{
  if(!catalog||typeof catalog!=='object')return catalog;
  const products=Array.isArray(catalog.products)?catalog.products:[];
  for(const product of products){if(product&&typeof product==='object'&&Object.prototype.hasOwnProperty.call(product,'stock'))delete product.stock}
  return catalog;
};
// Eski stok sayıları artık kullanılmıyor; stok durumu yalnız “Tükendi” işaretinden yönetilir.
try{
  const catalogPath=path.join(dataDir,'catalog.json');
  if(fs.existsSync(catalogPath)){
    const current=readJson('catalog.json',{categories:[],products:[],builder:{}});
    const hadStock=(current.products||[]).some(p=>p&&Object.prototype.hasOwnProperty.call(p,'stock'));
    if(hadStock)writeJson('catalog.json',stripLegacyStockRecords(current));
  }
}catch(e){console.warn('Eski stok kayıtları temizlenemedi:',e.message)}

const normalizeTRMobile=value=>{
  const digits=String(value||'').replace(/\D/g,'');
  if(/^5\d{9}$/.test(digits))return digits;
  if(/^05\d{9}$/.test(digits))return digits.slice(1);
  return '';
};


const GOOGLE_SHEETS_WEBHOOK_URL=process.env.GOOGLE_SHEETS_WEBHOOK_URL||'';
const GOOGLE_SHEETS_SECRET=process.env.GOOGLE_SHEETS_SECRET||'';

// ---------- V39: GitHub kalıcı katalog / fotoğraf deposu ----------
const GITHUB_TOKEN=(process.env.SHAZ_GITHUB_TOKEN||'').trim();
const GITHUB_REPO=(process.env.SHAZ_GITHUB_REPO||'').trim(); // owner/repo
const GITHUB_BRANCH=(process.env.SHAZ_GITHUB_BRANCH||'main').trim();
const githubEnabled=()=>!!(GITHUB_TOKEN&&/^[^/]+\/[^/]+$/.test(GITHUB_REPO)&&GITHUB_BRANCH);

async function ghApi(endpoint,options={}){
  if(!githubEnabled())throw new Error('GitHub kalıcı kayıt ayarları eksik.');
  const r=await fetch(`https://api.github.com/repos/${GITHUB_REPO}${endpoint}`,{
    ...options,
    headers:{
      'Accept':'application/vnd.github+json',
      'Authorization':`Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version':'2022-11-28',
      'User-Agent':'SHAZ-Site',
      ...(options.headers||{})
    }
  });
  const txt=await r.text();
  let data={};
  try{data=txt?JSON.parse(txt):{}}catch{data={message:txt}}
  if(!r.ok)throw new Error(data.message||`GitHub HTTP ${r.status}`);
  return data;
}

async function githubCommitFilesOnce(files,message){
  const ref=await ghApi(`/git/ref/heads/${encodeURIComponent(GITHUB_BRANCH)}`);
  const parentSha=ref.object.sha;
  const parentCommit=await ghApi(`/git/commits/${parentSha}`);
  const tree=[];
  for(const f of files){
    const blob=await ghApi('/git/blobs',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({content:f.content,encoding:f.encoding||'utf-8'})
    });
    tree.push({path:f.path,mode:'100644',type:'blob',sha:blob.sha});
  }
  const newTree=await ghApi('/git/trees',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({base_tree:parentCommit.tree.sha,tree})
  });
  const commit=await ghApi('/git/commits',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({message,tree:newTree.sha,parents:[parentSha]})
  });
  await ghApi(`/git/refs/heads/${encodeURIComponent(GITHUB_BRANCH)}`,{
    method:'PATCH',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({sha:commit.sha,force:false})
  });
  return {ok:true,commit:commit.sha};
}

// Aynı anda fotoğraf + ayar kaydı geldiğinde GitHub dalı ilerleyebilir.
// Yazmaları tek kuyruğa alıp non-fast-forward durumunda güncel HEAD üzerinden tekrar deneriz.
let githubWriteQueue=Promise.resolve();
function githubCommitFiles(files,message){
  if(!githubEnabled())return Promise.resolve({ok:false,skipped:true});
  const run=async()=>{
    let lastErr;
    for(let attempt=1;attempt<=5;attempt++){
      try{return await githubCommitFilesOnce(files,message)}
      catch(e){
        lastErr=e;
        const msg=String(e?.message||e).toLowerCase();
        const retryable=msg.includes('fast forward')||msg.includes('reference update')||msg.includes('conflict')||msg.includes('422');
        if(!retryable||attempt===5)throw e;
        await delay(250*attempt);
      }
    }
    throw lastErr;
  };
  const task=githubWriteQueue.then(run,run);
  githubWriteQueue=task.catch(()=>{});
  return task;
}

async function persistStateToGithub(){
  if(!githubEnabled())return {ok:false,skipped:true};
  const files=['settings.json','catalog.json'].map(name=>({
    path:`data/${name}`,
    content:fs.readFileSync(path.join(dataDir,name),'utf8'),
    encoding:'utf-8'
  }));
  return githubCommitFiles(files,'SHAZ panel: katalog ve site ayarları güncellendi');
}

async function persistOrdersToGithub(){
  if(!githubEnabled())return {ok:false,skipped:true};
  const ordersPath=path.join(dataDir,'orders.json');
  const content=fs.existsSync(ordersPath)?fs.readFileSync(ordersPath,'utf8'):'[]';
  return githubCommitFiles([{path:'data/orders.json',content,encoding:'utf-8'}],'SHAZ sipariş: kalıcı sipariş kaydı güncellendi [skip render]');
}

const ACCOUNT_SNAPSHOT_FILE='account_state.enc';
const ACCOUNT_SNAPSHOT_NAMES=['users.json','customers.json','addresses.json','favorites.json','marketing_consents.json','phone_verifications.json','password_resets.json','coupons.json','new_member_coupon_templates.json','account_login_attempts.json'];
function accountSnapshotKey(){return USER_SESSION_SECRET?crypto.createHash('sha256').update(USER_SESSION_SECRET).digest():null}
function buildEncryptedAccountSnapshot(){
  const key=accountSnapshotKey();if(!key)return '';
  const state={v:1,createdAt:new Date().toISOString(),files:{}};
  for(const name of ACCOUNT_SNAPSHOT_NAMES)state.files[name]=readJson(name,[]);
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),plain=Buffer.from(JSON.stringify(state),'utf8'),enc=Buffer.concat([cipher.update(plain),cipher.final()]),tag=cipher.getAuthTag();
  return JSON.stringify({v:1,iv:iv.toString('base64'),tag:tag.toString('base64'),data:enc.toString('base64'),createdAt:state.createdAt});
}
function restoreEncryptedAccountSnapshot(){
  try{
    const key=accountSnapshotKey(),file=path.join(dataDir,ACCOUNT_SNAPSHOT_FILE);if(!key||!fs.existsSync(file))return false;
    const box=JSON.parse(fs.readFileSync(file,'utf8')),iv=Buffer.from(box.iv,'base64'),tag=Buffer.from(box.tag,'base64'),enc=Buffer.from(box.data,'base64'),decipher=crypto.createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);
    const state=JSON.parse(Buffer.concat([decipher.update(enc),decipher.final()]).toString('utf8'));
    if(!state||state.v!==1||!state.files)return false;
    for(const name of ACCOUNT_SNAPSHOT_NAMES)if(Object.prototype.hasOwnProperty.call(state.files,name))writeJson(name,state.files[name]);
    console.log('SHAZ üyelik verileri şifreli kalıcı kayıttan geri yüklendi.');
    return true;
  }catch(e){console.warn('SHAZ üyelik kalıcı kayıt geri yüklenemedi:',e.message);return false}
}
async function persistAccountStateToGithub(){
  if(!githubEnabled()||!USER_SESSION_SECRET)return {ok:false,skipped:true};
  const content=buildEncryptedAccountSnapshot();if(!content)return {ok:false,skipped:true};
  fs.writeFileSync(path.join(dataDir,ACCOUNT_SNAPSHOT_FILE),content,'utf8');
  return githubCommitFiles([{path:`data/${ACCOUNT_SNAPSHOT_FILE}`,content,encoding:'utf-8'}],'SHAZ üyelik verileri kalıcı kayıt [skip render]');
}
function persistAccountStateAsync(){persistAccountStateToGithub().catch(e=>console.error('Üyelik GitHub kalıcı kayıt:',e))}
const localAccountSnapshotRestored=restoreEncryptedAccountSnapshot();
async function restoreAccountStateFromGithub(){
  if(!githubEnabled()||!USER_SESSION_SECRET)return false;
  try{
    const remote=await ghApi(`/contents/data/${encodeURIComponent(ACCOUNT_SNAPSHOT_FILE)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
    if(!remote||remote.encoding!=='base64'||!remote.content)return false;
    const content=Buffer.from(String(remote.content).replace(/\s+/g,''),'base64').toString('utf8');
    if(!content.trim())return false;
    fs.writeFileSync(path.join(dataDir,ACCOUNT_SNAPSHOT_FILE),content,'utf8');
    return restoreEncryptedAccountSnapshot();
  }catch(e){
    if(!String(e?.message||'').toLowerCase().includes('not found'))console.warn('SHAZ üyelik GitHub kalıcı kayıt geri yüklenemedi:',e.message);
    return false;
  }
}

function nextLocalOrderId(orders){
  let max=0;
  for(const o of (orders||[])){
    const n=Number(String(o?.id||'').replace(/^SHZ/i,''));
    if(Number.isFinite(n))max=Math.max(max,n);
  }
  return 'SHZ'+(max+1);
}

let sheetSyncRunning=false;
let lastSheetSyncInfo={at:'',ok:null,error:'',synced:0,pending:0};
async function syncPendingOrdersToSheets(){
  if(sheetSyncRunning)return {ok:false,busy:true};
  if(!GOOGLE_SHEETS_WEBHOOK_URL || !GOOGLE_SHEETS_SECRET){
    const missing=[!GOOGLE_SHEETS_WEBHOOK_URL?'GOOGLE_SHEETS_WEBHOOK_URL':'',!GOOGLE_SHEETS_SECRET?'GOOGLE_SHEETS_SECRET':''].filter(Boolean).join(', ');
    lastSheetSyncInfo={at:new Date().toISOString(),ok:false,error:'Render Environment eksik: '+missing,synced:0,pending:readJson('orders.json',[]).filter(o=>o.sheetSyncStatus!=='synced').length};
    return lastSheetSyncInfo;
  }
  sheetSyncRunning=true;
  try{
    const orders=readJson('orders.json',[]);
    const dailyDisplayIds=new Map(ordersWithDailyDisplayIds(orders).map(o=>[String(o.id||''),String(o.dailyDisplayId||o.id||'')]));
    let changed=false, syncedNow=0, lastError='';
    for(const order of orders.filter(o=>o.sheetSyncStatus!=='synced').slice().reverse()){
      try{
        const sheetOrder={...order,dailyDisplayId:dailyDisplayIds.get(String(order.id||''))||order.id||''};
        const sheet=await sheetsRequest({action:'create',requestId:order.requestId,order:sheetOrder});
        order.sheetSyncStatus='synced';
        order.sheetSyncedAt=new Date().toISOString();
        order.sheetId=sheet.id||order.id;
        order.sheetSyncError='';
        syncedNow++;
        changed=true;
      }catch(e){
        order.sheetSyncStatus='pending';
        order.sheetSyncError=String(e?.message||e).slice(0,500);
        order.sheetLastTriedAt=new Date().toISOString();
        lastError=order.sheetSyncError;
        changed=true;
      }
    }
    if(changed){
      writeJson('orders.json',orders);
      persistOrdersToGithub().catch(e=>console.error('Sipariş GitHub kalıcı kayıt:',e));
    }
    const pending=orders.filter(o=>o.sheetSyncStatus!=='synced').length;
    lastSheetSyncInfo={at:new Date().toISOString(),ok:pending===0,error:lastError,synced:syncedNow,pending};
    return lastSheetSyncInfo;
  }finally{sheetSyncRunning=false;}
}

const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function sheetsRequest(payload){
  if(!GOOGLE_SHEETS_WEBHOOK_URL || !GOOGLE_SHEETS_SECRET){
    throw new Error('Google E-Tablo bağlantısı yapılandırılmamış.');
  }
  const body=JSON.stringify({...payload,secret:GOOGLE_SHEETS_SECRET});
  let lastErr;
  for(let attempt=1;attempt<=3;attempt++){
    const controller=new AbortController();
    // Apps Script bazen LockService + Sheet yazımı sırasında 10 saniyeyi aşabiliyor.
    // 30 saniye bekliyoruz; aynı requestId tekrar gönderildiğinde Apps Script ikinci sipariş oluşturmaz.
    const timer=setTimeout(()=>controller.abort(),30000);
    try{
      const r=await fetch(GOOGLE_SHEETS_WEBHOOK_URL,{
        method:'POST',
        headers:{'Content-Type':'text/plain;charset=utf-8'},
        body,
        signal:controller.signal,
        redirect:'follow'
      });
      clearTimeout(timer);
      const txt=await r.text();
      let data={};
      try{data=JSON.parse(txt)}catch{}
      if(!r.ok || !data.ok)throw new Error(data.message||`Google E-Tablo HTTP ${r.status}`);
      return data;
    }catch(e){
      clearTimeout(timer);
      lastErr=e;
      if(attempt<3)await delay(900*attempt);
    }
  }
  throw lastErr||new Error('Google E-Tablo kaydı başarısız.');
}

const storage = multer.diskStorage({
 destination:(req,file,cb)=>cb(null,uploadDir),
 filename:(req,file,cb)=>cb(null,Date.now()+'-'+Math.random().toString(36).slice(2,8)+path.extname(file.originalname).toLowerCase())
});
const upload=multer({
 storage,
 limits:{fileSize:20*1024*1024,files:250},
 fileFilter:(req,file,cb)=>{
   const ok=['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype);
   cb(ok?null:new Error('Sadece görsel dosyaları yüklenebilir.'),ok);
 }
});
const customerUpload=multer({
 storage,
 limits:{fileSize:8*1024*1024,files:1},
 fileFilter:(req,file,cb)=>{
   const ok=['image/jpeg','image/png','image/webp'].includes(file.mimetype);
   cb(ok?null:new Error('Lütfen JPG, PNG veya WEBP fotoğraf yükleyin.'),ok);
 }
});

// Kısa, üyelik gerektirmeyen sepet paylaşım bağlantıları.
const sharedCartDir=path.join(dataDir,'shared-carts');fs.mkdirSync(sharedCartDir,{recursive:true});
app.post('/api/shared-cart',(req,res)=>{
  try{const id=crypto.randomBytes(4).toString('hex');fs.writeFileSync(path.join(sharedCartDir,id+'.json'),JSON.stringify(req.body||{}));res.json({ok:true,id});}
  catch(e){res.status(500).json({ok:false})}
});
app.get('/api/shared-cart/:id',(req,res)=>{
  const id=String(req.params.id||'');if(!/^[a-f0-9]{8}$/.test(id))return res.status(404).json({ok:false});
  const f=path.join(sharedCartDir,id+'.json');if(!fs.existsSync(f))return res.status(404).json({ok:false});
  try{res.json({ok:true,cart:JSON.parse(fs.readFileSync(f,'utf8'))})}catch(e){res.status(404).json({ok:false})}
});

app.get('/api/settings',(req,res)=>res.json(readJson('settings.json',{})));
app.get('/api/catalog',(req,res)=>res.json(stripLegacyStockRecords(readJson('catalog.json',{categories:[],products:[],builder:{}}))));

app.post('/api/admin/state',requireAdmin,async(req,res)=>{
  try{
    if(req.body.settings)writeJson('settings.json',req.body.settings);
    if(req.body.catalog)writeJson('catalog.json',stripLegacyStockRecords(req.body.catalog));
    let github={ok:false,skipped:true};
    if(githubEnabled())github=await persistStateToGithub();
    res.json({ok:true,github});
  }catch(e){
    console.error('Kalıcı durum kaydı:',e);
    res.status(500).json({ok:false,message:e.message||'Kayıt başarısız.'});
  }
});
app.post('/api/settings',requireAdmin,(req,res)=>{writeJson('settings.json',req.body);res.json({ok:true})});
app.post('/api/catalog',requireAdmin,(req,res)=>{writeJson('catalog.json',stripLegacyStockRecords(req.body));res.json({ok:true})});
app.get('/api/storage/status',requireAdmin,(req,res)=>res.json({
  githubEnabled:githubEnabled(),repo:githubEnabled()?GITHUB_REPO:'',branch:GITHUB_BRANCH,
  mode:githubEnabled()?'github':'local'
}));
function orderIstanbulDayKey(o){
  try{
    const d=new Date(o?.createdAt||'');
    if(Number.isFinite(d.getTime())){
      const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
      const v=Object.fromEntries(parts.map(x=>[x.type,x.value]));
      if(v.year&&v.month&&v.day)return `${v.year}-${v.month}-${v.day}`;
    }
  }catch(e){}
  const tr=String(o?.createdAtTR||'').trim();
  const m=tr.match(/^(\d{2})[.\/-](\d{2})[.\/-](\d{4})/);
  return m?`${m[3]}-${m[2]}-${m[1]}`:'';
}
function ordersWithDailyDisplayIds(orders){
  const byDay=new Map();
  for(const o of [...(orders||[])].sort((a,b)=>new Date(a?.createdAt||0)-new Date(b?.createdAt||0))){
    const day=orderIstanbulDayKey(o)||'unknown';
    const n=(byDay.get(day)||0)+1;
    byDay.set(day,n);
    o.__dailyDisplayId='SHZ'+n;
  }
  return (orders||[]).map(o=>{
    const dailyDisplayId=o.__dailyDisplayId||o.id||'';
    delete o.__dailyDisplayId;
    return {...o,dailyDisplayId};
  });
}
app.get('/api/orders',requireAdmin,(req,res)=>res.json(ordersWithDailyDisplayIds(readJson('orders.json',[]))));
app.patch('/api/orders/status',requireAdmin,async(req,res)=>{
 const ids=Array.isArray(req.body.ids)?req.body.ids:[]; const status=req.body.status;
 if(!['new','prepared','shipped'].includes(status))return res.status(400).json({ok:false});
 try{
   await sheetsRequest({action:'status',ids,status});
 }catch(e){
   console.error('Google E-Tablo durum güncelleme hatası:',e);
   return res.status(503).json({ok:false,message:'Durum Google E-Tablo’ya kaydedilemedi. Tekrar deneyin.'});
 }
 const orders=readJson('orders.json',[]); const now=new Date().toISOString();
 orders.forEach(o=>{if(ids.includes(o.id)){o.status=status;o.statusUpdatedAt=now;}});
 writeJson('orders.json',orders);res.json({ok:true,orders});
});
app.patch('/api/orders/:id',requireAdmin,(req,res)=>{
  const id=String(req.params.id||'').trim();
  const orders=readJson('orders.json',[]);
  const order=orders.find(o=>String(o.id||'')===id);
  if(!order)return res.status(404).json({ok:false,message:'Sipariş bulunamadı.'});

  const body=req.body&&typeof req.body==='object'?req.body:{};
  const customerPatch=body.customer&&typeof body.customer==='object'?body.customer:{};
  order.customer=(order.customer&&typeof order.customer==='object')?order.customer:{};
  const customerFields=['fullName','phone','extraPhone','province','district','neighborhood','avenue','street','fullAddress','buildingNo','floor','doorNo','businessName','branchName','note','deliveryMode','placeType'];
  for(const key of customerFields){
    if(Object.prototype.hasOwnProperty.call(customerPatch,key))order.customer[key]=String(customerPatch[key]??'').trim();
  }
  if(Object.prototype.hasOwnProperty.call(customerPatch,'phone')){
    const phone=normalizeTRMobile(customerPatch.phone);
    if(!phone)return res.status(400).json({ok:false,message:'Telefon numarası geçersiz.'});
    order.customer.phone=phone;
  }
  if(Object.prototype.hasOwnProperty.call(customerPatch,'extraPhone')){
    const raw=String(customerPatch.extraPhone||'').trim();
    const extra=raw?normalizeTRMobile(raw):'';
    if(raw&&!extra)return res.status(400).json({ok:false,message:'2. telefon numarası geçersiz.'});
    if(extra&&extra===order.customer.phone)return res.status(400).json({ok:false,message:'İki telefon numarası aynı olamaz.'});
    order.customer.extraPhone=extra;
  }

  if(Object.prototype.hasOwnProperty.call(body,'payment')){
    const payment=String(body.payment||'').trim();
    if(payment)order.payment=payment;
  }
  if(Object.prototype.hasOwnProperty.call(body,'total')){
    const total=Number(body.total);
    if(!Number.isFinite(total)||total<0)return res.status(400).json({ok:false,message:'Toplam tutar geçersiz.'});
    order.total=total;
  }
  if(Array.isArray(body.items)){
    body.items.forEach((patch,i)=>{
      const item=order.items?.[i];
      if(!item||!patch||typeof patch!=='object')return;
      item.product=(item.product&&typeof item.product==='object')?item.product:{};
      if(Object.prototype.hasOwnProperty.call(patch,'name'))item.product.name=String(patch.name||'').trim()||item.product.name||'Ürün';
      if(Object.prototype.hasOwnProperty.call(patch,'price')){
        const price=Number(patch.price);
        if(Number.isFinite(price)&&price>=0)item.product.price=price;
      }
      if(Object.prototype.hasOwnProperty.call(patch,'qty')){
        const qty=Math.max(1,Math.floor(Number(patch.qty)||1));
        item.qty=qty;
      }
    });
  }

  writeJson('orders.json',orders);
  persistOrdersToGithub().catch(e=>console.error('Sipariş düzenleme GitHub kalıcı kayıt:',e));
  res.json({ok:true,order});
});
app.delete('/api/orders',requireAdmin,(req,res)=>{
  const ids=Array.isArray(req.body?.ids)?req.body.ids.map(x=>String(x||'').trim()).filter(Boolean):[];
  if(!ids.length)return res.status(400).json({ok:false,message:'Silinecek sipariş seçilmedi.'});
  const idSet=new Set(ids);
  const orders=readJson('orders.json',[]);
  const kept=orders.filter(o=>!idSet.has(String(o.id||'')));
  const removedCount=orders.length-kept.length;
  if(!removedCount)return res.status(404).json({ok:false,message:'Seçili siparişler bulunamadı.'});
  writeJson('orders.json',kept);
  persistOrdersToGithub().catch(e=>console.error('Toplu sipariş silme GitHub kalıcı kayıt:',e));
  res.json({ok:true,removedCount});
});
app.delete('/api/orders/:id',requireAdmin,(req,res)=>{
  const id=String(req.params.id||'').trim();
  const orders=readJson('orders.json',[]);
  const index=orders.findIndex(o=>String(o.id||'')===id);
  if(index<0)return res.status(404).json({ok:false,message:'Sipariş bulunamadı.'});
  const [removed]=orders.splice(index,1);
  writeJson('orders.json',orders);
  persistOrdersToGithub().catch(e=>console.error('Sipariş silme GitHub kalıcı kayıt:',e));
  res.json({ok:true,removedId:removed?.id||id});
});

app.get('/api/orders/export.xlsx',requireAdmin,(req,res)=>{
 const orders=readJson('orders.json',[]);
 const exportNow=new Date();
 const exportAt=exportNow.toISOString();
 const exportAtTR=new Intl.DateTimeFormat('tr-TR',{
   timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit',
   hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false
 }).format(exportNow);

 const payText=o=>{
  const p=String(o.payment||'').toLowerCase();
  if(p==='cod'||p.includes('kapıda')||p.includes('cash'))return 'kapıda nakit';
  if(p.includes('iban')||p.includes('havale')||p.includes('transfer')||p==='online'||p==='bank')return 'havale';
  return p||'';
 };
 const orderProducts=o=>{
  const blocks=[];
  (o.items||[]).forEach(x=>{
    const name=x.product?.name||'Ürün';
    const internalCode=String(x.product?.internalCode||'').trim();
    const title=internalCode?`${name} | ${internalCode}`:name;
    const lines=[title];
    if(x.setCustomization){
      const setItems=Array.isArray(x.product?.setItems)?x.product.setItems:[];
      const keptIds=Array.isArray(x.setCustomization.keptIds)?x.setCustomization.keptIds:[];
      const removedIds=Array.isArray(x.setCustomization.removedIds)?x.setCustomization.removedIds:[];
      const removed=setItems.filter(it=>removedIds.includes(it.id)).map(it=>it.name).filter(Boolean);
      if(removed.length){
        const sent=(keptIds.length?setItems.filter(it=>keptIds.includes(it.id)):setItems.filter(it=>!removedIds.includes(it.id))).map(it=>it.name).filter(Boolean);
        if(sent.length)lines.push(`• Gönderilecek ürünler: ${sent.join(', ')} (Çıkarılan ürünler: ${removed.join(', ')})`);
      }
    }
    const writes=x.writes||x.setCustomization?.writes||[];
    writes.forEach(w=>{
      const item=w.item||name;
      const pos=w.position?` (${w.position})`:'';
      lines.push(`• Yazı — ${item}: “${w.text||''}”${pos}`);
    });
    const photos=x.photoCustomizations||x.setCustomization?.photoCustomizations||[];
    photos.forEach(ph=>{
      const item=ph.item||name;
      const caption=ph.caption?` · Fotoğraf yazısı (${ph.captionPosition==='above'?'üstte':'altta'}): ${ph.caption}`:'';
      lines.push(`• Fotoğraf — ${item}: ${ph.imageUrl||''}${caption}`);
    });
    blocks.push(lines.join('\n'));
  });
  return blocks.join('\n\n')||'Ürün';
 };
 const orderNoteText=o=>{
  const direct=String(o.orderNote||'').trim();
  if(direct)return direct;
  return (o.items||[]).map(x=>String(x.productNote||'').trim()).filter(Boolean).join(' | ');
 };
 const itemCount=o=>(o.items||[]).reduce((n,x)=>n+Math.max(1,Number(x.qty||1)),0)||1;
 const fullAddress=c=>{
  if(c.deliveryMode==='branch') return `ARAS KARGO ŞUBE TESLİM — ${c.branchName||''}`.trim();
  const road=[c.neighborhood,c.avenue,c.street].filter(Boolean).join(' ');
  const nums=[c.buildingNo?`no:${c.buildingNo}`:'',c.floor?`kat:${c.floor}`:'',c.doorNo?`daire:${c.doorNo}`:''].filter(Boolean).join(' ');
  const biz=c.placeType==='business'&&c.businessName?c.businessName:'';
  return [road,c.fullAddress,nums,biz].filter(Boolean).join(' ');
 };

 // İlk satır: Excel'in alınma zamanı.
 // İkinci satır: sütun başlıkları.
 // Her müşteri: 1 başlık + 8 bilgi satırı + 1 ayırıcı satır.
 const aoa=[
   [`Excel'e aktarma tarihi: ${exportAtTR}`,'','','',''],
   ['','SİPARİŞ','ADET','HAZIR MI','KARGOYA VERİLDİ Mİ']
 ];
 const merges=[{s:{r:0,c:0},e:{r:0,c:4}}];
 const rowHeights=[{hpt:24},{hpt:24}];

 orders.forEach((o,idx)=>{
   const c=o.customer||{};
   const blockStart=2+idx*10;
   const headerRow=blockStart;
   const r=blockStart+1; // 8 bilgi satırı burada başlar
   const separatorRow=blockStart+9;
   const details=orderProducts(o);
   const normalNote=orderNoteText(o);
   const deliveryNote=String(c.note||'').trim();
   const combinedNotes=`not: ${normalNote} | teslimat notu: ${deliveryNote}`;
   const detailsWithNotes=`${details}\n\n${combinedNotes}`;

   // Müşteri numarası açıkça görünsün.
   aoa[headerRow]=[
     `${idx+1}. MÜŞTERİ${o.id?` • ${o.id}`:''}`,
     o.createdAtTR||'',
     '',
     '',
     ''
   ];
   merges.push({s:{r:headerRow,c:0},e:{r:headerRow,c:4}});
   rowHeights[headerRow]={hpt:22};

   const left=[
    c.fullName||'',
    Number(normalizeTRMobile(c.phone)||0)||'',
    fullAddress(c),
    [c.province,c.district].filter(Boolean).join(' '),
    `${Number(o.total||0).toLocaleString('tr-TR')} TL`,
    payText(o),
    '@',
    details
   ];

   for(let i=0;i<8;i++){
     aoa[r+i]=[
       left[i],
       i===0?detailsWithNotes:'',
       i===0?itemCount(o):'',
       i===0?(o.status==='prepared'||o.status==='shipped'?'✓':'☐'):'',
       i===0?(o.status==='shipped'?'✓':'☐'):''
     ];
     rowHeights[r+i]={hpt:i===7?34:22};
   }

   merges.push(
     {s:{r,c:1},e:{r:r+7,c:1}},
     {s:{r,c:2},e:{r:r+7,c:2}},
     {s:{r,c:3},e:{r:r+7,c:3}},
     {s:{r,c:4},e:{r:r+7,c:4}}
   );

   // Müşteriler birbirine yapışmasın: araya net bir ayırıcı satır.
   aoa[separatorRow]=['────────────────────────────────','','','',''];
   merges.push({s:{r:separatorRow,c:0},e:{r:separatorRow,c:4}});
   rowHeights[separatorRow]={hpt:10};
 });

 const ws=XLSX.utils.aoa_to_sheet(aoa);
 ws['!merges']=merges;
 ws['!cols']=[{wch:42},{wch:54},{wch:9},{wch:14},{wch:22}];
 ws['!rows']=rowHeights;
 const wb=XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(wb,ws,'Siparişler');
 const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});

 // Bu dosyaya giren siparişlerin hepsini panelde işaretle.
 orders.forEach(o=>{
   o.excelExportedAt=exportAt;
   o.excelExportedAtTR=exportAtTR;
 });
 writeJson('orders.json',orders);

 const stamp=new Intl.DateTimeFormat('sv-SE',{
   timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit',
   hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false
 }).format(exportNow).replace(' ','_').replaceAll(':','-');

 res.setHeader('X-SHAZ-Exported-At',exportAtTR);
 res.setHeader('Content-Disposition',`attachment; filename=SHAZ-Siparisler-${stamp}.xlsx`);
 res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
});
let lastOrderIngress={at:'',requestId:'',ok:null,error:''};
app.get('/api/orders/last-ingress',requireAdmin,(req,res)=>res.json({ok:true,...lastOrderIngress}));

app.post('/api/orders',async(req,res)=>{
 const ingressAt=new Date().toISOString();
 try{
   const orders=readJson('orders.json',[]);
   const clientRequestId=String(req.body?.requestId||'').trim();
   const requestId=clientRequestId||crypto.randomUUID();
   lastOrderIngress={at:ingressAt,requestId,ok:null,error:''};

   // Aynı sipariş tekrar gelirse yeni kayıt açma.
   const existing=orders.find(o=>String(o.requestId||'')===requestId);
   if(existing){
     if(existing.sheetSyncStatus!=='synced')setTimeout(()=>syncPendingOrdersToSheets(),0);
     return res.json({ok:true,order:existing,duplicate:true});
   }

   const now=new Date();
   const createdAt=now.toISOString();
   const createdAtTR=new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(now);
   const body={...(req.body||{})};
   delete body.requestId;
   body.customer={...(body.customer||{})};
   const normalizedPhone=normalizeTRMobile(body.customer.phone);
   const normalizedExtra=body.customer.extraPhone?normalizeTRMobile(body.customer.extraPhone):'';

   if(!Array.isArray(body.items)||!body.items.length||!body.customer?.fullName||!normalizedPhone){
     return res.status(400).json({ok:false,message:'Sipariş bilgileri eksik veya telefon numarası eksik/fazla. Lütfen numarayı kontrol edin.'});
   }
   if(body.customer.extraPhone&&!normalizedExtra){
     return res.status(400).json({ok:false,message:'2. telefon numarası eksik veya fazla. Lütfen numarayı kontrol edin.'});
   }
   if(normalizedExtra&&normalizedExtra===normalizedPhone){
     return res.status(400).json({ok:false,message:'İki telefon numarası aynı olamaz. Lütfen yedek olarak farklı bir telefon numarası girin.'});
   }
   if(body.customer.deliveryMode!=='branch'&&!String(body.customer.avenue||'').trim()&&!String(body.customer.street||'').trim()){
     return res.status(400).json({ok:false,message:'Lütfen cadde veya sokak bilgilerinden en az birini giriniz.'});
   }
   body.customer.phone=normalizedPhone;
   body.customer.extraPhone=normalizedExtra;

   // v153: Üye/misafir aynı sipariş oluşturma mantığını kullanır; yalnız ilişki ve hukuki kayıt eklenir.
   const signedUser=accountUserFromReq(req);
   body.userId=signedUser?.id||null;body.customerId=signedUser?.customerId||null;
   const preCouponTotal=Math.max(0,Number(body.preCouponTotal??body.total??0));
   const couponResult=evaluateOrderCoupons(signedUser?.id||null,body.appliedCouponIds,preCouponTotal);
   if(!couponResult.ok)return res.status(400).json({ok:false,message:couponResult.message});
   body.preCouponTotal=preCouponTotal;body.couponDiscountTotal=couponResult.discount;body.appliedCoupons=couponResult.coupons;body.total=couponResult.total;
   const hasPersonal=(body.items||[]).some(x=>!!x.personalized);
   const legal=body.legalAcceptances&&typeof body.legalAcceptances==='object'?body.legalAcceptances:{};
   if(!legal.preInformation||!legal.distanceSales)return res.status(400).json({ok:false,message:'Lütfen sözleşmeleri onaylayın.'});
   if(hasPersonal&&(!legal.personalization||!legal.personalizationNotice))return res.status(400).json({ok:false,message:'Lütfen kişiselleştirme bilgilerinizi kontrol edip onaylayın.'});
   body.personalizationSnapshots=personalizationSnapshots(body.items);
   const savedOrderAddress=signedUser?saveOrderAddressForUser(signedUser,body.customer):null;
   if(savedOrderAddress)body.customer.savedAddressId=savedOrderAddress.id;

   // Siparişin ana kaydı önce sunucu/panele yapılır. Google E-Tablo geçici olarak cevap vermese bile
   // müşteri siparişi kaybolmaz ve tekrar adres girmek zorunda kalmaz.
   const order={
     id:nextLocalOrderId(orders),createdAt,createdAtTR,status:'new',statusUpdatedAt:createdAt,
     requestId,sheetSyncStatus:'pending',sheetSyncError:'',...body
   };
   orders.unshift(order);
   writeJson('orders.json',orders);
   if(signedUser){
     const coupons=readJson('coupons.json',[]),usedIds=new Set((couponResult.coupons||[]).map(c=>String(c.id)));
     if(usedIds.size){for(const c of coupons){if(c.userId===signedUser.id&&usedIds.has(String(c.id))){c.status='used';c.usedAt=createdAt;c.usedOrderId=order.id;c.updatedAt=createdAt}}writeJson('coupons.json',coupons)}
   }
   const legalRows=readJson('legal_acceptances.json',[]),acceptedAt=new Date().toISOString(),ua=String(req.headers['user-agent']||''),ip=consentIp(req);
   for(const type of ['PRE_INFORMATION','DISTANCE_SALES']){const doc=currentLegalDoc(type);legalRows.push({id:crypto.randomUUID(),orderId:order.id,userId:body.userId||null,customerId:body.customerId||null,legalDocumentType:type,documentVersion:doc?.version||'',documentHash:legalHash(doc),acceptedAt,ipAddress:ip,userAgent:ua})}
   if(hasPersonal){const doc=currentLegalDoc('DISTANCE_SALES');legalRows.push({id:crypto.randomUUID(),orderId:order.id,userId:body.userId||null,customerId:body.customerId||null,legalDocumentType:'PERSONALIZATION_CONFIRMATION',documentVersion:doc?.version||'',documentHash:legalHash(doc),acceptedAt,ipAddress:ip,userAgent:ua});}
   writeJson('legal_acceptances.json',legalRows);

   // Üye sipariş verdiyse üyelik kaydı sipariş commitinden önce aynı GitHub kuyruğuna alınır.
   // Böylece Render'da bir yeniden başlatma olsa bile oturumun bağlı olduğu kullanıcı kaydı kaybolmaz.
   if(signedUser)persistAccountStateAsync();
   // Render yeniden başlasa/deploy olsa da sipariş kaybolmasın diye GitHub'a da kalıcı kopyayı yaz.
   // Bunlar müşteri cevabını bloke etmez; asıl sipariş zaten orders.json'a kaydedildi.
   persistOrdersToGithub().catch(e=>console.error('Sipariş GitHub kalıcı kayıt:',e));
   setTimeout(()=>syncPendingOrdersToSheets(),0);

   lastOrderIngress={at:ingressAt,requestId,ok:true,error:''};
   return res.json({ok:true,order,pendingSheet:true});
 }catch(e){
   console.error('Sipariş yerel kayıt hatası:',e);
   lastOrderIngress={at:ingressAt,requestId:String(req.body?.requestId||''),ok:false,error:String(e?.message||e)};
   return res.status(500).json({ok:false,message:'Sipariş sunucuya kaydedilemedi. Lütfen tekrar deneyin.'});
 }
});

// Yönetim panelinden gerektiğinde Google E-Tablo senkronizasyonunu elle tetikleyebilmek için.
app.get('/api/orders/sync-status',requireAdmin,(req,res)=>{
  const orders=readJson('orders.json',[]);
  const pendingOrders=orders.filter(o=>o.sheetSyncStatus!=='synced');
  const lastError=pendingOrders.find(o=>o.sheetSyncError)?.sheetSyncError||lastSheetSyncInfo.error||'';
  res.json({
    ok:true,
    configured:!!(GOOGLE_SHEETS_WEBHOOK_URL&&GOOGLE_SHEETS_SECRET),
    hasWebhook:!!GOOGLE_SHEETS_WEBHOOK_URL,
    hasSecret:!!GOOGLE_SHEETS_SECRET,
    pending:pendingOrders.length,
    lastError,
    lastSync:lastSheetSyncInfo.at||'',
    webhookHost:(()=>{try{return new URL(GOOGLE_SHEETS_WEBHOOK_URL).host}catch{return ''}})()
  });
});
app.post('/api/orders/sync',requireAdmin,async(req,res)=>{
  try{
    const info=await syncPendingOrdersToSheets();
    const orders=readJson('orders.json',[]);
    const pending=orders.filter(o=>o.sheetSyncStatus!=='synced').length;
    res.json({ok:true,pending,info});
  }catch(e){res.status(500).json({ok:false,message:String(e?.message||e)})}
});
app.post('/api/orders/sheets-test',requireAdmin,async(req,res)=>{
  try{
    if(!GOOGLE_SHEETS_WEBHOOK_URL)throw new Error('Render Environment içinde GOOGLE_SHEETS_WEBHOOK_URL eksik.');
    if(!GOOGLE_SHEETS_SECRET)throw new Error('Render Environment içinde GOOGLE_SHEETS_SECRET eksik.');
    const d=await sheetsRequest({action:'ping'});
    setTimeout(()=>syncPendingOrdersToSheets().catch(()=>{}),0);
    res.json({ok:true,version:d.version||'',sheet:d.sheet||''});
  }catch(e){
    const message=String(e?.message||e);
    if(message.toLocaleLowerCase('tr-TR').includes('geçersiz işlem')){
      return res.status(409).json({ok:false,code:'OLD_APPS_SCRIPT',message:'Render URL ve SECRET Google tarafına ulaşıyor; ancak yayınlanmış Google Apps Script eski sürüm. ZIP içindeki google-apps-script.gs dosyasını Apps Script’e yapıştırıp yeni dağıtım yayınlayın.'});
    }
    res.status(500).json({ok:false,message});
  }
});

app.post('/api/customer-upload',customerUpload.array('files',1),async(req,res)=>{
 try{
   const proto=String(req.headers['x-forwarded-proto']||req.protocol||'https').split(',')[0].trim();
   const origin=proto+'://'+req.get('host');
   const files=(req.files||[]).map(f=>({name:f.originalname,filename:f.filename,url:origin+'/uploads/'+f.filename,path:f.path}));
   if(!files.length)return res.status(400).json({ok:false,message:'Fotoğraf seçilmedi.'});
   // Müşterinin sipariş fotoğrafı Render yeniden başlasa da kaybolmasın diye mevcut GitHub kalıcılığı varsa aynı sisteme yazılır.
   let github={ok:false,skipped:true};
   if(githubEnabled()){
     const f=files[0];
     github=await githubCommitFiles([{path:`uploads/${f.filename}`,content:fs.readFileSync(f.path).toString('base64'),encoding:'base64'}],`SHAZ sipariş: kişiye özel fotoğraf eklendi`);
   }
   res.json({ok:true,files:files.map(({name,url,filename})=>({name,url,filename})),github});
 }catch(e){
   console.error('Müşteri fotoğraf yükleme:',e);
   res.status(500).json({ok:false,message:e.message||'Fotoğraf yüklenemedi.'});
 }
});

app.post('/api/upload',requireAdmin, upload.array('files',250),async(req,res)=>{
 try{
   const files=(req.files||[]).map(f=>({name:f.originalname,filename:f.filename,url:'/uploads/'+f.filename,path:f.path}));
   let github={ok:false,skipped:true};
   if(files.length && githubEnabled()){
     const commitFiles=files.map(f=>({
       path:`uploads/${f.filename}`,
       content:fs.readFileSync(f.path).toString('base64'),
       encoding:'base64'
     }));
     github=await githubCommitFiles(commitFiles,`SHAZ panel: ${files.length} görsel eklendi`);
   }
   res.json({ok:true,files:files.map(({name,url,filename})=>({name,url,filename})),github});
 }catch(e){
   console.error('Fotoğraf kalıcı kayıt:',e);
   res.status(500).json({ok:false,message:e.message||'Fotoğraf yüklenemedi.'});
 }
});

app.get('/api/media',requireAdmin,(req,res)=>{
 try{
   const names=fs.readdirSync(uploadDir).filter(n=>/\.(jpe?g|png|webp|gif)$/i.test(n));
   names.sort((a,b)=>{
     try{return fs.statSync(path.join(uploadDir,b)).mtimeMs-fs.statSync(path.join(uploadDir,a)).mtimeMs}catch{return 0}
   });
   res.json({ok:true,files:names.map(name=>({name,url:'/uploads/'+name}))});
 }catch(e){res.json({ok:true,files:[]})}
});


function base64UrlJson(part){try{return JSON.parse(Buffer.from(String(part||''),'base64url').toString('utf8'))}catch{return null}}
async function googleIdentity(credential){
  if(!GOOGLE_CLIENT_ID)throw new Error('Google ile giriş yapılandırılmadı.');
  const r=await fetch('https://oauth2.googleapis.com/tokeninfo?id_token='+encodeURIComponent(String(credential||'')));const j=await r.json();
  if(!r.ok||j.aud!==GOOGLE_CLIENT_ID||!j.email||j.email_verified==='false')throw new Error('Google hesabı doğrulanamadı.');
  return {sub:String(j.sub||''),email:normalizeEmail(j.email),firstName:String(j.given_name||''),lastName:String(j.family_name||''),provider:'google'};
}
let appleKeysCache={at:0,keys:[]};
async function appleKeys(){if(Date.now()-appleKeysCache.at<6*60*60*1000&&appleKeysCache.keys.length)return appleKeysCache.keys;const r=await fetch('https://appleid.apple.com/auth/keys');const j=await r.json();if(!r.ok||!Array.isArray(j.keys))throw new Error('Apple doğrulama anahtarları alınamadı.');appleKeysCache={at:Date.now(),keys:j.keys};return j.keys}
async function appleIdentity(token){
  if(!APPLE_CLIENT_ID)throw new Error('Apple ile giriş yapılandırılmadı.');const parts=String(token||'').split('.');if(parts.length!==3)throw new Error('Apple oturum bilgisi geçersiz.');const head=base64UrlJson(parts[0]),payload=base64UrlJson(parts[1]);if(!head||!payload)throw new Error('Apple oturum bilgisi geçersiz.');
  const keys=await appleKeys(),jwk=keys.find(k=>k.kid===head.kid);if(!jwk)throw new Error('Apple imza anahtarı bulunamadı.');const key=crypto.createPublicKey({key:jwk,format:'jwk'}),ok=crypto.verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),key,Buffer.from(parts[2],'base64url'));if(!ok)throw new Error('Apple hesabı doğrulanamadı.');
  if(payload.iss!=='https://appleid.apple.com'||payload.aud!==APPLE_CLIENT_ID||Number(payload.exp||0)*1000<Date.now()||!payload.sub)throw new Error('Apple oturumu geçersiz veya süresi dolmuş.');
  return {sub:String(payload.sub),email:normalizeEmail(payload.email||''),firstName:'',lastName:'',provider:'apple'};
}
function socialLoginUser(identity,extra={}){
  const users=readJson('users.json',[]);let u=users.find(x=>(x.socialIds&&x.socialIds[identity.provider]===identity.sub)||(identity.email&&x.email===identity.email));const now=new Date().toISOString();let created=false;
  if(!u){if(!identity.email)throw new Error('Hesap e-postası alınamadı.');const id='USR-'+crypto.randomUUID(),customerId='CUS-'+crypto.randomUUID();u={id,customerId,firstName:String(extra.firstName||identity.firstName||'').trim()||'SHAZ',lastName:String(extra.lastName||identity.lastName||'').trim(),email:identity.email,phone:'',birthDate:'',phoneVerifiedAt:null,passwordSalt:'',passwordHash:'',authVersion:1,authProviders:['password'],socialIds:{},smsMarketingConsent:false,emailMarketingConsent:false,authProviders:[identity.provider],socialIds:{[identity.provider]:identity.sub},createdAt:now,updatedAt:now,disabled:false};users.push(u);writeJson('users.json',users);const customers=readJson('customers.json',[]);customers.push({id:customerId,userId:id,firstName:u.firstName,lastName:u.lastName,email:u.email,phone:'',createdAt:now,updatedAt:now});writeJson('customers.json',customers);created=true}else{if(u.disabled)throw new Error('Bu üyelik yönetim tarafından iptal edilmiş.');u.authProviders=Array.from(new Set([...(u.authProviders||[]),identity.provider]));u.socialIds={...(u.socialIds||{}),[identity.provider]:identity.sub};if(!u.firstName&&extra.firstName)u.firstName=String(extra.firstName);if(!u.lastName&&extra.lastName)u.lastName=String(extra.lastName);u.updatedAt=now;writeJson('users.json',users)}
  if(created)assignNewMemberCoupons(u.id,now);return u;
}
async function sendPasswordResetMail(email,link){if(!RESEND_API_KEY)return false;const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:PASSWORD_RESET_FROM,to:[email],subject:'SHAZ Şifre Sıfırlama',html:`<p>SHAZ hesabınızın şifresini yenilemek için aşağıdaki bağlantıyı kullanın.</p><p><a href="${link}">Şifremi yenile</a></p><p>Bu bağlantı 30 dakika geçerlidir.</p>`})});return r.ok}
async function sendAccountEmailVerificationMail(email,link){if(!RESEND_API_KEY)return false;const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:PASSWORD_RESET_FROM,to:[email],subject:'SHAZ E-posta Değişikliği Doğrulama',html:`<p>SHAZ hesabınızda yeni e-posta adresini doğrulamak için aşağıdaki bağlantıya tıklayın.</p><p><a href="${link}">Yeni e-posta adresimi doğrula</a></p><p>Bu bağlantı 30 dakika geçerlidir. Siz istemediyseniz bu e-postayı dikkate almayın.</p>`})});return r.ok}

// ---------- v153 hukuki metin yönetimi (mevcut admin içinde minimum ekran) ----------
function adminMemberRows(){
  const users=readJson('users.json',[]),addresses=readJson('addresses.json',[]),orders=readJson('orders.json',[]),coupons=readJson('coupons.json',[]);
  return users.map(u=>{
    const userAddresses=addresses.filter(a=>a.userId===u.id).map(a=>({...a,phone:normalizeAccountPhone(a.phone)||a.phone||'',extraPhone:normalizeAccountPhone(a.extraPhone)||a.extraPhone||''}));
    const primary=userAddresses.find(a=>a.isDefault)||userAddresses[0]||{},userCoupons=coupons.filter(c=>c.userId===u.id).map(c=>({...c}));
    return {id:u.id,customerId:u.customerId,firstName:u.firstName||'',lastName:u.lastName||'',email:u.email||'',phone:normalizeAccountPhone(u.phone)||u.phone||'',birthDate:u.birthDate||'',phoneVerifiedAt:u.phoneVerifiedAt||null,smsMarketingConsent:!!u.smsMarketingConsent,emailMarketingConsent:!!u.emailMarketingConsent,disabled:!!u.disabled,disabledAt:u.disabledAt||null,authProviders:Array.isArray(u.authProviders)?u.authProviders:(u.passwordHash?['password']:[]),createdAt:u.createdAt||'',addressCount:userAddresses.length,orderCount:orders.filter(o=>o.userId===u.id||o.customerId===u.customerId).length,couponCount:userCoupons.length,coupons:userCoupons,profileChangeHistory:Array.isArray(u.profileChangeHistory)?u.profileChangeHistory:[],province:primary.province||'',district:primary.district||'',address:[primary.neighborhood,primary.avenue,primary.street,primary.fullAddress,primary.buildingNo?`Bina ${primary.buildingNo}`:'',primary.floor?`Kat ${primary.floor}`:'',primary.doorNo?`Daire ${primary.doorNo}`:''].filter(Boolean).join(' · '),addresses:userAddresses};
  });
}
function filterAdminMembers(rows,q={}){
  const search=String(q.search||'').trim().toLocaleLowerCase('tr-TR'),province=String(q.province||'').trim().toLocaleLowerCase('tr-TR'),district=String(q.district||'').trim().toLocaleLowerCase('tr-TR'),sms=String(q.sms||''),emailMarketing=String(q.emailMarketing||''),provider=String(q.provider||'').trim().toLowerCase(),dateFrom=String(q.dateFrom||'').trim(),dateTo=String(q.dateTo||'').trim();
  const fromTs=dateFrom?new Date(dateFrom+'T00:00:00').getTime():0,toTs=dateTo?new Date(dateTo+'T23:59:59.999').getTime():0;
  let out=rows.filter(u=>{const hay=[u.firstName,u.lastName,u.email,u.phone,u.province,u.district,u.address].join(' ').toLocaleLowerCase('tr-TR');const providers=(u.authProviders||[]).map(x=>String(x).toLowerCase()),createdTs=new Date(u.createdAt||0).getTime();return (!search||hay.includes(search))&&(!province||String(u.province||'').toLocaleLowerCase('tr-TR')===province)&&(!district||String(u.district||'').toLocaleLowerCase('tr-TR')===district)&&(!sms||String(!!u.smsMarketingConsent)===sms)&&(!emailMarketing||String(!!u.emailMarketingConsent)===emailMarketing)&&(!provider||providers.includes(provider))&&(!fromTs||createdTs>=fromTs)&&(!toTs||createdTs<=toTs)});
  const sort=String(q.sort||'newest');
  out.sort((a,b)=>sort==='name'?`${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`,'tr'):sort==='orders'?Number(b.orderCount||0)-Number(a.orderCount||0):sort==='province'?`${a.province} ${a.district}`.localeCompare(`${b.province} ${b.district}`,'tr'):new Date(b.createdAt||0)-new Date(a.createdAt||0));
  return out;
}
app.get('/api/admin/users',requireAdmin,(req,res)=>res.json({ok:true,users:adminMemberRows()}));
app.get('/api/admin/users/export.xlsx',requireAdmin,(req,res)=>{
  const rows=filterAdminMembers(adminMemberRows(),req.query).map(u=>({
    'Ad Soyad':[u.firstName,u.lastName].filter(Boolean).join(' '),'Telefon':u.phone,'E-posta':u.email,'Doğum Tarihi':u.birthDate,'İl':u.province,'İlçe':u.district,'Adres':u.address,'Tüm Adresler':(u.addresses||[]).map(a=>[a.title,a.fullName,a.phone,a.province,a.district,a.neighborhood,a.avenue,a.street,a.fullAddress,a.buildingNo?`Bina ${a.buildingNo}`:'',a.floor?`Kat ${a.floor}`:'',a.doorNo?`Daire ${a.doorNo}`:''].filter(Boolean).join(' · ')).join(' | '),'Toplam Sipariş':u.orderCount,'Üyelik Tarihi':u.createdAt,'SMS İzni':u.smsMarketingConsent?'Açık':'Kapalı','E-posta İzni':u.emailMarketingConsent?'Açık':'Kapalı','Giriş Yöntemi':(u.authProviders||[]).join(', ')
  }));
  const wb=XLSX.utils.book_new(),ws=XLSX.utils.json_to_sheet(rows);XLSX.utils.book_append_sheet(wb,ws,'Üyeler');
  const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename="SHAZ-Uyeler.xlsx"');res.send(buf);
});
function normalizeAdminCouponInput(body,current={}){
  const code=String(body.code??current.code??'').trim().toUpperCase().replace(/\s+/g,''),discountType=String(body.discountType??current.discountType??'percent')==='fixed'?'fixed':'percent';
  const value=Number(body.value??current.value??0),expiresAt=String((body.expiresAt ?? couponExpiryDateKey(current.expiresAt) ?? '')).trim(),title=String(body.title??current.title??'').trim(),headline=String(body.headline??current.headline??'').trim();
  const minRaw=body.minCartAmount??current.minCartAmount??'',minCartAmount=String(minRaw).trim()===''?0:Number(minRaw);
  const requestedStackable=String(body.stackable??(current.stackable?'yes':'no'))==='yes'||body.stackable===true,stackable=discountType==='percent'?false:requestedStackable;
  const maxRaw=body.maxDiscountAmount??current.maxDiscountAmount??'',maxDiscountAmount=discountType==='percent'&&String(maxRaw).trim()!==''?Number(maxRaw):0;
  if(!/^[A-Z0-9_-]{3,32}$/.test(code))throw new Error('Kupon kodu 3-32 karakter olmalı; harf, rakam, _ veya - kullanın.');
  if(!Number.isFinite(value)||value<=0||(discountType==='percent'&&value>100))throw new Error('Geçerli bir indirim değeri girin.');
  if(!Number.isFinite(minCartAmount)||minCartAmount<0)throw new Error('Minimum sepet tutarı geçerli değil.');
  if(discountType==='percent'&&(!Number.isFinite(maxDiscountAmount)||maxDiscountAmount<0))throw new Error('Maksimum indirim tutarı geçerli değil.');
  if(expiresAt&&!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt))throw new Error('Son kullanma tarihi geçerli değil.');
  if(expiresAt&&expiresAt<istanbulDateKey())throw new Error('Geçmiş bir tarihe kupon tanımlanamaz. Son kullanma tarihi bugün veya daha ileri bir tarih olmalı.');
  return {code,discountType,value,expiresAt,title,headline,minCartAmount,stackable,maxDiscountAmount};
}

function newMemberCouponTemplates(){return readJson('new_member_coupon_templates.json',[])}
function dateKeyAddDays(key,days){const m=String(key||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return '';const d=new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3])+Number(days||0)));return d.toISOString().slice(0,10)}
function normalizeNewMemberCouponInput(body,current={}){const base=normalizeAdminCouponInput({...body,expiresAt:''},{...current,expiresAt:''}),validityDays=Math.max(1,Math.min(3650,Math.floor(Number(body.validityDays??current.validityDays??7)||0)));if(!validityDays)throw new Error('Kupon kullanım süresi en az 1 gün olmalı.');return {...base,expiresAt:'',validityDays}}
function assignNewMemberCoupons(userId,now=new Date().toISOString()){
  const templates=newMemberCouponTemplates().filter(t=>t&&t.enabled!==false);
  if(!templates.length)return [];
  const coupons=readJson('coupons.json',[]),created=[],startKey=istanbulDateKey(new Date(now));
  for(const t of templates){const validityDays=Math.max(1,Math.floor(Number(t.validityDays||7))),expiresAt=dateKeyAddDays(startKey,validityDays-1);const c={id:'CPN-'+crypto.randomUUID(),userId,code:t.code,discountType:t.discountType,value:Number(t.value||0),expiresAt,title:t.title||'',headline:t.headline||'',minCartAmount:Number(t.minCartAmount||0),stackable:!!t.stackable,maxDiscountAmount:Number(t.maxDiscountAmount||0),status:'active',source:'new-member-auto',templateId:t.id,validityDays,createdAt:now,updatedAt:now};coupons.push(c);created.push(c)}
  writeJson('coupons.json',coupons);return created;
}
app.get('/api/admin/new-member-coupons',requireAdmin,(req,res)=>res.json({ok:true,templates:newMemberCouponTemplates()}));
app.post('/api/admin/new-member-coupons',requireAdmin,(req,res)=>{let data;try{data=normalizeNewMemberCouponInput(req.body)}catch(e){return res.status(400).json({ok:false,message:e.message})}const rows=newMemberCouponTemplates(),now=new Date().toISOString(),row={id:'NMC-'+crypto.randomUUID(),...data,enabled:true,createdAt:now,updatedAt:now};rows.push(row);writeJson('new_member_coupon_templates.json',rows);persistAccountStateAsync();res.json({ok:true,template:row})});
app.patch('/api/admin/new-member-coupons/:id',requireAdmin,(req,res)=>{const rows=newMemberCouponTemplates(),i=rows.findIndex(x=>String(x.id)===String(req.params.id));if(i<0)return res.status(404).json({ok:false,message:'Otomatik kupon bulunamadı.'});let data;try{data=normalizeNewMemberCouponInput(req.body,rows[i])}catch(e){return res.status(400).json({ok:false,message:e.message})}rows[i]={...rows[i],...data,enabled:req.body.enabled===undefined?rows[i].enabled:req.body.enabled!==false,updatedAt:new Date().toISOString()};writeJson('new_member_coupon_templates.json',rows);persistAccountStateAsync();res.json({ok:true,template:rows[i]})});
app.delete('/api/admin/new-member-coupons/:id',requireAdmin,(req,res)=>{const rows=newMemberCouponTemplates(),i=rows.findIndex(x=>String(x.id)===String(req.params.id));if(i<0)return res.status(404).json({ok:false,message:'Otomatik kupon bulunamadı.'});rows.splice(i,1);writeJson('new_member_coupon_templates.json',rows);persistAccountStateAsync();res.json({ok:true})});
app.post('/api/admin/users/coupons',requireAdmin,(req,res)=>{
  const userIds=Array.isArray(req.body.userIds)?[...new Set(req.body.userIds.map(x=>String(x||'').trim()).filter(Boolean))]:[];
  if(!userIds.length)return res.status(400).json({ok:false,message:'Lütfen en az bir üye seçin.'});
  let data;try{data=normalizeAdminCouponInput(req.body)}catch(e){return res.status(400).json({ok:false,message:e.message})}
  const validUsers=new Set(readJson('users.json',[]).map(u=>String(u.id))),targetIds=userIds.filter(id=>validUsers.has(id));if(!targetIds.length)return res.status(404).json({ok:false,message:'Seçilen üyeler bulunamadı.'});
  const coupons=readJson('coupons.json',[]),now=new Date().toISOString();for(const userId of targetIds)coupons.push({id:'CPN-'+crypto.randomUUID(),userId,...data,expiresAt:data.expiresAt||'',status:'active',createdAt:now,updatedAt:now});
  writeJson('coupons.json',coupons);persistAccountStateAsync();res.json({ok:true,assigned:targetIds.length,code:data.code});
});
app.patch('/api/admin/coupons/:id',requireAdmin,(req,res)=>{
  const coupons=readJson('coupons.json',[]),i=coupons.findIndex(c=>String(c.id)===String(req.params.id));if(i<0)return res.status(404).json({ok:false,message:'Kupon bulunamadı.'});
  let data;try{data=normalizeAdminCouponInput(req.body,coupons[i])}catch(e){return res.status(400).json({ok:false,message:e.message})}
  coupons[i]={...coupons[i],...data,expiresAt:data.expiresAt||'',updatedAt:new Date().toISOString()};writeJson('coupons.json',coupons);persistAccountStateAsync();res.json({ok:true,coupon:coupons[i]});
});
app.delete('/api/admin/coupons/:id',requireAdmin,(req,res)=>{
  const coupons=readJson('coupons.json',[]),i=coupons.findIndex(c=>String(c.id)===String(req.params.id));if(i<0)return res.status(404).json({ok:false,message:'Kupon bulunamadı.'});
  coupons.splice(i,1);writeJson('coupons.json',coupons);persistAccountStateAsync();res.json({ok:true});
});
app.post('/api/admin/users/:id/cancel',requireAdmin,(req,res)=>{
  const users=readJson('users.json',[]),i=users.findIndex(u=>String(u.id)===String(req.params.id));if(i<0)return res.status(404).json({ok:false,message:'Üye bulunamadı.'});
  const u=users[i];if(u.disabled)return res.json({ok:true,alreadyDisabled:true});const now=new Date().toISOString();pushProfileHistory(u,'Üyelik Durumu','Aktif','İptal Edildi','admin');u.disabled=true;u.disabledAt=now;u.updatedAt=now;u.authVersion=Number(u.authVersion||1)+1;writeJson('users.json',users);persistAccountStateAsync();res.json({ok:true});
});
app.patch('/api/admin/users/:id/profile',requireAdmin,(req,res)=>{
  const users=readJson('users.json',[]),i=users.findIndex(u=>String(u.id)===String(req.params.id));if(i<0)return res.status(404).json({ok:false,message:'Üye bulunamadı.'});
  const u=users[i],birthDate=String(req.body.birthDate||'').trim();if(!validBirthDateIso(birthDate))return res.status(400).json({ok:false,message:'Geçerli bir doğum tarihi girin.'});
  pushProfileHistory(u,'Doğum Tarihi',u.birthDate||'',birthDate,'admin');u.birthDate=birthDate;u.updatedAt=new Date().toISOString();writeJson('users.json',users);persistAccountStateAsync();res.json({ok:true,user:publicUser(u)});
});
app.get('/api/admin/legal-documents',requireAdmin,(req,res)=>res.json({ok:true,documents:readLegalDocuments().filter(d=>d.active!==false)}));
app.put('/api/admin/legal-documents',requireAdmin,(req,res)=>{
  const incoming=Array.isArray(req.body.documents)?req.body.documents:[],allowed=new Set(['MEMBERSHIP','KVKK','PRIVACY','COOKIE','PRE_INFORMATION','DISTANCE_SALES']);
  const stored=readLegalDocuments(),accepts=readJson('legal_acceptances.json',[]),now=new Date().toISOString();
  const nextVersion=(type,requested)=>{const numeric=Number(requested);if(Number.isInteger(numeric)&&numeric>=0){let n=numeric+1;while(stored.some(x=>x.type===type&&String(x.version)===String(n)))n++;return String(n)}let n=2,v=`${requested}.${n}`;while(stored.some(x=>x.type===type&&String(x.version)===v)){n++;v=`${requested}.${n}`}return v};
  for(const d of incoming.filter(d=>allowed.has(String(d.type||'')))){
    const type=String(d.type),requestedVersion=String(d.version||'1').trim()||'1',title=String(d.title||'').trim(),content=String(d.content||''),active=true;
    let version=requestedVersion;const same=stored.find(x=>x.type===type&&String(x.version||'')===requestedVersion);const accepted=accepts.some(a=>a.legalDocumentType===type&&String(a.documentVersion||'')===requestedVersion);const changed=!!same&&(String(same.content||'')!==content||String(same.title||'')!==title);
    stored.forEach(x=>{if(x.type===type)x.active=false});
    if(same&&accepted&&changed){version=nextVersion(type,requestedVersion);stored.push({type,version,title,content,active,effectiveAt:now,createdAt:now,updatedAt:now})}
    else if(same){same.title=title;same.content=content;same.active=active;same.updatedAt=now;if(!same.effectiveAt)same.effectiveAt=now}
    else stored.push({type,version,title,content,active,effectiveAt:now,createdAt:now,updatedAt:now});
  }
  writeJson('legal_documents.json',stored);writeJson('legal_documents_backup.json',stored);res.json({ok:true,documents:stored.filter(d=>d.active!==false)});
});

// ---------- v153 müşteri auth/account API ----------
app.get('/api/legal-documents',(req,res)=>res.json({ok:true,documents:readLegalDocuments().filter(d=>d.active!==false).map(d=>({type:d.type,version:d.version,title:d.title,content:d.content||'',active:d.active!==false}))}));
app.get('/api/auth/social-config',(req,res)=>res.json({ok:true,googleClientId:GOOGLE_CLIENT_ID||'',appleClientId:APPLE_CLIENT_ID||'',appleRedirectUri:APPLE_REDIRECT_URI||'',passwordResetEnabled:!!RESEND_API_KEY}));
app.post('/api/auth/social/google',sameOriginGuard,async(req,res)=>{try{const identity=await googleIdentity(req.body.credential);const u=socialLoginUser(identity);persistAccountStateAsync();setUserSession(res,u,req);res.json({ok:true,user:publicUser(u)})}catch(e){res.status(401).json({ok:false,message:e.message||'Google ile giriş tamamlanamadı.'})}});
app.post('/api/auth/social/apple',sameOriginGuard,async(req,res)=>{try{const identity=await appleIdentity(req.body.identityToken);const u=socialLoginUser(identity,{firstName:req.body.firstName,lastName:req.body.lastName});persistAccountStateAsync();setUserSession(res,u,req);res.json({ok:true,user:publicUser(u)})}catch(e){res.status(401).json({ok:false,message:e.message||'Apple ile giriş tamamlanamadı.'})}});
app.post('/api/auth/forgot-password',sameOriginGuard,async(req,res)=>{
  const identifier=String(req.body.identifier??req.body.email??'').trim(),email=normalizeEmail(identifier),phone=normalizeAccountPhone(identifier),users=readJson('users.json',[]),u=users.find(x=>(email.includes('@')&&x.email===email)||(phone&&normalizeAccountPhone(x.phone)===phone));
  if(!identifier)return res.status(400).json({ok:false,message:'E-posta adresinizi veya telefon numaranızı girin.'});
  const generic='Bilgileriniz bir hesapla eşleşiyorsa şifre sıfırlama bağlantısı kayıtlı e-posta adresinize gönderildi.';
  if(!u)return res.json({ok:true,message:generic});
  if(!RESEND_API_KEY)return res.status(503).json({ok:false,message:'Şifre sıfırlama e-posta servisi henüz yapılandırılmadı.'});
  const raw=crypto.randomBytes(32).toString('base64url'),hash=crypto.createHash('sha256').update(raw).digest('hex'),arr=readJson('password_resets.json',[]).filter(x=>x.userId!==u.id&&new Date(x.expiresAt).getTime()>Date.now());arr.push({id:crypto.randomUUID(),userId:u.id,tokenHash:hash,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30*60*1000).toISOString(),usedAt:null});writeJson('password_resets.json',arr);const sent=await sendPasswordResetMail(u.email,`${PUBLIC_BASE_URL}/sifre-sifirla?token=${encodeURIComponent(raw)}`);if(!sent)return res.status(502).json({ok:false,message:'Şifre sıfırlama e-postası gönderilemedi.'});res.json({ok:true,message:generic})
});
app.post('/api/auth/reset-password',sameOriginGuard,(req,res)=>{const raw=String(req.body.token||''),password=String(req.body.password||'');if(password.length<8)return res.status(400).json({ok:false,message:'Yeni şifre en az 8 karakter olmalıdır.'});const hash=crypto.createHash('sha256').update(raw).digest('hex'),arr=readJson('password_resets.json',[]),x=arr.find(v=>v.tokenHash===hash&&!v.usedAt&&new Date(v.expiresAt).getTime()>Date.now());if(!x)return res.status(400).json({ok:false,message:'Şifre sıfırlama bağlantısı geçersiz veya süresi dolmuş.'});const users=readJson('users.json',[]),i=users.findIndex(u=>u.id===x.userId);if(i<0)return res.status(400).json({ok:false,message:'Hesap bulunamadı.'});const ph=passwordHash(password);users[i].passwordSalt=ph.salt;users[i].passwordHash=ph.hash;users[i].authVersion=Number(users[i].authVersion||1)+1;users[i].authProviders=Array.from(new Set([...(users[i].authProviders||[]),'password']));users[i].updatedAt=new Date().toISOString();x.usedAt=users[i].updatedAt;writeJson('users.json',users);writeJson('password_resets.json',arr);persistAccountStateAsync();res.json({ok:true})});

app.get(['/giris','/kayit','/sifre-sifirla','/hesabim','/hesabim/siparisler','/hesabim/bilgiler','/hesabim/adresler','/hesabim/favoriler','/hesabim/kuponlar','/hesabim/sifre'],(req,res)=>{res.setHeader('X-Robots-Tag','noindex, nofollow');res.sendFile(path.join(root,'public','index.html'))});
app.get('/hesabim/siparisler/:id',(req,res)=>{res.setHeader('X-Robots-Tag','noindex, nofollow');res.sendFile(path.join(root,'public','index.html'))});
app.post('/api/auth/register',sameOriginGuard,(req,res)=>{
  if(!USER_SESSION_SECRET)return res.status(503).json({ok:false,message:'Üyelik oturum anahtarı sunucuda yapılandırılmadı.'});
  const firstName=String(req.body.firstName||'').trim(),lastName=String(req.body.lastName||'').trim(),email=normalizeEmail(req.body.email),phone=normalizeAccountPhone(req.body.phone),password=String(req.body.password||''),birthDate=String(req.body.birthDate||'').trim();
  if(!firstName||!lastName||!email||!phone||!birthDate||password.length<8)return res.status(400).json({ok:false,message:!birthDate?'Doğum tarihi zorunludur.':!phone?'Lütfen geçerli bir telefon numarası girin.':!email.includes('@')?'Lütfen geçerli bir e-posta adresi girin.':'Lütfen tüm zorunlu alanları doldurun ve en az 8 karakterli şifre kullanın.'});
  if(!validBirthDateIso(birthDate))return res.status(400).json({ok:false,message:'Doğum tarihini gg.aa.yyyy biçiminde geçerli olarak girin.'});
  const users=readJson('users.json',[]);if(users.some(u=>u.email===email))return res.status(409).json({ok:false,message:'Bu e-posta adresiyle daha önce hesap oluşturulmuş.'});if(users.some(u=>normalizeAccountPhone(u.phone)===phone))return res.status(409).json({ok:false,message:'Bu telefon numarasıyla daha önce hesap oluşturulmuş.'});
  if(PHONE_VERIFICATION_REQUIRED)return res.status(503).json({ok:false,message:'Telefon doğrulama özelliği etkin ancak SMS sağlayıcısı henüz canlı kullanıma açılmadı.'});
  const now=new Date().toISOString(),id='USR-'+crypto.randomUUID(),customerId='CUS-'+crypto.randomUUID(),ph=passwordHash(password);
  const user={id,customerId,firstName,lastName,email,phone,birthDate,phoneVerifiedAt:null,passwordSalt:ph.salt,passwordHash:ph.hash,authVersion:1,authProviders:['password'],socialIds:{},smsMarketingConsent:!!req.body.smsMarketingConsent,emailMarketingConsent:!!req.body.emailMarketingConsent,createdAt:now,updatedAt:now,disabled:false};users.push(user);writeJson('users.json',users);
  const customers=readJson('customers.json',[]);customers.push({id:customerId,userId:id,firstName,lastName,email,phone,createdAt:now,updatedAt:now});writeJson('customers.json',customers);
  // Eski siparişleri yalnız telefon + e-posta birlikte aynıysa bağla; yalnız isim/telefon ile otomatik eşleştirme yapma.
  const oldOrders=readJson('orders.json',[]);let linked=false;for(const o of oldOrders){const oe=normalizeEmail(o?.customer?.email||'');const op=normalizeAccountPhone(o?.customer?.phone||'');if(oe&&oe===email&&op&&op===phone&&!o.userId){o.userId=id;o.customerId=customerId;linked=true}}if(linked)writeJson('orders.json',oldOrders);
  const cons=readJson('marketing_consents.json',[]);for(const [channel,value] of [['sms',!!req.body.smsMarketingConsent],['email',!!req.body.emailMarketingConsent]])cons.push({id:crypto.randomUUID(),userId:id,channel,granted:value,at:now,source:'registration',textVersion:'1',ip:consentIp(req),userAgent:String(req.headers['user-agent']||'')});writeJson('marketing_consents.json',cons);
  assignNewMemberCoupons(id,now);
  persistAccountStateAsync();setUserSession(res,user,req);res.json({ok:true,user:publicUser(user)});
});
app.post('/api/auth/login',sameOriginGuard,(req,res)=>{const login=String(req.body.login??req.body.email??'').trim(),attemptKey=accountLoginAttemptKey(req),attempt=accountAttemptState(attemptKey);if(Number(attempt.blockedUntil||0)>Date.now())return res.status(429).json({ok:false,message:accountBlockedMessage(attemptKey),remainingAttempts:0});const email=normalizeEmail(login),phone=normalizeAccountPhone(login),users=readJson('users.json',[]),u=users.find(x=>x.email===email||(phone&&normalizeAccountPhone(x.phone)===phone));if(!u||!passwordMatches(req.body.password,u)){const remaining=accountFailKey(attemptKey);if(remaining<=0)return res.status(429).json({ok:false,message:accountBlockedMessage(attemptKey),remainingAttempts:0});return res.status(401).json({ok:false,message:`E-posta/telefon veya şifre hatalı. ${remaining} hakkınız kaldı.`,remainingAttempts:remaining})}if(u.disabled)return res.status(403).json({ok:false,message:'Bu üyelik yönetim tarafından iptal edilmiş.'});clearAccountLoginAttempts(attemptKey);setUserSession(res,u,req);res.json({ok:true,user:publicUser(u)})});
app.post('/api/auth/logout',sameOriginGuard,(req,res)=>{clearUserSession(res,req);res.json({ok:true})});
app.get('/api/auth/me',(req,res)=>{const u=accountUserFromReq(req);res.json({ok:true,authenticated:!!u,user:publicUser(u)})});
app.patch('/api/account/profile',sameOriginGuard,requireUser,async(req,res)=>{
  const users=readJson('users.json',[]),i=users.findIndex(x=>x.id===req.accountUser.id),u=users[i],now=new Date().toISOString(),meta=profileChangeMeta(u);
  const email=normalizeEmail(req.body.email),phone=normalizeAccountPhone(req.body.phone),firstName=String(req.body.firstName||'').trim(),lastName=String(req.body.lastName||'').trim(),birthDate=String(req.body.birthDate||'').trim();
  if(!firstName||!lastName)return res.status(400).json({ok:false,message:'Ad ve soyad zorunludur.'});if(!email.includes('@'))return res.status(400).json({ok:false,message:'Lütfen geçerli bir e-posta adresi girin.'});if(!phone)return res.status(400).json({ok:false,message:'Lütfen geçerli bir telefon numarası girin.'});if(!validBirthDateIso(birthDate))return res.status(400).json({ok:false,message:'Doğum tarihi zorunludur ve geçerli olmalıdır.'});
  const nameChanged=firstName!==String(u.firstName||'')||lastName!==String(u.lastName||''),phoneChanged=phone!==normalizeAccountPhone(u.phone),emailChanged=email!==normalizeEmail(u.email),birthChanged=birthDate!==String(u.birthDate||'');
  if(nameChanged){const wait=profileWaitMs(meta.nameChangedAt,PROFILE_NAME_COOLDOWN_MS);if(wait>0)return res.status(429).json({ok:false,message:`Ad / Soyad bilgisi 30 günde 1 kez değiştirilebilir. Tekrar değiştirebilmeniz için ${humanWait(wait)} kaldı.`})}
  if(phoneChanged){const wait=profileWaitMs(meta.phoneChangedAt,PROFILE_PHONE_COOLDOWN_MS);if(wait>0)return res.status(429).json({ok:false,message:`Telefon numarası 7 günde 1 kez değiştirilebilir. Tekrar değiştirebilmeniz için ${humanWait(wait)} kaldı.`});if(users.some(x=>x.id!==u.id&&normalizeAccountPhone(x.phone)===phone))return res.status(409).json({ok:false,message:'Bu telefon numarasıyla daha önce hesap oluşturulmuş.'})}
  if(emailChanged&&users.some(x=>x.id!==u.id&&normalizeEmail(x.email)===email))return res.status(409).json({ok:false,message:'Bu e-posta adresiyle daha önce hesap oluşturulmuş.'});
  if(birthChanged&&meta.birthDateUserChangeCount>=1)return res.status(429).json({ok:false,message:'Doğum tarihinizi kullanıcı hesabından yalnızca 1 kez değiştirebilirsiniz. Bundan sonraki değişiklik için yönetim desteği gerekir.'});
  let pendingMessage='';
  if(emailChanged){
    if(!RESEND_API_KEY)return res.status(503).json({ok:false,message:'Yeni e-posta adresini doğrulamak için e-posta servisi henüz yapılandırılmadı. Mevcut e-posta adresiniz değiştirilmedi.'});
    const raw=crypto.randomBytes(32).toString('base64url'),tokenHash=crypto.createHash('sha256').update(raw).digest('hex'),pending={email,tokenHash,requestedAt:now,expiresAt:new Date(Date.now()+PROFILE_VERIFY_TTL_MS).toISOString()};
    const sent=await sendAccountEmailVerificationMail(email,`${PUBLIC_BASE_URL}/api/account/verify-email-change?token=${encodeURIComponent(raw)}`);if(!sent)return res.status(502).json({ok:false,message:'Yeni e-posta adresine doğrulama bağlantısı gönderilemedi. Mevcut e-posta adresiniz değiştirilmedi.'});u.pendingEmailChange=pending;pendingMessage='Yeni e-posta adresinize doğrulama bağlantısı gönderildi. Doğrulanana kadar mevcut e-posta adresiniz aktif kalır.';
  }
  if(phoneChanged){
    try{await SmsVerificationProvider.sendOtp(phone,u.id)}catch(e){return res.status(503).json({ok:false,message:'Yeni telefon numarası doğrulanmadan aktif edilemez. SMS doğrulama servisi şu anda yapılandırılmamış; mevcut telefon numaranız değiştirilmedi.'})}
    u.pendingPhoneChange={phone,requestedAt:now,expiresAt:new Date(Date.now()+PROFILE_VERIFY_TTL_MS).toISOString()};pendingMessage+=(pendingMessage?' ':'')+'Yeni telefon numaranıza doğrulama kodu gönderildi. Doğrulanana kadar mevcut numaranız aktif kalır.';
  }
  if(nameChanged){pushProfileHistory(u,'Ad / Soyad',[u.firstName,u.lastName].filter(Boolean).join(' '),[firstName,lastName].filter(Boolean).join(' '));u.firstName=firstName;u.lastName=lastName;meta.nameChangedAt=now}
  if(birthChanged){pushProfileHistory(u,'Doğum Tarihi',u.birthDate||'',birthDate);u.birthDate=birthDate;meta.birthDateUserChangeCount+=1}
  const oldSms=!!u.smsMarketingConsent,oldMail=!!u.emailMarketingConsent,newSms=!!req.body.smsMarketingConsent,newMail=!!req.body.emailMarketingConsent;
  if(oldSms!==newSms)pushProfileHistory(u,'SMS İzni',oldSms?'Açık':'Kapalı',newSms?'Açık':'Kapalı');if(oldMail!==newMail)pushProfileHistory(u,'E-posta İzni',oldMail?'Açık':'Kapalı',newMail?'Açık':'Kapalı');
  u.smsMarketingConsent=newSms;u.emailMarketingConsent=newMail;u.profileChangeMeta=meta;u.updatedAt=now;users[i]=u;writeJson('users.json',users);
  const customers=readJson('customers.json',[]),ci=customers.findIndex(c=>c.id===u.customerId);if(ci>=0){Object.assign(customers[ci],{firstName:u.firstName,lastName:u.lastName,email:u.email,phone:u.phone,updatedAt:now});writeJson('customers.json',customers)}
  if(oldSms!==newSms||oldMail!==newMail){const cons=readJson('marketing_consents.json',[]);if(oldSms!==newSms)cons.push({id:crypto.randomUUID(),userId:u.id,channel:'sms',granted:newSms,at:now,source:'account',textVersion:'1',ip:consentIp(req),userAgent:String(req.headers['user-agent']||'')});if(oldMail!==newMail)cons.push({id:crypto.randomUUID(),userId:u.id,channel:'email',granted:newMail,at:now,source:'account',textVersion:'1',ip:consentIp(req),userAgent:String(req.headers['user-agent']||'')});writeJson('marketing_consents.json',cons)}
  persistAccountStateAsync();res.json({ok:true,user:publicUser(u),pendingEmailVerification:emailChanged,pendingPhoneVerification:phoneChanged,message:pendingMessage||'Hesap bilgileri güncellendi.'});
});
app.get('/api/account/verify-email-change',async(req,res)=>{
  const token=String(req.query.token||''),hash=token?crypto.createHash('sha256').update(token).digest('hex'):'',users=readJson('users.json',[]),u=users.find(x=>x.pendingEmailChange?.tokenHash===hash);
  if(!u||!u.pendingEmailChange||new Date(u.pendingEmailChange.expiresAt).getTime()<Date.now())return res.status(400).send('<!doctype html><meta charset="utf-8"><title>SHAZ</title><p>Doğrulama bağlantısı geçersiz veya süresi dolmuş.</p>');
  const email=normalizeEmail(u.pendingEmailChange.email);if(users.some(x=>x.id!==u.id&&normalizeEmail(x.email)===email))return res.status(409).send('<!doctype html><meta charset="utf-8"><title>SHAZ</title><p>Bu e-posta adresi başka bir hesapta kullanılıyor.</p>');
  const old=u.email;pushProfileHistory(u,'E-posta',old,email);u.email=email;u.pendingEmailChange=null;u.profileChangeMeta={...profileChangeMeta(u),emailChangedAt:new Date().toISOString()};u.updatedAt=new Date().toISOString();writeJson('users.json',users);
  const customers=readJson('customers.json',[]),ci=customers.findIndex(c=>c.id===u.customerId);if(ci>=0){customers[ci].email=email;customers[ci].updatedAt=u.updatedAt;writeJson('customers.json',customers)}persistAccountStateAsync();
  res.send('<!doctype html><meta charset="utf-8"><title>SHAZ</title><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial;text-align:center;padding:50px"><h2>E-posta adresiniz doğrulandı.</h2><p>Yeni e-posta adresiniz artık hesabınızda aktif.</p><a href="/">Web sitesine dön</a></body>');
});
app.post('/api/account/verify-phone-change',sameOriginGuard,requireUser,async(req,res)=>{
  const users=readJson('users.json',[]),i=users.findIndex(x=>x.id===req.accountUser.id),u=users[i],pending=u.pendingPhoneChange,code=String(req.body.code||'').trim();if(!pending)return res.status(400).json({ok:false,message:'Bekleyen telefon numarası değişikliği yok.'});if(new Date(pending.expiresAt).getTime()<Date.now())return res.status(400).json({ok:false,message:'Telefon doğrulama süresi dolmuş. Değişikliği yeniden başlatın.'});
  const ok=await SmsVerificationProvider.verifyOtp(pending.phone,code,u.id);if(!ok)return res.status(400).json({ok:false,message:'Doğrulama kodu hatalı veya süresi dolmuş.'});if(users.some(x=>x.id!==u.id&&normalizeAccountPhone(x.phone)===pending.phone))return res.status(409).json({ok:false,message:'Bu telefon numarası başka bir hesapta kullanılıyor.'});
  const old=normalizeAccountPhone(u.phone)||u.phone;pushProfileHistory(u,'Telefon',old,pending.phone);u.phone=pending.phone;u.phoneVerifiedAt=new Date().toISOString();u.pendingPhoneChange=null;u.profileChangeMeta={...profileChangeMeta(u),phoneChangedAt:u.phoneVerifiedAt};u.updatedAt=u.phoneVerifiedAt;writeJson('users.json',users);
  const customers=readJson('customers.json',[]),ci=customers.findIndex(c=>c.id===u.customerId);if(ci>=0){customers[ci].phone=u.phone;customers[ci].updatedAt=u.updatedAt;writeJson('customers.json',customers)}persistAccountStateAsync();res.json({ok:true,user:publicUser(u)});
});
app.post('/api/account/password',sameOriginGuard,requireUser,(req,res)=>{if(!passwordMatches(req.body.currentPassword,req.accountUser))return res.status(400).json({ok:false,message:'Mevcut şifre hatalı.'});const np=String(req.body.newPassword||'');if(np.length<8)return res.status(400).json({ok:false,message:'Yeni şifre en az 8 karakter olmalıdır.'});const users=readJson('users.json',[]),i=users.findIndex(u=>u.id===req.accountUser.id),ph=passwordHash(np);users[i].passwordSalt=ph.salt;users[i].passwordHash=ph.hash;users[i].authVersion=Number(users[i].authVersion||1)+1;users[i].updatedAt=new Date().toISOString();writeJson('users.json',users);persistAccountStateAsync();setUserSession(res,users[i],req);res.json({ok:true})});
app.get('/api/account/addresses',requireUser,(req,res)=>res.json({ok:true,addresses:readJson('addresses.json',[]).filter(a=>a.userId===req.accountUser.id)}));
app.post('/api/account/addresses',sameOriginGuard,requireUser,(req,res)=>{const arr=readJson('addresses.json',[]),now=new Date().toISOString(),extraPhone=String(req.body.extraPhone||'').trim()?normalizeAccountPhone(req.body.extraPhone):'',a={id:'ADR-'+crypto.randomUUID(),userId:req.accountUser.id,title:String(req.body.title||'Adres').trim(),fullName:String(req.body.fullName||'').trim(),phone:normalizeAccountPhone(req.body.phone)||normalizeAccountPhone(req.accountUser.phone)||req.accountUser.phone,extraPhone,province:String(req.body.province||'').trim(),district:String(req.body.district||'').trim(),neighborhood:normalizeAccountAddressPart(req.body.neighborhood,'neighborhood'),avenue:normalizeAccountAddressPart(req.body.avenue,'avenue'),street:normalizeAccountAddressPart(req.body.street,'street'),fullAddress:String(req.body.fullAddress||'').trim(),buildingNo:String(req.body.buildingNo||'').trim(),floor:String(req.body.floor||'').trim(),doorNo:String(req.body.doorNo||'').trim(),isDefault:!!req.body.isDefault||!arr.some(x=>x.userId===req.accountUser.id),createdAt:now,updatedAt:now};if(String(req.body.extraPhone||'').trim()&&!extraPhone)return res.status(400).json({ok:false,message:'2. telefon numarası geçerli değil.'});if(extraPhone&&extraPhone===a.phone)return res.status(400).json({ok:false,message:'2. telefon numarası ana telefonla aynı olamaz.'});if(a.isDefault)arr.forEach(x=>{if(x.userId===a.userId)x.isDefault=false});arr.push(a);writeJson('addresses.json',arr);persistAccountStateAsync();res.json({ok:true,address:a})});
app.patch('/api/account/addresses/:id',sameOriginGuard,requireUser,(req,res)=>{const arr=readJson('addresses.json',[]),i=arr.findIndex(a=>a.id===req.params.id&&a.userId===req.accountUser.id);if(i<0)return res.status(404).json({ok:false,message:'Adres bulunamadı.'});const a=arr[i];for(const k of ['title','fullName','province','district','fullAddress','buildingNo','floor','doorNo'])if(k in req.body)a[k]=String(req.body[k]||'').trim();if('neighborhood'in req.body)a.neighborhood=normalizeAccountAddressPart(req.body.neighborhood,'neighborhood');if('avenue'in req.body)a.avenue=normalizeAccountAddressPart(req.body.avenue,'avenue');if('street'in req.body)a.street=normalizeAccountAddressPart(req.body.street,'street');if('phone'in req.body)a.phone=normalizeAccountPhone(req.body.phone)||a.phone;if('extraPhone'in req.body){const raw=String(req.body.extraPhone||'').trim(),extra=raw?normalizeAccountPhone(raw):'';if(raw&&!extra)return res.status(400).json({ok:false,message:'2. telefon numarası geçerli değil.'});if(extra&&extra===normalizeAccountPhone(a.phone))return res.status(400).json({ok:false,message:'2. telefon numarası ana telefonla aynı olamaz.'});a.extraPhone=extra}if('isDefault'in req.body)a.isDefault=!!req.body.isDefault;if(a.isDefault)arr.forEach((x,j)=>{if(j!==i&&x.userId===a.userId)x.isDefault=false});a.updatedAt=new Date().toISOString();writeJson('addresses.json',arr);persistAccountStateAsync();res.json({ok:true,address:a})});
app.delete('/api/account/addresses/:id',sameOriginGuard,requireUser,(req,res)=>{const arr=readJson('addresses.json',[]),i=arr.findIndex(a=>a.id===req.params.id&&a.userId===req.accountUser.id);if(i<0)return res.status(404).json({ok:false,message:'Adres bulunamadı.'});const wasDefault=!!arr[i].isDefault;arr.splice(i,1);if(wasDefault){const next=arr.find(a=>a.userId===req.accountUser.id);if(next)next.isDefault=true}writeJson('addresses.json',arr);persistAccountStateAsync();res.json({ok:true})});
app.get('/api/account/favorites',requireUser,(req,res)=>res.json({ok:true,productIds:readJson('favorites.json',[]).filter(x=>x.userId===req.accountUser.id).map(x=>x.productId)}));
app.post('/api/account/favorites/:productId',sameOriginGuard,requireUser,(req,res)=>{const arr=readJson('favorites.json',[]),pid=String(req.params.productId||'');if(!arr.some(x=>x.userId===req.accountUser.id&&x.productId===pid)){arr.push({id:crypto.randomUUID(),userId:req.accountUser.id,productId:pid,createdAt:new Date().toISOString()});writeJson('favorites.json',arr);persistAccountStateAsync()}res.json({ok:true})});
app.delete('/api/account/favorites/:productId',sameOriginGuard,requireUser,(req,res)=>{const arr=readJson('favorites.json',[]).filter(x=>!(x.userId===req.accountUser.id&&x.productId===String(req.params.productId||'')));writeJson('favorites.json',arr);persistAccountStateAsync();res.json({ok:true})});
function istanbulDateKey(date=new Date()){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date),map=Object.fromEntries(parts.map(x=>[x.type,x.value]));return `${map.year}-${map.month}-${map.day}`}
function couponExpiryDateKey(value){const m=String(value||'').match(/^(\d{4}-\d{2}-\d{2})/);return m?m[1]:''}
function evaluateOrderCoupons(userId,ids,baseTotal){
  const unique=[...new Set((Array.isArray(ids)?ids:[]).map(x=>String(x||'').trim()).filter(Boolean))],base=Math.max(0,Number(baseTotal||0));
  if(!unique.length)return {ok:true,discount:0,total:base,coupons:[]};if(!userId)return {ok:false,message:'Kupon kullanmak için üye hesabıyla giriş yapmalısınız.'};
  const today=istanbulDateKey(),all=readJson('coupons.json',[]),selected=[];for(const id of unique){const c=all.find(x=>String(x.id)===id&&x.userId===userId);if(!c)return {ok:false,message:'Seçilen kupon hesabınıza ait değil.'};const expiry=couponExpiryDateKey(c.expiresAt);if(c.status==='used')return {ok:false,message:`${c.code||'Kupon'} daha önce kullanılmış.`};if(expiry&&expiry<today)return {ok:false,message:`${c.code||'Kupon'} kuponunun süresi dolmuş.`};selected.push(c)}
  if(selected.length===1&&base<Number(selected[0].minCartAmount||0))return {ok:false,message:`${selected[0].code||'Kupon'} için minimum sepet tutarı ${Number(selected[0].minCartAmount||0).toLocaleString('tr-TR')} TL.`};
  if(selected.length>1){if(selected.some(c=>c.discountType==='percent'))return {ok:false,message:'Yüzdelik kuponlar başka kuponlarla birleştirilemez.'};if(selected.some(c=>c.stackable!==true))return {ok:false,message:'Bu kuponlardan biri diğer kuponlarla birlikte kullanılamaz.'};const requiredMin=selected.reduce((n,c)=>n+Math.max(0,Number(c.minCartAmount||0)),0);if(base<requiredMin)return {ok:false,message:`Seçtiğiniz kuponları birlikte kullanmak için indirim öncesi sepet toplamınız en az ${requiredMin.toLocaleString('tr-TR')} TL olmalı.`}}
  let remaining=base,discount=0;const applied=[];for(const c of selected){let amount=c.discountType==='fixed'?Number(c.value||0):remaining*(Number(c.value||0)/100);if(c.discountType==='percent'&&Number(c.maxDiscountAmount||0)>0)amount=Math.min(amount,Number(c.maxDiscountAmount));amount=Math.max(0,Math.min(remaining,Math.round(amount*100)/100));remaining=Math.max(0,Math.round((remaining-amount)*100)/100);discount=Math.round((discount+amount)*100)/100;applied.push({id:c.id,code:c.code,discountType:c.discountType,value:Number(c.value||0),title:c.title||'',minCartAmount:Number(c.minCartAmount||0),stackable:!!c.stackable,maxDiscountAmount:Number(c.maxDiscountAmount||0),discount:amount})}
  return {ok:true,discount,total:remaining,coupons:applied};
}
function saveOrderAddressForUser(user,customer){
  if(!user||!customer||customer.deliveryMode==='branch')return null;
  const arr=readJson('addresses.json',[]),userRows=arr.filter(a=>a.userId===user.id);
  if(customer.savedAddressId){const existing=userRows.find(a=>String(a.id)===String(customer.savedAddressId));if(existing)return existing;}
  const phone=normalizeAccountPhone(customer.phone)||normalizeAccountPhone(user.phone)||user.phone||'';
  const extraPhone=normalizeAccountPhone(customer.extraPhone)||'';
  const normalized={fullName:String(customer.fullName||'').trim(),phone,extraPhone,province:String(customer.province||'').trim(),district:String(customer.district||'').trim(),neighborhood:normalizeAccountAddressPart(customer.neighborhood,'neighborhood'),avenue:normalizeAccountAddressPart(customer.avenue,'avenue'),street:normalizeAccountAddressPart(customer.street,'street'),fullAddress:String(customer.fullAddress||'').trim(),buildingNo:String(customer.buildingNo||'').trim(),floor:String(customer.floor||'').trim(),doorNo:String(customer.doorNo||'').trim()};
  const key=a=>[a.fullName,a.phone,a.extraPhone,a.province,a.district,a.neighborhood,a.avenue,a.street,a.fullAddress,a.buildingNo,a.floor,a.doorNo].map(v=>String(v||'').trim().toLocaleLowerCase('tr-TR')).join('|');
  const duplicate=userRows.find(a=>key(a)===key(normalized));if(duplicate)return duplicate;
  const now=new Date().toISOString(),row={id:'ADR-'+crypto.randomUUID(),userId:user.id,title:'Sipariş Adresi',...normalized,isDefault:userRows.length===0,createdAt:now,updatedAt:now};
  arr.push(row);writeJson('addresses.json',arr);return row;
}
app.get('/api/account/coupons',requireUser,(req,res)=>{const today=istanbulDateKey(),rows=readJson('coupons.json',[]).filter(c=>c.userId===req.accountUser.id).map(c=>{const expiry=couponExpiryDateKey(c.expiresAt);return {...c,status:c.status==='used'?'used':(expiry&&expiry<today?'expired':'active')}});res.json({ok:true,coupons:rows})});
app.get('/api/account/orders',requireUser,(req,res)=>{const orders=ordersWithDailyDisplayIds(readJson('orders.json',[])).filter(o=>o.userId===req.accountUser.id||o.customerId===req.accountUser.customerId);res.json({ok:true,orders:orders.map(o=>({id:o.id,dailyDisplayId:o.dailyDisplayId,createdAt:o.createdAt,createdAtTR:o.createdAtTR,total:o.total,status:o.status,payment:o.payment,items:Array.isArray(o.items)?o.items:[]}))})});
app.get('/api/account/orders/:id',requireUser,(req,res)=>{const o=ordersWithDailyDisplayIds(readJson('orders.json',[])).find(o=>String(o.id)===String(req.params.id)&&(o.userId===req.accountUser.id||o.customerId===req.accountUser.customerId));if(!o)return res.status(404).json({ok:false,message:'Sipariş bulunamadı.'});res.json({ok:true,order:o})});
app.get('/admin/login',(req,res)=>{
 if(validSession(req))return res.redirect('/admin');
 res.sendFile(path.join(root,'public','admin-login.html'));
});
app.post('/api/admin/login',(req,res)=>{
 if(!ADMIN_USER || !ADMIN_PASSWORD || !SESSION_SECRET){
   return res.status(503).json({ok:false,message:'Yönetici girişi henüz sunucuda yapılandırılmadı.'});
 }
 const key=loginKey(req);
 if(isLoginBlocked(key))return res.status(429).json({ok:false,message:'Çok fazla başarısız deneme. 15 dakika sonra tekrar deneyin.'});
 const username=String(req.body.username||'');
 const password=String(req.body.password||'');
 if(!safeEqual(username,ADMIN_USER) || !safeEqual(password,ADMIN_PASSWORD)){
   registerLoginFailure(key);
   return res.status(401).json({ok:false,message:'Kullanıcı adı veya şifre hatalı.'});
 }
 loginAttempts.delete(key);
 const secure=process.env.NODE_ENV==='production' || String(req.headers['x-forwarded-proto']||'').includes('https');
 const token=signSession(Date.now());
 res.setHeader('Set-Cookie',`${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_MS/1000}${secure?'; Secure':''}`);
 res.json({ok:true});
});
app.post('/api/admin/logout',(req,res)=>{
 const secure=process.env.NODE_ENV==='production' || String(req.headers['x-forwarded-proto']||'').includes('https');
 res.setHeader('Set-Cookie',`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure?'; Secure':''}`);
 res.json({ok:true});
});
app.get('/api/admin/me',(req,res)=>res.json({authenticated:validSession(req)}));

app.get('/admin',requireAdmin,(req,res)=>res.sendFile(path.join(root,'admin.html')));

// Hassas admin HTML dosyasına doğrudan erişim yok.
app.get('/admin.html',(req,res)=>res.redirect('/admin'));

app.use((err,req,res,next)=>{
 console.error(err);
 res.status(400).json({ok:false,message:err.message||'İstek işlenemedi.'});
});

async function startServer(){
  // Render Free yeniden başlatıldığında yerel dosya sistemi temizlenebilir.
  // Bu yüzden [skip render] ile GitHub'a yazılan en güncel şifreli üyelik anlık görüntüsünü
  // dinlemeye başlamadan önce geri yükle; GitHub kullanılamazsa yerel seed/snapshot ile devam et.
  const remoteAccountSnapshotRestored=await restoreAccountStateFromGithub();
  if(remoteAccountSnapshotRestored)console.log('SHAZ üyelik verileri GitHub şifreli kalıcı kaydından geri yüklendi.');
  else if(localAccountSnapshotRestored)console.log('SHAZ üyelik verileri yerel şifreli kalıcı kayıttan kullanılıyor.');
  setInterval(()=>syncPendingOrdersToSheets().catch(()=>{}),60000);
  setTimeout(()=>syncPendingOrdersToSheets().catch(()=>{}),5000);
  app.listen(PORT,()=>console.log(`SHAZ çalışıyor: http://localhost:${PORT}`));
}
startServer().catch(e=>{console.error('SHAZ başlangıç hatası:',e);process.exitCode=1});
