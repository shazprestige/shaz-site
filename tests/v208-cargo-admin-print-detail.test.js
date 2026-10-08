const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const admin=read('public/admin.js'),server=read('server.js'),css=read('public/styles.css'),app=read('public/app.js');
function block(src,a,b){const x=src.indexOf(a),y=src.indexOf(b,x);assert.ok(x>=0&&y>x,`block missing: ${a}`);return src.slice(x,y)}
function sha(p){return crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')}
const cargoAdmin=block(admin,'const cargoFilterState','async function renderNotificationSettings');
const labelFns=Function(`${block(admin,'function cargoProviderBarcodeSvg','async function openCargoLabel')};return {cargoProviderBarcodeSvg,cargoLabelStyles,cargoLabelBodyHtml,cargoLabelPrintHtml,cargoBulkLabelPrintHtml}`)();
const sampleLabel=n=>({barcode:`DY00000000${String(n).padStart(2,'0')}`,orderId:`SHZ-TEST-${n}`,sender:'SHAZ PRESTIGE',recipient:`Müşteri ${n}`,phone:'05550000000',address:'Test adresi',payment:'Kapıda Ödeme',collectAmount:100+n,products:`SHAZ - NOVA x1`});

test('tek etiket tek print sayfası, beş etiket tek dokümanda beş print sayfası üretir',()=>{
  const one=labelFns.cargoLabelPrintHtml(sampleLabel(1));
  const five=labelFns.cargoBulkLabelPrintHtml([1,2,3,4,5].map(sampleLabel));
  assert.equal((one.match(/class="labelPage"/g)||[]).length,1);
  assert.equal((five.match(/class="labelPage"/g)||[]).length,5);
  assert.equal((five.match(/<html>/g)||[]).length,1);
  assert.match(five,/window\.onload=\(\)=>window\.print\(\)/);
});

test('toplu etiket tek popup kullanır ve print geçmişine göre eleme yapmaz',()=>{
  const bulk=block(cargoAdmin,'async function bulkPrintCargoLabels','function cargoWhatsappContactForRow');
  assert.equal((bulk.match(/window\.open\('','_blank'\)/g)||[]).length,1);
  assert.doesNotMatch(bulk,/alreadyPrinted|printStatus|daha önce basılmış|daha önce yazdırılmış/i);
  const route=block(server,"app.post('/api/admin/cargo/labels'","app.post('/api/admin/cargo/orders/:id/delete'");
  assert.doesNotMatch(route,/alreadyPrinted|printStatus|printed/i);
});

test('etiket yalnız gerçek DY provider barkod değerini kabul eder, SHZ/SP sahte barkod çizmez',()=>{
  assert.match(labelFns.cargoProviderBarcodeSvg('DY0000000002'),/<svg/);
  assert.equal(labelFns.cargoProviderBarcodeSvg('SHZ0000000002'),'');
  assert.equal(labelFns.cargoProviderBarcodeSvg('SP0000000002'),'');
  assert.equal(labelFns.cargoProviderBarcodeSvg(''),'');
  const body=labelFns.cargoLabelBodyHtml({...sampleLabel(2),barcode:'SHZ123'});
  assert.match(body,/GERÇEK WEBPOSTMAN DY BARKODU ALINMADAN ETİKET BASILAMAZ/);
});

test('barkodsuz shipment toplu etikette atlanır ve trackingNumber barkod yerine kullanılmaz',()=>{
  const route=block(server,"app.post('/api/admin/cargo/labels'","app.post('/api/admin/cargo/orders/:id/delete'");
  assert.match(route,/if\(!shipment\|\|!shipment\.barcode\)/);
  assert.doesNotMatch(route,/shipment\.barcode\|\|shipment\.trackingNumber/);
  assert.match(route,/skipped\.push/);
});

test('print CSS her etiketi ayrı 100x140 sayfada tutar ve bölünmesini engeller',()=>{
  const styles=labelFns.cargoLabelStyles();
  assert.match(styles,/@page\{size:100mm 140mm;margin:0\}/);
  assert.match(styles,/break-after:page/);
  assert.match(styles,/page-break-after:always/);
  assert.match(styles,/break-inside:avoid/);
  assert.match(styles,/page-break-inside:avoid/);
  assert.match(styles,/body\{background:#edf0f3;padding:24px 0\}/);
  assert.match(styles,/\.label\{width:100mm;min-height:108mm;border:1\.4px solid #222;background:#fff/);
});

test('Sipariş ID -> Yazı -> Üyelik kolon sırası ve header/row checkbox aynı grid kolonundadır',()=>{
  const head=block(cargoAdmin,'function cargoTableHeaderHtml','function renderCargoOrderRows');
  const seq=['Sipariş ID','>Yazı<','>Üyelik<','>Ad Soyad<','>Telefon<','>İl / İlçe<','>Adres<'];let at=-1;
  for(const token of seq){const next=head.indexOf(token);assert.ok(next>at,token);at=next}
  assert.match(css,/\.cargoTableWrap\.with-stage \.cargoOrderHeader,\.cargoTableWrap\.with-stage \.cargoOrderRow\{grid-template-columns:42px 100px 56px 60px/);
  assert.match(css,/\.cargoHeaderPick,\.cargoPick\{display:grid!important;place-items:center!important/);
  assert.match(css,/\.cargoHeaderPick input,\.cargoPick input,#cargoSelectAll\{margin:0!important\}/);
});

test('Yazı Var/Yok yalnız gerçek kayıtlı kişiselleştirme datasından hesaplanır',()=>{
  const src=block(server,'function cargoOrderHasPersonalization','function cargoProducts');
  const fn=Function(`${src};return cargoOrderHasPersonalization`)();
  assert.equal(fn({items:[{personalized:true,writes:[],photoCustomizations:[]}]}),false,'sadece personalized flag tahmin olmamalı');
  assert.equal(fn({items:[{writes:[{text:'Furkan',position:'Kordon'}]}]}),true);
  assert.equal(fn({items:[{photoCustomizations:[{imageUrl:'/uploads/a.jpg'}]}]}),true);
  assert.equal(fn({personalizationSnapshots:[{customerValue:'ABC'}]}),true);
  assert.equal(fn({items:[{writes:[{text:'   '}],photoCustomizations:[{}]}]}),false);
  assert.match(cargoAdmin,/has-personalization/);assert.match(cargoAdmin,/no-personalization/);
});

test('üyelik tahmini yapılmaz; yalnız userId/memberId gerçek kullanıcı ID eşleşmesi kullanılır',()=>{
  const membership=block(server,'function cargoOrderMembership','function cargoOrderView');
  assert.match(membership,/order\.userId\|\|order\.memberId/);
  assert.match(membership,/String\(x\.id\)===userId/);
  assert.doesNotMatch(membership,/email|phone|fullName/);
});

test('tablo header arka planı kesintisiz gri ve tarih filtre yazısı normal weight',()=>{
  assert.match(css,/\.cargoOrderHeader\{background:#f4f5f6!important\}/);
  assert.match(css,/\.cargoDateRangeButton\{font-family:inherit!important;font-size:14px!important;font-weight:400!important/);
  assert.match(cargoAdmin,/class="formControl cargoDateRangeButton"/);
});

test('checkout sipariş notu overlayi en üst stacking seviyesinde görünür kalır',()=>{
  assert.match(app,/productNoteOverlay/);
  assert.match(css,/\.productNoteOverlay\{z-index:2147483647!important;isolation:isolate!important\}/);
  assert.match(app,/orderNote/);
});

test('detay ekranı gerçek müşteri, ödeme, ürün, kişiselleştirme ve shipment geçmişini gösterir',()=>{
  const detail=block(cargoAdmin,'async function openCargoOrderDetail','function closeCargoOrderDetail');
  for(const text of ['Sipariş Tarihi ve Saati','Ad Soyad','Telefon','E-posta','Üyelik','Adres Başlığı','İl','İlçe','Mahalle','Açık Adres','Sipariş Notu','Ödeme Yöntemi','Ara Toplam','Tahsilat','Sipariş Toplamı','Ürünler ve Kişiselleştirme','Gerçek Barkod','Takip Numarası','Kargo Oluşturma','Son Kargo Güncelleme','Gerçek Teslim Tarihi','Kargo Kayıt Geçmişi','Kargo İşlem Geçmişi'])assert.match(detail,new RegExp(text));
  const payload=block(server,'function cargoOrderDetailPayload','function cargoSecretSafeText');
  assert.match(payload,/products:cargoProducts\(order\)/);assert.match(payload,/personalizationSnapshots/);assert.match(payload,/shipments/);assert.doesNotMatch(payload,/Authorization|YESILKAR_API_KEY|password/i);
});

test('ürün fotoğrafı snapshot öncelikli, exact product ID fallbackli ve lightbox büyütme mevcut',()=>{
  const products=block(server,'function cargoProducts','function cargoShipmentRelevantData');
  assert.match(products,/serverMainProductImage\(product\)\|\|serverMainProductImage\(live\)/);
  assert.match(products,/byId\.get\(productId\)/);
  const ui=block(cargoAdmin,'function cargoImageButton','function cargoTimelineHtml');
  assert.match(ui,/cargoProductThumb/);assert.match(ui,/openCargoDetailImage/);assert.match(ui,/cargoImageLightbox/);assert.match(ui,/cargoPersonalPhoto/);
});

test('üst işlem UIından Kargo Detayı, Geri Al, Yeniden Kargoya Gönder ve Kargo Durumunu Güncelle kaldırılmıştır',()=>{
  const actions=block(cargoAdmin,'function cargoDetailActionsHtml','function cargoErrorNote');
  const shell=block(cargoAdmin,'function renderCargoManagementShell','function applyCargoDataWithoutRebuildingFilters');
  for(const text of ['Kargo Detayı','Geri Al','Yeniden Kargoya Gönder','Kargo Durumunu Güncelle']){assert.doesNotMatch(actions,new RegExp(text));assert.doesNotMatch(shell,new RegExp(text))}
  assert.match(actions,/Yeni Barkod Oluştur/);assert.match(actions,/Tamamen Sil/);
});

test('Yeni Barkod Oluştur yalnız aktif shipment + dirty ve final olmayan siparişte kullanılabilir',()=>{
  const view=block(server,'function cargoOrderView','function cargoOrderDetailPayload');
  assert.match(view,/canNewBarcode:!!active&&dirty&&!isFinal/);
  assert.match(view,/canCreate:stage==='new'&&!active/);
  assert.match(view,/canMarkSent:!!active&&stage==='preparing'&&!dirty/);
  const actions=block(cargoAdmin,'function cargoDetailActionsHtml','function cargoErrorNote');
  assert.match(actions,/cargoCanNewBarcode\(row\)\?`<button[^`]*Yeni Barkod Oluştur/s);
});

test('shipment-relevant admin değişikliği dirty yapar, not/email gibi etiket dışı alanlar tek başına relevant snapshotı değiştirmez',()=>{
  const relevantSrc=block(server,'function cargoShipmentRelevantData','function cargoShipmentDirtyError');
  const relevant=Function(`${relevantSrc};return cargoShipmentRelevantData`)();
  const a={customer:{fullName:'A',phone:'05550000000',province:'Kocaeli',district:'Darıca',fullAddress:'X',email:'a@x.com'},payment:'cod',total:100,orderNote:'N1',items:[{product:{id:'P1',name:'Saat',price:50},qty:2}]};
  const same={...a,customer:{...a.customer,email:'b@x.com'},orderNote:'N2'};
  assert.deepEqual(relevant(a),relevant(same));
  const changed={...a,customer:{...a.customer,fullAddress:'Y'}};assert.notDeepEqual(relevant(a),relevant(changed));
  const patch=block(server,"app.patch('/api/orders/:id'","app.delete('/api/orders'");
  assert.match(patch,/shipmentRelevantChanged&&activeShipment/);assert.match(patch,/order\.cargoShipmentDirty=true/);assert.match(patch,/shipment_dirty/);
});

test('dirty siparişte eski etiket ve Gönderildi işlemi backend tarafından engellenir',()=>{
  const label=block(server,"app.get('/api/admin/cargo/orders/:id/label'","app.post('/api/admin/cargo/labels'");
  const stage=block(server,"app.post('/api/admin/cargo/orders/:id/stage'","app.post('/api/admin/cargo/orders/:id/undo-stage'");
  assert.match(label,/cargoAssertShipmentCurrent\(found\.order\)/);
  assert.match(stage,/cargoAssertShipmentCurrent\(found\.order\)/);
  assert.match(server,/CARGO_BARCODE_STALE/);
  assert.match(server,/Sipariş bilgileri mevcut barkod oluşturulduktan sonra değiştirildi/);
});

test('yeni barkod mevcut güvenli resend/revision yoluyla gerçek provider shipment oluşturur, ana SHAZ IDyi değiştirmez',()=>{
  const route=block(server,"app.post('/api/admin/cargo/orders/:id/new-barcode'","app.post('/api/admin/cargo/orders/:id/resend'");
  assert.match(route,/createCargoForIndexedOrder\(req\.params\.id,\{resend:true\}\)/);
  const providerNo=block(server,'function cargoProviderOrderNumber','function applyCargoCreateResult');
  assert.ok(providerNo.includes('cargoText(`${orderId}-R${prior}`,120)'));
  assert.doesNotMatch(route,/order\.id\s*=/);
  const apply=block(server,'function applyCargoCreateResult','async function recoverCargoCreateIfPossible');
  assert.match(apply,/cargoClearShipmentDirty\(order\.id,shipment\.id\)/);
  assert.doesNotMatch(apply,/filter\([^\n]*cargo_records|writeJson\('cargo_records\.json',\[shipment\]\)/);
});

test('eski shipment history korunur ve detayda önceki/son kayıtlar görünür',()=>{
  assert.match(server,/function cargoRecordsForOrder\(orderId\).*\.filter\(x=>String\(x\.orderId\)===String\(orderId\)\)/s);
  assert.match(cargoAdmin,/Kargo Kayıt Geçmişi/);assert.match(cargoAdmin,/Önceki kayıt/);assert.match(cargoAdmin,/Son kayıt/);
});

test('duruma göre üst/toplu butonlar yalnız ortak geçerli işlemlerde görünür',()=>{
  const bulk=block(cargoAdmin,'function updateCargoBulkBar','function renderCargoPagination');
  assert.match(bulk,/selected\.every\(x=>x\.canCreate\)/);
  assert.match(bulk,/n>1&&selected\.every\(cargoCanLabel\)/);
  assert.match(bulk,/selected\.every\(x=>x\.canMarkSent&&!x\.shipmentDirty\)/);
  assert.match(bulk,/!!one&&cargoCanNewBarcode\(one\)/);
});

test('kişiselleştirme seçim kartları eşit dikdörtgen ölçüde ve öneri yazısı kart dışında',()=>{
  const option=block(app,'function positionOptionHtml','function walletPhotoFee');
  assert.match(option,/positionOptionWrap/);assert.match(option,/<\/label>\$\{pref\?'<small class=recommendedHint>/);
  assert.match(css,/\.positionOptionWrap\{flex:1 1 132px;[^}]*grid-template-rows:48px auto/s);
  assert.match(css,/\.positionOptionWrap>\.positionChoice\{width:100%!important;height:48px!important;min-height:48px!important/);
  assert.match(css,/border-radius:8px!important/);
  assert.match(css,/\.positionOptionWrap>\.recommendedHint\{display:block!important/);
});

test('+ Yeni Müşteri manuel siparişi misafir varsayılanıyla Yeni aşamasında ve normal order ID üretimiyle oluşur',()=>{
  assert.match(cargoAdmin,/onclick="openCargoManualOrder\(\)">\+ Yeni Müşteri/);
  const manual=block(server,"app.post('/api/admin/cargo/manual-order'","app.get('/api/orders'");
  assert.match(manual,/id:nextLocalOrderId\(orders\)/);assert.match(manual,/status:'new'/);assert.match(manual,/userId:member\?\.id\|\|null/);assert.match(manual,/customerId:member\?\.customerId\|\|null/);assert.match(manual,/registerCargoPanelOrder\(order\)/);
  assert.doesNotMatch(manual,/barcode\s*:|trackingNumber\s*:/);
  assert.match(manual,/String\(u\.id\)===memberUserId/);assert.doesNotMatch(manual,/u\.phone.*customer|u\.email.*customer/i);
});

test('manuel sipariş formu gerçek ürün/adet/fiyat, yazı, fotoğraf ve sipariş notu alanlarını taşır',()=>{
  const ui=block(admin,'function cargoManualItemRow','async function renderNotificationSettings');
  for(const cls of ['cargoManualProduct','cargoManualQty','cargoManualPrice','cargoManualText','cargoManualPosition','cargoManualPhotoUrl','cargoManualPhotoPosition','cargoManualProductNote'])assert.match(ui,new RegExp(cls));
  assert.match(ui,/cargoManualOrderNote/);assert.match(ui,/\/api\/admin\/cargo\/manual-order/);
});

test('Yazı=Var detayında metin/konum ve fotoğraf gerçek order datasından kaybolmaz',()=>{
  const product=block(cargoAdmin,'function cargoProductDetailHtml','function cargoTimelineHtml');
  assert.match(product,/<b>Yazı<\/b>/);assert.match(product,/Konum:/);assert.match(product,/<b>Fotoğraf<\/b>/);assert.match(product,/cargoPersonalPhoto/);
  const payload=block(server,'function cargoProducts','function cargoShipmentRelevantData');assert.match(payload,/writes:/);assert.match(payload,/photoCustomizations:/);
});

test('kargo etiketi çoklu ürün özetini gerçek order items üzerinden üretir',()=>{
  const payload=block(server,'function cargoLabelPayload','function cargoManualOrderOptions');
  assert.match(payload,/cargoProducts\(order\)\.map\(x=>`\$\{x\.name\} x\$\{x\.quantity\}`\)\.join\(', '\)/);
  assert.doesNotMatch(payload,/SHAZ - NOVA x1/);
});

test('click/double-click/text selection ve filtre caret koruma davranışı korunur',()=>{
  assert.match(cargoAdmin,/function cargoRowClick\(e,id\).*if\(e\.target\.closest\('button,input,a,select,label,textarea'\)\)return;.*cargoHasTextSelection\(\).*setTimeout/s);
  assert.match(cargoAdmin,/function cargoRowDoubleClick\(\)\{clearTimeout\(cargoRowClickTimer\)\}/);
  const debounce=block(cargoAdmin,'function debouncedCargoFilter','function cargoChangePage');assert.match(debounce,/refreshCargoResults\(\)/);assert.doesNotMatch(debounce,/renderAllCustomers/);
});

test('telefonun başında WhatsApp butonu var ve Üyeler ile aynı whatsappOpenUrl/template altyapısını kullanır',()=>{
  const rows=block(cargoAdmin,'function renderCargoOrderRows','function cargoSelectedRows');
  const wp=rows.indexOf('cargoWhatsappBtn'),phone=rows.indexOf("esc(row.phone||'—')");assert.ok(wp>=0&&phone>wp);
  const wa=block(cargoAdmin,'function cargoWhatsappContactForRow','function cargoManualProductOptionsHtml');
  assert.match(wa,/loadWhatsappTemplates/);assert.match(wa,/whatsappTemplateById/);assert.match(wa,/whatsappOpenUrl\(cargoWhatsappContext,t\)/);
});

test('branch_waiting, background provider refresh, duplicate create lock ve recovery yapıları korunur',()=>{
  assert.match(server,/branch_waiting:\{code:'branch_waiting'/);
  assert.match(server,/async function runCargoBackgroundProviderRefresh/);
  assert.match(server,/const cargoCreateLocks=new Map\(\)/);assert.match(server,/async function withCargoCreateLock/);
  assert.match(server,/async function recoverCargoCreateIfPossible/);assert.match(server,/lookupShipmentByOrderNumber/);
});

test('V211: WebPostman sorgu koruması güncellendi, PWA ve paket bağımlılıkları korunuyor',()=>{
  assert.match(read('cargo-service.js'),/rateLimitStatus/);
  assert.match(read('cargo-service.js'),/PROVIDER_GET_GAP_MS/);
  assert.equal(sha('public/service-worker.js'),'2f24ecba4e6a0c093e60c56db8c6210822a2c01372588ab66cc0cdfac63c7f49');
  assert.equal(sha('public/manifest.webmanifest'),'bf9255e1e91c42bb4557ff858c183d79e25a5adb3eddf0aaf4e46b944a9f2b00');
  assert.equal(sha('package.json'),'6bbf968f8e25f9df8807b723d75a8f4db667de519721d2c70d0dd9a71da9c274');
  assert.equal(fs.existsSync(path.join(root,'package-lock.json')),false);
});
