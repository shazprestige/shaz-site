
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
for(const name of ['settings.json','catalog.json','orders.json']){
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
app.use(express.static(path.join(root,'public'),{etag:false,lastModified:false}));

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
    let changed=false, syncedNow=0, lastError='';
    for(const order of orders.filter(o=>o.sheetSyncStatus!=='synced').slice().reverse()){
      try{
        const sheet=await sheetsRequest({action:'create',requestId:order.requestId,order});
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
app.get('/api/catalog',(req,res)=>res.json(readJson('catalog.json',{categories:[],products:[],builder:{}})));

app.post('/api/admin/state',requireAdmin,async(req,res)=>{
  try{
    if(req.body.settings)writeJson('settings.json',req.body.settings);
    if(req.body.catalog)writeJson('catalog.json',req.body.catalog);
    let github={ok:false,skipped:true};
    if(githubEnabled())github=await persistStateToGithub();
    res.json({ok:true,github});
  }catch(e){
    console.error('Kalıcı durum kaydı:',e);
    res.status(500).json({ok:false,message:e.message||'Kayıt başarısız.'});
  }
});
app.post('/api/settings',requireAdmin,(req,res)=>{writeJson('settings.json',req.body);res.json({ok:true})});
app.post('/api/catalog',requireAdmin,(req,res)=>{writeJson('catalog.json',req.body);res.json({ok:true})});
app.get('/api/storage/status',requireAdmin,(req,res)=>res.json({
  githubEnabled:githubEnabled(),repo:githubEnabled()?GITHUB_REPO:'',branch:GITHUB_BRANCH,
  mode:githubEnabled()?'github':'local'
}));
app.get('/api/orders',requireAdmin,(req,res)=>res.json(readJson('orders.json',[])));
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
  const lines=[];
  (o.items||[]).forEach(x=>{
    const name=x.product?.name||'Ürün';
    let line=name;
    if(x.setCustomization){
      const removed=(x.setCustomization.removedIds||[])
        .map(id=>(x.product?.setItems||[]).find(s=>s.id===id)?.name)
        .filter(Boolean);
      if(removed.length) line+=` | Çıkarılan: ${removed.join(', ')}`;
    }
    const writes=x.writes||x.setCustomization?.writes||[];
    if(writes.length){
      const writeText=writes.map(w=>{
        const item=w.item||name;
        const pos=w.position?` (${w.position})`:'';
        return `${item}: ${w.text||''}${pos}`;
      }).filter(Boolean);
      if(writeText.length) line+=` | Yazı: ${writeText.join(' | ')}`;
    }
    const photos=x.photoCustomizations||x.setCustomization?.photoCustomizations||[];
    if(photos.length){
      const photoText=photos.map(ph=>{
        const item=ph.item||name;
        const caption=ph.caption?` | Fotoğraf yazısı (${ph.captionPosition==='above'?'üstte':'altta'}): ${ph.caption}`:'';
        return `${item}: ${ph.imageUrl||''}${caption}`;
      }).filter(Boolean);
      if(photoText.length) line+=` | Fotoğraf: ${photoText.join(' | ')}`;
    }
    lines.push(line);
  });
  return lines.join(' + ')||'Ürün';
 };
 const itemCount=o=>(o.items||[]).reduce((n,x)=>n+Math.max(1,Number(x.qty||1)),0)||1;
 const fullAddress=c=>{
  if(c.deliveryMode==='branch') return `ARAS KARGO ŞUBE TESLİM — ${c.branchName||''}`.trim();
  if(c.fullAddress) return [c.neighborhood,c.fullAddress].filter(Boolean).join(' ');
  const road=[c.neighborhood,c.avenue,c.street].filter(Boolean).join(' ');
  const nums=[c.buildingNo?`no:${c.buildingNo}`:'',c.floor?`kat:${c.floor}`:'',c.doorNo?`daire:${c.doorNo}`:''].filter(Boolean).join(' ');
  const biz=c.placeType==='business'&&c.businessName?` ${c.businessName}`:'';
  return [road,nums].filter(Boolean).join(' ')+biz;
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
       i===0?details:'',
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
   body.customer.phone=normalizedPhone;
   body.customer.extraPhone=normalizedExtra;

   // Siparişin ana kaydı önce sunucu/panele yapılır. Google E-Tablo geçici olarak cevap vermese bile
   // müşteri siparişi kaybolmaz ve tekrar adres girmek zorunda kalmaz.
   const order={
     id:nextLocalOrderId(orders),createdAt,createdAtTR,status:'new',statusUpdatedAt:createdAt,
     requestId,sheetSyncStatus:'pending',sheetSyncError:'',...body
   };
   orders.unshift(order);
   writeJson('orders.json',orders);

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
