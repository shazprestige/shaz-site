const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const admin=read('public/admin.js'),app=read('public/app.js'),server=read('server.js'),sw=read('public/service-worker.js');

function functionBlock(src,start,end){const a=src.indexOf(start),b=src.indexOf(end,a);assert.ok(a>=0&&b>a,`block not found: ${start}`);return src.slice(a,b)}

test('admin 10 saniye sonunda kendi ackWindowExpired sonucunu üretmez',()=>{
  const block=functionBlock(admin,'async function refreshManualPushDelivery','function closeMemberPushModal');
  assert.match(block,/Date\.now\(\)-started<10000/);
  assert.doesNotMatch(block,/ackWindowExpired\s*:\s*true/);
  assert.match(block,/renderManualPushResult\(latest\);return latest/);
});

test('ACK final kararı server public delivery stateinden gelmeye devam eder',()=>{
  assert.match(server,/function pushDeliveryPublicState/);
  assert.match(server,/ackWindowExpired=targetStates\.some\(x=>x\.ackWindowExpired===true\)/);
  assert.match(admin,/if\(pending>0&&!expired\)return 'Teslim teyidi bekleniyor\.\.\.'/);
  assert.match(admin,/if\(pending>0&&expired\)return '✕ Bildirim cihaza teslim edilmedi\.'/);
});

test('gecikmiş gerçek ACK SSE ile admin sonucunu güncelleyebilir',()=>{
  assert.match(admin,/payload\.type==='push-delivery-update'\)applyManualPushDeliveryUpdate\(payload\.delivery\)/);
  assert.match(server,/publishAdminPushDeliveryUpdate\(rows\[i\]\)/);
  assert.match(server,/function applyPushDeliveryAck/);
});

