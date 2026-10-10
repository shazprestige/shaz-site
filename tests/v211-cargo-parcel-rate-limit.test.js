'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createCargoService}=require('../cargo-service');
const env={YESILKAR_CREATE_URL:'https://example.test/restapi/client/consignment/add',YESILKAR_STATUS_URL_TEMPLATE:'https://example.test/restapi/client/consignments?barcode={barcode}',YESILKAR_AUTH_HEADER_NAME:'Authorization',YESILKAR_API_KEY:'testing-only',YESILKAR_FROM_HEADER_NAME:'From',YESILKAR_API_FROM:'testing@example.com',YESILKAR_BRANCH_CODE:'DY',YESILKAR_AMOUNT_TYPE_ID:'3'};

test('ürün sayısı 2 olsa da tek fiziki paket gönderir, provider barkod uydurmaz',()=>{
  const service=createCargoService({env});
  const order={id:'SHZ112',payment:'cod',total:1200,customer:{fullName:'Test',province:'Konya',district:'Meram',fullAddress:'Alpaslan Mh.',phone:'05010000000'},items:[{name:'Aksesuar',qty:1},{name:'Gözlük',qty:1}]};
  const p=service.buildShipmentPayload(order);
  assert.equal(p.quantity,1);assert.equal(p.consignment_type_id,2);assert.equal(p.amount_type_id,'3');
  assert.equal(p.amount,'1200.00');assert.equal(p.county_name,'Meram');
  assert.equal(p.summary,'Aksesuar x1, Gözlük x1');assert.ok(!('barcode' in p));
  assert.equal(service.buildShipmentPayload({...order,cargoPackageCount:2}).quantity,2);
  assert.equal(service.buildShipmentPayload({...order,cargoPackageCount:300}).quantity,1);
});

test('429 gelince HTML ekrana verilmez; GET beklerken yeni kargo POST denenebilir',async()=>{
  const calls=[];
  const service=createCargoService({env,fetchImpl:async(url,opts)=>{
    calls.push({url,method:opts.method});
    if(opts.method==='POST')return {ok:true,status:201,headers:{get:()=>null},text:async()=>JSON.stringify({error:false,barcode:'DY0000000023',record_id:23})};
    return {ok:false,status:429,headers:{get:()=>null},text:async()=>'<center><h1>429 Too Many Requests</h1>Your IP has been blocked</center>'};
  }});
  const shipment={barcode:'DY0000000008',status:'created'};
  await assert.rejects(service.refreshShipment({shipment}),e=>e.code==='CARGO_RATE_LIMITED'&&e.httpStatus===429&&!String(e.message).includes('<center>'));
  assert.equal(service.rateLimitStatus().active,true);
  await assert.rejects(service.refreshShipment({shipment}),e=>e.code==='CARGO_RATE_LIMITED');
  const created=await service.createShipment({order:{id:'SHZ113',payment:'cod',total:500,customer:{fullName:'Deneme',province:'Konya',district:'Meram'}}});
  assert.equal(created.barcode,'DY0000000023');
  assert.equal(calls.length,2,'GET bekleme devam eder; kullanıcı isteğiyle yeni gönderi oluşturulur');
});

test('provider yeni barkod POST isteğine 429 dönerse sahte başarı üretilmez',async()=>{
  const service=createCargoService({env,fetchImpl:async()=>({ok:false,status:429,headers:{get:()=>null},text:async()=>'<h1>429 Too Many Requests</h1>'})});
  await assert.rejects(service.createShipment({order:{id:'SHZ125',payment:'cod',total:450,customer:{fullName:'Test',province:'Konya',district:'Meram'}}}),e=>e.code==='CARGO_CREATE_RATE_LIMITED'&&e.httpStatus===429);
});

test('429 hata metni HTTP 200 dönse bile anlaşılır hız sınırı hatası üretilir',async()=>{
  let calls=0;
  const service=createCargoService({env,fetchImpl:async()=>{calls++;return {ok:true,status:200,text:async()=>'<center><h1>429 Too Many Requests</h1></center>'}}});
  await assert.rejects(service.refreshShipment({shipment:{barcode:'DY0000000011'}}),e=>e.code==='CARGO_RATE_LIMITED');
  assert.equal(calls,1);
});

test('429 koruması yalnız kargo kodlarını etkiler; sunucunun doğru durum geçmişi korunur',()=>{
  const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  assert.match(server,/CARGO_BACKGROUND_CONCURRENCY=1/);
  assert.match(server,/cargoService\.rateLimitStatus\(\)\.active/);
  assert.match(server,/CARGO_RATE_LIMITED/);
  assert.match(server,/lastRefreshError:active\?\.lastRefreshError\?cargoSafeError/);
  assert.match(server,/syncCargoWorkflowFromProvider\(row\.orderId,row\)/);
});

test('provider otomatik kontrolü yalnız oturumlu ve görünür admin isteğine bağlıdır',()=>{
  const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  const admin=fs.readFileSync(path.join(__dirname,'..','public','admin.js'),'utf8');
  assert.match(server,/app\.post\('\/api\/admin\/cargo\/active-refresh',requireAdmin,sameOriginGuard/);
  assert.match(server,/kickCargoRefreshForActiveAdmin\(\)/);
  assert.match(server,/CARGO_ACTIVE_BATCH_LIMIT=12/);
  assert.match(server,/setInterval\(\(\)=>runCargoBackgroundProviderRefresh\(/);
  assert.doesNotMatch(server,/setTimeout\(\(\)=>runCargoBackgroundProviderRefresh\(/);
  assert.match(admin,/document\.visibilityState==='hidden'/);
  assert.match(admin,/setInterval\(refreshCargoWhileAdminVisible,CARGO_VISIBLE_ADMIN_REFRESH_MS\)/);
  assert.match(admin,/function show\(tab\)\{\s*refreshCargoWhileAdminVisible\(\)/);
});

test('yeni admin ziyaretinde 12 dakika bekletmeden kargo kontrolü başlatılır; sık yeniden giriş engellenir',()=>{
  const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  const admin=fs.readFileSync(path.join(__dirname,'..','public','admin.js'),'utf8');
  assert.match(server,/CARGO_ADMIN_ENTRY_MIN_GAP_MS=60\*60\*1000/);
  const kick=server.slice(server.indexOf('function kickCargoRefreshForActiveAdmin()'),server.indexOf('function cargoQueryRows(',server.indexOf('function kickCargoRefreshForActiveAdmin()')));
  assert.match(kick,/now-cargoLastAdminRefreshKickAt<CARGO_ADMIN_ENTRY_MIN_GAP_MS/);
  assert.match(kick,/now-cargoLastProviderPollAt<CARGO_BACKGROUND_REFRESH_MS/);
  assert.match(kick,/cargoService\.rateLimitStatus\(\)\.active/);
  assert.match(admin,/const CARGO_VISIBLE_ADMIN_REFRESH_MS=12\*60\*1000\+5000/);
  assert.match(admin,/fetch\('\/api\/admin\/cargo\/active-refresh'/);
  assert.match(admin,/if\(document\.visibilityState==='visible'\)refreshCargoWhileAdminVisible\(\)/);
});
