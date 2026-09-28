
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
let webpush=null;
try{webpush=require('web-push')}catch(e){console.warn('web-push paketi yüklenmemiş; Web Push gönderimi devre dışı kalacak.')}
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
const privateUploadDir = path.join(persistRoot,'private-uploads');
const BUILD_VERSION='175';
fs.mkdirSync(dataDir,{recursive:true});
fs.mkdirSync(uploadDir,{recursive:true});
fs.mkdirSync(privateUploadDir,{recursive:true});
// İlk kullanımda repodaki başlangıç JSON'larını kalıcı alana yalnızca bir kez kopyala.
for(const name of ['settings.json','catalog.json','orders.json','users.json','customers.json','addresses.json','favorites.json','marketing_consents.json','legal_documents.json','legal_documents_backup.json','legal_acceptances.json','phone_verifications.json','password_resets.json','pending_registrations.json','coupons.json','new_member_coupon_templates.json','account_login_attempts.json','push_subscriptions.json','push_delivery_log.json','account_state.enc']){
  const dst=path.join(dataDir,name);
  const seed=path.join(root,'data',name);
  if(!fs.existsSync(dst) && fs.existsSync(seed)) fs.copyFileSync(seed,dst);
}
console.log('SHAZ veri dizini:',persistRoot);
app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:true,limit:'2mb'}));
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  if(process.env.NODE_ENV==='production' || String(req.headers['x-forwarded-proto']||'').includes('https'))res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  next();
});
app.use('/uploads', express.static(uploadDir,{maxAge:'7d'}));

