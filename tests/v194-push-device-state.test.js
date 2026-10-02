const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js');
const app=read('public/app.js');
const admin=read('public/admin.js');
const sw=read('public/service-worker.js');
const css=read('public/styles.css');
function slice(start,end,label){const i=server.indexOf(start);assert.ok(i>=0,label+' start');const j=server.indexOf(end,i);assert.ok(j>i,label+' end');return server.slice(i,j)}
const normalizeSrc=slice('function normalizeDeviceId(value)',"\nconst root =",'normalizeDeviceId');
const activeSrc=slice('function pushRecordActive(p={})','\nfunction pushRecordTargetEligible','pushRecordActive');
const eligibleSrc=slice('function pushRecordTargetEligible(p={})','\nfunction pushOwnerKey','pushRecordTargetEligible');
const ownerSrc=slice('function pushOwnerKey(p={})','\nfunction latestIso','pushOwnerKey');
const evidenceSrc=slice('function evidenceTime(v)','\nfunction devicePwaState','evidenceTime');
const markSrc=slice('function markPushSuperseded','\nfunction classifyOwnerLegacyUnbound','markPushSuperseded');
const classifySrc=slice('function classifyOwnerLegacyUnbound','\nfunction reconcileForegroundPushEndpoint','classifyOwnerLegacyUnbound');
const safeSrc=slice('function safePushRecordId(row)','\nfunction createPushDeliveryLog','safePushRecordId');
const reconcileSrc=slice('function reconcileForegroundPushEndpoint','\nfunction applyPushAckDeviceBinding','reconcileForegroundPushEndpoint');
const ackBindSrc=slice('function applyPushAckDeviceBinding','\n\nfunction recordCustomerPresence','applyPushAckDeviceBinding');
const normalizeTargetsSrc=slice('async function normalizeActivePushTargets','\nasync function sendPushRows','normalizeActivePushTargets');
function makeStateHarness(initialPush=[],initialActivity=[]){
  const factory=Function('initialPush','initialActivity','crypto',`
    let pushStore=structuredClone(initialPush),activityStore=structuredClone(initialActivity);
    function readJson(name){if(name==='push_subscriptions.json')return pushStore;if(name==='customer_activity.json')return activityStore;return []}
    function writeJson(name,value){if(name==='push_subscriptions.json')pushStore=value;if(name==='customer_activity.json')activityStore=value}
    function activityRows(){return activityStore}
    function publishAdminMemberUpdate(){}
    async function persistAccountStateToGithub(){return {ok:true}}
    function devicePlatformFromUa(ua=''){const x=String(ua);if(/iPhone|iPad|iPod/i.test(x)||(/Macintosh/i.test(x)&&/Mobile/i.test(x)))return 'iPhone / iOS';if(/Android/i.test(x))return 'Android';if(/Windows/i.test(x))return 'Windows';if(/Macintosh|Mac OS X/i.test(x))return 'Mac';return 'Diğer'}
    ${normalizeSrc};${activeSrc};${eligibleSrc};${ownerSrc};${evidenceSrc};${markSrc};${classifySrc};${safeSrc};${reconcileSrc};${ackBindSrc};${normalizeTargetsSrc};
    return {reconcileForegroundPushEndpoint,applyPushAckDeviceBinding,normalizeActivePushTargets,getPush:()=>pushStore,getActivity:()=>activityStore};
  `);
  return factory(initialPush,initialActivity,crypto);
}
const iso=(n=0)=>new Date(Date.now()+n).toISOString();

test('production senaryosu: 10 legacy/unbound + gerçek foreground endpoint => yalnız 1 manual target',async()=>{
  const endpoint='https://push.example/current';
  const initial=Array.from({length:10},(_,i)=>({id:'OLD-'+i,userId:'U1',customerId:'C1',deviceId:null,endpoint:i===4?endpoint:`https://push.example/old-${i}`,pushSubscriptionStatus:'ACTIVE',updatedAt:iso(-100000-i)}));
  const h=makeStateHarness(initial,[]),at=iso();
  const r=h.reconcileForegroundPushEndpoint({deviceId:'DEVICE-A1',user:{id:'U1',customerId:'C1'},endpoint,observedAt:at,pwaStandalone:false});
  assert.equal(r.changed,true);
  const rows=h.getPush(),current=rows.find(x=>x.endpoint===endpoint&&x.deviceId==='DEVICE-A1');
  assert.ok(current);assert.equal(current.lifecycle,'current');assert.equal(current.authoritativeAt,at);
  const unbound=rows.filter(x=>x.id!==current.id&&x.deviceId==null&&x.pushSubscriptionStatus==='ACTIVE');
  assert.equal(unbound.length,9);assert.ok(unbound.every(x=>x.lifecycle==='legacy-unbound'));
  assert.ok(unbound.every(x=>!x.deviceId),'belirsiz legacy kayıtlara cihaz kimliği uydurulmadı');
  const out=await h.normalizeActivePushTargets(rows);assert.equal(out.rows.length,1);assert.equal(out.rows[0].deviceId,'DEVICE-A1');assert.equal(out.legacyExcluded,9);
});