test('Android Service Worker ACK zinciri değiştirilmeden deliveryId ve subscriptionId gönderir',()=>{
  assert.match(sw,/self\.addEventListener\('push'/);
  assert.match(sw,/await self\.registration\.showNotification\(title,options\)/);
  assert.match(sw,/await acknowledgePush\(data\)/);
  assert.match(sw,/body:JSON\.stringify\(\{deliveryId,subscriptionId:String\(data\?\.subscriptionId\|\|''\),deviceId/);
  assert.match(server,/if\(!\/\^DEL-.*!subscriptionId\)return res\.status\(400\)/s);
  assert.match(server,/applyPushDeliveryAck\(rows\[i\],subscriptionId,at\)/);
});

test('ACK eşleşmesi deviceId boş olsa da delivery target subscriptionId üzerinden yapılır',()=>{
  const block=functionBlock(server,"app.post('/api/push/ack'","app.get('/api/admin/push/deliveries/:id'");
  assert.match(block,/subscriptionId=String\(req\.body\?\.subscriptionId/);
  assert.doesNotMatch(block,/!deviceId\)return res\.status\(400\)/);
  assert.match(block,/applyPushDeliveryAck\(rows\[i\],subscriptionId,at\)/);
});

test('Push Aktif authority ve manuel push hedefi aynı current eligible kayıt mantığını korur',()=>{
  assert.match(server,/const pushAuthorityRow=latestPushAuthorityRecord\(userPush\)/);
  assert.match(server,/function latestPushAuthorityRecord\(rows=\[\]\).*pushRecordTargetEligible\(x\)&&pushRecordCurrentRelevant\(x\)/s);
  assert.match(server,/rows=keepLatestAuthoritativePushTargets\(normalized\.rows,activityRows\(\)\)/);
});

test('mobil/PWA blur explicit background latch kullanır',()=>{
  assert.match(app,/shazPresenceBackgroundForced=false/);
  assert.match(app,/function shazForceBackgroundPresence\(reason='background'\)\{shazPresenceBackgroundForced=true/);
  assert.match(app,/addEventListener\('blur',\(\)=>\{if\(isStandalonePwa\(\)\|\|shazPresenceIsMobile\(\)\)shazForceBackgroundPresence\('blur'\)/);
});

test('blur sonrası visibility kısa süre visible kalsa bile self-heal ACTIVE yapamaz',()=>{
  const src=app.match(/function shazLocalPresenceState\(\)\{.*?\}/s)?.[0];assert.ok(src);
  const stateFn=Function('navigator','document','shazPresenceIsMobile','getForced',`let shazPresenceBackgroundForced=false;${src};return {fn:shazLocalPresenceState,set:v=>shazPresenceBackgroundForced=v};`)({onLine:true},{visibilityState:'visible',hasFocus:()=>false},()=>true);
  stateFn.set(false);assert.equal(stateFn.fn(),'ACTIVE');
  stateFn.set(true);assert.equal(stateFn.fn(),'BACKGROUND');
});

test('background payload servera visible=false focused=false gider',()=>{
  assert.match(app,/effectiveVisible=shazPresenceBackgroundForced\?false:!!visible/);
  assert.match(app,/effectiveFocused=shazPresenceBackgroundForced\?false:!!focused/);
  assert.match(app,/sendShazPresenceLifecycle\(false,false\)/);
});

test('focus pageshow visible resume foreground latchini temizleyip anında online akışını korur',()=>{
  assert.match(app,/if\(reason!=='online'\)shazPresenceBackgroundForced=false/);
  assert.match(app,/addEventListener\('focus',\(\)=>foreground\('focus'\)/);
  assert.match(app,/addEventListener\('pageshow',e=>foreground/);
  assert.match(app,/visibilityState==='visible'\)foreground\('visibility'\)/);
  assert.match(app,/addEventListener\('resume',\(\)=>foreground\('resume'\)/);
});

test('server 45 saniyeyi geçen live tabı offline yapıp admin SSE update yayınlar',()=>{
  assert.match(server,/const PRESENCE_ONLINE_MS=45000/);
  const block=functionBlock(server,'function expireStalePresenceTabs','function devicePresenceSnapshot');
  assert.match(block,/now-Number\(v\.receivedAtMs\|\|0\)<=PRESENCE_ONLINE_MS/);
  assert.match(block,/v\.sessionActive=false;v\.visible=false;v\.focused=false;v\.presenceState='offline'/);
  assert.match(block,/publishAdminMemberUpdate\(uid,'presence-expired'\)/);
  assert.match(server,/setInterval\(\(\)=>\{try\{expireStalePresenceTabs\(\)\}/);
});

test('presence expiry multi-tab aggregatei bozmaz; yalnız stale tab pasiflenir',()=>{
  const block=functionBlock(server,'function expireStalePresenceTabs','function devicePresenceSnapshot');
  const snapshot=server.match(/function devicePresenceSnapshot\(deviceId,a=\{\},now=Date\.now\(\)\)\{.*?\}(?=\nfunction deviceNotificationState)/s)?.[0];assert.ok(snapshot);
  const factory=Function(`${block};${snapshot};return {expireStalePresenceTabs,devicePresenceSnapshot};`);
  const now=100000;
  const tabs=new Map([
    ['old',{deviceId:'D1',userId:'U1',sessionActive:true,visible:false,focused:false,mobile:true,presenceState:'background',receivedAtMs:now-46000}],
    ['live',{deviceId:'D2',userId:'U1',sessionActive:true,visible:true,focused:true,mobile:false,presenceState:'active',receivedAtMs:now-1000}],
  ]);
  const published=[];
  const env=Function('presenceTabs','PRESENCE_ONLINE_MS','PRESENCE_TAB_RETENTION_MS','publishAdminMemberUpdate',`function prunePresenceTabs(now=Date.now()){for(const [k,v] of presenceTabs)if(now-Number(v.receivedAtMs||0)>PRESENCE_TAB_RETENTION_MS)presenceTabs.delete(k)};${block};${snapshot};return {expireStalePresenceTabs,devicePresenceSnapshot};`)(tabs,45000,600000,(uid,reason)=>published.push([uid,reason]));
  assert.equal(env.expireStalePresenceTabs(now),1);
  assert.equal(tabs.get('old').presenceState,'offline');
  assert.equal(env.devicePresenceSnapshot('D2',{userId:'U1'},now).status,'active');
  assert.deepEqual(published,[['U1','presence-expired']]);
});

test('package dependency ve service worker dosyası bu düzeltmede değiştirilmemiş kalır',()=>{
  const pkg=JSON.parse(read('package.json'));
  assert.deepEqual(pkg.dependencies,{express:'^4.21.2',multer:'^2.0.2',xlsx:'^0.18.5',sharp:'^0.34.4','web-push':'^3.6.7'});
  assert.equal(fs.existsSync(path.join(root,'package-lock.json')),false);
  assert.equal(crypto.createHash('sha256').update(sw).digest('hex'),'2f24ecba4e6a0c093e60c56db8c6210822a2c01372588ab66cc0cdfac63c7f49');
});
