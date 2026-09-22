
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
for(const name of ['settings.json','catalog.json','orders.json','users.json','customers.json','addresses.json','favorites.json','marketing_consents.json','legal_documents.json','legal_acceptances.json','phone_verifications.json','order_personalizations.json']){
  const dst=path.join(dataDir,name);
  const seed=path.join(root,'data',name);
  if(!fs.existsSync(dst) && fs.existsSync(seed)) fs.copyFileSync(seed,dst);
}
console.log('SHAZ veri dizini:',persistRoot);
app.use(express.json({limit:'5mb'}));
app.use(express.urlencoded({extended:true}));
app.use('/uploads', express.static(uploadDir,{maxAge:'7d'}));
app.get('/favicon.ico',(req,res)=>{
  const settings=readJson('settings.json',{});const logo=String(settings.logoUrl||'/uploads/shaz-logo-transparent.png');
  if(/^https?:\/\//i.test(logo))return res.redirect(302,logo);
  const rel=logo.replace(/^\/+/,''),file=logo.startsWith('/uploads/')?path.join(uploadDir,path.basename(rel)):path.join(root,'public',rel);
  if(fs.existsSync(file))return res.sendFile(file);
  const fallback=path.join(root,'public','favicon.ico');if(fs.existsSync(fallback))return res.sendFile(fallback);
  res.status(404).end();
});
app.get('/social-logo',(req,res)=>{
  const settings=readJson('settings.json',{});const logo=String(settings.logoUrl||'/uploads/shaz-logo-transparent.png');
  if(/^https?:\/\//i.test(logo))return res.redirect(302,logo);
  const rel=logo.replace(/^\/+/,''),file=logo.startsWith('/uploads/')?path.join(uploadDir,path.basename(rel)):path.join(root,'public',rel);
  if(fs.existsSync(file))return res.sendFile(file);res.status(404).end();
});

// Yeni sürümlerde telefonların eski JS/CSS'i tutup sipariş isteğini eski kodla göndermesini engelle.
app.use((req,res,next)=>{
  if (/\.(?:html?|js|css)$/i.test(req.path) || req.path==='/' || req.path==='/admin') {
    res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma','no-cache');
    res.setHeader('Expires','0');
  }
  next();
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
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: ${SHAZ_ORIGIN}/sitemap.xml\n`);
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
  if(/^905\d{9}$/.test(digits))return digits.slice(2);
  return '';
};

const normalizeAccountPhone=value=>{const n=normalizeTRMobile(value);return n?'+90'+n:''};
const normalizeEmail=value=>String(value||'').trim().toLowerCase();
const CUSTOMER_SESSION_COOKIE='shaz_customer_session';
const CUSTOMER_SESSION_SECRET=(process.env.CUSTOMER_SESSION_SECRET||SESSION_SECRET||'').trim();
const PHONE_VERIFICATION_REQUIRED=String(process.env.PHONE_VERIFICATION_REQUIRED||'false').toLowerCase()==='true';
const SMS_PROVIDER=String(process.env.SMS_PROVIDER||'verimor');
const SmsVerificationProvider={async sendOtp(){throw new Error('SMS doğrulama şu anda kapalı.')},async verifyOtp(){return false}};
const VerimorSmsProvider={name:'verimor',configured:()=>!!(process.env.VERIMOR_USERNAME&&process.env.VERIMOR_PASSWORD&&process.env.VERIMOR_SOURCE_ADDR),async sendOtp(){throw new Error('Verimor OTP feature flag açılmadan kullanılamaz.')},async verifyOtp(){return false}};
const CUSTOMER_SESSION_MAX=30*24*60*60*1000;
function ensureArrayFile(name){const f=path.join(dataDir,name);if(!fs.existsSync(f))writeJson(name,[])}
['users.json','customers.json','addresses.json','favorites.json','marketing_consents.json','legal_documents.json','legal_acceptances.json','phone_verifications.json','order_personalizations.json'].forEach(ensureArrayFile);
function hashPassword(password){const salt=crypto.randomBytes(16).toString('hex');const hash=crypto.scryptSync(String(password),salt,64).toString('hex');return `scrypt$${salt}$${hash}`}
function verifyPassword(password,stored){try{const [kind,salt,hash]=String(stored||'').split('$');if(kind!=='scrypt'||!salt||!hash)return false;const got=crypto.scryptSync(String(password),salt,64);const want=Buffer.from(hash,'hex');return got.length===want.length&&crypto.timingSafeEqual(got,want)}catch{return false}}
function signCustomerSession(userId,issuedAt=Date.now()){if(!CUSTOMER_SESSION_SECRET)return '';const payload=`${userId}.${issuedAt}`;const sig=crypto.createHmac('sha256',CUSTOMER_SESSION_SECRET).update(payload).digest('hex');return `${payload}.${sig}`}
function currentUser(req){if(!CUSTOMER_SESSION_SECRET)return null;const token=parseCookies(req)[CUSTOMER_SESSION_COOKIE];if(!token)return null;const parts=token.split('.');if(parts.length!==3)return null;const [id,issued,sig]=parts;const ts=Number(issued);if(!id||!Number.isFinite(ts)||Date.now()-ts>CUSTOMER_SESSION_MAX)return null;const expected=crypto.createHmac('sha256',CUSTOMER_SESSION_SECRET).update(`${id}.${issued}`).digest('hex');if(!safeEqual(sig,expected))return null;return readJson('users.json',[]).find(u=>String(u.id)===String(id))||null}
function setCustomerCookie(req,res,userId){const secure=process.env.NODE_ENV==='production'||String(req.headers['x-forwarded-proto']||'').includes('https');res.setHeader('Set-Cookie',`${CUSTOMER_SESSION_COOKIE}=${encodeURIComponent(signCustomerSession(userId))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${CUSTOMER_SESSION_MAX/1000}${secure?'; Secure':''}`)}
function clearCustomerCookie(req,res){const secure=process.env.NODE_ENV==='production'||String(req.headers['x-forwarded-proto']||'').includes('https');res.setHeader('Set-Cookie',`${CUSTOMER_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure?'; Secure':''}`)}
function publicUser(u){if(!u)return null;const {passwordHash,...x}=u;return x}
function requireCustomer(req,res,next){const u=currentUser(req);if(!u)return res.status(401).json({ok:false,message:'Giriş yapmanız gerekiyor.'});req.customerUser=u;next()}
function requestIp(req){return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim()}
function customerIdForUser(user){return String(user?.customerId||'')}
const customerLoginAttempts=new Map();
function customerLoginBlocked(key){const now=Date.now(),x=customerLoginAttempts.get(key);if(!x)return false;if(now-x.start>15*60*1000){customerLoginAttempts.delete(key);return false}return x.count>=8}
function customerLoginFail(key){const now=Date.now(),x=customerLoginAttempts.get(key);if(!x||now-x.start>15*60*1000)customerLoginAttempts.set(key,{count:1,start:now});else x.count++}
function activeLegalDocuments(){return readJson('legal_documents.json',[]).filter(d=>d&&d.active!==false).map(d=>({...d,hash:crypto.createHash('sha256').update(String(d.content||'')).digest('hex')}))}


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
  return githubCommitFiles([{path:'data/orders.json',content,encoding:'utf-8'}],'SHAZ sipariş: kalıcı sipariş kaydı güncellendi');
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


app.get('/api/legal-documents/public',(req,res)=>res.json({ok:true,documents:activeLegalDocuments().map(({type,title,version,content,active,effectiveAt,hash})=>({type,title,version,content,active,effectiveAt,hash}))}));
app.get('/legal/:type',(req,res)=>{const d=activeLegalDocuments().find(x=>x.type===String(req.params.type||''));if(!d)return res.status(404).type('text/plain').send('Metin bulunamadı.');res.type('html').send(`<!doctype html><html lang="tr"><meta charset="utf-8"><title>${escapeHtmlAttr(d.title||'SHAZ')}</title><body style="font-family:Arial;max-width:900px;margin:40px auto;padding:0 18px;line-height:1.6"><h1>${escapeHtmlAttr(d.title||'')}</h1><small>Versiyon ${escapeHtmlAttr(d.version||'')}</small><div style="white-space:pre-wrap">${escapeHtmlAttr(d.content||'')}</div></body></html>`)});

app.post('/api/auth/register',(req,res)=>{
  try{
    if(!CUSTOMER_SESSION_SECRET)return res.status(503).json({ok:false,message:'Üyelik oturum anahtarı sunucuda yapılandırılmadı.'});
    const firstName=String(req.body?.firstName||'').trim(),lastName=String(req.body?.lastName||'').trim(),email=normalizeEmail(req.body?.email),phone=normalizeAccountPhone(req.body?.phone),password=String(req.body?.password||''),passwordConfirm=String(req.body?.passwordConfirm||'');
    if(!firstName||!lastName)return res.status(400).json({ok:false,message:'Ad ve soyad zorunludur.'});
    if(!/^\S+@\S+\.\S+$/.test(email))return res.status(400).json({ok:false,message:'Lütfen geçerli bir e-posta adresi girin.'});
    if(!phone)return res.status(400).json({ok:false,message:'Lütfen geçerli bir telefon numarası girin.'});
    if(password.length<8)return res.status(400).json({ok:false,message:'Şifre en az 8 karakter olmalıdır.'});
    if(password!==passwordConfirm)return res.status(400).json({ok:false,message:'Şifreler eşleşmiyor.'});
    const users=readJson('users.json',[]);
    if(users.some(u=>normalizeEmail(u.email)===email))return res.status(409).json({ok:false,message:'Bu e-posta adresiyle daha önce hesap oluşturulmuş.'});
    if(users.some(u=>normalizeAccountPhone(u.phone)===phone))return res.status(409).json({ok:false,message:'Bu telefon numarasıyla daha önce hesap oluşturulmuş.'});
    const customers=readJson('customers.json',[]);
    let customer=customers.find(c=>normalizeEmail(c.email)===email&&normalizeAccountPhone(c.phone)===phone);
    if(!customer){customer={id:crypto.randomUUID(),firstName,lastName,fullName:`${firstName} ${lastName}`,email,phone,createdAt:new Date().toISOString()};customers.push(customer);writeJson('customers.json',customers)}
    const now=new Date().toISOString();
    const user={id:crypto.randomUUID(),customerId:customer.id,firstName,lastName,email,phone,birthDate:String(req.body?.birthDate||''),passwordHash:hashPassword(password),phoneVerifiedAt:null,createdAt:now,updatedAt:now,smsMarketingConsent:!!req.body?.smsMarketingConsent,emailMarketingConsent:!!req.body?.emailMarketingConsent};
    users.push(user);writeJson('users.json',users);
    const cons=readJson('marketing_consents.json',[]);for(const [channel,granted] of [['sms',user.smsMarketingConsent],['email',user.emailMarketingConsent]])cons.push({id:crypto.randomUUID(),userId:user.id,channel,granted,consentAt:now,source:'registration',textVersion:'v1',ip:requestIp(req),userAgent:String(req.headers['user-agent']||'')});writeJson('marketing_consents.json',cons);
    // Eski siparişleri yalnız telefon + e-posta birlikte güvenle eşleşiyorsa bağla.
    const orders=readJson('orders.json',[]);let changed=false;for(const o of orders){if(o.userId||o.customerId)continue;const oe=normalizeEmail(o.customer?.email),op=normalizeAccountPhone(o.customer?.phone);if(oe&&op&&oe===email&&op===phone){o.userId=user.id;o.customerId=customer.id;changed=true}}if(changed)writeJson('orders.json',orders);
    setCustomerCookie(req,res,user.id);res.json({ok:true,user:publicUser(user),phoneVerificationRequired:PHONE_VERIFICATION_REQUIRED,smsProvider:SMS_PROVIDER});
  }catch(e){res.status(500).json({ok:false,message:'Hesap oluşturulamadı.'})}
});
app.post('/api/auth/login',(req,res)=>{const key=requestIp(req);if(customerLoginBlocked(key))return res.status(429).json({ok:false,message:'Çok fazla başarısız deneme. Daha sonra tekrar deneyin.'});const id=String(req.body?.identifier||'').trim(),users=readJson('users.json',[]);const email=normalizeEmail(id),phone=normalizeAccountPhone(id);const u=users.find(x=>normalizeEmail(x.email)===email||(phone&&normalizeAccountPhone(x.phone)===phone));if(!u||!verifyPassword(req.body?.password,u.passwordHash)){customerLoginFail(key);return res.status(401).json({ok:false,message:'E-posta/telefon veya şifre hatalı.'})}customerLoginAttempts.delete(key);setCustomerCookie(req,res,u.id);res.json({ok:true,user:publicUser(u)})});
app.post('/api/auth/logout',(req,res)=>{clearCustomerCookie(req,res);res.json({ok:true})});
app.get('/api/auth/me',(req,res)=>res.json({ok:true,user:publicUser(currentUser(req))}));
app.get('/api/account',requireCustomer,(req,res)=>res.json({ok:true,user:publicUser(req.customerUser)}));
app.patch('/api/account',requireCustomer,(req,res)=>{const users=readJson('users.json',[]),u=users.find(x=>x.id===req.customerUser.id);if(!u)return res.status(404).json({ok:false});const email=normalizeEmail(req.body?.email),phone=normalizeAccountPhone(req.body?.phone);if(!/^\S+@\S+\.\S+$/.test(email))return res.status(400).json({ok:false,message:'Lütfen geçerli bir e-posta adresi girin.'});if(!phone)return res.status(400).json({ok:false,message:'Lütfen geçerli bir telefon numarası girin.'});if(users.some(x=>x.id!==u.id&&normalizeEmail(x.email)===email))return res.status(409).json({ok:false,message:'Bu e-posta adresi başka bir hesapta kullanılıyor.'});if(users.some(x=>x.id!==u.id&&normalizeAccountPhone(x.phone)===phone))return res.status(409).json({ok:false,message:'Bu telefon numarası başka bir hesapta kullanılıyor.'});const beforeSms=!!u.smsMarketingConsent,beforeMail=!!u.emailMarketingConsent;u.firstName=String(req.body?.firstName||u.firstName).trim();u.lastName=String(req.body?.lastName||u.lastName).trim();u.email=email;u.phone=phone;u.birthDate=String(req.body?.birthDate||'');u.smsMarketingConsent=!!req.body?.smsMarketingConsent;u.emailMarketingConsent=!!req.body?.emailMarketingConsent;u.updatedAt=new Date().toISOString();writeJson('users.json',users);if(beforeSms!==u.smsMarketingConsent||beforeMail!==u.emailMarketingConsent){const cons=readJson('marketing_consents.json',[]),now=new Date().toISOString();if(beforeSms!==u.smsMarketingConsent)cons.push({id:crypto.randomUUID(),userId:u.id,channel:'sms',granted:u.smsMarketingConsent,consentAt:now,source:'account',textVersion:'v1',ip:requestIp(req),userAgent:String(req.headers['user-agent']||'')});if(beforeMail!==u.emailMarketingConsent)cons.push({id:crypto.randomUUID(),userId:u.id,channel:'email',granted:u.emailMarketingConsent,consentAt:now,source:'account',textVersion:'v1',ip:requestIp(req),userAgent:String(req.headers['user-agent']||'')});writeJson('marketing_consents.json',cons)}res.json({ok:true,user:publicUser(u)})});
app.post('/api/account/password',requireCustomer,(req,res)=>{const users=readJson('users.json',[]),u=users.find(x=>x.id===req.customerUser.id);if(!u||!verifyPassword(req.body?.currentPassword,u.passwordHash))return res.status(400).json({ok:false,message:'Mevcut şifre yanlış.'});const np=String(req.body?.newPassword||'');if(np.length<8)return res.status(400).json({ok:false,message:'Yeni şifre en az 8 karakter olmalıdır.'});if(np!==String(req.body?.newPasswordConfirm||''))return res.status(400).json({ok:false,message:'Şifreler eşleşmiyor.'});u.passwordHash=hashPassword(np);u.updatedAt=new Date().toISOString();writeJson('users.json',users);res.json({ok:true})});
app.get('/api/account/addresses',requireCustomer,(req,res)=>res.json({ok:true,addresses:readJson('addresses.json',[]).filter(a=>a.userId===req.customerUser.id)}));
app.post('/api/account/addresses',requireCustomer,(req,res)=>{const list=readJson('addresses.json',[]);const a={id:crypto.randomUUID(),userId:req.customerUser.id,createdAt:new Date().toISOString(),...req.body};a.phone=normalizeAccountPhone(a.phone)||req.customerUser.phone;a.isDefault=!list.some(x=>x.userId===req.customerUser.id);list.push(a);writeJson('addresses.json',list);res.json({ok:true,address:a})});
app.patch('/api/account/addresses/:id',requireCustomer,(req,res)=>{const list=readJson('addresses.json',[]),a=list.find(x=>x.id===req.params.id&&x.userId===req.customerUser.id);if(!a)return res.status(404).json({ok:false,message:'Adres bulunamadı.'});if(req.body?.isDefault){list.filter(x=>x.userId===req.customerUser.id).forEach(x=>x.isDefault=false)}Object.assign(a,req.body,{id:a.id,userId:a.userId,updatedAt:new Date().toISOString()});if(a.phone)a.phone=normalizeAccountPhone(a.phone)||req.customerUser.phone;writeJson('addresses.json',list);res.json({ok:true,address:a})});
app.delete('/api/account/addresses/:id',requireCustomer,(req,res)=>{const list=readJson('addresses.json',[]),a=list.find(x=>x.id===req.params.id&&x.userId===req.customerUser.id);if(!a)return res.status(404).json({ok:false});const next=list.filter(x=>x!==a);if(a.isDefault){const first=next.find(x=>x.userId===req.customerUser.id);if(first)first.isDefault=true}writeJson('addresses.json',next);res.json({ok:true})});
app.get('/api/account/favorites',requireCustomer,(req,res)=>{const row=readJson('favorites.json',[]).find(x=>x.userId===req.customerUser.id);res.json({ok:true,productIds:row?.productIds||[]})});
app.put('/api/account/favorites',requireCustomer,(req,res)=>{const list=readJson('favorites.json',[]);let row=list.find(x=>x.userId===req.customerUser.id);if(!row){row={id:crypto.randomUUID(),userId:req.customerUser.id,productIds:[]};list.push(row)}const valid=new Set(readJson('catalog.json',{products:[]}).products?.map(p=>p.id)||[]);row.productIds=[...new Set((req.body?.productIds||[]).filter(id=>valid.has(id)))];row.updatedAt=new Date().toISOString();writeJson('favorites.json',list);res.json({ok:true,productIds:row.productIds})});
app.get('/api/account/orders',requireCustomer,(req,res)=>{const uid=req.customerUser.id,cid=customerIdForUser(req.customerUser);const orders=ordersWithDailyDisplayIds(readJson('orders.json',[])).filter(o=>String(o.userId||'')===uid||String(o.customerId||'')===cid);res.json({ok:true,orders})});
app.get('/api/account/orders/:id',requireCustomer,(req,res)=>{const uid=req.customerUser.id,cid=customerIdForUser(req.customerUser);const o=ordersWithDailyDisplayIds(readJson('orders.json',[])).find(o=>String(o.id)===String(req.params.id)&&(String(o.userId||'')===uid||String(o.customerId||'')===cid));if(!o)return res.status(404).json({ok:false,message:'Sipariş bulunamadı.'});res.json({ok:true,order:o})});

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
app.get('/api/admin/legal-documents',requireAdmin,(req,res)=>res.json({ok:true,documents:activeLegalDocuments()}));
app.post('/api/admin/legal-documents',requireAdmin,(req,res)=>{const type=String(req.body?.type||'').trim();if(!type)return res.status(400).json({ok:false,message:'Belge tipi eksik.'});const list=readJson('legal_documents.json',[]),now=new Date().toISOString();let d=list.find(x=>x.type===type&&x.version===String(req.body?.version||'1.0'));if(!d){d={id:crypto.randomUUID(),type,createdAt:now};list.push(d)}d.title=String(req.body?.title||type);d.version=String(req.body?.version||'1.0');d.content=String(req.body?.content||'');d.active=req.body?.active!==false;d.effectiveAt=d.effectiveAt||now;d.updatedAt=now;writeJson('legal_documents.json',list);res.json({ok:true,document:{...d,hash:crypto.createHash('sha256').update(d.content).digest('hex')}})});
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
   const signedUser=currentUser(req);
   if(signedUser){body.userId=signedUser.id;body.customerId=signedUser.customerId||'';if(!body.customer.email)body.customer.email=signedUser.email||'';}
   const legalDocs=activeLegalDocuments();
   const requiredTypes=['PRE_INFORMATION','DISTANCE_SALES'];
   const accepts=Array.isArray(body.legalAcceptances)?body.legalAcceptances:[];
   for(const type of requiredTypes){const doc=legalDocs.find(d=>d.type===type&&String(d.content||'').trim());if(!doc)return res.status(503).json({ok:false,message:'Sipariş için gerekli hukuki metinler henüz yönetim paneline eklenmedi.'});const a=accepts.find(x=>x.type===type&&x.version===doc.version&&x.hash===doc.hash);if(!a)return res.status(400).json({ok:false,message:'Lütfen sözleşmeleri onaylayın.'});}
   const hasPersonal=(body.items||[]).some(x=>x?.personalized||x?.writes?.length||x?.setCustomization?.writes?.length||x?.photoCustomizations?.length||x?.setCustomization?.photoCustomizations?.length);
   if(hasPersonal&&!body.personalizationConfirmed)return res.status(400).json({ok:false,message:'Lütfen kişiselleştirme bilgilerinizi kontrol edip onaylayın.'});

   // Siparişin ana kaydı önce sunucu/panele yapılır. Google E-Tablo geçici olarak cevap vermese bile
   // müşteri siparişi kaybolmaz ve tekrar adres girmek zorunda kalmaz.
   const order={
     id:nextLocalOrderId(orders),createdAt,createdAtTR,status:'new',statusUpdatedAt:createdAt,
     requestId,sheetSyncStatus:'pending',sheetSyncError:'',...body
   };
   orders.unshift(order);
   writeJson('orders.json',orders);
   const acceptanceRows=readJson('legal_acceptances.json',[]);
   for(const a of accepts){const doc=legalDocs.find(d=>d.type===a.type&&d.version===a.version);if(!doc)continue;acceptanceRows.push({id:crypto.randomUUID(),orderId:order.id,userId:signedUser?.id||null,customerId:signedUser?.customerId||body.customerId||null,legalDocumentType:doc.type,documentVersion:doc.version,documentHash:doc.hash,acceptedAt:createdAt,ipAddress:requestIp(req),userAgent:String(req.headers['user-agent']||'')})}
   if(hasPersonal)acceptanceRows.push({id:crypto.randomUUID(),orderId:order.id,userId:signedUser?.id||null,customerId:signedUser?.customerId||body.customerId||null,legalDocumentType:'PERSONALIZATION_CONFIRMATION',documentVersion:'v1',documentHash:crypto.createHash('sha256').update(JSON.stringify(body.items||[])).digest('hex'),acceptedAt:createdAt,ipAddress:requestIp(req),userAgent:String(req.headers['user-agent']||'')});
   writeJson('legal_acceptances.json',acceptanceRows);
   if(hasPersonal){const snapshots=readJson('order_personalizations.json',[]);for(const [itemIndex,item] of (body.items||[]).entries()){const productId=item?.product?.id||'';for(const w of (item?.writes||item?.setCustomization?.writes||[]))snapshots.push({id:crypto.randomUUID(),orderId:order.id,orderItemIndex:itemIndex,productId,fieldType:'text',placement:w.position||'',customerValue:w.text||'',uploadedImageReference:'',createdAt});for(const ph of (item?.photoCustomizations||item?.setCustomization?.photoCustomizations||[]))snapshots.push({id:crypto.randomUUID(),orderId:order.id,orderItemIndex:itemIndex,productId,fieldType:'photo',placement:ph.position||'',customerValue:ph.caption||'',uploadedImageReference:ph.imageUrl||ph.url||'',createdAt})}writeJson('order_personalizations.json',snapshots)}

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

setInterval(()=>syncPendingOrdersToSheets().catch(()=>{}),60000);
setTimeout(()=>syncPendingOrdersToSheets().catch(()=>{}),5000);
app.listen(PORT,()=>console.log(`SHAZ çalışıyor: http://localhost:${PORT}`));
