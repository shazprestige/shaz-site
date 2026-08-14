
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const root = __dirname;
const dataDir = path.join(root,'data');
const uploadDir = path.join(root,'uploads');
fs.mkdirSync(uploadDir,{recursive:true});
app.use(express.json({limit:'5mb'}));
app.use(express.urlencoded({extended:true}));
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(root,'public')));

const readJson=(name,fallback)=>{try{return JSON.parse(fs.readFileSync(path.join(dataDir,name),'utf8'))}catch(e){return fallback}};
const writeJson=(name,data)=>fs.writeFileSync(path.join(dataDir,name),JSON.stringify(data,null,2),'utf8');

const storage = multer.diskStorage({
 destination:(req,file,cb)=>cb(null,uploadDir),
 filename:(req,file,cb)=>cb(null,Date.now()+'-'+Math.random().toString(36).slice(2,8)+path.extname(file.originalname).toLowerCase())
});
const upload=multer({storage,limits:{fileSize:20*1024*1024,files:250}});

app.get('/api/settings',(req,res)=>res.json(readJson('settings.json',{})));
app.post('/api/settings',(req,res)=>{writeJson('settings.json',req.body);res.json({ok:true})});
app.get('/api/catalog',(req,res)=>res.json(readJson('catalog.json',{categories:[],products:[],builder:{}})));
app.post('/api/catalog',(req,res)=>{writeJson('catalog.json',req.body);res.json({ok:true})});
app.get('/api/orders',(req,res)=>res.json(readJson('orders.json',[])));
app.patch('/api/orders/status',(req,res)=>{
 const ids=Array.isArray(req.body.ids)?req.body.ids:[]; const status=req.body.status;
 if(!['new','prepared','shipped'].includes(status))return res.status(400).json({ok:false});
 const orders=readJson('orders.json',[]); const now=new Date().toISOString();
 orders.forEach(o=>{if(ids.includes(o.id)){o.status=status;o.statusUpdatedAt=now;}});
 writeJson('orders.json',orders);res.json({ok:true,orders});
});
app.get('/api/orders/export.xlsx',(req,res)=>{
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

 // İlk satır: bu Excel'in tam olarak ne zaman alındığı.
 // İkinci satır: eski başlık düzeni.
 const aoa=[
   [`Excel'e aktarma tarihi: ${exportAtTR}`,'','','',''],
   ['','SİPARİŞ','ADET','HAZIR MI','KARGOYA VERİLDİ Mİ']
 ];
 const merges=[{s:{r:0,c:0},e:{r:0,c:4}}];

 orders.forEach((o,idx)=>{
   const c=o.customer||{};
   const r=2+idx*8; // 2 üst satırdan sonra her müşteri 8 satır
   const details=orderProducts(o);
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
   }
   merges.push(
     {s:{r,c:1},e:{r:r+7,c:1}},
     {s:{r,c:2},e:{r:r+7,c:2}},
     {s:{r,c:3},e:{r:r+7,c:3}},
     {s:{r,c:4},e:{r:r+7,c:4}}
   );
 });

 const ws=XLSX.utils.aoa_to_sheet(aoa);
 ws['!merges']=merges;
 ws['!cols']=[{wch:42},{wch:54},{wch:9},{wch:14},{wch:22}];
 ws['!rows']=[{hpt:24},{hpt:24}];
 for(let i=0;i<orders.length;i++){
   for(let j=0;j<8;j++)ws['!rows'][2+i*8+j]={hpt:j===7?34:22};
 }
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
app.post('/api/orders',(req,res)=>{
 const orders=readJson('orders.json',[]);
 const now=new Date();
 const createdAt=now.toISOString();
 const createdAtTR=new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(now);
 const maxNo=orders.reduce((m,o)=>Math.max(m,Number(String(o.id||'').replace(/^SHZ/i,''))||0),0);
 const order={id:'SHZ'+(maxNo+1),createdAt,createdAtTR,status:'new',statusUpdatedAt:createdAt,...req.body};
 orders.unshift(order); writeJson('orders.json',orders); res.json({ok:true,order});
});
app.post('/api/upload', upload.array('files',250),(req,res)=>{
 res.json({ok:true,files:(req.files||[]).map(f=>({name:f.originalname,url:'/uploads/'+f.filename}))});
});
app.get('/admin',(req,res)=>res.sendFile(path.join(root,'public','admin.html')));
app.listen(PORT,()=>console.log(`SHAZ çalışıyor: http://localhost:${PORT}`));
