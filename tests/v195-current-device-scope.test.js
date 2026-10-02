const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js');
const admin=read('public/admin.js');

function match(re,label){const m=server.match(re);assert.ok(m,label);return m[0]}
function adminMatch(re,label){const m=admin.match(re);assert.ok(m,label);return m[0]}
const now=()=>new Date().toISOString();
const ago=days=>new Date(Date.now()-days*86400000).toISOString();

const normalizeDeviceSrc=match(/function normalizeDeviceId\(value\)\{.*?\}(?=\nconst root)/s,'normalizeDeviceId');
const evidenceSrc=match(/function evidenceTime\(v\)\{.*?\}/s,'evidenceTime');
const activeSrc=match(/function pushRecordActive\(p=\{\}\)\{.*?\}/s,'pushRecordActive');
const eligibleSrc=match(/function pushRecordTargetEligible\(p=\{\}\)\{.*?\}/s,'pushRecordTargetEligible');
const ownerAndCurrentSrc=match(/function pushOwnerKey\(p=\{\}\)\{.*?(?=\nfunction latestIso)/s,'current device helpers');
const markSupersededSrc=match(/function markPushSuperseded\(row,at,reason='superseded_endpoint'\)\{.*?\}/s,'markPushSuperseded');
const safeSrc=match(/function safePushRecordId\(row\)\{.*?\}/s,'safePushRecordId');
const normalizeTargetsSrc=match(/async function normalizeActivePushTargets\(rows=\[\]\)\{.*?\n\}/s,'normalizeActivePushTargets');

function targetHarness(initialPush=[],initialActivity=[]){
  const factory=Function('initialPush','initialActivity','crypto',`
    let pushStore=structuredClone(initialPush),activityStore=structuredClone(initialActivity);
    function readJson(name){if(name==='push_subscriptions.json')return pushStore;if(name==='customer_activity.json')return activityStore;return []}
    function writeJson(name,value){if(name==='push_subscriptions.json')pushStore=value;if(name==='customer_activity.json')activityStore=value}
    function activityRows(){return activityStore}
    function publishAdminMemberUpdate(){}
    async function persistAccountStateToGithub(){return {ok:true}}
    ${normalizeDeviceSrc};${evidenceSrc};${activeSrc};${eligibleSrc};${ownerAndCurrentSrc};${markSupersededSrc};${safeSrc};${normalizeTargetsSrc};
    return {normalizeActivePushTargets,getPush:()=>pushStore};
  `);
  return factory(initialPush,initialActivity,crypto);
}

function scopeFn(){
  const src=match(/function resolveManualPushScope\(body=\{\},users=\[\],pushRows=\[\]\)\{.*?\n\}/s,'resolveManualPushScope');
  return Function(`${activeSrc};${src};return resolveManualPushScope;`)();
}

function notificationFn(){
  const src=match(/function deviceNotificationState\(a=\{\},hasPush=false\)\{.*?\}(?=\nfunction aggregateNotificationStatus)/s,'deviceNotificationState');
  return Function(`${evidenceSrc};${src};return deviceNotificationState;`)();
}
function aggregateFn(){const src=match(/function aggregateNotificationStatus\(devices=\[\]\)\{.*?\}(?=\nfunction evidenceTime)/s,'aggregateNotificationStatus');return Function(`${src};return aggregateNotificationStatus;`)()}
function pwaFn(){
  const platform=match(/function devicePlatformFromUa\(ua=''\)\{.*?\}/s,'devicePlatformFromUa');
  const src=match(/function devicePwaState\(a=\{\},pushRows=\[\]\)\{.*?\}(?=\nfunction normalizeVisitSessionId)/s,'devicePwaState');
  return Function(`${normalizeDeviceSrc};${activeSrc};${platform};${evidenceSrc};${src};return devicePwaState;`)();
}
function ackFn(){const src=match(/function applyPushDeliveryAck\(row=\{\},subscriptionId='',at=new Date\(\)\.toISOString\(\)\)\{.*?\}(?=\napp\.post\('\/api\/push\/ack')/s,'applyPushDeliveryAck');return Function(`${src};return applyPushDeliveryAck;`)()}
function outcomeFn(){const src=adminMatch(/function manualPushOutcomeText\(r=\{\}\)\{.*?\}(?=\nfunction renderManualPushResult)/s,'manualPushOutcomeText');return Function(`${src};return manualPushOutcomeText;`)()}

// TEST 1
test('selected scope yalnız seçilen gerçek userId kapsamını hedefler',()=>{
  const fn=scopeFn(),users=[{id:'U1',customerId:'C1'},{id:'U2',customerId:'C2'}],push=[
    {id:'P1',userId:'U1',customerId:'C1',pushSubscriptionStatus:'ACTIVE'},
    {id:'P2',userId:'U2',customerId:'C1',pushSubscriptionStatus:'ACTIVE'},
    {id:'P3',userId:'U2',customerId:'C2',pushSubscriptionStatus:'ACTIVE'}
  ];
  const r=fn({scope:'selected',userIds:['U1'],membersOnly:true},users,push);
  assert.equal(r.ok,true);assert.equal(r.scope,'selected');assert.deepEqual(r.selectedUsers.map(x=>x.id),['U1']);assert.deepEqual(r.manualTargets.map(x=>x.id),['P1']);
});

// TEST 2
test('scope selected ama userIds boşsa fail-closed 400 ve gönderim yok',()=>{
  const r=scopeFn()({scope:'selected',userIds:[],membersOnly:true},[{id:'U1',customerId:'C1'}],[{id:'P1',userId:'U1',pushSubscriptionStatus:'ACTIVE'}]);
  assert.equal(r.ok,false);assert.equal(r.status,400);assert.match(r.message,/Seçili kullanıcı bulunamadı/);assert.equal(r.manualTargets,undefined);
  const partial=scopeFn()({scope:'selected',userIds:['U1','MISSING'],membersOnly:true},[{id:'U1',customerId:'C1'}],[{id:'P1',userId:'U1',pushSubscriptionStatus:'ACTIVE'}]);assert.equal(partial.ok,false);assert.equal(partial.status,400);assert.equal(partial.manualTargets,undefined);
  assert.match(server,/scopeResult=resolveManualPushScope[\s\S]*?if\(!scopeResult\.ok\)return res\.status\(scopeResult\.status\|\|400\)/);
});

// TEST 3
test('modal selected user snapshot immutable kalır; kaynak seçim sonradan değişse etkilenmez',()=>{
  const start=admin.indexOf("function createMemberPushScopeSnapshot(mode='all',ids=[])"),end=admin.indexOf('\nlet memberPushScope',start);
  assert.ok(start>=0&&end>start,'createMemberPushScopeSnapshot source missing');
  const src=admin.slice(start,end);
  const fn=Function(`${src};return createMemberPushScopeSnapshot;`)(),ids=['U1'],snap=fn('selected',ids);ids[0]='U2';ids.push('U3');
  assert.deepEqual(snap.userIds,['U1']);assert.equal(snap.mode,'selected');assert.equal(Object.isFrozen(snap),true);assert.equal(Object.isFrozen(snap.userIds),true);
  const realtime=admin.slice(admin.indexOf('function applyRealtimeMemberUpdate'),admin.indexOf('function applyRealtimeMemberSummary'));
  assert.doesNotMatch(realtime,/memberPushScope\s*=/);
  const send=admin.slice(admin.indexOf('async function sendManualPush'),admin.indexOf('function memberStatusLabel'));assert.match(send,/scope:scopeSnapshot\.mode===['"]selected['"]\?['"]selected['"]:/);assert.match(send,/userIds:\[\.\.\.scopeSnapshot\.userIds\]/);
});

// TEST 4
test('1 current cihaz + 9 historical cihaz => aktif push hedefi 1',async()=>{
  const rows=[{id:'CUR',userId:'U1',customerId:'C1',deviceId:'DEVICE-CURRENT-001',endpoint:'https://push/current',lifecycle:'current',authoritativeAt:now(),pushSubscriptionStatus:'ACTIVE'},...Array.from({length:9},(_,i)=>({id:'OLD'+i,userId:'U1',customerId:'C1',deviceId:'DEVICE-OLD-'+i,endpoint:'https://push/old-'+i,lifecycle:'current',authoritativeAt:ago(120+i),createdAt:ago(120+i),pushSubscriptionStatus:'ACTIVE'}))];
  const h=targetHarness(rows,[]),r=await h.normalizeActivePushTargets(h.getPush());
  assert.equal(r.rows.length,1);assert.equal(r.rows[0].id,'CUR');assert.equal(r.historicalExcluded,9);assert.equal(h.getPush().filter(x=>x.deviceRelevance==='historical').length,9);assert.equal(h.getPush().filter(x=>x.deviceRelevance==='historical').every(x=>x.pushSubscriptionStatus==='ACTIVE'),true);
});

// TEST 5
test('3 farklı güncel gerçek cihaz => aktif push hedefi 3',async()=>{
  const rows=['DEVICE-PHONE-001','DEVICE-PC-0001','DEVICE-TABLET-01'].map((d,i)=>({id:'P'+i,userId:'U1',deviceId:d,endpoint:'https://push/'+i,lifecycle:'current',authoritativeAt:now(),pushSubscriptionStatus:'ACTIVE'}));
  const r=await targetHarness(rows,[]).normalizeActivePushTargets(rows);assert.equal(r.rows.length,3);assert.equal(r.historicalExcluded,0);
});

// TEST 6
test('aynı endpoint duplicate kayıtlarda yalnız bir push hedefi kalır',async()=>{
  const ep='https://push/same',rows=[{id:'A',userId:'U1',deviceId:'DEVICE-A-001',endpoint:ep,lifecycle:'current',authoritativeAt:now(),pushSubscriptionStatus:'ACTIVE'},{id:'B',userId:'U1',deviceId:'DEVICE-B-001',endpoint:ep,lifecycle:'current',authoritativeAt:now(),pushSubscriptionStatus:'ACTIVE'}];
  const r=await targetHarness(rows,[]).normalizeActivePushTargets(rows);assert.equal(r.rows.length,1);assert.equal(r.rows[0].endpoint,ep);
});

// TEST 7
test('current foreground granted + active subscription => Bildirim Açık',()=>{
  const r=notificationFn()({notificationPermission:'granted',pushSubscriptionState:'active',lastNotificationVerifiedAt:now()},true);assert.equal(r.summary,'Açık');
});

// TEST 8
test('current foreground denied => Bildirim Kapalı',()=>{
  const r=notificationFn()({notificationPermission:'denied',pushSubscriptionState:'active',lastNotificationVerifiedAt:now(),lastPushDeviceAckAt:now()},true);assert.equal(r.summary,'Kapalı');
});

// TEST 9
test('current Açık + 9 historical unknown => aggregate Açık',()=>{
  const devices=[{notificationStatus:'Açık',aggregateEligible:true},...Array.from({length:9},()=>({notificationStatus:'Doğrulanamadı',aggregateEligible:false}))];assert.equal(aggregateFn()(devices),'Açık');
});

// TEST 10
test('iki current cihazdan biri Açık biri Kapalı => Karışık',()=>{
  assert.equal(aggregateFn()([{notificationStatus:'Açık',aggregateEligible:true},{notificationStatus:'Kapalı',aggregateEligible:true}]),'Karışık');
});

// TEST 11
test('bugün standalone PWA açılışı => Yüklü',()=>{
  assert.equal(pwaFn()({deviceId:'DEVICE-A-001',lastPwaStandaloneLaunchAt:now(),lastSeenAt:now()},[]).summary,'Yüklü');
});

// TEST 12
test('eski standalone kanıtı güncel kesin Yüklü sayılmaz',()=>{
  const result=pwaFn()({deviceId:'DEVICE-A-001',lastPwaStandaloneLaunchAt:ago(30),lastSeenAt:now()},[]);assert.equal(result.summary,'Muhtemelen');assert.notEqual(result.summary,'Yüklü');
});

// TEST 13
test('push ACK hedef subscription için delivery stateini anında teslim edildi yapar',()=>{
  const row={deliveryId:'DEL-123',targetCount:1,providerAccepted:1,targetSubscriptionIds:['P1'],targetStates:[{subscriptionId:'P1',status:'TESLİM TEYİDİ BEKLENİYOR'}],ackedSubscriptionIds:[],deviceAckCount:0,revision:1};
  const r=ackFn()(row,'P1',now());assert.equal(r.ok,true);assert.equal(r.row.deviceAckCount,1);assert.equal(r.row.targetStates[0].status,'TESLİM EDİLDİ');assert.match(server,/publishAdminPushDeliveryUpdate\(rows\[i\]\)/);
});

// TEST 14
test('provider accepted ama ACK timeout => Teslimat doğrulanamadı',()=>{
  assert.equal(outcomeFn()({targetCount:1,providerAccepted:1,deviceAckCount:0,ackWindowExpired:true}),'⚠ Teslimat doğrulanamadı.');
});

function renderHarness(){
  const outcome=adminMatch(/function manualPushOutcomeText\(r=\{\}\)\{.*?\}(?=\nfunction renderManualPushResult)/s,'outcome');
  const render=adminMatch(/function renderManualPushResult\(r\)\{.*?\n\}(?=\nfunction applyManualPushDeliveryUpdate)/s,'render');
  const el={textContent:'',innerHTML:''};
  const fn=Function('el',`function $(q){return el}function esc(v){return String(v??'').replace(/[&<>\"]/g,'')} ${outcome};${render};return renderManualPushResult;`)(el);
  return {el,fn};
}

// TEST 15
test('manual push ana sonuç görünümünde 10 cihazlık teknik liste görünmez',()=>{
  const {el,fn}=renderHarness();fn({ok:true,scope:'selected',selectedMemberCount:1,selectedMemberNames:['Eren çakar'],targetCount:10,providerAccepted:8,providerRejected:2,deviceAckCount:1,ackWindowExpired:true,targetStates:Array.from({length:10},(_,i)=>({subscriptionId:'P'+i,status:i===0?'TESLİM EDİLDİ':'TESLİM TEYİDİ BEKLENİYOR'}))});
  const main=el.innerHTML.split('<details>')[0];assert.match(main,/Eren çakar/);assert.match(main,/Hedef cihaz: <b>10<\/b>/);assert.match(main,/Teslim edildi: <b>1<\/b>/);assert.match(main,/Doğrulanamayan: <b>9<\/b>/);assert.doesNotMatch(main,/Cihaz 1:/);assert.doesNotMatch(main,/Provider|Push servisi kabul etti|Subscription/);
});

// TEST 16
test('Detayları Göster altında teknik provider/ACK/subscription bilgileri bulunur',()=>{
  const {el,fn}=renderHarness();fn({ok:true,targetCount:1,providerAccepted:1,deviceAckCount:0,ackWindowExpired:true,deliveryId:'DEL-X',targetStates:[{subscriptionId:'SUB-X',status:'TESLİM TEYİDİ BEKLENİYOR'}]});
  assert.match(el.innerHTML,/<summary>Detayları Göster<\/summary>/);assert.match(el.innerHTML,/Push servisi kabul etti: 1/);assert.match(el.innerHTML,/Cihaz tarafından alındı: 0/);assert.match(el.innerHTML,/Teslim teyidi bekleniyor: 0/);assert.match(el.innerHTML,/Teslimat doğrulanamadı: 1/);assert.match(el.innerHTML,/Subscription: SUB-X/);assert.match(el.innerHTML,/Delivery id: DEL-X/);
});