test('legacy ACK gerçek deviceId ile subscriptionı ve activity stateini self-heal eder',()=>{
  const at=iso(),legacy={id:'P1',userId:'U1',customerId:'C1',deviceId:null,endpoint:'https://push.example/legacy',pushSubscriptionStatus:'ACTIVE',lifecycle:'legacy-unbound',userAgent:'Mozilla/5.0 (iPhone) Mobile'};
  const h=makeStateHarness([legacy],[]),row=h.getPush()[0];const r=h.applyPushAckDeviceBinding(h.getPush(),row,'DEVICE-A1',null,at);
  assert.equal(r.bound,true);assert.equal(row.deviceId,'DEVICE-A1');assert.equal(row.lifecycle,'current');assert.equal(row.lastPushDeviceAckAt,at);
  const a=h.getActivity().find(x=>x.deviceId==='DEVICE-A1');assert.ok(a);assert.equal(a.lastPushDeviceAckAt,at);assert.equal(a.pushSubscriptionActive,true);assert.equal(a.pushSubscriptionState,'active');assert.equal(a.lastPwaIosPushAckAt,at);
});

test('ACK başka kullanıcıya ait activity/device ownershipini ele geçiremez',()=>{
  const at=iso(),row={id:'P1',userId:'U1',customerId:'C1',deviceId:null,endpoint:'https://push.example/x',pushSubscriptionStatus:'ACTIVE'};
  const h=makeStateHarness([row],[{id:'A1',deviceId:'DEVICE-B2',userId:'U2',customerId:'C2',platform:'Android'}]);const p=h.getPush()[0];
  const r=h.applyPushAckDeviceBinding(h.getPush(),p,'DEVICE-B2',null,at);assert.equal(r.bound,false);assert.equal(r.ownershipConflict,true);assert.equal(p.deviceId,null);
});

test('same device eski endpoint superseded olur, yeni/current endpoint tek hedef kalır',async()=>{
  const now=iso(),old={id:'OLD',userId:'U1',customerId:'C1',deviceId:'DEVICE-A1',endpoint:'https://push.example/old',pushSubscriptionStatus:'ACTIVE',updatedAt:iso(-5000)},cur={id:'CUR',userId:'U1',customerId:'C1',deviceId:'DEVICE-A1',endpoint:'https://push.example/new',pushSubscriptionStatus:'ACTIVE',lifecycle:'current',authoritativeAt:now,updatedAt:now};
  const h=makeStateHarness([old,cur],[]);const out=await h.normalizeActivePushTargets(h.getPush());assert.equal(out.rows.length,1);assert.equal(out.rows[0].id,'CUR');const oldAfter=h.getPush().find(x=>x.id==='OLD');assert.equal(oldAfter.pushSubscriptionStatus,'INVALID');assert.ok(oldAfter.supersededAt);
});

test('duplicate endpointte newer legacy row current device rowunu gölgeleyemez',async()=>{
  const ep='https://push.example/same',current={id:'CUR',userId:'U1',deviceId:'DEVICE-A1',lifecycle:'current',endpoint:ep,pushSubscriptionStatus:'ACTIVE',updatedAt:iso(-5000)},legacy={id:'LEG',userId:'U1',deviceId:null,lifecycle:'legacy-unbound',endpoint:ep,pushSubscriptionStatus:'ACTIVE',updatedAt:iso()};
  const h=makeStateHarness([current,legacy],[]);const out=await h.normalizeActivePushTargets(h.getPush());assert.equal(out.rows.length,1);assert.equal(out.rows[0].id,'CUR');
});

