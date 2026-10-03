const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const admin=read('public/admin.js'),server=read('server.js'),app=read('public/app.js'),html=read('admin.html'),envExample=read('.env.example'),cargoServiceSrc=read('cargo-service.js');
const {createCargoService,CARGO_STATUSES,providerStatusToCargoStatus,redactProviderResponse}=require('../cargo-service');
function block(src,a,b){const x=src.indexOf(a),y=src.indexOf(b,x);assert.ok(x>=0&&y>x,`block missing: ${a}`);return src.slice(x,y)}

test('10. sayfa artık Sipariş / Kargo ve eski müşteri listesi veri kaynağını kullanmıyor',()=>{
  assert.match(html,/10\. Sipariş \/ Kargo Yönetimi/);
  const cargo=block(admin,'const cargoFilterState','async function renderNotificationSettings');
  assert.match(cargo,/Sipariş \/ Kargo Yönetimi/);
  assert.match(cargo,/\/api\/admin\/cargo\/orders/);
  assert.doesNotMatch(cargo,/\/api\/admin\/customers-all/);
  assert.doesNotMatch(cargo,/allCustomerRows|allCustomerFilter/);
});

test('yeni panelin ana anahtarı orderId ve kayıt yalnız yeni sipariş commitinden sonra idempotent ekleniyor',()=>{
  assert.match(server,/function registerCargoPanelOrder\(order\).*rows\.some\(x=>String\(x\.orderId\)===String\(order\.id\)\).*return false/s);
  assert.match(server,/createdMs<cutoverMs\)return false/);
  const orderPost=block(server,"app.post('/api/orders'","// Yönetim panelinden gerektiğinde Google E-Tablo");
  assert.match(orderPost,/await persistOrdersToGithub\(\)/);
  assert.match(orderPost,/registerCargoPanelOrder\(order\)/);
  assert.doesNotMatch(server,/for\s*\([^)]*orders[^)]*\)\s*registerCargoPanelOrder/);
});


test('registerCargoPanelOrder runtime: yeni sipariş tek kez eklenir, eski sipariş eklenmez',()=>{
  const src=server.match(/function registerCargoPanelOrder\(order\)\{.*?\}(?=\nfunction cargoPanelOrder)/s)?.[0];assert.ok(src);
  let rows=[],events=0,writes=0;const startedAt='2026-10-03T12:00:00.000Z';
  const fn=Function('crypto','ensureCargoFeatureState','cargoOrderIndexRows','writeJson','appendCargoEvent','persistCargoStateAsync',`${src};return registerCargoPanelOrder;`)(
    {randomUUID:()=>String(rows.length+1)},()=>({startedAt}),()=>rows,(name,value)=>{if(name==='cargo_order_index.json')rows=value;writes++},()=>{events++},()=>{}
  );
  assert.equal(fn({id:'NEW-1',createdAt:'2026-10-03T12:00:01.000Z'}),true);
  assert.equal(fn({id:'NEW-1',createdAt:'2026-10-03T12:00:01.000Z'}),false);
  assert.equal(fn({id:'OLD-1',createdAt:'2026-10-03T11:59:59.000Z'}),false);
  assert.deepEqual(rows.map(x=>x.orderId),['NEW-1']);assert.equal(events,1);assert.equal(writes,1);
});

test('cutover marker eski sipariş backfillini engelliyor',()=>{
  assert.match(server,/cargo_feature_state\.json/);
  assert.match(server,/startedAt:new Date\(\)\.toISOString\(\),source:'deployment_cutover'/);
  assert.match(server,/createdMs<cutoverMs\)return false/);
  assert.doesNotMatch(server,/backfillCargo|migrateOldOrders|importHistoricalOrders/i);
});

test('kargo durumları tek merkezi configten yönetiliyor',()=>{
  assert.deepEqual(Object.keys(CARGO_STATUSES),['not_created','creating','created','handed_over','out_for_delivery','delivered','returned','cancelled','error']);
  assert.equal(providerStatusToCargoStatus('Teslim Edildi'),'delivered');
  assert.equal(providerStatusToCargoStatus('Dağıtımda'),'out_for_delivery');
  assert.equal(providerStatusToCargoStatus('İade'),'returned');
  assert.match(server,/CARGO_STATUS_OPTIONS/);
});

