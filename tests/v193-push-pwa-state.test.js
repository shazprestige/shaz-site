const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js');
const app=read('public/app.js');
const admin=read('public/admin.js');
const sw=read('public/service-worker.js');
const css=read('public/styles.css');
const index=read('public/index.html');
const adminHtml=read('admin.html');

function between(src,start,end){const i=src.indexOf(start);assert.ok(i>=0,`${start} bulunamadı`);const j=src.indexOf(end,i);assert.ok(j>i,`${end} bulunamadı`);return src.slice(i,j)}
function serverNotificationFn(){
  const ev=server.match(/function evidenceTime\(v\)\{.*?\}/s);assert.ok(ev);
  const fn=server.match(/function deviceNotificationState\(a=\{\},hasPush=false\)\{.*?\}(?=\nfunction aggregateNotificationStatus)/s);assert.ok(fn);
  return Function(`${ev[0]};${fn[0]};return deviceNotificationState;`)();
}
function aggregateFn(){const m=server.match(/function aggregateNotificationStatus\(devices=\[\]\)\{.*?\}(?=\nfunction evidenceTime)/s);assert.ok(m);return Function(`${m[0]};return aggregateNotificationStatus;`)()}
function pwaFn(){
  const active=server.match(/function pushRecordActive\(p=\{\}\)\{.*?\}/s),eligible=server.match(/function pushRecordTargetEligible\(p=\{\}\)\{.*?\}/s),owner=server.match(/function pushOwnerKey\(p=\{\}\)\{.*?(?=\nfunction latestIso)/s),normalize=server.match(/function normalizeDeviceId\(value\)\{.*?\}(?=\nconst root)/s),platform=server.match(/function devicePlatformFromUa\(ua=''\)\{.*?\}/s),ev=server.match(/function evidenceTime\(v\)\{.*?\}/s),fn=server.match(/function devicePwaState\(a=\{\},pushRows=\[\]\)\{.*?\}(?=\nfunction normalizeVisitSessionId)/s);assert.ok(active&&eligible&&owner&&normalize&&platform&&ev&&fn);return Function(`${normalize[0]};${active[0]};${eligible[0]};${owner[0]};${platform[0]};${ev[0]};${fn[0]};return devicePwaState;`)();
}
function ackFn(){const m=server.match(/function applyPushDeliveryAck\(row=\{\},subscriptionId='',at=new Date\(\)\.toISOString\(\)\)\{.*?\}(?=\napp\.post\('\/api\/push\/ack')/s);assert.ok(m);return Function(`${m[0]};return applyPushDeliveryAck;`)()}
function outcomeFn(){const m=admin.match(/function manualPushOutcomeText\(r=\{\}\)\{.*?\}(?=\nfunction renderManualPushResult)/s);assert.ok(m);return Function(`${m[0]};return manualPushOutcomeText;`)()}

const now=()=>new Date().toISOString();
const ago=days=>new Date(Date.now()-days*86400000).toISOString();

test('provider accepted gerçek denied durumunu Açık yapamaz',()=>{
  const fn=serverNotificationFn();
  const x=fn({notificationPermission:'denied',lastNotificationVerifiedAt:ago(1),pushSubscriptionState:'active',lastPushDeviceAckAt:now()},true);
  assert.equal(x.summary,'Kapalı');assert.equal(x.evidence,'foreground_permission');
});

test('SHAZ Hayır tercihini yalnız daha yeni gerçek granted+active doğrulaması geçersiz kılar',()=>{
  const fn=serverNotificationFn(),choice=ago(2),verified=ago(1);
  assert.equal(fn({notificationPermission:'default',notificationUserPreference:'off',notificationPromptChoice:'declined',notificationPromptChoiceAt:choice,lastPushDeviceAckAt:now(),pushSubscriptionState:'active'},true).summary,'Kapalı');
  assert.equal(fn({notificationPermission:'granted',notificationUserPreference:'off',notificationPromptChoice:'declined',notificationPromptChoiceAt:choice,lastNotificationVerifiedAt:verified,pushSubscriptionState:'active'},true).summary,'Açık');
});

test('ACK bilinmeyen/stale durumda kanalı doğrular ama permission uydurmaz',()=>{
  const fn=serverNotificationFn();const x=fn({notificationPermission:'default',pushSubscriptionState:'active',lastPushDeviceAckAt:now()},true);
  assert.equal(x.summary,'Açık');assert.equal(x.evidence,'device_ack');assert.equal(x.permission,'default');
});

test('granted fakat local subscription yoksa operasyonel olarak Kapalı',()=>{const fn=serverNotificationFn();assert.equal(fn({notificationPermission:'granted',lastNotificationVerifiedAt:now(),pushSubscriptionState:'missing'},false).summary,'Kapalı')});

test('çok eski granted+active doğrulaması kesin Açık sayılmaz',()=>{const fn=serverNotificationFn();assert.equal(fn({notificationPermission:'granted',lastNotificationVerifiedAt:ago(60),pushSubscriptionState:'active'},true).summary,'Doğrulanamadı')});

test('multi-device Açık + Kapalı => Karışık',()=>{const fn=aggregateFn();assert.equal(fn([{notificationStatus:'Açık'},{notificationStatus:'Kapalı'}]),'Karışık')});
test('multi-device tüm Açık => Açık, tüm Kapalı => Kapalı',()=>{const fn=aggregateFn();assert.equal(fn([{notificationStatus:'Açık'},{notificationStatus:'Açık'}]),'Açık');assert.equal(fn([{notificationStatus:'Kapalı'},{notificationStatus:'Kapalı'}]),'Kapalı')});
test('invalid/superseded aggregate dışı cihaz ana statei bozmaz',()=>{const fn=aggregateFn();assert.equal(fn([{notificationStatus:'Kapalı'},{notificationStatus:'Açık',aggregateEligible:false}]),'Kapalı')});
test('yeterli kanıt olmayan multi-device durumda Doğrulanamadı korunur',()=>{const fn=aggregateFn();assert.equal(fn([{notificationStatus:'Açık'},{notificationStatus:'Doğrulanamadı'}]),'Doğrulanamadı')});

test('PWA güçlü standalone sinyali Yüklü üretir',()=>{const fn=pwaFn();assert.equal(fn({deviceId:'DEVICE-PWA-001',deviceStateGeneration:196,lastPwaStandaloneLaunchAt:now()},[]).summary,'Yüklü')});
test('eski PWA güçlü sinyali sonsuza kadar Yüklü sayılmaz',()=>{const fn=pwaFn();assert.equal(fn({deviceId:'DEVICE-PWA-001',deviceStateGeneration:196,lastPwaStandaloneLaunchAt:ago(120)},[]).summary,'Muhtemelen')});
test('kalıcı invalid PWA push operasyonel olarak PWA Yüklü Değil üretir',()=>{const fn=pwaFn(),at=now();const x=fn({deviceId:'DEVICE-PWA-001',deviceStateGeneration:196},[{deviceId:'DEVICE-PWA-001',deviceStateGeneration:196,clientContext:'pwa',pwa:true,pushSubscriptionStatus:'INVALID',lastPushPermanentInvalidAt:at,endpoint:'https://push.example/pwa'}]);assert.equal(x.summary,'Yüklü Değil');assert.match(x.detail,/operasyonel kural/) });
test('legacy/unbound deviceIdsiz pwa=true veya iOS ACK tek başına PWA Yüklü üretemez',()=>{const fn=pwaFn(),t=now();const x=fn({platform:'iPhone / iOS'},[{deviceId:null,lifecycle:'legacy-unbound',pwa:true,pwaObservedAt:t,lastPushDeviceAckAt:t,pushSubscriptionStatus:'ACTIVE'}]);assert.equal(x.summary,'Tespit Edilemedi')});
test('?source=pwa tek başına PWA güçlü kanıtı değildir',()=>{const f=between(app,'function hasPwaLaunchSignal()','function isStandalonePwa()');assert.doesNotMatch(f,/source=pwa|searchParams|location\.search/) });

test('yanlış subscription ACK delivery sayacını artıramaz',()=>{const fn=ackFn(),row={targetSubscriptionIds:['P1'],targetCount:1,providerAccepted:1,ackedSubscriptionIds:[],deviceAckCount:0,revision:2,targetStates:[{subscriptionId:'P1',status:'TESLİM TEYİDİ BEKLENİYOR'}]};const r=fn(row,'P999',now());assert.equal(r.ok,false);assert.equal(row.deviceAckCount,0)});
test('aynı ACK iki kere gelirse yalnız bir kez sayılır',()=>{const fn=ackFn(),row={targetSubscriptionIds:['P1'],targetCount:1,providerAccepted:1,ackedSubscriptionIds:[],deviceAckCount:0,revision:2,targetStates:[{subscriptionId:'P1',status:'TESLİM TEYİDİ BEKLENİYOR'}]};const a=fn(row,'P1',now());const b=fn(a.row,'P1',now());assert.equal(a.row.deviceAckCount,1);assert.equal(b.row.deviceAckCount,1);assert.equal(b.duplicate,true);assert.equal(b.row.revision,a.row.revision);assert.equal(a.row.targetStates[0].status,'TESLİM EDİLDİ')});
test('ACK sayısı providerAccepted ve targetCount üstüne çıkmaz',()=>{const fn=ackFn(),row={targetSubscriptionIds:['P1','P2'],targetCount:2,providerAccepted:1,ackedSubscriptionIds:[],deviceAckCount:0,revision:1,targetStates:[{subscriptionId:'P1'},{subscriptionId:'P2'}]};const a=fn(row,'P1',now());const b=fn(a.row,'P2',now());assert.equal(b.row.deviceAckCount,1)});

test('provider accepted akışında activity permission/active state zorla açılmıyor',()=>{const block=between(server,'async function sendPushRows','async function sendOrderStatusPush');assert.doesNotMatch(block,/setActivityPushState\([^\n]*accepted/);assert.match(block,/lastPushResult='accepted'/)});
test('404/410 kalıcı invalid, 429/5xx geçici hata ayrımı kaynakta korunuyor',()=>{const block=between(server,'async function sendPushRows','async function sendOrderStatusPush');assert.match(block,/status===404\|\|status===410/);assert.match(block,/lastPushResult='permanent_invalid'/);assert.match(block,/lastPushResult='temporary_failure'/);assert.match(server,/function pushIsTransient\(status\)\{return status===429\|\|status>=500\|\|status===0\}/)});

test('admin net sonuç: ACK geldiyse teslim edildi',()=>{const fn=outcomeFn();assert.match(fn({targetCount:1,providerAccepted:1,deviceAckCount:1,failed:0}),/teslim edildi/i)});
test('admin net sonuç: accepted ama ACK yoksa önce bekler sonra teslim edilmedi der',()=>{const fn=outcomeFn();assert.match(fn({targetCount:1,providerAccepted:1,deviceAckCount:0,failed:0}),/bekleniyor/i);assert.match(fn({targetCount:1,providerAccepted:1,deviceAckCount:0,failed:0,ackWindowExpired:true}),/cihaza teslim edilmedi/i)});
test('admin net sonuç: 410 geçersiz, 503 geçici servis hatası',()=>{const fn=outcomeFn();assert.match(fn({targetCount:1,providerAccepted:0,deviceAckCount:0,failed:1,cleaned:1,failureStatuses:{410:1}}),/geçersiz/i);assert.match(fn({targetCount:1,providerAccepted:0,deviceAckCount:0,failed:1,cleaned:0,failureStatuses:{503:1}}),/Geçici gönderim hatası/i)});

test('delivery sonucu her hedef cihazın ayrı durumunu admin ekranına taşır',()=>{assert.match(server,/targetStates=list\.map/);assert.match(server,/status:'TESLİM EDİLDİ'/);assert.match(admin,/Cihaz \$\{i\+1\}:/);assert.match(admin,/BİLDİRİM CİHAZA TESLİM EDİLMEDİ/)});
test('SSE açıkken polling yapılmaz, koparsa hızlı fallback polling var',()=>{const f=between(admin,'async function refreshManualPushDelivery','function closeMemberPushModal');assert.match(f,/Date\.now\(\)-started<10000/);assert.match(f,/if\(!sseOpen\)/);assert.match(f,/setTimeout\(r,150\)/)});
test('eski delivery revision yeni ACK stateini geri saramaz',()=>{const f=between(admin,'function applyManualPushDeliveryUpdate','async function refreshManualPushDelivery');assert.match(f,/incomingRevision<currentRevision/);assert.match(f,/incomingAt<currentAt/)});

test('foreground verify çakışan eventleri pending olarak tekrar doğrular',()=>{const f=between(app,'async function verifyShazForegroundState','function bindShazNotificationPermissionWatcher');assert.match(f,/shazForegroundVerifyPending=true/);assert.match(f,/queueMicrotask\(\(\)=>verifyShazForegroundState/)});
test('focus pageshow visibility resume online foreground doğrulamasına bağlı',()=>{const f=between(app,'function startShazPresenceHeartbeat','async function fetchShazPushConfig');for(const token of ["addEventListener('focus'","addEventListener('online'","addEventListener('pageshow'","addEventListener('visibilitychange'","addEventListener('resume'"])assert.match(f,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')))});
test('presence gözlemi durable timestamp/version taşıyor ve server eski gözlemi ezmiyor',()=>{assert.match(app,/notificationObservedAt:String\(notificationSnapshot\.notificationObservedAt/);assert.match(app,/notificationStateVersion:Number\(notificationSnapshot\.notificationStateVersion/);assert.match(server,/incomingObservedMs>currentObservedMs/);assert.match(server,/incomingStateVersion>=currentStateVersion/)});

test('service worker ACK ve pushsubscriptionchange deviceId taşır, refresh sırasında körlemesine pwa=true yazmaz',()=>{assert.match(sw,/SHAZ_SET_DEVICE_ID/);assert.match(sw,/acknowledgePush[\s\S]*?deviceId=await readDeviceId\(\)/);assert.match(sw,/oldEndpoint/);assert.match(sw,/body\.deviceId=await readDeviceId\(\)/);const change=between(sw,"self.addEventListener('pushsubscriptionchange'","self.addEventListener('notificationclick'");assert.doesNotMatch(change,/body\.pwa=true/)});
test('service worker güncellemesi mevcut subscriptionı activation sırasında bozmaz',()=>{const activate=between(sw,"self.addEventListener('activate'", 'function safeNotificationTarget');assert.doesNotMatch(activate,/unsubscribe\(|pushManager\.subscribe/)});

test('Üyeler araması inputu yeniden render etmeyip yalnız satırları günceller',()=>{const f=between(admin,'let memberSearchDebounce','function renderLegalDocuments');assert.match(f,/updateMemberRows\(\)/);assert.doesNotMatch(f,/renderMembers\(/)});
test('SMS/e-posta açma tıkı anında checked olur ve return ile native click geri alınmaz',()=>{assert.match(app,/onclick="handleMarketingConsentClick\(event,this,'email'\)"/);assert.match(app,/onclick="handleMarketingConsentClick\(event,this,'sms'\)"/);const f=between(app,'function handleMarketingConsentClick','function accountOrderStatusInfo');assert.match(f,/if\(target\).*input\.checked=true/s);assert.doesNotMatch(f,/if\(target\)\{event\.preventDefault/)});

test('eski Tüm Müşteriler görünümü yeni Sipariş / Kargo ekranında kullanılmaz',()=>{const f=between(admin,'const cargoFilterState','async function renderNotificationSettings');assert.doesNotMatch(f,/\/api\/admin\/customers-all/);assert.match(f,/\/api\/admin\/cargo\/orders/);assert.match(f,/Sipariş \/ Kargo Yönetimi/)});
test('iOS/Android history restore zıplama düzeltmesi account popstate/gesture sabitlemesine bağlı',()=>{assert.match(app,/function stabilizeAccountHistoryRestore\(duration=520\)/);assert.match(app,/function bindAccountHistoryGestureStability\(\)/);assert.match(css,/html\.shazAccountHistoryRestore \.drawer\.drawerAccountMode/);assert.match(css,/transition:none!important/);assert.match(css,/position:fixed!important/);assert.match(css,/transform:none!important/)});

test('V217 asset cache sürümleri tutarlı ve dependency/lock kuralı korunuyor',()=>{assert.match(index,/app\.js\?v=217/);assert.match(index,/styles\.css\?v=217/);assert.match(adminHtml,/styles\.css\?v=217/);assert.match(adminHtml,/admin\.js\?v=217/);assert.match(app,/service-worker\.js\?v=200/);const pkg=JSON.parse(read('package.json'));assert.deepEqual(pkg.dependencies,{express:'^4.21.2',multer:'^2.0.2',xlsx:'^0.18.5',sharp:'^0.34.4','web-push':'^3.6.7'});assert.equal(fs.existsSync(path.join(root,'package-lock.json')),false)});

test('ACK provider final update öncesi gelse bile hedef durumu TESLİM EDİLDİ olarak geri sarılmaz',()=>{
  const m=server.match(/function updatePushDeliveryLog\(deliveryId,patch\)\{.*?\}(?=\nfunction pushDeliveryPublicState)/s);assert.ok(m);
  const ackAt=now();
  const run=Function(`let store=[{deliveryId:'D1',revision:2,targetCount:1,providerAccepted:0,ackedSubscriptionIds:['P1'],deviceAckCount:0,targetStates:[{subscriptionId:'P1',status:'TESLİM EDİLDİ',deviceAckAt:'${ackAt}'}]}];function pushDeliveryLogs(){return store}function writePushDeliveryLogs(v){store=v}${m[0]};const out=updatePushDeliveryLog('D1',{providerAccepted:1,targetStates:[{subscriptionId:'P1',status:'TESLİM TEYİDİ BEKLENİYOR',deviceAckAt:null}]});return out;`);
  const out=run();assert.equal(out.deviceAckCount,1);assert.equal(out.targetStates[0].status,'TESLİM EDİLDİ');assert.equal(out.targetStates[0].deviceAckAt,ackAt);
});

test('ACK timeout sonrası cihaz satırı bekleniyor yerine BİLDİRİM CİHAZA TESLİM EDİLMEDİ gösterir',()=>{assert.match(admin,/ackWindowExpired===true&&raw==='TESLİM TEYİDİ BEKLENİYOR'\?'BİLDİRİM CİHAZA TESLİM EDİLMEDİ'/)});

test('logout aynı cihazın eski kullanıcı ownershipini bırakır, browser permissionı sökmez',()=>{assert.match(server,/api\/auth\/logout[\s\S]*?unbindDeviceAccountOwnership\(deviceId,u\?\.id\|\|''\)/);const f=between(server,'function unbindDeviceAccountOwnership','function notificationDebug');assert.match(f,/row\.userId=null/);assert.match(f,/row\.customerId=null/);assert.doesNotMatch(f,/pushSubscriptionStatus='INVALID'|unsubscribe/)});

test('aynı cihaz yeni hesaba subscribe olduğunda eski user fallbacki kullanılmaz',()=>{const f=between(server,"app.post('/api/push/subscribe'","app.delete('/api/push/unsubscribe'");assert.match(f,/userId:deviceId\?\(user\?\.id\|\|null\)/);assert.match(f,/customerId:deviceId\?\(user\?\.customerId\|\|null\)/);assert.match(f,/id:previous\?\.id\|\|'PUSH-'/)});

test('1 gerçek authoritative cihaz + 9 legacy unbound kayıt yalnız 1 aktif hedef üretir',async()=>{
  const active=server.match(/function pushRecordActive\(p=\{\}\)\{.*?\}/s),eligible=server.match(/function pushRecordTargetEligible\(p=\{\}\)\{.*?\}/s),owner=server.match(/function pushOwnerKey\(p=\{\}\)\{.*?(?=\nfunction latestIso)/s),mark=server.match(/function markPushSuperseded\(row,at,reason='superseded_endpoint'\)\{.*?\}/s),safe=server.match(/function safePushRecordId\(row\)\{.*?\}/s),ev=server.match(/function evidenceTime\(v\)\{.*?\}/s),fn=server.match(/async function normalizeActivePushTargets\(rows=\[\]\)\{.*?\n\}/s);assert.ok(active&&eligible&&owner&&mark&&safe&&ev&&fn);
  const current={id:'CURRENT',userId:'U1',deviceId:'DEVICE-123',deviceStateGeneration:196,endpoint:'https://push/current',pushSubscriptionStatus:'ACTIVE',updatedAt:now()};const legacy=Array.from({length:9},(_,i)=>({id:'OLD'+i,userId:'U1',deviceId:null,endpoint:'https://push/old'+i,pushSubscriptionStatus:'ACTIVE',updatedAt:ago(10+i)}));const initial=[current,...legacy];
  const factory=Function('initial','crypto',`let store=initial;function readJson(){return store}function writeJson(name,v){store=v}function activityRows(){return []}function publishAdminMemberUpdate(){}async function persistAccountStateToGithub(){return {ok:true}}function normalizeDeviceId(value){return String(value||'')} ${active[0]};${eligible[0]};${ev[0]};${owner[0]};${mark[0]};${safe[0]};${fn[0]};return normalizeActivePushTargets;`);
  const out=await factory(initial,require('crypto'))(initial);assert.equal(out.rows.length,1);assert.equal(out.rows[0].id,'CURRENT');assert.equal(out.legacyExcluded,9);
});

test('gerçek 3 farklı deviceId varsa normalize sistemi üçünü de korur',async()=>{
  const active=server.match(/function pushRecordActive\(p=\{\}\)\{.*?\}/s),eligible=server.match(/function pushRecordTargetEligible\(p=\{\}\)\{.*?\}/s),owner=server.match(/function pushOwnerKey\(p=\{\}\)\{.*?(?=\nfunction latestIso)/s),mark=server.match(/function markPushSuperseded\(row,at,reason='superseded_endpoint'\)\{.*?\}/s),safe=server.match(/function safePushRecordId\(row\)\{.*?\}/s),ev=server.match(/function evidenceTime\(v\)\{.*?\}/s),fn=server.match(/async function normalizeActivePushTargets\(rows=\[\]\)\{.*?\n\}/s);assert.ok(active&&eligible&&owner&&mark&&safe&&ev&&fn);
  const initial=['PHONE-001','TABLET-01','DESKTOP-1'].map((deviceId,i)=>({id:'P'+i,userId:'U1',deviceId,deviceStateGeneration:196,endpoint:'https://push/'+i,pushSubscriptionStatus:'ACTIVE',updatedAt:now()}));
  const factory=Function('initial','crypto',`let store=initial;function readJson(){return store}function writeJson(name,v){store=v}function activityRows(){return []}function publishAdminMemberUpdate(){}async function persistAccountStateToGithub(){return {ok:true}}function normalizeDeviceId(value){return String(value||'')} ${active[0]};${eligible[0]};${ev[0]};${owner[0]};${mark[0]};${safe[0]};${fn[0]};return normalizeActivePushTargets;`);
  const out=await factory(initial,require('crypto'))(initial);assert.equal(out.rows.length,3);assert.equal(out.legacyExcluded,0);assert.equal(out.staleInvalidated,0);
});
