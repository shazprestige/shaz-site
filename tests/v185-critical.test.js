const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js');
const app=read('public/app.js');
const admin=read('public/admin.js');
const index=read('public/index.html');

test('login kaydı yalnız gerçek auth akışlarında çağrılıyor',()=>{
  const calls=[...server.matchAll(/recordAccountLogin\(/g)].length;
  assert.equal(calls,3,'1 fonksiyon tanımı + 2 gerçek auth çağrısı beklenir');
  assert.match(server,/serverTimestamp:at/);
  assert.match(server,/sessionId:String\(sessionId/);
  assert.match(server,/loginEventId:eventId/);
});

test('presence 5 sn heartbeat, 15 sn TTL ve tek authoritative implementation kullanıyor',()=>{
  assert.match(server,/PRESENCE_HEARTBEAT_MS=5000/);
  assert.match(server,/PRESENCE_ONLINE_MS=15000/);
  assert.equal([...server.matchAll(/function recordCustomerPresence\(/g)].length,1);
  assert.match(app,/SHAZ_PRESENCE_HEARTBEAT_MS=5000/);
  assert.match(app,/document\.visibilityState==='visible'&&document\.hasFocus\?\.\(\)===true/);
  assert.match(app,/tabId:shazTabId/);
});

test('bildirim durumu izin + subscription + doğrulama zamanıyla ayrılıyor',()=>{
  assert.match(server,/lastNotificationVerifiedAt/);
  assert.match(server,/pushSubscriptionState/);
  assert.match(server,/Doğrulanamadı/);
  assert.match(app,/pushManager\.getSubscription\(\)/);
  assert.match(app,/pushManager\.permissionState/);
});

test('kampanya izinleri ayrı authoritative endpoint ve realtime admin update kullanıyor',()=>{
  assert.match(server,/app\.patch\('\/api\/account\/marketing-consent'/);
  assert.match(server,/source:'account-settings'/);
  assert.match(server,/publishAdminMemberUpdate\(u\.id,'consent'\)/);
  assert.match(app,/persistMarketingConsent/);
  assert.match(admin,/SMS \/ Mail/);
  assert.match(admin,/Kampanya izinleri/);
});

test('admin realtime eski event/response ile yeni statei ezmiyor',()=>{
  assert.match(admin,/if\(version&&version<current\)return/);
  assert.match(admin,/if\(current>incoming&&existing\.has\(id\)\)return existing\.get\(id\)/);
  assert.match(admin,/EventSource\('\/api\/admin\/activity-stream'\)/);
});

test('ilk ekran parçalı gösterilmiyor',()=>{
  assert.match(index,/html\.siteBooting body\{[^}]*visibility:hidden!important;opacity:0!important/);
  assert.match(app,/waitForInitialVisualAssets/);
});
