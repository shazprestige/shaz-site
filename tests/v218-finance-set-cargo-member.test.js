'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {registerFinance,financeOrder,DEFAULT}=require('../finance-service');
const when='2026-10-10T12:00:00+03:00';
function setup(items=[{qty:1,product:{id:'watch',name:'Saat'}}],amount=1000){
 const db={'orders.json':[{id:'O1',status:'delivered',createdAt:when,total:amount,payment:'cod',items}], 'catalog.json':{products:[{id:'watch',name:'Saat'},{id:'tasbih',name:'Tesbih'},{id:'belt',name:'Kemer'},{id:'set20',name:'Set 20',isSet:true,setItems:[{id:'a',name:'Saat'},{id:'b',name:'Tesbih'},{id:'c',name:'Kemer'}]}]},'finance_state.json':DEFAULT()};
 const routes={};const app={get:(url,...f)=>routes['GET '+url]=f.at(-1),post:(url,...f)=>routes['POST '+url]=f.at(-1)};
 registerFinance(app,{readJson:(name,v)=>structuredClone(db[name]??v),writeJson:(name,v)=>db[name]=structuredClone(v),requireAdmin:()=>{},sameOriginGuard:()=>{},persist:async()=>{}});
 async function call(method,url,body={},query={}){const r={statusCode:200,headersSent:false,status(n){this.statusCode=n;return this},json(v){this.headersSent=true;this.value=v;return this},set(){return this},send(v){this.headersSent=true;this.value=v;return this}};assert.ok(routes[method+' '+url],url);await routes[method+' '+url]({params:{id:body.pathId,type:body.pathType},body,query},r);return r}
 async function add(productId,qty,price,date='2026-10-01',invoiced=false){return call('POST','/api/admin/finance/purchases',{date,invoice:'F'+Math.random(),supplier:'SHAZ',invoiced,lines:[{productId,quantity:qty,price,vatRate:0}]})}
 async function report(){return (await call('GET','/api/admin/finance/report',{}, {from:'2026-10-01',to:'2026-10-31'})).value}
 return {db,call,add,report};
}
test('Setten çıkarılmış tesbih maliyete girmez, satış analizinde görünmez',async()=>{
 const x=setup([{qty:1,product:{id:'set20',name:'Set 20',isSet:true,setItems:[{id:'a',name:'Saat',productId:'watch'},{id:'b',name:'Tesbih',productId:'tasbih'},{id:'c',name:'Kemer',productId:'belt'}]},setCustomization:{keptIds:['a','c'],removedIds:['b']}}]);
 await x.add('watch',3,190);await x.add('tasbih',3,10);await x.add('belt',3,30);
 const r=await x.report();assert.equal(r.orders[0].costCents,22000);assert.equal(r.orders[0].lines[0].components.length,2);assert.equal(r.products.some(p=>p.productId==='tasbih'),false);assert.equal(r.products.find(p=>p.productId==='watch').quantity,1);
});
test('Toplu set eşleştirmesi eksik maliyeti doğru çözer',async()=>{
 const line={qty:1,product:{id:'set20',name:'Set 20',isSet:true,setItems:[{id:'a',name:'Saat'},{id:'b',name:'Tesbih'},{id:'c',name:'Kemer'}]},setCustomization:{removedIds:['c']}};
 const x=setup([line]);await x.add('watch',1,190);await x.add('tasbih',1,10);
 let r=await x.report();assert.equal(r.orders[0].costCents,null);assert.match(r.orders[0].issues[0],/Set içeriğini/);
 const mapped=await x.call('POST','/api/admin/finance/set-mappings',{setIds:['set20'],mappings:[{itemName:'Saat',productId:'watch'},{itemName:'Tesbih',productId:'tasbih'}]});assert.equal(mapped.statusCode,200);
 r=await x.report();assert.equal(r.orders[0].costCents,20000);assert.equal(r.orders[0].lines[0].components.length,2);
});
test('Aynı ürün iki alışta 10 sonra 12 TL; yeni sipariş eski partiyi önce tüketir',async()=>{
 const x=setup([{qty:10,product:{id:'tasbih',name:'Tesbih'}}]);await x.add('tasbih',9,10,'2026-10-01');await x.add('tasbih',10,12,'2026-10-02');
 let r=await x.report();assert.equal(r.orders[0].costCents,10200); // 9*10 + 1*12
 const before=x.db['finance_state.json'].costs.O1.autoLines[0];await x.add('tasbih',10,15,'2026-10-03');r=await x.report();assert.equal(r.orders[0].costCents,before);assert.equal(r.orders[0].costCents,10200);
});
test('Faturalı ürün fiziksel maliyete dahil, faturasız satış resmi fatura kullanımını düşürmez',async()=>{
 const x=setup([{qty:2,product:{id:'watch',name:'Saat'}}]);await x.add('watch',1,20,'2026-10-01',false);await x.add('watch',1,30,'2026-10-02',true);
 const r=await x.report();assert.equal(r.orders[0].costCents,5000);assert.equal(r.stock.find(s=>s.invoiced).remaining,1);assert.equal(r.stock.filter(s=>s.invoiced).length,1);
});
test('Kullanılmamış alışın yanına düzenle işlemi fiyat değişikliğini kaydeder; kullanılan partide engeller',async()=>{
 const x=setup();const a=await x.add('tasbih',10,10);assert.equal(a.statusCode,200);const id=a.value.purchase.id;
 let r=await x.call('POST','/api/admin/finance/purchases/:id/edit',{pathId:id,date:'2026-10-01',invoice:'EDIT',supplier:'S',lines:[{productId:'tasbih',quantity:9,price:12}]});assert.equal(r.statusCode,200);assert.equal(r.value.purchase.lines[0].unitCostCents,1200);
 await x.add('watch',1,190);await x.report();const used=x.db['finance_state.json'].purchases.find(p=>p.lines[0].productId==='watch');r=await x.call('POST','/api/admin/finance/purchases/:id/edit',{pathId:used.id,date:'2026-10-01',invoice:'EDIT2',supplier:'S',lines:[{productId:'watch',quantity:1,price:1}]});assert.equal(r.statusCode,400);assert.match(r.value.message,/değiştirilemez/);
});
test('Ödeme tipine göre tarife, müşteri tahsilatı ve kargo maliyeti ayrı hesaplanır',()=>{
 const order={id:'O1',status:'delivered',createdAt:when,total:1000,payment:'cod',items:[{qty:1,product:{id:'watch',name:'Saat'}}]};const s=DEFAULT();s.costs.O1={lines:[{unitCostCents:30000}],personalizationActualCents:0,customerShippingCents:5000};
 s.tariffs=[{id:'cod',company:'Aras Kargo / YeşilKar',paymentBasis:'cod',minCents:0,maxCents:null,costCents:18700,customerChargeCents:5000,startsOn:'2026-01-01',createdAt:'2026-01-01T00:00:00Z'},{id:'paid',company:'Aras Kargo / YeşilKar',paymentBasis:'paid',minCents:0,maxCents:null,costCents:21500,customerChargeCents:0,startsOn:'2026-01-01',createdAt:'2026-01-01T00:00:00Z'}];
 let f=financeOrder(order,s);assert.equal(f.shippingCents,18700);assert.equal(f.customerShippingCents,5000);assert.equal(f.netRevenueCents,105000);assert.equal(f.profitCents,56300);
 s.costs.O1.customerShippingIncludedInTotal=true;f=financeOrder(order,s);assert.equal(f.netRevenueCents,100000);
 s.costs.O1.paymentBasis='paid';f=financeOrder(order,s);assert.equal(f.shippingCents,21500);
});
test('Sipariş / Kargo Yönetimi satır numaraları aşağıdan yukarıya; üye güncel e-posta/telefon girişi',()=>{
 const a=fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8'),srv=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');assert.match(a,/cargoPagination\.total\|\|cargoOrders\.length/);assert.match(srv,/app\.patch\('\/api\/admin\/users\/:id\/profile'/);assert.match(srv,/normalizeEmail\(x\.email\)===email/);assert.match(srv,/normalizeAccountPhone\(x\.phone\)===phone/);
});
test('Normal/faturalı alış ayrı sekmeler; düzenleme ve toplu set tanımlama formu var',()=>{
 const ui=fs.readFileSync(path.join(__dirname,'../public/finance-admin.js'),'utf8');assert.match(ui,/'normal','Normal Alış'/);assert.match(ui,/'invoices','Faturalı Alış'/);assert.match(ui,/finEditPurchase/);assert.match(ui,/Seçili Setlere Toplu Tanımla/);
});
test('Setin tüm parçaları için faturalı tahsis ayrı partilerden yapılır; satış faturası açılmadan resmi stok azalmaz',async()=>{
 const item={qty:1,product:{id:'set20',name:'Set 20',isSet:true,setItems:[{id:'a',name:'Saat',productId:'watch'},{id:'b',name:'Tesbih',productId:'tasbih'}]}};
 const x=setup([item]);const a=await x.add('watch',1,190,'2026-10-01',true);const b=await x.add('tasbih',1,10,'2026-10-01',true);
 await x.report();let before=(await x.report()).stock;assert.deepEqual(before.map(z=>z.remaining),[1,1]);
 const parts=[{batchId:a.value.purchase.lines[0].id,quantity:1},{batchId:b.value.purchase.lines[0].id,quantity:1}];
 let result=await x.call('POST','/api/admin/finance/allocate',{orderId:'O1',lineIndex:0,parts});assert.equal(result.statusCode,200);
 let after=await x.report();assert.deepEqual(after.stock.map(z=>z.remaining),[0,0]);
 result=await x.call('POST','/api/admin/finance/order/:id/costs',{pathId:'O1',salesInvoiced:true,outputVatRate:0});assert.equal(result.statusCode,200);
 result=await x.call('POST','/api/admin/finance/allocate/undo',{orderId:'O1',lineIndex:0});assert.equal(result.statusCode,200);after=await x.report();assert.deepEqual(after.stock.map(z=>z.remaining),[1,1]);
});
