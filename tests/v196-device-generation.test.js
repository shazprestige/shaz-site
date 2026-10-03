const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
function slice(start,end,label){const i=server.indexOf(start);assert.ok(i>=0,label+' start');const j=server.indexOf(end,i);assert.ok(j>i,label+' end');return server.slice(i,j)}
const normalizeSrc=slice('function normalizeDeviceId(value)','\nconst root =','normalizeDeviceId');
const activeSrc=slice('function pushRecordActive(p={})','\nfunction pushRecordTargetEligible','active');
const generationSrc=slice('function pushRecordTargetEligible(p={})','\nfunction latestIso','generation helpers');
const evidenceSrc=slice('function evidenceTime(v)','\nfunction devicePwaState','evidence');
const notificationSrc=slice('function deviceNotificationState(a={},hasPush=false)','\nfunction aggregateNotificationStatus','notification state');
const aggregateSrc=slice('function aggregateNotificationStatus(devices=[])','\nfunction evidenceTime','aggregate');
const markSrc=slice('function markPushSuperseded','\nfunction classifyOwnerLegacyUnbound','mark superseded');
const classifySrc=slice('function classifyOwnerLegacyUnbound','\nfunction reconcileForegroundPushEndpoint','classify');
const reconcileSrc=slice('function reconcileForegroundPushEndpoint','\nfunction applyPushAckDeviceBinding','reconcile');
const ackSrc=slice('function applyPushAckDeviceBinding','\n\nfunction recordCustomerPresence','ack bind');
const safeSrc=slice('function safePushRecordId(row)','\nfunction createPushDeliveryLog','safe id');
const normalizeTargetsSrc=slice('async function normalizeActivePushTargets','\nasync function sendPushRows','normalize targets');
const resolveScopeSrc=slice('function resolveManualPushScope(body={},users=[],pushRows=[])',"\napp.post('/api/admin/push/send'",'scope');
function harness(initialPush=[],initialActivity=[]){
  return Function('initialPush','initialActivity','crypto',`
    let pushStore=structuredClone(initialPush),activityStore=structuredClone(initialActivity);
    function readJson(name){if(name==='push_subscriptions.json')return pushStore;if(name==='customer_activity.json')return activityStore;return []}
    function writeJson(name,value){if(name==='push_subscriptions.json')pushStore=value;if(name==='customer_activity.json')activityStore=value}
    function activityRows(){return activityStore}
    function publishAdminMemberUpdate(){}
    async function persistAccountStateToGithub(){return {ok:true}}
    function devicePlatformFromUa(ua=''){return /iPhone/i.test(String(ua))?'iPhone / iOS':'Android'}
    ${normalizeSrc};${activeSrc};${generationSrc};${evidenceSrc};${markSrc};${classifySrc};${safeSrc};${reconcileSrc};${ackSrc};${normalizeTargetsSrc};${resolveScopeSrc};
    ${notificationSrc};${aggregateSrc};
    return {normalizeActivePushTargets,reconcileForegroundPushEndpoint,applyPushAckDeviceBinding,resolveManualPushScope,isCurrentRelevantDevice,pushRecordCurrentRelevant,deviceNotificationState,aggregateNotificationStatus,getPush:()=>pushStore,getActivity:()=>activityStore};
  `)(initialPush,initialActivity,crypto);
}
const now=()=>new Date().toISOString();
function row(id,deviceId,generation,userId='U1'){return {id,userId,customerId:'C1',deviceId,deviceStateGeneration:generation,endpoint:'https://push.example/'+id,pushSubscriptionStatus:'ACTIVE',lifecycle:'current',createdAt:now(),updatedAt:now(),authoritativeAt:now()}}

test('A: 11 device bugün, 10 eski generation + 1 generation 196 => aktif hedef 1',async()=>{
  const rows=[row('CURRENT','DEVICE-CURRENT-196',196),...Array.from({length:10},(_,i)=>row('OLD-'+i,'DEVICE-OLD-'+String(i).padStart(2,'0'),195))];
  const h=harness(rows,[]),out=await h.normalizeActivePushTargets(rows);assert.equal(out.rows.length,1);assert.equal(out.rows[0].id,'CURRENT');assert.equal(out.historicalExcluded,10);
});

test('45 günlük current sınıflandırması kaldırıldı: eski tarihli gen196 current, bugün gen195 historical',()=>{
  const h=harness([],[]),oldDate=new Date(Date.now()-400*86400000).toISOString();
  assert.equal(h.isCurrentRelevantDevice({deviceId:'DEVICE-CURRENT-196',deviceStateGeneration:196,currentVerifiedAt:oldDate},[]),true);
  assert.equal(h.isCurrentRelevantDevice({deviceId:'DEVICE-OLD-195',deviceStateGeneration:195,currentVerifiedAt:now()},[]),false);
  assert.doesNotMatch(generationSrc,/45\*24\*60\*60\*1000/);
});

test('B: current generation Açık + 10 historical unknown => Bildirim Açık',()=>{
  const h=harness([],[]),currentActivity={deviceId:'DEVICE-OPEN-196',deviceStateGeneration:196,notificationPermission:'granted',pushSubscriptionState:'active',lastNotificationVerifiedAt:now()},currentPush=row('OPEN','DEVICE-OPEN-196',196),currentState=h.deviceNotificationState(currentActivity,true),devices=[{notificationStatus:currentState.summary,aggregateEligible:h.isCurrentRelevantDevice(currentActivity,[currentPush])},...Array.from({length:10},(_,i)=>({notificationStatus:'Doğrulanamadı',aggregateEligible:h.isCurrentRelevantDevice({deviceId:'DEVICE-HISTORY-'+i,deviceStateGeneration:195},[])}))];
  assert.equal(currentState.summary,'Açık');assert.equal(h.aggregateNotificationStatus(devices),'Açık');
});