test('YeşilKar service boş configte fail-closed; sahte endpoint veya barkod üretmiyor',async()=>{
  let calls=0;const svc=createCargoService({env:{},fetchImpl:async()=>{calls++;throw new Error('fetch should not run')}});
  assert.equal(svc.config().configured,false);
  await assert.rejects(()=>svc.createShipment({order:{id:'O1',customer:{fullName:'Test',phone:'05000000000'}}}),e=>e.code==='CARGO_INTEGRATION_NOT_CONFIGURED');
  assert.equal(calls,0);
  assert.doesNotMatch(cargoServiceSrc,/https?:\/\//);
  assert.doesNotMatch(cargoServiceSrc,/Math\.random|randomUUID/);
});

test('YeşilKar payload gelecekteki gerçek alanlara siparişten hazırlanıyor',()=>{
  const svc=createCargoService({env:{}}),p=svc.buildShipmentPayload({id:'SHZ-1',total:1250,customer:{fullName:'Ali Veli',province:'Kocaeli',district:'Darıca',fullAddress:'Adres',phone:'05380000000'},items:[{name:'Saat',qty:2}]});
  for(const k of ['customer','province_name','county_name','address','telephone','branch_code','order_number','summary','quantity','amount_type_id','amount','barcode','record_id'])assert.ok(Object.hasOwn(p,k),k);
  assert.equal(p.order_number,'SHZ-1');assert.equal(p.customer,'Ali Veli');assert.equal(p.amount,1250);assert.equal(p.quantity,2);
});

test('secret yapı yalnız server env tarafında ve frontendde key/from değeri yok',()=>{
  for(const name of ['YESILKAR_CREATE_URL','YESILKAR_API_KEY','YESILKAR_API_FROM','YESILKAR_AUTH_HEADER_NAME'])assert.match(envExample,new RegExp('^'+name+'=', 'm'));
  assert.doesNotMatch(admin,/YESILKAR_API_KEY|YESILKAR_API_FROM|YESILKAR_AUTH_HEADER_VALUE/);
  assert.doesNotMatch(app,/YESILKAR_API_KEY|YESILKAR_API_FROM|YESILKAR_AUTH_HEADER_VALUE/);
  const redacted=redactProviderResponse({authorization:'abc',apiKey:'def',nested:{token:'ghi'},barcode:'123'});
  assert.equal(redacted.authorization,'[redacted]');assert.equal(redacted.apiKey,'[redacted]');assert.equal(redacted.nested.token,'[redacted]');assert.equal(redacted.barcode,'123');
});

test('panel tablo alanları, filtreler, pagination ve toplu seçim altyapısı mevcut',()=>{
  const cargo=block(admin,'const cargoFilterState','async function renderNotificationSettings');
  for(const text of ['Sipariş ID','Ad Soyad','Telefon','İl','İlçe','Adres','Ödeme','Toplam','Sipariş Tarihi','Kargo Firması','Kargo Durumu','Barkod / Takip','Kargo Oluşturma','Son Kargo Güncelleme','İşlemler'])assert.match(cargo,new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  for(const key of ['orderId','name','phone','city','payment','status','dateFrom','dateTo','created','page','pageSize'])assert.match(cargo,new RegExp(key+':'));
  assert.match(cargo,/selectedCargoOrderIds/);assert.match(cargo,/bulkCreateCargo/);assert.match(cargo,/cargoPagination/);
  assert.match(server,/pageSize=Math\.max\(10,Math\.min\(100/);
});

test('detay ekranı sipariş ürünleri, adres/not ve kargo timeline bilgisini serverdan gösteriyor',()=>{
  const cargo=block(admin,'const cargoFilterState','async function renderNotificationSettings');
  assert.match(cargo,/Kargo İşlem Geçmişi/);assert.match(cargo,/Ürünler/);assert.match(cargo,/Açık Adres/);assert.match(cargo,/Sipariş Notu/);
  assert.match(server,/products:cargoProducts\(order\)/);assert.match(server,/events=cargoEventRows\(\)/);
  assert.match(server,/customer:\{fullName:order\.customer\?\.fullName/);
});


test('Kargo Oluştur ekranı sipariş bilgisini serverdan otomatik doldurur ve client alanlarını göndermez',()=>{
  const cargo=block(admin,'const cargoFilterState','async function renderNotificationSettings');
  assert.match(cargo,/async function openCargoCreateDialog/);
  assert.match(cargo,/Bilgiler gerçek sipariş kaydından otomatik alınır/);
  assert.match(cargo,/o\.customer\?\.fullName/);assert.match(cargo,/o\.customer\?\.phone/);assert.match(cargo,/o\.customer\?\.address/);
  const create=block(cargo,'async function createCargoForOrder','async function resendCargoOrder');
  assert.match(create,/body:'\{\}'/);assert.doesNotMatch(create,/address|total|customer/);
});

test('kargo oluşturma server gerçek siparişi kullanıyor ve başarılı cevap olmadan created yapmıyor',()=>{
  const create=block(server,'async function createCargoForIndexedOrder','function cargoQueryRows');
  assert.match(create,/const found=cargoPanelOrder\(orderId\)/);
  assert.match(create,/status:'creating'/);
  const call=create.indexOf('await cargoService.createShipment({order})'),made=create.indexOf("shipment.status='created'");assert.ok(call>=0&&made>call);
  assert.doesNotMatch(create,/req\.body.*total|req\.body.*address/);
  assert.match(create,/shipment\.status='error'/);
});

test('başarılı kargo varken normal create çift kayıt oluşturmaz; resend bilinçli confirm ister',()=>{
  assert.match(server,/if\(existing&&!resend\).*CARGO_ALREADY_CREATED/s);
  assert.match(server,/\/resend'.*req\.body\?\.confirm!==true/s);
  assert.match(admin,/confirm\('Bu sipariş için bilinçli olarak yeni bir kargo kaydı oluşturulsun mu\?/);
});

test('cargo kayıtları sipariş tablosunu şişirmeden ayrı state dosyalarında tutuluyor ve timeline timestamp içeriyor',()=>{
  for(const f of ['cargo_order_index.json','cargo_records.json','cargo_events.json'])assert.match(server,new RegExp(f.replace('.','\\.')));
  assert.match(server,/orderId:String\(order\.id\)/);assert.match(server,/appendCargoEvent/);assert.match(server,/at:new Date\(\)\.toISOString\(\)/);
  assert.doesNotMatch(server,/order\.barcode\s*=|order\.trackingNumber\s*=/);
});

test('kargo admin APIleri admin korumalı ve mutasyonlar same-origin kontrollü',()=>{
  for(const route of ["app.get('/api/admin/cargo/orders'","app.get('/api/admin/cargo/orders/:id'","app.get('/api/admin/cargo/orders/:id/label'"])assert.match(server,new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'.*requireAdmin'));
  for(const route of ["app.post('/api/admin/cargo/orders/:id/create'","app.post('/api/admin/cargo/orders/:id/resend'","app.post('/api/admin/cargo/orders/:id/refresh'","app.post('/api/admin/cargo/bulk-create'"])assert.match(server,new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'.*requireAdmin,sameOriginGuard'));
});

test('etiket ayrı print template üzerinden gerçek shipment/order verisiyle hazırlanıyor',()=>{
  const cargo=block(admin,'const cargoFilterState','async function renderNotificationSettings');
  assert.match(cargo,/function cargoLabelPrintHtml/);assert.match(cargo,/SHAZ Kargo Etiketi/);assert.match(cargo,/Tahsilat:/);assert.match(cargo,/Ürün:/);
  const labelBlock=block(server,"app.get('/api/admin/cargo/orders/:id/label'","app.get('/api/orders'");assert.match(labelBlock,/barcode:shipment\.barcode/);assert.doesNotMatch(labelBlock,/FAKE|DUMMY|rastgele takip/i);
});


test('manuel push raporu server tarafında 8 saniyede hızlı sonuçlanır, 12 saatlik cihaz health state değişmez',()=>{
  assert.match(server,/const MANUAL_PUSH_REPORT_ACK_MS=8000/);
  assert.match(server,/manualReportDeadline=String\(row\.kind\|\|''\)==='manual'/);
  assert.match(server,/scheduleManualPushReportDeadline\(deliveryId\)/);
  assert.match(server,/const DELIVERY_HEALTH_WATCH_MS=12\*60\*60\*1000/);
  assert.match(server,/if\(manualReportDeadline&&now>=manualReportDeadline\)expired=true/);
});

test('manuel push teyidi hızlı güncellenir ama local sahte final failure üretmez',()=>{
  const push=block(admin,'async function refreshManualPushDelivery','function closeMemberPushModal');
  assert.match(push,/setTimeout\(r,150\)/);assert.match(push,/if\(!sseOpen\)/);assert.doesNotMatch(push,/ackWindowExpired\s*:\s*true/);
  assert.match(admin,/payload\.type==='push-delivery-update'/);
});

test('PWA background lifecycle hızlı gönderilir ve ghost PWA tabı 45 saniye online tutamaz',()=>{
  const life=block(app,'function sendShazPresenceLifecycle','function shazHandleLocalPresence');
  assert.match(life,/fetch\('\/api\/activity\/presence'/);assert.match(life,/sendBeacon/);
  assert.match(server,/if\(clientContext==='pwa'\).*other\.clientContext!=='pwa'.*other\.presenceState=presenceState/s);
  assert.match(server,/PRESENCE_ONLINE_MS=45000/);
});

test('package bağımlılıkları değişmedi ve sahte package-lock oluşturulmadı',()=>{
  const pkg=JSON.parse(read('package.json'));
  assert.deepEqual(pkg.dependencies,{express:'^4.21.2',multer:'^2.0.2',xlsx:'^0.18.5',sharp:'^0.34.4','web-push':'^3.6.7'});
  assert.equal(fs.existsSync(path.join(root,'package-lock.json')),false);
});