// Yeni sürümlerde telefonların eski JS/CSS'i tutup sipariş isteğini eski kodla göndermesini engelle.
app.use((req,res,next)=>{
  if (/\.(?:html?|js|css)$/i.test(req.path) || req.path==='/' || req.path==='/admin' || req.path==='/manifest.webmanifest') {
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
app.get('/api/pwa-splash-brand',async(req,res)=>{
  try{
    const a=brandAsset();let input=null;if(a.remote){const r=await safeFetchImageUrl(a.remote,{cache:'no-store'});if(!r.ok)throw new Error('Splash marka görseli alınamadı.');input=Buffer.from(await r.arrayBuffer())}else if(a.file)input=a.file;else return res.status(404).end();
    const buf=await sharp(input,{failOn:'none'}).trim({threshold:10}).png().toBuffer();res.type('png').set('Cache-Control','no-store, max-age=0').send(buf);
  }catch(e){console.error('PWA splash marka görseli:',e?.message||e);const a=brandAsset();if(a.file)return res.sendFile(a.file);if(a.remote)return res.redirect(302,a.remote);res.status(404).end()}
});
function isPrivateHostName(host){host=String(host||'').toLowerCase();if(host==='localhost'||host.endsWith('.localhost'))return true;if(/^127\./.test(host)||/^10\./.test(host)||/^192\.168\./.test(host)||/^169\.254\./.test(host))return true;const m=host.match(/^172\.(\d{1,3})\./);if(m&&Number(m[1])>=16&&Number(m[1])<=31)return true;if(host==='::1'||host.startsWith('fc')||host.startsWith('fd')||host.startsWith('fe80:'))return true;return false}
function assertSafeRemoteHttpUrl(raw){const u=new URL(raw);if(!['http:','https:'].includes(u.protocol)||isPrivateHostName(u.hostname))throw new Error('Güvensiz uzak URL engellendi.');return u}
async function safeFetchImageUrl(raw,opts={}){let url=assertSafeRemoteHttpUrl(raw).toString();for(let i=0;i<4;i++){const r=await fetch(url,{...opts,redirect:'manual'});if([301,302,303,307,308].includes(r.status)){const loc=r.headers.get('location');if(!loc)throw new Error('Geçersiz yönlendirme.');url=assertSafeRemoteHttpUrl(new URL(loc,url).toString()).toString();continue}return r}throw new Error('Çok fazla yönlendirme.');}
app.get('/api/announcement-image',async(req,res)=>{
  try{
    const cfg=readJson('settings.json',{}),raw=String(cfg?.siteAnnouncement?.imageUrl||'').trim();
    if(!raw)return res.status(404).end();
    let input=null,fallbackFile='',fallbackType='';
    if(/^https?:\/\//i.test(raw)){
      const remote=await safeFetchImageUrl(raw,{cache:'no-store'});
      if(!remote.ok)throw new Error('Duyuru görseli uzaktan alınamadı: '+remote.status);
      fallbackType=String(remote.headers.get('content-type')||'image/jpeg').split(';')[0];
      input=Buffer.from(await remote.arrayBuffer());
    }else{
      const clean=raw.split('?')[0].replace(/^\/+/,''),candidates=[path.join(persistRoot,clean),path.join(root,clean),path.join(root,'public',clean)];
      fallbackFile=candidates.find(f=>fs.existsSync(f)&&fs.statSync(f).isFile())||'';
      if(fallbackFile)input=fallbackFile;
      else if(githubEnabled()){
        try{
          const repoPath=clean.split('/').map(encodeURIComponent).join('/'),remoteFile=await ghApi(`/contents/${repoPath}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
          if(remoteFile?.encoding==='base64'&&remoteFile?.content)input=Buffer.from(String(remoteFile.content).replace(/\s+/g,''),'base64');
        }catch(recoverErr){console.error('Duyuru görseli GitHub geri yükleme:',recoverErr.message)}
      }
      if(!input)return res.status(404).end();
    }
    try{
      const buf=await sharp(input,{failOn:'none'}).rotate().flatten({background:'#ffffff'}).resize({width:1400,height:1800,fit:'inside',withoutEnlargement:true}).jpeg({quality:92,mozjpeg:true}).toBuffer();
      return res.type('jpeg').set('Cache-Control','no-store, max-age=0').send(buf);
    }catch(convertErr){
      console.error('Duyuru görseli dönüştürme:',convertErr);
      res.set('Cache-Control','no-store, max-age=0');
      if(fallbackFile)return res.sendFile(fallbackFile);
      if(Buffer.isBuffer(input)){if(fallbackType)res.type(fallbackType);return res.send(input)}
      throw convertErr;
    }
  }catch(e){console.error('Duyuru görseli:',e);res.status(500).set('Cache-Control','no-store').end()}
});
async function sendBrandPng(req,res,size){
  try{const a=brandAsset();if(a.remote)return res.redirect(302,a.remote);if(!a.file)return res.status(404).end();const buf=await sharp(a.file).resize(size,size,{fit:'contain',background:{r:255,g:255,b:255,alpha:0}}).png().toBuffer();res.type('png').set('Cache-Control','public, max-age=604800').send(buf)}catch(e){console.error('favicon üretimi:',e);res.status(500).end()}
}
app.get('/favicon.ico',(req,res)=>sendBrandPng(req,res,64));
app.get('/favicon-32.png',(req,res)=>sendBrandPng(req,res,32));
app.get('/favicon-64.png',(req,res)=>sendBrandPng(req,res,64));
app.get('/favicon-192.png',(req,res)=>sendBrandPng(req,res,192));
app.get('/apple-touch-icon.png',(req,res)=>sendPwaIcon(req,res,180,.70));
async function sendPwaIcon(req,res,size,ratio=.70){
  try{
    const a=brandAsset();let input=null;
    if(a.remote){const r=await safeFetchImageUrl(a.remote,{cache:'no-store'});if(!r.ok)throw new Error('PWA logo kaynağı alınamadı.');input=Buffer.from(await r.arrayBuffer())}
    else if(a.file)input=a.file;else return res.status(404).end();
    const safe=Math.max(1,Math.round(size*ratio));
    const trimmed=await sharp(input,{failOn:'none'}).trim({threshold:10}).png().toBuffer();
    const logo=await sharp(trimmed).resize(safe,safe,{fit:'inside',withoutEnlargement:false}).png().toBuffer();
    const canvas=await sharp({create:{width:size,height:size,channels:4,background:{r:255,g:255,b:255,alpha:1}}}).composite([{input:logo,gravity:'center'}]).png().toBuffer();
    res.type('png').set('Cache-Control','public, max-age=86400, must-revalidate').send(canvas)
  }catch(e){console.error('PWA ikon üretimi:',e);res.status(500).end()}
}
app.get('/icon-192.png',(req,res)=>sendPwaIcon(req,res,192,.70));
app.get('/icon-512.png',(req,res)=>sendPwaIcon(req,res,512,.70));
app.get('/icon-maskable-512.png',(req,res)=>sendPwaIcon(req,res,512,.58));
app.get('/social-card.png',async(req,res)=>{
  try{const a=brandAsset();if(a.remote)return res.redirect(302,a.remote);if(!a.file)return res.status(404).end();const logo=await sharp(a.file).resize(520,220,{fit:'inside',withoutEnlargement:true}).png().toBuffer();const card=await sharp({create:{width:1200,height:630,channels:4,background:{r:255,g:255,b:255,alpha:1}}}).composite([{input:logo,gravity:'center'}]).png().toBuffer();res.type('png').set('Cache-Control','public, max-age=604800').send(card)}catch(e){console.error('sosyal kart üretimi:',e);res.status(500).end()}
});
function serverMainProductImage(p){
  const list=Array.isArray(p?.images)?p.images.filter(Boolean):[];
  if(p?.image&&!list.includes(p.image))list.unshift(p.image);
  return p?.image||list[0]||'';
}
function serverProductCardHtml(p){
  const name=String(p?.name||'SHAZ Ürün');
  const image=String(serverMainProductImage(p)||'').trim();
  const href='/urun/'+encodeURIComponent(productSeoSlug(p));
  return `<a class="card productCardLink" data-product-id="${escapeHtmlAttr(p.id||'')}" href="${escapeHtmlAttr(href)}"><div class="photo">${image?`<img src="${escapeHtmlAttr(image)}" alt="${escapeHtmlAttr(name)}">`:'⌚'}</div><div class="info"><h3>${escapeHtmlAttr(name)}</h3><div class="price"><span>${Number(p?.price||0).toLocaleString('tr-TR')} TL</span></div></div></a>`;
}
function renderHomeHtml(){
  const indexPath=path.join(root,'public','index.html');let html=fs.readFileSync(indexPath,'utf8');
  const catalog=readJson('catalog.json',{products:[]});
  const cards=(catalog.products||[]).filter(p=>p&&!p.hidden).map(serverProductCardHtml).join('');
  if(cards)html=html.replace('<div class="grid products" id="productsList"></div>',`<div class="grid products" id="productsList">${cards}</div>`);
  return html;
}
app.get('/',(req,res)=>res.type('html').send(renderHomeHtml()));
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

const CRITICAL_JSON_FILES=new Set(['orders.json','users.json','customers.json','coupons.json','addresses.json','legal_acceptances.json','pending_registrations.json']);
const readJson=(name,fallback)=>{
  const file=path.join(dataDir,name);
  try{return JSON.parse(fs.readFileSync(file,'utf8'))}
  catch(e){
    if(e?.code==='ENOENT')return fallback;
    console.error('JSON okuma/parse hatası',name,e?.message||e);
    if(CRITICAL_JSON_FILES.has(name))throw new Error('Kritik veri dosyası okunamadı: '+name);
    return fallback;
  }
};
const writeJson=(name,data)=>{
  const file=path.join(dataDir,name),tmp=file+'.tmp-'+process.pid+'-'+crypto.randomBytes(4).toString('hex');
  const text=JSON.stringify(data,null,2);JSON.parse(text);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(tmp,text,'utf8');
  try{fs.renameSync(tmp,file)}catch(e){try{fs.unlinkSync(tmp)}catch(_){}throw e}
};
let orderMutationQueue=Promise.resolve(),accountMutationQueue=Promise.resolve();
function serializedMutation(kind,fn){const key=kind==='orders'?'orderMutationQueue':'accountMutationQueue';const prev=key==='orderMutationQueue'?orderMutationQueue:accountMutationQueue;let release;const gate=new Promise(r=>release=r);if(key==='orderMutationQueue')orderMutationQueue=prev.then(()=>gate,()=>gate);else accountMutationQueue=prev.then(()=>gate,()=>gate);return prev.then(fn).finally(release)}


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
  'users.json':[],'customers.json':[],'addresses.json':[],'favorites.json':[],'marketing_consents.json':[],'legal_acceptances.json':[],'phone_verifications.json':[],'password_resets.json':[],'pending_registrations.json':[],'new_member_coupon_templates.json':[],'account_login_attempts.json':{},'push_subscriptions.json':[],'legal_documents_backup.json':[],
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
const normalizeAccountPhone=value=>{let d=String(value||'').replace(/\D/g,'');if(/^00905\d{9}$/.test(d))d=d.slice(4);if(/^905\d{9}$/.test(d))d=d.slice(2);if(/^5\d{9}$/.test(d))return '0'+d;if(/^05\d{9}$/.test(d))return d;return ''};
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
function validPasswordSize(password){const n=String(password||'').length;return n>=8&&n<=256}
function passwordHash(password,salt=crypto.randomBytes(16).toString('hex')){const value=String(password);if(value.length>256)throw new Error('Şifre çok uzun.');const hash=crypto.scryptSync(value,salt,64).toString('hex');return {salt,hash}}
function passwordMatches(password,user){const value=String(password||'');if(!user?.passwordSalt||!user?.passwordHash||value.length>256)return false;const test=crypto.scryptSync(value,user.passwordSalt,64).toString('hex');return safeEqual(test,user.passwordHash)}
const PROFILE_NAME_COOLDOWN_MS=30*24*60*60*1000;
const PROFILE_PHONE_COOLDOWN_MS=7*24*60*60*1000;
const PROFILE_VERIFY_TTL_MS=30*60*1000;
function profileChangeMeta(u){const m=(u&&u.profileChangeMeta&&typeof u.profileChangeMeta==='object')?u.profileChangeMeta:{};return {nameChangedAt:m.nameChangedAt||null,phoneChangedAt:m.phoneChangedAt||null,emailChangedAt:m.emailChangedAt||null,birthDateUserChangeCount:Number(m.birthDateUserChangeCount||0)}}
function profileWaitMs(at,period){const t=at?new Date(at).getTime():0;return t?Math.max(0,t+period-Date.now()):0}
function humanWait(ms){const d=Math.floor(ms/86400000),h=Math.floor((ms%86400000)/3600000),m=Math.ceil((ms%3600000)/60000);return [d?`${d} gün`:'' ,h?`${h} saat`:'' ,(!d&&!h&&m)?`${m} dakika`:'' ].filter(Boolean).join(' ')||'kısa bir süre'}
function pushProfileHistory(u,field,oldValue,newValue,source='account'){const oldText=String(oldValue??''),newText=String(newValue??'');if(oldText===newText)return;u.profileChangeHistory=Array.isArray(u.profileChangeHistory)?u.profileChangeHistory:[];u.profileChangeHistory.push({at:new Date().toISOString(),field,oldValue:oldText,newValue:newText,source});}
function publicUser(u){if(!u)return null;const meta=profileChangeMeta(u);return {id:u.id,customerId:u.customerId,firstName:u.firstName,lastName:u.lastName,email:u.email,phone:normalizeAccountPhone(u.phone)||u.phone,birthDate:u.birthDate||'',emailVerifiedAt:u.emailVerifiedAt||null,phoneVerifiedAt:u.phoneVerifiedAt||null,smsMarketingConsent:!!u.smsMarketingConsent,emailMarketingConsent:!!u.emailMarketingConsent,createdAt:u.createdAt,authProviders:Array.isArray(u.authProviders)?u.authProviders:(u.passwordHash?['password']:[]),profileChangeMeta:meta,profileRules:{nameWaitMs:profileWaitMs(meta.nameChangedAt,PROFILE_NAME_COOLDOWN_MS),phoneWaitMs:profileWaitMs(meta.phoneChangedAt,PROFILE_PHONE_COOLDOWN_MS),birthDateChangeAvailable:meta.birthDateUserChangeCount<1},pendingEmailChange:u.pendingEmailChange?{email:u.pendingEmailChange.email,requestedAt:u.pendingEmailChange.requestedAt,expiresAt:u.pendingEmailChange.expiresAt,resendAt:u.pendingEmailChange.resendAt||null,purpose:u.pendingEmailChange.purpose||'legacy',attemptsRemaining:Math.max(0,5-Number(u.pendingEmailChange.attemptCount||0))}:null,pendingPhoneChange:u.pendingPhoneChange?{phone:u.pendingPhoneChange.phone,requestedAt:u.pendingPhoneChange.requestedAt,expiresAt:u.pendingPhoneChange.expiresAt}:null}}
function signUserSession(user){if(!USER_SESSION_SECRET)return '';const payload=Buffer.from(JSON.stringify({uid:user.id,iat:Date.now(),v:Number(user.authVersion||1)})).toString('base64url');const sig=crypto.createHmac('sha256',USER_SESSION_SECRET).update(payload).digest('base64url');return payload+'.'+sig}
function accountUserFromReq(req){if(!USER_SESSION_SECRET)return null;const token=parseCookies(req)[USER_SESSION_COOKIE];if(!token)return null;const [payload,sig]=token.split('.');if(!payload||!sig)return null;const exp=crypto.createHmac('sha256',USER_SESSION_SECRET).update(payload).digest('base64url');if(!safeEqual(sig,exp))return null;let data;try{data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'))}catch{return null}if(!data.uid||Date.now()-Number(data.iat||0)>USER_SESSION_MAX_AGE_MS)return null;const u=readJson('users.json',[]).find(x=>x.id===data.uid);if(!u||u.disabled||Number(u.authVersion||1)!==Number(data.v||1))return null;return u}
function setUserSession(res,user,req){const secure=process.env.NODE_ENV==='production'||String(req.headers['x-forwarded-proto']||'').includes('https');const token=signUserSession(user);res.setHeader('Set-Cookie',`${USER_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${USER_SESSION_MAX_AGE_MS/1000}${secure?'; Secure':''}`)}
function clearUserSession(res,req){const secure=process.env.NODE_ENV==='production'||String(req.headers['x-forwarded-proto']||'').includes('https');res.setHeader('Set-Cookie',`${USER_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure?'; Secure':''}`)}
function requireUser(req,res,next){const u=accountUserFromReq(req);if(!u)return res.status(401).json({ok:false,message:'Giriş yapmanız gerekiyor.'});req.accountUser=u;next()}
function sameOriginGuard(req,res,next){if(['GET','HEAD','OPTIONS'].includes(req.method))return next();const origin=String(req.headers.origin||'');const host=String(req.headers.host||'');if(origin){try{if(new URL(origin).host!==host)return res.status(403).json({ok:false,message:'Geçersiz istek kaynağı.'})}catch{return res.status(403).json({ok:false,message:'Geçersiz istek kaynağı.'})}}next()}
const accountRateKey=req=>String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
const ACCOUNT_LOGIN_MAX_ATTEMPTS=5;
function accountLoginDeviceId(req){const raw=String(req.body?.deviceId||req.headers['x-shaz-device-id']||'').trim();return /^[A-Za-z0-9._:-]{8,120}$/.test(raw)?raw:accountRateKey(req)}
function accountLoginAttemptKeys(req,login=''){
  const device='device:'+accountLoginDeviceId(req),identity=normalizeEmail(login)||normalizeAccountPhone(login)||String(login||'').trim().toLocaleLowerCase('tr-TR');
  // Hesabı yalnız identifier üzerinden global kilitleme: saldırgan başka ağdan hesabı kilitleyemesin.
  // Koruma cihaz ve hesap+IP kombinasyonunda kalır.
  const network=identity?'network:'+crypto.createHash('sha256').update(identity+'|'+accountRateKey(req)).digest('hex').slice(0,32):'';
  return [...new Set([device,network].filter(Boolean))];
}
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
function serverPrepareOrderItems(rawItems){
  const catalog=readJson('catalog.json',{products:[]}),products=Array.isArray(catalog.products)?catalog.products:[],byId=new Map(products.map(p=>[String(p.id),p]));
  const rows=Array.isArray(rawItems)?rawItems:[];if(!rows.length||rows.length>100)throw new Error('Sipariş ürünleri geçersiz.');
  const priceCfg=catalog.personalizationPricing||{},firstFee=Math.max(0,Number(priceCfg.first??75)),nextFee=Math.max(0,Number(priceCfg.second??50)),thirdFee=Math.max(0,Number(priceCfg.thirdPlus??nextFee)),photoExtra=Math.max(0,Number(catalog.walletPhotoFee??25));let slot=0;
  const rawProductIds=new Set(rows.map(x=>String(x?.product?.id||x?.productId||'')));
  const triggerCats=new Set([...rawProductIds].map(id=>byId.get(id)?.category).filter(Boolean));
  const clean=[];
  for(const src of rows){
    const pid=String(src?.product?.id||src?.productId||'').trim(),p=byId.get(pid);if(!p||p.hidden===true)throw new Error('Sepette artık satışta olmayan bir ürün var. Sepeti yenileyin.');
    const qty=Math.floor(Number(src.qty||1));if(!Number.isFinite(qty)||qty<1||qty>20)throw new Error('Ürün adedi geçersiz.');
    let base=Math.max(0,Number(p.price||0));
    const up=src.upsell&&typeof src.upsell==='object'?src.upsell:null;
    if(up?.ruleId){const rule=(catalog.checkoutUpsells||[]).find(r=>String(r.id)===String(up.ruleId)&&r.enabled!==false);if(rule&&triggerCats.has(rule.triggerCategoryId)&&p.category===rule.offerCategoryId&&((rule.offerMode||'all')==='all'||(rule.offerProductIds||[]).includes(p.id))){const v=rule?.productPrices?.[p.id];base=v!==undefined&&v!==null&&v!==''?Math.max(0,Number(v||0)):Math.max(0,Number(rule.specialPrice||0))}}
    let personalTotal=0;const set=src.setCustomization&&typeof src.setCustomization==='object'?src.setCustomization:null;
    const cleanWrites=[],cleanPhotos=[];
    const capText=v=>String(v||'').trim().slice(0,160),capPos=v=>String(v||'').trim().slice(0,80);
    if(set&&Array.isArray(p.setItems)){
      const removedIds=[...new Set((set.removedIds||[]).map(String))],removed=p.setItems.filter(si=>removedIds.includes(String(si.id))).reduce((sum,si)=>sum+Math.max(0,Number(si.removeDiscount||0)),0);base=Math.max(0,base-removed);
      const sw=Array.isArray(set.writes)?set.writes:[],sp=Array.isArray(set.photoCustomizations)?set.photoCustomizations:[],keys=[];[...sw,...sp].forEach(v=>{const k=String(v.itemId||v.item||'set-item').slice(0,120);if(!keys.includes(k))keys.push(k)});
      for(const k of keys){const tier=slot===0?firstFee:(slot===1?nextFee:thirdFee);slot++;const ws=sw.filter(w=>String(w.itemId||w.item||'set-item')===k),ps=sp.filter(ph=>String(ph.itemId||ph.item||'set-item')===k);ws.forEach((w,i)=>{const fee=i===0?tier:0;personalTotal+=fee;cleanWrites.push({...w,text:capText(w.text),position:capPos(w.position),fee})});ps.forEach((ph,i)=>{const slotFee=!ws.length&&i===0?tier:0,fee=slotFee+photoExtra;personalTotal+=fee;cleanPhotos.push({...ph,note:capText(ph.note),position:capPos(ph.position),slotFee,photoExtraFee:photoExtra,fee})})}
    }else{
      const ws=Array.isArray(src.writes)?src.writes:[],ps=Array.isArray(src.photoCustomizations)?src.photoCustomizations:[];if(ws.length||ps.length){const tier=slot===0?firstFee:(slot===1?nextFee:thirdFee);slot++;ws.forEach((w,i)=>{const fee=i===0?tier:0;personalTotal+=fee;cleanWrites.push({...w,text:capText(w.text),position:capPos(w.position),fee})});ps.forEach((ph,i)=>{const slotFee=!ws.length&&i===0?tier:0,fee=slotFee+photoExtra;personalTotal+=fee;cleanPhotos.push({...ph,note:capText(ph.note),position:capPos(ph.position),slotFee,photoExtraFee:photoExtra,fee})})}
    }
    const finalPrice=Math.max(0,Math.round((base+personalTotal)*100)/100),product={...p,price:finalPrice};const row={...src,product,basePrice:base,qty,writes:cleanWrites,photoCustomizations:cleanPhotos,personalized:cleanWrites.length>0||cleanPhotos.length>0};
    if(set)row.setCustomization={...set,writes:cleanWrites,photoCustomizations:cleanPhotos};
    if('productNote' in row)row.productNote=String(row.productNote||'').trim().slice(0,500);clean.push(row);
  }
  return {items:clean,catalog};
}
function serverCampaignProductMatches(rule,p){if(!p)return false;if((rule.excludedProductIds||[]).includes(p.id))return false;const scope=rule.scopeType||'category';if(scope==='all')return true;if(scope==='products')return (rule.productIds||[]).includes(p.id);return (rule.categoryIds||[]).includes(p.category)}
function serverCampaignWeight(rule,p){return Math.max(1,Math.min(10,Number(rule?.productUnitCounts?.[p?.id]||1)))}
function serverPhysicalUnits(items){const units=[];(items||[]).forEach((x,cartIndex)=>{for(let n=0;n<Math.max(1,Number(x.qty||1));n++)units.push({key:`${cartIndex}:${n}`,price:Number(x.product?.price||0),cartIndex,product:x.product})});return units}
function serverCampaignDiscount(rule,units){const v=Math.max(0,Number(rule.discountValue||0));if(rule.discountType==='fixed')return v;const subtotal=units.reduce((s,u)=>s+Number(u.price||0),0);if(rule.discountType==='percent')return subtotal*Math.max(0,Math.min(100,v))/100;if(rule.discountType==='bundlePrice')return Math.max(0,subtotal-v);return v}
function serverCampaignMaxUses(rule,totalWeight){const q=Math.max(1,Number(rule.minQty||1));if(totalWeight<q)return 0;if(!rule.repeatable)return 1;return Math.min(Math.floor(totalWeight/q),Math.max(1,Number(rule.maxApplications||1)))}
function serverCampaignGroups(rule,allUnits,maxCandidates=700){const q=Math.max(1,Number(rule.minQty||1)),eligible=[];allUnits.forEach((u,index)=>{if(serverCampaignProductMatches(rule,u.product))eligible.push({index,unit:u,weight:serverCampaignWeight(rule,u.product)})});const totalWeight=eligible.reduce((s,x)=>s+x.weight,0),maxUses=serverCampaignMaxUses(rule,totalWeight);if(!maxUses)return {groups:[],maxUses};const groups=[],seen=new Set();function walk(pos,sum,chosen){if(groups.length>=maxCandidates)return;if(sum>=q){const key=chosen.map(x=>x.index).join(',');if(!seen.has(key)){seen.add(key);const units=chosen.map(x=>x.unit);let mask=0n;chosen.forEach(x=>mask|=(1n<<BigInt(x.index)));groups.push({mask,units,discount:Math.max(0,serverCampaignDiscount(rule,units))})}return}if(pos>=eligible.length)return;let possible=sum;for(let i=pos;i<eligible.length;i++)possible+=eligible[i].weight;if(possible<q)return;walk(pos+1,sum+eligible[pos].weight,[...chosen,eligible[pos]]);walk(pos+1,sum,chosen)}walk(0,0,[]);groups.sort((a,b)=>b.discount-a.discount||a.units.length-b.units.length);return {groups,maxUses}}
function serverOptimizeCampaigns(rules,allUnits){const prepared=rules.map(rule=>({rule,...serverCampaignGroups(rule,allUnits,allUnits.length>22?220:700)})).filter(x=>x.groups.length&&x.maxUses>0);if(!prepared.length)return [];const memo=new Map();function dfs(usedMask,counts){const key=usedMask.toString()+'|'+counts.join(',');if(memo.has(key))return memo.get(key);let best={value:0,apps:[]};for(let ri=0;ri<prepared.length;ri++){const pr=prepared[ri];if((counts[ri]||0)>=pr.maxUses)continue;for(const g of pr.groups){if((usedMask&g.mask)!==0n)continue;const next=counts.slice();next[ri]=(next[ri]||0)+1;const tail=dfs(usedMask|g.mask,next),value=g.discount+tail.value;if(value>best.value+.0001)best={value,apps:[{rule:pr.rule,discount:g.discount,mask:g.mask},...tail.apps]}}}memo.set(key,best);return best}return dfs(0n,Array(prepared.length).fill(0)).apps}
function serverCampaignPricing(items,catalog){const units=serverPhysicalUnits(items),subtotal=units.reduce((s,u)=>s+u.price,0),active=(catalog.checkoutCampaigns||[]).filter(r=>r&&r.enabled!==false),applied=[];for(const rule of active.filter(r=>r.allowDoubleCount===true)){for(const x of serverOptimizeCampaigns([rule],units))if(x.discount>0)applied.push({id:x.rule.id,name:x.rule.name||'Kampanya',discount:Number(x.discount.toFixed(2)),uses:1})}for(const x of serverOptimizeCampaigns(active.filter(r=>r.allowDoubleCount!==true),units))if(x.discount>0)applied.push({id:x.rule.id,name:x.rule.name||'Kampanya',discount:Number(x.discount.toFixed(2)),uses:1});const merged=[];for(const a of applied){const f=merged.find(x=>x.id===a.id);if(f){f.discount=Number((f.discount+a.discount).toFixed(2));f.uses++}else merged.push({...a})}let remaining=subtotal;merged.sort((a,b)=>b.discount-a.discount).forEach(a=>{a.discount=Math.min(a.discount,Math.max(0,remaining));remaining-=a.discount});const discount=Number(merged.reduce((n,a)=>n+a.discount,0).toFixed(2));return {subtotal:Number(subtotal.toFixed(2)),discount,total:Math.max(0,Number((subtotal-discount).toFixed(2))),applied:merged}}

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

const ORDERS_SNAPSHOT_FILE='orders_state.enc';
function buildEncryptedOrdersSnapshot(){
  const key=accountSnapshotKey();if(!key)return '';
  const orders=readJson('orders.json',[]),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),plain=Buffer.from(JSON.stringify({v:1,createdAt:new Date().toISOString(),orders}),'utf8'),enc=Buffer.concat([cipher.update(plain),cipher.final()]),tag=cipher.getAuthTag();
  return JSON.stringify({v:1,iv:iv.toString('base64'),tag:tag.toString('base64'),data:enc.toString('base64')});
}
function restoreEncryptedOrdersSnapshot(){
  try{const key=accountSnapshotKey(),file=path.join(dataDir,ORDERS_SNAPSHOT_FILE);if(!key||!fs.existsSync(file))return false;const box=JSON.parse(fs.readFileSync(file,'utf8')),iv=Buffer.from(box.iv,'base64'),tag=Buffer.from(box.tag,'base64'),enc=Buffer.from(box.data,'base64'),decipher=crypto.createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);const state=JSON.parse(Buffer.concat([decipher.update(enc),decipher.final()]).toString('utf8'));if(!state||state.v!==1||!Array.isArray(state.orders))return false;writeJson('orders.json',state.orders);return true}catch(e){console.warn('SHAZ sipariş şifreli kayıt geri yüklenemedi:',e.message);return false}
}
async function persistOrdersToGithub(){
  const content=buildEncryptedOrdersSnapshot();if(!content)return {ok:false,skipped:true};
  fs.writeFileSync(path.join(dataDir,ORDERS_SNAPSHOT_FILE),content,'utf8');
  if(!githubEnabled())return {ok:false,skipped:true};
  return githubCommitFiles([{path:`data/${ORDERS_SNAPSHOT_FILE}`,content,encoding:'utf-8'}],'SHAZ sipariş: şifreli kalıcı sipariş kaydı güncellendi [skip render]');
}
async function restoreOrdersStateFromGithub(){
  if(!githubEnabled()||!USER_SESSION_SECRET)return restoreEncryptedOrdersSnapshot();
  try{const remote=await ghApi(`/contents/data/${encodeURIComponent(ORDERS_SNAPSHOT_FILE)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);if(!remote||remote.encoding!=='base64'||!remote.content)return restoreEncryptedOrdersSnapshot();const content=Buffer.from(String(remote.content).replace(/\s+/g,''),'base64').toString('utf8');fs.writeFileSync(path.join(dataDir,ORDERS_SNAPSHOT_FILE),content,'utf8');return restoreEncryptedOrdersSnapshot()}catch(e){if(!String(e?.message||'').toLowerCase().includes('not found'))console.warn('SHAZ sipariş GitHub şifreli kayıt geri yüklenemedi:',e.message);return restoreEncryptedOrdersSnapshot()}
}

const ACCOUNT_SNAPSHOT_FILE='account_state.enc';
const ACCOUNT_SNAPSHOT_NAMES=['users.json','customers.json','addresses.json','favorites.json','marketing_consents.json','phone_verifications.json','password_resets.json','pending_registrations.json','coupons.json','new_member_coupon_templates.json','account_login_attempts.json','push_subscriptions.json','customer_activity.json','notification_settings.json','legal_acceptances.json'];
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
 filename:(req,file,cb)=>cb(null,Date.now()+'-'+crypto.randomBytes(12).toString('hex')+path.extname(file.originalname).toLowerCase())
});
const upload=multer({
 storage,
 limits:{fileSize:20*1024*1024,files:250},
 fileFilter:(req,file,cb)=>{
   const ok=['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype);
   cb(ok?null:new Error('Sadece görsel dosyaları yüklenebilir.'),ok);
 }
});
const customerStorage=multer.diskStorage({destination:(req,file,cb)=>cb(null,privateUploadDir),filename:(req,file,cb)=>cb(null,crypto.randomBytes(24).toString('hex')+'.upload')});
const customerUpload=multer({
 storage:customerStorage,
 limits:{fileSize:8*1024*1024,files:1},
 fileFilter:(req,file,cb)=>{
   const ok=['image/jpeg','image/png','image/webp'].includes(file.mimetype);
   cb(ok?null:new Error('Lütfen JPG, PNG veya WEBP fotoğraf yükleyin.'),ok);
 }
});

// Kısa, üyelik gerektirmeyen sepet paylaşım bağlantıları.
const sharedCartDir=path.join(dataDir,'shared-carts');fs.mkdirSync(sharedCartDir,{recursive:true});
const simpleRateBuckets=new Map();
function rateLimitHit(req,key,limit,windowMs){const ip=accountRateKey(req),k=key+':'+ip,now=Date.now(),x=simpleRateBuckets.get(k);if(!x||now-x.start>windowMs){simpleRateBuckets.set(k,{start:now,count:1});return false}x.count++;simpleRateBuckets.set(k,x);return x.count>limit}
app.post('/api/shared-cart',(req,res)=>{
  try{
    if(rateLimitHit(req,'shared-cart',40,15*60*1000))return res.status(429).json({ok:false,message:'Çok fazla paylaşım isteği. Lütfen biraz sonra tekrar deneyin.'});
    const cart=req.body||{};
    if(!cart||typeof cart!=='object'||Array.isArray(cart))return res.status(400).json({ok:false,message:'Paylaşılan sepet verisi geçersiz.'});
    const raw=JSON.stringify(cart);
    if(Buffer.byteLength(raw)>180*1024)return res.status(413).json({ok:false,message:'Paylaşılan sepet çok büyük.'});
    const items=Array.isArray(cart.items)?cart.items:Array.isArray(cart.cart)?cart.cart:null;
    if(!items)return res.status(400).json({ok:false,message:'Paylaşılan sepet verisi geçersiz.'});
    if(items.length>100)return res.status(400).json({ok:false,message:'Sepette çok fazla ürün var.'});
    const textOk=(v,max)=>v===undefined||v===null||(typeof v==='string'&&v.length<=max);
    const numOk=(v,max)=>v===undefined||v===null||(Number.isFinite(Number(v))&&Number(v)>=0&&Number(v)<=max);
    const validItem=x=>x&&typeof x==='object'&&!Array.isArray(x)&&textOk(x.name,300)&&textOk(x.image,2000)&&numOk(x.price,10000000)&&numOk(x.basePrice,10000000)&&Number.isInteger(Number(x.qty||1))&&Number(x.qty||1)>=1&&Number(x.qty||1)<=50&&(!x.writes||Array.isArray(x.writes)&&x.writes.length<=20)&&(!x.photos||Array.isArray(x.photos)&&x.photos.length<=20);
    if(!items.every(validItem))return res.status(400).json({ok:false,message:'Paylaşılan sepet içeriği geçersiz.'});
    const id=crypto.randomBytes(12).toString('hex');
    fs.writeFileSync(path.join(sharedCartDir,id+'.json'),raw);
    res.json({ok:true,id});
  }catch(e){console.error('Paylaşılan sepet kayıt:',e);res.status(500).json({ok:false})}
});
app.get('/api/shared-cart/:id',(req,res)=>{
  const id=String(req.params.id||'');if(!/^[a-f0-9]{24}$/.test(id)&&!/^[a-f0-9]{8}$/.test(id))return res.status(404).json({ok:false});
  const f=path.join(sharedCartDir,id+'.json');if(!fs.existsSync(f))return res.status(404).json({ok:false});
  try{res.json({ok:true,cart:JSON.parse(fs.readFileSync(f,'utf8'))})}catch(e){res.status(404).json({ok:false})}
});

app.get('/api/settings',(req,res)=>{res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');res.setHeader('Pragma','no-cache');res.setHeader('Expires','0');res.json(readJson('settings.json',{}))});
app.use(['/api/account','/api/addresses','/api/orders','/api/admin/users','/api/admin/customers-all','/api/admin/customer','/api/admin/orders','/api/admin/activity'],(req,res,next)=>{res.setHeader('Cache-Control','no-store');res.setHeader('Pragma','no-cache');res.setHeader('Expires','0');next()});
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
app.patch('/api/orders/status',requireAdmin,async(req,res)=>serializedMutation('orders',async()=>{
 const ids=Array.isArray(req.body.ids)?req.body.ids:[]; const status=req.body.status;
 if(!['new','prepared','shipped','delivered'].includes(status))return res.status(400).json({ok:false});
 try{
   await sheetsRequest({action:'status',ids,status});
 }catch(e){
   console.error('Google E-Tablo durum güncelleme hatası:',e);
   return res.status(503).json({ok:false,message:'Durum Google E-Tablo’ya kaydedilemedi. Tekrar deneyin.'});
 }
 const orders=readJson('orders.json',[]); const now=new Date().toISOString();
 const changed=[];orders.forEach(o=>{if(ids.includes(o.id)&&o.status!==status){o.status=status;o.statusUpdatedAt=now;changed.push(o)}});
 writeJson('orders.json',orders);for(const o of changed)await sendOrderStatusPush(o,status);if(changed.length){writeJson('orders.json',orders);await persistOrdersToGithub().catch(e=>{console.error('Sipariş durum kalıcı kayıt:',e);throw e})}
 return res.json({ok:true,orders});
}));
app.patch('/api/orders/:id',requireAdmin,async(req,res)=>serializedMutation('orders',async()=>{
  const id=String(req.params.id||'').trim();
  const orders=readJson('orders.json',[]);
  const order=orders.find(o=>String(o.id||'')===id);
  if(!order)return res.status(404).json({ok:false,message:'Sipariş bulunamadı.'});
  const body=req.body&&typeof req.body==='object'?req.body:{};
  const customerPatch=body.customer&&typeof body.customer==='object'?body.customer:{};
  order.customer=(order.customer&&typeof order.customer==='object')?order.customer:{};
  const customerFields=['fullName','phone','extraPhone','province','district','neighborhood','avenue','street','fullAddress','buildingNo','floor','doorNo','businessName','branchName','note','deliveryMode','placeType'];
  for(const key of customerFields)if(Object.prototype.hasOwnProperty.call(customerPatch,key))order.customer[key]=String(customerPatch[key]??'').trim();
  if(Object.prototype.hasOwnProperty.call(customerPatch,'phone')){const phone=normalizeTRMobile(customerPatch.phone);if(!phone)return res.status(400).json({ok:false,message:'Telefon numarası geçersiz.'});order.customer.phone=phone}
  if(Object.prototype.hasOwnProperty.call(customerPatch,'extraPhone')){const raw=String(customerPatch.extraPhone||'').trim(),extra=raw?normalizeTRMobile(raw):'';if(raw&&!extra)return res.status(400).json({ok:false,message:'2. telefon numarası geçersiz.'});if(extra&&extra===order.customer.phone)return res.status(400).json({ok:false,message:'İki telefon numarası aynı olamaz.'});order.customer.extraPhone=extra}
  if(Object.prototype.hasOwnProperty.call(body,'payment')){const payment=String(body.payment||'').trim();if(payment)order.payment=payment}
  if(Object.prototype.hasOwnProperty.call(body,'total')){const total=Number(body.total);if(!Number.isFinite(total)||total<0)return res.status(400).json({ok:false,message:'Toplam tutar geçersiz.'});order.total=total}
  if(Array.isArray(body.items))body.items.forEach((patch,i)=>{const item=order.items?.[i];if(!item||!patch||typeof patch!=='object')return;item.product=(item.product&&typeof item.product==='object')?item.product:{};if(Object.prototype.hasOwnProperty.call(patch,'name'))item.product.name=String(patch.name||'').trim()||item.product.name||'Ürün';if(Object.prototype.hasOwnProperty.call(patch,'price')){const price=Number(patch.price);if(Number.isFinite(price)&&price>=0)item.product.price=price}if(Object.prototype.hasOwnProperty.call(patch,'qty'))item.qty=Math.max(1,Math.floor(Number(patch.qty)||1))});
  try{await sheetsRequest({action:'update',requestId:order.requestId,order})}catch(e){console.error('Google E-Tablo sipariş düzenleme hatası:',e);return res.status(503).json({ok:false,message:'Sipariş Google E-Tablo ile eşitlenemedi. Tekrar deneyin.'})}
  writeJson('orders.json',orders);await persistOrdersToGithub().catch(e=>{console.error('Sipariş düzenleme kalıcı kayıt:',e);throw e});return res.json({ok:true,order});
}));
app.delete('/api/orders',requireAdmin,async(req,res)=>serializedMutation('orders',async()=>{
  const ids=Array.isArray(req.body?.ids)?req.body.ids.map(x=>String(x||'').trim()).filter(Boolean):[];if(!ids.length)return res.status(400).json({ok:false,message:'Silinecek sipariş seçilmedi.'});
  const idSet=new Set(ids),orders=readJson('orders.json',[]),removed=orders.filter(o=>idSet.has(String(o.id||''))),kept=orders.filter(o=>!idSet.has(String(o.id||'')));
  if(!removed.length)return res.status(404).json({ok:false,message:'Seçili siparişler bulunamadı.'});
  for(const o of removed){try{await sheetsRequest({action:'delete',id:o.id,requestId:o.requestId})}catch(e){console.error('Google E-Tablo sipariş silme hatası:',e);return res.status(503).json({ok:false,message:'Sipariş Google E-Tablo ile eşitlenemedi. Tekrar deneyin.'})}}
  writeJson('orders.json',kept);await persistOrdersToGithub().catch(e=>{console.error('Toplu sipariş silme kalıcı kayıt:',e);throw e});return res.json({ok:true,removedCount:removed.length});
}));
app.delete('/api/orders/:id',requireAdmin,async(req,res)=>serializedMutation('orders',async()=>{
  const id=String(req.params.id||'').trim(),orders=readJson('orders.json',[]),index=orders.findIndex(o=>String(o.id||'')===id);if(index<0)return res.status(404).json({ok:false,message:'Sipariş bulunamadı.'});
  const removed=orders[index];try{await sheetsRequest({action:'delete',id:removed.id,requestId:removed.requestId})}catch(e){console.error('Google E-Tablo sipariş silme hatası:',e);return res.status(503).json({ok:false,message:'Sipariş Google E-Tablo ile eşitlenemedi. Tekrar deneyin.'})}
  orders.splice(index,1);writeJson('orders.json',orders);await persistOrdersToGithub().catch(e=>{console.error('Sipariş silme kalıcı kayıt:',e);throw e});return res.json({ok:true,removedId:removed?.id||id});
}));

app.get('/api/orders/export.xlsx',requireAdmin,async(req,res)=>serializedMutation('orders',async()=>{
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
 await persistOrdersToGithub().catch(e=>{console.error('Excel export kalıcı kayıt:',e);throw e});

 const stamp=new Intl.DateTimeFormat('sv-SE',{
   timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit',
   hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false
 }).format(exportNow).replace(' ','_').replaceAll(':','-');

 res.setHeader('X-SHAZ-Exported-At',exportAtTR);
 res.setHeader('Content-Disposition',`attachment; filename=SHAZ-Siparisler-${stamp}.xlsx`);
 res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
}));
let lastOrderIngress={at:'',requestId:'',ok:null,error:''};
app.get('/api/orders/last-ingress',requireAdmin,(req,res)=>res.json({ok:true,...lastOrderIngress}));

app.post('/api/orders',async(req,res)=>serializedMutation('orders',async()=>{
 if(rateLimitHit(req,'order-create',25,15*60*1000))return res.status(429).json({ok:false,message:'Çok fazla sipariş isteği. Lütfen biraz sonra tekrar deneyin.'});
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
   const prepared=serverPrepareOrderItems(body.items);body.items=prepared.items;const campaignResult=serverCampaignPricing(body.items,prepared.catalog),preCouponTotal=campaignResult.total;
   body.subtotal=campaignResult.subtotal;body.discountTotal=campaignResult.discount;body.appliedCampaigns=campaignResult.applied;
   const couponResult=evaluateOrderCoupons(signedUser?.id||null,body.appliedCouponIds,preCouponTotal);
   if(!couponResult.ok)return res.status(400).json({ok:false,message:couponResult.message});
   body.preCouponTotal=preCouponTotal;body.couponDiscountTotal=couponResult.discount;body.appliedCoupons=couponResult.coupons;body.total=couponResult.total;
   const hasPersonal=(body.items||[]).some(x=>!!x.personalized);
   const legal=body.legalAcceptances&&typeof body.legalAcceptances==='object'?body.legalAcceptances:{};
   if(!legal.preInformation||!legal.distanceSales)return res.status(400).json({ok:false,message:'Lütfen sözleşmeleri onaylayın.'});
   const legalRefs=body.legalDocumentRefs&&typeof body.legalDocumentRefs==='object'?body.legalDocumentRefs:{};for(const type of ['PRE_INFORMATION','DISTANCE_SALES']){const doc=currentLegalDoc(type),seen=legalRefs[type]||{};if(!doc||String(seen.version||'')!==String(doc.version||'')||String(seen.hash||'')!==String(legalHash(doc)||''))return res.status(409).json({ok:false,message:'Sözleşme metni güncellendi. Lütfen güncel metni tekrar açıp onaylayın.'})}
   if(hasPersonal&&(!legal.personalization||!legal.personalizationNotice))return res.status(400).json({ok:false,message:'Lütfen kişiselleştirme bilgilerinizi kontrol edip onaylayın.'});
   body.personalizationSnapshots=personalizationSnapshots(body.items);
   const savedOrderAddress=signedUser?saveOrderAddressForUser(signedUser,body.customer):null;
   if(savedOrderAddress)body.customer.savedAddressId=savedOrderAddress.id;

   // Siparişin ana kaydı önce sunucu/panele yapılır. Google E-Tablo geçici olarak cevap vermese bile
   // müşteri siparişi kaybolmaz ve tekrar adres girmek zorunda kalmaz.
   const order={id:nextLocalOrderId(orders),createdAt,createdAtTR,status:'new',statusUpdatedAt:createdAt,requestId,sheetSyncStatus:'pending',sheetSyncError:'',deviceId:String(req.body?.deviceId||'').trim()||null,...body};
   orders.unshift(order);
   writeJson('orders.json',orders);
   await sendOrderStatusPush(order,'new');writeJson('orders.json',orders);
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
   await persistOrdersToGithub().catch(e=>{console.error('Sipariş kalıcı kayıt:',e);throw e});
   setTimeout(()=>syncPendingOrdersToSheets(),0);

   lastOrderIngress={at:ingressAt,requestId,ok:true,error:''};
   return res.json({ok:true,order,pendingSheet:true});
 }catch(e){
   console.error('Sipariş yerel kayıt hatası:',e);
   lastOrderIngress={at:ingressAt,requestId:String(req.body?.requestId||''),ok:false,error:String(e?.message||e)};
   return res.status(500).json({ok:false,message:'Sipariş sunucuya kaydedilemedi. Lütfen tekrar deneyin.'});
 }

}));

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

app.get('/api/customer-image/:token',(req,res)=>{const token=String(req.params.token||'');if(!/^[a-f0-9]{48}\.(?:jpg|png|webp)$/.test(token))return res.status(404).end();const f=path.join(privateUploadDir,token);if(!fs.existsSync(f))return res.status(404).end();res.setHeader('Cache-Control','private, no-store');res.sendFile(f)});
app.post('/api/customer-upload',sameOriginGuard,customerUpload.array('files',1),async(req,res)=>{
 try{
   if(rateLimitHit(req,'customer-upload',30,15*60*1000))return res.status(429).json({ok:false,message:'Çok fazla fotoğraf yükleme isteği. Lütfen biraz sonra tekrar deneyin.'});
   const f=(req.files||[])[0];if(!f)return res.status(400).json({ok:false,message:'Fotoğraf seçilmedi.'});
   let meta;try{meta=await sharp(f.path,{failOn:'error',limitInputPixels:60_000_000}).metadata()}catch(e){try{fs.unlinkSync(f.path)}catch(_){}return res.status(400).json({ok:false,message:'Yüklenen dosya geçerli bir fotoğraf değil.'})}
   if(!['jpeg','png','webp'].includes(String(meta.format||''))){try{fs.unlinkSync(f.path)}catch(_){}return res.status(400).json({ok:false,message:'Lütfen JPG, PNG veya WEBP fotoğraf yükleyin.'})}
   if(Number(meta.width||0)>12000||Number(meta.height||0)>12000){try{fs.unlinkSync(f.path)}catch(_){}return res.status(400).json({ok:false,message:'Fotoğraf boyutları çok büyük.'})}
   const ext=meta.format==='jpeg'?'jpg':meta.format,filename=crypto.randomBytes(24).toString('hex')+'.'+ext,out=path.join(privateUploadDir,filename),img=sharp(f.path,{failOn:'error',limitInputPixels:60_000_000}).rotate();
   if(ext==='jpg')await img.jpeg({quality:92,mozjpeg:true}).toFile(out);else if(ext==='png')await img.png({compressionLevel:9}).toFile(out);else await img.webp({quality:92}).toFile(out);
   try{fs.unlinkSync(f.path)}catch(_){}
   res.json({ok:true,files:[{name:f.originalname,filename,url:'/api/customer-image/'+filename}],github:{ok:false,skipped:true,private:true}});
 }catch(e){console.error('Müşteri fotoğraf yükleme:',e);res.status(500).json({ok:false,message:'Fotoğraf yüklenemedi. Lütfen tekrar deneyin.'})}
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
  const users=readJson('users.json',[]),socialMatches=users.filter(x=>(x.socialIds&&x.socialIds[identity.provider]===identity.sub)||(identity.email&&x.email===identity.email));let u=socialMatches.find(x=>!x.deleted)||socialMatches[0];const now=new Date().toISOString();let created=false;
  if(!u){if(!identity.email)throw new Error('Hesap e-postası alınamadı.');const id='USR-'+crypto.randomUUID(),customerId='CUS-'+crypto.randomUUID();u={id,customerId,firstName:String(extra.firstName||identity.firstName||'').trim()||'SHAZ',lastName:String(extra.lastName||identity.lastName||'').trim(),email:identity.email,phone:'',birthDate:'',phoneVerifiedAt:null,passwordSalt:'',passwordHash:'',authVersion:1,authProviders:['password'],socialIds:{},smsMarketingConsent:false,emailMarketingConsent:false,authProviders:[identity.provider],socialIds:{[identity.provider]:identity.sub},createdAt:now,updatedAt:now,disabled:false};users.push(u);writeJson('users.json',users);const customers=readJson('customers.json',[]);customers.push({id:customerId,userId:id,firstName:u.firstName,lastName:u.lastName,email:u.email,phone:'',createdAt:now,updatedAt:now});writeJson('customers.json',customers);created=true}else{if(u.deleted)throw new Error('Bu kullanıcı silinmiştir. Aynı bilgilerle baştan yeni bir hesap oluşturabilirsiniz.');if(u.disabled)throw new Error('Bu üyelik yönetim tarafından iptal edilmiş.');u.authProviders=Array.from(new Set([...(u.authProviders||[]),identity.provider]));u.socialIds={...(u.socialIds||{}),[identity.provider]:identity.sub};if(!u.firstName&&extra.firstName)u.firstName=String(extra.firstName);if(!u.lastName&&extra.lastName)u.lastName=String(extra.lastName);u.updatedAt=now;writeJson('users.json',users)}
  if(created)assignNewMemberCoupons(u.id,now);return u;
}

function emailHtmlEscape(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}
function shazTransactionalLogoUrl(){const base=/^https:\/\//i.test(PUBLIC_BASE_URL)?PUBLIC_BASE_URL:SHAZ_ORIGIN;return `${base}/api/brand-image?v=${BUILD_VERSION}`}
function shazTransactionalEmailHtml({title,intro='',body='',code='',actionLabel='',actionUrl='',securityNote=''}){const logo=emailHtmlEscape(shazTransactionalLogoUrl()),safeTitle=emailHtmlEscape(title),safeIntro=emailHtmlEscape(intro),safeBody=emailHtmlEscape(body),safeCode=emailHtmlEscape(code),safeAction=emailHtmlEscape(actionLabel),safeUrl=emailHtmlEscape(actionUrl),safeNote=emailHtmlEscape(securityNote);return `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#171717"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f5f5f5"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;background:#ffffff;border:1px solid #e8e8e8;border-radius:8px"><tr><td align="center" style="padding:28px 28px 18px;border-bottom:1px solid #eeeeee"><img src="${logo}" alt="SHAZ" width="118" style="display:block;width:118px;max-width:42%;height:auto;margin:0 auto;border:0"></td></tr><tr><td style="padding:28px"><h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;text-align:center;color:#111111">${safeTitle}</h1>${safeIntro?`<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#333333">${safeIntro}</p>`:''}${safeBody?`<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#333333">${safeBody}</p>`:''}${safeCode?`<div style="margin:22px 0;padding:18px 12px;border:1px solid #dedede;background:#fafafa;text-align:center;font-size:32px;line-height:1;font-weight:800;letter-spacing:7px;color:#111111">${safeCode}</div>`:''}${safeAction&&safeUrl?`<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:24px auto"><tr><td bgcolor="#111111" style="border-radius:5px"><a href="${safeUrl}" style="display:inline-block;padding:13px 20px;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700">${safeAction}</a></td></tr></table>`:''}${safeNote?`<p style="margin:20px 0 0;padding-top:18px;border-top:1px solid #eeeeee;font-size:13px;line-height:1.55;color:#666666">${safeNote}</p>`:''}<p style="margin:22px 0 0;font-size:12px;color:#8a8a8a;text-align:center">SHAZ</p></td></tr></table></td></tr></table></body></html>`}
async function sendShazTransactionalEmail({to,subject,title,intro='',body='',code='',actionLabel='',actionUrl='',securityNote='',text=''}){if(!RESEND_API_KEY)return false;const html=shazTransactionalEmailHtml({title,intro,body,code,actionLabel,actionUrl,securityNote}),plain=String(text||[title,intro,body,code?`Kod: ${code}`:'',actionUrl||'',securityNote,'SHAZ'].filter(Boolean).join('\n\n'));const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:PASSWORD_RESET_FROM,to:[to],subject,html,text:plain})});return r.ok}
async function sendPasswordResetMail(email,link){return sendShazTransactionalEmail({to:email,subject:'SHAZ Şifre Sıfırlama',title:'Şifrenizi Yenileyin',intro:'SHAZ hesabınızın şifresini yenilemek için aşağıdaki bağlantıyı kullanın.',actionLabel:'Şifremi yenile',actionUrl:link,securityNote:'Bu bağlantı 30 dakika geçerlidir. Bu işlemi siz başlatmadıysanız bu e-postayı dikkate almayabilirsiniz.'})}
async function sendEmailChangeVerificationMail(email,code){return sendShazTransactionalEmail({to:email,subject:'SHAZ E-posta Değişikliği Doğrulama Kodu',title:'E-posta Değişikliğini Doğrulayın',intro:'SHAZ hesabınızın e-posta adresini değiştirmek için doğrulama kodunuz:',code,securityNote:'Bu kod 5 dakika boyunca geçerlidir. Bu işlemi siz başlatmadıysanız bu e-postayı dikkate almayabilirsiniz.'})}
async function sendEmailChangedSecurityMail(oldEmail,newEmail){return sendShazTransactionalEmail({to:oldEmail,subject:'SHAZ Hesabınızın E-posta Adresi Değiştirildi',title:'E-posta Adresiniz Değiştirildi',intro:'SHAZ hesabınızın e-posta adresi başarıyla değiştirildi.',body:`Yeni e-posta: ${maskRegistrationEmail(newEmail)}`,securityNote:'Bu işlemi siz yapmadıysanız hesabınızın şifresini sıfırlayın ve SHAZ desteğiyle iletişime geçin.'})}
const REGISTRATION_CHALLENGE_COOKIE='shaz_registration_challenge';
const REGISTRATION_OTP_TTL_MS=5*60*1000;
const REGISTRATION_PENDING_TTL_MS=24*60*60*1000;
const REGISTRATION_RESEND_COOLDOWN_MS=60*1000;
const EMAIL_CHANGE_OTP_TTL_MS=5*60*1000;
const EMAIL_CHANGE_RESEND_COOLDOWN_MS=60*1000;
const registrationMailRateBuckets=new Map();
function appendSetCookie(res,value){const old=res.getHeader('Set-Cookie');if(!old)return res.setHeader('Set-Cookie',value);res.setHeader('Set-Cookie',Array.isArray(old)?[...old,value]:[old,value])}
function setRegistrationChallengeCookie(res,req,token){const secure=process.env.NODE_ENV==='production'||String(req.headers['x-forwarded-proto']||'').includes('https');appendSetCookie(res,`${REGISTRATION_CHALLENGE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${REGISTRATION_PENDING_TTL_MS/1000}${secure?'; Secure':''}`)}
function clearRegistrationChallengeCookie(res,req){const secure=process.env.NODE_ENV==='production'||String(req.headers['x-forwarded-proto']||'').includes('https');appendSetCookie(res,`${REGISTRATION_CHALLENGE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure?'; Secure':''}`)}
function registrationChallengeHash(token){return crypto.createHash('sha256').update(String(token||'')).digest('hex')}
function registrationOtpHash(id,code){return crypto.createHmac('sha256',USER_SESSION_SECRET).update(String(id||'')+':'+String(code||'')).digest('hex')}
function emailChangeOtpHash(userId,email,code){return crypto.createHmac('sha256',USER_SESSION_SECRET).update(`email_change:${String(userId||'')}:${normalizeEmail(email)}:${String(code||'')}`).digest('hex')}
function newRegistrationOtp(){return String(crypto.randomInt(0,1000000)).padStart(6,'0')}
function maskRegistrationEmail(email){const [local,domain]=String(email||'').split('@');if(!domain)return '';return (local?local.slice(0,1):'')+'***@'+domain}
function cleanPendingRegistrations(rows){const cut=Date.now()-REGISTRATION_PENDING_TTL_MS;return (Array.isArray(rows)?rows:[]).filter(x=>new Date(x?.createdAt||0).getTime()>=cut)}
function pendingRegistrationFromReq(req,rows=readJson('pending_registrations.json',[])){const token=parseCookies(req)[REGISTRATION_CHALLENGE_COOKIE]||'';if(!token)return null;const hash=registrationChallengeHash(token);return (rows||[]).find(x=>x.challengeHash===hash)||null}
function verificationMailRateHit(req,email,limit=6,windowMs=60*60*1000){const now=Date.now(),emailKey=crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0,24),ip=accountRateKey(req);const hit=(key,max)=>{const x=registrationMailRateBuckets.get(key);if(!x||now-x.start>windowMs){registrationMailRateBuckets.set(key,{start:now,count:1});return false}x.count++;registrationMailRateBuckets.set(key,x);return x.count>max};return hit('verify-mail:email:'+emailKey,limit)||hit('verify-mail:ip:'+ip,30)}
async function sendRegistrationVerificationMail(email,code){return sendShazTransactionalEmail({to:email,subject:'SHAZ E-posta Doğrulama Kodu',title:'E-posta Adresinizi Doğrulayın',intro:'SHAZ üyeliğinizi tamamlamak için doğrulama kodunuz:',code,securityNote:'Bu kod 5 dakika boyunca geçerlidir. Bu işlemi siz başlatmadıysanız bu e-postayı dikkate almayabilirsiniz.'})}

// ---------- v153 hukuki metin yönetimi (mevcut admin içinde minimum ekran) ----------
function adminMemberRows(){
  const users=readJson('users.json',[]),addresses=readJson('addresses.json',[]),orders=readJson('orders.json',[]),coupons=readJson('coupons.json',[]),acts=readJson('customer_activity.json',[]);
  return users.map(u=>{
    const userAddresses=addresses.filter(a=>a.userId===u.id).map(a=>({...a,phone:normalizeAccountPhone(a.phone)||a.phone||'',extraPhone:normalizeAccountPhone(a.extraPhone)||a.extraPhone||''}));
    const primary=userAddresses.find(a=>a.isDefault)||userAddresses[0]||{},userCoupons=coupons.filter(c=>c.userId===u.id).map(c=>({...c}));
    const ua=acts.filter(x=>x.userId===u.id||x.customerId===u.customerId),visits=ua.flatMap(x=>x.visits||[]).sort(),pwaVisits=ua.filter(x=>x.pwa||x.lastPwaAt),lastPwaAt=pwaVisits.map(x=>x.lastPwaAt).filter(Boolean).sort().at(-1)||'';return {id:u.id,customerId:u.customerId,firstName:u.firstName||'',lastName:u.lastName||'',email:u.email||'',phone:normalizeAccountPhone(u.phone)||u.phone||'',extraPhone:primary.extraPhone||'',lastSeenAt:visits.at(-1)||'',lastPwaAt,pwaActive:!!lastPwaAt,visitCount:visits.length,visits,birthDate:u.birthDate||'',phoneVerifiedAt:u.phoneVerifiedAt||null,smsMarketingConsent:!!u.smsMarketingConsent,emailMarketingConsent:!!u.emailMarketingConsent,disabled:!!u.disabled,disabledAt:u.disabledAt||null,deleted:!!u.deleted,deletedAt:u.deletedAt||null,authProviders:Array.isArray(u.authProviders)?u.authProviders:(u.passwordHash?['password']:[]),createdAt:u.createdAt||'',addressCount:userAddresses.length,orderCount:orders.filter(o=>o.userId===u.id||o.customerId===u.customerId).length,couponCount:userCoupons.length,coupons:userCoupons,profileChangeHistory:Array.isArray(u.profileChangeHistory)?u.profileChangeHistory:[],province:primary.province||'',district:primary.district||'',address:[primary.neighborhood,primary.avenue,primary.street,primary.fullAddress,primary.buildingNo?`Bina ${primary.buildingNo}`:'',primary.floor?`Kat ${primary.floor}`:'',primary.doorNo?`Daire ${primary.doorNo}`:''].filter(Boolean).join(' · '),addresses:userAddresses};
  });
}
function filterAdminMembers(rows,q={}){
  const search=String(q.search||'').trim().toLocaleLowerCase('tr-TR'),province=String(q.province||'').trim().toLocaleLowerCase('tr-TR'),district=String(q.district||'').trim().toLocaleLowerCase('tr-TR'),sms=String(q.sms||''),emailMarketing=String(q.emailMarketing||''),provider=String(q.provider||'').trim().toLowerCase(),status=String(q.status||'').trim().toLowerCase(),dateFrom=String(q.dateFrom||'').trim(),dateTo=String(q.dateTo||'').trim();
  const fromTs=dateFrom?new Date(dateFrom+'T00:00:00').getTime():0,toTs=dateTo?new Date(dateTo+'T23:59:59.999').getTime():0;
  let out=rows.filter(u=>{const hay=[u.firstName,u.lastName,u.email,u.phone,u.province,u.district,u.address].join(' ').toLocaleLowerCase('tr-TR');const providers=(u.authProviders||[]).map(x=>String(x).toLowerCase()),createdTs=new Date(u.createdAt||0).getTime();return (!search||hay.includes(search))&&(!province||String(u.province||'').toLocaleLowerCase('tr-TR')===province)&&(!district||String(u.district||'').toLocaleLowerCase('tr-TR')===district)&&(!sms||String(!!u.smsMarketingConsent)===sms)&&(!emailMarketing||String(!!u.emailMarketingConsent)===emailMarketing)&&(!provider||providers.includes(provider))&&(!status||(status==='active'?!u.disabled&&!u.deleted:status==='disabled'?u.disabled&&!u.deleted:status==='deleted'?!!u.deleted:true))&&(!fromTs||createdTs>=fromTs)&&(!toTs||createdTs<=toTs)});
  const sort=String(q.sort||'newest');
  out.sort((a,b)=>sort==='name'?`${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`,'tr'):sort==='orders'?Number(b.orderCount||0)-Number(a.orderCount||0):sort==='province'?`${a.province} ${a.district}`.localeCompare(`${b.province} ${b.district}`,'tr'):new Date(b.createdAt||0)-new Date(a.createdAt||0));
  return out;
}
app.get('/api/admin/users',requireAdmin,(req,res)=>res.json({ok:true,users:adminMemberRows()}));
app.get('/api/admin/users/export.xlsx',requireAdmin,(req,res)=>{
  const rows=filterAdminMembers(adminMemberRows(),req.query).map(u=>({
    'Ad Soyad':[u.firstName,u.lastName].filter(Boolean).join(' '),'Telefon':u.phone,'E-posta':u.email,'Doğum Tarihi':u.birthDate,'İl':u.province,'İlçe':u.district,'Adres':u.address,'Tüm Adresler':(u.addresses||[]).map(a=>[a.title,a.fullName,a.phone,a.province,a.district,a.neighborhood,a.avenue,a.street,a.fullAddress,a.buildingNo?`Bina ${a.buildingNo}`:'',a.floor?`Kat ${a.floor}`:'',a.doorNo?`Daire ${a.doorNo}`:''].filter(Boolean).join(' · ')).join(' | '),'Toplam Sipariş':u.orderCount,'Üyelik Tarihi':u.createdAt,'SMS İzni':u.smsMarketingConsent?'Açık':'Kapalı','E-posta İzni':u.emailMarketingConsent?'Açık':'Kapalı','Giriş Yöntemi':(u.authProviders||[]).join(', '),'Üyelik Durumu':u.deleted?'Silinmiş':u.disabled?'Kapalı':'Aktif'
  }));
  const wb=XLSX.utils.book_new(),ws=XLSX.utils.json_to_sheet(rows);XLSX.utils.book_append_sheet(wb,ws,'Üyeler');
  const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename="SHAZ-Uyeler.xlsx"');res.send(buf);
});
function normalizeAdminCouponInput(body,current={}){
  const rawCode=String(body.code??current.code??'').trim().toLocaleUpperCase('tr-TR'),code=(rawCode.replaceAll('İ','I').replaceAll('Ş','S').replaceAll('Ğ','G').replaceAll('Ü','U').replaceAll('Ö','O').replaceAll('Ç','C').replaceAll('İ','I').replace(/[^A-Z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,32)||('SHAZ'+crypto.randomBytes(3).toString('hex').toUpperCase())),discountType=String(body.discountType??current.discountType??'percent')==='fixed'?'fixed':'percent';
  const value=Number(body.value??current.value??0),expiresAt=String((body.expiresAt ?? couponExpiryDateKey(current.expiresAt) ?? '')).trim(),title=String(body.title??current.title??'').trim(),headline=String(body.headline??current.headline??'').trim();
  const minRaw=body.minCartAmount??current.minCartAmount??'',minCartAmount=String(minRaw).trim()===''?0:Number(minRaw);
  const requestedStackable=String(body.stackable??(current.stackable?'yes':'no'))==='yes'||body.stackable===true,stackable=discountType==='percent'?false:requestedStackable;
  const maxRaw=body.maxDiscountAmount??current.maxDiscountAmount??'',maxDiscountAmount=discountType==='percent'&&String(maxRaw).trim()!==''?Number(maxRaw):0;
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
app.post('/api/admin/users/:id/cancel',requireAdmin,async(req,res)=>serializedMutation('accounts',async()=>{
  const users=readJson('users.json',[]),i=users.findIndex(u=>String(u.id)===String(req.params.id));if(i<0)return res.status(404).json({ok:false,message:'Üye bulunamadı.'});
  const u=users[i];if(u.disabled)return res.json({ok:true,alreadyDisabled:true});const now=new Date().toISOString();pushProfileHistory(u,'Üyelik Durumu','Aktif','İptal Edildi','admin');u.disabled=true;u.disabledAt=now;u.updatedAt=now;u.authVersion=Number(u.authVersion||1)+1;writeJson('users.json',users);
  await persistAccountStateToGithub().catch(e=>{console.error('Üyelik iptal kalıcı kayıt:',e);throw e});return res.json({ok:true});
}));
app.post('/api/admin/users/:id/reactivate',requireAdmin,async(req,res)=>serializedMutation('accounts',async()=>{
  const users=readJson('users.json',[]),i=users.findIndex(u=>String(u.id)===String(req.params.id));if(i<0)return res.status(404).json({ok:false,message:'Üye bulunamadı.'});
  const u=users[i],email=normalizeEmail(u.email),phone=normalizeAccountPhone(u.phone),conflict=users.find(x=>x.id!==u.id&&!x.deleted&&((email&&normalizeEmail(x.email)===email)||(phone&&normalizeAccountPhone(x.phone)===phone)));if(conflict)return res.status(409).json({ok:false,message:'Aynı e-posta veya telefonla aktif başka bir hesap bulunduğu için bu eski kayıt yeniden açılamaz.'});
  const now=new Date().toISOString(),oldStatus=u.deleted?'Silinmiş':u.disabled?'İptal Edildi':'Aktif';pushProfileHistory(u,'Üyelik Durumu',oldStatus,'Aktif','admin');u.disabled=false;u.disabledAt=null;u.deleted=false;u.deletedAt=null;u.updatedAt=now;u.authVersion=Number(u.authVersion||1)+1;writeJson('users.json',users);
  const customers=readJson('customers.json',[]);if(!customers.some(c=>c.id===u.customerId||c.userId===u.id))customers.push({id:u.customerId||('CUS-'+crypto.randomUUID()),userId:u.id,firstName:u.firstName||'',lastName:u.lastName||'',email:u.email||'',phone:u.phone||'',createdAt:u.createdAt||now,updatedAt:now});writeJson('customers.json',customers);
  await persistAccountStateToGithub().catch(e=>{console.error('Üye yeniden açma kalıcı kayıt:',e);throw e});return res.json({ok:true});
}));
app.delete('/api/admin/users/:id',requireAdmin,async(req,res)=>serializedMutation('accounts',async()=>{
  const id=String(req.params.id),users=readJson('users.json',[]),i=users.findIndex(x=>String(x.id)===id);if(i<0)return res.status(404).json({ok:false,message:'Üye bulunamadı.'});
  const u=users[i],now=new Date().toISOString();if(!u.deleted)pushProfileHistory(u,'Üyelik Durumu',u.disabled?'İptal Edildi':'Aktif','Silinmiş','admin');u.deleted=true;u.deletedAt=now;u.disabled=true;u.disabledAt=u.disabledAt||now;u.updatedAt=now;u.authVersion=Number(u.authVersion||1)+1;writeJson('users.json',users);
  writeJson('customers.json',readJson('customers.json',[]).filter(x=>x.id!==u.customerId&&x.userId!==u.id));for(const f of ['addresses.json','favorites.json','coupons.json','marketing_consents.json'])writeJson(f,readJson(f,[]).filter(x=>x.userId!==u.id));writeJson('push_subscriptions.json',readJson('push_subscriptions.json',[]).filter(x=>x.userId!==u.id&&x.customerId!==u.customerId));writeJson('customer_activity.json',readJson('customer_activity.json',[]).filter(x=>x.userId!==u.id&&x.customerId!==u.customerId));
  await persistAccountStateToGithub().catch(e=>{console.error('Üye silme kalıcı kayıt:',e);throw e});return res.json({ok:true,deleted:true});
}));
app.patch('/api/admin/users/:id/profile',requireAdmin,async(req,res)=>{return serializedMutation('accounts',async()=>{const users=readJson('users.json',[]),i=users.findIndex(u=>String(u.id)===String(req.params.id));if(i<0)return res.status(404).json({ok:false,message:'Üye bulunamadı.'});const u=users[i],now=new Date().toISOString(),fields=['firstName','lastName','email','phone','birthDate'];for(const field of fields){if(!Object.prototype.hasOwnProperty.call(req.body,field))continue;let value=String(req.body[field]||'').trim();if(field==='email'){value=normalizeEmail(value);if(!value.includes('@'))return res.status(400).json({ok:false,message:'Geçerli e-posta girin.'});if(users.some(x=>x.id!==u.id&&!x.deleted&&normalizeEmail(x.email)===value))return res.status(409).json({ok:false,message:'Bu e-posta başka bir üyede kullanılıyor.'})}if(field==='phone'){value=normalizeAccountPhone(value);if(!value)return res.status(400).json({ok:false,message:'Geçerli telefon girin.'});if(users.some(x=>x.id!==u.id&&!x.deleted&&normalizeAccountPhone(x.phone)===value))return res.status(409).json({ok:false,message:'Bu telefon başka bir üyede kullanılıyor.'});if(value!==normalizeAccountPhone(u.phone))u.phoneVerifiedAt=null}if(field==='birthDate'&&!validBirthDateIso(value))return res.status(400).json({ok:false,message:'Geçerli doğum tarihi girin.'});const label={firstName:'Ad',lastName:'Soyad',email:'E-posta',phone:'Telefon',birthDate:'Doğum Tarihi'}[field];if(field==='email'&&value!==normalizeEmail(u.email)){u.emailVerifiedAt=null;u.pendingEmailChange=null}pushProfileHistory(u,label,u[field]||'',value,'admin');u[field]=value}u.updatedAt=now;writeJson('users.json',users);const customers=readJson('customers.json',[]),ci=customers.findIndex(c=>c.id===u.customerId);if(ci>=0){Object.assign(customers[ci],{firstName:u.firstName,lastName:u.lastName,email:u.email,phone:u.phone,updatedAt:now});writeJson('customers.json',customers)}await persistAccountStateToGithub().catch(e=>{console.error('Admin üye kalıcı kayıt:',e);throw e});return res.json({ok:true,user:publicUser(u)})})});
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
app.get('/api/legal-documents',(req,res)=>res.json({ok:true,documents:readLegalDocuments().filter(d=>d.active!==false).map(d=>({type:d.type,version:d.version,hash:legalHash(d),title:d.title,content:d.content||'',active:d.active!==false}))}));

function notificationSettings(){const d={statuses:{new:{enabled:true,title:'SHAZ',body:'Siparişiniz alındı. Bizi tercih ettiğiniz için teşekkür ederiz.'},prepared:{enabled:true,title:'SHAZ',body:'Siparişiniz hazırlanıyor.'},shipped:{enabled:true,title:'SHAZ',body:'Siparişiniz kargoya verildi. Kargo sürecinizi takip etmek için bildirime dokunun.'},delivered:{enabled:true,title:'SHAZ',body:'Siparişiniz teslim edildi. SHAZ’ı tercih ettiğiniz için teşekkür ederiz.'}},manualTitleHistory:[]};const s=readJson('notification_settings.json',d);s.statuses={...d.statuses,...(s.statuses||{})};s.manualTitleHistory=[...new Map((Array.isArray(s.manualTitleHistory)?s.manualTitleHistory:[]).map(x=>{const v=String(x||'').trim().slice(0,80);return [v.toLocaleLowerCase('tr-TR'),v]}).filter(x=>x[1])).values()].slice(0,20);return s}
function activityRows(){return readJson('customer_activity.json',[])}
const adminActivityStreams=new Set();
function publishAdminActivityVisit(row){const data=`data: ${JSON.stringify({type:'visit',userId:row?.userId||null,customerId:row?.customerId||null,pwa:!!row?.pwa,at:row?.lastSeenAt||new Date().toISOString()})}\n\n`;for(const stream of [...adminActivityStreams]){try{stream.write(data)}catch(_){adminActivityStreams.delete(stream)}}}
function recordCustomerVisit(req,body={}){const now=new Date().toISOString(),user=accountUserFromReq(req),deviceId=String(body.deviceId||'').trim();if(!deviceId)return;const rows=activityRows();let r=rows.find(x=>x.deviceId===deviceId);if(!r){r={id:'ACT-'+crypto.randomUUID(),deviceId,userId:user?.id||null,customerId:user?.customerId||null,visits:[],createdAt:now};rows.push(r)}if(user){r.userId=user.id;r.customerId=user.customerId}r.lastSeenAt=now;r.permission=String(body.permission||r.permission||'');if(body.pwa){r.pwa=true;r.lastPwaAt=now;r.firstPwaAt=r.firstPwaAt||now}r.visits=Array.isArray(r.visits)?r.visits:[];r.visits.push(now);if(r.visits.length>500)r.visits=r.visits.slice(-500);writeJson('customer_activity.json',rows);persistAccountStateAsync();publishAdminActivityVisit(r)}
// ---------- PWA / Web Push ----------
const VAPID_PUBLIC_KEY=String(process.env.VAPID_PUBLIC_KEY||'').trim();
const VAPID_PRIVATE_KEY=String(process.env.VAPID_PRIVATE_KEY||'').trim();
const VAPID_SUBJECT=String(process.env.VAPID_SUBJECT||'').trim();
let webPushReady=false,webPushConfigError='';
function decodeBase64Url(v){try{const s=String(v||'').replace(/-/g,'+').replace(/_/g,'/'),pad='='.repeat((4-s.length%4)%4);return Buffer.from(s+pad,'base64')}catch(_){return Buffer.alloc(0)}}
function validVapidSubject(v){if(/^mailto:[^\s@]+@[^\s@]+$/i.test(v))return true;try{const u=new URL(v);return u.protocol==='https:'}catch(_){return false}}
function validateVapidPair(){
  if(!webpush)throw new Error('web-push paketi kullanılamıyor.');
  if(!VAPID_PUBLIC_KEY||!VAPID_PRIVATE_KEY||!VAPID_SUBJECT)throw new Error('VAPID environment değişkenleri eksik.');
  if(!validVapidSubject(VAPID_SUBJECT))throw new Error('VAPID_SUBJECT geçersiz.');
  const pub=decodeBase64Url(VAPID_PUBLIC_KEY),priv=decodeBase64Url(VAPID_PRIVATE_KEY);
  if(pub.length!==65||priv.length!==32)throw new Error('VAPID anahtar formatı geçersiz.');
  const ecdh=crypto.createECDH('prime256v1');ecdh.setPrivateKey(priv);const derived=ecdh.getPublicKey();
  if(derived.length!==pub.length||!crypto.timingSafeEqual(derived,pub))throw new Error('VAPID public/private anahtarları aynı key pair değil.');
  webpush.setVapidDetails(VAPID_SUBJECT,VAPID_PUBLIC_KEY,VAPID_PRIVATE_KEY);
  return true;
}
try{webPushReady=validateVapidPair()}catch(e){webPushConfigError=String(e?.message||'VAPID yapılandırması geçersiz.');console.warn('VAPID yapılandırması geçersiz:',webPushConfigError)}

const PUSH_DELIVERY_LOG_FILE='push_delivery_log.json';
const pushSendIdempotency=new Map();
const pushSubscribeRate=new Map();
function safePushRecordId(row){return String(row?.id||crypto.createHash('sha256').update(String(row?.endpoint||'')).digest('hex').slice(0,12))}
function pushDeliveryLogs(){return readJson(PUSH_DELIVERY_LOG_FILE,[])}
function writePushDeliveryLogs(rows){writeJson(PUSH_DELIVERY_LOG_FILE,(Array.isArray(rows)?rows:[]).slice(-200))}
function createPushDeliveryLog(targetCount,kind){const rows=pushDeliveryLogs(),row={deliveryId:'DEL-'+crypto.randomUUID(),createdAt:new Date().toISOString(),kind:String(kind||'manual').slice(0,40),targetCount:Number(targetCount||0),providerAccepted:0,failed:0,cleaned:0,deviceAckCount:0,ackedSubscriptionIds:[],failureStatuses:{}};rows.push(row);writePushDeliveryLogs(rows);return row}
function updatePushDeliveryLog(deliveryId,patch){const rows=pushDeliveryLogs(),i=rows.findIndex(x=>x.deliveryId===deliveryId);if(i<0)return null;rows[i]={...rows[i],...patch};writePushDeliveryLogs(rows);return rows[i]}
function pushStats(){const rows=readJson('push_subscriptions.json',[]),cut=Date.now()-30*86400000;return {registered:rows.length,active30:rows.filter(x=>{const d=new Date(x.lastPushSuccessAt||x.updatedAt||x.createdAt||0).getTime();return Number.isFinite(d)&&d>=cut}).length,enabled:webPushReady,configError:webPushReady?'':webPushConfigError}}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function pushRetryAfterMs(e,attempt){const raw=e?.headers?.['retry-after']||e?.headers?.get?.('retry-after');const n=Number(raw);if(Number.isFinite(n)&&n>=0)return Math.min(10000,n*1000);return Math.min(2500,500*Math.pow(2,attempt))}
function pushErrorStatus(e){return Number(e?.statusCode||e?.status||0)||0}
function pushIsTransient(status){return status===429||status>=500||status===0}
async function runWithConcurrency(items,limit,worker){const out=new Array(items.length),next={i:0};async function run(){while(true){const i=next.i++;if(i>=items.length)return;try{out[i]=await worker(items[i],i)}catch(e){out[i]={ok:false,status:pushErrorStatus(e),error:String(e?.message||e)}}}}await Promise.all(Array.from({length:Math.max(1,Math.min(limit,items.length||1))},run));return out}
async function sendPushRows(rows,payload,opts={}){
  rows=Array.isArray(rows)?rows.filter(Boolean):[];
  const log=createPushDeliveryLog(rows.length,opts.kind||'manual'),deliveryId=log.deliveryId,all=readJson('push_subscriptions.json',[]),invalid=new Set();
  const ttl=Math.max(60,Math.min(86400,Number(opts.ttl||3600))),urgency=['very-low','low','normal','high'].includes(opts.urgency)?opts.urgency:'normal';
  const results=await runWithConcurrency(rows,6,async row=>{
    const id=safePushRecordId(row),target=all.find(x=>x.endpoint===row.endpoint),attemptAt=new Date().toISOString();if(target)target.lastPushAttemptAt=attemptAt;
    let lastStatus=0,lastError='',attempts=0;
    for(let attempt=0;attempt<2;attempt++){
      attempts=attempt+1;
      try{
        const perPayload={...payload,deliveryId,subscriptionId:id};
        if(String(payload?.type||'')==='manual'){const rua=String(row?.userAgent||'');perPayload.targetPlatform=/iPhone|iPad|iPod/i.test(rua)||(/Macintosh/i.test(rua)&&/Mobile/i.test(rua))?'ios':(/Android/i.test(rua)?'android':'unknown')}
        await webpush.sendNotification({endpoint:row.endpoint,keys:{p256dh:row.p256dh,auth:row.auth}},JSON.stringify(perPayload),{TTL:ttl,urgency,timeout:10000});
        const at=new Date().toISOString();if(target){target.lastPushSuccessAt=at;target.lastPushFailureAt=null;target.lastPushFailureStatus=null;target.updatedAt=at}
        return {id,ok:true,status:201,cleaned:false,attempts};
      }catch(e){
        const status=pushErrorStatus(e);lastStatus=status;lastError=String(e?.message||'Push gönderim hatası.').slice(0,180);
        if(status===404||status===410){invalid.add(row.endpoint);break}
        if(!pushIsTransient(status)||attempt===1)break;
        await sleep(pushRetryAfterMs(e,attempt));
      }
    }
    const at=new Date().toISOString();if(target){target.lastPushFailureAt=at;target.lastPushFailureStatus=lastStatus||'network';target.updatedAt=at}
    if(lastStatus===401||lastStatus===403)console.warn('Push VAPID/auth hatası:',lastStatus,'kayıt',id);
    else console.warn('Push gönderim hatası:',lastStatus||'network','kayıt',id,lastError);
    return {id,ok:false,status:lastStatus,cleaned:invalid.has(row.endpoint),attempts};
  });
  let changed=false,next=all;
  if(invalid.size){next=all.filter(x=>!invalid.has(x.endpoint));changed=true}
  if(results.length)changed=true;
  if(changed){writeJson('push_subscriptions.json',next);try{await persistAccountStateToGithub()}catch(e){console.error('Push aboneliği kalıcı kayıt:',e.message)}}
  const accepted=results.filter(x=>x.ok).length,failed=results.length-accepted,cleaned=invalid.size,failureStatuses={};
  for(const r of results.filter(x=>!x.ok)){const k=String(r.status||'network');failureStatuses[k]=(failureStatuses[k]||0)+1}
  updatePushDeliveryLog(deliveryId,{providerAccepted:accepted,failed,cleaned,failureStatuses,finishedAt:new Date().toISOString()});
  console.log('Push delivery',deliveryId,'hedef',rows.length,'accepted',accepted,'failed',failed,'cleaned',cleaned,'statuses',JSON.stringify(failureStatuses));
  return {deliveryId,targetCount:rows.length,providerAccepted:accepted,sent:accepted,failed,cleaned,configurationError:!!(failureStatuses['401']||failureStatuses['403']),results};
}
async function sendOrderStatusPush(order,status){
  if(!webPushReady||!order)return {skipped:true,reason:webPushConfigError||'push-disabled'};
  const cfg=notificationSettings().statuses?.[status];if(!cfg||cfg.enabled===false)return {skipped:true,reason:'disabled'};
  const all=readJson('push_subscriptions.json',[]),targets=all.filter(x=>(order.userId&&x.userId===order.userId)||(order.customerId&&x.customerId===order.customerId)||(order.deviceId&&x.deviceId===order.deviceId));if(!targets.length)return {skipped:true,reason:'no-target'};
  order.notificationHistory=Array.isArray(order.notificationHistory)?order.notificationHistory:[];
  const eventKey=status+':'+String(order.statusUpdatedAt||order.createdAt||'');
  if(order.notificationHistory.includes(eventKey))return {skipped:true,reason:'legacy-dedupe'};
  const succeeded=new Set(order.notificationHistory.filter(x=>x&&typeof x==='object'&&x.eventKey===eventKey&&x.subscriptionId&&x.success===true).map(x=>String(x.subscriptionId)));
  const pending=targets.filter(x=>!succeeded.has(safePushRecordId(x)));if(!pending.length)return {skipped:true,reason:'deduped'};
  const url='/hesabim/siparisler/'+encodeURIComponent(order.id),tag='order-'+String(order.id).slice(0,40)+'-'+status+'-'+crypto.createHash('sha1').update(eventKey).digest('hex').slice(0,10);
  const result=await sendPushRows(pending,{title:String(cfg.title||'SHAZ').trim()||'SHAZ',body:String(cfg.body||'').trim(),icon:'/icon-192.png?v=175',badge:'/icon-192.png?v=175',url,tag,data:{url}},{kind:'order:'+status,ttl:12*60*60,urgency:'high'});
  const now=new Date().toISOString();for(const r of result.results.filter(x=>x.ok))order.notificationHistory.push({eventKey,subscriptionId:String(r.id),success:true,sentAt:now,deliveryId:result.deliveryId});
  if(order.notificationHistory.length>300)order.notificationHistory=order.notificationHistory.slice(-300);
  return result;
}
function cleanPushSubscription(body={}){const endpoint=String(body.endpoint||'').trim(),p256dh=String(body.keys?.p256dh||body.p256dh||'').trim(),auth=String(body.keys?.auth||body.auth||'').trim();if(!/^https:\/\//i.test(endpoint)||endpoint.length>2048||p256dh.length<20||p256dh.length>512||auth.length<8||auth.length>512)return null;return {endpoint,keys:{p256dh,auth}}}
function pushSubscribeAllowed(req){const key=String(req.ip||req.socket?.remoteAddress||'unknown'),now=Date.now(),old=pushSubscribeRate.get(key)||[];const fresh=old.filter(t=>now-t<10*60*1000);if(fresh.length>=40)return false;fresh.push(now);pushSubscribeRate.set(key,fresh);return true}
app.get('/api/push/public-key',(req,res)=>{res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');res.setHeader('Pragma','no-cache');res.setHeader('Expires','0');res.json({ok:true,enabled:webPushReady,publicKey:webPushReady?VAPID_PUBLIC_KEY:'',error:webPushReady?'':webPushConfigError})});
app.post('/api/push/subscribe',sameOriginGuard,async(req,res)=>{
  if(!pushSubscribeAllowed(req))return res.status(429).json({ok:false,message:'Çok fazla abonelik isteği.'});
  let bodySize=0;try{bodySize=Buffer.byteLength(JSON.stringify(req.body||{}),'utf8')}catch{}if(bodySize>12000)return res.status(413).json({ok:false,message:'Push abonelik verisi çok büyük.'});
  const sub=cleanPushSubscription(req.body);if(!sub)return res.status(400).json({ok:false,message:'Geçersiz push aboneliği.'});
  const rows=readJson('push_subscriptions.json',[]),now=new Date().toISOString(),user=accountUserFromReq(req),deviceId=String(req.body.deviceId||'').trim().slice(0,120),oldEndpoint=String(req.body.oldEndpoint||'').trim(),ua=String(req.headers['user-agent']||'').slice(0,500);
  let i=rows.findIndex(x=>x.endpoint===sub.endpoint);if(i<0&&oldEndpoint)i=rows.findIndex(x=>x.endpoint===oldEndpoint);
  const previous=i>=0?rows[i]:null,row={id:previous?.id||'PUSH-'+crypto.randomUUID(),userId:user?.id||previous?.userId||null,customerId:user?.customerId||previous?.customerId||null,deviceId:deviceId||previous?.deviceId||null,pwa:req.body.pwa===undefined?!!previous?.pwa:!!req.body.pwa,endpoint:sub.endpoint,p256dh:sub.keys.p256dh,auth:sub.keys.auth,userAgent:ua||previous?.userAgent||'',createdAt:previous?.createdAt||now,updatedAt:now,lastPushAttemptAt:previous?.lastPushAttemptAt||null,lastPushSuccessAt:previous?.lastPushSuccessAt||null,lastPushFailureAt:previous?.lastPushFailureAt||null,lastPushFailureStatus:previous?.lastPushFailureStatus||null};
  if(i>=0)rows[i]=row;else rows.push(row);
  const deduped=rows.filter((x,idx)=>{if(idx===i||x.endpoint===sub.endpoint)return true;if(deviceId&&x.deviceId===deviceId&&x.endpoint!==sub.endpoint)return false;return true});
  const currentIndex=deduped.findIndex(x=>x.endpoint===sub.endpoint);if(currentIndex<0)deduped.push(row);
  writeJson('push_subscriptions.json',deduped);
  let persistence={ok:false,skipped:true};try{persistence=await persistAccountStateToGithub()}catch(e){console.error('Push subscribe kalıcı kayıt:',e.message)}
  res.json({ok:true,persisted:!!persistence?.ok||persistRoot!==root,updated:!!previous});
});
app.delete('/api/push/unsubscribe',sameOriginGuard,async(req,res)=>{const endpoint=String(req.body?.endpoint||'').trim(),rows=readJson('push_subscriptions.json',[]),next=rows.filter(x=>x.endpoint!==endpoint);if(next.length!==rows.length){writeJson('push_subscriptions.json',next);try{await persistAccountStateToGithub()}catch(e){console.error('Push unsubscribe kalıcı kayıt:',e.message)}}res.json({ok:true})});
app.post('/api/push/ack',sameOriginGuard,(req,res)=>{const deliveryId=String(req.body?.deliveryId||'').trim(),subscriptionId=String(req.body?.subscriptionId||'').trim().slice(0,120);if(!/^DEL-[0-9a-f-]{20,}$/i.test(deliveryId))return res.status(400).json({ok:false});const rows=pushDeliveryLogs(),i=rows.findIndex(x=>x.deliveryId===deliveryId);if(i<0)return res.status(404).json({ok:false});const acked=new Set(Array.isArray(rows[i].ackedSubscriptionIds)?rows[i].ackedSubscriptionIds:[]);if(subscriptionId)acked.add(subscriptionId);else acked.add('anonymous:'+String(req.body?.receivedAt||Date.now()));rows[i].ackedSubscriptionIds=[...acked].slice(-500);rows[i].deviceAckCount=rows[i].ackedSubscriptionIds.length;rows[i].lastAckAt=new Date().toISOString();writePushDeliveryLogs(rows);res.json({ok:true})});
app.get('/api/admin/push/deliveries/:id',requireAdmin,(req,res)=>{const row=pushDeliveryLogs().find(x=>x.deliveryId===String(req.params.id));if(!row)return res.status(404).json({ok:false});res.json({ok:true,delivery:{deliveryId:row.deliveryId,createdAt:row.createdAt,targetCount:row.targetCount,providerAccepted:row.providerAccepted,failed:row.failed,cleaned:row.cleaned,deviceAckCount:row.deviceAckCount,failureStatuses:row.failureStatuses||{}}})});
function normalizeManualPushTarget(raw){const value=String(raw||'').trim();if(!value)return '/';try{const relative=/^\/(?!\/)/.test(value),u=relative?new URL(value,SHAZ_ORIGIN):new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;return u.origin===SHAZ_ORIGIN?(u.pathname+u.search+u.hash):u.href}catch(_){return null}}
function rememberManualPushTitle(title){title=String(title||'').trim().slice(0,80);if(!title)return notificationSettings().manualTitleHistory;const settings=notificationSettings(),key=title.toLocaleLowerCase('tr-TR'),next=[title,...(settings.manualTitleHistory||[]).filter(x=>String(x).trim().toLocaleLowerCase('tr-TR')!==key)].slice(0,20);settings.manualTitleHistory=next;writeJson('notification_settings.json',settings);return next}
app.post('/api/admin/push/send',sameOriginGuard,requireAdmin,async(req,res)=>{
  if(!webPushReady)return res.status(503).json({ok:false,message:'Web Push yapılandırması aktif değil: '+(webPushConfigError||'VAPID geçersiz.')});
  const rawTitle=String(req.body.title??'').trim().slice(0,80),rawBody=String(req.body.body??'').trim().slice(0,240),rawUrl=String(req.body.url??'').trim(),clientRequestId=String(req.body.clientRequestId||'').trim().slice(0,120);if(!rawBody)return res.status(400).json({ok:false,message:'Bildirim açıklaması boş bırakılamaz.'});
  if(clientRequestId){const old=pushSendIdempotency.get(clientRequestId);if(old&&Date.now()-old.at<15000)return res.json(old.response)}
  const url=normalizeManualPushTarget(rawUrl);if(!url)return res.status(400).json({ok:false,message:'URL yalnızca geçerli site yolu veya http/https web adresi olabilir.'});
  // Manuel bildirimde admin başlığı ve açıklamayı ayrı tut. Platform fallback kararı Service Worker'da verilir.
  const payload={type:'manual',title:rawTitle,titleProvided:!!rawTitle,body:rawBody,icon:'/icon-192.png?v=175',badge:'/icon-192.png?v=175',url,data:{url}};
  const manualTargets=readJson('push_subscriptions.json',[]);
  const result=await sendPushRows(manualTargets,payload,{kind:'manual',ttl:24*60*60,urgency:'normal'});let titleHistory=notificationSettings().manualTitleHistory;
  if(rawTitle&&result.providerAccepted>0){titleHistory=rememberManualPushTitle(rawTitle);try{await persistAccountStateToGithub()}catch(e){console.error('Manuel push başlık geçmişi kalıcı kayıt:',e.message)}}
  const response={ok:true,...result,deviceAckCount:0,titleHistory};
  if(clientRequestId){pushSendIdempotency.set(clientRequestId,{at:Date.now(),response});for(const [k,v] of pushSendIdempotency)if(Date.now()-v.at>60000)pushSendIdempotency.delete(k)}
  res.json(response);
});
app.post('/api/activity/visit',sameOriginGuard,(req,res)=>{recordCustomerVisit(req,req.body||{});res.json({ok:true})});
app.get('/api/admin/activity-stream',requireAdmin,(req,res)=>{res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('Connection','keep-alive');res.flushHeaders?.();res.write('event: ready\ndata: {}\n\n');adminActivityStreams.add(res);const keep=setInterval(()=>{try{res.write(': keepalive\n\n')}catch(_){}},25000);req.on('close',()=>{clearInterval(keep);adminActivityStreams.delete(res)})});
app.get('/api/admin/notification-settings',requireAdmin,(req,res)=>res.json({ok:true,settings:notificationSettings(),pushStats:pushStats()}));
app.put('/api/admin/notification-settings',requireAdmin,(req,res)=>{const current=notificationSettings(),incoming=req.body?.statuses||{};for(const k of ['new','prepared','shipped','delivered'])if(incoming[k])current.statuses[k]={enabled:incoming[k].enabled!==false,title:String(incoming[k].title||'SHAZ').slice(0,80),body:String(incoming[k].body||'').slice(0,240)};writeJson('notification_settings.json',current);persistAccountStateAsync();res.json({ok:true,settings:current})});
app.get('/api/admin/customers-all',requireAdmin,(req,res)=>{const users=readJson('users.json',[]),orders=readJson('orders.json',[]),push=readJson('push_subscriptions.json',[]),acts=activityRows(),map=new Map();const add=(key,base)=>{if(!map.has(key))map.set(key,{key,name:'',phone:'',email:'',member:false,orderCount:0,lastOrderAt:'',lastOrderStatus:'',lastOrderTotal:0,pushActive:false,permission:'default',pwaStatus:'—',firstPwaAt:'',lastPwaAt:'',lastSeenAt:'',lastNotificationAt:'',visitCount:0,visits:[],orders:[],...base});return map.get(key)};for(const u of users){const key='u:'+u.id,r=add(key,{name:[u.firstName,u.lastName].filter(Boolean).join(' '),phone:u.phone||'',email:u.email||'',member:true,userId:u.id,customerId:u.customerId,disabled:!!u.disabled});const a=acts.filter(x=>x.userId===u.id||x.customerId===u.customerId);r.visits=a.flatMap(x=>x.visits||[]).sort();r.visitCount=r.visits.length;r.lastSeenAt=r.visits.at(-1)||'';r.firstPwaAt=a.map(x=>x.firstPwaAt).filter(Boolean).sort()[0]||'';r.lastPwaAt=a.map(x=>x.lastPwaAt).filter(Boolean).sort().at(-1)||'';r.permission=a.map(x=>x.permission).filter(Boolean).at(-1)||'default';r.pushActive=push.some(x=>x.userId===u.id||x.customerId===u.customerId)}for(const o of orders){const c=o.customer||{},strongGuest=String(c.phone||'').trim()+'|'+String(c.email||'').trim(),key=o.userId?'u:'+o.userId:o.customerId?'c:'+o.customerId:'g:'+crypto.createHash('sha1').update(strongGuest).digest('hex').slice(0,12),r=add(key,{name:c.fullName||[c.firstName,c.lastName].filter(Boolean).join(' '),phone:c.phone||'',email:c.email||'',member:!!o.userId,customerId:o.customerId||null,userId:o.userId||null});r.orderCount++;r.orders.push({id:o.id,createdAt:o.createdAt||'',status:o.status||'',total:Number(o.total||0)});if(!r.lastOrderAt||new Date(o.createdAt)>new Date(r.lastOrderAt)){r.lastOrderAt=o.createdAt;r.lastOrderStatus=o.status||'';r.lastOrderTotal=Number(o.total||0)}const hist=Array.isArray(o.notificationHistory)?o.notificationHistory:[];if(hist.length)r.lastNotificationAt=o.statusUpdatedAt||o.createdAt||r.lastNotificationAt;const a=acts.filter(x=>(o.userId&&x.userId===o.userId)||(o.customerId&&x.customerId===o.customerId)||(o.deviceId&&x.deviceId===o.deviceId));if(a.length){r.visits=[...new Set([...r.visits,...a.flatMap(x=>x.visits||[])])].sort();r.visitCount=r.visits.length;r.lastSeenAt=r.visits.at(-1)||r.lastSeenAt;r.firstPwaAt=[r.firstPwaAt,...a.map(x=>x.firstPwaAt)].filter(Boolean).sort()[0]||'';r.lastPwaAt=a.map(x=>x.lastPwaAt).filter(Boolean).sort().at(-1)||r.lastPwaAt;r.permission=a.map(x=>x.permission).filter(Boolean).at(-1)||r.permission}r.pushActive=r.pushActive||push.some(x=>(o.userId&&x.userId===o.userId)||(o.customerId&&x.customerId===o.customerId)||(o.deviceId&&x.deviceId===o.deviceId))}for(const r of map.values()){if(r.lastPwaAt){const age=Date.now()-new Date(r.lastPwaAt).getTime();r.pwaStatus=age<30*24*60*60*1000?'Aktif':(r.pushActive?'Uzun süredir kullanılmıyor':'Pasif / kaldırılmış olabilir')}r.notificationStatus=r.pushActive?'Açık':(r.permission==='denied'?'Sistemden reddedilmiş':r.permission==='granted'?'Push aboneliği pasif':'Kapalı');r.orders.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))}const list=[...map.values()].sort((a,b)=>new Date(b.lastSeenAt||b.lastOrderAt||0)-new Date(a.lastSeenAt||a.lastOrderAt||0)),stats={total:list.length,members:list.filter(x=>x.member).length,guests:list.filter(x=>!x.member).length,pushActive:list.filter(x=>x.pushActive).length,pwaActive:list.filter(x=>x.pwaStatus==='Aktif').length,notificationOpen:list.filter(x=>x.notificationStatus==='Açık').length};res.json({ok:true,customers:list,stats})});
app.get('/api/auth/social-config',(req,res)=>res.json({ok:true,googleClientId:'',appleClientId:'',appleRedirectUri:'',passwordResetEnabled:!!RESEND_API_KEY}));
app.post('/api/auth/social/google',sameOriginGuard,(req,res)=>res.status(410).json({ok:false,message:'Google ile giriş artık kullanılmıyor. E-posta veya telefon ve şifrenizle giriş yapın.'}));
app.post('/api/auth/social/apple',sameOriginGuard,(req,res)=>res.status(410).json({ok:false,message:'Apple ile giriş artık kullanılmıyor. E-posta veya telefon ve şifrenizle giriş yapın.'}));
app.post('/api/auth/forgot-password',sameOriginGuard,async(req,res)=>{
  if(rateLimitHit(req,'forgot-password',12,15*60*1000))return res.status(429).json({ok:false,message:'Çok fazla istek. Lütfen biraz sonra tekrar deneyin.'});
  const identifier=String(req.body.identifier??req.body.email??'').trim(),email=normalizeEmail(identifier),phone=normalizeAccountPhone(identifier),users=readJson('users.json',[]),u=users.find(x=>(email.includes('@')&&x.email===email)||(phone&&normalizeAccountPhone(x.phone)===phone));
  if(!identifier)return res.status(400).json({ok:false,message:'E-posta adresinizi veya telefon numaranızı girin.'});
  const generic='Bilgileriniz bir hesapla eşleşiyorsa şifre sıfırlama bağlantısı kayıtlı e-posta adresinize gönderildi.';
  if(!u)return res.json({ok:true,message:generic});
  if(!RESEND_API_KEY)return res.status(503).json({ok:false,message:'Şifre sıfırlama e-posta servisi henüz yapılandırılmadı.'});
  const raw=crypto.randomBytes(32).toString('base64url'),hash=crypto.createHash('sha256').update(raw).digest('hex'),arr=readJson('password_resets.json',[]).filter(x=>x.userId!==u.id&&new Date(x.expiresAt).getTime()>Date.now());arr.push({id:crypto.randomUUID(),userId:u.id,tokenHash:hash,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30*60*1000).toISOString(),usedAt:null});writeJson('password_resets.json',arr);await persistAccountStateToGithub().catch(e=>{console.error('Şifre sıfırlama token kalıcı kayıt:',e);throw e});const sent=await sendPasswordResetMail(u.email,`${PUBLIC_BASE_URL}/sifre-sifirla?token=${encodeURIComponent(raw)}`);if(!sent)return res.status(502).json({ok:false,message:'Şifre sıfırlama e-postası gönderilemedi.'});res.json({ok:true,message:generic})
});
app.post('/api/auth/reset-password',sameOriginGuard,async(req,res)=>serializedMutation('accounts',async()=>{const raw=String(req.body.token||''),password=String(req.body.password||'');if(!validPasswordSize(password))return res.status(400).json({ok:false,message:'Yeni şifre 8-256 karakter arasında olmalıdır.'});const hash=crypto.createHash('sha256').update(raw).digest('hex'),arr=readJson('password_resets.json',[]),x=arr.find(v=>v.tokenHash===hash&&!v.usedAt&&new Date(v.expiresAt).getTime()>Date.now());if(!x)return res.status(400).json({ok:false,message:'Şifre sıfırlama bağlantısı geçersiz veya süresi dolmuş.'});const users=readJson('users.json',[]),i=users.findIndex(u=>u.id===x.userId);if(i<0)return res.status(400).json({ok:false,message:'Hesap bulunamadı.'});const ph=passwordHash(password);users[i].passwordSalt=ph.salt;users[i].passwordHash=ph.hash;users[i].authVersion=Number(users[i].authVersion||1)+1;users[i].authProviders=Array.from(new Set([...(users[i].authProviders||[]),'password']));users[i].updatedAt=new Date().toISOString();x.usedAt=users[i].updatedAt;writeJson('users.json',users);writeJson('password_resets.json',arr);await persistAccountStateToGithub().catch(e=>{console.error('Şifre değişikliği kalıcı kayıt:',e);throw e});return res.json({ok:true})}));

app.get(['/giris','/kayit','/sifre-sifirla','/hesabim','/hesabim/siparisler','/hesabim/bilgiler','/hesabim/adresler','/hesabim/favoriler','/hesabim/kuponlar','/hesabim/sifre'],(req,res)=>{res.setHeader('X-Robots-Tag','noindex, nofollow');res.sendFile(path.join(root,'public','index.html'))});
app.get('/hesabim/siparisler/:id',(req,res)=>{res.setHeader('X-Robots-Tag','noindex, nofollow');res.sendFile(path.join(root,'public','index.html'))});
app.get('/api/auth/register/pending',(req,res)=>{
  let rows=cleanPendingRegistrations(readJson('pending_registrations.json',[]));const original=readJson('pending_registrations.json',[]);if(rows.length!==original.length){writeJson('pending_registrations.json',rows);persistAccountStateAsync()}
  const pending=pendingRegistrationFromReq(req,rows);res.setHeader('Cache-Control','no-store');if(!pending)return res.json({ok:true,pending:false});
  res.json({ok:true,pending:true,maskedEmail:maskRegistrationEmail(pending.email),expiresAt:pending.expiresAt,resendAt:pending.resendAt,attemptsRemaining:Math.max(0,5-Number(pending.attemptCount||0))});
});
app.post('/api/auth/register',sameOriginGuard,async(req,res)=>{
  if(rateLimitHit(req,'register',12,15*60*1000)||rateLimitHit(req,'register-send-code',8,15*60*1000))return res.status(429).json({ok:false,message:'Çok fazla kayıt isteği. Lütfen biraz sonra tekrar deneyin.'});
  if(!USER_SESSION_SECRET)return res.status(503).json({ok:false,message:'Üyelik oturum anahtarı sunucuda yapılandırılmadı.'});
  if(!RESEND_API_KEY)return res.status(503).json({ok:false,message:'Doğrulama e-posta servisi henüz yapılandırılmadı.'});
  const firstName=String(req.body.firstName||'').trim(),lastName=String(req.body.lastName||'').trim(),email=normalizeEmail(req.body.email),phone=normalizeAccountPhone(req.body.phone),password=String(req.body.password||''),birthDate=String(req.body.birthDate||'').trim();
  if(!firstName||!lastName||!email||!phone||!birthDate||!validPasswordSize(password))return res.status(400).json({ok:false,message:!birthDate?'Doğum tarihi zorunludur.':!phone?'Lütfen geçerli bir telefon numarası girin.':!email.includes('@')?'Lütfen geçerli bir e-posta adresi girin.':'Lütfen tüm zorunlu alanları doldurun ve en az 8 karakterli şifre kullanın.'});
  if(!validBirthDateIso(birthDate))return res.status(400).json({ok:false,message:'Doğum tarihini gg.aa.yyyy biçiminde geçerli olarak girin.'});
  if(PHONE_VERIFICATION_REQUIRED)return res.status(503).json({ok:false,message:'Telefon doğrulama özelliği etkin ancak SMS sağlayıcısı henüz canlı kullanıma açılmadı.'});
  const users=readJson('users.json',[]);if(users.some(u=>!u.deleted&&normalizeEmail(u.email)===email))return res.status(409).json({ok:false,message:'Bu e-posta adresiyle zaten bir hesap bulunuyor.'});if(users.some(u=>!u.deleted&&normalizeAccountPhone(u.phone)===phone))return res.status(409).json({ok:false,message:'Bu telefon numarasıyla daha önce hesap oluşturulmuş.'});
  if(verificationMailRateHit(req,email))return res.status(429).json({ok:false,message:'Çok fazla doğrulama e-postası istendi. Lütfen daha sonra tekrar deneyin.'});
  const now=new Date(),code=newRegistrationOtp(),challengeToken=crypto.randomBytes(32).toString('base64url'),ph=passwordHash(password);let pending;
  await serializedMutation('accounts',async()=>{let rows=cleanPendingRegistrations(readJson('pending_registrations.json',[]));const existing=rows.find(x=>normalizeEmail(x.email)===email),id=existing?.id||('REG-'+crypto.randomUUID()),createdAt=existing?.createdAt||now.toISOString();pending={id,challengeHash:registrationChallengeHash(challengeToken),firstName,lastName,email,phone,birthDate,passwordSalt:ph.salt,passwordHash:ph.hash,smsMarketingConsent:!!req.body.smsMarketingConsent,emailMarketingConsent:!!req.body.emailMarketingConsent,verificationCodeHash:registrationOtpHash(id,code),expiresAt:new Date(now.getTime()+REGISTRATION_OTP_TTL_MS).toISOString(),resendAt:new Date(now.getTime()+REGISTRATION_RESEND_COOLDOWN_MS).toISOString(),attemptCount:0,createdAt,updatedAt:now.toISOString()};if(existing)rows=rows.filter(x=>x.id!==existing.id);rows.push(pending);writeJson('pending_registrations.json',rows);persistAccountStateAsync()});
  let sent=false;try{sent=await sendRegistrationVerificationMail(email,code)}catch(e){console.error('Üyelik doğrulama e-postası:',e?.message||e)}
  if(!sent){await serializedMutation('accounts',async()=>{const rows=readJson('pending_registrations.json',[]).filter(x=>x.id!==pending.id);writeJson('pending_registrations.json',rows);persistAccountStateAsync()});clearRegistrationChallengeCookie(res,req);return res.status(502).json({ok:false,message:'Doğrulama e-postası gönderilemedi. Lütfen biraz sonra tekrar deneyin.'})}
  setRegistrationChallengeCookie(res,req,challengeToken);return res.json({ok:true,verificationRequired:true,maskedEmail:maskRegistrationEmail(email),expiresAt:pending.expiresAt,resendAt:pending.resendAt});
});
app.post('/api/auth/register/resend',sameOriginGuard,async(req,res)=>serializedMutation('accounts',async()=>{
  if(rateLimitHit(req,'register-resend',12,15*60*1000))return res.status(429).json({ok:false,message:'Çok fazla tekrar gönderme isteği. Lütfen biraz sonra tekrar deneyin.'});
  let rows=cleanPendingRegistrations(readJson('pending_registrations.json',[])),pending=pendingRegistrationFromReq(req,rows);if(!pending)return res.status(404).json({ok:false,message:'Doğrulama kaydı bulunamadı. Lütfen üyelik formuna geri dönün.'});
  const retryMs=new Date(pending.resendAt||0).getTime()-Date.now();if(retryMs>0)return res.status(429).json({ok:false,message:`Yeni kod için ${Math.ceil(retryMs/1000)} saniye bekleyin.`,retryAfter:Math.ceil(retryMs/1000)});if(verificationMailRateHit(req,pending.email))return res.status(429).json({ok:false,message:'Çok fazla doğrulama e-postası istendi. Lütfen daha sonra tekrar deneyin.'});
  const code=newRegistrationOtp(),now=new Date(),next={...pending,verificationCodeHash:registrationOtpHash(pending.id,code),expiresAt:new Date(now.getTime()+REGISTRATION_OTP_TTL_MS).toISOString(),resendAt:new Date(now.getTime()+REGISTRATION_RESEND_COOLDOWN_MS).toISOString(),attemptCount:0,updatedAt:now.toISOString()};
  let sent=false;try{sent=await sendRegistrationVerificationMail(pending.email,code)}catch(e){console.error('Üyelik doğrulama e-postası tekrar gönderim:',e?.message||e)}if(!sent)return res.status(502).json({ok:false,message:'Doğrulama e-postası gönderilemedi. Lütfen biraz sonra tekrar deneyin.'});
  rows=rows.map(x=>x.id===pending.id?next:x);writeJson('pending_registrations.json',rows);persistAccountStateAsync();return res.json({ok:true,maskedEmail:maskRegistrationEmail(next.email),expiresAt:next.expiresAt,resendAt:next.resendAt});
}));
app.post('/api/auth/register/cancel',sameOriginGuard,async(req,res)=>serializedMutation('accounts',async()=>{const rows=readJson('pending_registrations.json',[]),pending=pendingRegistrationFromReq(req,rows);if(pending){writeJson('pending_registrations.json',rows.filter(x=>x.id!==pending.id));persistAccountStateAsync()}clearRegistrationChallengeCookie(res,req);return res.json({ok:true})}));
app.post('/api/auth/register/verify',sameOriginGuard,async(req,res)=>serializedMutation('accounts',async()=>{
  if(rateLimitHit(req,'register-verify',40,15*60*1000))return res.status(429).json({ok:false,message:'Çok fazla doğrulama denemesi. Lütfen biraz sonra tekrar deneyin.'});
  const code=String(req.body.code||'').replace(/\D/g,'').slice(0,6);if(code.length!==6)return res.status(400).json({ok:false,message:'6 haneli doğrulama kodunu girin.'});let rows=cleanPendingRegistrations(readJson('pending_registrations.json',[])),pending=pendingRegistrationFromReq(req,rows);if(!pending)return res.status(404).json({ok:false,message:'Doğrulama kaydı bulunamadı. Lütfen üyelik formuna geri dönün.'});
  if(new Date(pending.expiresAt||0).getTime()<=Date.now())return res.status(410).json({ok:false,message:'Doğrulama kodunun süresi doldu. Yeni kod isteyin.'});if(Number(pending.attemptCount||0)>=5||!pending.verificationCodeHash)return res.status(429).json({ok:false,message:'Doğrulama kodu geçersiz hale geldi. Yeni kod isteyin.'});
  const expected=registrationOtpHash(pending.id,code);if(!safeEqual(expected,pending.verificationCodeHash)){pending.attemptCount=Number(pending.attemptCount||0)+1;if(pending.attemptCount>=5){pending.verificationCodeHash='';pending.expiresAt=new Date().toISOString()}pending.updatedAt=new Date().toISOString();rows=rows.map(x=>x.id===pending.id?pending:x);writeJson('pending_registrations.json',rows);persistAccountStateAsync();const left=Math.max(0,5-pending.attemptCount);return res.status(400).json({ok:false,message:left?`Doğrulama kodu hatalı. ${left} deneme hakkınız kaldı.`:'Doğrulama kodu geçersiz hale geldi. Yeni kod isteyin.',attemptsRemaining:left})}
  const users=readJson('users.json',[]),email=normalizeEmail(pending.email),phone=normalizeAccountPhone(pending.phone);if(users.some(u=>!u.deleted&&normalizeEmail(u.email)===email))return res.status(409).json({ok:false,message:'Bu e-posta adresiyle zaten bir hesap bulunuyor.'});if(users.some(u=>!u.deleted&&normalizeAccountPhone(u.phone)===phone))return res.status(409).json({ok:false,message:'Bu telefon numarasıyla daha önce hesap oluşturulmuş.'});
  const now=new Date().toISOString(),id='USR-'+crypto.randomUUID(),customerId='CUS-'+crypto.randomUUID(),user={id,customerId,firstName:pending.firstName,lastName:pending.lastName,email,phone,birthDate:pending.birthDate,emailVerifiedAt:now,phoneVerifiedAt:null,passwordSalt:pending.passwordSalt,passwordHash:pending.passwordHash,authVersion:1,authProviders:['password'],socialIds:{},smsMarketingConsent:!!pending.smsMarketingConsent,emailMarketingConsent:!!pending.emailMarketingConsent,createdAt:now,updatedAt:now,disabled:false};users.push(user);writeJson('users.json',users);
  const customers=readJson('customers.json',[]);customers.push({id:customerId,userId:id,firstName:user.firstName,lastName:user.lastName,email,phone,createdAt:now,updatedAt:now});writeJson('customers.json',customers);
  const oldOrders=readJson('orders.json',[]);let linked=false;for(const o of oldOrders){const oe=normalizeEmail(o?.customer?.email||''),op=normalizeAccountPhone(o?.customer?.phone||'');if(oe&&oe===email&&op&&op===phone&&!o.userId){o.userId=id;o.customerId=customerId;linked=true}}if(linked)writeJson('orders.json',oldOrders);
  const cons=readJson('marketing_consents.json',[]);for(const [channel,value] of [['sms',!!pending.smsMarketingConsent],['email',!!pending.emailMarketingConsent]])cons.push({id:crypto.randomUUID(),userId:id,channel,granted:value,at:now,source:'registration',textVersion:'1',ip:consentIp(req),userAgent:String(req.headers['user-agent']||'')});writeJson('marketing_consents.json',cons);assignNewMemberCoupons(id,now);
  writeJson('pending_registrations.json',rows.filter(x=>x.id!==pending.id));await persistAccountStateToGithub().catch(e=>{console.error('Üyelik doğrulama kalıcı kayıt:',e);throw e});setUserSession(res,user,req);clearRegistrationChallengeCookie(res,req);return res.json({ok:true,user:publicUser(user)});
}));
app.post('/api/auth/login',sameOriginGuard,(req,res)=>{if(rateLimitHit(req,'login',80,15*60*1000))return res.status(429).json({ok:false,message:'Çok fazla giriş isteği. Lütfen biraz sonra tekrar deneyin.'});const login=String(req.body.login??req.body.email??'').trim(),attemptKeys=accountLoginAttemptKeys(req,login),blockedKey=attemptKeys.find(k=>Number(accountAttemptState(k).blockedUntil||0)>Date.now());if(blockedKey)return res.status(429).json({ok:false,message:accountBlockedMessage(blockedKey),remainingAttempts:0});const email=normalizeEmail(login),phone=normalizeAccountPhone(login),users=readJson('users.json',[]),matches=users.filter(x=>x.email===email||(phone&&normalizeAccountPhone(x.phone)===phone)),u=matches.find(x=>!x.deleted)||matches[0];if(u?.deleted)return res.status(403).json({ok:false,message:'Bu kullanıcı silinmiştir. Aynı bilgilerle baştan yeni bir hesap oluşturabilirsiniz.'});if(!u||!passwordMatches(req.body.password,u)){const remainings=attemptKeys.map(accountFailKey),remaining=Math.min(...remainings);if(remaining<=0){const key=attemptKeys.find(k=>Number(accountAttemptState(k).blockedUntil||0)>Date.now())||attemptKeys[0];return res.status(429).json({ok:false,message:accountBlockedMessage(key),remainingAttempts:0})}return res.status(401).json({ok:false,message:`E-posta/telefon veya şifre hatalı. ${remaining} hakkınız kaldı.`,remainingAttempts:remaining})}if(u.disabled)return res.status(403).json({ok:false,message:'Bu üyelik yönetim tarafından iptal edilmiş.'});attemptKeys.forEach(clearAccountLoginAttempts);setUserSession(res,u,req);res.json({ok:true,user:publicUser(u)})});
app.post('/api/auth/logout',sameOriginGuard,(req,res)=>{clearUserSession(res,req);res.json({ok:true})});
app.get('/api/auth/me',(req,res)=>{const u=accountUserFromReq(req);res.json({ok:true,authenticated:!!u,user:publicUser(u)})});
app.patch('/api/account/profile',sameOriginGuard,requireUser,async(req,res)=>serializedMutation('accounts',async()=>{
  const users=readJson('users.json',[]),i=users.findIndex(x=>x.id===req.accountUser.id),u=users[i],now=new Date().toISOString(),meta=profileChangeMeta(u);
  const requestedEmail=normalizeEmail(req.body.email??u.email),email=normalizeEmail(u.email),phone=normalizeAccountPhone(req.body.phone),firstName=String(req.body.firstName||'').trim(),lastName=String(req.body.lastName||'').trim(),birthDate=String(req.body.birthDate||'').trim();
  if(requestedEmail&&requestedEmail!==email)return res.status(400).json({ok:false,message:'E-posta adresini değiştirmek için “E-posta Değiştir” akışını kullanın.'});
  if(!firstName||!lastName)return res.status(400).json({ok:false,message:'Ad ve soyad zorunludur.'});if(!phone)return res.status(400).json({ok:false,message:'Lütfen geçerli bir telefon numarası girin.'});if(!validBirthDateIso(birthDate))return res.status(400).json({ok:false,message:'Doğum tarihi zorunludur ve geçerli olmalıdır.'});
  const nameChanged=firstName!==String(u.firstName||'')||lastName!==String(u.lastName||''),phoneChanged=phone!==normalizeAccountPhone(u.phone),birthChanged=birthDate!==String(u.birthDate||'');
  if(nameChanged){const wait=profileWaitMs(meta.nameChangedAt,PROFILE_NAME_COOLDOWN_MS);if(wait>0)return res.status(429).json({ok:false,message:`Ad / Soyad bilgisi 30 günde 1 kez değiştirilebilir. Tekrar değiştirebilmeniz için ${humanWait(wait)} kaldı.`})}
  if(phoneChanged){const wait=profileWaitMs(meta.phoneChangedAt,PROFILE_PHONE_COOLDOWN_MS);if(wait>0)return res.status(429).json({ok:false,message:`Telefon numarası 7 günde 1 kez değiştirilebilir. Tekrar değiştirebilmeniz için ${humanWait(wait)} kaldı.`});if(users.some(x=>x.id!==u.id&&normalizeAccountPhone(x.phone)===phone))return res.status(409).json({ok:false,message:'Bu telefon numarasıyla daha önce hesap oluşturulmuş.'})}
  if(birthChanged&&meta.birthDateUserChangeCount>=1)return res.status(429).json({ok:false,message:'Doğum tarihinizi kullanıcı hesabından yalnızca 1 kez değiştirebilirsiniz. Bundan sonraki değişiklik için yönetim desteği gerekir.'});
  let pendingMessage='';
  if(phoneChanged){
    try{await SmsVerificationProvider.sendOtp(phone,u.id)}catch(e){return res.status(503).json({ok:false,message:'Yeni telefon numarası doğrulanmadan aktif edilemez. SMS doğrulama servisi şu anda yapılandırılmamış; mevcut telefon numaranız değiştirilmedi.'})}
    u.pendingPhoneChange={phone,requestedAt:now,expiresAt:new Date(Date.now()+PROFILE_VERIFY_TTL_MS).toISOString()};pendingMessage='Yeni telefon numaranıza doğrulama kodu gönderildi. Doğrulanana kadar mevcut numaranız aktif kalır.';
  }
  if(nameChanged){pushProfileHistory(u,'Ad / Soyad',[u.firstName,u.lastName].filter(Boolean).join(' '),[firstName,lastName].filter(Boolean).join(' '));u.firstName=firstName;u.lastName=lastName;meta.nameChangedAt=now}
  if(birthChanged){pushProfileHistory(u,'Doğum Tarihi',u.birthDate||'',birthDate);u.birthDate=birthDate;meta.birthDateUserChangeCount+=1}
  const oldSms=!!u.smsMarketingConsent,oldMail=!!u.emailMarketingConsent,newSms=!!req.body.smsMarketingConsent,newMail=!!req.body.emailMarketingConsent;
  if(oldSms!==newSms)pushProfileHistory(u,'SMS İzni',oldSms?'Açık':'Kapalı',newSms?'Açık':'Kapalı');if(oldMail!==newMail)pushProfileHistory(u,'E-posta İzni',oldMail?'Açık':'Kapalı',newMail?'Açık':'Kapalı');
  u.smsMarketingConsent=newSms;u.emailMarketingConsent=newMail;u.profileChangeMeta=meta;u.updatedAt=now;users[i]=u;writeJson('users.json',users);
  const customers=readJson('customers.json',[]),ci=customers.findIndex(c=>c.id===u.customerId);if(ci>=0){Object.assign(customers[ci],{firstName:u.firstName,lastName:u.lastName,email:u.email,phone:u.phone,updatedAt:now});writeJson('customers.json',customers)}
  if(oldSms!==newSms||oldMail!==newMail){const cons=readJson('marketing_consents.json',[]);if(oldSms!==newSms)cons.push({id:crypto.randomUUID(),userId:u.id,channel:'sms',granted:newSms,at:now,source:'account',textVersion:'1',ip:consentIp(req),userAgent:String(req.headers['user-agent']||'')});if(oldMail!==newMail)cons.push({id:crypto.randomUUID(),userId:u.id,channel:'email',granted:newMail,at:now,source:'account',textVersion:'1',ip:consentIp(req),userAgent:String(req.headers['user-agent']||'')});writeJson('marketing_consents.json',cons)}
  await persistAccountStateToGithub().catch(e=>{console.error('Hesap kalıcı kayıt:',e);throw e});res.json({ok:true,user:publicUser(u),pendingPhoneVerification:phoneChanged,message:pendingMessage||'Hesap bilgileri güncellendi.'});
}));

app.post('/api/account/email-change/start',sameOriginGuard,requireUser,async(req,res)=>serializedMutation('accounts',async()=>{
  if(rateLimitHit(req,'email-change-start',12,15*60*1000))return res.status(429).json({ok:false,message:'Çok fazla e-posta değişikliği isteği. Lütfen biraz sonra tekrar deneyin.'});
  if(!USER_SESSION_SECRET||!RESEND_API_KEY)return res.status(503).json({ok:false,message:'E-posta doğrulama servisi şu anda kullanılamıyor.'});
  const users=readJson('users.json',[]),i=users.findIndex(x=>x.id===req.accountUser.id);if(i<0)return res.status(401).json({ok:false,message:'Giriş yapmanız gerekiyor.'});const u=users[i],target=normalizeEmail(req.body.email),current=normalizeEmail(u.email);
  if(!target||!target.includes('@'))return res.status(400).json({ok:false,message:'Geçerli bir yeni e-posta adresi girin.'});if(target===current)return res.status(400).json({ok:false,message:'Yeni e-posta adresi mevcut e-posta adresinizle aynı.'});
  if(u.passwordHash&&!passwordMatches(req.body.currentPassword,u))return res.status(400).json({ok:false,message:'Mevcut şifreniz hatalı.'});
  if(users.some(x=>x.id!==u.id&&!x.deleted&&normalizeEmail(x.email)===target))return res.status(409).json({ok:false,message:'Bu e-posta adresi başka bir hesapta kullanılıyor.'});
  if(verificationMailRateHit(req,target,6,60*60*1000))return res.status(429).json({ok:false,message:'Çok fazla doğrulama e-postası istendi. Lütfen daha sonra tekrar deneyin.'});
  const code=newRegistrationOtp(),now=new Date(),previous=u.pendingEmailChange?{...u.pendingEmailChange}:null,pending={purpose:'email_change',userId:u.id,email:target,verificationCodeHash:emailChangeOtpHash(u.id,target,code),requestedAt:now.toISOString(),expiresAt:new Date(now.getTime()+EMAIL_CHANGE_OTP_TTL_MS).toISOString(),resendAt:new Date(now.getTime()+EMAIL_CHANGE_RESEND_COOLDOWN_MS).toISOString(),attemptCount:0};
  u.pendingEmailChange=pending;u.updatedAt=now.toISOString();users[i]=u;writeJson('users.json',users);try{await persistAccountStateToGithub()}catch(e){u.pendingEmailChange=previous;writeJson('users.json',users);throw e}
  let sent=false;try{sent=await sendEmailChangeVerificationMail(target,code)}catch(e){console.error('E-posta değişikliği doğrulama maili:',e?.message||e)}
  if(!sent){u.pendingEmailChange=previous;u.updatedAt=new Date().toISOString();users[i]=u;writeJson('users.json',users);try{await persistAccountStateToGithub()}catch(e){console.error('E-posta değişikliği rollback kalıcı kayıt:',e)}return res.status(502).json({ok:false,message:'Doğrulama e-postası gönderilemedi. Mevcut e-posta adresiniz değiştirilmedi.'})}
  return res.json({ok:true,pendingEmail:maskRegistrationEmail(target),expiresAt:pending.expiresAt,resendAt:pending.resendAt,passwordReverified:!!u.passwordHash});
}));

app.post('/api/account/email-change/resend',sameOriginGuard,requireUser,async(req,res)=>serializedMutation('accounts',async()=>{
  if(rateLimitHit(req,'email-change-resend',12,15*60*1000))return res.status(429).json({ok:false,message:'Çok fazla tekrar gönderme isteği. Lütfen biraz sonra tekrar deneyin.'});
  const users=readJson('users.json',[]),i=users.findIndex(x=>x.id===req.accountUser.id),u=users[i],pending=u?.pendingEmailChange;if(!u||!pending||pending.purpose!=='email_change')return res.status(404).json({ok:false,message:'Bekleyen e-posta değişikliği bulunamadı.'});
  const retryMs=new Date(pending.resendAt||0).getTime()-Date.now();if(retryMs>0)return res.status(429).json({ok:false,message:`Yeni kod için ${Math.ceil(retryMs/1000)} saniye bekleyin.`,retryAfter:Math.ceil(retryMs/1000)});
  if(verificationMailRateHit(req,pending.email,6,60*60*1000))return res.status(429).json({ok:false,message:'Çok fazla doğrulama e-postası istendi. Lütfen daha sonra tekrar deneyin.'});
  const previous={...pending},code=newRegistrationOtp(),now=new Date(),next={...pending,verificationCodeHash:emailChangeOtpHash(u.id,pending.email,code),expiresAt:new Date(now.getTime()+EMAIL_CHANGE_OTP_TTL_MS).toISOString(),resendAt:new Date(now.getTime()+EMAIL_CHANGE_RESEND_COOLDOWN_MS).toISOString(),attemptCount:0,requestedAt:now.toISOString()};
  u.pendingEmailChange=next;u.updatedAt=now.toISOString();users[i]=u;writeJson('users.json',users);try{await persistAccountStateToGithub()}catch(e){u.pendingEmailChange=previous;writeJson('users.json',users);throw e}
  let sent=false;try{sent=await sendEmailChangeVerificationMail(next.email,code)}catch(e){console.error('E-posta değişikliği tekrar maili:',e?.message||e)}
  if(!sent){u.pendingEmailChange=previous;users[i]=u;writeJson('users.json',users);try{await persistAccountStateToGithub()}catch(e){console.error('E-posta değişikliği resend rollback:',e)}return res.status(502).json({ok:false,message:'Doğrulama e-postası gönderilemedi. Mevcut kodunuz korunuyor.'})}
  return res.json({ok:true,pendingEmail:maskRegistrationEmail(next.email),expiresAt:next.expiresAt,resendAt:next.resendAt});
}));

app.post('/api/account/email-change/cancel',sameOriginGuard,requireUser,async(req,res)=>serializedMutation('accounts',async()=>{
  const users=readJson('users.json',[]),i=users.findIndex(x=>x.id===req.accountUser.id);if(i<0)return res.status(401).json({ok:false,message:'Giriş yapmanız gerekiyor.'});users[i].pendingEmailChange=null;users[i].updatedAt=new Date().toISOString();writeJson('users.json',users);await persistAccountStateToGithub().catch(e=>{console.error('E-posta değişikliği iptal kalıcı kayıt:',e);throw e});return res.json({ok:true,user:publicUser(users[i])});
}));

app.post('/api/account/email-change/verify',sameOriginGuard,requireUser,async(req,res)=>serializedMutation('accounts',async()=>{
  if(rateLimitHit(req,'email-change-verify',40,15*60*1000))return res.status(429).json({ok:false,message:'Çok fazla doğrulama denemesi. Lütfen biraz sonra tekrar deneyin.'});
  const code=String(req.body.code||'').replace(/\D/g,'').slice(0,6);if(code.length!==6)return res.status(400).json({ok:false,message:'6 haneli doğrulama kodunu girin.'});
  const users=readJson('users.json',[]),i=users.findIndex(x=>x.id===req.accountUser.id),u=users[i],pending=u?.pendingEmailChange;if(!u||!pending||pending.purpose!=='email_change'||pending.userId!==u.id)return res.status(404).json({ok:false,message:'Bekleyen e-posta değişikliği bulunamadı.'});
  if(new Date(pending.expiresAt||0).getTime()<=Date.now())return res.status(410).json({ok:false,message:'Doğrulama kodunun süresi doldu. Yeni kod isteyin.'});if(Number(pending.attemptCount||0)>=5||!pending.verificationCodeHash)return res.status(429).json({ok:false,message:'Doğrulama kodu geçersiz hale geldi. Yeni kod isteyin.'});
  const expected=emailChangeOtpHash(u.id,pending.email,code);if(!safeEqual(expected,pending.verificationCodeHash)){pending.attemptCount=Number(pending.attemptCount||0)+1;if(pending.attemptCount>=5){pending.verificationCodeHash='';pending.expiresAt=new Date().toISOString()}u.pendingEmailChange=pending;u.updatedAt=new Date().toISOString();users[i]=u;writeJson('users.json',users);await persistAccountStateToGithub().catch(e=>console.error('E-posta OTP deneme kalıcı kayıt:',e));const left=Math.max(0,5-pending.attemptCount);return res.status(400).json({ok:false,message:left?`Doğrulama kodu hatalı. ${left} deneme hakkınız kaldı.`:'Doğrulama kodu geçersiz hale geldi. Yeni kod isteyin.',attemptsRemaining:left})}
  const email=normalizeEmail(pending.email);if(users.some(x=>x.id!==u.id&&!x.deleted&&normalizeEmail(x.email)===email))return res.status(409).json({ok:false,message:'Bu e-posta adresi başka bir hesapta kullanılıyor. Mevcut e-posta adresiniz değiştirilmedi.'});
  const beforeUsers=JSON.parse(JSON.stringify(users)),customers=readJson('customers.json',[]),beforeCustomers=JSON.parse(JSON.stringify(customers)),oldEmail=u.email,now=new Date().toISOString();
  pushProfileHistory(u,'E-posta',oldEmail,email,'verified_email_change');u.email=email;u.emailVerifiedAt=now;u.pendingEmailChange=null;u.profileChangeMeta={...profileChangeMeta(u),emailChangedAt:now};u.updatedAt=now;users[i]=u;
  const ci=customers.findIndex(c=>c.id===u.customerId||c.userId===u.id);if(ci>=0){customers[ci].email=email;customers[ci].updatedAt=now}
  try{writeJson('users.json',users);if(ci>=0)writeJson('customers.json',customers);await persistAccountStateToGithub()}catch(e){try{writeJson('users.json',beforeUsers);if(ci>=0)writeJson('customers.json',beforeCustomers)}catch(rollbackErr){console.error('E-posta değişikliği rollback:',rollbackErr)}throw e}
  try{await sendEmailChangedSecurityMail(oldEmail,email)}catch(e){console.error('Eski e-posta güvenlik bildirimi:',e?.message||e)}
  return res.json({ok:true,user:publicUser(u),message:'E-posta adresiniz güncellendi.'});
}));

app.get('/api/account/verify-email-change',(req,res)=>{res.status(410).setHeader('Cache-Control','no-store');res.send('Bu eski e-posta doğrulama bağlantısı artık kullanılmıyor. Hesap Bilgilerim ekranından e-posta değişikliğini yeniden başlatın.')});
app.post('/api/account/verify-email-change',sameOriginGuard,(req,res)=>res.status(410).json({ok:false,message:'Bu eski doğrulama yöntemi artık kullanılmıyor. Hesap Bilgilerim ekranından e-posta değişikliğini yeniden başlatın.'}));

app.post('/api/account/verify-phone-change',sameOriginGuard,requireUser,async(req,res)=>serializedMutation('accounts',async()=>{
  const users=readJson('users.json',[]),i=users.findIndex(x=>x.id===req.accountUser.id),u=users[i],pending=u.pendingPhoneChange,code=String(req.body.code||'').trim();if(!pending)return res.status(400).json({ok:false,message:'Bekleyen telefon numarası değişikliği yok.'});if(new Date(pending.expiresAt).getTime()<Date.now())return res.status(400).json({ok:false,message:'Telefon doğrulama süresi dolmuş. Değişikliği yeniden başlatın.'});
  const ok=await SmsVerificationProvider.verifyOtp(pending.phone,code,u.id);if(!ok)return res.status(400).json({ok:false,message:'Doğrulama kodu hatalı veya süresi dolmuş.'});if(users.some(x=>x.id!==u.id&&normalizeAccountPhone(x.phone)===pending.phone))return res.status(409).json({ok:false,message:'Bu telefon numarası başka bir hesapta kullanılıyor.'});
  const old=normalizeAccountPhone(u.phone)||u.phone;pushProfileHistory(u,'Telefon',old,pending.phone);u.phone=pending.phone;u.phoneVerifiedAt=new Date().toISOString();u.pendingPhoneChange=null;u.profileChangeMeta={...profileChangeMeta(u),phoneChangedAt:u.phoneVerifiedAt};u.updatedAt=u.phoneVerifiedAt;writeJson('users.json',users);
  const customers=readJson('customers.json',[]),ci=customers.findIndex(c=>c.id===u.customerId);if(ci>=0){customers[ci].phone=u.phone;customers[ci].updatedAt=u.updatedAt;writeJson('customers.json',customers)}await persistAccountStateToGithub().catch(e=>{console.error('Telefon değişikliği kalıcı kayıt:',e);throw e});return res.json({ok:true,user:publicUser(u)});
}));
app.post('/api/account/password',sameOriginGuard,requireUser,async(req,res)=>serializedMutation('accounts',async()=>{if(!passwordMatches(req.body.currentPassword,req.accountUser))return res.status(400).json({ok:false,message:'Mevcut şifre hatalı.'});const np=String(req.body.newPassword||'');if(!validPasswordSize(np))return res.status(400).json({ok:false,message:'Yeni şifre 8-256 karakter arasında olmalıdır.'});const users=readJson('users.json',[]),i=users.findIndex(u=>u.id===req.accountUser.id),ph=passwordHash(np);users[i].passwordSalt=ph.salt;users[i].passwordHash=ph.hash;users[i].authVersion=Number(users[i].authVersion||1)+1;users[i].updatedAt=new Date().toISOString();writeJson('users.json',users);await persistAccountStateToGithub().catch(e=>{console.error('Şifre kalıcı kayıt:',e);throw e});setUserSession(res,users[i],req);return res.json({ok:true})}));
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
app.get('/api/account/orders',requireUser,(req,res)=>{const orders=ordersWithDailyDisplayIds(readJson('orders.json',[])).filter(o=>o.userId===req.accountUser.id||o.customerId===req.accountUser.customerId);res.json({ok:true,orders})});
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
 res.status(400).json({ok:false,message:process.env.NODE_ENV==='production'?'İşlem sırasında bir hata oluştu. Lütfen tekrar deneyin.':(err.message||'İstek işlenemedi.')});
});

async function startServer(){
  // Render Free yeniden başlatıldığında yerel dosya sistemi temizlenebilir.
  // Bu yüzden [skip render] ile GitHub'a yazılan en güncel şifreli üyelik anlık görüntüsünü
  // dinlemeye başlamadan önce geri yükle; GitHub kullanılamazsa yerel seed/snapshot ile devam et.
  const remoteAccountSnapshotRestored=await restoreAccountStateFromGithub();
  const ordersSnapshotRestored=await restoreOrdersStateFromGithub();
  if(ordersSnapshotRestored)console.log('SHAZ sipariş verileri şifreli kalıcı kayıttan geri yüklendi.');
  if(remoteAccountSnapshotRestored)console.log('SHAZ üyelik verileri GitHub şifreli kalıcı kaydından geri yüklendi.');
  else if(localAccountSnapshotRestored)console.log('SHAZ üyelik verileri yerel şifreli kalıcı kayıttan kullanılıyor.');
  setInterval(()=>syncPendingOrdersToSheets().catch(()=>{}),60000);
  setTimeout(()=>syncPendingOrdersToSheets().catch(()=>{}),5000);
  app.listen(PORT,()=>console.log(`SHAZ çalışıyor: http://localhost:${PORT}`));
}
startServer().catch(e=>{console.error('SHAZ başlangıç hatası:',e);process.exitCode=1});
