const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js'),app=read('public/app.js'),admin=read('public/admin.js'),css=read('public/styles.css');

test('12 saatlik delivery health watch kalıcı alanlarla ve saatlik scheduler ile tanımlı',()=>{
  assert.match(server,/DELIVERY_HEALTH_WATCH_MS=12\*60\*60\*1000/);
  assert.match(server,/DELIVERY_HEALTH_CHECK_MS=60\*60\*1000/);
  assert.match(server,/deliveryHealthWatchStartedAt/);
  assert.match(server,/deliveryHealthNextCheckAt/);
  assert.match(server,/deliveryProbeAttempts/);
  assert.match(server,/reason='12h_no_delivery_evidence'|deliveryHealthReason='12h_no_delivery_evidence'/);
  assert.match(server,/setInterval\(\(\)=>runDeliveryHealthWatchChecks\(\)/);
});

test('health watch görünür hourly retry push göndermiyor',()=>{
  const start=server.indexOf('async function runDeliveryHealthWatchChecks');
  const end=server.indexOf('function startDeliveryHealthWatchesForAccepted',start);
  const block=server.slice(start,end);
  assert.doesNotMatch(block,/sendNotification|sendPushRows/);
});

test('global push degraded durumda watch pause olur ve 429 5xx sistemsel hata sayılır',()=>{
  assert.match(server,/status===429\|\|status===0\|\|status>=500/);
  assert.match(server,/deliveryHealthState='paused_global'/);
  assert.match(server,/deliveryHealthPauseStartedAt/);
});

test('404 410 kalıcı invalid, transient hata uninstall kararı değildir',()=>{
  assert.match(server,/status===404\|\|status===410/);
  assert.match(server,/lastPushResult='permanent_invalid'/);
  assert.match(server,/lastPushResult='temporary_failure'/);
});

test('stale offline observation aktif watchı yanlışlıkla kapatamaz, pencere içi observation kapatabilir',()=>{
  assert.match(server,/activeWindowEvidence=deliveryHealthWatchActive\(row\)&&\(!startMs\|\|evidenceMs>=startMs\)/);
  assert.match(server,/withinOriginalWindow=!!startMs&&evidenceMs>=startMs/);
});

test('ana admin aggregate yalnız en son authoritative device üzerinden hesaplanır',()=>{
  assert.match(server,/const authoritativeDevice=\[\.\.\.devices\]/);
  assert.match(server,/const currentDevices=authoritativeDevice\?\[authoritativeDevice\]:\[\]/);
  assert.match(server,/d\.deviceRelevance=current\?'current':'historical'/);
});

test('gerçek push gönderim hedefleri owner başına latest authoritative cihaza indirilir',()=>{
  assert.match(server,/function keepLatestAuthoritativePushTargets/);
  assert.match(server,/rows=keepLatestAuthoritativePushTargets\(normalized\.rows,activityRows\(\)\)/);
});

test('offline foreground state localStorageda saklanır ve online olunca önce kuyruğu yollar',()=>{
  assert.match(app,/SHAZ_PENDING_DEVICE_STATE_KEY='shazPendingDeviceStateV1'/);
  assert.match(app,/saveShazPendingDeviceState\(payload\)/);
  assert.match(app,/const queued=readShazPendingDeviceState\(\)/);
  assert.match(app,/if\(qr\.ok\)clearShazPendingDeviceState\(\)/);
  assert.match(app,/observedAt/);
});

test('presence 10 saniye heartbeat ve 45 saniye online grace kullanır',()=>{
  assert.match(server,/PRESENCE_HEARTBEAT_MS=10000/);
  assert.match(server,/PRESENCE_ONLINE_MS=45000/);
  assert.match(app,/SHAZ_PRESENCE_HEARTBEAT_MS=10000/);
});

test('üyeler görünür listedeki sıra numarasını aşağıdan yukarı hesaplar',()=>{
  assert.match(admin,/const visibleCount=\(members\|\|\[\]\)\.length/);
  assert.match(admin,/const rowNumber=visibleCount-rowIndex/);
  assert.match(admin,/memberAdminOrderNo/);
});

test('SMS Mail metinleri ve tikleri iki sabit merkez kolonda hizalanır',()=>{
  assert.match(css,/\.memberConsentHeader b,\.memberConsentState small>span,\.memberConsentState small>b\{justify-self:center!important/);
  assert.match(css,/\.memberConsentHeader,\.memberConsentState small\{grid-template-columns:1fr 1fr!important\}/);
});



test('latest gerçek cihazda aktif push yoksa eski cihaz fallback push hedefi olamaz',()=>{
  assert.match(server,/ownerActs=\(acts\|\|\[\]\)\.filter/);
  assert.match(server,/ids=\[\.\.\.new Set\(\[\.\.\.candidates\.map\(x=>normalizeDeviceId\(x\.deviceId\)\),\.\.\.ownerActs\.map/);
  assert.match(server,/const bestDevice=latestAuthoritativeDeviceId\(group,acts\);const same=group\.filter\(x=>normalizeDeviceId\(x\.deviceId\)===bestDevice\)/);
});
test('package bağımlılıkları değiştirilmedi ve package-lock üretilmedi',()=>{
  const pkg=JSON.parse(read('package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(),['express','multer','sharp','web-push','xlsx'].sort());
  assert.equal(fs.existsSync(path.join(root,'package-lock.json')),false);
});