test('C: current generation denied + 10 historical granted/unknown => Bildirim Kapalı',()=>{
  const h=harness([],[]),currentActivity={deviceId:'DEVICE-DENIED-196',deviceStateGeneration:196,notificationPermission:'denied',pushSubscriptionState:'active',lastNotificationVerifiedAt:now()},currentPush=row('DENIED','DEVICE-DENIED-196',196),currentState=h.deviceNotificationState(currentActivity,true),devices=[{notificationStatus:currentState.summary,aggregateEligible:h.isCurrentRelevantDevice(currentActivity,[currentPush])},...Array.from({length:10},(_,i)=>({notificationStatus:i%2?'Açık':'Doğrulanamadı',aggregateEligible:h.isCurrentRelevantDevice({deviceId:'DEVICE-HISTORY-'+i,deviceStateGeneration:195},[])}))];
  assert.equal(currentState.summary,'Kapalı');assert.equal(h.aggregateNotificationStatus(devices),'Kapalı');assert.match(server,/const pushAuthorityRow=latestPushAuthorityRecord\(userPush\)/);assert.match(server,/notificationStatus=pushState\.summary/);
});

test('D: iki gerçek cihaz generation 196 doğrulanırsa iki hedef korunur',async()=>{
  const rows=[row('PHONE','DEVICE-PHONE-196',196),row('PC','DEVICE-PC-196000',196)];const out=await harness(rows,[]).normalizeActivePushTargets(rows);assert.equal(out.rows.length,2);
});

test('E: provider accepted eski generation cihazı current yapmaz',()=>{
  const h=harness([],[]),old=row('OLD','DEVICE-OLD-195',195);old.lastPushAcceptedAt=now();old.lastPushSuccessAt=now();assert.equal(h.pushRecordCurrentRelevant(old),false);
  const send=slice('async function sendPushRows','\nasync function sendOrderStatusPush','send push');assert.doesNotMatch(send,/deviceStateGeneration\s*=\s*CURRENT_DEVICE_STATE_GENERATION/);
});

test('F: historical subscription gerçek deviceId ile ACK verirse generation 196 olur',()=>{
  const old=row('ACKOLD',null,195);old.lifecycle='legacy-unbound';old.deviceRelevance='historical';const h=harness([old],[]),p=h.getPush()[0],at=now();const out=h.applyPushAckDeviceBinding(h.getPush(),p,'DEVICE-ACK-196',null,at);assert.equal(out.bound,true);assert.equal(p.deviceStateGeneration,196);assert.equal(p.deviceRelevance,'current');const a=h.getActivity()[0];assert.equal(a.deviceStateGeneration,196);assert.equal(a.currentVerifiedAt,at);
});

test('foreground endpoint gerçek client sinyaliyle subscription generation 196 olur',()=>{
  const old=row('FG','DEVICE-OLD-195',195);const h=harness([old],[]),at=now();const out=h.reconcileForegroundPushEndpoint({deviceId:'DEVICE-NEW-196',user:{id:'U1',customerId:'C1'},endpoint:old.endpoint,observedAt:at});assert.equal(out.changed,true);const p=h.getPush()[0];assert.equal(p.deviceStateGeneration,196);assert.equal(p.deviceId,'DEVICE-NEW-196');assert.equal(p.currentEndpoint,old.endpoint);assert.equal(p.currentVerifiedAt,at);
});

test('G: seçilen Eren dışında kullanıcı karışmaz ve yalnız Eren current generation hedefi kalır',async()=>{
  const rows=[row('EREN-CUR','EREN-DEVICE-196',196,'EREN'),row('EREN-OLD','EREN-DEVICE-195',195,'EREN'),row('OTHER','OTHER-DEVICE-196',196,'OTHER')];rows[0].customerId='CE';rows[1].customerId='CE';rows[2].customerId='CO';const h=harness(rows,[]),scope=h.resolveManualPushScope({scope:'selected',userIds:['EREN']},[{id:'EREN',customerId:'CE'},{id:'OTHER',customerId:'CO'}],rows);assert.equal(scope.ok,true);assert.deepEqual(new Set(scope.manualTargets.map(x=>x.userId)),new Set(['EREN']));const out=await h.normalizeActivePushTargets(scope.manualTargets);assert.equal(out.rows.length,1);assert.equal(out.rows[0].id,'EREN-CUR');
});

test('subscribe, foreground ve ACK current generation üretir; provider sonucu üretmez',()=>{
  assert.match(server,/deviceStateGeneration:deviceId\?CURRENT_DEVICE_STATE_GENERATION/);assert.match(server,/if\(body\.foregroundOpen===true\)\{r\.deviceStateGeneration=CURRENT_DEVICE_STATE_GENERATION/);assert.match(server,/pushRow\.deviceStateGeneration=CURRENT_DEVICE_STATE_GENERATION/);assert.match(server,/a\.deviceStateGeneration=CURRENT_DEVICE_STATE_GENERATION/);
});

test('PWA authority push ve presence authorityden ayrı hesaplanıyor',()=>{
  assert.match(server,/const pwaAuthorityDevice=\[\.\.\.devices\]\.filter\(x=>evidenceTime\(x\.pwaAuthorityAt\)>0\)/);
  assert.match(server,/pwaAuthorityDeviceId:pwaAuthorityDevice\?\.deviceId\|\|''/);
  assert.match(server,/presenceAuthorityDeviceId:presenceAuthorityDevice\?\.deviceId\|\|''/);
});
