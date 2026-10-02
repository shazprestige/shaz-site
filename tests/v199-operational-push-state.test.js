const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js'),app=read('public/app.js'),admin=read('public/admin.js'),sw=read('public/service-worker.js');

function notificationFn(){
  const ev=server.match(/function evidenceTime\(v\)\{.*?\}/s);const fn=server.match(/function deviceNotificationState\(a=\{\},hasPush=false\)\{.*?\}(?=\nfunction aggregateNotificationStatus)/s);assert.ok(ev&&fn);return Function(`${ev[0]};${fn[0]};return deviceNotificationState;`)();
}
function pwaFn(){
  const normalize=server.match(/function normalizeDeviceId\(value\)\{.*?\}(?=\nconst root)/s),active=server.match(/function pushRecordActive\(p=\{\}\)\{.*?\}/s),ownerBlock=server.match(/function pushRecordTargetEligible\(p=\{\}\)\{.*?(?=\nfunction latestIso)/s),platform=server.match(/function devicePlatformFromUa\(ua=''\)\{.*?\}/s),ev=server.match(/function evidenceTime\(v\)\{.*?\}/s),fn=server.match(/function devicePwaState\(a=\{\},pushRows=\[\]\)\{.*?\}(?=\nfunction normalizeVisitSessionId)/s);assert.ok(normalize&&active&&ownerBlock&&platform&&ev&&fn);return Function(`${normalize[0]};${active[0]};${ownerBlock[0]};${platform[0]};${ev[0]};${fn[0]};return devicePwaState;`)();
}
function healthFn(logs){
  const ev=server.match(/function evidenceTime\(v\)\{.*?\}/s),fn=server.match(/function pushSystemHealthSnapshot\(now=Date\.now\(\)\)\{.*?\}(?=\nfunction applyDeliveryHealthEstimate)/s);assert.ok(ev&&fn);return Function('logs',`const DELIVERY_HEALTH_GLOBAL_WINDOW_MS=60*60*1000;function pushDeliveryLogs(){return logs}${ev[0]};${fn[0]};return pushSystemHealthSnapshot;`)(logs);
}
function strongEvidenceFn(acts){
  const ev=server.match(/function evidenceTime\(v\)\{.*?\}/s),fn=server.match(/function deliveryHealthStrongEvidenceAfter\(row,acts,startMs\)\{.*?\}(?=\nasync function runDeliveryHealthWatchChecks)/s);assert.ok(ev&&fn);return Function('acts',`function normalizeDeviceId(v){return String(v||'')}${ev[0]};${fn[0]};return row=>deliveryHealthStrongEvidenceAfter(row,acts,Date.parse('2026-10-03T00:00:00.000Z'));`)(acts);
}
const iso=(ms=0)=>new Date(Date.now()+ms).toISOString();

// 1-4: Kullanıcının dört kesin kabul kombinasyonu.
test('PWA foreground granted + active subscription => Uygulama Yüklü ve Bildirim Açık',()=>{
  const at=iso(),n=notificationFn()({notificationPermission:'granted',pushSubscriptionState:'active',lastNotificationVerifiedAt:at},true),p=pwaFn()({deviceId:'DEVICE-V199-A',deviceStateGeneration:196,lastPwaStandaloneLaunchAt:at},[]);assert.equal(n.summary,'Açık');assert.equal(p.summary,'Yüklü');
});
test('PWA foreground denied => Uygulama Yüklü ve Bildirim Kapalı',()=>{
  const at=iso(),n=notificationFn()({notificationPermission:'denied',pushSubscriptionState:'missing',lastNotificationVerifiedAt:at},false),p=pwaFn()({deviceId:'DEVICE-V199-B',deviceStateGeneration:196,lastPwaStandaloneLaunchAt:at},[]);assert.equal(n.summary,'Kapalı');assert.equal(p.summary,'Yüklü');
});
test('gerçek device ACK => platformdan bağımsız Bildirim Açık ve Uygulama Yüklü',()=>{
  const at=iso(),n=notificationFn()({notificationPermission:'default',pushSubscriptionState:'active',lastPushDeviceAckAt:at},true),p=pwaFn()({deviceId:'DEVICE-V199-C',deviceStateGeneration:196,lastPushDeviceAckAt:at,platform:'Android'},[]);assert.equal(n.summary,'Açık');assert.equal(n.evidence,'device_ack');assert.equal(p.summary,'Yüklü');
});
test('normal accepted push ACK timeout => Bildirim Kapalı ve Uygulama Yüklü Değil',()=>{
  const at=iso(),old=iso(-24*60*60*1000),n=notificationFn()({notificationPermission:'granted',pushSubscriptionState:'active',lastNotificationVerifiedAt:old,estimatedNotificationClosedAt:at},true),p=pwaFn()({deviceId:'DEVICE-V199-D',deviceStateGeneration:196,lastPwaStandaloneLaunchAt:old,estimatedAppRemovedAt:at},[]);assert.equal(n.summary,'Kapalı');assert.equal(n.evidence,'12h_no_delivery_evidence');assert.equal(p.summary,'Yüklü Değil');
});

test('granted fakat subscription yoksa Açık denmez, Kapalı değerlendirilir',()=>{assert.equal(notificationFn()({notificationPermission:'granted',pushSubscriptionState:'missing',lastNotificationVerifiedAt:iso()},false).summary,'Kapalı')});
test('404/410 permanent invalid sonrası operasyonel sonuç Kapalı + Yüklü Değil',()=>{const at=iso(),old=iso(-86400000);assert.equal(notificationFn()({notificationPermission:'granted',pushSubscriptionState:'invalid',lastNotificationVerifiedAt:old,lastPushPermanentInvalidAt:at},false).summary,'Kapalı');assert.equal(pwaFn()({deviceId:'DEVICE-V199-E',deviceStateGeneration:196,lastPwaStandaloneLaunchAt:old,lastPushPermanentInvalidAt:at},[]).summary,'Yüklü Değil')});

test('çok accepted ama ACK yokluğu tek başına global provider arızası sayılmaz',()=>{const t=iso(-1000),logs=Array.from({length:10},(_,i)=>({createdAt:t,targetStates:[{providerStatus:201,deviceAckAt:null,subscriptionId:'P'+i}]}));const h=healthFn(logs)();assert.equal(h.accepted,10);assert.equal(h.acked,0);assert.equal(h.healthy,true);assert.equal(h.degraded,false)});
test('429/5xx/network ve VAPID/auth gibi sistemsel hata global healthi degrade edebilir',()=>{const t=iso(-1000),logs=[{createdAt:t,targetStates:[{providerStatus:503},{providerStatus:503},{providerStatus:503}]}];const h=healthFn(logs)();assert.equal(h.transient,3);assert.equal(h.degraded,true)});

test('sıradan heartbeat/currentVerified ACK watchını tek başına başarıya çeviremez; standalone veya ACK çevirebilir',()=>{const after='2026-10-03T01:00:00.000Z',row={deviceId:'DEVICE-V199-F'};assert.equal(strongEvidenceFn([{deviceId:'DEVICE-V199-F',lastSeenAt:after,currentVerifiedAt:after}])(row),false);assert.equal(strongEvidenceFn([{deviceId:'DEVICE-V199-F',lastPwaStandaloneLaunchAt:after}])(row),true);assert.equal(strongEvidenceFn([{deviceId:'DEVICE-V199-F',lastPushDeviceAckAt:after}])(row),true)});

test('foreground fresh state Notification.permission, getSubscription, permissionState ve Permissions API ile okunuyor',()=>{const block=app.slice(app.indexOf('async function shazNotificationSnapshot'),app.indexOf('function shazPresencePayload'));assert.match(block,/Notification\.permission/);assert.match(block,/pushManager\.getSubscription\(\)/);assert.match(block,/pushManager\.permissionState/);assert.match(block,/navigator\.permissions\.query\(\{name:'notifications'\}\)/)});
test('granted + missing subscription foregroundda yeniden subscribe edilmeye çalışılıyor',()=>{const block=app.slice(app.indexOf('async function verifyShazForegroundState'),app.indexOf('function bindShazNotificationPermissionWatcher'));assert.match(block,/permission==='granted'/);assert.match(block,/if\(!sub\)\{await reconcileShazPush\(reg,true\)/)});
test('offline PWA state pending olarak saklanıp online gelince servera gönderiliyor',()=>{assert.match(app,/saveShazPendingDeviceState\(payload\)/);assert.match(app,/const queued=readShazPendingDeviceState\(\)/);assert.match(app,/window\.addEventListener\('online',\(\)=>foreground\('online'\)/)});
test('standalone açılış app stateini self-heal eder, notification estimate yalnız fresh karar varsa temizlenir',()=>{assert.match(server,/standaloneEvidence=signal==='standalone_launch'\|\|body\.standaloneLaunch===true/);assert.match(server,/resolveDeliveryHealthEvidence\(deviceId,observedAt,'standalone_launch',\{app:true,notification:freshNotificationDecision\}\)/);assert.match(server,/foreground_notification',\{app:false,notification:true\}/)});
test('service worker gerçek push eventinde device ACK gönderiyor',()=>{assert.match(sw,/self\.addEventListener\('push'/);assert.match(sw,/await acknowledgePush\(data\)/);assert.match(sw,/fetch\('\/api\/push\/ack'/)});
test('ACK ve presence state değişimleri admin SSE publish zincirine bağlı',()=>{assert.match(server,/publishAdminMemberUpdate\(uid,'push-ack'\)/);assert.match(server,/publishAdminMemberUpdate\(uid,reason\)/);assert.match(admin,/ADMIN_MEMBER_UPDATE_RECEIVED/)});
test('manuel push timeout sonucu artık doğrulanamadı değil cihaza teslim edilmedi',()=>{assert.match(admin,/✕ Bildirim cihaza teslim edilmedi\./);assert.match(admin,/BİLDİRİM CİHAZA TESLİM EDİLMEDİ/)});
test('yalnız latest authoritative push target korunuyor',()=>{assert.match(server,/rows=keepLatestAuthoritativePushTargets\(normalized\.rows,activityRows\(\)\)/);assert.match(server,/const bestDevice=latestAuthoritativeDeviceId\(group,acts\)/)});
test('package dependencyleri değiştirilmedi ve package-lock üretilmedi',()=>{const pkg=JSON.parse(read('package.json'));assert.deepEqual(pkg.dependencies,{express:'^4.21.2',multer:'^2.0.2',xlsx:'^0.18.5',sharp:'^0.34.4','web-push':'^3.6.7'});assert.equal(fs.existsSync(path.join(root,'package-lock.json')),false)});
