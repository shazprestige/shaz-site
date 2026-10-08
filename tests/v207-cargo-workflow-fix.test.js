const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js'),admin=read('public/admin.js'),css=read('public/styles.css'),cargoServiceSrc=read('cargo-service.js');
const {createCargoService,providerMovementToWorkflowStage}=require('../cargo-service');
function block(src,a,b){const x=src.indexOf(a),y=src.indexOf(b,x);assert.ok(x>=0&&y>x,`block missing: ${a}`);return src.slice(x,y)}
const cargoAdmin=block(admin,'const cargoFilterState','async function renderNotificationSettings');

test('sekme sırası tam istenen sıra ve branch_waiting sayacıyla tanımlı',()=>{
  const labels=['TÜM SİPARİŞLER','YENİ','HAZIRLANIYOR','GÖNDERİLDİ','YOLDA','ŞUBEDE BEKLİYOR','TESLİM EDİLDİ','İADE'];
  let p=-1;for(const label of labels){const n=cargoAdmin.indexOf(label);assert.ok(n>p,label);p=n}
  assert.match(server,/branch_waiting:\{code:'branch_waiting',label:'Şubede Bekliyor'\}/);
  assert.match(server,/branch_waiting:0/);
});

test('sıradan şube hareketleri branch_waiting olmaz, açık müşteri şube bekleme hareketleri olur',()=>{
  for(const text of ['Çıkış şubesine kabul edildi','Transfer şubesine ulaştı','Aktarma merkezinde','Teslimat şubesine ulaştı','Şubeler arası transfer','Dağıtım için teslimat şubesine geldi']){
    assert.notEqual(providerMovementToWorkflowStage({status:'handed_over',movementText:text,currentStage:'in_transit'}),'branch_waiting',text);
  }
  for(const text of ['Şubede bekliyor','Şubeden teslim','Alıcı şubeden teslim alacak','Müşteri teslimat şubesinden alacak','Alıcı gelmesi bekleniyor, şubede','Teslim edilemedi, şubede alıcı bekleniyor']){
    assert.equal(providerMovementToWorkflowStage({status:'handed_over',movementText:text,currentStage:'in_transit'}),'branch_waiting',text);
  }
});

test('branch_waiting gerçek final ve yeniden dağıtım geçişlerini destekliyor',()=>{
  assert.equal(providerMovementToWorkflowStage({status:'delivered',movementText:'Teslim edildi',currentStage:'branch_waiting'}),'delivered');
  assert.equal(providerMovementToWorkflowStage({status:'returned',movementText:'İade sürecinde',currentStage:'branch_waiting'}),'returned');
  assert.equal(providerMovementToWorkflowStage({status:'out_for_delivery',movementText:'Yeniden dağıtıma çıktı',currentStage:'branch_waiting'}),'in_transit');
  assert.equal(providerMovementToWorkflowStage({status:'handed_over',movementText:'Teslimat şubesine ulaştı',currentStage:'branch_waiting'}),null);
});

test('provider gerçek hareket metni ve gerçek durum zamanı response içinden taşınıyor',async()=>{
  const svc=createCargoService({env:{YESILKAR_CREATE_URL:'https://example.test/create',YESILKAR_AUTH_HEADER_NAME:'Authorization',YESILKAR_API_KEY:'secret',YESILKAR_FROM_HEADER_NAME:'From',YESILKAR_API_FROM:'SHAZ',YESILKAR_BRANCH_CODE:'DY',YESILKAR_AMOUNT_TYPE_ID:'3'},fetchImpl:async()=>({ok:true,status:200,text:async()=>JSON.stringify({data:{barcode:'DY0001',status:'Teslim Edildi',hareket_aciklama:'Alıcıya teslim edildi',teslim_tarihi:'06.10.2026 14:20:00'}})})});
  const r=await svc.createShipment({order:{id:'SHZ1',payment:'cod',total:10,customer:{fullName:'A',province:'Kocaeli',district:'Darıca',fullAddress:'X',phone:'05000000000'}}});
  assert.equal(r.barcode,'DY0001');assert.equal(r.providerMovementText,'Alıcıya teslim edildi');assert.equal(r.providerStatusAt,'2026-10-06T11:20:00.000Z');
});

