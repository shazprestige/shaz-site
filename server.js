
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const {createCargoService,CARGO_STATUS_OPTIONS,redactProviderResponse}=require('./cargo-service');
const cargoService=createCargoService();
let webpush=null;
try{webpush=require('web-push')}catch(e){console.warn('web-push paketi yüklenmemiş; Web Push gönderimi devre dışı kalacak.')}
const app = express();
const PORT = process.env.PORT || 3000;
const configuredProxyHops=Number(process.env.TRUST_PROXY_HOPS||((process.env.RENDER||process.env.RENDER_EXTERNAL_URL)?1:0));
if(Number.isInteger(configuredProxyHops)&&configuredProxyHops>0)app.set('trust proxy',configuredProxyHops);
function trustedClientIp(req){return String(req.ip||req.socket?.remoteAddress||'').trim()}
function normalizeDeviceId(value){const id=String(value||'').trim();return /^[A-Za-z0-9._:-]{8,120}$/.test(id)?id:''}
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
for(const name of ['settings.json','catalog.json','orders.json','users.json','customers.json','addresses.json','favorites.json','marketing_consents.json','legal_documents.json','legal_documents_backup.json','legal_acceptances.json','phone_verifications.json','password_resets.json','pending_registrations.json','coupons.json','new_member_coupon_templates.json','account_login_attempts.json','login_events.json','push_subscriptions.json','push_delivery_log.json','marketing_integration_state.json','integration_outbox.json','integration_webhook_events.json','sms_delivery_log.json','account_state.enc']){
  const dst=path.join(dataDir,name);
  const seed=path.join(root,'data',name);
  if(!fs.existsSync(dst) && fs.existsSync(seed)) fs.copyFileSync(seed,dst);
}
console.log('SHAZ veri dizini:',persistRoot);
// Marketing/SMS webhook imzaları ham body üzerinde doğrulanır. Bu üç route global JSON parser'dan önce kalmalıdır.
app.post('/api/integrations/resend/webhook',express.raw({type:'application/json',limit:'1mb'}),handleResendMarketingWebhook);
app.post('/api/integrations/verimor/sms-webhook',express.raw({type:'application/json',limit:'1mb'}),handleVerimorSmsWebhook);
app.post('/api/integrations/verimor/iys-push',express.raw({type:'application/json',limit:'256kb'}),handleVerimorIysPush);
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
let pwaSplashBrandCache={key:'',buffer:null};
async function getPwaSplashBrandBuffer(){
  const a=brandAsset();let input=null,key='';
  if(a.remote){key='remote:'+a.remote;if(pwaSplashBrandCache.key===key&&pwaSplashBrandCache.buffer)return pwaSplashBrandCache.buffer;const r=await safeFetchImageUrl(a.remote,{cache:'no-store'});if(!r.ok)throw new Error('Splash marka görseli alınamadı.');input=Buffer.from(await r.arrayBuffer())}
  else if(a.file){const st=fs.statSync(a.file);key=`file:${a.file}:${st.size}:${st.mtimeMs}`;if(pwaSplashBrandCache.key===key&&pwaSplashBrandCache.buffer)return pwaSplashBrandCache.buffer;input=a.file}
  else throw new Error('Splash marka görseli bulunamadı.');
  const buffer=await sharp(input,{failOn:'none'}).trim({threshold:10}).png().toBuffer();pwaSplashBrandCache={key,buffer};return buffer;
}
const pwaStartupSizes=new Set(['440x956x3','420x912x3','402x874x3','430x932x3','393x852x3','428x926x3','390x844x3','360x780x3','414x896x3','375x812x3','414x896x2','375x667x2','414x736x3','320x568x2','1032x1376x2','1024x1366x2','834x1210x2','834x1194x2','820x1180x2','834x1112x2','810x1080x2','744x1133x2','768x1024x2']);
const pwaStartupCache=new Map();
app.get('/pwa-startup.png',async(req,res)=>{
  try{
    const cw=Number(req.query.cw),ch=Number(req.query.ch),dpr=Number(req.query.dpr),sizeKey=`${cw}x${ch}x${dpr}`;
    if(!pwaStartupSizes.has(sizeKey))return res.status(404).end();
    const brand=await getPwaSplashBrandBuffer(),brandHash=crypto.createHash('sha1').update(brand).digest('hex').slice(0,12),cacheKey=`${sizeKey}:${brandHash}`;
    if(pwaStartupCache.has(cacheKey))return res.type('png').set('Cache-Control','public, max-age=31536000, immutable').send(pwaStartupCache.get(cacheKey));
    const width=Math.round(cw*dpr),height=Math.round(ch*dpr),logoBox=Math.max(1,Math.round(Math.min(cw*.42,170)*dpr)),optical=(-Math.max(54,Math.min(76,ch*.0825))+30)*dpr;
    const logo=await sharp(brand,{failOn:'none'}).resize(logoBox,logoBox,{fit:'inside',withoutEnlargement:false}).png().toBuffer(),meta=await sharp(logo).metadata();
    const left=Math.round((width-Number(meta.width||logoBox))/2),top=Math.round(height/2+optical-Number(meta.height||logoBox)/2);
    const image=await sharp({create:{width,height,channels:4,background:{r:255,g:255,b:255,alpha:1}}}).composite([{input:logo,left,top}]).png().toBuffer();
    pwaStartupCache.set(cacheKey,image);
    res.type('png').set('Cache-Control','public, max-age=31536000, immutable').send(image);
  }catch(e){console.error('PWA startup image:',e?.message||e);res.status(500).end()}
});
setImmediate(()=>Promise.all([getPwaSplashBrandBuffer(),getPwaIconBuffer(180,.70)]).catch(e=>console.warn('PWA görsel önbelleği hazırlanamadı:',e?.message||e)));
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
const pwaIconCache=new Map();
async function getPwaIconBuffer(size,ratio=.70){
  const brand=await getPwaSplashBrandBuffer(),brandHash=crypto.createHash('sha1').update(brand).digest('hex').slice(0,12),key=`${size}:${ratio}:${brandHash}`;
  if(pwaIconCache.has(key))return pwaIconCache.get(key);
  const safe=Math.max(1,Math.round(size*ratio));
  const logo=await sharp(brand,{failOn:'none'}).resize(safe,safe,{fit:'inside',withoutEnlargement:false}).png().toBuffer();
  const canvas=await sharp({create:{width:size,height:size,channels:4,background:{r:255,g:255,b:255,alpha:1}}}).composite([{input:logo,gravity:'center'}]).png().toBuffer();
  pwaIconCache.set(key,canvas);return canvas;
}
async function sendPwaIcon(req,res,size,ratio=.70){
  try{const canvas=await getPwaIconBuffer(size,ratio);res.type('png').set('Cache-Control','public, max-age=86400, must-revalidate').send(canvas)}
  catch(e){console.error('PWA ikon üretimi:',e);res.status(500).end()}
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
const loginKey=req=>trustedClientIp(req);
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

const CRITICAL_JSON_FILES=new Set(['orders.json','users.json','customers.json','coupons.json','addresses.json','legal_acceptances.json','pending_registrations.json','marketing_integration_state.json','integration_outbox.json','cargo_feature_state.json','cargo_order_index.json','cargo_records.json','cargo_events.json']);
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
const RESEND_MARKETING_SYNC_ENABLED=/^(1|true|yes)$/i.test(String(process.env.RESEND_MARKETING_SYNC_ENABLED||'false'));
const RESEND_MARKETING_API_KEY=String(process.env.RESEND_MARKETING_API_KEY||'').trim();
const RESEND_MARKETING_TOPIC_ID=String(process.env.RESEND_MARKETING_TOPIC_ID||'').trim();
const RESEND_WEBHOOK_SECRET=String(process.env.RESEND_WEBHOOK_SECRET||'').trim();
const VERIMOR_SMS_ENABLED=/^(1|true|yes)$/i.test(String(process.env.VERIMOR_SMS_ENABLED||'false'));
const VERIMOR_WEBHOOK_ENABLED=/^(1|true|yes)$/i.test(String(process.env.VERIMOR_WEBHOOK_ENABLED||'false'));
const VERIMOR_IYS_SYNC_ENABLED=/^(1|true|yes)$/i.test(String(process.env.VERIMOR_IYS_SYNC_ENABLED||'false'));
const VERIMOR_IYS_PUSH_ENABLED=/^(1|true|yes)$/i.test(String(process.env.VERIMOR_IYS_PUSH_ENABLED||'false'));
const VERIMOR_USERNAME=String(process.env.VERIMOR_USERNAME||'').trim();
const VERIMOR_API_PASSWORD=String(process.env.VERIMOR_API_PASSWORD||process.env.VERIMOR_PASSWORD||'').trim();
const VERIMOR_SOURCE_ADDR=String(process.env.VERIMOR_SOURCE_ADDR||'').trim();
const VERIMOR_WEBHOOK_SECRET=String(process.env.VERIMOR_WEBHOOK_SECRET||'').trim();
const VERIMOR_IYS_DEFAULT_RECIPIENT_TYPE=String(process.env.VERIMOR_IYS_DEFAULT_RECIPIENT_TYPE||'').trim().toUpperCase();
const INTEGRATION_WORKER_SECRET=String(process.env.INTEGRATION_WORKER_SECRET||'').trim();
// Web Push: mevcut VAPID adlarını esas al, daha eski/alternatif deploy adlarını da geriye uyumlu oku.
const VAPID_PUBLIC_KEY=String(process.env.VAPID_PUBLIC_KEY||process.env.WEB_PUSH_VAPID_PUBLIC_KEY||process.env.WEB_PUSH_PUBLIC_KEY||process.env.WEBPUSH_PUBLIC_KEY||'').trim();
const VAPID_PRIVATE_KEY=String(process.env.VAPID_PRIVATE_KEY||process.env.WEB_PUSH_VAPID_PRIVATE_KEY||process.env.WEB_PUSH_PRIVATE_KEY||process.env.WEBPUSH_PRIVATE_KEY||'').trim();
const VAPID_SUBJECT=String(process.env.VAPID_SUBJECT||process.env.WEB_PUSH_VAPID_SUBJECT||process.env.WEB_PUSH_SUBJECT||process.env.WEBPUSH_SUBJECT||'').trim();
const accountLoginAttempts=new Map();
for(const [name,fallback] of Object.entries({
  'users.json':[],'customers.json':[],'addresses.json':[],'favorites.json':[],'marketing_consents.json':[],'legal_acceptances.json':[],'phone_verifications.json':[],'password_resets.json':[],'pending_registrations.json':[],'new_member_coupon_templates.json':[],'account_login_attempts.json':{},'login_events.json':[],'push_subscriptions.json':[],'customer_activity.json':[],'whatsapp_templates.json':[],'admin_preferences.json':{},'marketing_integration_state.json':{version:1,users:{}},'integration_outbox.json':[],'integration_webhook_events.json':[],'sms_delivery_log.json':[],'legal_documents_backup.json':[],
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

// ---------- v178: Marketing consent / Resend / Verimor / İYS entegrasyon altyapısı ----------
// Bu katman mevcut emailMarketingConsent ve smsMarketingConsent alanlarını kullanır; ikinci bir kullanıcı tercihi sistemi oluşturmaz.
const INTEGRATION_MAX_ATTEMPTS=6;
function integrationNow(){return new Date().toISOString()}
function integrationState(){const x=readJson('marketing_integration_state.json',{version:1,users:{}});if(!x||typeof x!=='object')return {version:1,users:{}};if(!x.users||typeof x.users!=='object')x.users={};return x}
function integrationUserState(state,userId){state.users[userId]=state.users[userId]||{};return state.users[userId]}
function maskedEmail(v){const e=normalizeEmail(v),i=e.indexOf('@');if(i<1)return '***';return e.slice(0,1)+'***'+e.slice(i)}
function maskedPhone(v){const p=normalizeAccountPhone(v);return p?p.slice(0,3)+'***'+p.slice(-2):'***'}
function latestConsentAudit(userId,channel,recipient=''){
  const nr=channel==='email'?normalizeEmail(recipient):normalizeAccountPhone(recipient);
  return readJson('marketing_consents.json',[]).filter(x=>x.userId===userId&&x.channel===channel&&(!nr||(channel==='email'?normalizeEmail(x.consentRecipient||x.recipient||'')===nr:normalizeAccountPhone(x.consentRecipient||x.recipient||'')===nr))).sort((a,b)=>new Date(b.at||0)-new Date(a.at||0))[0]||null;
}
function appendConsentAudit({req,user,channel,granted,source,recipient,at=integrationNow(),providerEventId=null,providerAt=null,previousGranted:previousGrantedInput}){
  const cons=readJson('marketing_consents.json',[]);
  const normalizedRecipient=channel==='email'?normalizeEmail(recipient||user?.email):normalizeAccountPhone(recipient||user?.phone);
  const previous=[...cons].reverse().find(x=>x.userId===user.id&&x.channel===channel),previousGranted=previousGrantedInput===undefined?(previous?!!previous.granted:null):!!previousGrantedInput;
  const row={id:crypto.randomUUID(),userId:user.id,channel,granted:!!granted,previousGranted,newGranted:!!granted,at,serverTimestamp:at,source,textVersion:'1',consentRecipient:normalizedRecipient,consentVersion:at,consentSource:source,consentAt:granted?at:null,revokedAt:granted?null:at,providerEventId,providerAt};
  if(req){row.ip=consentIp(req);row.userAgent=String(req.headers['user-agent']||'')}
  cons.push(row);writeJson('marketing_consents.json',cons);return row;
}
function makeIntegrationJob({provider,action,channel,user,destination,consentVersion,payload={}}){
  const jobs=readJson('integration_outbox.json',[]);
  const normalized=channel==='email'?normalizeEmail(destination):normalizeAccountPhone(destination);
  // Aynı güncel tercih için aynı bekleyen job'ı çoğaltma.
  const existing=jobs.find(j=>j.provider===provider&&j.action===action&&j.userId===user.id&&j.destination===normalized&&j.consentVersion===consentVersion&&['pending','processing','unknown'].includes(j.status));
  if(existing)return existing;
  const now=integrationNow(),job={id:'JOB-'+crypto.randomUUID(),provider,action,channel,userId:user.id,customerId:user.customerId||null,destination:normalized,consentVersion,preferenceUpdatedAt:consentVersion,status:'pending',attempts:0,nextRetryAt:now,lastError:null,providerReferenceId:null,payload,createdAt:now,updatedAt:now};
  jobs.push(job);writeJson('integration_outbox.json',jobs);return job;
}
function recordLocalMarketingDecision({req,user,channel,granted,source,recipient,at=integrationNow(),previousGranted}){
  const audit=appendConsentAudit({req,user,channel,granted,source,recipient,at,previousGranted});
  const st=integrationState(),us=integrationUserState(st,user.id),dest=channel==='email'?normalizeEmail(recipient||user.email):normalizeAccountPhone(recipient||user.phone);
  us[channel]={...(us[channel]||{}),destination:dest,localGranted:!!granted,lastLocalDecisionAt:at,consentRecipient:dest,consentVersion:at,consentSource:source,needsReconcile:true};
  writeJson('marketing_integration_state.json',st);
  if(channel==='email'&&RESEND_MARKETING_SYNC_ENABLED)makeIntegrationJob({provider:'resend',action:'sync_email_consent',channel,user,destination:dest,consentVersion:at,payload:{granted:!!granted}});
  if(VERIMOR_IYS_SYNC_ENABLED){
    const verified=channel==='email'?!!user.emailVerifiedAt:!!user.phoneVerifiedAt;
    if(verified&&VERIMOR_IYS_DEFAULT_RECIPIENT_TYPE)makeIntegrationJob({provider:'verimor_iys',action:'sync_iys_consent',channel,user,destination:dest,consentVersion:at,payload:{granted:!!granted,source:'HS_WEB',recipientType:VERIMOR_IYS_DEFAULT_RECIPIENT_TYPE}});
  }
  return audit;
}
function cancelStaleMarketingJobs(userId,channel,latestVersion){
  const jobs=readJson('integration_outbox.json',[]);let changed=false;
  for(const j of jobs){if(j.userId===userId&&j.channel===channel&&['pending','failed','unknown'].includes(j.status)&&String(j.consentVersion||'')!==String(latestVersion||'')){j.status='cancelled';j.lastError='Daha yeni kullanıcı tercihi mevcut.';j.updatedAt=integrationNow();changed=true}}
  if(changed)writeJson('integration_outbox.json',jobs);
}
function integrationJobFeatureEnabled(job){
  if(job?.provider==='resend'&&job.action==='sync_email_consent')return RESEND_MARKETING_SYNC_ENABLED;
  if(job?.provider==='verimor_iys'&&job.action==='sync_iys_consent')return VERIMOR_IYS_SYNC_ENABLED;
  if(job?.provider==='verimor_iys'&&job.action==='pull_iys_campaign')return VERIMOR_IYS_PUSH_ENABLED;
  return true;
}
function recordContactChangeMarketingDecision({req,user,channel,granted,recipient,previousRecipient,at=integrationNow(),previousGranted}){
  const dest=channel==='email'?normalizeEmail(recipient):normalizeAccountPhone(recipient),prev=channel==='email'?normalizeEmail(previousRecipient):normalizeAccountPhone(previousRecipient),source=channel==='email'?'account_email_change':'account_phone_change';
  const audit=appendConsentAudit({req,user,channel,granted:!!granted,source,recipient:dest,at,previousGranted});
  const st=integrationState(),us=integrationUserState(st,user.id);
  us[channel]={...(us[channel]||{}),destination:dest,previousDestination:prev||null,localGranted:!!granted,requiresRecipientReconsent:false,needsReconcile:true,destinationChangedAt:at,lastLocalDecisionAt:at,consentRecipient:granted?dest:null,consentVersion:at,consentSource:source};
  writeJson('marketing_integration_state.json',st);
  if(channel==='email'){
    if(prev&&prev!==dest)makeIntegrationJob({provider:'resend',action:'sync_email_consent',channel:'email',user,destination:prev,consentVersion:at,payload:{granted:false,reason:'destination_changed'}});
    makeIntegrationJob({provider:'resend',action:'sync_email_consent',channel:'email',user,destination:dest,consentVersion:at,payload:{granted:!!granted,reason:granted?'contact_change_consent':'contact_change_no_consent'}});
  }
  if(granted)makeIntegrationJob({provider:'verimor_iys',action:'sync_iys_consent',channel,user,destination:dest,consentVersion:at,payload:{granted:true,source:'HS_WEB',recipientType:VERIMOR_IYS_DEFAULT_RECIPIENT_TYPE}});
  cancelStaleMarketingJobs(user.id,channel,at);
  return audit;
}
function safeJsonParseBuffer(buf){try{return JSON.parse(Buffer.isBuffer(buf)?buf.toString('utf8'):String(buf||''))}catch{return null}}
function timingSafeText(a,b){const aa=Buffer.from(String(a||'')),bb=Buffer.from(String(b||''));return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb)}
function verifyResendWebhookRaw(raw,headers){
  if(!RESEND_WEBHOOK_SECRET)return false;
  const id=String(headers['svix-id']||''),ts=String(headers['svix-timestamp']||''),sig=String(headers['svix-signature']||'');
  if(!id||!ts||!sig)return false;
  const secret=RESEND_WEBHOOK_SECRET.replace(/^whsec_/,'');let key;try{key=Buffer.from(secret,'base64')}catch{return false}
  const expected=crypto.createHmac('sha256',key).update(`${id}.${ts}.${raw.toString('utf8')}`).digest('base64');
  return sig.split(/\s+/).some(part=>{const x=part.includes(',')?part.split(',').pop():part;return timingSafeText(x,expected)});
}
function verifyVerimorWebhookRaw(raw,header){
  if(!VERIMOR_WEBHOOK_SECRET)return false;
  const got=String(header||'').trim().replace(/^sha256=/i,'').toLowerCase();
  const exp=crypto.createHmac('sha256',VERIMOR_WEBHOOK_SECRET).update(raw).digest('hex').toLowerCase();
  return timingSafeText(got,exp);
}
function webhookSeen(id){return readJson('integration_webhook_events.json',[]).some(x=>x.id===id)}
function rememberWebhook(id,provider,type,at){
  const arr=readJson('integration_webhook_events.json',[]),cut=Date.now()-30*86400000;
  const clean=arr.filter(x=>new Date(x.processedAt||x.at||0).getTime()>=cut);
  clean.push({id,provider,type,at:at||null,processedAt:integrationNow()});writeJson('integration_webhook_events.json',clean.slice(-5000));
}
async function handleResendMarketingWebhook(req,res){
  if(!RESEND_MARKETING_SYNC_ENABLED)return res.status(204).end();
  const raw=Buffer.isBuffer(req.body)?req.body:Buffer.from('');
  if(!verifyResendWebhookRaw(raw,req.headers))return res.status(401).send('invalid signature');
  const event=safeJsonParseBuffer(raw);if(!event)return res.status(400).send('invalid json');
  const eventId=String(req.headers['svix-id']||event.id||'');if(!eventId)return res.status(400).end();if(webhookSeen('resend:'+eventId))return res.status(204).end();
  const type=String(event.type||''),data=event.data||{},email=normalizeEmail(data.email||data.contact?.email||'');
  try{
    if(type==='contact.updated'&&email&&data.unsubscribed===true){
      await serializedMutation('accounts',async()=>{
        const users=readJson('users.json',[]),i=users.findIndex(u=>!u.deleted&&normalizeEmail(u.email)===email);if(i<0)return;
        const u=users[i],providerAt=String(data.updated_at||event.created_at||integrationNow()),last=latestConsentAudit(u.id,'email',email),lastLocalAt=new Date(last?.at||0).getTime(),providerTs=new Date(providerAt).getTime();
        if(Number.isFinite(providerTs)&&providerTs<lastLocalAt)return;
        if(u.emailMarketingConsent!==false){const previousGranted=!!u.emailMarketingConsent;u.emailMarketingConsent=false;u.updatedAt=integrationNow();users[i]=u;writeJson('users.json',users);appendConsentAudit({user:u,channel:'email',granted:false,source:'resend_unsubscribe',recipient:email,at:providerAt,providerEventId:eventId,providerAt,previousGranted});cancelStaleMarketingJobs(u.id,'email',providerAt);publishAdminMemberUpdate(u.id,'consent')}
        const st=integrationState(),us=integrationUserState(st,u.id);us.email={...(us.email||{}),destination:email,localGranted:false,providerUnsubscribedAt:providerAt,lastProviderEventAt:providerAt,needsReconcile:false};writeJson('marketing_integration_state.json',st);await persistAccountStateToGithub().catch(()=>{});
      });
    }else if(type==='suppression.added'||type==='suppression.removed'){
      const st=integrationState(),users=readJson('users.json',[]),u=users.find(x=>!x.deleted&&normalizeEmail(x.email)===email);if(u){const us=integrationUserState(st,u.id);us.email={...(us.email||{}),destination:email,deliverabilitySuppressed:type==='suppression.added',suppressionUpdatedAt:String(event.created_at||integrationNow())};writeJson('marketing_integration_state.json',st)}
    }
    rememberWebhook('resend:'+eventId,'resend',type,event.created_at);
    res.status(204).end();
  }catch(e){console.error('Resend marketing webhook:',e?.message||e);res.status(500).end()}
}
async function handleVerimorSmsWebhook(req,res){
  if(!VERIMOR_WEBHOOK_ENABLED)return res.status(204).end();
  const raw=Buffer.isBuffer(req.body)?req.body:Buffer.from('');
  if(!verifyVerimorWebhookRaw(raw,req.headers['x-verimor-signature']))return res.status(401).send('invalid signature');
  const payload=safeJsonParseBuffer(raw);if(!payload)return res.status(400).end();
  const rows=Array.isArray(payload)?payload:[payload],logs=readJson('sms_delivery_log.json',[]);
  for(const row of rows){
    const mid=String(row.message_id||row.id||row.custom_id||'');if(!mid)continue;
    const status=String(row.status||row.state||'').toUpperCase(),eid='verimor:sms:'+mid+':'+status;if(webhookSeen(eid))continue;
    const old=logs.find(x=>x.providerMessageId===mid||x.customId===String(row.custom_id||''));if(old){old.status=status||old.status;old.updatedAt=integrationNow()}else logs.push({id:'SMS-'+crypto.randomUUID(),provider:'verimor',providerMessageId:mid,customId:String(row.custom_id||''),status,createdAt:integrationNow(),updatedAt:integrationNow()});
    rememberWebhook(eid,'verimor_sms','delivery',integrationNow());
  }
  writeJson('sms_delivery_log.json',logs.slice(-10000));res.status(204).end();
}
async function handleVerimorIysPush(req,res){
  if(!VERIMOR_IYS_PUSH_ENABLED)return res.status(204).end();
  const raw=Buffer.isBuffer(req.body)?req.body:Buffer.from('');
  if(!verifyVerimorWebhookRaw(raw,req.headers['x-verimor-signature']))return res.status(401).send('invalid signature');
  const body=safeJsonParseBuffer(raw);const campaignId=String(body?.iys_campaign_id||body?.campaign_id||'').trim();
  if(!campaignId)return res.status(400).end();
  const fakeUser={id:'SYSTEM',customerId:null};makeIntegrationJob({provider:'verimor_iys',action:'pull_iys_campaign',channel:'system',user:fakeUser,destination:campaignId,consentVersion:String(body.report_date||integrationNow()),payload:{campaignId}});
  res.status(202).end();
}
async function resendMarketingRequest(pathname,{method='GET',body}={}){
  if(!RESEND_MARKETING_SYNC_ENABLED)throw new Error('Resend marketing sync kapalı.');
  if(!RESEND_MARKETING_API_KEY||!RESEND_MARKETING_TOPIC_ID)throw new Error('Resend marketing yapılandırması eksik.');
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),12000);
  try{const r=await fetch('https://api.resend.com'+pathname,{method,headers:{Authorization:`Bearer ${RESEND_MARKETING_API_KEY}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:ctl.signal});const text=await r.text();let data=null;try{data=text?JSON.parse(text):null}catch{};if(!r.ok){const e=new Error('Resend marketing request başarısız: '+r.status);e.status=r.status;e.data=data;throw e}return data}finally{clearTimeout(timer)}
}
async function upsertResendMarketingContact(user,granted,destination){
  const email=normalizeEmail(destination);if(!email)throw new Error('Geçersiz e-posta.');
  const body={email,first_name:String(user.firstName||'').trim()||undefined,last_name:String(user.lastName||'').trim()||undefined,unsubscribed:!granted};Object.keys(body).forEach(k=>body[k]===undefined&&delete body[k]);
  try{await resendMarketingRequest('/contacts',{method:'POST',body})}catch(e){if(e.status===409)await resendMarketingRequest('/contacts/'+encodeURIComponent(email),{method:'PATCH',body});else throw e}
  await resendMarketingRequest('/contacts/'+encodeURIComponent(email)+'/topics',{method:'PATCH',body:{topics:[{id:RESEND_MARKETING_TOPIC_ID,subscription:granted?'opt_in':'opt_out'}]}});
}
async function verimorRequest(pathname,body){
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),15000);try{const r=await fetch('https://sms.verimor.com.tr'+pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:ctl.signal});const text=await r.text();if(!r.ok)throw new Error('Verimor request başarısız: '+r.status);return text}finally{clearTimeout(timer)}
}
function verimorConfigReady(){return !!(VERIMOR_USERNAME&&VERIMOR_API_PASSWORD&&VERIMOR_SOURCE_ADDR)}
function toVerimorPhone(v){const p=normalizeAccountPhone(v);return p?'90'+p.slice(1):''}
async function sendVerimorTransactionalSms({phone,message,customId}){
  if(!VERIMOR_SMS_ENABLED)return {skipped:true,reason:'disabled'};if(!verimorConfigReady())throw new Error('Verimor SMS yapılandırması eksik.');
  const dest=toVerimorPhone(phone);if(!dest)throw new Error('Geçersiz telefon numarası.');
  const text=await verimorRequest('/v2/send.json',{username:VERIMOR_USERNAME,password:VERIMOR_API_PASSWORD,source_addr:VERIMOR_SOURCE_ADDR,custom_id:customId||('SHAZ-'+crypto.randomUUID()),messages:[{dest,msg:String(message||'')}]});return {ok:true,providerReferenceId:String(text||'').trim()};
}
async function sendVerimorMarketingSms({userId,message,recipientType,customId}){
  if(!VERIMOR_SMS_ENABLED)return {skipped:true,reason:'disabled'};const u=readJson('users.json',[]).find(x=>x.id===userId&&!x.deleted&&!x.disabled);if(!u||u.smsMarketingConsent!==true)throw new Error('SMS marketing izni yok.');
  const audit=latestConsentAudit(u.id,'sms',u.phone);if(!audit?.granted||!audit.consentAt)throw new Error('SMS consent kanıtı eksik.');
  if(!verimorConfigReady())throw new Error('Verimor SMS yapılandırması eksik.');const rt=String(recipientType||VERIMOR_IYS_DEFAULT_RECIPIENT_TYPE||'').toUpperCase();if(!['BIREYSEL','TACIR'].includes(rt))throw new Error('İYS recipient type eksik.');
  const dest=toVerimorPhone(u.phone);if(!dest)throw new Error('Geçersiz telefon numarası.');
  const cid=customId||('SHAZ-'+crypto.randomUUID()),text=await verimorRequest('/v2/send.json',{username:VERIMOR_USERNAME,password:VERIMOR_API_PASSWORD,source_addr:VERIMOR_SOURCE_ADDR,is_commercial:true,iys_recipient_type:rt,add_ret:true,custom_id:cid,messages:[{dest,msg:String(message||''),id:cid}]});return {ok:true,providerReferenceId:String(text||'').trim(),customId:cid};
}
async function syncVerimorIysJob(job,user){
  if(!VERIMOR_IYS_SYNC_ENABLED)throw new Error('Verimor İYS sync kapalı.');if(!verimorConfigReady())throw new Error('Verimor İYS yapılandırması eksik.');
  const rt=String(job.payload?.recipientType||VERIMOR_IYS_DEFAULT_RECIPIENT_TYPE||'').toUpperCase();if(!['BIREYSEL','TACIR'].includes(rt))throw new Error('İYS recipient type eksik.');
  const audit=latestConsentAudit(user.id,job.channel,job.destination);if(!audit||String(audit.consentVersion||audit.at)!==String(job.consentVersion)||!audit.consentAt&&!audit.revokedAt)throw new Error('Güncel consent metadata bulunamadı.');
  const recipient=job.channel==='email'?normalizeEmail(job.destination):toVerimorPhone(job.destination),type=job.channel==='email'?'EPOSTA':'MESAJ';
  const date=new Date(audit.at);const consent_date=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}:${String(date.getSeconds()).padStart(2,'0')}`;
  return verimorRequest('/v2/iys_consents.json',{username:VERIMOR_USERNAME,password:VERIMOR_API_PASSWORD,source_addr:VERIMOR_SOURCE_ADDR,consents:[{recipient,status:audit.granted?'ONAY':'RET',type,source:String(job.payload?.source||'HS_WEB'),consent_date,recipient_type:rt}]});
}
async function processIntegrationOutbox(limit=20){
  const claimed=await serializedMutation('accounts',async()=>{const jobs=readJson('integration_outbox.json',[]),now=Date.now(),take=[];for(const j of jobs){if(take.length>=limit)break;if(!['pending','failed'].includes(j.status)||!integrationJobFeatureEnabled(j)||new Date(j.nextRetryAt||0).getTime()>now||Number(j.attempts||0)>=INTEGRATION_MAX_ATTEMPTS)continue;j.status='processing';j.claimedAt=integrationNow();j.updatedAt=j.claimedAt;take.push({...j})}writeJson('integration_outbox.json',jobs);return take});
  for(const job of claimed){
    let result=null,error=null;try{
      const user=readJson('users.json',[]).find(x=>x.id===job.userId&&!x.deleted&&!x.disabled);
      if(job.userId!=='SYSTEM'&&!user)throw new Error('Kullanıcı aktif değil.');
      if(user&&!['destination_changed','contact_change_no_consent'].includes(job.payload?.reason)){const current=user[job.channel==='email'?'emailMarketingConsent':'smsMarketingConsent'];const latest=latestConsentAudit(user.id,job.channel,job.destination);if(job.action!=='pull_iys_campaign'&&(!latest||String(latest.consentVersion||latest.at)!==String(job.consentVersion)||!!current!==!!job.payload?.granted))throw Object.assign(new Error('Stale job'),{cancel:true})}
      if(job.provider==='resend'&&job.action==='sync_email_consent'){await upsertResendMarketingContact(user,!!job.payload.granted,job.destination);result='synced'}
      else if(job.provider==='verimor_iys'&&job.action==='sync_iys_consent'){result=await syncVerimorIysJob(job,user)}
      else if(job.provider==='verimor_iys'&&job.action==='pull_iys_campaign'){if(!VERIMOR_IYS_PUSH_ENABLED||!verimorConfigReady())throw new Error('İYS Push yapılandırması eksik.');const url=`https://sms.verimor.com.tr/v2/iys/campaigns/${encodeURIComponent(job.payload.campaignId)}/consents?username=${encodeURIComponent(VERIMOR_USERNAME)}&password=${encodeURIComponent(VERIMOR_API_PASSWORD)}`;const r=await fetch(url);if(!r.ok)throw new Error('İYS campaign detail alınamadı: '+r.status);result=await r.json();await reconcileVerifiedIysRows(Array.isArray(result)?result:(result?.consents||[]),job.payload.campaignId)}
      else throw new Error('Bilinmeyen integration job.');
    }catch(e){error=e}
    await serializedMutation('accounts',async()=>{const jobs=readJson('integration_outbox.json',[]),j=jobs.find(x=>x.id===job.id);if(!j)return;if(error?.cancel){j.status='cancelled';j.lastError='Daha yeni kullanıcı tercihi mevcut.'}else if(error){j.attempts=Number(j.attempts||0)+1;j.status=j.attempts>=INTEGRATION_MAX_ATTEMPTS?'failed':'failed';j.lastError=String(error.message||'Entegrasyon hatası').slice(0,240);j.nextRetryAt=new Date(Date.now()+Math.min(6*3600000,30000*Math.pow(2,Math.max(0,j.attempts-1)))).toISOString()}else{j.status='done';j.lastError=null;j.providerReferenceId=typeof result==='string'?String(result).slice(0,120):j.providerReferenceId}j.updatedAt=integrationNow();writeJson('integration_outbox.json',jobs)});
  }
  return claimed.length;
}
async function reconcileVerifiedIysRows(rows,campaignId){
  await serializedMutation('accounts',async()=>{const users=readJson('users.json',[]),state=integrationState();let changed=false;for(const row of rows){const status=String(row.status||'').toUpperCase(),type=String(row.type||'').toUpperCase(),recipient=String(row.recipient||'').trim();if(!['ONAY','RET'].includes(status)||!['EPOSTA','MESAJ'].includes(type))continue;const u=type==='EPOSTA'?users.find(x=>!x.deleted&&normalizeEmail(x.email)===normalizeEmail(recipient)):users.find(x=>!x.deleted&&toVerimorPhone(x.phone)===recipient);if(!u)continue;const validMeta=!!row.consent_date&&!!row.source&&!!row.recipient_type;if(status==='ONAY'&&!validMeta)continue;const key=type==='EPOSTA'?'emailMarketingConsent':'smsMarketingConsent',channel=type==='EPOSTA'?'email':'sms',grant=status==='ONAY';if(u[key]!==grant){const previousGranted=!!u[key];u[key]=grant;u.updatedAt=integrationNow();appendConsentAudit({user:u,channel,granted:grant,source:'iys_verified_'+status.toLowerCase(),recipient:channel==='email'?u.email:u.phone,at:String(row.consent_date||integrationNow()),providerEventId:'iys:'+campaignId,providerAt:String(row.consent_date||integrationNow()),previousGranted});publishAdminMemberUpdate(u.id,'consent');changed=true}const us=integrationUserState(state,u.id);us[channel]={...(us[channel]||{}),iysStatus:status,iysUpdatedAt:String(row.consent_date||integrationNow()),needsReconcile:channel==='email'};if(channel==='email'&&grant===false&&RESEND_MARKETING_SYNC_ENABLED)makeIntegrationJob({provider:'resend',action:'sync_email_consent',channel:'email',user:u,destination:u.email,consentVersion:String(row.consent_date||integrationNow()),payload:{granted:false}})}if(changed)writeJson('users.json',users);writeJson('marketing_integration_state.json',state);await persistAccountStateToGithub().catch(()=>{})})
}
function marketingDryRun(){
  const users=readJson('users.json',[]).filter(u=>!u.deleted),emails=new Map(),phones=new Map();let emailTrue=0,emailFalse=0,emailNull=0,smsTrue=0,smsFalse=0,smsNull=0,invalidEmail=0,invalidPhone=0,missingEmailEvidence=0,missingSmsEvidence=0;
  for(const u of users){if(u.emailMarketingConsent===true)emailTrue++;else if(u.emailMarketingConsent===false)emailFalse++;else emailNull++;if(u.smsMarketingConsent===true)smsTrue++;else if(u.smsMarketingConsent===false)smsFalse++;else smsNull++;const e=normalizeEmail(u.email),p=normalizeAccountPhone(u.phone);if(!e||!e.includes('@'))invalidEmail++;else emails.set(e,(emails.get(e)||0)+1);if(!p)invalidPhone++;else phones.set(p,(phones.get(p)||0)+1);if(u.emailMarketingConsent===true&&!latestConsentAudit(u.id,'email',u.email)?.consentAt)missingEmailEvidence++;if(u.smsMarketingConsent===true&&!latestConsentAudit(u.id,'sms',u.phone)?.consentAt)missingSmsEvidence++}
  return {totalUsers:users.length,email:{allowed:emailTrue,blocked:emailFalse,unknown:emailNull,invalid:invalidEmail,duplicates:[...emails].filter(([,n])=>n>1).length,missingConsentEvidence:missingEmailEvidence},sms:{allowed:smsTrue,blocked:smsFalse,unknown:smsNull,invalid:invalidPhone,duplicates:[...phones].filter(([,n])=>n>1).length,missingConsentEvidence:missingSmsEvidence},pendingJobs:readJson('integration_outbox.json',[]).filter(j=>['pending','failed','unknown'].includes(j.status)).length};
}

function enqueueCurrentConsentReconcile(){
  const users=readJson('users.json',[]).filter(u=>!u.deleted&&!u.disabled),summary={resend:0,iys:0,skippedEvidence:0,skippedVerification:0};
  for(const u of users){
    const ea=latestConsentAudit(u.id,'email',u.email),email=normalizeEmail(u.email);
    if(RESEND_MARKETING_SYNC_ENABLED&&email){
      if(u.emailMarketingConsent===false||ea?.consentAt&&ea.granted===true){const version=String(ea?.consentVersion||ea?.at||u.updatedAt||integrationNow());makeIntegrationJob({provider:'resend',action:'sync_email_consent',channel:'email',user:u,destination:email,consentVersion:version,payload:{granted:u.emailMarketingConsent===true}});summary.resend++}
      else summary.skippedEvidence++;
    }
    if(VERIMOR_IYS_SYNC_ENABLED){
      for(const [channel,key,dest,verified] of [['email','emailMarketingConsent',u.email,!!u.emailVerifiedAt],['sms','smsMarketingConsent',u.phone,!!u.phoneVerifiedAt]]){
        const a=latestConsentAudit(u.id,channel,dest);if(!verified){summary.skippedVerification++;continue}if(!a?.at||a.granted===true&&!a.consentAt){summary.skippedEvidence++;continue}
        if(!VERIMOR_IYS_DEFAULT_RECIPIENT_TYPE){summary.skippedEvidence++;continue}
        makeIntegrationJob({provider:'verimor_iys',action:'sync_iys_consent',channel,user:u,destination:dest,consentVersion:String(a.consentVersion||a.at),payload:{granted:!!a.granted,source:'HS_WEB',recipientType:VERIMOR_IYS_DEFAULT_RECIPIENT_TYPE}});summary.iys++;
      }
    }
  }
  return summary;
}

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
function publicUser(u){if(!u)return null;const meta=profileChangeMeta(u);return {id:u.id,customerId:u.customerId,firstName:u.firstName,lastName:u.lastName,email:u.email,phone:normalizeAccountPhone(u.phone)||u.phone,birthDate:u.birthDate||'',emailVerifiedAt:u.emailVerifiedAt||null,phoneVerifiedAt:u.phoneVerifiedAt||null,smsMarketingConsent:!!u.smsMarketingConsent,emailMarketingConsent:!!u.emailMarketingConsent,createdAt:u.createdAt,authProviders:Array.isArray(u.authProviders)?u.authProviders:(u.passwordHash?['password']:[]),profileChangeMeta:meta,profileRules:{nameWaitMs:profileWaitMs(meta.nameChangedAt,PROFILE_NAME_COOLDOWN_MS),phoneWaitMs:profileWaitMs(meta.phoneChangedAt,PROFILE_PHONE_COOLDOWN_MS),birthDateChangeAvailable:meta.birthDateUserChangeCount<1},pendingEmailChange:u.pendingEmailChange?{changeId:u.pendingEmailChange.changeId||null,email:u.pendingEmailChange.email,requestedAt:u.pendingEmailChange.requestedAt,expiresAt:u.pendingEmailChange.expiresAt,resendAt:u.pendingEmailChange.resendAt||null,purpose:u.pendingEmailChange.purpose||'legacy',attemptsRemaining:Math.max(0,5-Number(u.pendingEmailChange.attemptCount||0))}:null,pendingPhoneChange:u.pendingPhoneChange?{changeId:u.pendingPhoneChange.changeId||null,phone:u.pendingPhoneChange.phone,requestedAt:u.pendingPhoneChange.requestedAt,expiresAt:u.pendingPhoneChange.expiresAt}:null}}
function signUserSession(user,sessionId=''){if(!USER_SESSION_SECRET)return '';const payload=Buffer.from(JSON.stringify({uid:user.id,iat:Date.now(),v:Number(user.authVersion||1),sid:String(sessionId||'').slice(0,120)})).toString('base64url');const sig=crypto.createHmac('sha256',USER_SESSION_SECRET).update(payload).digest('base64url');return payload+'.'+sig}
function accountUserFromReq(req){if(!USER_SESSION_SECRET)return null;const token=parseCookies(req)[USER_SESSION_COOKIE];if(!token)return null;const [payload,sig]=token.split('.');if(!payload||!sig)return null;const exp=crypto.createHmac('sha256',USER_SESSION_SECRET).update(payload).digest('base64url');if(!safeEqual(sig,exp))return null;let data;try{data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'))}catch{return null}if(!data.uid||Date.now()-Number(data.iat||0)>USER_SESSION_MAX_AGE_MS)return null;const u=readJson('users.json',[]).find(x=>x.id===data.uid);if(!u||u.disabled||Number(u.authVersion||1)!==Number(data.v||1))return null;return u}
function setUserSession(res,user,req,sessionId=''){const secure=process.env.NODE_ENV==='production'||String(req.headers['x-forwarded-proto']||'').includes('https');const sid=String(sessionId||('SES-'+crypto.randomUUID())).slice(0,120),token=signUserSession(user,sid);res.setHeader('Set-Cookie',`${USER_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${USER_SESSION_MAX_AGE_MS/1000}${secure?'; Secure':''}`);return sid}
function clearUserSession(res,req){const secure=process.env.NODE_ENV==='production'||String(req.headers['x-forwarded-proto']||'').includes('https');res.setHeader('Set-Cookie',`${USER_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure?'; Secure':''}`)}
function requireUser(req,res,next){const u=accountUserFromReq(req);if(!u)return res.status(401).json({ok:false,message:'Giriş yapmanız gerekiyor.'});req.accountUser=u;next()}
function sameOriginGuard(req,res,next){if(['GET','HEAD','OPTIONS'].includes(req.method))return next();const origin=String(req.headers.origin||'');const host=String(req.headers.host||'');if(origin){try{if(new URL(origin).host!==host)return res.status(403).json({ok:false,message:'Geçersiz istek kaynağı.'})}catch{return res.status(403).json({ok:false,message:'Geçersiz istek kaynağı.'})}}next()}
const accountRateKey=req=>trustedClientIp(req);
const ACCOUNT_LOGIN_MAX_ATTEMPTS=5;
function accountLoginDeviceId(req){return normalizeDeviceId(req.body?.deviceId||req.headers['x-shaz-device-id'])||accountRateKey(req)}
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
function consentIp(req){return trustedClientIp(req)}
function readLegalDocuments(){
  let docs=readJson('legal_documents.json',[]);const backup=readJson('legal_documents_backup.json',[]);
  const hasText=arr=>Array.isArray(arr)&&arr.some(d=>String(d?.content||'').trim());
  if(!hasText(docs)&&hasText(backup)){docs=backup;writeJson('legal_documents.json',docs)}
  return Array.isArray(docs)?docs:[];
}
function currentLegalDoc(type){return readLegalDocuments().find(d=>d.type===type&&d.active!==false)||null}
function legalHash(doc){return crypto.createHash('sha256').update(String(doc?.content||'')).digest('hex')}
function personalizationSnapshots(items){const out=[];(items||[]).forEach((item,itemIndex)=>{(item.writes||[]).forEach(w=>out.push({itemIndex,productId:item.product?.id||'',productName:item.product?.name||'',fieldType:'write',placement:w.position||'',customerValue:w.text||'',fee:Number(w.fee||0)}));(item.photoCustomizations||[]).forEach(p=>out.push({itemIndex,productId:item.product?.id||'',productName:item.product?.name||'',fieldType:'photo',placement:p.position||'',customerValue:p.note||'',uploadedImageReference:p.url||p.imageUrl||'',fee:Number(p.fee||0)}))});return out}
function serverBuilderProduct(raw,byId,catalog){
  const rawItems=Array.isArray(raw?.builderItems)?raw.builderItems:[],ids=[...new Set(rawItems.map(x=>String(x?.id||x?.productId||'').trim()).filter(Boolean))];
  if(ids.length<2||ids.length>20)return null;
  const selected=ids.map(id=>byId.get(id));if(selected.some(p=>!p||p.hidden===true||p.soldOutEnabled===true))return null;
  const count=selected.length,pricing=catalog.builder?.productPricing||{};let total=0;
  for(const p of selected){const map=pricing?.[p.id],key=String(count),rawPrice=map&&Object.prototype.hasOwnProperty.call(map,key)?map[key]:p.price,price=Number(rawPrice);if(!Number.isFinite(price)||price<0)return null;total+=price}
  return {id:'custom-builder',name:`Kendi Setim (${count} ürün)`,price:Number(total.toFixed(2)),isSet:true,builderItems:selected.map(p=>({id:p.id,name:p.name,category:p.category,image:serverMainProductImage(p)}))};
}
function serverUpsellTriggerMatches(rule,rows,byId){
  const triggerCategory=String(rule?.triggerCategoryId||''),mode=String(rule?.triggerMode||'all'),selected=new Set((rule?.triggerProductIds||[]).map(String));
  if(!triggerCategory)return false;
  return rows.some(x=>{const id=String(x?.product?.id||x?.productId||'').trim(),p=byId.get(id);if(!p||p.hidden===true||p.soldOutEnabled===true||String(p.category||'')!==triggerCategory)return false;return mode==='selected'?selected.has(String(p.id)):true});
}
function serverPrepareOrderItems(rawItems,{allowSoldOut=false}={}){
  const catalog=readJson('catalog.json',{products:[]}),products=Array.isArray(catalog.products)?catalog.products:[],byId=new Map(products.map(p=>[String(p.id),p]));
  const rows=Array.isArray(rawItems)?rawItems:[];if(!rows.length||rows.length>100)throw new Error('Sipariş ürünleri geçersiz.');
  const priceCfg=catalog.personalizationPricing||{},firstFee=Math.max(0,Number(priceCfg.first??75)),nextFee=Math.max(0,Number(priceCfg.second??50)),thirdFee=Math.max(0,Number(priceCfg.thirdPlus??nextFee)),photoExtra=Math.max(0,Number(catalog.walletPhotoFee??25));let slot=0;
  const clean=[];
  for(const src of rows){
    const pid=String(src?.product?.id||src?.productId||'').trim();let p=byId.get(pid),builderProduct=null;
    if(!p&&Array.isArray(src?.builderItems)){builderProduct=serverBuilderProduct(src,byId,catalog);p=builderProduct}
    if(!p||p.hidden===true)throw new Error('Sepette artık satışta olmayan bir ürün var. Sepeti yenileyin.');
    if(!allowSoldOut&&p.soldOutEnabled===true)throw new Error('Sepetinizde tükendi olarak işaretlenmiş bir ürün var. Sepeti yenileyin.');
    const qty=Math.floor(Number(src.qty||1));if(!Number.isFinite(qty)||qty<1||qty>20)throw new Error('Ürün adedi geçersiz.');
    let base=Math.max(0,Number(p.price||0));
    const up=src.upsell&&typeof src.upsell==='object'?src.upsell:null;
    if(!builderProduct&&up?.ruleId){const rule=(catalog.checkoutUpsells||[]).find(r=>String(r.id)===String(up.ruleId)&&r.enabled!==false);if(rule&&serverUpsellTriggerMatches(rule,rows,byId)&&p.category===rule.offerCategoryId&&((rule.offerMode||'all')==='all'||(rule.offerProductIds||[]).map(String).includes(String(p.id)))){const v=rule?.productPrices?.[p.id];base=v!==undefined&&v!==null&&v!==''?Math.max(0,Number(v||0)):Math.max(0,Number(rule.specialPrice||0))}}
    let personalTotal=0;const set=src.setCustomization&&typeof src.setCustomization==='object'?src.setCustomization:null;
    const cleanWrites=[],cleanPhotos=[];
    const capText=v=>String(v||'').trim().slice(0,160),capPos=v=>String(v||'').trim().slice(0,80),safePhotoRef=v=>{const ref=String(v||'').trim();return /^\/api\/customer-image\/[a-f0-9]{48}\.(?:jpg|png|webp)$/.test(ref)?ref:''};
    if(set&&Array.isArray(p.setItems)){
      const validSetIds=new Set(p.setItems.map(si=>String(si.id))),removedIds=[...new Set((set.removedIds||[]).map(String))].filter(id=>validSetIds.has(id)),remainingCount=p.setItems.filter(si=>!removedIds.includes(String(si.id))).length;
      if(p.setItems.length>=2&&remainingCount<2)throw new Error('Hazır sette en az 2 ürün kalmalıdır.');
      const removed=p.setItems.filter(si=>removedIds.includes(String(si.id))).reduce((sum,si)=>sum+Math.max(0,Number(si.removeDiscount||0)),0);base=Math.max(0,base-removed);
      const sw=Array.isArray(set.writes)?set.writes:[],sp=Array.isArray(set.photoCustomizations)?set.photoCustomizations:[],keys=[];[...sw,...sp].forEach(v=>{const k=String(v.itemId||v.item||'set-item').slice(0,120);if(!keys.includes(k))keys.push(k)});
      for(const k of keys){const tier=slot===0?firstFee:(slot===1?nextFee:thirdFee);slot++;const ws=sw.filter(w=>String(w.itemId||w.item||'set-item')===k),ps=sp.filter(ph=>String(ph.itemId||ph.item||'set-item')===k);ws.forEach((w,i)=>{const fee=i===0?tier:0;personalTotal+=fee;cleanWrites.push({...w,text:capText(w.text),position:capPos(w.position),fee})});ps.forEach((ph,i)=>{const slotFee=!ws.length&&i===0?tier:0,fee=slotFee+photoExtra;personalTotal+=fee;cleanPhotos.push({...ph,imageUrl:safePhotoRef(ph.imageUrl||ph.url),url:safePhotoRef(ph.imageUrl||ph.url),note:capText(ph.note),position:capPos(ph.position),slotFee,photoExtraFee:photoExtra,fee})})}
    }else{
      const ws=Array.isArray(src.writes)?src.writes:[],ps=Array.isArray(src.photoCustomizations)?src.photoCustomizations:[];if(ws.length||ps.length){const tier=slot===0?firstFee:(slot===1?nextFee:thirdFee);slot++;ws.forEach((w,i)=>{const fee=i===0?tier:0;personalTotal+=fee;cleanWrites.push({...w,text:capText(w.text),position:capPos(w.position),fee})});ps.forEach((ph,i)=>{const slotFee=!ws.length&&i===0?tier:0,fee=slotFee+photoExtra;personalTotal+=fee;cleanPhotos.push({...ph,imageUrl:safePhotoRef(ph.imageUrl||ph.url),url:safePhotoRef(ph.imageUrl||ph.url),note:capText(ph.note),position:capPos(ph.position),slotFee,photoExtraFee:photoExtra,fee})})}
    }
    const finalPrice=Math.max(0,Math.round((base+personalTotal)*100)/100),product={...p,price:finalPrice};const row={...src,product,basePrice:base,qty,writes:cleanWrites,photoCustomizations:cleanPhotos,personalized:cleanWrites.length>0||cleanPhotos.length>0};
    if(set)row.setCustomization={...set,removedIds:Array.isArray(p.setItems)?[...new Set((set.removedIds||[]).map(String))].filter(id=>p.setItems.some(si=>String(si.id)===id)):[],writes:cleanWrites,photoCustomizations:cleanPhotos};
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


const CARGO_SNAPSHOT_FILE='cargo_state.enc';
const CARGO_STATE_NAMES=['cargo_feature_state.json','cargo_order_index.json','cargo_records.json','cargo_events.json'];
function cargoSnapshotKey(){return USER_SESSION_SECRET?crypto.createHash('sha256').update(USER_SESSION_SECRET).digest():null}
function buildEncryptedCargoSnapshot(){
  const key=cargoSnapshotKey();if(!key)return '';
  const state={v:1,createdAt:new Date().toISOString(),files:{}};for(const name of CARGO_STATE_NAMES)state.files[name]=readJson(name,name==='cargo_feature_state.json'?{}:[]);
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),plain=Buffer.from(JSON.stringify(state),'utf8'),enc=Buffer.concat([cipher.update(plain),cipher.final()]),tag=cipher.getAuthTag();
  return JSON.stringify({v:1,iv:iv.toString('base64'),tag:tag.toString('base64'),data:enc.toString('base64'),createdAt:state.createdAt});
}
function restoreEncryptedCargoSnapshot(){
  try{const key=cargoSnapshotKey(),file=path.join(dataDir,CARGO_SNAPSHOT_FILE);if(!key||!fs.existsSync(file))return false;const box=JSON.parse(fs.readFileSync(file,'utf8')),iv=Buffer.from(box.iv,'base64'),tag=Buffer.from(box.tag,'base64'),enc=Buffer.from(box.data,'base64'),decipher=crypto.createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);const state=JSON.parse(Buffer.concat([decipher.update(enc),decipher.final()]).toString('utf8'));if(!state||state.v!==1||!state.files)return false;for(const name of CARGO_STATE_NAMES)if(Object.prototype.hasOwnProperty.call(state.files,name))writeJson(name,state.files[name]);return true}catch(e){console.warn('SHAZ kargo kalıcı kayıt geri yüklenemedi:',e.message);return false}
}
async function persistCargoStateToGithub(){
  const content=buildEncryptedCargoSnapshot();if(!content)return {ok:false,skipped:true};fs.writeFileSync(path.join(dataDir,CARGO_SNAPSHOT_FILE),content,'utf8');if(!githubEnabled())return {ok:false,skipped:true};return githubCommitFiles([{path:`data/${CARGO_SNAPSHOT_FILE}`,content,encoding:'utf-8'}],'SHAZ kargo: şifreli kalıcı kargo kaydı güncellendi [skip render]');
}
function persistCargoStateAsync(){persistCargoStateToGithub().catch(e=>console.error('Kargo GitHub kalıcı kayıt:',e.message))}
async function restoreCargoStateFromGithub(){
  if(!githubEnabled()||!USER_SESSION_SECRET)return restoreEncryptedCargoSnapshot();
  try{const remote=await ghApi(`/contents/data/${encodeURIComponent(CARGO_SNAPSHOT_FILE)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);if(!remote||remote.encoding!=='base64'||!remote.content)return restoreEncryptedCargoSnapshot();const content=Buffer.from(String(remote.content).replace(/\s+/g,''),'base64').toString('utf8');fs.writeFileSync(path.join(dataDir,CARGO_SNAPSHOT_FILE),content,'utf8');return restoreEncryptedCargoSnapshot()}catch(e){if(!String(e?.message||'').toLowerCase().includes('not found'))console.warn('SHAZ kargo GitHub şifreli kayıt geri yüklenemedi:',e.message);return restoreEncryptedCargoSnapshot()}
}

const ACCOUNT_SNAPSHOT_FILE='account_state.enc';
const ACCOUNT_SNAPSHOT_NAMES=['users.json','customers.json','addresses.json','favorites.json','marketing_consents.json','phone_verifications.json','password_resets.json','pending_registrations.json','coupons.json','new_member_coupon_templates.json','account_login_attempts.json','login_events.json','push_subscriptions.json','customer_activity.json','notification_settings.json','legal_acceptances.json','whatsapp_templates.json','admin_preferences.json','marketing_integration_state.json','integration_outbox.json','integration_webhook_events.json','sms_delivery_log.json'];
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
  // SHZ numarası, ana sipariş silinse bile provider tarafındaki eski order_number ile çakışmamalı.
  // Format aynı kalır; yalnız mevcut kalıcı geçmişte kullanılmış en büyük SHZ numarasının gerisine düşmez.
  const historicalIds=[...(orders||[]).map(o=>o?.id),...readJson('legal_acceptances.json',[]).map(x=>x?.orderId),...readJson('cargo_order_index.json',[]).map(x=>x?.orderId),...readJson('cargo_records.json',[]).map(x=>x?.orderId)];
  let max=0;
  for(const id of historicalIds){
    const m=String(id||'').match(/^SHZ(\d+)$/i),n=m?Number(m[1]):NaN;
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
const whatsappMediaUpload=multer({storage,limits:{fileSize:25*1024*1024,files:1},fileFilter:(req,file,cb)=>{const ok=['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime'].includes(file.mimetype);cb(ok?null:new Error('WhatsApp hazır mesajı için JPG, PNG, WEBP, GIF, MP4, WEBM veya MOV yükleyin.'),ok)}});

// Kısa, üyelik gerektirmeyen sepet paylaşım bağlantıları.
const sharedCartDir=path.join(dataDir,'shared-carts');fs.mkdirSync(sharedCartDir,{recursive:true});
const simpleRateBuckets=new Map();
function rateLimitHit(req,key,limit,windowMs){const ip=accountRateKey(req),k=key+':'+ip,now=Date.now(),x=simpleRateBuckets.get(k);if(!x||now-x.start>windowMs){simpleRateBuckets.set(k,{start:now,count:1});return false}x.count++;simpleRateBuckets.set(k,x);return x.count>limit}
function sharedCartCleanWrite(w={}){return {itemId:String(w.itemId||'').slice(0,120),item:String(w.item||'').slice(0,160),text:String(w.text||'').slice(0,160),position:String(w.position||'').slice(0,80)}}
function sharedCartCleanPhoto(ph={}){return {itemId:String(ph.itemId||'').slice(0,120),item:String(ph.item||'').slice(0,160),note:String(ph.note||'').slice(0,160),position:String(ph.position||'').slice(0,80),caption:String(ph.caption||'').slice(0,160),captionPosition:String(ph.captionPosition||'').slice(0,20)}}
function sharedCartSource(cart){
  if(!cart||typeof cart!=='object'||Array.isArray(cart))throw new Error('Paylaşılan sepet verisi geçersiz.');
  const rawItems=Array.isArray(cart.items)?cart.items:Array.isArray(cart.cart)?cart.cart:null;if(!rawItems||!rawItems.length||rawItems.length>100)throw new Error('Paylaşılan sepet verisi geçersiz.');
  const catalog=readJson('catalog.json',{products:[]}),products=Array.isArray(catalog.products)?catalog.products:[],byId=new Map(products.map(p=>[String(p.id),p]));
  const items=rawItems.map(x=>{
    if(!x||typeof x!=='object'||Array.isArray(x))throw new Error('Paylaşılan sepet içeriği geçersiz.');
    let productId=String(x.productId||x.product?.id||'').trim();
    if(!productId&&x.name){const matches=products.filter(p=>String(p?.name||'').trim()===String(x.name||'').trim());if(matches.length===1)productId=String(matches[0].id)}
    const builderItems=Array.isArray(x.builderItems)?x.builderItems.map(v=>({id:String(v?.id||v?.productId||'').trim()})).filter(v=>v.id).slice(0,20):[];
    if(!byId.has(productId)&&builderItems.length<2)throw new Error('Paylaşılan sepette doğrulanamayan bir ürün var.');
    const qty=Math.floor(Number(x.qty||1));if(!Number.isFinite(qty)||qty<1||qty>20)throw new Error('Paylaşılan sepet ürün adedi geçersiz.');
    const writes=(Array.isArray(x.writes)?x.writes:[]).slice(0,20).map(sharedCartCleanWrite),photos=(Array.isArray(x.photoCustomizations)?x.photoCustomizations:Array.isArray(x.photos)?x.photos:[]).slice(0,20).map(sharedCartCleanPhoto);
    const source={productId,qty,writes,photoCustomizations:photos};
    if(builderItems.length)source.builderItems=builderItems;
    if(x.upsell?.ruleId)source.upsell={ruleId:String(x.upsell.ruleId).slice(0,120)};
    if(x.setCustomization&&typeof x.setCustomization==='object'){const sc=x.setCustomization;source.setCustomization={removedIds:Array.isArray(sc.removedIds)?sc.removedIds.map(String).slice(0,30):[],keptIds:Array.isArray(sc.keptIds)?sc.keptIds.map(String).slice(0,30):[],writes:(Array.isArray(sc.writes)?sc.writes:[]).slice(0,30).map(sharedCartCleanWrite),photoCustomizations:(Array.isArray(sc.photoCustomizations)?sc.photoCustomizations:[]).slice(0,30).map(sharedCartCleanPhoto)}}
    return source;
  });
  return {v:2,items};
}
function sharedCartView(source){
  const prepared=serverPrepareOrderItems(source.items,{allowSoldOut:true}),campaign=serverCampaignPricing(prepared.items,prepared.catalog);
  return {v:2,items:prepared.items.map(x=>({productId:x.product?.id||'',name:x.product?.name||'Ürün',price:Number(x.product?.price||0),image:serverMainProductImage(x.product)||'',qty:Number(x.qty||1),writes:(x.writes||[]).map(w=>({item:w.item||'',text:w.text||'',position:w.position||'',fee:Number(w.fee||0)})),photos:(x.photoCustomizations||[]).map(ph=>({item:ph.item||'',fee:Number(ph.fee||0)}))})),subtotal:campaign.subtotal,discount:campaign.discount,total:campaign.total,applied:(campaign.applied||[]).map(a=>({name:String(a.name||'Kampanya'),discount:Number(a.discount||0)}))};
}
app.post('/api/shared-cart',(req,res)=>{
  try{
    if(rateLimitHit(req,'shared-cart',40,15*60*1000))return res.status(429).json({ok:false,message:'Çok fazla paylaşım isteği. Lütfen biraz sonra tekrar deneyin.'});
    const raw=JSON.stringify(req.body||{});if(Buffer.byteLength(raw)>180*1024)return res.status(413).json({ok:false,message:'Paylaşılan sepet çok büyük.'});
    const source=sharedCartSource(req.body||{});sharedCartView(source);
    const id=crypto.randomBytes(12).toString('hex');fs.writeFileSync(path.join(sharedCartDir,id+'.json'),JSON.stringify(source));res.json({ok:true,id});
  }catch(e){console.error('Paylaşılan sepet kayıt:',e?.message||e);res.status(400).json({ok:false,message:'Paylaşılan sepet içeriği doğrulanamadı.'})}
});
app.post('/api/shared-cart/resolve',(req,res)=>{
  try{if(rateLimitHit(req,'shared-cart-resolve',120,15*60*1000))return res.status(429).json({ok:false});const raw=JSON.stringify(req.body||{});if(Buffer.byteLength(raw)>180*1024)return res.status(413).json({ok:false});const source=sharedCartSource(req.body||{});res.json({ok:true,cart:sharedCartView(source)})}catch(e){res.status(400).json({ok:false})}
});
app.get('/api/shared-cart/:id',(req,res)=>{
  const id=String(req.params.id||'');if(!/^[a-f0-9]{24}$/.test(id)&&!/^[a-f0-9]{8}$/.test(id))return res.status(404).json({ok:false});
  const f=path.join(sharedCartDir,id+'.json');if(!fs.existsSync(f))return res.status(404).json({ok:false});
  try{const source=sharedCartSource(JSON.parse(fs.readFileSync(f,'utf8'))),cart=sharedCartView(source);try{const now=new Date();fs.utimesSync(f,now,now)}catch(_){}res.json({ok:true,cart})}catch(e){res.status(404).json({ok:false})}
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
const ORDER_STATUSES=new Set(['new','prepared','shipped','delivered']);
function normalizeOrderStatus(value){return ORDER_STATUSES.has(String(value||''))?String(value):'new'}
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
    return {...o,status:normalizeOrderStatus(o.status),dailyDisplayId};
  });
}

const CARGO_SUCCESS_STATES=new Set(['created','handed_over','out_for_delivery','delivered','returned']);
const CARGO_FINAL_PROVIDER_STATES=new Set(['delivered','returned']);
const CARGO_ADMIN_STAGES=Object.freeze({
  new:{code:'new',label:'Yeni'},
  preparing:{code:'preparing',label:'Hazırlanıyor'},
  sent:{code:'sent',label:'Gönderildi'},
  in_transit:{code:'in_transit',label:'Yolda'},
  branch_waiting:{code:'branch_waiting',label:'Şubede Bekliyor'},
  delivered:{code:'delivered',label:'Teslim Edildi'},
  returned:{code:'returned',label:'İade'}
});
const CARGO_ADMIN_STAGE_CODES=new Set(Object.keys(CARGO_ADMIN_STAGES));
const CARGO_BACKGROUND_REFRESH_MS=12*60*1000,CARGO_BACKGROUND_CONCURRENCY=3;
let cargoBackgroundRefreshRunning=false,cargoIntegrationHealth={state:'unknown',lastSuccessAt:'',lastErrorAt:'',errorType:''};
const cargoCreateLocks=new Map();
async function withCargoCreateLock(orderId,task){const key=String(orderId||''),previous=cargoCreateLocks.get(key)||Promise.resolve();let release;const gate=new Promise(resolve=>{release=resolve}),tail=previous.then(()=>gate);cargoCreateLocks.set(key,tail);await previous;try{return await task()}finally{release();if(cargoCreateLocks.get(key)===tail)cargoCreateLocks.delete(key)}}
function ensureCargoFeatureState(){let state=readJson('cargo_feature_state.json',{});if(!state||typeof state!=='object'||!state.startedAt){state={v:1,startedAt:new Date().toISOString(),source:'deployment_cutover'};writeJson('cargo_feature_state.json',state);persistCargoStateAsync()}return state}
function cargoOrderIndexRows(){return readJson('cargo_order_index.json',[])}
function cargoRecordRows(){return readJson('cargo_records.json',[])}
function cargoEventRows(){return readJson('cargo_events.json',[])}
function cargoText(value,max=500){return String(value??'').trim().slice(0,max)}
function cargoPaymentLabel(payment){const p=String(payment||'').toLowerCase();if(p==='cod'||p.includes('kapıda')||p.includes('cash'))return 'Kapıda Ödeme';if(p.includes('online'))return 'Online Ödeme';if(p.includes('havale')||p.includes('eft')||p.includes('transfer'))return 'Havale / EFT';return cargoText(payment,80)||'—'}
function cargoAddress(customer={}){if(customer.deliveryMode==='branch')return ['ARAS KARGO ŞUBE TESLİM',customer.branchName].filter(Boolean).join(' - ');const road=[customer.neighborhood,customer.avenue,customer.street].filter(Boolean).join(' '),nums=[customer.buildingNo?`No:${customer.buildingNo}`:'',customer.floor?`Kat:${customer.floor}`:'',customer.doorNo?`Daire:${customer.doorNo}`:''].filter(Boolean).join(' ');return [road,customer.fullAddress,nums,customer.businessName].filter(Boolean).join(' ').replace(/\s+/g,' ').trim()}
function cargoOrderHasPersonalization(order={}){
  const meaningful=v=>String(v??'').trim().length>0;
  if((Array.isArray(order.personalizationSnapshots)?order.personalizationSnapshots:[]).some(x=>meaningful(x?.customerValue)||meaningful(x?.uploadedImageReference)))return true;
  return (Array.isArray(order.items)?order.items:[]).some(x=>{
    const writes=Array.isArray(x?.writes)?x.writes:(Array.isArray(x?.setCustomization?.writes)?x.setCustomization.writes:[]);
    const photos=Array.isArray(x?.photoCustomizations)?x.photoCustomizations:(Array.isArray(x?.setCustomization?.photoCustomizations)?x.setCustomization.photoCustomizations:[]);
    return writes.some(w=>meaningful(w?.text))||photos.some(ph=>meaningful(ph?.imageUrl||ph?.url));
  });
}
function cargoProducts(order={}){
  const catalog=readJson('catalog.json',{products:[]}),byId=new Map((Array.isArray(catalog.products)?catalog.products:[]).map(p=>[String(p?.id||''),p]));
  return (Array.isArray(order.items)?order.items:[]).map((x,i)=>{
    const product=x?.product&&typeof x.product==='object'?x.product:{},productId=cargoText(product.id||x?.productId||'',160),live=productId?byId.get(productId):null;
    const image=cargoText(serverMainProductImage(product)||serverMainProductImage(live)||x?.image||'',1000),images=[...new Set([...(Array.isArray(product.images)?product.images:[]),product.image,image].map(v=>cargoText(v,1000)).filter(Boolean))];
    const quantity=Math.max(1,Number(x?.qty||1)),price=Number(product.price||x?.price||0),setItems=Array.isArray(product.setItems)?product.setItems:(Array.isArray(live?.setItems)?live.setItems:[]),setCustomization=x?.setCustomization||null,keptIds=Array.isArray(setCustomization?.keptIds)?setCustomization.keptIds:[],removedIds=Array.isArray(setCustomization?.removedIds)?setCustomization.removedIds:[],removedItems=setItems.filter(it=>removedIds.includes(it.id)).map(it=>cargoText(it?.name||'',180)).filter(Boolean),sentItems=removedItems.length?(keptIds.length?setItems.filter(it=>keptIds.includes(it.id)):setItems.filter(it=>!removedIds.includes(it.id))).map(it=>cargoText(it?.name||'',180)).filter(Boolean):[];
    return {index:i+1,productId,name:cargoText(product.name||x?.name||'Ürün',180),internalCode:cargoText(product.internalCode||live?.internalCode||'',120),quantity,price,lineTotal:Number((price*quantity).toFixed(2)),image,images,variant:x?.variant??x?.selectedVariant??product.variant??null,options:x?.options??x?.selectedOptions??x?.productOptions??null,productNote:cargoText(x?.productNote||'',500),personalized:!!x?.personalized,writes:Array.isArray(x?.writes)?x.writes:(Array.isArray(x?.setCustomization?.writes)?x.setCustomization.writes:[]),photoCustomizations:Array.isArray(x?.photoCustomizations)?x.photoCustomizations:(Array.isArray(x?.setCustomization?.photoCustomizations)?x.setCustomization.photoCustomizations:[]),setCustomization,sentItems,removedItems};
  });
}
function cargoShipmentRelevantData(order={}){
  const c=order.customer||{};
  return {customer:{fullName:c.fullName||'',phone:c.phone||'',province:c.province||'',district:c.district||'',neighborhood:c.neighborhood||'',avenue:c.avenue||'',street:c.street||'',fullAddress:c.fullAddress||'',buildingNo:c.buildingNo||'',floor:c.floor||'',doorNo:c.doorNo||'',businessName:c.businessName||'',deliveryMode:c.deliveryMode||'',branchName:c.branchName||''},payment:order.payment||'',total:Number(order.total||0),items:(Array.isArray(order.items)?order.items:[]).map(x=>({productId:x?.product?.id||x?.productId||'',name:x?.product?.name||x?.name||'',qty:Number(x?.qty||1),price:Number(x?.product?.price||x?.price||0),productNote:x?.productNote||'',writes:x?.writes||x?.setCustomization?.writes||[],photoCustomizations:x?.photoCustomizations||x?.setCustomization?.photoCustomizations||[],setCustomization:x?.setCustomization||null}))};
}
function cargoShipmentDirtyError(){const e=new Error('Sipariş bilgileri mevcut barkod oluşturulduktan sonra değiştirildi. Mevcut barkod eski bilgileri içeriyor. Devam etmek için yeni barkod oluşturun.');e.code='CARGO_BARCODE_STALE';return e}
function cargoAssertShipmentCurrent(order){if(order?.cargoShipmentDirty===true)throw cargoShipmentDirtyError()}
function cargoClearShipmentDirty(orderId,shipmentId=''){
  const orders=readJson('orders.json',[]),order=orders.find(o=>String(o.id||'')===String(orderId));if(!order||order.cargoShipmentDirty!==true)return false;
  order.cargoShipmentDirty=false;order.cargoShipmentDirtyAt='';order.cargoShipmentDirtyFields=[];order.cargoLastShipmentId=shipmentId||order.cargoLastShipmentId||'';order.cargoShipmentSynchronizedAt=new Date().toISOString();
  writeJson('orders.json',orders);persistOrdersToGithub().catch(e=>console.error('Yeni barkod dirty temizleme kalıcı kayıt:',e));return true;
}
function cargoRecordsForOrder(orderId){return cargoRecordRows().filter(x=>String(x.orderId)===String(orderId)).sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0))}
function latestCargoRecord(orderId){return cargoRecordsForOrder(orderId)[0]||null}
function successfulCargoRecord(orderId){return cargoRecordsForOrder(orderId).find(x=>CARGO_SUCCESS_STATES.has(String(x.status||'')))||null}
function cargoStatusLabel(status){return CARGO_STATUS_OPTIONS.find(x=>x.code===status)?.label||CARGO_STATUS_OPTIONS[0].label}
function cargoAdminStageLabel(stage){return CARGO_ADMIN_STAGES[stage]?.label||CARGO_ADMIN_STAGES.new.label}
function cargoStageFromProviderStatus(status){if(status==='delivered')return 'delivered';if(status==='returned')return 'returned';if(status==='handed_over'||status==='out_for_delivery')return 'in_transit';if(status==='created')return 'preparing';return 'new'}
function ensureCargoWorkflowIndexRows(){const rows=cargoOrderIndexRows(),records=cargoRecordRows();let changed=false;for(const row of rows){if(!CARGO_ADMIN_STAGE_CODES.has(String(row.adminStage||''))){const shipment=records.filter(x=>String(x.orderId)===String(row.orderId)&&CARGO_SUCCESS_STATES.has(String(x.status||''))).sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0))[0]||null;row.adminStage=cargoStageFromProviderStatus(shipment?.status||'');row.stageUpdatedAt=row.stageUpdatedAt||row.panelCreatedAt||row.orderCreatedAt||new Date().toISOString();changed=true}if(!Array.isArray(row.stageHistory)){row.stageHistory=[];changed=true}if(!row.stageHistory.length){row.stageHistory.push({id:'CGS-'+crypto.randomUUID(),from:'',to:row.adminStage,source:'migration',reason:'Mevcut kargo kaydından yönetim aşaması oluşturuldu.',shipmentId:null,at:row.stageUpdatedAt||new Date().toISOString()});changed=true}}if(changed){writeJson('cargo_order_index.json',rows);persistCargoStateAsync()}return rows}
function cargoCanUndoStage(indexRow){const history=Array.isArray(indexRow?.stageHistory)?indexRow.stageHistory:[],last=history.at(-1);return !!(last&&last.source==='manual'&&last.to===indexRow.adminStage&&CARGO_ADMIN_STAGE_CODES.has(String(last.from||'')))}
function appendCargoEvent({orderId,shipmentId=null,type,label,message='',status='',at=new Date().toISOString()}={}){const rows=cargoEventRows();rows.push({id:'CGE-'+crypto.randomUUID(),orderId:String(orderId||''),shipmentId:shipmentId||null,type:cargoText(type,80),label:cargoText(label,180),message:cargoText(message,1000),status:cargoText(status,80),at});writeJson('cargo_events.json',rows);return rows.at(-1)}
function setCargoAdminStage(orderId,to,{source='system',reason='',shipmentId=null}={}){if(!CARGO_ADMIN_STAGE_CODES.has(String(to||''))){const e=new Error('Geçersiz kargo yönetim aşaması.');e.code='CARGO_STAGE_INVALID';throw e}const rows=ensureCargoWorkflowIndexRows(),row=rows.find(x=>String(x.orderId)===String(orderId));if(!row){const e=new Error('Sipariş yeni kargo panelinde bulunamadı.');e.code='CARGO_ORDER_NOT_INDEXED';throw e}const from=CARGO_ADMIN_STAGE_CODES.has(String(row.adminStage||''))?row.adminStage:'new';if(from===to)return row;const at=new Date().toISOString(),entry={id:'CGS-'+crypto.randomUUID(),from,to,source:cargoText(source,40)||'system',reason:cargoText(reason,300),shipmentId:shipmentId||null,at};row.adminStage=to;row.stageUpdatedAt=at;row.stageHistory=[...(Array.isArray(row.stageHistory)?row.stageHistory:[]),entry].slice(-100);writeJson('cargo_order_index.json',rows);appendCargoEvent({orderId,shipmentId,type:'admin_stage_changed',label:`Yönetim aşaması: ${cargoAdminStageLabel(to)}`,message:reason,status:to,at});persistCargoStateAsync();publishAdminCargoUpdate(orderId,'stage_changed');return row}
function undoCargoAdminStage(orderId){const rows=ensureCargoWorkflowIndexRows(),row=rows.find(x=>String(x.orderId)===String(orderId));if(!row){const e=new Error('Sipariş yeni kargo panelinde bulunamadı.');e.code='CARGO_ORDER_NOT_INDEXED';throw e}const history=Array.isArray(row.stageHistory)?row.stageHistory:[],last=history.at(-1);if(!last||last.source!=='manual'||last.to!==row.adminStage||!CARGO_ADMIN_STAGE_CODES.has(String(last.from||''))){const e=new Error('Geri alınabilecek manuel aşama değişikliği bulunmuyor.');e.code='CARGO_STAGE_UNDO_UNAVAILABLE';throw e}return setCargoAdminStage(orderId,last.from,{source:'undo',reason:`Manuel ${cargoAdminStageLabel(last.to)} değişikliği geri alındı.`,shipmentId:last.shipmentId||null})}
function registerCargoPanelOrder(order){if(!order?.id)return false;const state=ensureCargoFeatureState(),createdMs=new Date(order.createdAt||0).getTime(),cutoverMs=new Date(state.startedAt||0).getTime();if(Number.isFinite(createdMs)&&Number.isFinite(cutoverMs)&&createdMs<cutoverMs)return false;const rows=cargoOrderIndexRows();if(rows.some(x=>String(x.orderId)===String(order.id)))return false;const at=new Date().toISOString();rows.unshift({id:'CGO-'+crypto.randomUUID(),orderId:String(order.id),source:'site_order',orderCreatedAt:order.createdAt||at,panelCreatedAt:at,adminStage:'new',stageUpdatedAt:at,stageHistory:[{id:'CGS-'+crypto.randomUUID(),from:'',to:'new',source:'system',reason:'Sipariş kargo yönetimine eklendi.',shipmentId:null,at}]});writeJson('cargo_order_index.json',rows);appendCargoEvent({orderId:order.id,type:'order_created',label:'Sipariş oluştu',status:'not_created',at});persistCargoStateAsync();return true}
function cargoPanelOrder(orderId){const index=ensureCargoWorkflowIndexRows().find(x=>String(x.orderId)===String(orderId));if(!index)return null;const order=readJson('orders.json',[]).find(x=>String(x.id)===String(orderId));return order?{order,index}:null}
function cargoOrderMembership(order={}){const userId=cargoText(order.userId||order.memberId||'',160);if(!userId)return {isMember:false,membershipSource:'guest'};const user=readJson('users.json',[]).find(x=>String(x.id)===userId&&!x.deleted);return {isMember:!!user,membershipSource:user?'user_id':'missing_or_deleted_user_id'}}
function cargoOrderView(order,indexRow,shipment=null){
  const c=order.customer||{},latest=latestCargoRecord(order.id),active=shipment||successfulCargoRecord(order.id),s=active||latest,status=s?.status||'not_created',recentCreateError=!active&&latest?.status==='error'?latest.errorMessage||'Kargo oluşturma hatası.':'',membership=cargoOrderMembership(order),stage=indexRow?.adminStage||'new',dirty=order.cargoShipmentDirty===true,isFinal=['delivered','returned'].includes(stage);
  return {orderId:String(order.id),userId:cargoText(order.userId||order.memberId||'',160),customerId:cargoText(order.customerId||'',160),fullName:c.fullName||[c.firstName,c.lastName].filter(Boolean).join(' ')||'',phone:c.phone||'',email:c.email||'',province:c.province||'',district:c.district||'',address:cargoAddress(c),payment:order.payment||'',paymentLabel:cargoPaymentLabel(order.payment),total:Number(order.total||0),orderCreatedAt:order.createdAt||'',panelCreatedAt:indexRow?.panelCreatedAt||'',cargoCompany:s?.cargoCompany||'Aras Kargo / YeşilKar',cargoStatus:status,cargoStatusLabel:cargoStatusLabel(status),adminStage:stage,adminStageLabel:cargoAdminStageLabel(stage),barcode:active?.barcode||'',trackingNumber:active?.trackingNumber||'',cargoCreatedAt:active?.createdAt||latest?.createdAt||'',lastCargoStatusAt:active?.lastStatusAt||active?.updatedAt||'',lastCargoCheckAt:active?.lastCheckedAt||'',deliveredAt:active?.deliveredAt||'',providerMovementText:active?.providerMovementText||'',providerStatusAt:active?.providerStatusAt||'',shipmentId:active?.id||'',createErrorMessage:recentCreateError,lastRefreshError:active?.lastRefreshError||'',lastRefreshErrorAt:active?.lastRefreshErrorAt||'',lastRefreshErrorType:active?.lastRefreshErrorType||'',shipmentDirty:dirty,shipmentDirtyAt:order.cargoShipmentDirtyAt||'',shipmentDirtyFields:Array.isArray(order.cargoShipmentDirtyFields)?order.cargoShipmentDirtyFields:[],hasPersonalization:cargoOrderHasPersonalization(order),canCreate:stage==='new'&&!active&&latest?.status!=='creating',canRetryCreate:stage==='new'&&!active&&latest?.status==='error',canResend:!!active,canNewBarcode:!!active&&dirty&&!isFinal,canMarkSent:!!active&&stage==='preparing'&&!dirty,canUndoStage:cargoCanUndoStage(indexRow),canEditOrder:!isFinal,hasProviderShipment:!!active,isMember:membership.isMember,membershipSource:membership.membershipSource};
}
function cargoOrderDetailPayload(order,index){
  const shipment=successfulCargoRecord(order.id),events=cargoEventRows().filter(x=>String(x.orderId)===String(order.id)).sort((a,b)=>new Date(a.at||0)-new Date(b.at||0)),shipments=cargoRecordsForOrder(order.id).map(x=>({...x,providerResponse:undefined})),c=order.customer||{};
  return {...cargoOrderView(order,index,shipment),createdAtTR:order.createdAtTR||'',memberId:order.memberId||order.userId||null,customer:{fullName:c.fullName||'',phone:c.phone||'',extraPhone:c.extraPhone||'',email:c.email||'',province:c.province||'',district:c.district||'',neighborhood:c.neighborhood||'',avenue:c.avenue||'',street:c.street||'',fullAddress:c.fullAddress||'',buildingNo:c.buildingNo||'',floor:c.floor||'',doorNo:c.doorNo||'',businessName:c.businessName||'',branchName:c.branchName||'',deliveryMode:c.deliveryMode||'',placeType:c.placeType||'',addressTitle:c.addressTitle||c.title||'',savedAddressId:c.savedAddressId||'',address:cargoAddress(c),note:c.note||''},orderNote:order.orderNote||'',subtotal:Number(order.subtotal??0),discountTotal:Number(order.discountTotal??0),preCouponTotal:Number(order.preCouponTotal??order.subtotal??0),couponDiscountTotal:Number(order.couponDiscountTotal??0),shippingAmount:Number(order.shippingAmount??order.shippingFee??0),collectionAmount:Number(shipment?.collectAmount??order.total??0),products:cargoProducts(order),personalizationSnapshots:Array.isArray(order.personalizationSnapshots)?order.personalizationSnapshots:[],adminEditHistory:Array.isArray(order.adminEditHistory)?order.adminEditHistory:[],shipment:shipment?{...shipment,providerResponse:undefined,errorMessage:shipment.errorMessage||''}:null,shipments,stageHistory:Array.isArray(index.stageHistory)?index.stageHistory:[],events};
}
function cargoSecretSafeText(value,max=400){let text=cargoText(value,max);for(const key of ['YESILKAR_API_KEY','YESILKAR_AUTH_HEADER_VALUE','YESILKAR_API_FROM']){const secret=String(process.env[key]||'').trim();if(secret&&secret.length>=4)text=text.split(secret).join('[redacted]')}return text}
function cargoSafeError(e){const base=cargoSecretSafeText(e?.message||'Kargo işlemi başarısız.',400),cause=cargoSecretSafeText(e?.cause?.code||e?.cause?.name||'',80);if(/fetch failed|network|socket|timeout|connect/i.test(base)||cause)return `Kargo servisine bağlantı kurulamadı: ${base}${cause?` (${cause})`:''}`;return base}
function cargoSafeErrorType(e){const http=Number(e?.httpStatus||0);if(e?.code==='CARGO_INTEGRATION_NOT_CONFIGURED'||e?.code==='CARGO_STATUS_NOT_CONFIGURED')return 'configuration';if(http===401||http===403)return 'authorization';if(/fetch failed|network|socket|timeout|connect/i.test(String(e?.message||''))||e?.cause?.code)return 'network';if(e?.code==='CARGO_PROVIDER_ERROR')return 'provider';return cargoText(e?.code||e?.name||'error',80).toLowerCase()}
function cargoMarkIntegrationSuccess(){cargoIntegrationHealth={state:'healthy',lastSuccessAt:new Date().toISOString(),lastErrorAt:cargoIntegrationHealth.lastErrorAt||'',errorType:''}}
function cargoMarkIntegrationFailure(e){const type=cargoSafeErrorType(e);if(type==='configuration'||type==='authorization')cargoIntegrationHealth={...cargoIntegrationHealth,state:'error',lastErrorAt:new Date().toISOString(),errorType:type}}
function cargoIntegrationSnapshot(){const cfg=cargoService.config();return {...cfg,health:cfg.configured?(cargoIntegrationHealth.state==='error'?'error':cargoIntegrationHealth.state==='healthy'?'healthy':'configured'):'error',lastSuccessAt:cargoIntegrationHealth.lastSuccessAt||'',lastErrorAt:cargoIntegrationHealth.lastErrorAt||'',errorType:cargoIntegrationHealth.errorType||''}}
function cargoLogFailure(operation,orderId,e){const cause=cargoText(e?.cause?.code||e?.cause?.name||'',80),type=cargoText(e?.code||e?.name||'Error',80);console.error('[SHAZ CARGO]',{endpoint:operation,orderId:String(orderId||''),errorType:type,causeCode:cause||undefined,message:cargoSafeError(e),at:new Date().toISOString()})}
function cargoCreateErrorLooksDuplicate(e){return /sipariş\s*no.*daha\s*önce|daha\s*önce\s*kayıt|duplicate|already\s*(?:exists|registered|created)/i.test(String(e?.message||''))}
function cargoCreateErrorIsUncertain(e){return cargoSafeErrorType(e)==='network'}
function cargoProviderOrderNumber(orderId,resend=false){if(!resend)return cargoText(orderId,120);const prior=cargoRecordsForOrder(orderId).filter(x=>x.resendOf||String(x.providerOrderNumber||'').startsWith(String(orderId)+'-R')).length+1;return cargoText(`${orderId}-R${prior}`,120)}
function applyCargoCreateResult({order,shipment,rows,result,resend=false,recovered=false}){shipment.status=CARGO_SUCCESS_STATES.has(String(result?.status||''))?result.status:'created';shipment.barcode=result?.barcode||shipment.barcode||'';shipment.trackingNumber=result?.trackingNumber||shipment.trackingNumber||'';shipment.providerRecordId=result?.recordId||shipment.providerRecordId||'';shipment.labelUrl=result?.labelUrl||shipment.labelUrl||'';shipment.providerMovementText=result?.providerMovementText||shipment.providerMovementText||'';shipment.providerStatusAt=result?.providerStatusAt||shipment.providerStatusAt||'';shipment.providerResponse=redactProviderResponse(result?.providerResponse||{});shipment.updatedAt=new Date().toISOString();shipment.lastStatusAt=shipment.updatedAt;shipment.lastCheckedAt=shipment.updatedAt;shipment.lastRefreshError='';shipment.lastRefreshErrorAt='';shipment.lastRefreshErrorType='';shipment.errorMessage='';shipment.createUncertain=false;if(shipment.status==='delivered'&&shipment.providerStatusAt)shipment.deliveredAt=shipment.providerStatusAt;writeJson('cargo_records.json',rows);appendCargoEvent({orderId:order.id,shipmentId:shipment.id,type:recovered?'create_recovered':'created',label:recovered?'Mevcut provider kargo kaydı doğrulandı':'Kargo başarıyla oluştu',message:shipment.providerMovementText||'',status:shipment.status,at:shipment.updatedAt});if(shipment.barcode)appendCargoEvent({orderId:order.id,shipmentId:shipment.id,type:'barcode_received',label:'Barkod alındı',message:shipment.barcode,status:shipment.status,at:shipment.updatedAt});setCargoAdminStage(order.id,'preparing',{source:'system',reason:recovered?'Provider’daki mevcut gerçek kargo kaydı siparişe yeniden bağlandı.':resend?'Yeni kargo kaydı oluşturuldu; sipariş yeniden hazırlanıyor.':'Gerçek WebPostman kargo kaydı oluşturuldu; sipariş hazırlanıyor.',shipmentId:shipment.id});if(resend&&order.cargoShipmentDirty===true)cargoClearShipmentDirty(order.id,shipment.id);cargoMarkIntegrationSuccess();persistCargoStateAsync();publishAdminCargoUpdate(order.id,recovered?'create_recovered':'created');return shipment}
async function recoverCargoCreateIfPossible({order,shipment,error,rows}){let result=null;try{if(error?.providerResponse&&typeof error.providerResponse==='object'){const parsed=cargoService.resultFromProvider(error.providerResponse);if(parsed&&(parsed.barcode||parsed.trackingNumber||parsed.recordId))result={...parsed,status:cargoService.providerStatusToCargoStatus(parsed.providerStatus,'created')}}if(!result&&(cargoCreateErrorLooksDuplicate(error)||cargoCreateErrorIsUncertain(error)))result=await cargoService.lookupShipmentByOrderNumber({orderNumber:shipment.providerOrderNumber,currentStatus:'created',order});if(result&&(result.barcode||result.trackingNumber||result.recordId)){const target=rows.find(x=>String(x.id||'')===String(shipment.id||''))||shipment;const applied=applyCargoCreateResult({order,shipment:target,rows,result,resend:!!target.resendOf,recovered:true});if(CARGO_FINAL_PROVIDER_STATES.has(applied.status))syncCargoWorkflowFromProvider(order.id,applied);return applied}}catch(lookupError){cargoLogFailure('cargo/status-reconcile',order.id,lookupError)}return null}
async function createCargoForIndexedOrderUnlocked(orderId,{resend=false}={}){const found=cargoPanelOrder(orderId);if(!found){const e=new Error('Sipariş yeni kargo panelinde bulunamadı. Eski siparişler otomatik taşınmaz.');e.code='CARGO_ORDER_NOT_INDEXED';throw e}const {order}=found,existing=successfulCargoRecord(order.id),latest=latestCargoRecord(order.id);if(existing&&!resend){const e=new Error('Bu sipariş için daha önce başarılı bir kargo kaydı oluşturulmuş. Çift kargo engellendi.');e.code='CARGO_ALREADY_CREATED';throw e}if(!resend&&latest?.status==='creating'){const e=new Error('Bu sipariş için kargo oluşturma isteği zaten devam ediyor. İkinci POST gönderilmedi.');e.code='CARGO_CREATE_IN_PROGRESS';throw e}if(resend&&!existing){const e=new Error('Yeniden kargoya gönderme için önce başarılı bir mevcut kargo kaydı gerekir.');e.code='CARGO_NOT_CREATED';throw e}if(!resend&&latest?.status==='error'&&(latest.createUncertain===true||cargoCreateErrorLooksDuplicate({message:latest.errorMessage||''}))){const recovered=await recoverCargoCreateIfPossible({order,shipment:latest,error:{message:latest.errorMessage||'Önceki oluşturma sonucu belirsiz.'},rows:cargoRecordRows()});if(recovered)return recovered;const e=new Error('Önceki kargo oluşturma isteğinin provider tarafındaki sonucu doğrulanamadı. Aynı Sipariş No ile körü körüne yeni POST gönderilmedi.');e.code='CARGO_CREATE_RECONCILE_REQUIRED';throw e}const cfg=cargoService.config();if(!cfg.configured){const e=new Error('YeşilKar / Aras API entegrasyonu henüz aktif değil. Gerçek API bilgileri girilmeden kargo oluşturulmaz.');e.code='CARGO_INTEGRATION_NOT_CONFIGURED';cargoMarkIntegrationFailure(e);throw e}const at=new Date().toISOString(),rows=cargoRecordRows(),shipment={id:'CGR-'+crypto.randomUUID(),orderId:String(order.id),provider:'yesilkar',cargoCompany:'Aras Kargo / YeşilKar',providerOrderNumber:cargoProviderOrderNumber(order.id,resend),status:'creating',barcode:'',trackingNumber:'',providerRecordId:'',amountType:'',collectAmount:Number(order.total||0),createdAt:at,updatedAt:at,lastStatusAt:at,lastCheckedAt:'',lastRefreshError:'',lastRefreshErrorAt:'',lastRefreshErrorType:'',labelData:null,labelUrl:'',providerMovementText:'',providerStatusAt:'',deliveredAt:'',providerResponse:null,errorMessage:'',createUncertain:false,resendOf:resend&&existing?existing.id:null};rows.push(shipment);writeJson('cargo_records.json',rows);appendCargoEvent({orderId:order.id,shipmentId:shipment.id,type:'create_requested',label:resend?'Yeniden kargoya gönderme isteği gönderildi':'Kargo oluşturma isteği gönderildi',message:`Provider order_number: ${shipment.providerOrderNumber}`,status:'creating',at});persistCargoStateAsync();try{const result=await cargoService.createShipment({order,orderNumber:shipment.providerOrderNumber});return applyCargoCreateResult({order,shipment,rows,result,resend,recovered:false})}catch(e){const otherSuccess=successfulCargoRecord(order.id);if(cargoCreateErrorLooksDuplicate(e)&&otherSuccess&&otherSuccess.id!==shipment.id){const i=rows.findIndex(x=>x.id===shipment.id);if(i>=0)rows.splice(i,1);writeJson('cargo_records.json',rows);appendCargoEvent({orderId:order.id,shipmentId:otherSuccess.id,type:'duplicate_create_ignored',label:'Çift kargo oluşturma isteği engellendi',message:'Provider duplicate cevabı mevcut başarılı shipment nedeniyle hata durumuna çevrilmedi.',status:otherSuccess.status,at:new Date().toISOString()});persistCargoStateAsync();return otherSuccess}const recovered=await recoverCargoCreateIfPossible({order,shipment,error:e,rows});if(recovered)return recovered;shipment.status='error';shipment.errorMessage=cargoSafeError(e);shipment.createUncertain=cargoCreateErrorIsUncertain(e)||cargoCreateErrorLooksDuplicate(e);shipment.updatedAt=new Date().toISOString();shipment.lastStatusAt=shipment.updatedAt;shipment.lastCheckedAt=shipment.updatedAt;shipment.providerResponse=redactProviderResponse(e?.providerResponse||{});writeJson('cargo_records.json',rows);appendCargoEvent({orderId:order.id,shipmentId:shipment.id,type:'error',label:'Kargo oluşturma hatası',message:shipment.errorMessage,status:'error',at:shipment.updatedAt});cargoMarkIntegrationFailure(e);cargoLogFailure('consignment/add',order.id,e);persistCargoStateAsync();throw e}}
function syncCargoWorkflowFromProvider(orderId,shipment){const found=cargoPanelOrder(orderId);if(!found||!shipment)return;let current=found.index.adminStage||'new';const target=cargoService.providerMovementToWorkflowStage({status:shipment.status,movementText:shipment.providerMovementText||'',currentStage:current}),reason=shipment.providerMovementText||cargoStatusLabel(shipment.status);if(target==='delivered'||target==='returned'){setCargoAdminStage(orderId,target,{source:'automatic_provider',reason,shipmentId:shipment.id});return}if(target==='branch_waiting'){if(current==='sent'){setCargoAdminStage(orderId,'in_transit',{source:'automatic_provider',reason,shipmentId:shipment.id});current='in_transit'}if(current==='in_transit')setCargoAdminStage(orderId,'branch_waiting',{source:'automatic_provider',reason,shipmentId:shipment.id});return}if(target==='in_transit'&&(current==='sent'||current==='branch_waiting'))setCargoAdminStage(orderId,'in_transit',{source:'automatic_provider',reason,shipmentId:shipment.id})}
async function createCargoForIndexedOrder(orderId,options={}){return withCargoCreateLock(orderId,()=>createCargoForIndexedOrderUnlocked(orderId,options))}
async function attachExistingCargoByBarcode(orderId,barcode){return withCargoCreateLock(orderId,async()=>{const found=cargoPanelOrder(orderId);if(!found){const e=new Error('Sipariş yeni kargo panelinde bulunamadı.');e.code='CARGO_ORDER_NOT_INDEXED';throw e}const existing=successfulCargoRecord(found.order.id);if(existing)return existing;const value=cargoText(barcode,160);if(!/^[A-Za-z0-9._-]{4,160}$/.test(value)){const e=new Error('Geçerli WebPostman barkodu girilmedi.');e.code='CARGO_BARCODE_INVALID';throw e}const result=await cargoService.lookupShipmentByBarcode({barcode:value,currentStatus:'created',orderNumber:String(found.order.id),order:found.order});if(!result||!(result.barcode||result.trackingNumber||result.recordId)){const e=new Error('Bu barkod WebPostman üzerinde bu SHAZ siparişiyle güvenli biçimde doğrulanamadı.');e.code='CARGO_EXISTING_NOT_VERIFIED';throw e}const rows=cargoRecordRows();let shipment=rows.filter(x=>String(x.orderId)===String(found.order.id)).sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0))[0]||null;if(!shipment){const at=new Date().toISOString();shipment={id:'CGR-'+crypto.randomUUID(),orderId:String(found.order.id),provider:'yesilkar',cargoCompany:'Aras Kargo / YeşilKar',providerOrderNumber:String(found.order.id),status:'creating',barcode:'',trackingNumber:'',providerRecordId:'',amountType:'',collectAmount:Number(found.order.total||0),createdAt:at,updatedAt:at,lastStatusAt:at,lastCheckedAt:'',lastRefreshError:'',lastRefreshErrorAt:'',lastRefreshErrorType:'',labelData:null,labelUrl:'',providerMovementText:'',providerStatusAt:'',deliveredAt:'',providerResponse:null,errorMessage:'',createUncertain:false,resendOf:null};rows.push(shipment)}else shipment.providerOrderNumber=shipment.providerOrderNumber||String(found.order.id);return applyCargoCreateResult({order:found.order,shipment,rows,result,recovered:true})})}
async function refreshCargoShipmentStatus(orderId,{background=false}={}){const found=cargoPanelOrder(orderId),shipment=found?successfulCargoRecord(found.order.id):null;if(!found){const e=new Error('Sipariş yeni kargo panelinde bulunamadı.');e.code='CARGO_ORDER_NOT_INDEXED';throw e}if(!shipment){const e=new Error('Durumu sorgulanabilecek başarılı kargo kaydı yok.');e.code='CARGO_NOT_CREATED';throw e}try{const result=await cargoService.refreshShipment({shipment});const rows=cargoRecordRows(),row=rows.find(x=>x.id===shipment.id);if(!row){const e=new Error('Kargo kaydı bulunamadı.');e.code='CARGO_RECORD_NOT_FOUND';throw e}const before=row.status,now=new Date().toISOString();row.status=result.status||row.status;row.barcode=result.barcode||row.barcode;row.trackingNumber=result.trackingNumber||row.trackingNumber;row.providerRecordId=result.recordId||row.providerRecordId;row.labelUrl=result.labelUrl||row.labelUrl;if(result.providerMovementText)row.providerMovementText=result.providerMovementText;if(result.providerStatusAt)row.providerStatusAt=result.providerStatusAt;row.providerResponse=redactProviderResponse(result.providerResponse||{});row.updatedAt=now;row.lastStatusAt=now;row.lastCheckedAt=now;row.lastRefreshError='';row.lastRefreshErrorAt='';row.lastRefreshErrorType='';if(row.status==='delivered'&&result.providerStatusAt)row.deliveredAt=result.providerStatusAt;writeJson('cargo_records.json',rows);if(before!==row.status)appendCargoEvent({orderId:row.orderId,shipmentId:row.id,type:'status_changed',label:cargoStatusLabel(row.status),message:row.providerMovementText||'',status:row.status,at:now});syncCargoWorkflowFromProvider(row.orderId,row);cargoMarkIntegrationSuccess();persistCargoStateAsync();publishAdminCargoUpdate(row.orderId,'provider_refresh');return row}catch(e){const rows=cargoRecordRows(),row=rows.find(x=>x.id===shipment.id);if(row){const now=new Date().toISOString();row.lastCheckedAt=now;row.lastRefreshError=cargoSafeError(e);row.lastRefreshErrorAt=now;row.lastRefreshErrorType=cargoSafeErrorType(e);writeJson('cargo_records.json',rows);appendCargoEvent({orderId:row.orderId,shipmentId:row.id,type:'status_refresh_error',label:background?'Arka plan kargo kontrolü başarısız':'Son güncelleme başarısız',message:row.lastRefreshError,status:row.status,at:now});persistCargoStateAsync();publishAdminCargoUpdate(row.orderId,'provider_refresh_error')}cargoMarkIntegrationFailure(e);cargoLogFailure('cargo/status',orderId,e);throw e}}
async function reconcileDuplicateCargoCreates(){const index=ensureCargoWorkflowIndexRows();let checked=0;for(const row of index){if(checked>=5)break;if(successfulCargoRecord(row.orderId))continue;const latest=latestCargoRecord(row.orderId);if(!latest||latest.status!=='error'||!cargoCreateErrorLooksDuplicate({message:latest.errorMessage||''}))continue;const found=cargoPanelOrder(row.orderId);if(!found)continue;checked++;await recoverCargoCreateIfPossible({order:found.order,shipment:latest,error:{message:latest.errorMessage||'Sipariş No ile daha önce kayıt olunmuş.'},rows:cargoRecordRows()})}}
async function runCargoBackgroundProviderRefresh(){if(cargoBackgroundRefreshRunning)return;cargoBackgroundRefreshRunning=true;try{await reconcileDuplicateCargoCreates();const index=ensureCargoWorkflowIndexRows(),ids=[];for(const row of index){if(['delivered','returned'].includes(String(row.adminStage||'')))continue;const shipment=successfulCargoRecord(row.orderId);if(!shipment||CARGO_FINAL_PROVIDER_STATES.has(String(shipment.status||'')))continue;if(!(shipment.barcode||shipment.trackingNumber||shipment.providerRecordId||String(shipment.providerOrderNumber||'')))continue;ids.push(String(row.orderId))}let cursor=0;const worker=async()=>{while(cursor<ids.length){const id=ids[cursor++];try{await refreshCargoShipmentStatus(id,{background:true})}catch(_){}}};await Promise.all(Array.from({length:Math.min(CARGO_BACKGROUND_CONCURRENCY,ids.length)},()=>worker()))}finally{cargoBackgroundRefreshRunning=false}}
function cargoQueryRows(q={}){const index=ensureCargoWorkflowIndexRows(),orders=readJson('orders.json',[]),byId=new Map(orders.map(o=>[String(o.id),o]));let rows=index.map(x=>{const o=byId.get(String(x.orderId));return o?cargoOrderView(o,x):null}).filter(Boolean);const orderId=cargoText(q.orderId,120).toLocaleLowerCase('tr-TR'),name=cargoText(q.name,200).toLocaleLowerCase('tr-TR'),phone=cargoText(q.phone,80).replace(/\D/g,''),city=cargoText(q.city,120).toLocaleLowerCase('tr-TR'),payment=cargoText(q.payment,80).toLocaleLowerCase('tr-TR'),status=cargoText(q.status,80),stage=cargoText(q.stage,40),created=cargoText(q.created,20),orderFrom=cargoText(q.orderDateFrom||q.dateFrom,20),orderTo=cargoText(q.orderDateTo||q.dateTo,20),deliveryFrom=cargoText(q.deliveryDateFrom,20),deliveryTo=cargoText(q.deliveryDateTo,20),orderFromMs=orderFrom?new Date(orderFrom+'T00:00:00').getTime():0,orderToMs=orderTo?new Date(orderTo+'T23:59:59.999').getTime():0,deliveryFromMs=deliveryFrom?new Date(deliveryFrom+'T00:00:00').getTime():0,deliveryToMs=deliveryTo?new Date(deliveryTo+'T23:59:59.999').getTime():0;rows=rows.filter(r=>{const orderDt=new Date(r.orderCreatedAt||0).getTime(),deliveryDt=r.deliveredAt?new Date(r.deliveredAt).getTime():0,hasCargo=!!r.hasProviderShipment;return (!orderId||r.orderId.toLocaleLowerCase('tr-TR').includes(orderId))&&(!name||r.fullName.toLocaleLowerCase('tr-TR').includes(name))&&(!phone||r.phone.replace(/\D/g,'').includes(phone))&&(!city||[r.province,r.district].join(' ').toLocaleLowerCase('tr-TR').includes(city))&&(!payment||String(r.payment||'').toLocaleLowerCase('tr-TR')===payment)&&(!status||r.cargoStatus===status)&&(!stage||stage==='all'||r.adminStage===stage)&&(!created||(created==='yes'?hasCargo:!hasCargo))&&(!orderFromMs||orderDt>=orderFromMs)&&(!orderToMs||orderDt<=orderToMs)&&(!deliveryFromMs||(deliveryDt&&deliveryDt>=deliveryFromMs))&&(!deliveryToMs||(deliveryDt&&deliveryDt<=deliveryToMs))});return rows.sort((a,b)=>new Date(b.panelCreatedAt||b.orderCreatedAt||0)-new Date(a.panelCreatedAt||a.orderCreatedAt||0))}
function cargoStageCounts(rows=[]){const out={all:rows.length,new:0,preparing:0,sent:0,in_transit:0,branch_waiting:0,delivered:0,returned:0};for(const row of rows)if(Object.prototype.hasOwnProperty.call(out,row.adminStage))out[row.adminStage]++;return out}
function cargoLabelPayload(order,shipment){const c=order.customer||{};return {barcode:shipment.barcode||'',trackingNumber:shipment.trackingNumber||'',orderId:String(order.id),sender:'SHAZ',recipient:c.fullName||'',phone:c.phone||'',address:cargoAddress(c),payment:cargoPaymentLabel(order.payment),collectAmount:Number(order.total||0),products:cargoProducts(order).map(x=>`${x.name} x${x.quantity}`).join(', '),cargoCompany:shipment.cargoCompany||'Aras Kargo / YeşilKar',providerLabelUrl:shipment.labelUrl||''}}
function cargoManualOrderOptions(){
  const catalog=readJson('catalog.json',{products:[]}),users=readJson('users.json',[]);
  return {products:(Array.isArray(catalog.products)?catalog.products:[]).filter(p=>p&&p.hidden!==true).map(p=>({id:String(p.id||''),name:String(p.name||'Ürün'),price:Number(p.price||0),image:serverMainProductImage(p)||''})),members:(Array.isArray(users)?users:[]).filter(u=>u&&!u.deleted&&!u.disabled).map(u=>({id:String(u.id||''),customerId:String(u.customerId||''),name:[u.firstName,u.lastName].filter(Boolean).join(' ')||String(u.name||''),phone:String(u.phone||''),email:String(u.email||'')}))};
}
function cargoManualPhotoRef(value){const v=String(value||'').trim();return !v||/^\/(?!\/)/.test(v)||/^https?:\/\//i.test(v)?v:''}
function deleteCargoPanelOrder(orderId){const index=cargoOrderIndexRows(),records=cargoRecordRows(),events=cargoEventRows(),found=index.find(x=>String(x.orderId)===String(orderId));if(!found){const e=new Error('Sipariş yeni kargo panelinde bulunamadı.');e.code='CARGO_ORDER_NOT_INDEXED';throw e}const related=records.filter(x=>String(x.orderId)===String(orderId)),hadProviderCargo=related.some(x=>CARGO_SUCCESS_STATES.has(String(x.status||'')));writeJson('cargo_order_index.json',index.filter(x=>String(x.orderId)!==String(orderId)));writeJson('cargo_records.json',records.filter(x=>String(x.orderId)!==String(orderId)));writeJson('cargo_events.json',events.filter(x=>String(x.orderId)!==String(orderId)));persistCargoStateAsync();publishAdminCargoUpdate(orderId,'deleted');return {orderId:String(orderId),hadProviderCargo,removedShipments:related.length}}
app.get('/api/admin/cargo/orders',requireAdmin,(req,res)=>{const page=Math.max(1,Number(req.query.page||1)),pageSize=Math.max(10,Math.min(100,Number(req.query.pageSize||25))),base=cargoQueryRows({...req.query,stage:''}),stage=cargoText(req.query.stage,40),all=stage&&stage!=='all'?base.filter(x=>x.adminStage===stage):base,start=(page-1)*pageSize;res.setHeader('Cache-Control','no-store');res.json({ok:true,orders:all.slice(start,start+pageSize),pagination:{page,pageSize,total:all.length,pages:Math.max(1,Math.ceil(all.length/pageSize))},statuses:CARGO_STATUS_OPTIONS,adminStages:Object.values(CARGO_ADMIN_STAGES),stageCounts:cargoStageCounts(base),cutover:ensureCargoFeatureState(),cargo:cargoIntegrationSnapshot()})});
app.get('/api/admin/cargo/orders/:id',requireAdmin,(req,res)=>{const found=cargoPanelOrder(req.params.id);if(!found)return res.status(404).json({ok:false,message:'Sipariş yeni kargo panelinde bulunamadı.'});res.setHeader('Cache-Control','no-store');res.json({ok:true,order:cargoOrderDetailPayload(found.order,found.index),statuses:CARGO_STATUS_OPTIONS,adminStages:Object.values(CARGO_ADMIN_STAGES),cargo:{...cargoIntegrationSnapshot(),missing:undefined}})});
app.post('/api/admin/cargo/orders/:id/create',requireAdmin,sameOriginGuard,async(req,res)=>{try{const shipment=await createCargoForIndexedOrder(req.params.id,{resend:false});res.json({ok:true,shipment})}catch(e){const status=e.code==='CARGO_INTEGRATION_NOT_CONFIGURED'||e.code==='CARGO_ALREADY_CREATED'||e.code==='CARGO_CREATE_IN_PROGRESS'||e.code==='CARGO_CREATE_RECONCILE_REQUIRED'?409:e.code==='CARGO_ORDER_NOT_INDEXED'?404:502;res.status(status).json({ok:false,code:e.code||'CARGO_ERROR',message:cargoSafeError(e)})}});
app.post('/api/admin/cargo/orders/:id/attach-existing',requireAdmin,sameOriginGuard,async(req,res)=>{try{const shipment=await attachExistingCargoByBarcode(req.params.id,req.body?.barcode);res.json({ok:true,shipment})}catch(e){const status=e.code==='CARGO_ORDER_NOT_INDEXED'?404:['CARGO_BARCODE_INVALID','CARGO_EXISTING_NOT_VERIFIED','CARGO_ALREADY_CREATED'].includes(e.code)?409:502;res.status(status).json({ok:false,code:e.code||'CARGO_ERROR',message:cargoSafeError(e)})}});
app.post('/api/admin/cargo/orders/:id/new-barcode',requireAdmin,sameOriginGuard,async(req,res)=>{if(req.body?.confirm!==true)return res.status(400).json({ok:false,message:'Yeni barkod için confirm=true gerekli.'});const found=cargoPanelOrder(req.params.id),active=found?successfulCargoRecord(found.order.id):null;if(!found)return res.status(404).json({ok:false,message:'Sipariş yeni kargo panelinde bulunamadı.'});if(!active)return res.status(409).json({ok:false,code:'CARGO_NOT_CREATED',message:'Yeni barkod için önce mevcut başarılı bir kargo kaydı gerekir.'});if(found.order.cargoShipmentDirty!==true)return res.status(409).json({ok:false,code:'CARGO_NEW_BARCODE_NOT_REQUIRED',message:'Sipariş bilgileri mevcut barkoddan sonra değişmedi; yeni barkod gerekmiyor.'});if(['delivered','returned'].includes(String(found.index.adminStage||'')))return res.status(409).json({ok:false,code:'CARGO_FINAL_ORDER',message:'Teslim edilmiş veya iade edilmiş geçmiş sipariş için yeni barkod oluşturulamaz.'});try{const shipment=await createCargoForIndexedOrder(req.params.id,{resend:true});res.json({ok:true,shipment})}catch(e){const status=e.code==='CARGO_INTEGRATION_NOT_CONFIGURED'||e.code==='CARGO_NOT_CREATED'||e.code==='CARGO_CREATE_IN_PROGRESS'?409:e.code==='CARGO_ORDER_NOT_INDEXED'?404:502;res.status(status).json({ok:false,code:e.code||'CARGO_ERROR',message:cargoSafeError(e)})}});
app.post('/api/admin/cargo/orders/:id/resend',requireAdmin,sameOriginGuard,async(req,res)=>{if(req.body?.confirm!==true)return res.status(400).json({ok:false,message:'Yeniden kargoya gönderme için confirm=true gerekli.'});try{const shipment=await createCargoForIndexedOrder(req.params.id,{resend:true});res.json({ok:true,shipment})}catch(e){const status=e.code==='CARGO_INTEGRATION_NOT_CONFIGURED'||e.code==='CARGO_NOT_CREATED'||e.code==='CARGO_CREATE_IN_PROGRESS'?409:e.code==='CARGO_ORDER_NOT_INDEXED'?404:502;res.status(status).json({ok:false,code:e.code||'CARGO_ERROR',message:cargoSafeError(e)})}});
app.post('/api/admin/cargo/orders/:id/refresh',requireAdmin,sameOriginGuard,async(req,res)=>{try{const shipment=await refreshCargoShipmentStatus(req.params.id,{background:false});res.json({ok:true,shipment})}catch(e){const status=e.code==='CARGO_ORDER_NOT_INDEXED'||e.code==='CARGO_RECORD_NOT_FOUND'?404:e.code==='CARGO_STATUS_NOT_CONFIGURED'||e.code==='CARGO_INTEGRATION_NOT_CONFIGURED'||e.code==='CARGO_NOT_CREATED'?409:502;res.status(status).json({ok:false,code:e.code||'CARGO_ERROR',message:cargoSafeError(e)})}});
app.post('/api/admin/cargo/orders/:id/stage',requireAdmin,sameOriginGuard,(req,res)=>{try{if(req.body?.stage!=='sent')return res.status(400).json({ok:false,message:'Bu işlem için yalnız Gönderildi aşaması manuel seçilebilir.'});const found=cargoPanelOrder(req.params.id),shipment=found?successfulCargoRecord(found.order.id):null;if(!found)return res.status(404).json({ok:false,message:'Sipariş yeni kargo panelinde bulunamadı.'});if(!shipment||found.index.adminStage!=='preparing')return res.status(409).json({ok:false,message:'Yalnız Hazırlanıyor aşamasındaki gerçek kargo kaydı Gönderildi olarak işaretlenebilir.'});try{cargoAssertShipmentCurrent(found.order)}catch(e){return res.status(409).json({ok:false,code:e.code,message:e.message})}const row=setCargoAdminStage(req.params.id,'sent',{source:'manual',reason:'Ürün fiziksel olarak kargoya teslim edildi olarak işaretlendi.',shipmentId:shipment.id});res.json({ok:true,adminStage:row.adminStage})}catch(e){res.status(e.code==='CARGO_ORDER_NOT_INDEXED'?404:409).json({ok:false,code:e.code||'CARGO_STAGE_ERROR',message:cargoSafeError(e)})}});
app.post('/api/admin/cargo/orders/:id/undo-stage',requireAdmin,sameOriginGuard,(req,res)=>{try{const row=undoCargoAdminStage(req.params.id);res.json({ok:true,adminStage:row.adminStage})}catch(e){res.status(e.code==='CARGO_ORDER_NOT_INDEXED'?404:409).json({ok:false,code:e.code||'CARGO_STAGE_ERROR',message:cargoSafeError(e)})}});
app.post('/api/admin/cargo/bulk-stage',requireAdmin,sameOriginGuard,(req,res)=>{const ids=[...new Set((Array.isArray(req.body?.orderIds)?req.body.orderIds:[]).map(x=>cargoText(x,120)).filter(Boolean))].slice(0,100);if(!ids.length)return res.status(400).json({ok:false,message:'Sipariş seçilmedi.'});if(req.body?.stage!=='sent')return res.status(400).json({ok:false,message:'Bu toplu işlem için yalnız Gönderildi aşaması destekleniyor.'});const results=ids.map(id=>{try{const found=cargoPanelOrder(id),shipment=found?successfulCargoRecord(id):null;if(!found||!shipment||found.index.adminStage!=='preparing')throw new Error('Hazırlanıyor aşamasında gerçek kargo kaydı yok.');cargoAssertShipmentCurrent(found.order);setCargoAdminStage(id,'sent',{source:'manual',reason:'Toplu işlemle Gönderildi olarak işaretlendi.',shipmentId:shipment.id});return {orderId:id,ok:true}}catch(e){return {orderId:id,ok:false,message:cargoSafeError(e)}}});res.json({ok:true,total:ids.length,updated:results.filter(x=>x.ok).length,results})});
app.post('/api/admin/cargo/bulk-undo-stage',requireAdmin,sameOriginGuard,(req,res)=>{const ids=[...new Set((Array.isArray(req.body?.orderIds)?req.body.orderIds:[]).map(x=>cargoText(x,120)).filter(Boolean))].slice(0,100);if(!ids.length)return res.status(400).json({ok:false,message:'Sipariş seçilmedi.'});const results=ids.map(id=>{try{undoCargoAdminStage(id);return {orderId:id,ok:true}}catch(e){return {orderId:id,ok:false,message:cargoSafeError(e)}}});res.json({ok:true,total:ids.length,updated:results.filter(x=>x.ok).length,results})});
app.post('/api/admin/cargo/bulk-create',requireAdmin,sameOriginGuard,async(req,res)=>{const ids=[...new Set((Array.isArray(req.body?.orderIds)?req.body.orderIds:[]).map(x=>cargoText(x,120)).filter(Boolean))].slice(0,100);if(!ids.length)return res.status(400).json({ok:false,message:'Sipariş seçilmedi.'});const results=[];for(const id of ids){try{const shipment=await createCargoForIndexedOrder(id,{resend:false});results.push({orderId:id,ok:true,shipmentId:shipment.id})}catch(e){results.push({orderId:id,ok:false,code:e.code||'CARGO_ERROR',message:cargoSafeError(e)})}}res.json({ok:true,total:ids.length,created:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok).length,results})});
app.get('/api/admin/cargo/orders/:id/label',requireAdmin,(req,res)=>{const found=cargoPanelOrder(req.params.id);if(!found)return res.status(404).json({ok:false,message:'Sipariş yeni kargo panelinde bulunamadı.'});const shipment=successfulCargoRecord(found.order.id);if(!shipment||!shipment.barcode)return res.status(409).json({ok:false,message:'Etiket için gerçek WebPostman barkodu olan aktif kargo kaydı bulunmuyor.'});try{cargoAssertShipmentCurrent(found.order)}catch(e){return res.status(409).json({ok:false,code:e.code,message:e.message})}res.setHeader('Cache-Control','no-store');res.json({ok:true,label:cargoLabelPayload(found.order,shipment)})});
app.post('/api/admin/cargo/labels',requireAdmin,sameOriginGuard,(req,res)=>{const ids=[...new Set((Array.isArray(req.body?.orderIds)?req.body.orderIds:[]).map(x=>cargoText(x,120)).filter(Boolean))].slice(0,100);if(!ids.length)return res.status(400).json({ok:false,message:'Sipariş seçilmedi.'});const labels=[],skipped=[];for(const id of ids){const found=cargoPanelOrder(id),shipment=found?successfulCargoRecord(id):null;if(!found){skipped.push({orderId:id,reason:'Sipariş kargo panelinde bulunamadı.'});continue}if(!shipment||!shipment.barcode){skipped.push({orderId:id,reason:'Gerçek WebPostman barkodu olan aktif kargo kaydı yok.'});continue}if(found.order.cargoShipmentDirty===true){skipped.push({orderId:id,reason:cargoShipmentDirtyError().message});continue}labels.push(cargoLabelPayload(found.order,shipment))}res.setHeader('Cache-Control','no-store');res.json({ok:true,labels,skipped})});
app.post('/api/admin/cargo/orders/:id/delete',requireAdmin,sameOriginGuard,(req,res)=>{if(req.body?.confirm!==true||req.body?.confirmPermanent!==true)return res.status(400).json({ok:false,message:'Kalıcı silme için iki aşamalı onay gerekli.'});try{res.json({ok:true,...deleteCargoPanelOrder(req.params.id)})}catch(e){res.status(e.code==='CARGO_ORDER_NOT_INDEXED'?404:409).json({ok:false,code:e.code||'CARGO_DELETE_ERROR',message:cargoSafeError(e)})}});
app.post('/api/admin/cargo/bulk-delete',requireAdmin,sameOriginGuard,(req,res)=>{if(req.body?.confirm!==true||req.body?.confirmPermanent!==true)return res.status(400).json({ok:false,message:'Toplu kalıcı silme için iki aşamalı onay gerekli.'});const ids=[...new Set((Array.isArray(req.body?.orderIds)?req.body.orderIds:[]).map(x=>cargoText(x,120)).filter(Boolean))].slice(0,100);if(!ids.length)return res.status(400).json({ok:false,message:'Sipariş seçilmedi.'});const results=ids.map(id=>{try{return {ok:true,...deleteCargoPanelOrder(id)}}catch(e){return {orderId:id,ok:false,message:cargoSafeError(e)}}});res.json({ok:true,total:ids.length,deleted:results.filter(x=>x.ok).length,remoteMayRemain:results.filter(x=>x.ok&&x.hadProviderCargo).length,results})});
app.get('/api/admin/cargo/manual-order-options',requireAdmin,(req,res)=>{res.setHeader('Cache-Control','no-store');res.json({ok:true,...cargoManualOrderOptions()})});
app.post('/api/admin/cargo/manual-order',requireAdmin,sameOriginGuard,async(req,res)=>serializedMutation('orders',async()=>{
  try{
    const body=req.body&&typeof req.body==='object'&&!Array.isArray(req.body)?req.body:{},orders=readJson('orders.json',[]),catalog=readJson('catalog.json',{products:[]}),byId=new Map((Array.isArray(catalog.products)?catalog.products:[]).map(p=>[String(p.id||''),p])),customer=body.customer&&typeof body.customer==='object'?body.customer:{};
    const fullName=cargoText(customer.fullName,200),phone=normalizeTRMobile(customer.phone),province=cargoText(customer.province,120),district=cargoText(customer.district,120),fullAddress=cargoText(customer.fullAddress,1000),email=cargoText(customer.email,240);
    if(!fullName||!phone||!province||!district||!fullAddress)return res.status(400).json({ok:false,message:'Ad Soyad, telefon, il, ilçe ve adres zorunludur.'});
    const rawItems=Array.isArray(body.items)?body.items:[];if(!rawItems.length||rawItems.length>50)return res.status(400).json({ok:false,message:'En az bir gerçek ürün seçin.'});
    const items=[];for(const raw of rawItems){const product=byId.get(String(raw?.productId||''));if(!product)return res.status(400).json({ok:false,message:'Manuel siparişte doğrulanamayan ürün var.'});const qty=Math.max(1,Math.min(99,Math.floor(Number(raw?.qty)||1))),requestedPrice=raw?.price===''||raw?.price===null||raw?.price===undefined?Number(product.price||0):Number(raw.price);if(!Number.isFinite(requestedPrice)||requestedPrice<0)return res.status(400).json({ok:false,message:'Ürün fiyatı geçersiz.'});const text=cargoText(raw?.personalizationText,500),position=cargoText(raw?.personalizationPosition,160),photoRef=cargoManualPhotoRef(raw?.photoUrl),photoPosition=cargoText(raw?.photoPosition,160),writes=text?[{item:product.name||'Ürün',text,position,fee:0}]:[],photoCustomizations=photoRef?[{item:product.name||'Ürün',imageUrl:photoRef,url:photoRef,position:photoPosition,fee:0}]:[];items.push({product:{...product,price:requestedPrice},basePrice:requestedPrice,qty,writes,photoCustomizations,personalized:writes.length>0||photoCustomizations.length>0,productNote:cargoText(raw?.productNote,500)})}
    const subtotal=Number(items.reduce((sum,x)=>sum+Number(x.product?.price||0)*Number(x.qty||1),0).toFixed(2)),rawTotal=body.total,total=rawTotal===''||rawTotal===null||rawTotal===undefined?subtotal:Number(rawTotal);if(!Number.isFinite(total)||total<0)return res.status(400).json({ok:false,message:'Sipariş toplamı geçersiz.'});
    const payment=['cod','online'].includes(String(body.payment||'cod'))?String(body.payment||'cod'):'cod',memberUserId=cargoText(body.memberUserId,160),members=readJson('users.json',[]),member=memberUserId?(Array.isArray(members)?members:[]).find(u=>String(u.id)===memberUserId&&!u.deleted&&!u.disabled):null;if(memberUserId&&!member)return res.status(400).json({ok:false,message:'Seçilen mevcut üye bulunamadı veya aktif değil.'});
    const now=new Date(),createdAt=now.toISOString(),createdAtTR=new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(now),order={id:nextLocalOrderId(orders),createdAt,createdAtTR,status:'new',statusUpdatedAt:createdAt,requestId:'ADMIN-MANUAL-'+crypto.randomUUID(),sheetSyncStatus:'pending',sheetSyncError:'',manualOrder:true,orderSource:'admin_manual',userId:member?.id||null,customerId:member?.customerId||null,customer:{fullName,phone,email,province,district,fullAddress},payment,items,subtotal,discountTotal:0,preCouponTotal:subtotal,couponDiscountTotal:0,total,orderNote:cargoText(body.orderNote,500),personalizationSnapshots:personalizationSnapshots(items)};
    orders.unshift(order);writeJson('orders.json',orders);await persistOrdersToGithub().catch(e=>{console.error('Manuel sipariş kalıcı kayıt:',e);throw e});registerCargoPanelOrder(order);setTimeout(()=>syncPendingOrdersToSheets(),0);publishAdminCargoUpdate(order.id,'manual_order_created');return res.json({ok:true,order:cargoOrderDetailPayload(order,ensureCargoWorkflowIndexRows().find(x=>String(x.orderId)===String(order.id)))})
  }catch(e){console.error('Manuel sipariş oluşturma:',e);return res.status(500).json({ok:false,message:'Manuel sipariş kaydedilemedi.'})}
}));

app.get('/api/orders',requireAdmin,(req,res)=>res.json(ordersWithDailyDisplayIds(readJson('orders.json',[]))));
app.patch('/api/orders/status',requireAdmin,async(req,res)=>serializedMutation('orders',async()=>{
 const ids=Array.isArray(req.body.ids)?req.body.ids:[]; const status=req.body.status;
 if(!ORDER_STATUSES.has(String(status||'')))return res.status(400).json({ok:false});
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
  const id=String(req.params.id||'').trim(),orders=readJson('orders.json',[]),order=orders.find(o=>String(o.id||'')===id);if(!order)return res.status(404).json({ok:false,message:'Sipariş bulunamadı.'});
  const body=req.body&&typeof req.body==='object'?req.body:{},beforeRelevant=JSON.stringify(cargoShipmentRelevantData(order)),wasDirty=order.cargoShipmentDirty===true,customerPatch=body.customer&&typeof body.customer==='object'?body.customer:{};order.customer=(order.customer&&typeof order.customer==='object')?order.customer:{};
  const customerFields=['fullName','phone','extraPhone','email','province','district','neighborhood','avenue','street','fullAddress','buildingNo','floor','doorNo','businessName','branchName','note','deliveryMode','placeType','addressTitle'];for(const key of customerFields)if(Object.prototype.hasOwnProperty.call(customerPatch,key))order.customer[key]=String(customerPatch[key]??'').trim();
  if(Object.prototype.hasOwnProperty.call(customerPatch,'phone')){const phone=normalizeTRMobile(customerPatch.phone);if(!phone)return res.status(400).json({ok:false,message:'Telefon numarası geçersiz.'});order.customer.phone=phone}
  if(Object.prototype.hasOwnProperty.call(customerPatch,'extraPhone')){const raw=String(customerPatch.extraPhone||'').trim(),extra=raw?normalizeTRMobile(raw):'';if(raw&&!extra)return res.status(400).json({ok:false,message:'2. telefon numarası geçersiz.'});if(extra&&extra===order.customer.phone)return res.status(400).json({ok:false,message:'İki telefon numarası aynı olamaz.'});order.customer.extraPhone=extra}
  if(Object.prototype.hasOwnProperty.call(body,'payment')){const payment=String(body.payment||'').trim();if(payment)order.payment=payment}
  if(Object.prototype.hasOwnProperty.call(body,'total')){const total=Number(body.total);if(!Number.isFinite(total)||total<0)return res.status(400).json({ok:false,message:'Toplam tutar geçersiz.'});order.total=total}
  if(Object.prototype.hasOwnProperty.call(body,'orderNote'))order.orderNote=String(body.orderNote||'').trim().slice(0,500);
  if(Array.isArray(body.items))body.items.forEach((patch,i)=>{const item=order.items?.[i];if(!item||!patch||typeof patch!=='object')return;item.product=(item.product&&typeof item.product==='object')?item.product:{};if(Object.prototype.hasOwnProperty.call(patch,'name'))item.product.name=String(patch.name||'').trim()||item.product.name||'Ürün';if(Object.prototype.hasOwnProperty.call(patch,'price')){const price=Number(patch.price);if(Number.isFinite(price)&&price>=0)item.product.price=price}if(Object.prototype.hasOwnProperty.call(patch,'qty'))item.qty=Math.max(1,Math.floor(Number(patch.qty)||1))});
  const afterRelevant=JSON.stringify(cargoShipmentRelevantData(order)),shipmentRelevantChanged=beforeRelevant!==afterRelevant,activeShipment=successfulCargoRecord(id),changedFields=[...Object.keys(customerPatch),...(Object.prototype.hasOwnProperty.call(body,'payment')?['payment']:[]),...(Object.prototype.hasOwnProperty.call(body,'total')?['total']:[]),...(Object.prototype.hasOwnProperty.call(body,'orderNote')?['orderNote']:[]),...(Array.isArray(body.items)?['items']:[])],at=new Date().toISOString();
  if(shipmentRelevantChanged&&activeShipment){order.cargoShipmentDirty=true;order.cargoShipmentDirtyAt=at;order.cargoShipmentDirtyFields=[...new Set([...(Array.isArray(order.cargoShipmentDirtyFields)?order.cargoShipmentDirtyFields:[]),...changedFields])].slice(0,40)}
  if(changedFields.length){order.adminEditHistory=[...(Array.isArray(order.adminEditHistory)?order.adminEditHistory:[]),{at,fields:[...new Set(changedFields)].slice(0,40),shipmentRelevantChanged}].slice(-100);order.updatedAt=at}
  try{await sheetsRequest({action:'update',requestId:order.requestId,order})}catch(e){console.error('Google E-Tablo sipariş düzenleme hatası:',e);return res.status(503).json({ok:false,message:'Sipariş Google E-Tablo ile eşitlenemedi. Tekrar deneyin.'})}
  writeJson('orders.json',orders);await persistOrdersToGithub().catch(e=>{console.error('Sipariş düzenleme kalıcı kayıt:',e);throw e});if(!wasDirty&&order.cargoShipmentDirty===true){appendCargoEvent({orderId:id,shipmentId:activeShipment?.id||null,type:'shipment_dirty',label:'Sipariş barkod sonrası değiştirildi',message:'Mevcut barkod eski sipariş bilgilerini içeriyor; yeni barkod gerekli.',status:activeShipment?.status||'',at});persistCargoStateAsync();publishAdminCargoUpdate(id,'shipment_dirty')}return res.json({ok:true,order,shipmentDirty:order.cargoShipmentDirty===true});
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
 const allOrders=readJson('orders.json',[]);
 const selectedIds=[...new Set(String(req.query.selectedIds||'').split(',').map(x=>x.trim()).filter(Boolean))];
 const cargoFilterKeys=['orderId','name','phone','city','payment','status','stage','created','orderDateFrom','orderDateTo','deliveryDateFrom','deliveryDateTo'];
 const hasCargoFilter=cargoFilterKeys.some(k=>String(req.query[k]||'').trim());
 let orders=allOrders;
 if(selectedIds.length){const wanted=new Set(selectedIds);orders=allOrders.filter(o=>wanted.has(String(o.id)))}else if(hasCargoFilter){const wanted=new Set(cargoQueryRows(req.query).map(x=>String(x.orderId)));orders=allOrders.filter(o=>wanted.has(String(o.id)))}
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
 writeJson('orders.json',allOrders);
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
     try{const indexed=registerCargoPanelOrder(existing),exists=indexed||cargoOrderIndexRows().some(x=>String(x.orderId)===String(existing.id));if(!exists)throw new Error('Sipariş kargo paneline kaydedilemedi.')}catch(e){console.error('Kargo paneli duplicate kayıt kontrolü:',e.message);return res.status(500).json({ok:false,message:'Sipariş kaydı bulundu ancak yönetim paneli kaydı tamamlanamadı. Lütfen tekrar deneyin.'})}
     if(existing.sheetSyncStatus!=='synced')setTimeout(()=>syncPendingOrdersToSheets(),0);
     return res.json({ok:true,order:existing,duplicate:true});
   }

   const now=new Date();
   const createdAt=now.toISOString();
   const createdAtTR=new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(now);
   const incoming=req.body&&typeof req.body==='object'&&!Array.isArray(req.body)?req.body:{};
   const body={items:incoming.items,customer:incoming.customer&&typeof incoming.customer==='object'&&!Array.isArray(incoming.customer)?{...incoming.customer}:{},payment:incoming.payment,orderNote:incoming.orderNote,personalApproval:incoming.personalApproval,shippingNoticeAccepted:incoming.shippingNoticeAccepted,legalAcceptances:incoming.legalAcceptances,legalDocumentRefs:incoming.legalDocumentRefs,appliedCouponIds:incoming.appliedCouponIds};
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
   const requestedPayment=String(body.payment||'cod').trim().toLowerCase();
   if(requestedPayment!=='cod')return res.status(400).json({ok:false,message:'Geçersiz ödeme yöntemi.'});
   body.payment='cod';

   // v153: Üye/misafir aynı sipariş oluşturma mantığını kullanır; yalnız ilişki ve hukuki kayıt eklenir.
   const signedUser=accountUserFromReq(req);
   body.userId=signedUser?.id||null;body.customerId=signedUser?.customerId||null;
   let prepared;try{prepared=serverPrepareOrderItems(body.items)}catch(validationError){return res.status(400).json({ok:false,message:String(validationError?.message||'Sipariş ürünleri geçersiz.')})}body.items=prepared.items;const campaignResult=serverCampaignPricing(body.items,prepared.catalog),preCouponTotal=campaignResult.total;
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
   const order={...body,id:nextLocalOrderId(orders),createdAt,createdAtTR,status:'new',statusUpdatedAt:createdAt,requestId,sheetSyncStatus:'pending',sheetSyncError:'',deviceId:normalizeDeviceId(incoming.deviceId)||null,userId:body.userId||null,customerId:body.customerId||null,subtotal:body.subtotal,discountTotal:body.discountTotal,preCouponTotal:body.preCouponTotal,couponDiscountTotal:body.couponDiscountTotal,total:body.total};
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

   // Siparişin ana kaydı, hukuk kayıtları ve kargo paneli indeksi başarıyla yerelde oluşturulmadan müşteriye başarı dönme.
   try{const indexed=registerCargoPanelOrder(order),exists=indexed||cargoOrderIndexRows().some(x=>String(x.orderId)===String(order.id));if(!exists)throw new Error('Sipariş kargo paneline kaydedilemedi.')}catch(e){console.error('Kargo paneli sipariş indeksleme:',e.message);throw e}
   // Üye hesabı, push bildirimi, GitHub kalıcı kopyası ve Google E-Tablo senkronu siparişin oluşmasını bekletmez.
   // Sipariş bu noktada gerçekten orders.json içine yazılmış ve kargo paneline indekslenmiştir.
   if(signedUser)persistAccountStateAsync();
   setTimeout(async()=>{try{await sendOrderStatusPush(order,'new');const latest=readJson('orders.json',[]);const saved=latest.find(x=>String(x.id)===String(order.id));if(saved){saved.notificationHistory=order.notificationHistory;writeJson('orders.json',latest)}}catch(e){console.error('Sipariş push bildirimi:',e)}},0);
   setTimeout(async()=>{try{await persistOrdersToGithub()}catch(e){console.error('Sipariş kalıcı kayıt:',e)}},0);
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

const CUSTOMER_UPLOAD_ORPHAN_AGE_MS=7*24*60*60*1000,SHARED_CART_MAX_AGE_MS=90*24*60*60*1000;
function referencedCustomerUploadFiles(){
  const refs=new Set(),raw=JSON.stringify(readJson('orders.json',[])),re=/\/api\/customer-image\/([a-f0-9]{48}\.(?:jpg|png|webp))/g;let m;while((m=re.exec(raw)))refs.add(m[1]);return refs;
}
function cleanupOrphanCustomerUploads(){
  const refs=referencedCustomerUploadFiles(),cutoff=Date.now()-CUSTOMER_UPLOAD_ORPHAN_AGE_MS;let removed=0;
  for(const name of fs.readdirSync(privateUploadDir)){if(!/^[a-f0-9]{48}\.(?:jpg|png|webp|upload)$/.test(name)||refs.has(name))continue;const f=path.join(privateUploadDir,name);let st;try{st=fs.statSync(f)}catch{continue}if(!st.isFile()||st.mtimeMs>cutoff)continue;try{fs.unlinkSync(f);removed++}catch(_){}}
  if(removed)console.log('Terk edilmiş müşteri fotoğrafı temizlendi:',removed);
}
function cleanupStaleSharedCarts(){
  const cutoff=Date.now()-SHARED_CART_MAX_AGE_MS;let removed=0;
  for(const name of fs.readdirSync(sharedCartDir)){if(!/^(?:[a-f0-9]{8}|[a-f0-9]{24})\.json$/.test(name))continue;const f=path.join(sharedCartDir,name);let st;try{st=fs.statSync(f)}catch{continue}if(!st.isFile()||st.mtimeMs>cutoff)continue;try{fs.unlinkSync(f);removed++}catch(_){}}
  if(removed)console.log('Eski paylaşılan sepet temizlendi:',removed);
}
function runSafeStorageCleanup(){try{cleanupOrphanCustomerUploads()}catch(e){console.warn('Müşteri fotoğrafı temizliği:',e?.message||e)}try{cleanupStaleSharedCarts()}catch(e){console.warn('Paylaşılan sepet temizliği:',e?.message||e)}}

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
function pushRecordActive(p={}){const status=String(p.pushSubscriptionStatus||p.status||'ACTIVE').toUpperCase(),lifecycle=String(p.lifecycle||p.recordState||'').toLowerCase();return status!=='INVALID'&&p.invalidatedAt==null&&p.permanentInvalidAt==null&&p.supersededAt==null&&lifecycle!=='superseded'}
function pushRecordTargetEligible(p={}){const relevance=String(p.deviceRelevance||'').toLowerCase();return pushRecordActive(p)&&!!normalizeDeviceId(p.deviceId)&&String(p.lifecycle||p.recordState||'').toLowerCase()!=='legacy-unbound'&&relevance!=='historical'}
function pushOwnerKey(p={}){return p.userId?'u:'+String(p.userId):p.customerId?'c:'+String(p.customerId):''}
const CURRENT_DEVICE_STATE_GENERATION=196;
function deviceStateGeneration(v){const n=Number(v?.deviceStateGeneration??v);return Number.isInteger(n)&&n>0?n:0}
function currentDeviceGeneration(v={}){return deviceStateGeneration(v)===CURRENT_DEVICE_STATE_GENERATION}
function pushCurrentEvidenceAt(p={}){const strong=Math.max(evidenceTime(p.lastPushDeviceAckAt),evidenceTime(p.currentVerifiedAt),evidenceTime(p.authoritativeAt),evidenceTime(p.subscriptionVerifiedAt),evidenceTime(p.pwaObservedAt));if(strong)return strong;const providerTouched=!!(p.lastPushAttemptAt||p.lastPushAcceptedAt||p.lastPushSuccessAt||p.lastPushFailureAt);return providerTouched?0:Math.max(evidenceTime(p.createdAt),evidenceTime(p.updatedAt))}
function activityCurrentEvidenceAt(a={}){return Math.max(evidenceTime(a.currentVerifiedAt),evidenceTime(a.notificationObservedAt),evidenceTime(a.lastNotificationVerifiedAt),evidenceTime(a.lastSeenAt),evidenceTime(a.lastOpenAt),evidenceTime(a.lastPushDeviceAckAt),evidenceTime(a.lastPwaStandaloneLaunchAt),evidenceTime(a.lastPwaInstalledSignalAt))}
function currentDeviceEvidenceAt(a={},pushRows=[]){return Math.max(activityCurrentEvidenceAt(a),0,...(pushRows||[]).filter(pushRecordActive).map(pushCurrentEvidenceAt))}
function isCurrentRelevantDevice(a={},pushRows=[]){if(!normalizeDeviceId(a.deviceId))return false;return currentDeviceGeneration(a)||(pushRows||[]).some(x=>pushRecordActive(x)&&normalizeDeviceId(x.deviceId)===normalizeDeviceId(a.deviceId)&&currentDeviceGeneration(x))}
function pushRecordCurrentRelevant(p={}){return pushRecordTargetEligible(p)&&currentDeviceGeneration(p)}
function markPushHistorical(row,at,reason='previous_device_generation'){if(!row||!pushRecordActive(row)||!normalizeDeviceId(row.deviceId))return false;if(String(row.deviceRelevance||'').toLowerCase()==='historical'&&row.historicalReason===reason)return false;row.deviceRelevance='historical';row.historicalAt=row.historicalAt||at;row.historicalReason=reason;row.deviceRelevanceUpdatedAt=at;return true}
function deviceAuthorityEvidenceAt(deviceId,pushRows=[],acts=activityRows()){deviceId=normalizeDeviceId(deviceId);if(!deviceId)return 0;const a=(acts||[]).find(x=>normalizeDeviceId(x.deviceId)===deviceId)||{},activityStrong=Math.max(evidenceTime(a.currentVerifiedAt),evidenceTime(a.lastNotificationVerifiedAt),evidenceTime(a.lastOpenAt),evidenceTime(a.lastPushDeviceAckAt),evidenceTime(a.lastPwaStandaloneLaunchAt),evidenceTime(a.lastPwaInstalledSignalAt)),pushStrong=(pushRows||[]).filter(x=>normalizeDeviceId(x.deviceId)===deviceId&&pushRecordActive(x)).reduce((m,x)=>Math.max(m,evidenceTime(x.lastPushDeviceAckAt),evidenceTime(x.currentVerifiedAt),evidenceTime(x.authoritativeAt),evidenceTime(x.subscriptionVerifiedAt),evidenceTime(x.pwaObservedAt)),0);return Math.max(activityStrong,pushStrong)}
function latestAuthoritativeDeviceId(pushRows=[],acts=activityRows()){const candidates=(pushRows||[]).filter(x=>pushRecordTargetEligible(x)&&pushRecordCurrentRelevant(x)),userIds=new Set(candidates.map(x=>String(x.userId||'')).filter(Boolean)),customerIds=new Set(candidates.map(x=>String(x.customerId||'')).filter(Boolean)),ownerActs=(acts||[]).filter(a=>(a.userId&&userIds.has(String(a.userId)))||(a.customerId&&customerIds.has(String(a.customerId)))).filter(a=>isCurrentRelevantDevice(a,candidates.filter(p=>normalizeDeviceId(p.deviceId)===normalizeDeviceId(a.deviceId)))),ids=[...new Set([...candidates.map(x=>normalizeDeviceId(x.deviceId)),...ownerActs.map(x=>normalizeDeviceId(x.deviceId))].filter(Boolean))];let best='',bestAt=-1;for(const id of ids){const at=deviceAuthorityEvidenceAt(id,candidates,ownerActs);if(at>bestAt){best=id;bestAt=at}}return best}
function pushClientContext(p={}){const c=String(p.clientContext||'').toLowerCase();if(c==='pwa'||c==='browser')return c;return p.pwa===true?'pwa':'browser'}
function pushAuthorityEvidenceAt(p={}){return Math.max(evidenceTime(p.lastPushDeviceAckAt),evidenceTime(p.currentVerifiedAt),evidenceTime(p.authoritativeAt),evidenceTime(p.subscriptionVerifiedAt),evidenceTime(p.pwaObservedAt),evidenceTime(p.updatedAt),evidenceTime(p.createdAt))}
function latestPushAuthorityRecord(rows=[]){return [...(rows||[])].filter(x=>pushRecordTargetEligible(x)&&pushRecordCurrentRelevant(x)).sort((a,b)=>pushAuthorityEvidenceAt(b)-pushAuthorityEvidenceAt(a))[0]||null}
function latestPushAuthorityDeviceId(rows=[]){return normalizeDeviceId(latestPushAuthorityRecord(rows)?.deviceId)}
function keepLatestAuthoritativePushTargets(rows=[],acts=activityRows()){const groups=new Map();for(const row of (rows||[])){if(!pushRecordTargetEligible(row)||!pushRecordCurrentRelevant(row))continue;const deviceId=normalizeDeviceId(row.deviceId),owner=pushOwnerKey(row)||('d:'+deviceId);if(!groups.has(owner))groups.set(owner,[]);groups.get(owner).push(row)}const out=[];for(const group of groups.values()){const best=latestPushAuthorityRecord(group);if(best)out.push(best)}return out}
function latestIso(values){return (values||[]).filter(Boolean).sort().at(-1)||''}
function activityNotificationContext(a={},context='browser'){
  const p=context==='pwa'?'pwa':'browser',cap=p[0].toUpperCase()+p.slice(1),permission=String(a[p+'NotificationPermission']||'unknown'),verifiedAt=a[p+'LastNotificationVerifiedAt']||'',endpoint=String(a[p+'CurrentPushEndpoint']||''),active=a[p+'PushSubscriptionActive'];
  return {permission,verifiedAt,endpoint,pushSubscriptionActive:typeof active==='boolean'?active:null,pushSubscriptionState:String(a[p+'PushSubscriptionState']||'unknown'),pushPermissionState:String(a[p+'PushPermissionState']||'unknown'),permissionsApiState:String(a[p+'PermissionsApiState']||'unknown'),context:cap.toLowerCase()};
}
function notificationStateForPushAuthority(pushRow={},a={}){
  const context=pushClientContext(pushRow),ctx=activityNotificationContext(a,context),endpoint=String(pushRow.endpoint||''),endpointMatches=!!endpoint&&!!ctx.endpoint&&endpoint===ctx.endpoint,permission=(endpointMatches&&ctx.permission!=='unknown')?ctx.permission:String(pushRow.notificationPermission||'granted'),verifiedAt=(endpointMatches&&ctx.verifiedAt)||pushRow.subscriptionVerifiedAt||pushRow.currentVerifiedAt||'',lastAck=pushRow.lastPushDeviceAckAt||'',lastPermanent=pushRow.lastPushPermanentInvalidAt||pushRow.permanentInvalidAt||'',estimatedClosedAt=pushRow.deliveryHealthEstimatedAt||'';
  return deviceNotificationState({...a,notificationPermission:permission,permission,notificationSupported:true,pushSubscriptionActive:true,pushSubscriptionState:'active',lastNotificationVerifiedAt:verifiedAt,lastPushDeviceAckAt:lastAck,lastPushPermanentInvalidAt:lastPermanent,estimatedNotificationClosedAt:estimatedClosedAt,estimatedAppRemovedAt:null,deliveryHealthEstimatedAt:null,notificationPromptChoice:'',notificationUserPreference:permission==='granted'?'on':'unknown'},true);
}
function notificationFallbackAuthorityState(activities=[]){
  const candidates=[];for(const a of (activities||[])){for(const context of ['pwa','browser']){const x=activityNotificationContext(a,context),at=evidenceTime(x.verifiedAt);if(at&&(x.permission==='denied'||x.permission==='granted'))candidates.push({a,x,at})}if(!candidates.some(c=>c.a===a)){const at=evidenceTime(a.lastNotificationVerifiedAt);if(at)candidates.push({a,x:{permission:String(a.notificationPermission||a.permission||'unknown'),verifiedAt:a.lastNotificationVerifiedAt,pushSubscriptionActive:a.pushSubscriptionActive===true,pushSubscriptionState:String(a.pushSubscriptionState||'unknown')},at})}}
  const best=candidates.sort((a,b)=>b.at-a.at)[0];if(!best)return {summary:'Doğrulanamadı',detail:'Henüz cihazdan doğrulanmış bildirim durumu yok.',permission:'unknown',pushSubscription:'unknown',evidence:'stale_unknown'};return deviceNotificationState({...best.a,notificationPermission:best.x.permission,permission:best.x.permission,lastNotificationVerifiedAt:best.x.verifiedAt,pushSubscriptionActive:best.x.pushSubscriptionActive===true,pushSubscriptionState:best.x.pushSubscriptionState},best.x.pushSubscriptionActive===true);
}
function pwaAuthorityEvidenceAt(a={},pushRows=[]){const pwaPush=(pushRows||[]).filter(x=>pushClientContext(x)==='pwa'),positive=Math.max(evidenceTime(a.lastPwaInstalledSignalAt),evidenceTime(a.lastPwaStandaloneLaunchAt),evidenceTime(a.installedVerifiedAt),evidenceTime(a.lastPwaPushDeviceAckAt),0,...pwaPush.map(x=>Math.max(evidenceTime(x.pwaObservedAt),evidenceTime(x.subscriptionVerifiedAt),evidenceTime(x.lastPushDeviceAckAt)))),negative=Math.max(0,...pwaPush.map(x=>Math.max(evidenceTime(x.deliveryHealthEstimatedAt),evidenceTime(x.lastPushPermanentInvalidAt||x.permanentInvalidAt))));return Math.max(positive,negative)}
function adminMemberRows(targetUserId=''){
  const allUsers=readJson('users.json',[]),users=(targetUserId?allUsers.filter(u=>String(u.id)===String(targetUserId)):allUsers).filter(u=>!u.deleted),addresses=readJson('addresses.json',[]),orders=readJson('orders.json',[]),coupons=readJson('coupons.json',[]),acts=activityRows(),logins=loginEventRows(),pushRows=readJson('push_subscriptions.json',[]);
  return users.map(u=>{
    const userAddresses=addresses.filter(a=>a.userId===u.id).map(a=>({...a,phone:normalizeAccountPhone(a.phone)||a.phone||'',extraPhone:normalizeAccountPhone(a.extraPhone)||a.extraPhone||''}));
    const primary=userAddresses.find(a=>a.isDefault)||userAddresses[0]||{},userCoupons=coupons.filter(c=>c.userId===u.id).map(c=>({...c}));
    const ua=acts.filter(x=>x.userId===u.id||x.customerId===u.customerId),userPush=pushRows.filter(x=>x.userId===u.id||x.customerId===u.customerId),userLogins=logins.filter(x=>x.userId===u.id).sort((a,b)=>new Date(a.serverTimestamp||a.at||0)-new Date(b.serverTimestamp||b.at||0));
    const deviceMap=new Map();for(const a of ua){const key=a.deviceId||('activity:'+a.id);deviceMap.set(key,{...a,_activityRow:true})}for(const p of userPush){const key=p.deviceId||('push:'+p.id),current=deviceMap.get(key)||{deviceId:p.deviceId||'',userAgent:p.userAgent||'',notificationPermission:'unknown',notificationSupported:true,_activityRow:false};current.userAgent=current.userAgent||p.userAgent||'';current._hasPushRow=true;deviceMap.set(key,current)}
    const devices=[...deviceMap.entries()].map(([key,a],index)=>{
      const matchingPush=userPush.filter(x=>(a.deviceId&&x.deviceId===a.deviceId)||(!a.deviceId&&key==='push:'+x.id)),activePush=matchingPush.filter(x=>pushRecordActive(x)&&pushRecordCurrentRelevant(x)),pres=devicePresenceSnapshot(a.deviceId,a),lastPushAcceptedAt=latestIso(matchingPush.map(x=>x.lastPushAcceptedAt||x.lastPushSuccessAt)),lastPushDeviceAckAt=latestIso([a.lastPushDeviceAckAt,...matchingPush.map(x=>x.lastPushDeviceAckAt)]),lastPushPermanentInvalidAt=latestIso(matchingPush.map(x=>x.lastPushPermanentInvalidAt||x.permanentInvalidAt)),state=deviceNotificationState({...a,lastPushDeviceAckAt,lastPushPermanentInvalidAt},activePush.length>0),pwaState=devicePwaState(a,matchingPush),latestPush=[...matchingPush].sort((x,y)=>evidenceTime(y.lastPushAttemptAt||y.updatedAt)-evidenceTime(x.lastPushAttemptAt||x.updatedAt))[0]||{},currentRelevant=isCurrentRelevantDevice(a,matchingPush),currentEvidenceAt=deviceAuthorityEvidenceAt(a.deviceId,matchingPush,ua),pwaAuthorityAt=pwaAuthorityEvidenceAt(a,matchingPush);
      return {index:index+1,deviceId:a.deviceId||'',platform:a.platform||devicePlatformFromUa(a.userAgent||matchingPush[0]?.userAgent||''),clientContext:a.lastClientContext||a.clientContext||'',appStatus:pwaState.summary,pwaState:pwaState.state,appDetail:pwaState.detail,firstPwaAt:a.firstPwaAt||a.installedVerifiedAt||'',lastPwaAt:a.lastPwaStandaloneLaunchAt||a.lastPwaAt||'',lastPwaInstalledSignalAt:a.lastPwaInstalledSignalAt||a.installedVerifiedAt||'',lastPwaStandaloneLaunchAt:a.lastPwaStandaloneLaunchAt||a.lastPwaAt||'',notificationStatus:state.summary,notificationDetail:state.detail,notificationPermission:state.permission,notificationPromptChoice:a.notificationPromptChoice||'',notificationPromptChoiceAt:a.notificationPromptChoiceAt||null,notificationUserPreference:a.notificationUserPreference||'unknown',permissionsApiState:a.permissionsApiState||'unknown',pushSubscription:state.pushSubscription,lastNotificationVerifiedAt:a.lastNotificationVerifiedAt||null,lastPushAcceptedAt,lastPushDeviceAckAt:lastPushDeviceAckAt||null,lastPushSuccessAt:lastPushAcceptedAt||null,lastPushFailureAt:latestIso(matchingPush.map(x=>x.lastPushFailureAt))||null,lastPushPermanentInvalidAt:lastPushPermanentInvalidAt||a.lastPushPermanentInvalidAt||null,lastPushResult:latestPush.lastPushResult||'',lastPushHttpStatus:latestPush.lastPushHttpStatus??null,lastPushErrorCode:latestPush.lastPushErrorCode||null,pushSubscriptionActive:activePush.length>0,notificationEvidence:state.evidence||'',deliveryHealthState:latestPush.deliveryHealthState||'',deliveryHealthWatchStartedAt:latestPush.deliveryHealthWatchStartedAt||null,deliveryHealthLastCheckAt:latestPush.deliveryHealthLastCheckAt||null,deliveryHealthNextCheckAt:latestPush.deliveryHealthNextCheckAt||null,deliveryHealthWatchDeadlineAt:latestPush.deliveryHealthWatchDeadlineAt||null,deliveryProbeAttempts:Number(latestPush.deliveryProbeAttempts||0),deliveryHealthReason:latestPush.deliveryHealthReason||'',deliveryHealthEstimated:latestPush.deliveryHealthEstimated===true||a.deliveryHealthEstimated===true,deliveryHealthEstimatedAt:latestPush.deliveryHealthEstimatedAt||a.deliveryHealthEstimatedAt||null,aggregateEligible:currentRelevant,deviceRelevance:currentRelevant?'current':'historical',deviceStateGeneration:Math.max(deviceStateGeneration(a),0,...matchingPush.map(deviceStateGeneration)),currentEvidenceAt:currentEvidenceAt?new Date(currentEvidenceAt).toISOString():'',pwaAuthorityAt:pwaAuthorityAt?new Date(pwaAuthorityAt).toISOString():'',lastSeenAt:pres.lastSeenAt||a.lastSeenAt||'',lastOpenAt:a.lastOpenAt||'',lastHeartbeatAt:pres.lastHeartbeatAt||'',presenceStatus:pres.status,online:pres.status==='active',pageVisible:pres.visible,focused:pres.focused,sessionActive:pres.sessionActive,presenceVersion:Number(a.presenceVersion||0),statusVersion:Number(a.statusVersion||0)};
    }).filter(x=>!!normalizeDeviceId(x.deviceId));
    const pushAuthorityRow=latestPushAuthorityRecord(userPush),pushAuthorityDeviceId=normalizeDeviceId(pushAuthorityRow?.deviceId),pushAuthorityActivity=pushAuthorityDeviceId?ua.find(x=>normalizeDeviceId(x.deviceId)===pushAuthorityDeviceId)||{}:{},pushState=pushAuthorityRow?notificationStateForPushAuthority(pushAuthorityRow,pushAuthorityActivity):notificationFallbackAuthorityState(ua);
    const pwaAuthorityDevice=[...devices].filter(x=>evidenceTime(x.pwaAuthorityAt)>0).sort((a,b)=>evidenceTime(b.pwaAuthorityAt)-evidenceTime(a.pwaAuthorityAt))[0]||null,presenceAuthorityDevice=[...devices].filter(x=>x.presenceStatus!=='offline').sort((a,b)=>evidenceTime(b.lastHeartbeatAt||b.lastSeenAt)-evidenceTime(a.lastHeartbeatAt||a.lastSeenAt))[0]||[...devices].sort((a,b)=>evidenceTime(b.lastSeenAt)-evidenceTime(a.lastSeenAt))[0]||null;
    for(const d of devices){d.pushAuthority=!!pushAuthorityDeviceId&&normalizeDeviceId(d.deviceId)===pushAuthorityDeviceId;d.pwaAuthority=!!pwaAuthorityDevice&&normalizeDeviceId(d.deviceId)===normalizeDeviceId(pwaAuthorityDevice.deviceId);d.presenceAuthority=!!presenceAuthorityDevice&&normalizeDeviceId(d.deviceId)===normalizeDeviceId(presenceAuthorityDevice.deviceId)}
    const appStatus=pwaAuthorityDevice?.appStatus||'Tespit Edilemedi',notificationStatus=pushState.summary||'Doğrulanamadı',lastSeenAt=latestIso(devices.map(x=>x.lastSeenAt)),lastOpenAt=latestIso(devices.map(x=>x.lastOpenAt)),lastLoginAt=userLogins.at(-1)?.serverTimestamp||userLogins.at(-1)?.at||'',presenceStatus=devices.some(x=>x.presenceStatus==='active')?'Aktif':devices.some(x=>x.presenceStatus==='background')?'Arka Planda':'Çevrimdışı',pushActive=!!pushAuthorityRow,notificationPermissionGranted=notificationStatus==='Açık',legacyUnboundPushCount=userPush.filter(x=>pushRecordActive(x)&&!normalizeDeviceId(x.deviceId)).length;
    return {id:u.id,customerId:u.customerId,firstName:u.firstName||'',lastName:u.lastName||'',email:u.email||'',phone:normalizeAccountPhone(u.phone)||u.phone||'',extraPhone:primary.extraPhone||'',lastSeenAt,lastOpenAt,lastLoginAt,pwaActive:appStatus==='Yüklü'||appStatus==='Muhtemelen',pwaVerified:appStatus==='Yüklü',pwaProbably:appStatus==='Muhtemelen',appStatus,notificationStatus,notificationPermissionGranted,pushActive,presenceStatus,online:presenceStatus==='Aktif',onlineThresholdMs:PRESENCE_ONLINE_MS,backgroundThresholdMs:PRESENCE_ONLINE_MS,presenceAuthorityDeviceId:presenceAuthorityDevice?.deviceId||'',pushAuthorityDeviceId,pwaAuthorityDeviceId:pwaAuthorityDevice?.deviceId||'',visitCount:userLogins.length,visits:userLogins.map(x=>x.serverTimestamp||x.at),loginEvents:userLogins,devices,legacyUnboundPushCount,birthDate:u.birthDate||'',phoneVerifiedAt:u.phoneVerifiedAt||null,smsMarketingConsent:!!u.smsMarketingConsent,emailMarketingConsent:!!u.emailMarketingConsent,disabled:!!u.disabled,disabledAt:u.disabledAt||null,deleted:!!u.deleted,deletedAt:u.deletedAt||null,authProviders:Array.isArray(u.authProviders)?u.authProviders:(u.passwordHash?['password']:[]),createdAt:u.createdAt||'',addressCount:userAddresses.length,orderCount:orders.filter(o=>o.userId===u.id||o.customerId===u.customerId).length,couponCount:userCoupons.length,coupons:userCoupons,profileChangeHistory:Array.isArray(u.profileChangeHistory)?u.profileChangeHistory:[],province:primary.province||'',district:primary.district||'',address:[primary.neighborhood,primary.avenue,primary.street,primary.fullAddress,primary.buildingNo?`Bina ${primary.buildingNo}`:'',primary.floor?`Kat ${primary.floor}`:'',primary.doorNo?`Daire ${primary.doorNo}`:''].filter(Boolean).join(' · '),addresses:userAddresses,stateVersion:adminMemberStateSequence};
  });
}
function filterAdminMembers(rows,q={}){
  const search=String(q.search||'').trim().toLocaleLowerCase('tr-TR'),province=String(q.province||'').trim().toLocaleLowerCase('tr-TR'),district=String(q.district||'').trim().toLocaleLowerCase('tr-TR'),sms=String(q.sms||''),emailMarketing=String(q.emailMarketing||''),provider=String(q.provider||'').trim().toLowerCase(),status=String(q.status||'').trim().toLowerCase(),coupon=String(q.coupon||''),online=String(q.online||''),appState=String(q.app||''),notification=String(q.notification||''),push=String(q.push||''),dateFrom=String(q.dateFrom||'').trim(),dateTo=String(q.dateTo||'').trim();
  const fromTs=dateFrom?new Date(dateFrom+'T00:00:00').getTime():0,toTs=dateTo?new Date(dateTo+'T23:59:59.999').getTime():0;
  let out=rows.filter(u=>{const hay=[u.firstName,u.lastName,u.email,u.phone,u.province,u.district,u.address].join(' ').toLocaleLowerCase('tr-TR'),providers=(u.authProviders||[]).map(x=>String(x).toLowerCase()),createdTs=new Date(u.createdAt||0).getTime();return (!search||hay.includes(search))&&(!province||String(u.province||'').toLocaleLowerCase('tr-TR')===province)&&(!district||String(u.district||'').toLocaleLowerCase('tr-TR')===district)&&(!sms||String(!!u.smsMarketingConsent)===sms)&&(!emailMarketing||String(!!u.emailMarketingConsent)===emailMarketing)&&(!provider||providers.includes(provider))&&(!coupon||(coupon==='yes'?Number(u.couponCount||0)>0:Number(u.couponCount||0)===0))&&(!status||(status==='active'?!u.disabled&&!u.deleted:status==='disabled'?u.disabled&&!u.deleted:status==='deleted'?!!u.deleted:true))&&(!online||(online==='Çevrimiçi'?u.presenceStatus==='Aktif':online==='Çevrimdışı'?u.presenceStatus!=='Aktif':String(u.presenceStatus||'').toLocaleLowerCase('tr-TR')===online.toLocaleLowerCase('tr-TR')))&&(!appState||(appState==='installed'?u.pwaVerified:appState==='probably'?u.pwaProbably:appState==='invalid'?u.appStatus==='Yüklü Değil':appState==='unknown'?u.appStatus==='Tespit Edilemedi':true))&&(!notification||(notification==='open'?u.notificationPermissionGranted:notification==='closed'?!u.notificationPermissionGranted:true))&&(!push||(push==='active'?u.pushActive:!u.pushActive))&&(!fromTs||createdTs>=fromTs)&&(!toTs||createdTs<=toTs)});
  const sort=String(q.sort||'newest'),name=x=>`${x.firstName||''} ${x.lastName||''}`.trim();
  out.sort((a,b)=>{switch(sort){case'oldest':return new Date(a.createdAt||0)-new Date(b.createdAt||0);case'lastSeenDesc':return new Date(b.lastLoginAt||0)-new Date(a.lastLoginAt||0);case'lastSeenAsc':return new Date(a.lastLoginAt||0)-new Date(b.lastLoginAt||0);case'nameAsc':case'name':return name(a).localeCompare(name(b),'tr');case'nameDesc':return name(b).localeCompare(name(a),'tr');case'ordersDesc':case'orders':return Number(b.orderCount||0)-Number(a.orderCount||0);case'ordersAsc':return Number(a.orderCount||0)-Number(b.orderCount||0);case'couponsDesc':return Number(b.couponCount||0)-Number(a.couponCount||0);case'couponsAsc':return Number(a.couponCount||0)-Number(b.couponCount||0);case'province':return `${a.province} ${a.district}`.localeCompare(`${b.province} ${b.district}`,'tr');default:return new Date(b.createdAt||0)-new Date(a.createdAt||0)}});
  return out;
}
function memberSummary(rows=adminMemberRows()){
  const activeNow=rows.filter(x=>x.presenceStatus==='Aktif').length,backgroundNow=rows.filter(x=>x.presenceStatus==='Arka Planda').length;
  return {totalMembers:rows.length,pwaInstalledVerified:rows.filter(x=>x.pwaVerified).length,pwaProbablyInstalled:rows.filter(x=>!x.pwaVerified&&x.pwaProbably).length,activeNow,backgroundNow,notificationPermissionGranted:rows.filter(x=>x.notificationPermissionGranted).length,pushActive:rows.filter(x=>x.pushActive).length,smsConsentGranted:rows.filter(x=>x.smsMarketingConsent).length,emailConsentGranted:rows.filter(x=>x.emailMarketingConsent).length,serverTime:new Date().toISOString(),version:adminMemberStateSequence};
}
function memberFilterLocations(rows=adminMemberRows()){const provinces={};for(const r of rows){if(!r.province)continue;(provinces[r.province]??=new Set());if(r.district)provinces[r.province].add(r.district)}return Object.fromEntries(Object.entries(provinces).sort((a,b)=>a[0].localeCompare(b[0],'tr')).map(([k,v])=>[k,[...v].sort((a,b)=>a.localeCompare(b,'tr'))]))}
app.get('/api/admin/users',requireAdmin,(req,res)=>{res.setHeader('Cache-Control','no-store');const all=adminMemberRows(),users=filterAdminMembers(all,req.query);res.json({ok:true,users,total:all.length,filteredTotal:users.length,serverTime:new Date().toISOString(),version:adminMemberStateSequence})});
app.get('/api/admin/users/summary',requireAdmin,(req,res)=>{res.setHeader('Cache-Control','no-store');res.json({ok:true,summary:memberSummary(),locations:memberFilterLocations()})});
app.get('/api/admin/users/ids',requireAdmin,(req,res)=>{res.setHeader('Cache-Control','no-store');res.json({ok:true,ids:filterAdminMembers(adminMemberRows(),req.query).map(x=>x.id),version:adminMemberStateSequence})});
app.get('/api/admin/users/export.xlsx',requireAdmin,(req,res)=>{
  const selectedIds=[...new Set(String(req.query.selectedIds||'').split(',').map(x=>x.trim()).filter(Boolean))];
  const sourceRows=selectedIds.length?adminMemberRows().filter(u=>selectedIds.includes(String(u.id))):filterAdminMembers(adminMemberRows(),req.query);
  const rows=sourceRows.map(u=>({
    'Ad Soyad':[u.firstName,u.lastName].filter(Boolean).join(' '),'Telefon':u.phone,'E-posta':u.email,'Doğum Tarihi':u.birthDate,'İl':u.province,'İlçe':u.district,'Adres':u.address,'Tüm Adresler':(u.addresses||[]).map(a=>[a.title,a.fullName,a.phone,a.province,a.district,a.neighborhood,a.avenue,a.street,a.fullAddress,a.buildingNo?`Bina ${a.buildingNo}`:'',a.floor?`Kat ${a.floor}`:'',a.doorNo?`Daire ${a.doorNo}`:''].filter(Boolean).join(' · ')).join(' | '),'Toplam Sipariş':u.orderCount,'Üyelik Tarihi':u.createdAt,'SMS İzni':u.smsMarketingConsent?'Açık':'Kapalı','E-posta İzni':u.emailMarketingConsent?'Açık':'Kapalı','Giriş Yöntemi':(u.authProviders||[]).join(', '),'Üyelik Durumu':u.deleted||u.disabled?'Silinmiş':'Mevcut'
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

function whatsappTemplates(){return readJson('whatsapp_templates.json',[]).filter(x=>x&&x.isActive!==false)}
function whatsappAdminPreferenceKey(){return String(ADMIN_USER||'admin').slice(0,120)}
function whatsappAdminPreferences(){return readJson('admin_preferences.json',{})}
function validateWhatsappTemplateInput(body={}){const type=String(body.type||'TEXT').toUpperCase(),title=String(body.title||'').trim().slice(0,120),text=String(body.text||'').trim().slice(0,4000),mediaUrl=String(body.mediaUrl||'').trim().slice(0,2000),mediaType=String(body.mediaType||'').toLowerCase();if(!['TEXT','IMAGE','VIDEO','TEXT_IMAGE','TEXT_VIDEO'].includes(type))return {error:'Geçersiz hazır mesaj tipi.'};if(!title)return {error:'Hazır mesaj başlığı zorunludur.'};const needsText=['TEXT','TEXT_IMAGE','TEXT_VIDEO'].includes(type),needsMedia=['IMAGE','VIDEO','TEXT_IMAGE','TEXT_VIDEO'].includes(type);if(needsText&&!text)return {error:'Bu hazır mesaj tipi için mesaj metni zorunludur.'};if(needsMedia&&!mediaUrl)return {error:'Bu hazır mesaj tipi için fotoğraf/video zorunludur.'};if(['IMAGE','TEXT_IMAGE'].includes(type)&&mediaType&&mediaType!=='image')return {error:'Bu hazır mesaj tipi fotoğraf gerektirir.'};if(['VIDEO','TEXT_VIDEO'].includes(type)&&mediaType&&mediaType!=='video')return {error:'Bu hazır mesaj tipi video gerektirir.'};return {value:{type,title,text,mediaUrl,mediaType:mediaType||(['VIDEO','TEXT_VIDEO'].includes(type)?'video':needsMedia?'image':'')}}}
app.get('/api/admin/whatsapp/templates',requireAdmin,(req,res)=>{res.setHeader('Cache-Control','no-store');const prefs=whatsappAdminPreferences(),key=whatsappAdminPreferenceKey();res.json({ok:true,templates:whatsappTemplates(),lastTemplateId:prefs[key]?.lastWhatsappTemplateId||'',providerMode:'desktop'})});
app.post('/api/admin/whatsapp/templates',requireAdmin,sameOriginGuard,(req,res)=>{const parsed=validateWhatsappTemplateInput(req.body||{});if(parsed.error)return res.status(400).json({ok:false,message:parsed.error});const rows=readJson('whatsapp_templates.json',[]),now=new Date().toISOString(),row={id:'WAT-'+crypto.randomUUID(),...parsed.value,createdAt:now,updatedAt:now,isActive:true,createdBy:whatsappAdminPreferenceKey()};rows.push(row);writeJson('whatsapp_templates.json',rows);persistAccountStateAsync();res.json({ok:true,template:row})});
app.delete('/api/admin/whatsapp/templates/:id',requireAdmin,sameOriginGuard,(req,res)=>{const rows=readJson('whatsapp_templates.json',[]),i=rows.findIndex(x=>x.id===req.params.id&&x.isActive!==false);if(i<0)return res.status(404).json({ok:false,message:'Hazır mesaj bulunamadı.'});rows[i].isActive=false;rows[i].updatedAt=new Date().toISOString();writeJson('whatsapp_templates.json',rows);persistAccountStateAsync();res.json({ok:true})});
app.post('/api/admin/whatsapp/media',requireAdmin,sameOriginGuard,whatsappMediaUpload.single('file'),async(req,res)=>{try{const f=req.file;if(!f)return res.status(400).json({ok:false,message:'Dosya seçilmedi.'});const type=String(f.mimetype||'').startsWith('video/')?'video':'image',url='/uploads/'+f.filename;if(githubEnabled()){try{await githubCommitFiles([{path:`uploads/${f.filename}`,content:fs.readFileSync(f.path).toString('base64'),encoding:'base64'}],`SHAZ panel: WhatsApp hazır mesaj medyası eklendi`)}catch(e){console.error('WhatsApp medya kalıcı kayıt:',e.message)}}res.json({ok:true,url,mediaType:type,name:f.originalname})}catch(e){res.status(500).json({ok:false,message:e.message||'Medya yüklenemedi.'})}});
app.put('/api/admin/whatsapp/preference',requireAdmin,sameOriginGuard,(req,res)=>{const id=String(req.body?.lastTemplateId||''),prefs=whatsappAdminPreferences(),key=whatsappAdminPreferenceKey();prefs[key]={...(prefs[key]||{}),lastWhatsappTemplateId:id,updatedAt:new Date().toISOString()};writeJson('admin_preferences.json',prefs);persistAccountStateAsync();res.json({ok:true})});
app.post('/api/admin/whatsapp/opened',requireAdmin,sameOriginGuard,(req,res)=>{const customerId=String(req.body?.customerId||''),userId=String(req.body?.userId||''),templateId=String(req.body?.templateId||''),mode=String(req.body?.mode||'desktop'),rows=activityRows(),now=new Date().toISOString();let r=rows.find(x=>(userId&&x.userId===userId)||(customerId&&x.customerId===customerId));if(!r){r={id:'ACT-'+crypto.randomUUID(),deviceId:'ADMIN-WHATSAPP-'+crypto.randomUUID(),userId:userId||null,customerId:customerId||null,visits:[],createdAt:now};rows.push(r)}r.whatsappEvents=Array.isArray(r.whatsappEvents)?r.whatsappEvents:[];r.whatsappEvents.push({id:'WAL-'+crypto.randomUUID(),templateId:templateId||null,adminId:whatsappAdminPreferenceKey(),mode,provider:mode==='cloud_api'?'whatsapp_business_platform':'desktop_deep_link',status:mode==='cloud_api'?'queued':'opened',openedAt:mode==='desktop'?now:null,createdAt:now});r.whatsappEvents=r.whatsappEvents.slice(-500);r.updatedAt=now;writeJson('customer_activity.json',rows);persistAccountStateAsync();res.json({ok:true,status:mode==='desktop'?'opened':'queued'})});
app.post('/api/admin/users/:id/cancel',requireAdmin,async(req,res)=>serializedMutation('accounts',async()=>{
  const users=readJson('users.json',[]),i=users.findIndex(u=>String(u.id)===String(req.params.id));if(i<0)return res.status(404).json({ok:false,message:'Üye bulunamadı.'});
  const u=users[i];if(u.disabled)return res.json({ok:true,alreadyDisabled:true});const now=new Date().toISOString();pushProfileHistory(u,'Üyelik Durumu','Mevcut','Silinmiş','admin');u.disabled=true;u.disabledAt=now;u.updatedAt=now;u.authVersion=Number(u.authVersion||1)+1;writeJson('users.json',users);
  await persistAccountStateToGithub().catch(e=>{console.error('Üyelik iptal kalıcı kayıt:',e);throw e});return res.json({ok:true});
}));
app.post('/api/admin/users/:id/reactivate',requireAdmin,async(req,res)=>serializedMutation('accounts',async()=>{
  const users=readJson('users.json',[]),i=users.findIndex(u=>String(u.id)===String(req.params.id));if(i<0)return res.status(404).json({ok:false,message:'Üye bulunamadı.'});
  const u=users[i],email=normalizeEmail(u.email),phone=normalizeAccountPhone(u.phone),conflict=users.find(x=>x.id!==u.id&&!x.deleted&&((email&&normalizeEmail(x.email)===email)||(phone&&normalizeAccountPhone(x.phone)===phone)));if(conflict)return res.status(409).json({ok:false,message:'Aynı e-posta veya telefonla aktif başka bir hesap bulunduğu için bu eski kayıt yeniden açılamaz.'});
  const now=new Date().toISOString(),oldStatus=u.deleted||u.disabled?'Silinmiş':'Mevcut';pushProfileHistory(u,'Üyelik Durumu',oldStatus,'Mevcut','admin');u.disabled=false;u.disabledAt=null;u.deleted=false;u.deletedAt=null;u.updatedAt=now;u.authVersion=Number(u.authVersion||1)+1;writeJson('users.json',users);
  const customers=readJson('customers.json',[]);if(!customers.some(c=>c.id===u.customerId||c.userId===u.id))customers.push({id:u.customerId||('CUS-'+crypto.randomUUID()),userId:u.id,firstName:u.firstName||'',lastName:u.lastName||'',email:u.email||'',phone:u.phone||'',createdAt:u.createdAt||now,updatedAt:now});writeJson('customers.json',customers);
  await persistAccountStateToGithub().catch(e=>{console.error('Üye yeniden açma kalıcı kayıt:',e);throw e});return res.json({ok:true});
}));
app.delete('/api/admin/users/:id',requireAdmin,async(req,res)=>serializedMutation('accounts',async()=>{
  const id=String(req.params.id),users=readJson('users.json',[]),i=users.findIndex(x=>String(x.id)===id);if(i<0)return res.status(404).json({ok:false,message:'Üye bulunamadı.'});
  const u=users[i],now=new Date().toISOString();if(!u.deleted)pushProfileHistory(u,'Üyelik Durumu',u.disabled?'Silinmiş':'Mevcut','Silinmiş','admin');u.deleted=true;u.deletedAt=now;u.disabled=true;u.disabledAt=u.disabledAt||now;u.updatedAt=now;u.authVersion=Number(u.authVersion||1)+1;writeJson('users.json',users);
  writeJson('customers.json',readJson('customers.json',[]).filter(x=>x.id!==u.customerId&&x.userId!==u.id));for(const f of ['addresses.json','favorites.json','coupons.json'])writeJson(f,readJson(f,[]).filter(x=>x.userId!==u.id));const integrationJobs=readJson('integration_outbox.json',[]);for(const j of integrationJobs)if(j.userId===u.id&&['pending','failed','unknown','processing'].includes(j.status)){j.status='cancelled';j.lastError='Kullanıcı hesabı pasif/silinmiş.';j.updatedAt=integrationNow()}writeJson('integration_outbox.json',integrationJobs);writeJson('push_subscriptions.json',readJson('push_subscriptions.json',[]).filter(x=>x.userId!==u.id&&x.customerId!==u.customerId));writeJson('customer_activity.json',readJson('customer_activity.json',[]).filter(x=>x.userId!==u.id&&x.customerId!==u.customerId));writeJson('login_events.json',readJson('login_events.json',[]).filter(x=>x.userId!==u.id&&x.customerId!==u.customerId));
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
const PRESENCE_HEARTBEAT_MS=10000;
const PRESENCE_ONLINE_MS=45000;
const PRESENCE_TAB_RETENTION_MS=10*60*1000;
const presenceTabs=new Map();
const adminActivityStreams=new Set();
let adminMemberStateSequence=0;
function activityRows(){return readJson('customer_activity.json',[])}
function loginEventRows(){return readJson('login_events.json',[])}
function devicePlatformFromUa(ua=''){const x=String(ua);if(/iPhone|iPad|iPod/i.test(x)||(/Macintosh/i.test(x)&&/Mobile/i.test(x)))return 'iPhone / iOS';if(/Android/i.test(x))return 'Android';if(/Windows/i.test(x))return 'Windows';if(/Macintosh|Mac OS X/i.test(x))return 'Mac';return 'Diğer'}
function mobileUa(ua=''){return /iPhone|iPad|iPod|Android|Mobile/i.test(String(ua))}
function prunePresenceTabs(now=Date.now()){for(const [k,v] of presenceTabs)if(now-Number(v.receivedAtMs||0)>PRESENCE_TAB_RETENTION_MS)presenceTabs.delete(k)}
function expireStalePresenceTabs(now=Date.now()){const affectedUsers=new Set();for(const [k,v] of presenceTabs){if(v.sessionActive!==true||now-Number(v.receivedAtMs||0)<=PRESENCE_ONLINE_MS)continue;v.sessionActive=false;v.visible=false;v.focused=false;v.presenceState='offline';v.serverVersion=Number(v.serverVersion||0)+1;presenceTabs.set(k,v);if(v.userId)affectedUsers.add(v.userId)}prunePresenceTabs(now);for(const uid of affectedUsers)publishAdminMemberUpdate(uid,'presence-expired');return affectedUsers.size}
function devicePresenceSnapshot(deviceId,a={},now=Date.now()){prunePresenceTabs(now);const tabs=[...presenceTabs.values()].filter(x=>x.deviceId===deviceId&&(!a.userId||!x.userId||x.userId===a.userId)),recent=tabs.filter(x=>x.sessionActive===true&&now-Number(x.receivedAtMs||0)<=PRESENCE_ONLINE_MS),active=recent.filter(x=>x.visible===true&&(x.mobile===true||x.focused===true)&&x.presenceState!=='background'),background=recent.filter(x=>x.presenceState==='background'||!(x.visible===true&&(x.mobile===true||x.focused===true))),latest=([...tabs].sort((x,y)=>Number(y.receivedAtMs||0)-Number(x.receivedAtMs||0))[0]||null);return {status:active.length?'active':background.length?'background':'offline',sessionActive:!!(active.length||background.length),visible:!!active.some(x=>x.visible===true),focused:!!active.some(x=>x.focused===true),lastHeartbeatAt:latest?.serverReceivedAt||'',lastSeenAt:latest?.serverReceivedAt||a.lastSeenAt||''}}
function deviceNotificationState(a={},hasPush=false){
  const permission=String(a.notificationPermission||a.permission||'unknown'),pushState=String(a.pushSubscriptionState||(a.pushSubscriptionActive===true?'active':a.pushSubscriptionActive===false?'missing':'unknown')),preference=String(a.notificationUserPreference||'unknown'),choice=String(a.notificationPromptChoice||''),verifiedAt=evidenceTime(a.lastNotificationVerifiedAt),ackAt=evidenceTime(a.lastPushDeviceAckAt),choiceAt=evidenceTime(a.notificationPromptChoiceAt),now=Date.now(),freshMs=45*24*60*60*1000,verificationFresh=verifiedAt>0&&now-verifiedAt<=freshMs;
  const base={permission,pushSubscription:pushState,evidence:'stale_unknown'},estimatedAt=evidenceTime(a.estimatedNotificationClosedAt||(a.estimatedAppRemovedAt?null:a.deliveryHealthEstimatedAt)),permanentAt=evidenceTime(a.lastPushPermanentInvalidAt),positiveAt=Math.max(verifiedAt,ackAt);
  if(a.notificationSupported===false||permission==='unsupported')return {...base,summary:'Desteklenmiyor',detail:'Bu cihaz Web Push bildirimlerini desteklemiyor.',permission:'unsupported',pushSubscription:'unknown',evidence:'unsupported'};
  if(estimatedAt>positiveAt)return {...base,summary:'Kapalı',detail:'Normal kabul edilen push için doğrulama süresi boyunca gerçek device ACK alınmadı; operasyonel kural gereği bildirim kapalı sayıldı.',evidence:'12h_no_delivery_evidence'};
  if(permanentAt>positiveAt)return {...base,summary:'Kapalı',detail:`Push aboneliği kalıcı geçersiz oldu. Son permanent invalid: ${a.lastPushPermanentInvalidAt||'—'}`,pushSubscription:'invalid',evidence:'push_permanent_invalid'};
  const openVerification=permission==='granted'&&pushState==='active'&&hasPush?verifiedAt:0;
  if(permission==='denied')return {...base,summary:'Kapalı',detail:`Bildirim izni cihaz tarafından kapalı doğrulandı. Son doğrulama: ${a.lastNotificationVerifiedAt||'—'}`,evidence:'foreground_permission'};
  if((preference==='off'||choice==='declined')&&choiceAt>0&&openVerification<=choiceAt)return {...base,summary:'Kapalı',detail:`SHAZ bildirim isteği kullanıcı tarafından reddedildi. Tercih zamanı: ${a.notificationPromptChoiceAt||'—'}`,evidence:'prompt_declined'};
  if(ackAt>0&&hasPush)return {...base,summary:'Açık',detail:`Push kanalı cihaz ACK'i ile doğrulandı. Son ACK: ${a.lastPushDeviceAckAt||'—'}${a.lastNotificationVerifiedAt?` · Son izin doğrulaması: ${a.lastNotificationVerifiedAt}`:''}`,pushSubscription:'active',evidence:'device_ack'};
  if(permission==='granted'&&pushState==='active'&&hasPush&&verificationFresh)return {...base,summary:'Açık',detail:`Cihaz tarafından izin ve push aboneliği doğrulandı. Son doğrulama: ${a.lastNotificationVerifiedAt||'—'}`,pushSubscription:'active',evidence:'foreground_permission'};
  if(permission==='granted'&&pushState==='active'&&hasPush&&!verificationFresh)return {...base,summary:'Doğrulanamadı',detail:`Web izni ve abonelik daha önce açık doğrulandı ancak son kesin doğrulama eski: ${a.lastNotificationVerifiedAt||'—'}.`,pushSubscription:'active',evidence:'stale_unknown'};
  if(permission==='granted'&&pushState!=='active')return {...base,summary:'Kapalı',detail:`Bildirim izni açık fakat doğrulanmış aktif push aboneliği bulunamadı. Abonelik yeniden oluşturulamazsa operasyonel olarak kapalı kabul edilir. Son doğrulama: ${a.lastNotificationVerifiedAt||'—'}`,pushSubscription:pushState==='invalid'?'invalid':'missing',evidence:'subscription_missing'};
  if(permission==='default'&&(preference==='off'||choice==='declined'))return {...base,summary:'Kapalı',detail:`SHAZ bildirim isteği kullanıcı tarafından reddedildi${a.notificationPromptChoiceAt?`. Tercih zamanı: ${a.notificationPromptChoiceAt}`:''}.`,evidence:'prompt_declined'};
  return {...base,summary:'Doğrulanamadı',detail:a.lastNotificationVerifiedAt?`Son kesin bildirim durumu güncel olarak doğrulanamadı. Son doğrulama: ${a.lastNotificationVerifiedAt}`:'Henüz cihazdan doğrulanmış bildirim durumu yok.'};
}
function aggregateNotificationStatus(devices=[]){
  const states=(devices||[]).filter(x=>x&&x.aggregateEligible!==false).map(x=>String(x.notificationStatus||'Doğrulanamadı'));
  if(!states.length)return 'Doğrulanamadı';
  const meaningful=states.filter(x=>x!=='Desteklenmiyor');if(!meaningful.length)return 'Desteklenmiyor';
  const set=new Set(meaningful);
  if(set.size===1)return meaningful[0];
  if(set.has('Doğrulanamadı'))return 'Doğrulanamadı';
  if(set.has('Açık')&&set.has('Kapalı'))return 'Karışık';
  if(set.has('Açık')||set.has('Kapalı')||set.has('Abonelik eksik'))return 'Karışık';
  return 'Doğrulanamadı';
}
function evidenceTime(v){const t=new Date(v||0).getTime();return Number.isFinite(t)?t:0}
function devicePwaState(a={},pushRows=[]){
  const platform=String(a.platform||devicePlatformFromUa(a.userAgent||pushRows[0]?.userAgent||'')),pwaRows=pushRows.filter(x=>pushClientContext(x)==='pwa'&&(!x.deviceStateGeneration||x.deviceStateGeneration===CURRENT_DEVICE_STATE_GENERATION)),trustedPushRows=pwaRows.filter(pushRecordCurrentRelevant),hasRealPwaDevice=trustedPushRows.length>0||evidenceTime(a.lastPwaInstalledSignalAt)>0||evidenceTime(a.lastPwaStandaloneLaunchAt)>0||evidenceTime(a.installedVerifiedAt)>0,pwaDeviceAck=Math.max(evidenceTime(a.lastPwaPushDeviceAckAt),0,...pwaRows.map(x=>evidenceTime(x.lastPushDeviceAckAt))),standaloneSubscribe=Math.max(0,...trustedPushRows.map(x=>evidenceTime(x.pwaObservedAt||x.subscriptionVerifiedAt||x.updatedAt)));
  const strong=hasRealPwaDevice?Math.max(evidenceTime(a.lastPwaInstalledSignalAt),evidenceTime(a.lastPwaStandaloneLaunchAt),evidenceTime(a.installedVerifiedAt),standaloneSubscribe,pwaDeviceAck):0;
  const legacyPositive=Math.max(evidenceTime(a.lastPwaAt),evidenceTime(a.firstPwaAt));
  const permanent=Math.max(0,...pwaRows.map(x=>evidenceTime(x.lastPushPermanentInvalidAt||x.permanentInvalidAt)));
  const estimated=Math.max(0,...pwaRows.map(x=>evidenceTime(x.deliveryHealthEstimatedAt))),now=Date.now(),freshStrong=strong>0&&now-strong<=7*24*60*60*1000;
  if(strong>Math.max(permanent,estimated)&&freshStrong)return {state:'VERIFIED_INSTALLED',summary:'Yüklü',detail:`Son kesin PWA doğrulaması: ${new Date(strong).toISOString()}`};
  if(estimated>strong)return {state:'OPERATIONALLY_NOT_INSTALLED',summary:'Yüklü Değil',detail:'PWA push cihazı için doğrulama süresi boyunca gerçek device ACK alınmadığı için operasyonel olarak yüklü değil sayıldı.'};
  if(permanent>strong&&permanent>0&&pwaRows.length>0&&!pwaRows.some(pushRecordActive))return {state:'OPERATIONALLY_NOT_INSTALLED',summary:'Yüklü Değil',detail:`PWA push aboneliği ${new Date(permanent).toISOString()} tarihinde kalıcı geçersiz oldu; operasyonel kural gereği uygulama yüklü değil sayıldı.`};
  if(strong>0||legacyPositive>0)return {state:'PROBABLY_INSTALLED',summary:'Muhtemelen',detail:`Daha önce PWA sinyali görüldü ancak güncel kurulum kesin olarak doğrulanamıyor. Son güçlü sinyal: ${strong?new Date(strong).toISOString():new Date(legacyPositive).toISOString()}`};
  return {state:'UNKNOWN',summary:'Tespit Edilemedi',detail:'Standalone/appinstalled/PWA subscription ACK gibi güçlü PWA kurulum kanıtı bulunamadı.'};
}
function normalizeVisitSessionId(value){const id=String(value||'').trim();return /^[A-Za-z0-9._:-]{8,160}$/.test(id)?id:''}
function accountSessionIdFromReq(req){try{const token=parseCookies(req)[USER_SESSION_COOKIE];if(!token)return '';const [payload,sig]=token.split('.');if(!payload||!sig)return '';const exp=crypto.createHmac('sha256',USER_SESSION_SECRET).update(payload).digest('base64url');if(!safeEqual(sig,exp))return '';const data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));return String(data?.sid||'').slice(0,120)}catch{return ''}}
function recordAccountLogin(req,user,provider='password',transactionId='',sessionId=''){if(!user?.id)return null;const rows=loginEventRows(),tx=String(transactionId||'').trim().slice(0,160),visitSessionId=normalizeVisitSessionId(req.body?.visitSessionId);if(tx){const old=rows.find(x=>x.userId===user.id&&(x.loginEventId===tx||x.transactionId===tx));if(old)return old}if(sessionId){const old=rows.find(x=>x.userId===user.id&&String(x.sessionId||'')===String(sessionId));if(old)return old}const at=new Date().toISOString(),eventId=tx||('LOGIN-'+crypto.randomUUID()),row={id:'LOGIN-'+crypto.randomUUID(),loginEventId:eventId,userId:user.id,customerId:user.customerId||null,sessionId:String(sessionId||'').slice(0,120)||null,visitSessionId:visitSessionId||null,deviceId:normalizeDeviceId(req.body?.deviceId),provider:String(provider||'password').slice(0,40),loginMethod:String(provider||'password').slice(0,40),transactionId:tx||null,userAgent:String(req.headers['user-agent']||'').slice(0,500),serverTimestamp:at,at};rows.push(row);writeJson('login_events.json',rows);publishAdminMemberUpdate(user.id,'login');return row}
function recordAccountVisit(req,user,visitSessionId){visitSessionId=normalizeVisitSessionId(visitSessionId);if(!user?.id||!visitSessionId)return null;const rows=loginEventRows(),old=rows.find(x=>x.userId===user.id&&String(x.visitSessionId||'')===visitSessionId);if(old)return old;const at=new Date().toISOString(),row={id:'VISIT-'+crypto.randomUUID(),loginEventId:'VISIT-'+crypto.randomUUID(),userId:user.id,customerId:user.customerId||null,sessionId:accountSessionIdFromReq(req)||null,visitSessionId,deviceId:normalizeDeviceId(req.query?.deviceId||req.headers['x-shaz-device-id']),provider:'session',loginMethod:'session_visit',transactionId:null,userAgent:String(req.headers['user-agent']||'').slice(0,500),serverTimestamp:at,at};rows.push(row);writeJson('login_events.json',rows);publishAdminMemberUpdate(user.id,'visit');persistAccountStateAsync();return row}
function markDeviceSignedOut(deviceId,userId=''){deviceId=normalizeDeviceId(deviceId);if(!deviceId)return;const now=new Date().toISOString();for(const [k,v] of presenceTabs)if(v.deviceId===deviceId&&(!userId||v.userId===userId)){v.sessionActive=false;v.visible=false;v.focused=false;v.serverReceivedAt=now;v.receivedAtMs=Date.now();v.serverVersion=Number(v.serverVersion||0)+1;presenceTabs.set(k,v)}const rows=activityRows(),r=rows.find(x=>x.deviceId===deviceId&&(!userId||x.userId===userId));if(r){r.lastSeenAt=now;r.signedOutAt=now;r.updatedAt=now;r.presenceVersion=Number(r.presenceVersion||0)+1;writeJson('customer_activity.json',rows)}publishAdminMemberUpdate(userId||r?.userId,'presence')}
function unbindDeviceAccountOwnership(deviceId,userId=''){deviceId=normalizeDeviceId(deviceId);if(!deviceId)return;const now=new Date().toISOString(),acts=activityRows(),a=acts.find(x=>x.deviceId===deviceId&&(!userId||x.userId===userId));if(a){a.previousUserId=a.userId||a.previousUserId||null;a.previousCustomerId=a.customerId||a.previousCustomerId||null;a.userId=null;a.customerId=null;a.updatedAt=now;a.statusVersion=Number(a.statusVersion||0)+1;writeJson('customer_activity.json',acts)}const pushes=readJson('push_subscriptions.json',[]);let changed=false;for(const row of pushes){if(row.deviceId===deviceId&&(!userId||row.userId===userId)){row.previousUserId=row.userId||row.previousUserId||null;row.previousCustomerId=row.customerId||row.previousCustomerId||null;row.userId=null;row.customerId=null;row.updatedAt=now;changed=true}}if(changed)writeJson('push_subscriptions.json',pushes);if(userId)publishAdminMemberUpdate(userId,'logout')}

function notificationDebug(event,data={}){if(process.env.NODE_ENV==='production'&&process.env.SHAZ_NOTIFICATION_DEBUG!=='1')return;console.log('[SHAZ]',event,JSON.stringify({userId:data.userId||null,deviceId:data.deviceId||null,permission:data.permission||undefined,subscriptionState:data.subscriptionState||undefined,timestamp:new Date().toISOString()}))}
function shouldApplyNotificationObservation(verified,incomingObservedMs,currentObservedMs,incomingStateVersion,currentStateVersion){if(verified!==true)return false;if(incomingObservedMs>currentObservedMs)return true;if(incomingObservedMs<currentObservedMs)return false;if(incomingObservedMs>0&&incomingStateVersion>=currentStateVersion)return incomingStateVersion>currentStateVersion;if(currentObservedMs>0)return false;return incomingStateVersion>=currentStateVersion&&incomingStateVersion>currentStateVersion}
function setActivityPushState(deviceId,active,meta={}){deviceId=normalizeDeviceId(deviceId);if(!deviceId)return;const rows=activityRows(),r=rows.find(x=>x.deviceId===deviceId);if(!r)return;const now=meta.at||new Date().toISOString(),before=JSON.stringify([r.pushSubscriptionActive,r.pushSubscriptionState,r.lastPushAcceptedAt,r.lastPushDeviceAckAt,r.lastPushPermanentInvalidAt,r.deviceStateGeneration,r.currentVerifiedAt,r.deviceRelevance,r.deliveryHealthEstimatedAt,r.estimatedAppRemovedAt,r.estimatedNotificationClosedAt]);if(meta.accepted){r.lastPushAcceptedAt=now;r.lastPushSuccessAt=now}if(meta.ack){r.lastPushDeviceAckAt=now;r.lastPushDeliveryVerifiedAt=now;r.pushSubscriptionActive=true;r.pushSubscriptionState='active'}if(meta.permanent)r.lastPushPermanentInvalidAt=now;if(meta.accepted!==true&&meta.ack!==true){r.pushSubscriptionActive=!!active;r.pushSubscriptionState=active?'active':(meta.permanent?'invalid':'missing');r.subscriptionVerifiedAt=meta.verifiedAt||now}if(meta.verifyCurrentGeneration===true||meta.ack===true){r.deviceStateGeneration=CURRENT_DEVICE_STATE_GENERATION;r.currentVerifiedAt=meta.verifiedAt||now;r.deviceRelevance='current'}if(active&&(meta.verifyCurrentGeneration===true||meta.ack===true)){r.deliveryHealthEstimated=false;r.deliveryHealthEstimatedAt=null;r.deliveryHealthReason=null;r.estimatedAppRemovedAt=null;r.estimatedNotificationClosedAt=null;r.deliveryHealthRecoveredAt=meta.verifiedAt||now}const after=JSON.stringify([r.pushSubscriptionActive,r.pushSubscriptionState,r.lastPushAcceptedAt,r.lastPushDeviceAckAt,r.lastPushPermanentInvalidAt,r.deviceStateGeneration,r.currentVerifiedAt,r.deviceRelevance,r.deliveryHealthEstimatedAt,r.estimatedAppRemovedAt,r.estimatedNotificationClosedAt]);if(before===after)return;r.statusVersion=Number(r.statusVersion||0)+1;r.updatedAt=now;writeJson('customer_activity.json',rows);publishAdminMemberUpdate(r.userId,meta.ack?'push-ack':meta.accepted?'push-provider':active?'notification':'pwa')}
function markPushSuperseded(row,at,reason='superseded_endpoint'){if(!row||!pushRecordActive(row))return false;row.pushSubscriptionStatus='INVALID';row.invalidatedAt=at;row.supersededAt=at;row.updatedAt=at;row.lastPushFailureStatus=reason;row.lastPushResult='superseded';return true}
function classifyOwnerLegacyUnbound(rows,current,at){const owner=pushOwnerKey(current);let changed=false;if(!owner)return changed;for(const row of rows){if(row===current||!pushRecordActive(row)||normalizeDeviceId(row.deviceId)||pushOwnerKey(row)!==owner)continue;if(String(row.lifecycle||'').toLowerCase()!=='legacy-unbound'){row.lifecycle='legacy-unbound';row.legacyUnboundAt=row.legacyUnboundAt||at;row.updatedAt=at;changed=true}}return changed}
function reconcileForegroundPushEndpoint({deviceId,user,endpoint,observedAt,pwaStandalone=false,clientContext='browser'}={}){deviceId=normalizeDeviceId(deviceId);endpoint=String(endpoint||'').trim();clientContext=pwaStandalone===true?'pwa':(String(clientContext||'').toLowerCase()==='pwa'?'pwa':'browser');if(!deviceId||!/^https:\/\//i.test(endpoint))return {changed:false,affectedUserIds:[]};const rows=readJson('push_subscriptions.json',[]),at=observedAt||new Date().toISOString(),matches=rows.filter(x=>pushRecordActive(x)&&String(x.endpoint||'')===endpoint).sort((a,b)=>evidenceTime(b.lastPushDeviceAckAt||b.subscriptionVerifiedAt||b.updatedAt)-evidenceTime(a.lastPushDeviceAckAt||a.subscriptionVerifiedAt||a.updatedAt));if(!matches.length)return {changed:false,affectedUserIds:[]};const row=matches.find(x=>!user||!x.userId||String(x.userId)===String(user.id))||matches[0],affected=new Set([row.userId].filter(Boolean)),resolvedContext=pushClientContext(row)==='pwa'&&clientContext==='browser'?'pwa':clientContext;let changed=false;if(row.deviceId!==deviceId){row.deviceId=deviceId;changed=true}if(user&&row.userId!==user.id){if(row.userId)affected.add(row.userId);row.previousUserId=row.userId||row.previousUserId||null;row.userId=user.id;changed=true}if(user&&row.customerId!==user.customerId){row.previousCustomerId=row.customerId||row.previousCustomerId||null;row.customerId=user.customerId||null;changed=true}if(String(row.lifecycle||'')!=='current'){row.lifecycle='current';changed=true}if(String(row.deviceRelevance||'')!=='current'){row.deviceRelevance='current';changed=true}if(pushClientContext(row)!==resolvedContext||String(row.clientContext||'')!==resolvedContext){row.clientContext=resolvedContext;row.pwa=resolvedContext==='pwa';changed=true}if(deviceStateGeneration(row)!==CURRENT_DEVICE_STATE_GENERATION){row.deviceStateGeneration=CURRENT_DEVICE_STATE_GENERATION;changed=true}row.currentVerifiedAt=at;row.currentEndpoint=endpoint;if(row.authoritativeAt!==at){row.authoritativeAt=at;changed=true}if(pwaStandalone===true){if(row.pwa!==true)changed=true;row.pwa=true;row.pwaObservedAt=at}for(const x of rows){if(x===row||!pushRecordActive(x))continue;if(String(x.endpoint||'')===endpoint||(normalizeDeviceId(x.deviceId)===deviceId&&pushClientContext(x)===resolvedContext&&String(x.endpoint||'')!==endpoint)){if(markPushSuperseded(x,at)){changed=true;if(x.userId)affected.add(x.userId)}}}if(classifyOwnerLegacyUnbound(rows,row,at))changed=true;if(changed){row.updatedAt=at;writeJson('push_subscriptions.json',rows)}if(row.userId)affected.add(row.userId);return {changed,row,affectedUserIds:[...affected]}}
function applyPushAckDeviceBinding(pushRows,pushRow,deviceId,requestUser,at){deviceId=normalizeDeviceId(deviceId);if(!pushRow||!pushRecordActive(pushRow))return {bound:false,changed:false,affectedUserIds:[]};const affected=new Set([pushRow.userId].filter(Boolean));let changed=false,ownershipConflict=false;pushRow.lastPushDeviceAckAt=at;pushRow.lastPushDeliveryVerifiedAt=at;pushRow.deliveryHealthState='healthy';pushRow.deliveryHealthResolvedAt=at;pushRow.deliveryHealthResolutionReason='device_ack';pushRow.deliveryHealthNextCheckAt=null;pushRow.deliveryHealthPauseStartedAt=null;pushRow.deliveryHealthEstimated=false;pushRow.deliveryHealthEstimatedAt=null;pushRow.deliveryHealthReason=null;pushRow.updatedAt=at;changed=true;if(!deviceId)return {bound:false,changed,affectedUserIds:[...affected]};const acts=activityRows(),activity=acts.find(x=>normalizeDeviceId(x.deviceId)===deviceId),rowUser=String(pushRow.userId||''),rowCustomer=String(pushRow.customerId||''),requestUserId=String(requestUser?.id||''),requestCustomerId=String(requestUser?.customerId||'');if(requestUserId&&rowUser&&requestUserId!==rowUser)ownershipConflict=true;if(activity&&rowUser&&activity.userId&&String(activity.userId)!==rowUser)ownershipConflict=true;if(activity&&rowCustomer&&activity.customerId&&String(activity.customerId)!==rowCustomer)ownershipConflict=true;const conflictingPush=pushRows.find(x=>x!==pushRow&&pushRecordActive(x)&&normalizeDeviceId(x.deviceId)===deviceId&&((rowUser&&x.userId&&String(x.userId)!==rowUser)||(rowCustomer&&x.customerId&&String(x.customerId)!==rowCustomer)));if(conflictingPush)ownershipConflict=true;if(pushRow.deviceId&&normalizeDeviceId(pushRow.deviceId)!==deviceId)ownershipConflict=true;if(ownershipConflict)return {bound:false,changed,ownershipConflict:true,affectedUserIds:[...affected]};if(!pushRow.deviceId){pushRow.deviceId=deviceId;changed=true}if(!pushRow.userId&&requestUserId){pushRow.userId=requestUserId;pushRow.customerId=requestUser?.customerId||null;affected.add(requestUserId);changed=true}pushRow.lifecycle='current';pushRow.deviceRelevance='current';pushRow.deviceStateGeneration=CURRENT_DEVICE_STATE_GENERATION;pushRow.currentVerifiedAt=at;pushRow.currentEndpoint=String(pushRow.endpoint||'');pushRow.authoritativeAt=at;if(classifyOwnerLegacyUnbound(pushRows,pushRow,at))changed=true;for(const x of pushRows){if(x===pushRow||!pushRecordActive(x))continue;if(normalizeDeviceId(x.deviceId)===deviceId&&pushClientContext(x)===pushClientContext(pushRow)&&String(x.endpoint||'')!==String(pushRow.endpoint||'')){if(markPushSuperseded(x,at)){changed=true;if(x.userId)affected.add(x.userId)}}}let a=activity;if(!a){a={id:'ACT-'+crypto.randomUUID(),deviceId,userId:pushRow.userId||requestUser?.id||null,customerId:pushRow.customerId||requestUser?.customerId||null,visits:[],createdAt:at,presenceVersion:0,statusVersion:0,userAgent:pushRow.userAgent||'',platform:devicePlatformFromUa(pushRow.userAgent||'')};acts.push(a)}else{if(!a.userId&&pushRow.userId)a.userId=pushRow.userId;if(!a.customerId&&pushRow.customerId)a.customerId=pushRow.customerId;if(!a.userAgent&&pushRow.userAgent)a.userAgent=pushRow.userAgent;a.platform=a.platform||devicePlatformFromUa(a.userAgent||'')}const before=JSON.stringify([a.lastPushDeviceAckAt,a.pushSubscriptionActive,a.pushSubscriptionState,a.lastPwaIosPushAckAt,a.deviceStateGeneration,a.currentVerifiedAt,a.currentEndpoint,a.deviceRelevance]);a.lastPushDeviceAckAt=at;a.lastPushDeliveryVerifiedAt=at;if(pushClientContext(pushRow)==='pwa')a.lastPwaPushDeviceAckAt=at;a.pushSubscriptionActive=true;a.pushSubscriptionState='active';a.deviceStateGeneration=CURRENT_DEVICE_STATE_GENERATION;a.currentVerifiedAt=at;a.currentEndpoint=String(pushRow.endpoint||'');a.deviceRelevance='current';if(String(a.platform||devicePlatformFromUa(a.userAgent||pushRow.userAgent||''))==='iPhone / iOS')a.lastPwaIosPushAckAt=at;const after=JSON.stringify([a.lastPushDeviceAckAt,a.pushSubscriptionActive,a.pushSubscriptionState,a.lastPwaIosPushAckAt,a.deviceStateGeneration,a.currentVerifiedAt,a.currentEndpoint,a.deviceRelevance]);if(before!==after){a.statusVersion=Number(a.statusVersion||0)+1;a.updatedAt=at;writeJson('customer_activity.json',acts);changed=true}a.deliveryHealthEstimated=false;a.deliveryHealthEstimatedAt=null;a.deliveryHealthReason=null;a.estimatedAppRemovedAt=null;a.estimatedNotificationClosedAt=null;a.deliveryHealthRecoveredAt=at;if(a.userId)affected.add(a.userId);return {bound:true,changed,activity:a,affectedUserIds:[...affected]}}

function recordCustomerPresence(req,body={}){
  const now=new Date().toISOString(),nowMs=Date.now(),observedMs=evidenceTime(body.observedAt)||nowMs,observedAt=new Date(observedMs).toISOString(),user=accountUserFromReq(req),deviceId=normalizeDeviceId(body.deviceId),tabId=String(body.tabId||'legacy').trim().slice(0,120)||'legacy',clientContext=String(body.clientContext||'').toLowerCase()==='pwa'?'pwa':'browser',presenceState=['active','background','offline'].includes(String(body.presenceState||''))?String(body.presenceState):body.visible===true?'active':'background';if(!deviceId)return null;
  const rows=activityRows();let r=rows.find(x=>x.deviceId===deviceId);if(!r){r={id:'ACT-'+crypto.randomUUID(),deviceId,userId:user?.id||null,customerId:user?.customerId||null,visits:[],createdAt:now,presenceVersion:0,statusVersion:0};rows.push(r)}
  const tabKey=deviceId+'|'+tabId,oldTab=presenceTabs.get(tabKey),incomingSeq=Math.max(0,Number(body.sequence||0));if(oldTab&&incomingSeq&&Number(oldTab.clientSequence||0)>=incomingSeq)return r;
  const beforeState=devicePresenceSnapshot(deviceId,r,nowMs).status,durableBefore=JSON.stringify([r.userId,r.customerId,r.lastOpenAt,r.lastPwaInstalledSignalAt,r.lastPwaStandaloneLaunchAt,r.installedVerifiedAt,r.notificationPermission,r.permission,r.notificationSupported,r.pushSubscriptionActive,r.pushSubscriptionState,r.pushPermissionState,r.permissionsApiState,r.notificationPromptChoice,r.notificationPromptChoiceAt,r.notificationUserPreference,r.notificationObservedAt,r.notificationStateVersion,r.platform,r.deviceStateGeneration,r.currentVerifiedAt,r.currentEndpoint,r.deviceRelevance,r.lastClientContext,r.pwaNotificationPermission,r.pwaPushSubscriptionActive,r.pwaPushSubscriptionState,r.pwaLastNotificationVerifiedAt,r.pwaCurrentPushEndpoint,r.browserNotificationPermission,r.browserPushSubscriptionActive,r.browserPushSubscriptionState,r.browserLastNotificationVerifiedAt,r.browserCurrentPushEndpoint,r.deliveryHealthEstimatedAt,r.estimatedAppRemovedAt,r.estimatedNotificationClosedAt]);
  const visible=body.visible===true,focused=body.focused===true,sessionActive=!!user,ua=String(req.headers['user-agent']||r.userAgent||'').slice(0,500),mobile=mobileUa(ua);
  presenceTabs.set(tabKey,{deviceId,tabId,userId:user?.id||null,customerId:user?.customerId||null,clientContext,presenceState,visible,focused,mobile,sessionActive,clientSequence:incomingSeq||Number(oldTab?.clientSequence||0)+1,serverVersion:Number(oldTab?.serverVersion||0)+1,serverReceivedAt:now,receivedAtMs:nowMs});
  if(clientContext==='pwa'){for(const [otherKey,other] of presenceTabs){if(otherKey===tabKey||other.deviceId!==deviceId||other.clientContext!=='pwa'||(user?.id&&other.userId&&String(other.userId)!==String(user.id)))continue;if(presenceState==='active'){other.sessionActive=false;other.visible=false;other.focused=false;other.presenceState='offline'}else{other.sessionActive=presenceState!=='offline'&&!!user;other.visible=false;other.focused=false;other.presenceState=presenceState}other.serverVersion=Number(other.serverVersion||0)+1;other.serverReceivedAt=now;other.receivedAtMs=nowMs;presenceTabs.set(otherKey,other)}}
  if(user){r.userId=user.id;r.customerId=user.customerId;r.signedOutAt=null}r.userAgent=ua;r.platform=devicePlatformFromUa(r.userAgent);r.lastClientContext=clientContext;
  const incomingObservedMs=evidenceTime(body.notificationObservedAt),currentObservedMs=evidenceTime(r.notificationObservedAt),incomingStateVersion=Math.max(0,Number(body.notificationStateVersion||0)),currentStateVersion=Math.max(0,Number(r.notificationStateVersion||0)),verified=body.notificationVerified===true;
  const canApplyVerified=shouldApplyNotificationObservation(verified,incomingObservedMs,currentObservedMs,incomingStateVersion,currentStateVersion);
  if(canApplyVerified){const permission=['granted','denied','default','unsupported','unknown'].includes(String(body.permission))?String(body.permission):String(r.notificationPermission||r.permission||'unknown');r.notificationPermission=permission;r.permission=permission;if(typeof body.notificationSupported==='boolean')r.notificationSupported=body.notificationSupported;if(typeof body.pushSubscriptionActive==='boolean'){r.pushSubscriptionActive=body.pushSubscriptionActive;if(r.pushSubscriptionState!=='invalid'||body.pushSubscriptionActive)r.pushSubscriptionState=body.pushSubscriptionActive?'active':'missing'}if(['granted','denied','prompt','unknown'].includes(String(body.pushPermissionState)))r.pushPermissionState=String(body.pushPermissionState);if(['granted','denied','prompt','unknown'].includes(String(body.permissionsApiState)))r.permissionsApiState=String(body.permissionsApiState);r.lastNotificationVerifiedAt=incomingObservedMs?new Date(incomingObservedMs).toISOString():now;r.notificationObservedAt=r.lastNotificationVerifiedAt;r.notificationStateVersion=Math.max(currentStateVersion,incomingStateVersion);const prefix=clientContext==='pwa'?'pwa':'browser';r[prefix+'NotificationPermission']=permission;if(typeof body.pushSubscriptionActive==='boolean'){r[prefix+'PushSubscriptionActive']=body.pushSubscriptionActive;r[prefix+'PushSubscriptionState']=body.pushSubscriptionActive?'active':'missing'}r[prefix+'LastNotificationVerifiedAt']=r.lastNotificationVerifiedAt;r[prefix+'CurrentPushEndpoint']=String(body.currentPushEndpoint||'').trim();r[prefix+'PushPermissionState']=String(body.pushPermissionState||'unknown');r[prefix+'PermissionsApiState']=String(body.permissionsApiState||'unknown');if(body.foregroundOpen===true){r.deviceStateGeneration=CURRENT_DEVICE_STATE_GENERATION;r.currentVerifiedAt=r.lastNotificationVerifiedAt||now;r.currentEndpoint=String(body.currentPushEndpoint||'').trim();r.deviceRelevance='current'}}
  const pushReconcile=canApplyVerified&&body.pushSubscriptionActive===true?reconcileForegroundPushEndpoint({deviceId,user,endpoint:body.currentPushEndpoint,observedAt:r.lastNotificationVerifiedAt||now,pwaStandalone:body.standaloneLaunch===true||String(body.pwaSignal||'')==='standalone_launch',clientContext}):{changed:false,affectedUserIds:[]};
  const incomingChoiceAt=evidenceTime(body.notificationPromptChoiceAt),currentChoiceAt=evidenceTime(r.notificationPromptChoiceAt);if(incomingChoiceAt&&incomingChoiceAt>=currentChoiceAt){if(['accepted','declined'].includes(String(body.notificationPromptChoice)))r.notificationPromptChoice=String(body.notificationPromptChoice);if(['on','off','unknown'].includes(String(body.notificationUserPreference)))r.notificationUserPreference=String(body.notificationUserPreference);r.notificationPromptChoiceAt=new Date(incomingChoiceAt).toISOString()}
  if(canApplyVerified&&String(body.permission)==='granted'&&body.pushSubscriptionActive===true&&evidenceTime(r.lastNotificationVerifiedAt)>evidenceTime(r.notificationPromptChoiceAt))r.notificationUserPreference='on';
  if(visible&&body.foregroundOpen===true&&observedMs>=evidenceTime(r.lastOpenAt))r.lastOpenAt=observedAt;
  const signal=String(body.pwaSignal||''),pwaObservedMs=evidenceTime(body.pwaObservedAt)||observedMs,currentPwaObservedMs=evidenceTime(r.pwaObservedAt);if(pwaObservedMs>=currentPwaObservedMs){if(signal==='appinstalled'){r.lastPwaInstalledSignalAt=new Date(pwaObservedMs).toISOString();r.installedVerifiedAt=r.lastPwaInstalledSignalAt;r.firstPwaAt=r.firstPwaAt||r.lastPwaInstalledSignalAt;r.lastPwaAt=r.lastPwaInstalledSignalAt;r.pwaObservedAt=r.lastPwaInstalledSignalAt}if(signal==='standalone_launch'||body.standaloneLaunch===true){r.lastPwaStandaloneLaunchAt=new Date(pwaObservedMs).toISOString();r.installedVerifiedAt=r.lastPwaStandaloneLaunchAt;r.firstPwaAt=r.firstPwaAt||r.lastPwaStandaloneLaunchAt;r.lastPwaAt=r.lastPwaStandaloneLaunchAt;r.pwaObservedAt=r.lastPwaStandaloneLaunchAt}}
  if(body.foregroundOpen===true||signal==='standalone_launch'||body.standaloneLaunch===true){r.lastDeviceObservedAt=observedAt;r.lastDeviceReceivedAt=now;const standaloneEvidence=signal==='standalone_launch'||body.standaloneLaunch===true,freshNotificationDecision=canApplyVerified&&(String(body.permission)==='denied'||String(body.permission)==='granted');let healthResolved=false;if(standaloneEvidence)healthResolved=resolveDeliveryHealthEvidence(deviceId,observedAt,'standalone_launch',{app:true,notification:freshNotificationDecision});else if(freshNotificationDecision)clearDeliveryHealthEstimateOnActivity(deviceId,observedAt,'foreground_notification',{app:false,notification:true});if(healthResolved){r.deliveryHealthEstimated=false;r.deliveryHealthEstimatedAt=null;r.deliveryHealthReason=null;r.estimatedAppRemovedAt=null;if(freshNotificationDecision)r.estimatedNotificationClosedAt=null;r.deliveryHealthRecoveredAt=observedAt;r.deliveryHealthRecoveryReason='standalone_launch'}}const afterState=devicePresenceSnapshot(deviceId,r,nowMs).status,durableAfter=JSON.stringify([r.userId,r.customerId,r.lastOpenAt,r.lastPwaInstalledSignalAt,r.lastPwaStandaloneLaunchAt,r.installedVerifiedAt,r.notificationPermission,r.permission,r.notificationSupported,r.pushSubscriptionActive,r.pushSubscriptionState,r.pushPermissionState,r.permissionsApiState,r.notificationPromptChoice,r.notificationPromptChoiceAt,r.notificationUserPreference,r.notificationObservedAt,r.notificationStateVersion,r.platform,r.deviceStateGeneration,r.currentVerifiedAt,r.currentEndpoint,r.deviceRelevance,r.lastClientContext,r.pwaNotificationPermission,r.pwaPushSubscriptionActive,r.pwaPushSubscriptionState,r.pwaLastNotificationVerifiedAt,r.pwaCurrentPushEndpoint,r.browserNotificationPermission,r.browserPushSubscriptionActive,r.browserPushSubscriptionState,r.browserLastNotificationVerifiedAt,r.browserCurrentPushEndpoint,r.deliveryHealthEstimatedAt,r.estimatedAppRemovedAt,r.estimatedNotificationClosedAt]);
  const lastPersistMs=new Date(r.lastSeenAt||0).getTime(),persistLastSeen=!Number.isFinite(lastPersistMs)||nowMs-lastPersistMs>=60000||beforeState!==afterState;if(persistLastSeen)r.lastSeenAt=now;if(beforeState!==afterState)r.presenceVersion=Number(r.presenceVersion||0)+1;if(durableBefore!==durableAfter)r.statusVersion=Number(r.statusVersion||0)+1;r.updatedAt=now;if(durableBefore!==durableAfter||persistLastSeen)writeJson('customer_activity.json',rows);if(durableBefore!==durableAfter||pushReconcile.changed)persistAccountStateAsync();if(beforeState!==afterState||durableBefore!==durableAfter||pushReconcile.changed){const reason=beforeState!==afterState?'presence':'status',uids=new Set([r.userId,...(pushReconcile.affectedUserIds||[])].filter(Boolean));for(const uid of uids)publishAdminMemberUpdate(uid,reason)}return r;
}
function publishAdminSummaryUpdate(){adminMemberStateSequence++;const data=`data: ${JSON.stringify({type:'member-summary-updated',version:adminMemberStateSequence,summary:memberSummary()})}\n\n`;for(const stream of [...adminActivityStreams]){try{stream.write(data)}catch(_){adminActivityStreams.delete(stream)}}}
function publishAdminMemberUpdate(userId,reason='update'){if(!userId)return;adminMemberStateSequence++;const member=adminMemberRows(userId)[0];if(!member)return;member.stateVersion=adminMemberStateSequence;const data=`data: ${JSON.stringify({type:'member-update',reason,userId,version:adminMemberStateSequence,serverTimestamp:new Date().toISOString(),member})}\n\n`;for(const stream of [...adminActivityStreams]){try{stream.write(data)}catch(_){adminActivityStreams.delete(stream)}}notificationDebug('ADMIN_MEMBER_UPDATE_PUBLISHED',{userId,deviceId:member.devices?.[0]?.deviceId,permission:member.devices?.[0]?.notificationPermission,subscriptionState:member.devices?.[0]?.pushSubscription});setTimeout(()=>publishAdminSummaryUpdate(),0)}
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
const DELIVERY_HEALTH_WATCH_MS=12*60*60*1000;
const DELIVERY_HEALTH_CHECK_MS=60*60*1000;
// Manuel admin bildirimi raporunda cihaz ACK sonucu saatlerce beklemesin.
// Bu yalnız gönderim RAPORUNU finalize eder; 12 saatlik cihaz/PWA health state mantığını değiştirmez.
const MANUAL_PUSH_REPORT_ACK_MS=8000;
const DELIVERY_HEALTH_GLOBAL_WINDOW_MS=60*60*1000;
function deliveryHealthWatchActive(row={}){return ['watching','paused_global','paused_system'].includes(String(row.deliveryHealthState||''))&&!!row.deliveryHealthWatchStartedAt}
function clearDeliveryHealthEstimateOnActivity(deviceId,at,reason='real_device_evidence',scope={app:true,notification:true}){deviceId=normalizeDeviceId(deviceId);if(!deviceId)return false;const rows=activityRows(),r=rows.find(x=>normalizeDeviceId(x.deviceId)===deviceId);if(!r)return false;const clearApp=scope?.app!==false,clearNotification=scope?.notification!==false,before=JSON.stringify([r.deliveryHealthEstimated,r.deliveryHealthEstimatedAt,r.deliveryHealthReason,r.estimatedAppRemovedAt,r.estimatedNotificationClosedAt]);if(clearApp)r.estimatedAppRemovedAt=null;if(clearNotification)r.estimatedNotificationClosedAt=null;if(!r.estimatedAppRemovedAt&&!r.estimatedNotificationClosedAt){r.deliveryHealthEstimated=false;r.deliveryHealthEstimatedAt=null;r.deliveryHealthReason=null}r.deliveryHealthRecoveredAt=at;r.deliveryHealthRecoveryReason=reason;const after=JSON.stringify([r.deliveryHealthEstimated,r.deliveryHealthEstimatedAt,r.deliveryHealthReason,r.estimatedAppRemovedAt,r.estimatedNotificationClosedAt]);if(before===after)return false;r.statusVersion=Number(r.statusVersion||0)+1;r.updatedAt=new Date().toISOString();writeJson('customer_activity.json',rows);if(r.userId)publishAdminMemberUpdate(r.userId,'delivery-health-recovered');return true}
function resolveDeliveryHealthEvidence(deviceId,at=new Date().toISOString(),reason='device_evidence',scope={app:true,notification:true}){deviceId=normalizeDeviceId(deviceId);if(!deviceId)return false;const rows=readJson('push_subscriptions.json',[]),evidenceMs=evidenceTime(at),activity=activityRows().find(x=>normalizeDeviceId(x.deviceId)===deviceId)||{};let changed=false,shouldClearActivity=!!(Math.max(evidenceTime(activity.deliveryHealthEstimatedAt),evidenceTime(activity.estimatedAppRemovedAt),evidenceTime(activity.estimatedNotificationClosedAt))&&evidenceMs>=Math.max(evidenceTime(activity.deliveryHealthEstimatedAt),evidenceTime(activity.estimatedAppRemovedAt),evidenceTime(activity.estimatedNotificationClosedAt)));for(const row of rows){if(normalizeDeviceId(row.deviceId)!==deviceId)continue;const estimatedMs=evidenceTime(row.deliveryHealthEstimatedAt),startMs=evidenceTime(row.deliveryHealthWatchStartedAt),deadlineMs=evidenceTime(row.deliveryHealthWatchDeadlineAt),withinOriginalWindow=!!startMs&&evidenceMs>=startMs&&(!deadlineMs||evidenceMs<=deadlineMs),activeWindowEvidence=deliveryHealthWatchActive(row)&&(!startMs||evidenceMs>=startMs),newerThanEstimate=!!estimatedMs&&evidenceMs>=estimatedMs;if(activeWindowEvidence||withinOriginalWindow||newerThanEstimate){row.deliveryHealthState='healthy';row.deliveryHealthResolvedAt=at;row.deliveryHealthResolutionReason=reason;row.deliveryHealthNextCheckAt=null;row.deliveryHealthPauseStartedAt=null;row.deliveryHealthEstimated=false;row.deliveryHealthEstimatedAt=null;row.deliveryHealthReason=null;row.updatedAt=new Date().toISOString();changed=true;shouldClearActivity=true}}if(changed)writeJson('push_subscriptions.json',rows);const activityChanged=shouldClearActivity?clearDeliveryHealthEstimateOnActivity(deviceId,at,reason,scope):false;if(changed||activityChanged)persistAccountStateAsync();return changed||activityChanged}
function startDeliveryHealthWatch(row,deliveryId,acceptedAt=new Date().toISOString()){if(!row||!pushRecordActive(row)||!pushRecordCurrentRelevant(row)||!normalizeDeviceId(row.deviceId))return false;const nowMs=evidenceTime(acceptedAt)||Date.now();if(!deliveryHealthWatchActive(row)){row.deliveryHealthWatchStartedAt=new Date(nowMs).toISOString();row.deliveryHealthWatchDeadlineAt=new Date(nowMs+DELIVERY_HEALTH_WATCH_MS).toISOString();row.deliveryProbeAttempts=0;row.deliveryHealthPauseStartedAt=null}else if(row.deliveryHealthPauseStartedAt){const pauseStart=evidenceTime(row.deliveryHealthPauseStartedAt),deadline=evidenceTime(row.deliveryHealthWatchDeadlineAt)||evidenceTime(row.deliveryHealthWatchStartedAt)+DELIVERY_HEALTH_WATCH_MS;if(pauseStart&&nowMs>pauseStart)row.deliveryHealthWatchDeadlineAt=new Date(deadline+(nowMs-pauseStart)).toISOString();row.deliveryHealthPauseStartedAt=null}row.deliveryHealthState='watching';row.deliveryHealthLastDeliveryId=deliveryId;row.deliveryHealthLastAcceptedAt=new Date(nowMs).toISOString();row.deliveryHealthLastCheckAt=row.deliveryHealthLastCheckAt||null;row.deliveryHealthNextCheckAt=row.deliveryHealthNextCheckAt||new Date(nowMs+DELIVERY_HEALTH_CHECK_MS).toISOString();row.deliveryHealthReason='awaiting_device_ack';row.deliveryHealthEstimated=false;row.deliveryHealthEstimatedAt=null;row.updatedAt=new Date().toISOString();return true}
function pushSystemHealthSnapshot(now=Date.now()){const cut=now-DELIVERY_HEALTH_GLOBAL_WINDOW_MS,logs=pushDeliveryLogs().filter(x=>evidenceTime(x.createdAt)>=cut);let accepted=0,acked=0,transient=0,authFailures=0;for(const log of logs){for(const state of (Array.isArray(log.targetStates)?log.targetStates:[])){const status=Number(state?.providerStatus||0);if(status>=200&&status<300){accepted++;if(state?.deviceAckAt)acked++}else if(status===429||status===0||status>=500)transient++;else if(status===401||status===403)authFailures++}}const ackRate=accepted?acked/accepted:1,degraded=authFailures>0||transient>=Math.max(3,accepted);return {healthy:!degraded,degraded,accepted,acked,transient,authFailures,ackRate,windowMs:DELIVERY_HEALTH_GLOBAL_WINDOW_MS}}
function applyDeliveryHealthEstimate(deviceId,at=new Date().toISOString()){deviceId=normalizeDeviceId(deviceId);if(!deviceId)return false;const rows=activityRows(),r=rows.find(x=>normalizeDeviceId(x.deviceId)===deviceId);if(!r)return false;r.deliveryHealthEstimated=true;r.deliveryHealthEstimatedAt=at;r.deliveryHealthReason='12h_no_delivery_evidence';r.estimatedAppRemovedAt=at;r.estimatedNotificationClosedAt=at;r.statusVersion=Number(r.statusVersion||0)+1;r.updatedAt=at;writeJson('customer_activity.json',rows);if(r.userId)publishAdminMemberUpdate(r.userId,'delivery-health-estimated');return true}
function deliveryHealthStrongEvidenceAfter(row,acts,startMs){const deviceId=normalizeDeviceId(row.deviceId),a=(acts||[]).find(x=>normalizeDeviceId(x.deviceId)===deviceId)||{},standalonePushEvidence=row?.pwa===true?evidenceTime(row.pwaObservedAt):0;return Math.max(evidenceTime(row.lastPushDeviceAckAt),standalonePushEvidence,evidenceTime(a.lastPushDeviceAckAt),evidenceTime(a.lastPwaStandaloneLaunchAt),evidenceTime(a.lastPwaInstalledSignalAt))>startMs}
async function runDeliveryHealthWatchChecks(){const now=Date.now(),rows=readJson('push_subscriptions.json',[]),acts=activityRows(),health=pushSystemHealthSnapshot(now),latestByOwner=new Map();for(const row of keepLatestAuthoritativePushTargets(rows,acts)){latestByOwner.set(pushOwnerKey(row)||('d:'+normalizeDeviceId(row.deviceId)),normalizeDeviceId(row.deviceId))}let changed=false;const estimatedDevices=new Set(),resolvedDevices=new Set();for(const row of rows){if(!deliveryHealthWatchActive(row))continue;const deviceId=normalizeDeviceId(row.deviceId),owner=pushOwnerKey(row)||('d:'+deviceId),startMs=evidenceTime(row.deliveryHealthWatchStartedAt);if(!deviceId||latestByOwner.get(owner)!==deviceId){row.deliveryHealthState='healthy';row.deliveryHealthResolvedAt=new Date(now).toISOString();row.deliveryHealthResolutionReason='historical_device';row.deliveryHealthNextCheckAt=null;row.deliveryHealthPauseStartedAt=null;changed=true;continue}if(!pushRecordActive(row)){row.deliveryHealthState='invalid';row.deliveryHealthResolvedAt=new Date(now).toISOString();row.deliveryHealthResolutionReason='permanent_invalid';row.deliveryHealthNextCheckAt=null;row.deliveryHealthPauseStartedAt=null;changed=true;continue}if(deliveryHealthStrongEvidenceAfter(row,acts,startMs)){row.deliveryHealthState='healthy';row.deliveryHealthResolvedAt=new Date(now).toISOString();row.deliveryHealthResolutionReason='real_device_evidence';row.deliveryHealthNextCheckAt=null;row.deliveryHealthPauseStartedAt=null;row.deliveryHealthEstimated=false;row.deliveryHealthEstimatedAt=null;row.deliveryHealthReason=null;resolvedDevices.add(deviceId);changed=true;continue}const nextMs=evidenceTime(row.deliveryHealthNextCheckAt);if(nextMs&&nextMs>now)continue;if(!health.healthy){if(!row.deliveryHealthPauseStartedAt)row.deliveryHealthPauseStartedAt=new Date(now).toISOString();row.deliveryHealthState='paused_global';row.deliveryHealthLastCheckAt=new Date(now).toISOString();row.deliveryHealthNextCheckAt=new Date(now+DELIVERY_HEALTH_CHECK_MS).toISOString();row.deliveryHealthReason='global_push_degraded';changed=true;continue}if(row.deliveryHealthPauseStartedAt){const pauseMs=Math.max(0,now-evidenceTime(row.deliveryHealthPauseStartedAt)),deadline=evidenceTime(row.deliveryHealthWatchDeadlineAt)||startMs+DELIVERY_HEALTH_WATCH_MS;row.deliveryHealthWatchDeadlineAt=new Date(deadline+pauseMs).toISOString();row.deliveryHealthPauseStartedAt=null}row.deliveryHealthState='watching';row.deliveryHealthLastCheckAt=new Date(now).toISOString();row.deliveryProbeAttempts=Math.max(0,Number(row.deliveryProbeAttempts||0))+1;row.deliveryHealthNextCheckAt=new Date(now+DELIVERY_HEALTH_CHECK_MS).toISOString();row.deliveryHealthReason='awaiting_device_ack';const deadline=evidenceTime(row.deliveryHealthWatchDeadlineAt)||startMs+DELIVERY_HEALTH_WATCH_MS;if(now>=deadline){row.deliveryHealthState='estimated_closed';row.deliveryHealthEstimated=true;row.deliveryHealthEstimatedAt=new Date(now).toISOString();row.deliveryHealthReason='12h_no_delivery_evidence';row.deliveryHealthNextCheckAt=null;estimatedDevices.add(deviceId)}changed=true}if(changed){writeJson('push_subscriptions.json',rows);for(const d of resolvedDevices)clearDeliveryHealthEstimateOnActivity(d,new Date(now).toISOString(),'real_device_evidence');for(const d of estimatedDevices)applyDeliveryHealthEstimate(d,new Date(now).toISOString());persistAccountStateAsync()}return {changed,health,estimated:[...estimatedDevices],resolved:[...resolvedDevices]}}
function startDeliveryHealthWatchesForAccepted(deliveryId,acceptedIds=[]){const ids=new Set((acceptedIds||[]).map(String)),delivery=pushDeliveryLogs().find(x=>x.deliveryId===deliveryId),acked=new Set(Array.isArray(delivery?.ackedSubscriptionIds)?delivery.ackedSubscriptionIds:[]),rows=readJson('push_subscriptions.json',[]),acts=activityRows(),latest=keepLatestAuthoritativePushTargets(rows,acts),latestIds=new Set(latest.map(safePushRecordId));let changed=false;for(const row of rows){const id=safePushRecordId(row);if(!ids.has(id)||acked.has(id)||!latestIds.has(id))continue;if(startDeliveryHealthWatch(row,deliveryId,row.lastPushAcceptedAt||new Date().toISOString()))changed=true}if(changed){writeJson('push_subscriptions.json',rows);persistAccountStateAsync()}return changed}
const pushSendIdempotency=new Map();
const pushSubscribeRate=new Map();
function safePushRecordId(row){return String(row?.id||crypto.createHash('sha256').update(String(row?.endpoint||'')).digest('hex').slice(0,12))}
function pushDeliveryLogs(){return readJson(PUSH_DELIVERY_LOG_FILE,[])}
function writePushDeliveryLogs(rows){writeJson(PUSH_DELIVERY_LOG_FILE,(Array.isArray(rows)?rows:[]).slice(-200))}
function createPushDeliveryLog(targets,kind){const rows=pushDeliveryLogs(),createdAt=new Date().toISOString(),list=Array.isArray(targets)?targets:[],targetSubscriptionIds=list.map(safePushRecordId).filter(Boolean),targetCount=Array.isArray(targets)?list.length:Number(targets||0),targetStates=list.map(x=>({subscriptionId:safePushRecordId(x),deviceId:normalizeDeviceId(x.deviceId)||null,status:'GÖNDERİLİYOR',providerStatus:null,deviceAckAt:null})),row={deliveryId:'DEL-'+crypto.randomUUID(),createdAt,updatedAt:createdAt,revision:1,kind:String(kind||'manual').slice(0,40),targetCount:Number(targetCount||0),targetSubscriptionIds:[...new Set(targetSubscriptionIds)].slice(0,500),targetStates,providerAccepted:0,failed:0,cleaned:0,deviceAckCount:0,ackedSubscriptionIds:[],failureStatuses:{}};rows.push(row);writePushDeliveryLogs(rows);return row}
function updatePushDeliveryLog(deliveryId,patch){const rows=pushDeliveryLogs(),i=rows.findIndex(x=>x.deliveryId===deliveryId);if(i<0)return null;const previous=rows[i],previousAckAt=new Map((Array.isArray(previous.targetStates)?previous.targetStates:[]).map(x=>[String(x?.subscriptionId||''),x?.deviceAckAt||null]));rows[i]={...previous,...patch,updatedAt:new Date().toISOString(),revision:Number(previous.revision||0)+1};const ackedSet=new Set(Array.isArray(rows[i].ackedSubscriptionIds)?rows[i].ackedSubscriptionIds:[]),rawAck=ackedSet.size,accepted=Math.max(0,Number(rows[i].providerAccepted||0)),target=Math.max(0,Number(rows[i].targetCount||0));rows[i].deviceAckCount=Math.min(rawAck,accepted,target);if(Array.isArray(rows[i].targetStates))rows[i].targetStates=rows[i].targetStates.map(x=>ackedSet.has(String(x?.subscriptionId||''))?{...x,status:'TESLİM EDİLDİ',deviceAckAt:x?.deviceAckAt||previousAckAt.get(String(x?.subscriptionId||''))||rows[i].updatedAt}:x);writePushDeliveryLogs(rows);return rows[i]}
function pushDeliveryPublicState(row={}){const now=Date.now(),target=Math.max(0,Number(row.targetCount||0)),accepted=Math.min(target,Math.max(0,Number(row.providerAccepted||0))),rawAck=Math.max(0,Number(row.deviceAckCount||0)),acked=Math.min(rawAck,accepted,target),failed=Math.max(0,Number(row.failed||0)),cleaned=Math.max(0,Number(row.cleaned||0)),subscriptions=readJson('push_subscriptions.json',[]),systemHealthy=pushSystemHealthSnapshot(now).healthy,targetStates=(Array.isArray(row.targetStates)?row.targetStates:[]).map(x=>{const subscriptionId=String(x?.subscriptionId||''),deviceAckAt=x?.deviceAckAt||null,rawStatus=String(x?.status||'GÖNDERİLİYOR');let status=rawStatus,expired=false;if(rawStatus==='TESLİM TEYİDİ BEKLENİYOR'&&!deviceAckAt&&systemHealthy){const manualReportDeadline=String(row.kind||'')==='manual'?(evidenceTime(row.finishedAt||row.createdAt)+MANUAL_PUSH_REPORT_ACK_MS):0,sub=subscriptions.find(s=>safePushRecordId(s)===subscriptionId),watchForDelivery=sub&&String(sub.deliveryHealthLastDeliveryId||'')===String(row.deliveryId||''),watchState=String(sub?.deliveryHealthState||''),paused=['paused_global','paused_system'].includes(watchState);if(manualReportDeadline&&now>=manualReportDeadline)expired=true;else if(watchForDelivery&&watchState==='estimated_closed'&&String(sub.deliveryHealthReason||'')==='12h_no_delivery_evidence')expired=true;else if(!paused&&String(row.kind||'')!=='manual'){let deadline=watchForDelivery?evidenceTime(sub.deliveryHealthWatchDeadlineAt):0;if(!deadline)deadline=evidenceTime(row.createdAt)+DELIVERY_HEALTH_WATCH_MS;expired=now>=deadline}if(expired)status='BİLDİRİM CİHAZA TESLİM EDİLMEDİ'}return {subscriptionId,deviceId:normalizeDeviceId(x?.deviceId)||null,status,providerStatus:x?.providerStatus??null,deviceAckAt,ackWindowExpired:expired}}),ackWindowExpired=targetStates.some(x=>x.ackWindowExpired===true);return {deliveryId:row.deliveryId,createdAt:row.createdAt,updatedAt:row.updatedAt||row.createdAt,finishedAt:row.finishedAt||null,revision:Number(row.revision||0),targetCount:target,providerAccepted:accepted,providerRejected:failed,failed,cleaned,permanentInvalid:cleaned,deviceAckCount:acked,pendingAck:Math.max(0,accepted-acked),ackWindowExpired,failureStatuses:row.failureStatuses||{},targetStates}}
function publishAdminCargoUpdate(orderId,reason='update'){const data=`data: ${JSON.stringify({type:'cargo-update',reason,orderId:String(orderId||''),serverTimestamp:new Date().toISOString()})}\n\n`;for(const stream of [...adminActivityStreams]){try{stream.write(data)}catch(_){adminActivityStreams.delete(stream)}}}
function publishAdminPushDeliveryUpdate(row){if(!row?.deliveryId)return;const data=`data: ${JSON.stringify({type:'push-delivery-update',serverTimestamp:new Date().toISOString(),delivery:pushDeliveryPublicState(row)})}\n\n`;for(const stream of [...adminActivityStreams]){try{stream.write(data)}catch(_){adminActivityStreams.delete(stream)}}notificationDebug('ADMIN_DELIVERY_UPDATE_PUBLISHED',{subscriptionState:'delivery'})}
function scheduleManualPushReportDeadline(deliveryId){const row=pushDeliveryLogs().find(x=>x.deliveryId===deliveryId);if(!row||String(row.kind||'')!=='manual'||Number(row.providerAccepted||0)<=0)return;const deadline=evidenceTime(row.finishedAt||row.createdAt)+MANUAL_PUSH_REPORT_ACK_MS,delay=Math.max(0,deadline-Date.now()+30);setTimeout(()=>{const latest=pushDeliveryLogs().find(x=>x.deliveryId===deliveryId);if(latest)publishAdminPushDeliveryUpdate(latest)},delay)}
function pushStats(){const rows=readJson('push_subscriptions.json',[]),acts=activityRows(),cut=Date.now()-30*86400000,active=rows.filter(pushRecordActive),eligible=active.filter(x=>pushRecordTargetEligible(x)&&pushRecordCurrentRelevant(x,acts)),invalid=rows.filter(x=>!pushRecordActive(x)),currentDevices=new Set(eligible.map(x=>pushOwnerKey(x)+'|'+normalizeDeviceId(x.deviceId)).filter(Boolean));return {registered:rows.length,active:active.length,currentActiveDevices:currentDevices.size,eligibleSubscriptions:eligible.length,legacyUnbound:active.filter(x=>!normalizeDeviceId(x.deviceId)||String(x.lifecycle||'').toLowerCase()==='legacy-unbound').length,historical:active.filter(x=>normalizeDeviceId(x.deviceId)&&!pushRecordCurrentRelevant(x,acts)).length,invalid:invalid.length,active30:eligible.filter(x=>{const a=x.deviceId?acts.find(v=>v.deviceId===x.deviceId):null,d=Math.max(pushCurrentEvidenceAt(x),activityCurrentEvidenceAt(a||{}));return d>=cut}).length,deliveryHealth:pushSystemHealthSnapshot(),enabled:webPushReady,configError:webPushReady?'':webPushConfigError}}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function pushRetryAfterMs(e,attempt){const raw=e?.headers?.['retry-after']||e?.headers?.get?.('retry-after');const n=Number(raw);if(Number.isFinite(n)&&n>=0)return Math.min(10000,n*1000);return Math.min(2500,500*Math.pow(2,attempt))}
function pushErrorStatus(e){return Number(e?.statusCode||e?.status||0)||0}
function pushIsTransient(status){return status===429||status>=500||status===0}
async function runWithConcurrency(items,limit,worker){const out=new Array(items.length),next={i:0};async function run(){while(true){const i=next.i++;if(i>=items.length)return;try{out[i]=await worker(items[i],i)}catch(e){out[i]={ok:false,status:pushErrorStatus(e),error:String(e?.message||e)}}}}await Promise.all(Array.from({length:Math.max(1,Math.min(limit,items.length||1))},run));return out}
async function normalizeActivePushTargets(rows=[]){
  const requested=(Array.isArray(rows)?rows:[]).filter(Boolean),requestedIds=new Set(requested.map(safePushRecordId)),requestedEndpoints=new Set(requested.map(x=>String(x.endpoint||'')).filter(Boolean)),all=readJson('push_subscriptions.json',[]),acts=activityRows(),raw=all.filter(x=>pushRecordActive(x)&&(requestedIds.has(safePushRecordId(x))||requestedEndpoints.has(String(x.endpoint||''))));
  const recency=x=>Math.max(pushCurrentEvidenceAt(x),evidenceTime(x.lastPushAttemptAt),evidenceTime(x.updatedAt),evidenceTime(x.createdAt)),sorted=[...raw].sort((a,b)=>recency(b)-recency(a)),byEndpoint=new Map();for(const row of sorted){const ep=String(row.endpoint||'');if(!ep)continue;const current=byEndpoint.get(ep),currentGen=current?pushRecordCurrentRelevant(current):false,rowGen=pushRecordCurrentRelevant(row);if(!current||(!currentGen&&rowGen)||((currentGen===rowGen)&&!pushRecordTargetEligible(current)&&pushRecordTargetEligible(row)))byEndpoint.set(ep,row)}let candidates=[...byEndpoint.values()],legacyExcluded=0,historicalExcluded=0,historicalChanged=false;
  candidates=candidates.filter(row=>{if(!pushRecordTargetEligible(row)){legacyExcluded++;return false}if(pushRecordCurrentRelevant(row,acts))return true;historicalExcluded++;const stored=all.find(x=>safePushRecordId(x)===safePushRecordId(row));if(stored&&markPushHistorical(stored,new Date().toISOString()))historicalChanged=true;return false});
  const groups=new Map();for(const row of candidates){const deviceId=normalizeDeviceId(row.deviceId);if(!deviceId)continue;const key=pushOwnerKey(row)+'|'+deviceId+'|'+pushClientContext(row);(groups.get(key)||groups.set(key,[]).get(key)).push(row)}
  const stale=[];for(const group of groups.values()){if(group.length<2)continue;group.sort((a,b)=>pushCurrentEvidenceAt(b)-pushCurrentEvidenceAt(a));for(const old of group.slice(1))stale.push(old)}
  if(stale.length){const now=new Date().toISOString(),staleSet=new Set(stale.map(x=>safePushRecordId(x))),affectedUsers=new Set();for(const row of all){if(!staleSet.has(safePushRecordId(row))||!pushRecordActive(row))continue;if(markPushSuperseded(row,now)&&row.userId)affectedUsers.add(row.userId)}writeJson('push_subscriptions.json',all);for(const uid of affectedUsers)publishAdminMemberUpdate(uid,'push');try{await persistAccountStateToGithub()}catch(e){console.error('Eski push aboneliği kalıcı kayıt:',e.message)}}else if(historicalChanged){writeJson('push_subscriptions.json',all);try{await persistAccountStateToGithub()}catch(e){console.error('Historical push işareti kalıcı kayıt:',e.message)}}
  const staleIds=new Set(stale.map(x=>safePushRecordId(x)));return {rows:candidates.filter(x=>!staleIds.has(safePushRecordId(x))&&pushRecordTargetEligible(x)),staleFound:stale.length,staleInvalidated:stale.length,legacyExcluded,historicalExcluded};
}
async function sendPushRows(rows,payload,opts={}){
  rows=Array.isArray(rows)?rows.filter(x=>x&&pushRecordActive(x)):[];const normalized=await normalizeActivePushTargets(rows);rows=keepLatestAuthoritativePushTargets(normalized.rows,activityRows());
  const log=createPushDeliveryLog(rows,opts.kind||'manual'),deliveryId=log.deliveryId,all=readJson('push_subscriptions.json',[]),invalid=new Set();
  const ttl=Math.max(60,Math.min(86400,Number(opts.ttl||3600))),urgency=['very-low','low','normal','high'].includes(opts.urgency)?opts.urgency:'normal';
  const results=await runWithConcurrency(rows,6,async row=>{
    const id=safePushRecordId(row),target=all.find(x=>safePushRecordId(x)===id)||all.find(x=>x.endpoint===row.endpoint&&pushRecordActive(x)),attemptAt=new Date().toISOString();if(target)target.lastPushAttemptAt=attemptAt;
    let lastStatus=0,lastError='',lastErrorCode='',attempts=0;
    for(let attempt=0;attempt<2;attempt++){
      attempts=attempt+1;
      try{
        const perPayload={...payload,deliveryId,subscriptionId:id};
        if(String(payload?.type||'')==='manual'){const rua=String(row?.userAgent||'');perPayload.targetPlatform=/iPhone|iPad|iPod/i.test(rua)||(/Macintosh/i.test(rua)&&/Mobile/i.test(rua))?'ios':(/Android/i.test(rua)?'android':'unknown')}
        const pushResponse=await webpush.sendNotification({endpoint:row.endpoint,keys:{p256dh:row.p256dh,auth:row.auth}},JSON.stringify(perPayload),{TTL:ttl,urgency,timeout:10000});
        const acceptedStatus=Number(pushResponse?.statusCode||pushResponse?.status||201),at=new Date().toISOString();if(target){target.pushSubscriptionStatus='ACTIVE';target.lastPushAttemptAt=attemptAt;target.lastPushResult='accepted';target.lastPushHttpStatus=acceptedStatus;target.lastPushAcceptedAt=at;target.lastPushSuccessAt=at;target.lastPushFailureAt=null;target.lastPushFailureStatus=null;target.lastPushErrorCode=null;target.temporaryFailureAt=null;target.temporaryFailureCount=0;target.updatedAt=at}
        notificationDebug('PROVIDER_ACCEPTED',{userId:target?.userId,deviceId:target?.deviceId,subscriptionState:'active'});
        return {id,ok:true,status:acceptedStatus,cleaned:false,attempts};
      }catch(e){
        const status=pushErrorStatus(e);lastStatus=status;lastError=String(e?.message||'Push gönderim hatası.').slice(0,180);lastErrorCode=String(e?.code||e?.name||'').slice(0,120);
        if(status===404||status===410){invalid.add(row.endpoint);break}
        if(!pushIsTransient(status)||attempt===1)break;
        await sleep(pushRetryAfterMs(e,attempt));
      }
    }
    const at=new Date().toISOString();if(target){target.lastPushAttemptAt=attemptAt;target.lastPushFailureAt=at;target.lastPushFailureStatus=lastStatus||'network';target.lastPushHttpStatus=lastStatus||null;target.lastPushErrorCode=lastErrorCode||lastError||null;if(lastStatus===404||lastStatus===410){target.lastPushResult='permanent_invalid';target.pushSubscriptionStatus='INVALID';target.invalidatedAt=at;target.permanentInvalidAt=at;target.lastPushPermanentInvalidAt=at;target.deliveryHealthState='invalid';target.deliveryHealthResolvedAt=at;target.deliveryHealthResolutionReason='permanent_invalid';target.deliveryHealthNextCheckAt=null;target.deliveryHealthPauseStartedAt=null;target.deliveryHealthEstimated=false;target.deliveryHealthEstimatedAt=null;target.deliveryHealthReason=null}else{target.lastPushResult='temporary_failure';target.temporaryFailureAt=at;target.temporaryFailureCount=Number(target.temporaryFailureCount||0)+1;if(deliveryHealthWatchActive(target)){target.deliveryHealthState='paused_system';target.deliveryHealthPauseStartedAt=target.deliveryHealthPauseStartedAt||at;target.deliveryHealthNextCheckAt=new Date(Date.now()+DELIVERY_HEALTH_CHECK_MS).toISOString();target.deliveryHealthReason='provider_transient_failure'}}target.updatedAt=at}
    notificationDebug('PROVIDER_REJECTED',{userId:target?.userId,deviceId:target?.deviceId,subscriptionState:(lastStatus===404||lastStatus===410)?'invalid':'temporary_failure'});if(lastStatus===404||lastStatus===410)notificationDebug('PUSH_SUBSCRIPTION_INVALIDATED',{userId:target?.userId,deviceId:target?.deviceId,subscriptionState:'invalid'});
    if(lastStatus===401||lastStatus===403)console.warn('Push VAPID/auth hatası:',lastStatus,'kayıt',id);
    else console.warn('Push gönderim hatası:',lastStatus||'network','kayıt',id,lastError);
    return {id,ok:false,status:lastStatus,cleaned:invalid.has(row.endpoint),attempts};
  });
  let changed=false,next=all;
  if(invalid.size)changed=true;
  if(results.length)changed=true;
  if(changed){writeJson('push_subscriptions.json',next);for(const d of new Set(results.filter(r=>r.cleaned).map(r=>all.find(x=>safePushRecordId(x)===r.id)?.deviceId).filter(Boolean))){const stillActive=all.some(x=>x.deviceId===d&&pushRecordActive(x));setActivityPushState(d,stillActive,{permanent:!stillActive})}for(const uid of new Set(results.map(r=>all.find(x=>safePushRecordId(x)===r.id)?.userId).filter(Boolean)))publishAdminMemberUpdate(uid,'push');try{await persistAccountStateToGithub()}catch(e){console.error('Push aboneliği kalıcı kayıt:',e.message)}}
  const accepted=results.filter(x=>x.ok).length,failed=results.length-accepted,cleaned=invalid.size,failureStatuses={};
  for(const r of results.filter(x=>!x.ok)){const k=String(r.status||'network');failureStatuses[k]=(failureStatuses[k]||0)+1}
  const targetStates=results.map(r=>({subscriptionId:String(r.id||''),deviceId:normalizeDeviceId(all.find(x=>safePushRecordId(x)===r.id)?.deviceId)||null,status:r.ok?'TESLİM TEYİDİ BEKLENİYOR':(r.cleaned?'PUSH ABONELİĞİ GEÇERSİZ':(pushIsTransient(Number(r.status||0))?'GEÇİCİ SERVİS HATASI':'TESLİM EDİLEMEDİ')),providerStatus:r.status||null,deviceAckAt:null}));
  const delivery=updatePushDeliveryLog(deliveryId,{providerAccepted:accepted,failed,cleaned,failureStatuses,targetStates,finishedAt:new Date().toISOString()});publishAdminPushDeliveryUpdate(delivery);scheduleManualPushReportDeadline(deliveryId);startDeliveryHealthWatchesForAccepted(deliveryId,results.filter(x=>x.ok).map(x=>x.id));
  console.log('Push delivery',deliveryId,'hedef',rows.length,'accepted',accepted,'failed',failed,'cleaned',cleaned,'statuses',JSON.stringify(failureStatuses));
  const deliveryState=pushDeliveryPublicState(delivery);return {...deliveryState,deliveryRevision:Number(delivery?.revision||0),deliveryUpdatedAt:delivery?.updatedAt||'',sent:accepted,staleSubscriptionsFound:normalized.staleFound,staleSubscriptionsInvalidated:normalized.staleInvalidated,legacyTargetsExcluded:Number(normalized.legacyExcluded||0),historicalTargetsExcluded:Number(normalized.historicalExcluded||0),configurationError:!!(failureStatuses['401']||failureStatuses['403']),results};
}
async function sendOrderStatusPush(order,status){
  if(!webPushReady||!order)return {skipped:true,reason:webPushConfigError||'push-disabled'};
  const cfg=notificationSettings().statuses?.[status];if(!cfg||cfg.enabled===false)return {skipped:true,reason:'disabled'};
  const all=readJson('push_subscriptions.json',[]),targets=all.filter(x=>pushRecordActive(x)&&((order.userId&&x.userId===order.userId)||(order.customerId&&x.customerId===order.customerId)||(order.deviceId&&x.deviceId===order.deviceId)));if(!targets.length)return {skipped:true,reason:'no-target'};
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
  const rows=readJson('push_subscriptions.json',[]),now=new Date().toISOString(),user=accountUserFromReq(req),deviceId=normalizeDeviceId(req.body.deviceId),oldEndpoint=String(req.body.oldEndpoint||'').trim(),ua=String(req.headers['user-agent']||'').slice(0,500),verifiedAt=String(req.body.subscriptionVerifiedAt||now),rawContext=String(req.body.clientContext||'').toLowerCase(),requestedClientContext=req.body.pwa===true||rawContext==='pwa'?'pwa':(req.body.pwa===false||rawContext==='browser'?'browser':'');
  let i=rows.findIndex(x=>x.endpoint===sub.endpoint&&pushRecordActive(x));if(i<0&&oldEndpoint)i=rows.findIndex(x=>x.endpoint===oldEndpoint&&pushRecordActive(x));
  const previous=i>=0?rows[i]:null,previousContext=pushClientContext(previous||{}),clientContext=previous&&previousContext==='pwa'&&requestedClientContext==='browser'?'pwa':(requestedClientContext||previousContext),pwaObservedAt=clientContext==='pwa'?String(req.body.pwaObservedAt||previous?.pwaObservedAt||verifiedAt):null,row={id:previous?.id||'PUSH-'+crypto.randomUUID(),userId:deviceId?(user?.id||null):(user?.id||previous?.userId||null),customerId:deviceId?(user?.customerId||null):(user?.customerId||previous?.customerId||null),deviceId:deviceId||previous?.deviceId||null,lifecycle:deviceId?'current':'legacy-unbound',deviceRelevance:deviceId?'current':(previous?.deviceRelevance||'legacy-unbound'),deviceStateGeneration:deviceId?CURRENT_DEVICE_STATE_GENERATION:(previous?.deviceStateGeneration||null),currentVerifiedAt:deviceId?verifiedAt:(previous?.currentVerifiedAt||null),currentEndpoint:deviceId?sub.endpoint:(previous?.currentEndpoint||null),authoritativeAt:deviceId?verifiedAt:(previous?.authoritativeAt||null),pwa:clientContext==='pwa',clientContext,notificationPermission:String(req.body.permission||previous?.notificationPermission||'unknown'),pwaObservedAt:pwaObservedAt||previous?.pwaObservedAt||null,endpoint:sub.endpoint,oldEndpoint:oldEndpoint||previous?.oldEndpoint||null,p256dh:sub.keys.p256dh,auth:sub.keys.auth,userAgent:ua||previous?.userAgent||'',pushSubscriptionStatus:'ACTIVE',createdAt:previous?.createdAt||now,updatedAt:now,subscriptionVerifiedAt:verifiedAt,lastPushAttemptAt:previous?.lastPushAttemptAt||null,lastPushAcceptedAt:previous?.lastPushAcceptedAt||previous?.lastPushSuccessAt||null,lastPushSuccessAt:previous?.lastPushSuccessAt||null,lastPushDeviceAckAt:previous?.lastPushDeviceAckAt||null,lastPushDeliveryVerifiedAt:previous?.lastPushDeliveryVerifiedAt||null,lastPushFailureAt:previous?.lastPushFailureAt||null,lastPushFailureStatus:previous?.lastPushFailureStatus||null,lastPushResult:previous?.lastPushResult||null,lastPushHttpStatus:previous?.lastPushHttpStatus??null,lastPushErrorCode:previous?.lastPushErrorCode||null,temporaryFailureAt:null,temporaryFailureCount:0,invalidatedAt:null,permanentInvalidAt:null,lastPushPermanentInvalidAt:null,supersededAt:null};
  if(i>=0)rows[i]=row;else rows.push(row);
  // Aynı gerçek cihazın eski endpointleri audit için superseded/INVALID kalır; belirsiz deviceId'siz kayıtlar silinmez, legacy-unbound olarak ayrılır.
  for(const x of rows)if(x!==row&&pushRecordActive(x)&&((deviceId&&normalizeDeviceId(x.deviceId)===deviceId&&pushClientContext(x)===clientContext&&x.endpoint!==sub.endpoint)||x.endpoint===sub.endpoint))markPushSuperseded(x,now);
  row.deliveryHealthState='healthy';row.deliveryHealthResolvedAt=verifiedAt;row.deliveryHealthResolutionReason='subscription_verified';row.deliveryHealthNextCheckAt=null;row.deliveryHealthPauseStartedAt=null;row.deliveryHealthEstimated=false;row.deliveryHealthEstimatedAt=null;row.deliveryHealthReason=null;classifyOwnerLegacyUnbound(rows,row,now);writeJson('push_subscriptions.json',rows);if(deviceId){setActivityPushState(deviceId,true,{verifiedAt,verifyCurrentGeneration:true});clearDeliveryHealthEstimateOnActivity(deviceId,verifiedAt,'subscription_verified')}
  let persistence={ok:false,skipped:true};try{persistence=await persistAccountStateToGithub()}catch(e){console.error('Push subscribe kalıcı kayıt:',e.message)}
  res.json({ok:true,persisted:!!persistence?.ok||persistRoot!==root,updated:!!previous,subscriptionId:row.id});
});
app.delete('/api/push/unsubscribe',sameOriginGuard,async(req,res)=>{const endpoint=String(req.body?.endpoint||'').trim(),rows=readJson('push_subscriptions.json',[]),now=new Date().toISOString(),removed=rows.filter(x=>x.endpoint===endpoint&&pushRecordActive(x));if(removed.length){for(const x of removed){x.pushSubscriptionStatus='INVALID';x.invalidatedAt=now;x.updatedAt=now;x.lastPushFailureStatus='client_unsubscribe'}writeJson('push_subscriptions.json',rows);for(const d of new Set(removed.map(x=>x.deviceId).filter(Boolean)))if(!rows.some(x=>x.deviceId===d&&pushRecordActive(x)))setActivityPushState(d,false,{verifiedAt:now});try{await persistAccountStateToGithub()}catch(e){console.error('Push unsubscribe kalıcı kayıt:',e.message)}}res.json({ok:true})});
function applyPushDeliveryAck(row={},subscriptionId='',at=new Date().toISOString()){
  subscriptionId=String(subscriptionId||'').trim().slice(0,120);const targets=new Set(Array.isArray(row.targetSubscriptionIds)?row.targetSubscriptionIds:[]);if(!subscriptionId||!targets.has(subscriptionId))return {ok:false,reason:'not-target',row};
  const acked=new Set(Array.isArray(row.ackedSubscriptionIds)?row.ackedSubscriptionIds:[]),duplicate=acked.has(subscriptionId);if(!duplicate)acked.add(subscriptionId);const accepted=Math.max(0,Number(row.providerAccepted||0)),target=Math.max(0,Number(row.targetCount||0)),next={...row,ackedSubscriptionIds:[...acked],deviceAckCount:Math.min(acked.size,accepted,target),updatedAt:at,revision:Number(row.revision||0)+(duplicate?0:1)};
  if(!duplicate)next.targetStates=(Array.isArray(row.targetStates)?row.targetStates:[]).map(x=>String(x?.subscriptionId||'')===subscriptionId?{...x,status:'TESLİM EDİLDİ',deviceAckAt:at}:x);
  return {ok:true,duplicate,row:next};
}
app.post('/api/push/ack',sameOriginGuard,(req,res)=>{
  const deliveryId=String(req.body?.deliveryId||'').trim(),subscriptionId=String(req.body?.subscriptionId||'').trim().slice(0,120),deviceId=normalizeDeviceId(req.body?.deviceId);if(!/^DEL-[0-9a-f-]{20,}$/i.test(deliveryId)||!subscriptionId)return res.status(400).json({ok:false});
  const rows=pushDeliveryLogs(),i=rows.findIndex(x=>x.deliveryId===deliveryId);if(i<0)return res.status(404).json({ok:false});const at=new Date().toISOString(),result=applyPushDeliveryAck(rows[i],subscriptionId,at);if(!result.ok){notificationDebug('PUSH_ACK_REJECTED_NOT_TARGET',{subscriptionState:'unmatched'});return res.status(409).json({ok:false,message:'ACK bu delivery hedeflerinden birine ait değil.'})}if(!result.duplicate){rows[i]=result.row;writePushDeliveryLogs(rows);publishAdminPushDeliveryUpdate(rows[i])}
  const pushRows=readJson('push_subscriptions.json',[]),pushRow=pushRows.find(x=>safePushRecordId(x)===subscriptionId);let bind={bound:false,changed:false,affectedUserIds:[]};if(pushRow&&pushRecordActive(pushRow)){bind=applyPushAckDeviceBinding(pushRows,pushRow,deviceId,accountUserFromReq(req),at);if(bind.changed){writeJson('push_subscriptions.json',pushRows);persistAccountStateAsync()}for(const uid of new Set(bind.affectedUserIds||[]))publishAdminMemberUpdate(uid,'push-ack')}
  notificationDebug('PUSH_DEVICE_ACK',{userId:pushRow?.userId,deviceId:bind.bound?deviceId:pushRow?.deviceId,subscriptionState:'active'});res.json({ok:true,duplicate:result.duplicate,deviceBound:!!bind.bound,ownershipConflict:!!bind.ownershipConflict,deviceAckCount:Number(rows[i].deviceAckCount||0),revision:Number(rows[i].revision||0)});
});
app.get('/api/admin/push/deliveries/:id',requireAdmin,(req,res)=>{const row=pushDeliveryLogs().find(x=>x.deliveryId===String(req.params.id));if(!row)return res.status(404).json({ok:false});res.json({ok:true,delivery:pushDeliveryPublicState(row)})});
function normalizeManualPushTarget(raw){const value=String(raw||'').trim();if(!value)return '/';try{const relative=/^\/(?!\/)/.test(value),u=relative?new URL(value,SHAZ_ORIGIN):new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;return u.origin===SHAZ_ORIGIN?(u.pathname+u.search+u.hash):u.href}catch(_){return null}}
function rememberManualPushTitle(title){title=String(title||'').trim().slice(0,80);if(!title)return notificationSettings().manualTitleHistory;const settings=notificationSettings(),key=title.toLocaleLowerCase('tr-TR'),next=[title,...(settings.manualTitleHistory||[]).filter(x=>String(x).trim().toLocaleLowerCase('tr-TR')!==key)].slice(0,20);settings.manualTitleHistory=next;writeJson('notification_settings.json',settings);return next}
function resolveManualPushScope(body={},users=[],pushRows=[]){
  const scope=String(body.scope||'').trim().toLowerCase(),legacySelected=!scope&&Array.isArray(body.userIds),selectedScope=scope==='selected'||legacySelected;
  if(scope&&!['selected','members','all'].includes(scope))return {ok:false,status:400,message:'Geçersiz bildirim kapsamı.'};
  const activeUsers=(Array.isArray(users)?users:[]).filter(x=>!x.deleted),targetUserIds=new Set((Array.isArray(body.userIds)?body.userIds:[]).map(x=>String(x||'').trim()).filter(Boolean));
  if(selectedScope&&!targetUserIds.size)return {ok:false,status:400,message:'Seçili kullanıcı bulunamadı.'};
  const selectedUsers=selectedScope?activeUsers.filter(x=>targetUserIds.has(String(x.id||''))):[];
  if(selectedScope&&selectedUsers.length!==targetUserIds.size)return {ok:false,status:400,message:'Seçili kullanıcı bulunamadı.'};
  const memberScope=scope==='members'||(!scope&&body.membersOnly===true&&!selectedScope),memberUserIds=new Set(activeUsers.map(x=>String(x.id||'')).filter(Boolean)),memberCustomerIds=new Set(activeUsers.map(x=>String(x.customerId||'')).filter(Boolean)),targetCustomerIds=new Set(selectedUsers.map(x=>String(x.customerId||'')).filter(Boolean));
  const manualTargets=(Array.isArray(pushRows)?pushRows:[]).filter(x=>pushRecordActive(x)&&(selectedScope?(x.userId?targetUserIds.has(String(x.userId)):targetCustomerIds.has(String(x.customerId||''))):memberScope?(x.userId?memberUserIds.has(String(x.userId)):memberCustomerIds.has(String(x.customerId||''))):true));
  return {ok:true,scope:selectedScope?'selected':memberScope?'members':'all',selectedScope,memberScope,targetUserIds,selectedUsers,activeUsers,manualTargets};
}
app.post('/api/admin/push/send',sameOriginGuard,requireAdmin,async(req,res)=>{
  if(!webPushReady)return res.status(503).json({ok:false,message:'Web Push yapılandırması aktif değil: '+(webPushConfigError||'VAPID geçersiz.')});
  const rawTitle=String(req.body.title??'').trim().slice(0,80),rawBody=String(req.body.body??'').trim().slice(0,240),rawUrl=String(req.body.url??'').trim(),clientRequestId=String(req.body.clientRequestId||'').trim().slice(0,120);if(!rawBody)return res.status(400).json({ok:false,message:'Bildirim açıklaması boş bırakılamaz.'});
  if(clientRequestId){const old=pushSendIdempotency.get(clientRequestId);if(old&&Date.now()-old.at<15000)return res.json(old.response)}
  const url=normalizeManualPushTarget(rawUrl);if(!url)return res.status(400).json({ok:false,message:'URL yalnızca geçerli site yolu veya http/https web adresi olabilir.'});
  // Manuel bildirimde admin başlığı ve açıklamayı ayrı tut. Platform fallback kararı Service Worker'da verilir.
  const payload={type:'manual',title:rawTitle,titleProvided:!!rawTitle,body:rawBody,icon:'/icon-192.png?v=175',badge:'/icon-192.png?v=175',url,data:{url}};
  const users=readJson('users.json',[]),scopeResult=resolveManualPushScope(req.body||{},users,readJson('push_subscriptions.json',[]));if(!scopeResult.ok)return res.status(scopeResult.status||400).json({ok:false,message:scopeResult.message||'Seçili kullanıcı bulunamadı.'});
  const {selectedScope,memberScope,selectedUsers,activeUsers,manualTargets}=scopeResult;
  const result=await sendPushRows(manualTargets,payload,{kind:'manual',ttl:24*60*60,urgency:'normal'});result.selectedMemberCount=selectedScope?selectedUsers.length:0;result.memberScopeCount=selectedScope?selectedUsers.length:(memberScope?activeUsers.length:0);result.selectedMemberNames=selectedScope?selectedUsers.map(x=>[x.firstName,x.lastName].filter(Boolean).join(' ')||x.email||x.id):[];result.scope=scopeResult.scope;let titleHistory=notificationSettings().manualTitleHistory;
  if(rawTitle&&result.providerAccepted>0){titleHistory=rememberManualPushTitle(rawTitle);try{await persistAccountStateToGithub()}catch(e){console.error('Manuel push başlık geçmişi kalıcı kayıt:',e.message)}}
  const response={ok:true,...result,deviceAckCount:Number(result.deviceAckCount||0),pendingAck:Number(result.pendingAck??result.providerAccepted??0),titleHistory};
  if(clientRequestId){pushSendIdempotency.set(clientRequestId,{at:Date.now(),response});for(const [k,v] of pushSendIdempotency)if(Date.now()-v.at>60000)pushSendIdempotency.delete(k)}
  res.json(response);
});
function handlePresence(req,res){const deviceId=normalizeDeviceId(req.body?.deviceId);if(!deviceId)return res.status(400).json({ok:false,message:'Geçersiz cihaz kimliği.'});if(rateLimitHit(req,'activity-heartbeat',240,60*1000))return res.status(429).json({ok:false,message:'Çok fazla presence isteği.'});const exists=activityRows().some(x=>String(x.deviceId||'')===deviceId);if(!exists&&rateLimitHit(req,'activity-new-device',30,60*60*1000))return res.status(429).json({ok:false,message:'Çok fazla yeni cihaz kaydı. Lütfen daha sonra tekrar deneyin.'});recordCustomerPresence(req,{...(req.body||{}),deviceId});res.setHeader('Cache-Control','no-store');res.json({ok:true,serverReceivedAt:new Date().toISOString(),ttlMs:PRESENCE_ONLINE_MS})}
app.post('/api/activity/presence',sameOriginGuard,handlePresence);
// Eski istemciler /visit çağırsa bile artık login geçmişi üretmez; yalnız presence günceller.
app.post('/api/activity/visit',sameOriginGuard,handlePresence);
app.get('/api/admin/integrations/marketing/dry-run',requireAdmin,(req,res)=>res.json({ok:true,dryRun:true,mutation:false,report:marketingDryRun(),flags:{resendMarketing:RESEND_MARKETING_SYNC_ENABLED,verimorSms:VERIMOR_SMS_ENABLED,verimorWebhook:VERIMOR_WEBHOOK_ENABLED,verimorIys:VERIMOR_IYS_SYNC_ENABLED,verimorIysPush:VERIMOR_IYS_PUSH_ENABLED}}));
app.post('/api/admin/integrations/marketing/reconcile',requireAdmin,sameOriginGuard,(req,res)=>{if(req.body?.confirm!==true)return res.status(400).json({ok:false,message:'Gerçek reconcile için confirm=true gereklidir.',dryRun:marketingDryRun()});if(!RESEND_MARKETING_SYNC_ENABLED&&!VERIMOR_IYS_SYNC_ENABLED)return res.status(409).json({ok:false,message:'Provider sync feature flagleri kapalı. Önce dry-run ve panel ayarlarını tamamlayın.'});const queued=enqueueCurrentConsentReconcile();persistAccountStateAsync();res.json({ok:true,queued,report:marketingDryRun()})});
app.post('/api/admin/integrations/outbox/process',requireAdmin,sameOriginGuard,async(req,res)=>{const count=await processIntegrationOutbox(Math.max(1,Math.min(100,Number(req.body?.limit||20))));persistAccountStateAsync();res.json({ok:true,processed:count,report:marketingDryRun()})});
app.post('/api/internal/integrations/process-outbox',async(req,res)=>{if(!INTEGRATION_WORKER_SECRET||!timingSafeText(String(req.headers.authorization||'').replace(/^Bearer\s+/i,''),INTEGRATION_WORKER_SECRET))return res.status(401).end();const count=await processIntegrationOutbox(50);persistAccountStateAsync();res.json({ok:true,processed:count})});
app.get('/api/admin/activity-stream',requireAdmin,(req,res)=>{res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-store, no-cache, no-transform');res.setHeader('Connection','keep-alive');res.flushHeaders?.();res.write('event: ready\ndata: {}\n\n');adminActivityStreams.add(res);const keep=setInterval(()=>{try{res.write(': keepalive\n\n')}catch(_){}},25000);req.on('close',()=>{clearInterval(keep);adminActivityStreams.delete(res)})});
app.get('/api/admin/notification-settings',requireAdmin,(req,res)=>res.json({ok:true,settings:notificationSettings(),pushStats:pushStats()}));
app.put('/api/admin/notification-settings',requireAdmin,(req,res)=>{const current=notificationSettings(),incoming=req.body?.statuses||{};for(const k of ['new','prepared','shipped','delivered'])if(incoming[k])current.statuses[k]={enabled:incoming[k].enabled!==false,title:String(incoming[k].title||'SHAZ').slice(0,80),body:String(incoming[k].body||'').slice(0,240)};writeJson('notification_settings.json',current);persistAccountStateAsync();res.json({ok:true,settings:current})});
app.get('/api/admin/customers-all',requireAdmin,(req,res)=>{
  const users=readJson('users.json',[]),orders=readJson('orders.json',[]),push=readJson('push_subscriptions.json',[]),acts=activityRows(),logins=loginEventRows(),memberRows=adminMemberRows(),memberById=new Map(memberRows.map(x=>[String(x.id),x])),map=new Map();
  const add=(key,base)=>{if(!map.has(key))map.set(key,{key,name:'',phone:'',email:'',member:false,orderCount:0,lastOrderAt:'',lastOrderStatus:'',lastOrderTotal:0,pushActive:false,notificationStatus:'Doğrulanamadı',pwaStatus:'Tespit Edilemedi',appStatus:'Tespit Edilemedi',firstPwaAt:'',lastPwaAt:'',lastSeenAt:'',lastNotificationAt:'',visitCount:0,visits:[],orders:[],_activityRows:[],_pushRows:[],...base});return map.get(key)};
  for(const u of users){const key='u:'+u.id,m=memberById.get(String(u.id))||{},r=add(key,{name:[u.firstName,u.lastName].filter(Boolean).join(' '),phone:u.phone||'',email:u.email||'',member:true,userId:u.id,customerId:u.customerId,disabled:!!u.disabled,createdAt:u.createdAt||'',lastLoginAt:m.lastLoginAt||'',loginMethod:(m.loginEvents||[]).at(-1)?.loginMethod||(m.loginEvents||[]).at(-1)?.provider||'',smsMarketingConsent:!!u.smsMarketingConsent,emailMarketingConsent:!!u.emailMarketingConsent,appStatus:m.appStatus||'Tespit Edilemedi',pwaStatus:m.appStatus||'Tespit Edilemedi',notificationStatus:m.notificationStatus||'Doğrulanamadı',pushActive:!!m.pushActive,presenceStatus:m.presenceStatus==='Aktif'?'Çevrimiçi':'Çevrimdışı',address:m.address||'',addresses:m.addresses||[],couponCount:Number(m.couponCount||0),coupons:m.coupons||[]});const a=acts.filter(x=>x.userId===u.id||x.customerId===u.customerId),userLogins=logins.filter(x=>x.userId===u.id).sort((x,y)=>new Date(x.serverTimestamp||x.at||0)-new Date(y.serverTimestamp||y.at||0));r._activityRows=a;r._pushRows=push.filter(x=>x.userId===u.id||x.customerId===u.customerId);r.visits=userLogins.map(x=>x.serverTimestamp||x.at).filter(Boolean);r.visitCount=r.visits.length;r.lastSeenAt=r.lastLoginAt||r.visits.at(-1)||a.map(x=>x.lastSeenAt).filter(Boolean).sort().at(-1)||'';r.firstPwaAt=a.map(x=>x.firstPwaAt).filter(Boolean).sort()[0]||'';r.lastPwaAt=a.map(x=>x.lastPwaAt).filter(Boolean).sort().at(-1)||''}
  for(const o of orders){const c=o.customer||{},strongGuest=String(c.phone||'').trim()+'|'+String(c.email||'').trim(),key=o.userId?'u:'+o.userId:o.customerId?'c:'+o.customerId:'g:'+crypto.createHash('sha1').update(strongGuest).digest('hex').slice(0,12),r=add(key,{name:c.fullName||[c.firstName,c.lastName].filter(Boolean).join(' '),phone:c.phone||'',email:c.email||'',member:!!o.userId,customerId:o.customerId||null,userId:o.userId||null});r.orderCount++;r.orders.push({id:o.id,createdAt:o.createdAt||'',status:o.status||'',total:Number(o.total||0)});if(!r.lastOrderAt||new Date(o.createdAt)>new Date(r.lastOrderAt)){r.lastOrderAt=o.createdAt;r.lastOrderStatus=o.status||'';r.lastOrderTotal=Number(o.total||0)}const relatedActs=acts.filter(x=>(o.userId&&x.userId===o.userId)||(o.customerId&&x.customerId===o.customerId)||(o.deviceId&&x.deviceId===o.deviceId)),relatedPush=push.filter(x=>(o.userId&&x.userId===o.userId)||(o.customerId&&x.customerId===o.customerId)||(o.deviceId&&x.deviceId===o.deviceId));r._activityRows=[...new Map([...(r._activityRows||[]),...relatedActs].map(x=>[x.id||x.deviceId,x])).values()];r._pushRows=[...new Map([...(r._pushRows||[]),...relatedPush].map(x=>[safePushRecordId(x),x])).values()];if(!r.member){r.visits=[...new Set([...r.visits,...relatedActs.flatMap(x=>x.visits||[])])].sort();r.visitCount=r.visits.length}r.lastSeenAt=[r.lastSeenAt,...relatedActs.map(x=>x.lastSeenAt)].filter(Boolean).sort().at(-1)||'';r.orders.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))}
  for(const r of map.values()){if(!r.member){const allPush=(r._pushRows||[]),allActivePush=allPush.filter(pushRecordActive),deviceStates=(r._activityRows||[]).map(a=>{const rows=allPush.filter(x=>a.deviceId&&x.deviceId===a.deviceId),currentRows=rows.filter(x=>pushRecordCurrentRelevant(x)),lastAck=latestIso(currentRows.map(x=>x.lastPushDeviceAckAt)),lastPermanent=latestIso(rows.map(x=>x.lastPushPermanentInvalidAt||x.permanentInvalidAt)),currentRelevant=isCurrentRelevantDevice(a,rows),st=deviceNotificationState({...a,lastPushDeviceAckAt:lastAck,lastPushPermanentInvalidAt:lastPermanent},currentRows.length>0);return {notificationStatus:st.summary,aggregateEligible:currentRelevant}}),currentActs=(r._activityRows||[]).filter(a=>isCurrentRelevantDevice(a,allPush.filter(x=>a.deviceId&&x.deviceId===a.deviceId)));r.pushActive=allActivePush.some(x=>pushRecordTargetEligible(x)&&pushRecordCurrentRelevant(x));r.notificationStatus=aggregateNotificationStatus(deviceStates);const pwaStates=currentActs.map(a=>devicePwaState(a,allPush.filter(x=>a.deviceId&&x.deviceId===a.deviceId)));r.appStatus=pwaStates.some(x=>x.state==='VERIFIED_INSTALLED')?'Yüklü':pwaStates.some(x=>x.state==='OPERATIONALLY_NOT_INSTALLED')?'Yüklü Değil':pwaStates.some(x=>x.state==='PROBABLY_INSTALLED')?'Muhtemelen':'Tespit Edilemedi';r.pwaStatus=r.appStatus}delete r._activityRows;delete r._pushRows}
  const list=[...map.values()].sort((a,b)=>new Date(b.lastSeenAt||b.lastOrderAt||0)-new Date(a.lastSeenAt||a.lastOrderAt||0)),stats={total:list.length,members:list.filter(x=>x.member).length,guests:list.filter(x=>!x.member).length,pushActive:list.filter(x=>x.pushActive).length,pwaActive:list.filter(x=>x.appStatus==='Yüklü').length,notificationOpen:list.filter(x=>x.notificationStatus==='Açık').length};res.json({ok:true,customers:list,stats});
});
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
  recordLocalMarketingDecision({req,user,channel:'sms',granted:!!pending.smsMarketingConsent,source:'signup',recipient:user.phone,at:now});
  recordLocalMarketingDecision({req,user,channel:'email',granted:!!pending.emailMarketingConsent,source:'signup',recipient:user.email,at:now});
  cancelStaleMarketingJobs(id,'sms',now);cancelStaleMarketingJobs(id,'email',now);assignNewMemberCoupons(id,now);
  writeJson('pending_registrations.json',rows.filter(x=>x.id!==pending.id));await persistAccountStateToGithub().catch(e=>{console.error('Üyelik doğrulama kalıcı kayıt:',e);throw e});const sessionId='SES-'+crypto.randomUUID();recordAccountLogin(req,user,'password',req.body?.authEventId,sessionId);persistAccountStateAsync();setUserSession(res,user,req,sessionId);publishAdminMemberUpdate(user.id,'signup');clearRegistrationChallengeCookie(res,req);return res.json({ok:true,user:publicUser(user)});
}));
app.post('/api/auth/login',sameOriginGuard,(req,res)=>{if(rateLimitHit(req,'login',80,15*60*1000))return res.status(429).json({ok:false,message:'Çok fazla giriş isteği. Lütfen biraz sonra tekrar deneyin.'});const login=String(req.body.login??req.body.email??'').trim(),attemptKeys=accountLoginAttemptKeys(req,login),blockedKey=attemptKeys.find(k=>Number(accountAttemptState(k).blockedUntil||0)>Date.now());if(blockedKey)return res.status(429).json({ok:false,message:accountBlockedMessage(blockedKey),remainingAttempts:0});const email=normalizeEmail(login),phone=normalizeAccountPhone(login),users=readJson('users.json',[]),matches=users.filter(x=>x.email===email||(phone&&normalizeAccountPhone(x.phone)===phone)),u=matches.find(x=>!x.deleted)||matches[0];if(u?.deleted)return res.status(403).json({ok:false,message:'Bu kullanıcı silinmiştir. Aynı bilgilerle baştan yeni bir hesap oluşturabilirsiniz.'});if(!u||!passwordMatches(req.body.password,u)){const remainings=attemptKeys.map(accountFailKey),remaining=Math.min(...remainings);if(remaining<=0){const key=attemptKeys.find(k=>Number(accountAttemptState(k).blockedUntil||0)>Date.now())||attemptKeys[0];return res.status(429).json({ok:false,message:accountBlockedMessage(key),remainingAttempts:0})}return res.status(401).json({ok:false,message:`E-posta/telefon veya şifre hatalı. ${remaining} hakkınız kaldı.`,remainingAttempts:remaining})}if(u.disabled)return res.status(403).json({ok:false,message:'Bu üyelik yönetim tarafından iptal edilmiş.'});attemptKeys.forEach(clearAccountLoginAttempts);const sessionId='SES-'+crypto.randomUUID();recordAccountLogin(req,u,'password',req.body?.authEventId,sessionId);persistAccountStateAsync();setUserSession(res,u,req,sessionId);res.json({ok:true,user:publicUser(u)})});
app.post('/api/auth/logout',sameOriginGuard,(req,res)=>{const u=accountUserFromReq(req),deviceId=req.body?.deviceId;markDeviceSignedOut(deviceId,u?.id||'');unbindDeviceAccountOwnership(deviceId,u?.id||'');clearUserSession(res,req);persistAccountStateAsync();res.json({ok:true})});
app.get('/api/auth/me',(req,res)=>{res.setHeader('Cache-Control','no-store');const u=accountUserFromReq(req);if(u)recordAccountVisit(req,u,req.query?.visitSessionId);res.json({ok:true,authenticated:!!u,user:publicUser(u)})});
app.patch('/api/account/marketing-consent',sameOriginGuard,requireUser,async(req,res)=>serializedMutation('accounts',async()=>{
  const channel=String(req.body?.channel||'').toLowerCase(),granted=req.body?.granted===true;if(!['sms','email'].includes(channel))return res.status(400).json({ok:false,message:'Geçersiz izin kanalı.'});
  const users=readJson('users.json',[]),i=users.findIndex(x=>x.id===req.accountUser.id);if(i<0)return res.status(401).json({ok:false,message:'Giriş yapmanız gerekiyor.'});const beforeUsers=JSON.parse(JSON.stringify(users)),beforeConsents=readJson('marketing_consents.json',[]),beforeIntegrationState=integrationState(),beforeOutbox=readJson('integration_outbox.json',[]),u=users[i],key=channel==='sms'?'smsMarketingConsent':'emailMarketingConsent',old=!!u[key];
  if(old===granted)return res.json({ok:true,user:publicUser(u),changed:false});const now=new Date().toISOString();u[key]=granted;u.updatedAt=now;pushProfileHistory(u,channel==='sms'?'SMS İzni':'E-posta İzni',old?'Açık':'Kapalı',granted?'Açık':'Kapalı','account-settings');users[i]=u;writeJson('users.json',users);recordLocalMarketingDecision({req,user:u,channel,granted,source:'account-settings',recipient:channel==='sms'?u.phone:u.email,at:now,previousGranted:old});cancelStaleMarketingJobs(u.id,channel,now);
  try{await persistAccountStateToGithub()}catch(e){writeJson('users.json',beforeUsers);writeJson('marketing_consents.json',beforeConsents);writeJson('marketing_integration_state.json',beforeIntegrationState);writeJson('integration_outbox.json',beforeOutbox);throw e}
  publishAdminMemberUpdate(u.id,'consent');return res.json({ok:true,user:publicUser(u),changed:true,serverTimestamp:now});
}));
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
    u.pendingPhoneChange={changeId:'PC-'+crypto.randomUUID(),userId:u.id,phone,requestedAt:now,expiresAt:new Date(Date.now()+PROFILE_VERIFY_TTL_MS).toISOString()};pendingMessage='Yeni telefon numaranıza doğrulama kodu gönderildi. Doğrulanana kadar mevcut numaranız aktif kalır.';
  }
  if(nameChanged){pushProfileHistory(u,'Ad / Soyad',[u.firstName,u.lastName].filter(Boolean).join(' '),[firstName,lastName].filter(Boolean).join(' '));u.firstName=firstName;u.lastName=lastName;meta.nameChangedAt=now}
  if(birthChanged){pushProfileHistory(u,'Doğum Tarihi',u.birthDate||'',birthDate);u.birthDate=birthDate;meta.birthDateUserChangeCount+=1}
  const oldSms=!!u.smsMarketingConsent,oldMail=!!u.emailMarketingConsent,newSms=oldSms,newMail=oldMail;
  if(oldSms!==newSms)pushProfileHistory(u,'SMS İzni',oldSms?'Açık':'Kapalı',newSms?'Açık':'Kapalı');if(oldMail!==newMail)pushProfileHistory(u,'E-posta İzni',oldMail?'Açık':'Kapalı',newMail?'Açık':'Kapalı');
  u.smsMarketingConsent=newSms;u.emailMarketingConsent=newMail;u.profileChangeMeta=meta;u.updatedAt=now;users[i]=u;writeJson('users.json',users);
  const customers=readJson('customers.json',[]),ci=customers.findIndex(c=>c.id===u.customerId);if(ci>=0){Object.assign(customers[ci],{firstName:u.firstName,lastName:u.lastName,email:u.email,phone:u.phone,updatedAt:now});writeJson('customers.json',customers)}
  if(oldSms!==newSms){recordLocalMarketingDecision({req,user:u,channel:'sms',granted:newSms,source:'account-settings',recipient:u.phone,at:now,previousGranted:oldSms});cancelStaleMarketingJobs(u.id,'sms',now)}
  if(oldMail!==newMail){recordLocalMarketingDecision({req,user:u,channel:'email',granted:newMail,source:'account-settings',recipient:u.email,at:now,previousGranted:oldMail});cancelStaleMarketingJobs(u.id,'email',now)}
  await persistAccountStateToGithub().catch(e=>{console.error('Hesap kalıcı kayıt:',e);throw e});publishAdminMemberUpdate(u.id,'profile');res.json({ok:true,user:publicUser(u),pendingPhoneVerification:phoneChanged,message:pendingMessage||'Hesap bilgileri güncellendi.'});
}));

app.post('/api/account/email-change/start',sameOriginGuard,requireUser,async(req,res)=>serializedMutation('accounts',async()=>{
  if(rateLimitHit(req,'email-change-start',12,15*60*1000))return res.status(429).json({ok:false,message:'Çok fazla e-posta değişikliği isteği. Lütfen biraz sonra tekrar deneyin.'});
  if(!USER_SESSION_SECRET||!RESEND_API_KEY)return res.status(503).json({ok:false,message:'E-posta doğrulama servisi şu anda kullanılamıyor.'});
  const users=readJson('users.json',[]),i=users.findIndex(x=>x.id===req.accountUser.id);if(i<0)return res.status(401).json({ok:false,message:'Giriş yapmanız gerekiyor.'});const u=users[i],target=normalizeEmail(req.body.email),current=normalizeEmail(u.email);
  if(!target||!target.includes('@'))return res.status(400).json({ok:false,message:'Geçerli bir yeni e-posta adresi girin.'});if(target===current)return res.status(400).json({ok:false,message:'Yeni e-posta adresi mevcut e-posta adresinizle aynı.'});
  if(u.passwordHash&&!passwordMatches(req.body.currentPassword,u))return res.status(400).json({ok:false,message:'Mevcut şifreniz hatalı.'});
  if(users.some(x=>x.id!==u.id&&!x.deleted&&normalizeEmail(x.email)===target))return res.status(409).json({ok:false,message:'Bu e-posta adresi başka bir hesapta kullanılıyor.'});
  if(verificationMailRateHit(req,target,6,60*60*1000))return res.status(429).json({ok:false,message:'Çok fazla doğrulama e-postası istendi. Lütfen daha sonra tekrar deneyin.'});
  const code=newRegistrationOtp(),now=new Date(),previous=u.pendingEmailChange?{...u.pendingEmailChange}:null,pending={changeId:'EC-'+crypto.randomUUID(),purpose:'email_change',userId:u.id,email:target,verificationCodeHash:emailChangeOtpHash(u.id,target,code),requestedAt:now.toISOString(),expiresAt:new Date(now.getTime()+EMAIL_CHANGE_OTP_TTL_MS).toISOString(),resendAt:new Date(now.getTime()+EMAIL_CHANGE_RESEND_COOLDOWN_MS).toISOString(),attemptCount:0};
  u.pendingEmailChange=pending;u.updatedAt=now.toISOString();users[i]=u;writeJson('users.json',users);try{await persistAccountStateToGithub()}catch(e){u.pendingEmailChange=previous;writeJson('users.json',users);throw e}
  let sent=false;try{sent=await sendEmailChangeVerificationMail(target,code)}catch(e){console.error('E-posta değişikliği doğrulama maili:',e?.message||e)}
  if(!sent){u.pendingEmailChange=previous;u.updatedAt=new Date().toISOString();users[i]=u;writeJson('users.json',users);try{await persistAccountStateToGithub()}catch(e){console.error('E-posta değişikliği rollback kalıcı kayıt:',e)}return res.status(502).json({ok:false,message:'Doğrulama e-postası gönderilemedi. Mevcut e-posta adresiniz değiştirilmedi.'})}
  return res.json({ok:true,pendingEmail:maskRegistrationEmail(target),changeId:pending.changeId,expiresAt:pending.expiresAt,resendAt:pending.resendAt,passwordReverified:!!u.passwordHash});
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
  return res.json({ok:true,pendingEmail:maskRegistrationEmail(next.email),changeId:next.changeId||null,expiresAt:next.expiresAt,resendAt:next.resendAt});
}));

app.post('/api/account/email-change/cancel',sameOriginGuard,requireUser,async(req,res)=>serializedMutation('accounts',async()=>{
  const users=readJson('users.json',[]),i=users.findIndex(x=>x.id===req.accountUser.id);if(i<0)return res.status(401).json({ok:false,message:'Giriş yapmanız gerekiyor.'});users[i].pendingEmailChange=null;users[i].updatedAt=new Date().toISOString();writeJson('users.json',users);await persistAccountStateToGithub().catch(e=>{console.error('E-posta değişikliği iptal kalıcı kayıt:',e);throw e});return res.json({ok:true,user:publicUser(users[i])});
}));

app.post('/api/account/email-change/verify',sameOriginGuard,requireUser,async(req,res)=>serializedMutation('accounts',async()=>{
  if(rateLimitHit(req,'email-change-verify',40,15*60*1000))return res.status(429).json({ok:false,message:'Çok fazla doğrulama denemesi. Lütfen biraz sonra tekrar deneyin.'});
  const code=String(req.body.code||'').replace(/\D/g,'').slice(0,6),keepMarketing=req.body.keepMarketing===true||String(req.body.keepMarketing||'').toLowerCase()==='true',changeId=String(req.body.changeId||'').trim();if(code.length!==6)return res.status(400).json({ok:false,message:'6 haneli doğrulama kodunu girin.'});
  const users=readJson('users.json',[]),i=users.findIndex(x=>x.id===req.accountUser.id),u=users[i],pending=u?.pendingEmailChange;if(!u)return res.status(401).json({ok:false,message:'Giriş yapmanız gerekiyor.'});if(!pending){if(changeId&&u.lastVerifiedEmailChange?.changeId===changeId)return res.json({ok:true,user:publicUser(u),message:'E-posta adresiniz güncellendi.'});return res.status(404).json({ok:false,message:'Bekleyen e-posta değişikliği bulunamadı.'})}if(pending.purpose!=='email_change'||pending.userId!==u.id||changeId&&pending.changeId&&changeId!==pending.changeId)return res.status(409).json({ok:false,message:'Bu e-posta değişikliği isteği artık geçerli değil.'});
  if(new Date(pending.expiresAt||0).getTime()<=Date.now())return res.status(410).json({ok:false,message:'Doğrulama kodunun süresi doldu. Yeni kod isteyin.'});if(Number(pending.attemptCount||0)>=5||!pending.verificationCodeHash)return res.status(429).json({ok:false,message:'Doğrulama kodu geçersiz hale geldi. Yeni kod isteyin.'});
  const expected=emailChangeOtpHash(u.id,pending.email,code);if(!safeEqual(expected,pending.verificationCodeHash)){pending.attemptCount=Number(pending.attemptCount||0)+1;if(pending.attemptCount>=5){pending.verificationCodeHash='';pending.expiresAt=new Date().toISOString()}u.pendingEmailChange=pending;u.updatedAt=new Date().toISOString();users[i]=u;writeJson('users.json',users);await persistAccountStateToGithub().catch(e=>console.error('E-posta OTP deneme kalıcı kayıt:',e));const left=Math.max(0,5-pending.attemptCount);return res.status(400).json({ok:false,message:left?`Doğrulama kodu hatalı. ${left} deneme hakkınız kaldı.`:'Doğrulama kodu geçersiz hale geldi. Yeni kod isteyin.',attemptsRemaining:left})}
  const email=normalizeEmail(pending.email);if(users.some(x=>x.id!==u.id&&!x.deleted&&normalizeEmail(x.email)===email))return res.status(409).json({ok:false,message:'Bu e-posta adresi başka bir hesapta kullanılıyor. Mevcut e-posta adresiniz değiştirilmedi.'});
  const beforeUsers=JSON.parse(JSON.stringify(users)),customers=readJson('customers.json',[]),beforeCustomers=JSON.parse(JSON.stringify(customers)),beforeConsents=readJson('marketing_consents.json',[]),beforeIntegrationState=integrationState(),beforeOutbox=readJson('integration_outbox.json',[]),oldEmail=u.email,oldMarketing=!!u.emailMarketingConsent,now=new Date().toISOString();
  pushProfileHistory(u,'E-posta',oldEmail,email,'verified_email_change');if(oldMarketing!==keepMarketing)pushProfileHistory(u,'E-posta İzni',oldMarketing?'Açık':'Kapalı',keepMarketing?'Açık':'Kapalı','verified_email_change');u.email=email;u.emailVerifiedAt=now;u.emailMarketingConsent=keepMarketing;u.lastVerifiedEmailChange={changeId:pending.changeId||changeId||null,email,completedAt:now,keepMarketing};u.pendingEmailChange=null;u.profileChangeMeta={...profileChangeMeta(u),emailChangedAt:now};u.updatedAt=now;users[i]=u;
  const ci=customers.findIndex(c=>c.id===u.customerId||c.userId===u.id);if(ci>=0){customers[ci].email=email;customers[ci].updatedAt=now}
  try{writeJson('users.json',users);if(ci>=0)writeJson('customers.json',customers);recordContactChangeMarketingDecision({req,user:u,channel:'email',granted:keepMarketing,recipient:email,previousRecipient:oldEmail,at:now,previousGranted:oldMarketing});await persistAccountStateToGithub()}
  catch(e){try{writeJson('users.json',beforeUsers);if(ci>=0)writeJson('customers.json',beforeCustomers);writeJson('marketing_consents.json',beforeConsents);writeJson('marketing_integration_state.json',beforeIntegrationState);writeJson('integration_outbox.json',beforeOutbox)}catch(rollbackErr){console.error('E-posta değişikliği rollback:',rollbackErr)}throw e}
  publishAdminMemberUpdate(u.id,'consent');try{await sendEmailChangedSecurityMail(oldEmail,email)}catch(e){console.error('Eski e-posta güvenlik bildirimi:',e?.message||e)}
  return res.json({ok:true,user:publicUser(u),message:'E-posta adresiniz güncellendi.'});
}));

app.get('/api/account/verify-email-change',(req,res)=>{res.status(410).setHeader('Cache-Control','no-store');res.send('Bu eski e-posta doğrulama bağlantısı artık kullanılmıyor. Hesap Bilgilerim ekranından e-posta değişikliğini yeniden başlatın.')});
app.post('/api/account/verify-email-change',sameOriginGuard,(req,res)=>res.status(410).json({ok:false,message:'Bu eski doğrulama yöntemi artık kullanılmıyor. Hesap Bilgilerim ekranından e-posta değişikliğini yeniden başlatın.'}));

app.post('/api/account/verify-phone-change',sameOriginGuard,requireUser,async(req,res)=>serializedMutation('accounts',async()=>{
  const users=readJson('users.json',[]),i=users.findIndex(x=>x.id===req.accountUser.id),u=users[i],pending=u?.pendingPhoneChange,code=String(req.body.code||'').trim(),keepMarketing=req.body.keepMarketing===true||String(req.body.keepMarketing||'').toLowerCase()==='true',changeId=String(req.body.changeId||'').trim();if(!u)return res.status(401).json({ok:false,message:'Giriş yapmanız gerekiyor.'});if(!pending){if(changeId&&u.lastVerifiedPhoneChange?.changeId===changeId)return res.json({ok:true,user:publicUser(u)});return res.status(400).json({ok:false,message:'Bekleyen telefon numarası değişikliği yok.'})}if(pending.userId&&pending.userId!==u.id||changeId&&pending.changeId&&changeId!==pending.changeId)return res.status(409).json({ok:false,message:'Bu telefon değişikliği isteği artık geçerli değil.'});if(new Date(pending.expiresAt).getTime()<Date.now())return res.status(400).json({ok:false,message:'Telefon doğrulama süresi dolmuş. Değişikliği yeniden başlatın.'});
  const ok=await SmsVerificationProvider.verifyOtp(pending.phone,code,u.id);if(!ok)return res.status(400).json({ok:false,message:'Doğrulama kodu hatalı veya süresi dolmuş.'});if(users.some(x=>x.id!==u.id&&normalizeAccountPhone(x.phone)===pending.phone))return res.status(409).json({ok:false,message:'Bu telefon numarası başka bir hesapta kullanılıyor.'});
  const beforeUsers=JSON.parse(JSON.stringify(users)),customers=readJson('customers.json',[]),beforeCustomers=JSON.parse(JSON.stringify(customers)),beforeConsents=readJson('marketing_consents.json',[]),beforeIntegrationState=integrationState(),beforeOutbox=readJson('integration_outbox.json',[]),old=normalizeAccountPhone(u.phone)||u.phone,oldMarketing=!!u.smsMarketingConsent,now=new Date().toISOString();
  pushProfileHistory(u,'Telefon',old,pending.phone,'verified_phone_change');if(oldMarketing!==keepMarketing)pushProfileHistory(u,'SMS İzni',oldMarketing?'Açık':'Kapalı',keepMarketing?'Açık':'Kapalı','verified_phone_change');u.phone=pending.phone;u.phoneVerifiedAt=now;u.smsMarketingConsent=keepMarketing;u.lastVerifiedPhoneChange={changeId:pending.changeId||changeId||null,phone:pending.phone,completedAt:now,keepMarketing};u.pendingPhoneChange=null;u.profileChangeMeta={...profileChangeMeta(u),phoneChangedAt:now};u.updatedAt=now;users[i]=u;
  const ci=customers.findIndex(c=>c.id===u.customerId||c.userId===u.id);if(ci>=0){customers[ci].phone=u.phone;customers[ci].updatedAt=now}
  try{writeJson('users.json',users);if(ci>=0)writeJson('customers.json',customers);recordContactChangeMarketingDecision({req,user:u,channel:'sms',granted:keepMarketing,recipient:u.phone,previousRecipient:old,at:now,previousGranted:oldMarketing});await persistAccountStateToGithub();publishAdminMemberUpdate(u.id,'consent')}
  catch(e){try{writeJson('users.json',beforeUsers);if(ci>=0)writeJson('customers.json',beforeCustomers);writeJson('marketing_consents.json',beforeConsents);writeJson('marketing_integration_state.json',beforeIntegrationState);writeJson('integration_outbox.json',beforeOutbox)}catch(rollbackErr){console.error('Telefon değişikliği rollback:',rollbackErr)}throw e}
  return res.json({ok:true,user:publicUser(u)});
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
  const cargoSnapshotRestored=await restoreCargoStateFromGithub();
  ensureCargoFeatureState();
  if(ordersSnapshotRestored)console.log('SHAZ sipariş verileri şifreli kalıcı kayıttan geri yüklendi.');
  if(cargoSnapshotRestored)console.log('SHAZ kargo verileri şifreli kalıcı kayıttan geri yüklendi.');
  if(remoteAccountSnapshotRestored)console.log('SHAZ üyelik verileri GitHub şifreli kalıcı kaydından geri yüklendi.');
  else if(localAccountSnapshotRestored)console.log('SHAZ üyelik verileri yerel şifreli kalıcı kayıttan kullanılıyor.');
  setInterval(()=>syncPendingOrdersToSheets().catch(()=>{}),60000);
  setTimeout(()=>syncPendingOrdersToSheets().catch(()=>{}),5000);
  setTimeout(()=>runCargoBackgroundProviderRefresh().catch(()=>console.error('Kargo arka plan başlangıç kontrolü başarısız.')),20000);
  setInterval(()=>runCargoBackgroundProviderRefresh().catch(()=>console.error('Kargo arka plan kontrolü başarısız.')),CARGO_BACKGROUND_REFRESH_MS);
  setTimeout(runSafeStorageCleanup,30000);
  setInterval(runSafeStorageCleanup,24*60*60*1000);
  setTimeout(()=>runDeliveryHealthWatchChecks().catch(e=>console.error('Delivery health başlangıç kontrolü:',e)),15000);
  setInterval(()=>runDeliveryHealthWatchChecks().catch(e=>console.error('Delivery health saatlik kontrol:',e)),DELIVERY_HEALTH_CHECK_MS);
  setInterval(()=>{try{expireStalePresenceTabs()}catch(e){console.error('Presence expiry kontrolü:',e)}},1000);
  app.listen(PORT,()=>console.log(`SHAZ çalışıyor: http://localhost:${PORT}`));
}
startServer().catch(e=>{console.error('SHAZ başlangıç hatası:',e);process.exitCode=1});