test('gerçek üç farklı current device korunur',async()=>{
  const rows=['PHONE-001','TABLET-01','DESKTOP-1'].map((deviceId,i)=>({id:'P'+i,userId:'U1',deviceId,lifecycle:'current',authoritativeAt:iso(-i),endpoint:'https://push.example/'+i,pushSubscriptionStatus:'ACTIVE'}));
  const h=makeStateHarness(rows,[]);const out=await h.normalizeActivePushTargets(h.getPush());assert.equal(out.rows.length,3);
});

test('aynı endpoint User A -> User B foreground açılışında ownership yeni hesaba rebind olur',()=>{
  const ep='https://push.example/shared',row={id:'P1',userId:'UA',customerId:'CA',deviceId:'DEVICE-01',lifecycle:'current',endpoint:ep,pushSubscriptionStatus:'ACTIVE'};
  const h=makeStateHarness([row],[]);const r=h.reconcileForegroundPushEndpoint({deviceId:'DEVICE-01',user:{id:'UB',customerId:'CB'},endpoint:ep,observedAt:iso()});assert.equal(r.changed,true);const x=h.getPush()[0];assert.equal(x.userId,'UB');assert.equal(x.customerId,'CB');assert.equal(x.previousUserId,'UA');
});

test('SW ACK payload deviceId içerir; yoksa uyduracak fallback yoktur',()=>{assert.match(sw,/JSON\.stringify\(\{deliveryId,subscriptionId:String\(data\?\.subscriptionId\|\|''\),deviceId,receivedAt:/);assert.doesNotMatch(sw,/deviceId\s*:\s*['\"]DEV-|randomUUID\(\).*deviceId/) });

test('pushsubscriptionchange oldEndpoint ve IndexedDB deviceId taşır ama pwa=true zorlamaz',()=>{const i=sw.indexOf("self.addEventListener('pushsubscriptionchange'");const j=sw.indexOf("self.addEventListener('notificationclick'",i);assert.ok(i>=0&&j>i);const block=sw.slice(i,j);assert.match(block,/oldEndpoint/);assert.match(block,/body\.deviceId=await readDeviceId\(\)/);assert.doesNotMatch(block,/body\.pwa=true/) });

test('foreground payload current endpoint + observation revision taşır',()=>{assert.match(app,/currentPushEndpoint:String\(notificationSnapshot\.currentPushEndpoint\|\|''\)/);assert.match(app,/notificationObservedAt:String\(notificationSnapshot\.notificationObservedAt/);assert.match(app,/notificationStateVersion:Number\(notificationSnapshot\.notificationStateVersion/) });
test('foreground granted + mevcut subscription da idempotent subscribe ile servera yeniden doğrulanır',()=>{const i=app.indexOf('async function verifyShazForegroundState');const j=app.indexOf('function bindShazNotificationPermissionWatcher',i);assert.ok(i>=0&&j>i);const block=app.slice(i,j);assert.match(block,/else if\(permission==='granted'\)\{[\s\S]*?else await reconcileShazPush\(reg,true\)/) });

test('Hesap Bilgilerim Kaydet yalnız marketing kuyruğu bitip state doğrulandıktan sonra tüm değişiklikler kaydedildi der',()=>{const i=app.indexOf('async function saveAccountProfile');const j=app.indexOf('function stopEmailChangeVerifyTimer',i);assert.ok(i>=0&&j>i);const block=app.slice(i,j);assert.match(block,/await waitForMarketingConsentSettled\(\)/);assert.match(block,/Kampanya tercihlerinin tamamı kaydedilemedi/);assert.match(block,/Tüm değişiklikler kaydedildi/) });

test('account geri hareketi iOS edge gesture öncesi ve popstate anında uzun sabitleme uygular',()=>{assert.match(app,/function bindAccountHistoryGestureStability\(\)/);assert.match(app,/x<=36\)stabilizeAccountHistoryRestore\(700\)/);assert.match(app,/if\(isAccountPath\(location\.pathname\)\)\{stabilizeAccountHistoryRestore\(\);openAccountRouteIfNeeded\(\);return\}/);assert.match(css,/position:fixed!important/);assert.match(css,/contain:paint!important/);assert.match(css,/transition:none!important/) });

test('admin tarihsel active row sayısı ile gerçek current cihaz sayısını ayrı gösterir',()=>{assert.match(admin,/Aktif kayıt:/);assert.match(admin,/Gerçek current cihaz:/);assert.match(admin,/ps\.currentActiveDevices/) });