test('provider yenilemesi yalnız aktif admin isteğiyle, 12 dakika sınırı ve kontrollü concurrency ile çalışıyor',()=>{
  assert.match(server,/CARGO_BACKGROUND_REFRESH_MS=12\*60\*1000,CARGO_BACKGROUND_CONCURRENCY=1/);
  assert.match(server,/async function runCargoBackgroundProviderRefresh/);
  assert.match(server,/CARGO_FINAL_PROVIDER_STATES\.has/);
  assert.match(server,/Promise\.all\(Array\.from\(\{length:Math\.min\(CARGO_BACKGROUND_CONCURRENCY,ids\.length\)\}/);
  assert.match(server,/kickCargoRefreshForActiveAdmin/);
  assert.match(server,/app\.post\('\/api\/admin\/cargo\/active-refresh',requireAdmin,sameOriginGuard/);
  assert.doesNotMatch(server,/setInterval\(\(\)=>runCargoBackgroundProviderRefresh\(/);
});

test('refresh hatası son doğru shipment statusunu error yapmıyor, yalnız güvenli kontrol bilgisi yazıyor',()=>{
  const refresh=block(server,'async function refreshCargoShipmentStatus','async function runCargoBackgroundProviderRefresh');
  const c=refresh.slice(refresh.indexOf('catch(e)'));
  for(const key of ['lastCheckedAt','lastRefreshError','lastRefreshErrorAt','lastRefreshErrorType'])assert.match(c,new RegExp(key+'='));
  assert.doesNotMatch(c,/row\.status\s*=\s*['"]error['"]/);
});

test('secret değerler hata/log metninde redacted ediliyor',()=>{
  const safe=block(server,'function cargoSecretSafeText','function cargoMarkIntegrationSuccess');
  for(const key of ['YESILKAR_API_KEY','YESILKAR_AUTH_HEADER_VALUE','YESILKAR_API_FROM'])assert.match(safe,new RegExp(key));
  assert.match(safe,/\[redacted\]/);
  const log=block(server,'function cargoLogFailure','async function createCargoForIndexedOrder');
  assert.doesNotMatch(log,/process\.env\.YESILKAR_API_KEY|headers\s*:/);
});

test('başarılı shipment varken sonraki duplicate create aktif shipmentı Hata yapmıyor',()=>{
  const view=block(server,'function cargoOrderView','function cargoOrderDetailPayload');
  assert.match(view,/recentCreateError=!active&&latest\?\.status==='error'/);
  const create=block(server,'async function createCargoForIndexedOrder','function syncCargoWorkflowFromProvider');
  assert.match(create,/cargoCreateErrorLooksDuplicate\(e\)&&otherSuccess/);
  assert.match(create,/duplicate_create_ignored/);
  assert.match(create,/return otherSuccess/);
});

test('aynı sipariş için backend create kilidi eşzamanlı işleri sıraya alıyor',async()=>{
  const src=block(server,'const cargoCreateLocks=new Map();','function ensureCargoFeatureState');
  const {withCargoCreateLock}=Function(`${src};return {withCargoCreateLock};`)();
  const order=[];
  const a=withCargoCreateLock('SHZ104',async()=>{order.push('a-start');await new Promise(r=>setTimeout(r,15));order.push('a-end')});
  const b=withCargoCreateLock('SHZ104',async()=>{order.push('b-start');order.push('b-end')});
  await Promise.all([a,b]);assert.deepEqual(order,['a-start','a-end','b-start','b-end']);
});

test('eşzamanlı veya belirsiz create ikinci kör POST üretmiyor',()=>{
  const create=block(server,'async function createCargoForIndexedOrder','function syncCargoWorkflowFromProvider');
  assert.match(create,/latest\?\.status==='creating'.*CARGO_CREATE_IN_PROGRESS/s);
  assert.match(create,/latest\?\.status==='error'.*cargoCreateErrorLooksDuplicate.*recoverCargoCreateIfPossible/s);
  assert.match(create,/CARGO_CREATE_RECONCILE_REQUIRED/);
  assert.equal((create.match(/cargoService\.createShipment\(/g)||[]).length,1);
  assert.match(cargoServiceSrc,/statusUrlTemplate\.includes\('\{order_number\}'\)/);assert.ok(cargoServiceSrc.includes("searchParams.set('sipno',wanted)"));assert.ok(!cargoServiceSrc.includes("searchParams.set('show_page','50')"));
  assert.match(server,/const cargoCreateLocks=new Map\(\)/);assert.match(server,/withCargoCreateLock\(orderId/);
});



test('duplicate create recovery dokümante edilmiş cargo sipno sorgusundan gerçek DY barkodu buluyor',async()=>{
  const calls=[];
  const svc=createCargoService({env:{YESILKAR_CREATE_URL:'http://webpostman.test/restapi/client/consignment/add',YESILKAR_STATUS_URL_TEMPLATE:'http://webpostman.test/restapi/client/consignments?barcode={barcode}',YESILKAR_AUTH_HEADER_NAME:'Authorization',YESILKAR_API_KEY:'secret',YESILKAR_FROM_HEADER_NAME:'From',YESILKAR_API_FROM:'user@example.com',YESILKAR_BRANCH_CODE:'DY',YESILKAR_AMOUNT_TYPE_ID:'3'},fetchImpl:async url=>{calls.push(String(url));return {ok:true,status:200,text:async()=>JSON.stringify({error:false,data:[{kayitno:'321',musteribarkod:'DY0000000104',gonderino:'4300000104',kurcikno:'343000000104',sipno:'SHZ104',telno:'5321234567',alimtarihi:'2026-10-06',statu_no:'00',sonuc:'Kabul Bekliyor'}]})}}});
  const r=await svc.lookupShipmentByOrderNumber({orderNumber:'SHZ104',order:{createdAt:'2026-10-05T21:00:00.000Z',customer:{phone:'05321234567'}}});
  assert.equal(r.barcode,'DY0000000104');assert.equal(r.recordId,'321');assert.equal(r.providerOrderNumber,'SHZ104');
  assert.match(calls[0],/\/restapi\/client\/cargo\?sipno=SHZ104/);
});


test('alfanümerik sipno doğrudan sonuç vermezse cargo telefon ve alım tarih aralığıyla güvenli fallback yapıyor',async()=>{
  const calls=[];
  const env={YESILKAR_CREATE_URL:'http://webpostman.test/restapi/client/consignment/add',YESILKAR_STATUS_URL_TEMPLATE:'http://webpostman.test/restapi/client/consignments?barcode={barcode}',YESILKAR_AUTH_HEADER_NAME:'Authorization',YESILKAR_API_KEY:'secret',YESILKAR_FROM_HEADER_NAME:'From',YESILKAR_API_FROM:'user@example.com',YESILKAR_BRANCH_CODE:'DY',YESILKAR_AMOUNT_TYPE_ID:'3'};
  const svc=createCargoService({env,fetchImpl:async url=>{calls.push(String(url));const u=new URL(String(url));if(u.searchParams.has('sipno'))return {ok:true,status:200,text:async()=>JSON.stringify({error:false,data:[]})};return {ok:true,status:200,text:async()=>JSON.stringify({error:false,data:[{kayitno:'321',musteribarkod:'DY0000000002',gonderino:'4300000002',sipno:'SHZ104',telno:'5321234567',alimtarihi:'2026-10-06',statu_no:'01',sonuc:'Kabul Edildi'}]})}}});
  const r=await svc.lookupShipmentByOrderNumber({orderNumber:'SHZ104',order:{createdAt:'2026-10-05T19:54:33+03:00',customer:{phone:'05321234567'}}});
  assert.equal(r.barcode,'DY0000000002');assert.equal(r.providerOrderNumber,'SHZ104');
  assert.match(calls[0],/\/restapi\/client\/cargo\?sipno=SHZ104/);assert.match(calls[1],/telno=5321234567/);assert.match(calls[1],/alim_start=04-10-2026/);assert.match(calls[1],/alim_end=07-10-2026/);
});

test('duplicate reconcile bulunamazsa create penceresi kapanmıyor ve DY barkod alanına yönlendiriyor',()=>{
  const src=block(cargoAdmin,'async function createCargoForOrder','async function attachExistingCargo');
  assert.match(src,/existingBarcode[\s\S]*attachExistingCargo\(orderId,btn\)/);assert.match(src,/CARGO_CREATE_RECONCILE_REQUIRED[\s\S]*cargoExistingBarcode[\s\S]*input\?\.focus\(\);return}/);
  assert.match(cargoAdmin,/cargoCreateReconcileNotice/);
});

test('provider takip numarası önceliği korunuyor ve alım tarihi teslim/status tarihi sayılmıyor',()=>{
  const svc=createCargoService({env:{}});
  const r=svc.resultFromProvider({data:{musteribarkod:'DY0000000002',gonderino:'4300000104',kurcikno:'343000000104',alimtarihi:'2026-10-06'}});
  assert.equal(r.trackingNumber,'4300000104');assert.equal(r.providerStatusAt,'');
});

test('mevcut DY barkodu consignments endpointinden doğrulanıp aynı SHZ siparişine güvenle bağlanabiliyor',async()=>{
  const calls=[];
  const svc=createCargoService({env:{YESILKAR_CREATE_URL:'http://webpostman.test/restapi/client/consignment/add',YESILKAR_STATUS_URL_TEMPLATE:'http://webpostman.test/restapi/client/consignments?barcode={barcode}',YESILKAR_AUTH_HEADER_NAME:'Authorization',YESILKAR_API_KEY:'secret',YESILKAR_FROM_HEADER_NAME:'From',YESILKAR_API_FROM:'user@example.com',YESILKAR_BRANCH_CODE:'DY',YESILKAR_AMOUNT_TYPE_ID:'3'},fetchImpl:async url=>{calls.push(String(url));return {ok:true,status:200,text:async()=>JSON.stringify({result:[{id:321,barcode:'DY0000000002',order_number:'SHZ104',telephone:'5321234567'}]})}}});
  const r=await svc.lookupShipmentByBarcode({barcode:'DY0000000002',orderNumber:'SHZ104',order:{customer:{phone:'05321234567'}}});
  assert.equal(r.barcode,'DY0000000002');assert.equal(r.providerOrderNumber,'SHZ104');assert.match(calls[0],/\/restapi\/client\/consignments\?barcode=DY0000000002/);
  assert.match(server,/\/attach-existing'/);assert.match(cargoAdmin,/Mevcut Barkodu Doğrula ve Bağla/);
});

test('duplicate recovery aynı order_number olsa bile açıkça farklı müşterinin eski kaydını bağlamıyor',async()=>{
  const svc=createCargoService({env:{YESILKAR_CREATE_URL:'http://webpostman.test/restapi/client/consignment/add',YESILKAR_STATUS_URL_TEMPLATE:'http://webpostman.test/restapi/client/consignments?barcode={barcode}',YESILKAR_AUTH_HEADER_NAME:'Authorization',YESILKAR_API_KEY:'secret',YESILKAR_FROM_HEADER_NAME:'From',YESILKAR_API_FROM:'user@example.com',YESILKAR_BRANCH_CODE:'DY',YESILKAR_AMOUNT_TYPE_ID:'3'},fetchImpl:async()=>({ok:true,status:200,text:async()=>JSON.stringify({result:[{id:11,barcode:'DYOLD',order_number:'SHZ104',telephone:'5550000000',created_at:'01.01.2025 10:00:00'}]})})});
  const r=await svc.lookupShipmentByOrderNumber({orderNumber:'SHZ104',order:{createdAt:'2026-10-05T21:00:00.000Z',customer:{phone:'05321234567'}}});
  assert.equal(r,null);
});

test('arka plan mevcut duplicate error kaydını da otomatik reconcile etmeye çalışıyor',()=>{
  const src=block(server,'async function reconcileDuplicateCargoCreates','function cargoQueryRows');
  assert.match(src,/latest\.status!=='error'/);assert.match(src,/cargoCreateErrorLooksDuplicate/);assert.match(src,/recoverCargoCreateIfPossible/);assert.match(src,/await reconcileDuplicateCargoCreates\(\)/);
});
test('ana SHAZ sipariş numarası formatı korunup silinen geçmiş nedeniyle geriye sarmıyor',()=>{
  const src=block(server,'function nextLocalOrderId','let sheetSyncRunning');
  const data={
    'legal_acceptances.json':[{orderId:'SHZ12'}],
    'cargo_order_index.json':[{orderId:'SHZ11'}],
    'cargo_records.json':[]
  };
  const fn=Function('readJson',`${src};return nextLocalOrderId;`)((name,fallback)=>data[name]||fallback);
  assert.equal(fn([{id:'SHZ9'}]),'SHZ13');
});

test('resend ana SHAZ IDyi değiştirmeden yeni provider order_number ve yeni shipment kullanıyor',()=>{
  const svc=createCargoService({env:{YESILKAR_AMOUNT_TYPE_ID:'3'}});
  const p=svc.buildShipmentPayload({id:'SHZ44',payment:'cod',total:100,customer:{}},{orderNumber:'SHZ44-R2'});
  assert.equal(p.order_number,'SHZ44-R2');
  assert.match(server,/providerOrderNumber:cargoProviderOrderNumber\(order\.id,resend\)/);
  assert.match(server,/resendOf:resend&&existing\?existing\.id:null/);
  assert.match(server,/`\$\{orderId\}-R\$\{prior\}`/);
});

test('normal create payloadı hâlâ ana order.id kullanıyor ve DY barkod providerdan geliyor',()=>{
  const svc=createCargoService({env:{YESILKAR_AMOUNT_TYPE_ID:'3'}}),p=svc.buildShipmentPayload({id:'SHZ55',payment:'cod',total:100,customer:{}});
  assert.equal(p.order_number,'SHZ55');assert.equal(Object.hasOwn(p,'barcode'),false);
  assert.doesNotMatch(cargoServiceSrc,/barcode\s*:\s*['"]SHZ|barcode\s*:\s*['"]SP/);
});

test('tablo sütunları yeni sırada; Kargo Firması ve İşlemler sütunu yok, Aşama yalnız tüm siparişlerde',()=>{
  const header=block(cargoAdmin,'function cargoTableHeaderHtml','function renderCargoOrderRows');
  const labels=['Sipariş ID','Üyelik','Ad Soyad','Telefon','İl / İlçe','Adres','Ödeme','Toplam','Sipariş Tarihi','Aşama','Kargo Durumu','Barkod / Takip','Kargo Oluşturma','Son Kargo Güncelleme'];let p=-1;for(const label of labels){const n=header.indexOf(label);assert.ok(n>p,label);p=n}
  assert.doesNotMatch(header,/Kargo Firması|İşlemler/);
  assert.match(header,/showStage=cargoFilterState\.stage==='all'/);assert.match(header,/showStage\?'<b>Aşama<\/b>':''/);
});

test('üyelik tespiti yalnız gerçek userId/memberId ilişkisini kullanıyor, isim telefon tahmini yok',()=>{
  const src=block(server,'function cargoOrderMembership','function cargoOrderView');
  assert.match(src,/order\.userId\|\|order\.memberId/);assert.match(src,/String\(x\.id\)===userId/);
  assert.doesNotMatch(src,/email|phone|fullName/);
  const fn=Function('cargoText','readJson',`${src};return cargoOrderMembership;`)((v)=>String(v||'').trim(),()=>[{id:'U1',deleted:false},{id:'U2',deleted:true}]);
  assert.equal(fn({email:'same@example.com',phone:'0500'}).isMember,false);assert.equal(fn({userId:'U1'}).isMember,true);assert.equal(fn({userId:'U2'}).isMember,false);
});

test('adres substring ile kesilmiyor, wrap oluyor ve checkbox/üyelik tiki büyütülmüş',()=>{
  assert.doesNotMatch(cargoAdmin,/cargoAddressShort|slice\(0,39\).*…/s);
  assert.match(css,/\.cargoAddress\{[^}]*white-space:normal[^}]*word-break:break-word/s);
  assert.match(css,/\.cargoPick input,#cargoSelectAll\{width:18px;height:18px/);
  assert.match(css,/\.cargoMembershipMark\{font-size:16px/);
});

test('seçili sipariş üst işlem barında istenen tüm işlemler var',()=>{
  const actions=block(cargoAdmin,'function cargoDetailActionsHtml','function cargoErrorNote');
  for(const text of ['Etiketi Görüntüle/Yazdır','Gönderildi Olarak İşaretle','Yeni Barkod Oluştur','Tamamen Sil'])assert.match(actions,new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  for(const text of ['Kargo Detayı','Kargo Durumunu Güncelle','Geri Al','Yeniden Kargoya Gönder'])assert.doesNotMatch(actions,new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(cargoAdmin,/Kargo Oluştur \/ Tekrar Dene/);assert.match(cargoAdmin,/Toplu Etiket Yazdır/);
});

test('kargo ve üyeler satırları tek click gecikmeli açılır, double click ve text selection iptal eder',()=>{
  assert.match(cargoAdmin,/ondblclick="cargoRowDoubleClick\(event\)"/);assert.match(cargoAdmin,/setTimeout\(\(\)=>\{if\(!cargoHasTextSelection\(\)\)openCargoOrderDetail\(id\)\},220\)/);assert.match(cargoAdmin,/function cargoRowDoubleClick\(\)\{clearTimeout\(cargoRowClickTimer\)\}/);
  assert.match(admin,/ondblclick="memberRowDoubleClick\(event\)"/);assert.match(admin,/function memberRowDoubleClick\(\)\{clearTimeout\(memberRowClickTimer\)\}/);assert.match(admin,/window\.getSelection/);
});

test('silinen üyeler backend aktif listeden ve frontend state/sayaçtan çıkarılıyor',()=>{
  const members=block(server,'function adminMemberRows','function filterAdminMembers');assert.match(members,/\.filter\(u=>!u\.deleted\)/);
  assert.match(admin,/members=\(members\|\|\[\]\)\.filter\(x=>String\(x\.id\)!==String\(userId\)\)/);
  assert.match(admin,/memberFilteredTotal=Math\.max\(0,Number\(memberFilteredTotal\|\|0\)-1\)/);
  assert.doesNotMatch(block(admin,'async function renderMembers','let memberSearchDebounce'),/>Silinmiş<\/option>/);
});

test('Üyelik / Son Giriş başlığı kendi sınıfıyla hizalı ve ilgili yazılar ölçülü büyütülmüş',()=>{
  assert.match(admin,/class="memberMembershipHeader">Üyelik \/ Son Giriş/);
  assert.match(css,/\.memberMembershipHeader\{[^}]*font-size:10\.5px/s);assert.match(css,/\.memberMembership b\{font-size:12px!important\}/);assert.match(css,/\.memberMembership small\{font-size:10px!important\}/);
});

test('Sipariş Tarihi ve Teslim Tarihi tarih aralığı filtresi, teslimde yalnız deliveredAt kullanıyor',()=>{
  assert.match(cargoAdmin,/Sipariş Tarihi<button[^>]*openCargoDateRangePicker\('order'\)/);assert.match(cargoAdmin,/Teslim Tarihi<button[^>]*openCargoDateRangePicker\('delivery'\)/);
  assert.match(cargoAdmin,/cargoRangeFrom/);assert.match(cargoAdmin,/cargoRangeTo/);
  const query=block(server,'function cargoQueryRows','function cargoStageCounts');
  assert.match(query,/orderDateFrom/);assert.match(query,/orderDateTo/);assert.match(query,/deliveryDateFrom/);assert.match(query,/deliveryDateTo/);assert.match(query,/deliveryDt=r\.deliveredAt\?/);
  assert.doesNotMatch(query,/deliveryDt=r\.deliveredAt\?new Date\(r\.orderCreatedAt/);
});

test('arama yazarken filtre DOMu yeniden kurulmadığı için focus/caret korunuyor',()=>{
  const debounce=block(cargoAdmin,'function debouncedCargoFilter','function cargoChangePage');
  assert.match(debounce,/refreshCargoResults\(\)/);assert.doesNotMatch(debounce,/renderAllCustomers/);
  const apply=block(cargoAdmin,'function applyCargoDataWithoutRebuildingFilters','async function refreshCargoResults');assert.match(apply,/renderCargoOrderRows\(\)/);assert.doesNotMatch(apply,/\.innerHTML=`<div class="cargoPageHead/);
});

test('üst Yenile butonu ve eski başlangıç açıklaması kaldırılmış, entegrasyon kutusu kalmış',()=>{
  assert.doesNotMatch(cargoAdmin,/Bu ekran yalnız yeni sistem devreye girdikten sonra/);assert.doesNotMatch(cargoAdmin,/>Yenile<\/button>/);
  assert.match(cargoAdmin,/Aras Kargo \/ YeşilKar/);assert.match(cargoAdmin,/API bağlantısı yapılandırılmış\./);assert.match(cargoAdmin,/cargoConfig\.health!=='error'/);
});

test('provider hareketi detayda aynen gösteriliyor ve stage history manual/automatic_provider kaynağını koruyor',()=>{
  assert.match(cargoAdmin,/Son Gerçek Provider Hareketi/);assert.match(cargoAdmin,/o\.providerMovementText/);
  assert.match(server,/source:'automatic_provider'/);assert.match(server,/source:'manual'/);assert.match(server,/stageHistory=/);
});

test('provider final durumları manuel Gönderildi aşamasında takılmaz',()=>{
  const sync=block(server,'function syncCargoWorkflowFromProvider','async function refreshCargoShipmentStatus');
  assert.match(sync,/if\(target==='delivered'\|\|target==='returned'\)\{setCargoAdminStage/);
  const finalPos=sync.indexOf("target==='delivered'"),transitPos=sync.indexOf("target==='in_transit'");assert.ok(finalPos>=0&&finalPos<transitPos);
});

test('etiket tekrar baskı ve toplu baskı print geçmişinden bağımsız, tek popup dokümanında sayfalı',()=>{
  assert.doesNotMatch(cargoAdmin,/alreadyPrinted|printStatus|daha önce yazdırıldı/i);
  assert.match(cargoAdmin,/function cargoBulkLabelPrintHtml\(labels=\[\]\)/);assert.match(cargoAdmin,/labels\.map\(label=>`<div class="labelPage">/);assert.match(cargoAdmin,/window\.open\('','_blank'\)/);
  const labels=block(server,"app.post('/api/admin/cargo/labels'","app.post('/api/admin/cargo/orders/:id/delete'");assert.match(labels,/!shipment\|\|!shipment\.barcode/);assert.doesNotMatch(labels,/shipment\.barcode\|\|shipment\.trackingNumber/);assert.doesNotMatch(labels,/printed|printStatus/i);
});

test('kargo local tamamen silme iki aşamalı, providerı ve üyeyi silmiş gibi davranmıyor',()=>{
  assert.match(cargoAdmin,/İkinci onay/);assert.match(cargoAdmin,/WebPostman’daki gerçek kargo kaydı ayrı kalabilir/);
  const del=block(server,'function deleteCargoPanelOrder',"app.get('/api/admin/cargo/orders'");assert.doesNotMatch(del,/users\.json|consignment\/delete|webpostman/i);
});

test('backend değişikliği mevcut SSE üzerinden cargo-update yayınlayıp filtre DOMunu bozmadan UIyi yeniliyor',()=>{
  assert.match(server,/function publishAdminCargoUpdate/);assert.match(server,/type:'cargo-update'/);assert.match(server,/publishAdminCargoUpdate\(row\.orderId,'provider_refresh'\)/);
  assert.match(admin,/payload\.type==='cargo-update'\)scheduleCargoRealtimeRefresh\(\)/);assert.match(cargoAdmin,/function scheduleCargoRealtimeRefresh/);assert.match(cargoAdmin,/setTimeout\(\(\)=>refreshCargoResults\(\),120\)/);
});

test('package bağımlılıklarına dokunulmadı ve package-lock üretilmedi',()=>{
  const pkg=JSON.parse(read('package.json'));assert.deepEqual(pkg.dependencies,{express:'^4.21.2',multer:'^2.0.2',xlsx:'^0.18.5',sharp:'^0.34.4','web-push':'^3.6.7'});assert.equal(fs.existsSync(path.join(root,'package-lock.json')),false);
});
