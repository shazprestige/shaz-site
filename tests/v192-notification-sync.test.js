const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const app=read('public/app.js');
const admin=read('public/admin.js');
const server=read('server.js');
const pkg=JSON.parse(read('package.json'));

test('özel bildirim reddi server presence zincirine anında taşınıyor',()=>{
  assert.match(app,/notificationPromptChoice:String\(prompt\.choice\|\|''\)/);
  assert.match(app,/notificationUserPreference:String\(prompt\.userPreference\|\|'unknown'\)/);
  assert.match(app,/async function dismissPushPrompt\(\).*userPreference='off'.*await syncShazPresence\(true\)/s);
  assert.match(server,/notificationPromptChoice/);
  assert.match(server,/notificationUserPreference/);
  assert.match(server,/permission==='default'&&\(preference==='off'\|\|choice==='declined'\)/);
});

test('foreground gerçek browser permission ve subscription durumunu cache üstünden zorla doğruluyor',()=>{
  assert.match(app,/navigator\.permissions\.query\(\{name:'notifications'\}\)/);
  assert.match(app,/verifyShazForegroundState/);
  assert.match(app,/reconcileShazPush\(reg,true\)/);
  assert.match(app,/await syncShazPresence\(true,true,standalone,true/);
  for(const token of ["foreground('focus')","pageshow","foreground('visibility')","foreground('resume')"]) assert.match(app,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('notification state önceliği denied, granted+subscription, granted-missing, default-declined şeklinde ayrılıyor',()=>{
  assert.match(server,/if\(permission==='denied'\)return \{summary:'Kapalı'/);
  assert.match(server,/permission==='granted'&&pushState==='active'&&hasPush/);
  assert.match(server,/summary:'Abonelik eksik'/);
  assert.match(server,/SHAZ bildirim isteği kullanıcı tarafından reddedildi/);
  assert.match(server,/summary:'Doğrulanamadı'.*Tarayıcı bildirim izni henüz verilmedi/s);
});

test('push ACK SSE ile anında admin popupına taşınır ve revision eski polling cevabını engeller',()=>{
  assert.match(server,/type:'push-delivery-update'/);
  assert.match(server,/publishAdminPushDeliveryUpdate\(rows\[i\]\)/);
  assert.match(server,/revision=Number\(rows\[i\]\.revision\|\|0\)\+1/);
  assert.match(admin,/payload\.type==='push-delivery-update'/);
  assert.match(admin,/incomingRevision<currentRevision/);
  assert.match(admin,/manualPushDeliveryState=\{\.\.\.incoming,\.\.\.current,ok:true\}/);
  assert.match(admin,/setTimeout\(r,400\)/);
});

test('tek üye scope başka userId taşıyan customerId çakışmasını hedeflemez',()=>{
  assert.match(server,/targetUserIds\.has\(String\(x\.userId\|\|''\)\)\|\|targetCustomerIds\.has/);
  assert.match(server,/&&\(!x\.userId\|\|targetUserIds\.has\(String\(x\.userId\|\|''\)\)\)/);
});

test('SMS/e-posta tikleri network bitene kadar disabled yapılmadan optimistic ve kuyruklu çalışır',()=>{
  assert.match(app,/marketingConsentQueued=new Map\(\)/);
  assert.match(app,/marketingConsentQueued\.set\(channel,\{input,granted:next\}\)/);
  assert.doesNotMatch(app,/input\.disabled=true/);
  assert.match(app,/queueMicrotask\(\(\)=>persistMarketingConsent/);
});

test('dependency listesi ve package lock politikası değişmedi',()=>{
  assert.deepEqual(pkg.dependencies,{express:'^4.21.2',multer:'^2.0.2',xlsx:'^0.18.5',sharp:'^0.34.4','web-push':'^3.6.7'});
  assert.equal(fs.existsSync(path.join(root,'package-lock.json')),false);
});

test('notification state fonksiyonu gerçek senaryolarda beklenen sonucu üretir',()=>{
  const match=server.match(/function deviceNotificationState\(a=\{\},hasPush=false\)\{.*?\}(?=\nfunction aggregateNotificationStatus)/s);
  assert.ok(match,'deviceNotificationState bulunamadı');
  const fn=Function(`${match[0]}; return deviceNotificationState;`)();
  assert.equal(fn({notificationPermission:'denied',lastNotificationVerifiedAt:'2026-10-02T10:00:00.000Z',pushSubscriptionState:'active'},true).summary,'Kapalı');
  assert.equal(fn({notificationPermission:'granted',lastNotificationVerifiedAt:'2026-10-02T10:00:00.000Z',pushSubscriptionState:'active'},true).summary,'Açık');
  assert.equal(fn({notificationPermission:'granted',lastNotificationVerifiedAt:'2026-10-02T10:00:00.000Z',pushSubscriptionState:'missing'},false).summary,'Abonelik eksik');
  assert.equal(fn({notificationPermission:'default',notificationUserPreference:'off',notificationPromptChoice:'declined',notificationPromptChoiceAt:'2026-10-02T10:00:00.000Z'},false).summary,'Kapalı');
  assert.equal(fn({notificationPermission:'default',notificationUserPreference:'unknown',lastNotificationVerifiedAt:'2026-10-02T10:00:00.000Z'},false).summary,'Doğrulanamadı');
});

test('ACK revision geldikten sonra daha eski polling cevabı cihaz alındı bilgisini geri saramaz',()=>{
  const match=admin.match(/function applyManualPushDeliveryUpdate\(incoming,base=\{\}\)\{.*?\}(?=\nasync function refreshManualPushDelivery)/s);
  assert.ok(match,'applyManualPushDeliveryUpdate bulunamadı');
  const run=Function(`let manualPushDeliveryState={deliveryId:'DEL-test',revision:3,deliveryRevision:3,deviceAckCount:1,pendingAck:0,providerAccepted:1,ok:true};const document={querySelector:()=>null};function renderManualPushResult(){};${match[0]};const result=applyManualPushDeliveryUpdate({deliveryId:'DEL-test',revision:2,deviceAckCount:0,pendingAck:1,providerAccepted:1,ok:true});return {result,state:manualPushDeliveryState};`);
  const out=run();
  assert.equal(out.state.revision,3);
  assert.equal(out.state.deviceAckCount,1);
  assert.equal(out.state.pendingAck,0);
});
