const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js');
const app=read('public/app.js');
const admin=read('public/admin.js');
function match(src,re,label){const m=src.match(re);assert.ok(m,label+' bulunamadı');return m[0]}

test('notification observation revision eski veya eşit doğrulamayı yeni state üstüne yazdırmaz',()=>{
  const src=match(server,/function shouldApplyNotificationObservation\(verified,incomingObservedMs,currentObservedMs,incomingStateVersion,currentStateVersion\)\{.*?\}/s,'shouldApplyNotificationObservation');
  const fn=Function(`${src};return shouldApplyNotificationObservation;`)();
  assert.equal(fn(true,2000,1000,2,9),true);
  assert.equal(fn(true,1000,2000,99,2),false);
  assert.equal(fn(true,2000,2000,6,5),true);
  assert.equal(fn(true,2000,2000,5,5),false);
  assert.equal(fn(false,3000,2000,9,5),false);
});

test('stale lifecycle snapshot kendini doğrulanmış evidence diye işaretleyemez',()=>{
  const payload=match(app,/function shazPresencePayload\([^\n]+\{.*?\}\n/s,'shazPresencePayload');
  assert.match(payload,/notificationVerified:verified===true/);
  assert.doesNotMatch(payload,/notificationSnapshot\.verified===true/);
});

test('foreground denied/granted önce ham gerçek statei servera yazar sonra subscription mutasyonu yapar ve tekrar doğrular',()=>{
  const start=app.indexOf('async function verifyShazForegroundState');const end=app.indexOf('function bindShazNotificationPermissionWatcher',start);assert.ok(start>=0&&end>start);const block=app.slice(start,end);
  const firstSync=block.indexOf("await syncShazPresence(true,true,standalone,true,standalone?'standalone_launch':'')");
  const permissionRead=block.indexOf("permission=Notification.permission");
  const cleanup=block.indexOf("cleanupRevokedPush(reg)");
  const lastSync=block.lastIndexOf("await syncShazPresence(true,true,standalone,true,standalone?'standalone_launch':'')");
  assert.ok(firstSync>=0&&permissionRead>firstSync&&cleanup>permissionRead&&lastSync>cleanup);
});

test('register akışında denied state unsubscribe beklenmeden önce servera gönderilir',()=>{
  const start=app.indexOf('async function registerShazPwa');assert.ok(start>=0);const block=app.slice(start,start+4000);const denied=block.indexOf("if(Notification.permission==='denied')");assert.ok(denied>=0);const part=block.slice(denied,denied+420);assert.ok(part.indexOf('syncShazPresence(true)')<part.indexOf('cleanupRevokedPush(reg)'));
});

test('deviceRelevance historical olan subscription generation doğru görünse bile push hedefi olamaz',()=>{
  const normalize=match(server,/function normalizeDeviceId\(value\)\{.*?\}(?=\nconst root)/s,'normalizeDeviceId');
  const active=match(server,/function pushRecordActive\(p=\{\}\)\{.*?\}/s,'pushRecordActive');
  const eligible=match(server,/function pushRecordTargetEligible\(p=\{\}\)\{.*?\}/s,'pushRecordTargetEligible');
  const fn=Function(`${normalize};${active};${eligible};return pushRecordTargetEligible;`)();
  assert.equal(fn({deviceId:'DEVICE-12345678',lifecycle:'current',deviceRelevance:'historical',pushSubscriptionStatus:'ACTIVE'}),false);
  assert.equal(fn({deviceId:'DEVICE-12345678',lifecycle:'current',deviceRelevance:'current',pushSubscriptionStatus:'ACTIVE'}),true);
});

test('manual push teknik detay bölümü her renderda kapalı tutulur',()=>{
  const render=match(admin,/function renderManualPushResult\(r\)\{.*?\n\}(?=\nfunction applyManualPushDeliveryUpdate)/s,'renderManualPushResult');
  assert.match(render,/querySelector\?\.\('details'\)\?\.removeAttribute\('open'\)/);
  assert.match(render,/<details><summary>Detayları Göster<\/summary>/);
});
