
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;
const root = __dirname;
// Render'da normal servis diski deploy/restart sırasında sıfırlanabilir.
// Kalıcı disk bağlandıysa SHAZ_PERSIST_DIR=/var/data/shaz vererek katalog, ayarlar ve yüklenen görselleri orada sakla.
// Değişken verilmemiş olsa bile /var/data yazılabiliyorsa otomatik kullanılır.
const requestedPersistDir = process.env.SHAZ_PERSIST_DIR || '/var/data/shaz';
let persistRoot = root;
try{
  const parent=path.dirname(requestedPersistDir);
  if(fs.existsSync(parent)){
    fs.mkdirSync(requestedPersistDir,{recursive:true});
    fs.accessSync(requestedPersistDir,fs.constants.W_OK);
    persistRoot=requestedPersistDir;
  }
}catch(e){
  console.warn('Kalıcı disk bulunamadı; geçici servis diski kullanılacak. Deploy sonrası panel verileri sıfırlanabilir.');
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
app.use('/uploads', express.static(uploadDir));

app.use(express.static(path.join(root,'public')));

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

const GOOGLE_SHEETS_WEBHOOK_URL=process.env.GOOGLE_SHEETS_WEBHOOK_URL||'';
const GOOGLE_SHEETS_SECRET=process.env.GOOGLE_SHEETS_SECRET||'';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function sheetsRequest(payload){
  if(!GOOGLE_SHEETS_WEBHOOK_URL || !GOOGLE_SHEETS_SECRET){
    throw new Error('Google E-Tablo bağlantısı yapılandırılmamış.');
  }
  const body=JSON.stringify({...payload,secret:GOOGLE_SHEETS_SECRET});
  let lastErr;
  for(let attempt=1;attempt<=2;attempt++){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),10000);
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
      if(attempt<2)await delay(900);
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

app.get('/api/settings',(req,res)=>res.json(readJson('settings.json',{})));
app.post('/api/settings',requireAdmin,(req,res)=>{writeJson('settings.json',req.body);res.json({ok:true})});
app.get('/api/catalog',(req,res)=>res.json(readJson('catalog.json',{categories:[],products:[],builder:{}})));
app.post('/api/catalog',requireAdmin,(req,res)=>{writeJson('catalog.json',req.body);res.json({ok:true})});
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
    lines.push(line);
  });
  return lines.join(' + ')||'Ürün';
 };
 const itemCount=o=>(o.items||[]).reduce((n,x)=>n+Math.max(1,Number(x.qty||1)),0)||1;
 const fullAddress=c=>{
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
    c.phone||'',
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
app.post('/api/orders',async(req,res)=>{
 const orders=readJson('orders.json',[]);
 const now=new Date();
 const createdAt=now.toISOString();
 const createdAtTR=new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(now);
 const requestId=crypto.randomUUID();
 const draft={createdAt,createdAtTR,status:'new',statusUpdatedAt:createdAt,requestId,...req.body};

 // Google E-Tablo ana kayıt noktasıdır. Oraya yazılmadan müşteriye "sipariş oluştu" demiyoruz.
 try{
   const sheet=await sheetsRequest({action:'create',requestId,order:draft});
   const order={...draft,id:sheet.id};
   orders.unshift(order);
   writeJson('orders.json',orders); // yönetim paneli için yerel hızlı kopya
   return res.json({ok:true,order});
 }catch(e){
   console.error('Google E-Tablo sipariş kayıt hatası:',e);
   return res.status(503).json({
     ok:false,
     message:'Siparişiniz güvenli kayıt sistemine yazılamadı. Lütfen tekrar deneyin.'
   });
 }
});
app.post('/api/upload',requireAdmin, upload.array('files',250),(req,res)=>{
 res.json({ok:true,files:(req.files||[]).map(f=>({name:f.originalname,url:'/uploads/'+f.filename}))});
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

app.listen(PORT,()=>console.log(`SHAZ çalışıyor: http://localhost:${PORT}`));
