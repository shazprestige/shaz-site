'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {registerFinance,financeOrder,summarize,vat,DEFAULT,cents}=require('../finance-service');
const makeOrder=(id='O1',amount=1000)=>({id,total:amount,status:'delivered',createdAt:'2026-10-09T12:00:00+03:00',customer:{fullName:'Müşteri'},items:[{qty:1,product:{id:'watch',name:'Saat'}}]});
function harness(){
 const urls={};const db={'orders.json':[makeOrder()], 'catalog.json':{products:[{id:'watch',name:'Saat',internalCode:'SET 20'}]},'finance_state.json':DEFAULT()};
 const app={get:(url,...fn)=>{urls['GET '+url]=fn.at(-1)},post:(url,...fn)=>{urls['POST '+url]=fn.at(-1)}};
 let commits=0;
 registerFinance(app,{readJson:(name,d)=>structuredClone(db[name]??d),writeJson:(name,val)=>db[name]=structuredClone(val),requireAdmin:()=>{},sameOriginGuard:()=>{},persist:async()=>{commits++}});
 const call=async(method,url,body={},query={})=>{const route=method+' '+url;const handler=urls[route];assert.ok(handler,'Endpoint bulunmalı '+route);const res={statusCode:200,headersSent:false,set:()=>res,status:c=>{res.statusCode=c;return res},json:v=>{res.value=v;res.headersSent=true;return res},send:v=>{res.value=v;res.headersSent=true;return res}};await handler({body,params:{id:body.orderId||'O1'},query},res);return res};
 return {call,db,commits:()=>commits};
}
test('Örnek 1000 satış - 300 maliyet - 187 kargo - 35 yazı = 478 kâr',()=>{
 const s=DEFAULT();s.costs.O1={lines:[{unitCostCents:30000}],shippingActualCents:18700,personalizationActualCents:3500};
 const o=financeOrder(makeOrder(),s);assert.equal(o.netRevenueCents,100000);assert.equal(o.profitCents,47800);assert.equal(o.issues.length,0);
});
test('KDV dahil 600 TL işlem 500 TL matrah 100 TL KDV üretir; oranlar bağımsızdır',()=>{
 assert.deepEqual(vat(600,20,true),{netCents:50000,vatCents:10000,grossCents:60000,rate:20});
 assert.deepEqual(vat(500,10,false),{netCents:50000,vatCents:5000,grossCents:55000,rate:10});
 assert.equal(cents(999.99),99999);
});
test('Maliyeti veya kargo bedeli eksikse kâr sıfıra düşmez, kesinleşmez',()=>{
 const f=financeOrder(makeOrder(),DEFAULT());assert.equal(f.profitCents,null);assert.ok(f.issues.some(x=>x.includes('Ürün maliyeti')));assert.ok(f.issues.some(x=>x.includes('Gidiş kargosu')));
});
test('İptal edilen sipariş ciroya giremez',()=>{
 const o=makeOrder();o.status='cancelled';const f=financeOrder(o,DEFAULT());assert.equal(f.recognized,false);assert.equal(f.netRevenueCents,0);
});
test('999,99, 1000, 1000,01 TL aralıkları doğru parti ve maliyete yönlenir',()=>{
 const s=DEFAULT();s.tariffs=[{id:'lower',company:'Aras Kargo / YeşilKar',minCents:0,maxCents:99999,costCents:18700,startsOn:'2026-01-01',createdAt:'2026-01-01T00:00:00Z'},{id:'higher',company:'Aras Kargo / YeşilKar',minCents:100000,maxCents:null,costCents:21500,startsOn:'2026-01-01',createdAt:'2026-01-01T00:00:00Z'}];
 assert.equal(financeOrder(makeOrder('O1',999.99),s).shippingCents,18700);
 assert.equal(financeOrder(makeOrder('O1',1000),s).shippingCents,21500);
 assert.equal(financeOrder(makeOrder('O1',1000.01),s).shippingCents,21500);
});
test('Alış faturası iki partide korunur; faturalı stok ilk istekte değil seçimde azalır; stok eksiye düşmez',async()=>{
 const h=harness();
 const p=async(invoice,price,quantity)=>h.call('POST','/api/admin/finance/purchases',{date:'2026-10-02',supplier:'Tedarikçi',invoice,lines:[{productId:'watch',quantity,price,vatRate:0,vatIncluded:false}]});
 assert.equal((await p('A',190,1)).statusCode,200);assert.equal((await p('B',220,1)).statusCode,200);
 let report=(await h.call('GET','/api/admin/finance/report',{}, {from:'2026-10-01',to:'2026-10-31'})).value;
 assert.deepEqual(report.stock.map(x=>x.remaining),[1,1]);
 const first=report.stock[0].id;
 const alloc=await h.call('POST','/api/admin/finance/allocate',{orderId:'O1',lineIndex:0,parts:[{batchId:first,quantity:1}]});
 assert.equal(alloc.statusCode,200);assert.equal(alloc.value.order.costCents,19000);
 report=(await h.call('GET','/api/admin/finance/report',{}, {from:'2026-10-01',to:'2026-10-31'})).value;
 assert.deepEqual(report.stock.map(x=>x.remaining),[0,1]);
 const wrong=await h.call('POST','/api/admin/finance/allocate',{orderId:'O1',lineIndex:0,parts:[{batchId:'wrong',quantity:1}]});assert.equal(wrong.statusCode,400);
 const invoice=await h.call('POST','/api/admin/finance/order/:id/costs',{salesInvoiced:true,outputVatRate:20});assert.equal(invoice.statusCode,200);
 const refund=await h.call('POST','/api/admin/finance/refunds',{orderId:'O1',date:'2026-10-10',amount:1000,type:'full',items:[{lineIndex:0,quantity:1,resellable:true}],returnShipping:187});assert.equal(refund.statusCode,200);
 report=(await h.call('GET','/api/admin/finance/report',{}, {from:'2026-10-01',to:'2026-10-31'})).value;
 assert.deepEqual(report.stock.map(x=>x.remaining),[1,1],'İade edilen satılabilir ürün kendi faturalı partisine geri dönmeli');
});
test('Faturalı satış için stok kullanımı olmadan satış faturası işaretlenemez',async()=>{
 const h=harness();const r=await h.call('POST','/api/admin/finance/order/:id/costs',{salesInvoiced:true,outputVatRate:20});assert.equal(r.statusCode,409);assert.match(r.value.message,/faturalı stok/i);
});
test('Tam iade ve kısmi iade cirodan yalnız iade tutarını çıkarır; satılabilir ürün ikinci kez zarar yazılmaz',async()=>{
 const h=harness();let r=await h.call('POST','/api/admin/finance/order/:id/costs',{shippingActual:187,personalizationActual:35,lines:[{unitCost:300}]});assert.equal(r.statusCode,200);
 r=await h.call('POST','/api/admin/finance/refunds',{orderId:'O1',date:'2026-10-10',amount:300,items:[],type:'partial'});assert.equal(r.value.order.netRevenueCents,70000);
 r=await h.call('POST','/api/admin/finance/refunds',{orderId:'O1',date:'2026-10-10',amount:700,items:[{lineIndex:0,quantity:1,resellable:true}],type:'full',returnShipping:187});assert.equal(r.value.order.netRevenueCents,0);assert.equal(r.value.order.costCents,0);assert.equal(r.value.order.returnLossCents,18700);assert.equal(r.value.order.profitCents,-40900);
});
test('Tekrar satılamayan ürünün maliyeti iade zararı etkisiyle kârda kalır',async()=>{
 const h=harness();await h.call('POST','/api/admin/finance/order/:id/costs',{shippingActual:187,personalizationActual:35,lines:[{unitCost:300}]});const r=await h.call('POST','/api/admin/finance/refunds',{orderId:'O1',date:'2026-10-10',amount:1000,type:'full',items:[{lineIndex:0,quantity:1,resellable:false}],returnShipping:187});assert.equal(r.value.order.costCents,30000);assert.equal(r.value.order.profitCents,-70900);
});
test('Aynı gider/idempotent operationId API iki defa çağrılsa tek kayıt oluşur',async()=>{
 const h=harness(),request={date:'2026-10-10',category:'advertising',amount:120,operationId:'test-unique-1'};const a=await h.call('POST','/api/admin/finance/expenses',request),b=await h.call('POST','/api/admin/finance/expenses',request);assert.equal(a.statusCode,200);assert.equal(b.statusCode,200);assert.equal(a.value.expense.id,b.value.expense.id);assert.equal(h.db['finance_state.json'].expenses.length,1);
});
test('Aynı iade operationId tekrar geldiğinde fazla iade veya ikinci zarar oluşmaz',async()=>{
 const h=harness(),request={orderId:'O1',date:'2026-10-10',amount:1000,returnShipping:187,items:[],operationId:'refund-unique-1'};const a=await h.call('POST','/api/admin/finance/refunds',request),b=await h.call('POST','/api/admin/finance/refunds',request);assert.equal(a.statusCode,200);assert.equal(b.statusCode,200);assert.equal(h.db['finance_state.json'].refunds.length,1);assert.equal(a.value.refund.id,b.value.refund.id);
});
test('Maliyet geçmişi snapshot korunur; güncel fatura/tarife siparişi geri değiştirmez',()=>{
 const s=DEFAULT();s.costs.O1={lines:[{unitCostCents:19000}],shippingActualCents:18700,personalizationActualCents:0};const before=financeOrder(makeOrder(),s).profitCents;
 s.purchases.push({lines:[{productId:'watch',unitCostCents:22000,quantity:10}]});s.tariffs.push({company:'Aras Kargo / YeşilKar',minCents:0,maxCents:null,costCents:99900,startsOn:'2026-01-01',createdAt:'2026-10-10T00:00:00Z'});
 assert.equal(financeOrder(makeOrder(),s).profitCents,before);
});

test('Barkod etiketi ve Excel aynı ürün detayı kaynağını kullanır: set modeli, çıkartılan ürün ve yazı',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const {orderProducts}=require('../order-product-details');
 const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
 assert.match(server,/require\('\.\/order-product-details'\)/);
 const text=orderProducts({items:[{product:{id:'set20',name:'Hediye Seti',internalCode:'SET 20',setItems:[{id:'w',name:'Saat'},{id:'c',name:'Cüzdan'}]},setCustomization:{keptIds:['w'],removedIds:['c']},writes:[{item:'Saat',text:'SHAZ',position:'Arka'}]}]});
 assert.match(text,/SET 20/);assert.match(text,/Gönderilecek ürünler: Saat/);assert.match(text,/Çıkarılan ürünler: Cüzdan/);assert.match(text,/SHAZ/);
});
