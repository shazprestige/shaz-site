const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js');
const app=read('public/app.js');
const index=read('public/index.html');
const css=read('public/styles.css');
const adminHtml=read('admin.html');
const sw=read('public/service-worker.js');

function between(src,start,end){const i=src.indexOf(start);assert.ok(i>=0,`${start} bulunamadı`);const j=src.indexOf(end,i);assert.ok(j>i,`${end} bulunamadı`);return src.slice(i,j)}
function pushAuthorityFn(){
  const normalize=server.match(/function normalizeDeviceId\(value\)\{.*?\}(?=\nconst root)/s);assert.ok(normalize);
  const ev=server.match(/function evidenceTime\(v\)\{.*?\}/s);assert.ok(ev);
  const block=between(server,'function pushRecordActive(p={})','\nfunction latestIso');
  return Function(`${normalize[0]};${ev[0]};${block};return latestPushAuthorityRecord;`)();
}
function pwaFn(){
  const normalize=server.match(/function normalizeDeviceId\(value\)\{.*?\}(?=\nconst root)/s),active=server.match(/function pushRecordActive\(p=\{\}\)\{.*?\}/s),ownerBlock=server.match(/function pushRecordTargetEligible\(p=\{\}\)\{.*?(?=\nfunction latestIso)/s),platform=server.match(/function devicePlatformFromUa\(ua=''\)\{.*?\}/s),ev=server.match(/function evidenceTime\(v\)\{.*?\}/s),fn=server.match(/function devicePwaState\(a=\{\},pushRows=\[\]\)\{.*?\}(?=\nfunction normalizeVisitSessionId)/s);assert.ok(normalize&&active&&ownerBlock&&platform&&ev&&fn);return Function(`${normalize[0]};${active[0]};${ownerBlock[0]};${platform[0]};${ev[0]};${fn[0]};return devicePwaState;`)();
}
function presenceFn(tabs){
  const fn=server.match(/function devicePresenceSnapshot\(deviceId,a=\{\},now=Date\.now\(\)\)\{.*?\}(?=\nfunction deviceNotificationState)/s);assert.ok(fn);
  return Function('tabs',`const PRESENCE_ONLINE_MS=45000;const presenceTabs=new Map(tabs.map((x,i)=>[String(i),x]));function prunePresenceTabs(){};${fn[0]};return devicePresenceSnapshot;`)(tabs);
}
const at=(delta=0)=>new Date(Date.now()+delta).toISOString();
const pushRow=(id,context='pwa',delta=0)=>({id,userId:'U1',customerId:'C1',deviceId:'DEVICE-'+id,deviceStateGeneration:196,endpoint:'https://push.example/'+id,pushSubscriptionStatus:'ACTIVE',lifecycle:'current',deviceRelevance:'current',clientContext:context,pwa:context==='pwa',subscriptionVerifiedAt:at(delta),updatedAt:at(delta)});

test('presence, push ve PWA authority admin ana satırında ayrı kaynaklardan hesaplanıyor',()=>{
  assert.match(server,/const pushAuthorityRow=latestPushAuthorityRecord\(userPush\)/);
  assert.match(server,/const pwaAuthorityDevice=\[\.\.\.devices\]/);
  assert.match(server,/presenceAuthorityDevice=/);
  assert.match(server,/pushAuthorityDeviceId/);
  assert.match(server,/pwaAuthorityDeviceId/);
  assert.match(server,/presenceAuthorityDeviceId/);
});

test('normal browser aktivitesi push hedef seçiminde generic lastOpenAt olarak kullanılmıyor',()=>{
  const block=between(server,'function keepLatestAuthoritativePushTargets','\nfunction latestIso');
  assert.match(block,/latestPushAuthorityRecord\(group\)/);
  assert.doesNotMatch(block,/latestAuthoritativeDeviceId\(/);
  assert.doesNotMatch(block,/lastOpenAt/);
});

test('latest valid push subscription push authority olur',()=>{
  const fn=pushAuthorityFn(),old=pushRow('PWA','pwa',-60000),newer=pushRow('BROWSER','browser',0);
  assert.equal(fn([old,newer]).id,'BROWSER');
  newer.pushSubscriptionStatus='INVALID';newer.invalidatedAt=at();
  assert.equal(fn([old,newer]).id,'PWA');
});

test('browser foreground aynı PWA endpointini browser contextine düşürmez',()=>{
  const block=between(server,'function reconcileForegroundPushEndpoint','\nfunction applyPushAckDeviceBinding');
  assert.match(block,/resolvedContext=pushClientContext\(row\)==='pwa'&&clientContext==='browser'\?'pwa':clientContext/);
  assert.match(block,/pushClientContext\(x\)===resolvedContext/);
});

test('subscribe ve pushsubscriptionchange mevcut PWA contextini korur',()=>{
  const block=between(server,"app.post('/api/push/subscribe'","\napp.delete('/api/push/unsubscribe'");
  assert.match(block,/requestedClientContext=/);
  assert.match(block,/previousContext=pushClientContext\(previous\|\|\{\}\)/);
  assert.match(block,/previous&&previousContext==='pwa'&&requestedClientContext==='browser'\?'pwa'/);
});

test('PWA ve browser aynı deviceId üzerinde farklı endpoint ise birbirini supersede etmez',()=>{
  const reconcile=between(server,'function reconcileForegroundPushEndpoint','\nfunction applyPushAckDeviceBinding');
  const subscribe=between(server,"app.post('/api/push/subscribe'","\napp.delete('/api/push/unsubscribe'");
  const ack=between(server,'function applyPushAckDeviceBinding','\n\nfunction recordCustomerPresence');
  assert.match(reconcile,/pushClientContext\(x\)===resolvedContext/);
  assert.match(subscribe,/pushClientContext\(x\)===clientContext/);
  assert.match(ack,/pushClientContext\(x\)===pushClientContext\(pushRow\)/);
});

test('normal browser standalone=false daha önceki PWA kurulum kanıtını yok etmez',()=>{
  const fn=pwaFn(),p=pushRow('PWA-KEEP','pwa');p.pwaObservedAt=at();
  const result=fn({deviceId:p.deviceId,deviceStateGeneration:196,lastClientContext:'browser'},[p]);
  assert.equal(result.summary,'Yüklü');
});

test('browser push negatif kanıtı aynı cihazdaki PWA kurulumunu Yüklü Değil yapmaz',()=>{
  const fn=pwaFn(),pwa=pushRow('PWA-SAFE','pwa',-60000),browser=pushRow('BROWSER-BAD','browser',0);
  pwa.pwaObservedAt=at(-60000);
  browser.pushSubscriptionStatus='INVALID';browser.invalidatedAt=at();browser.lastPushPermanentInvalidAt=at();browser.deliveryHealthEstimatedAt=at();
  const result=fn({deviceId:pwa.deviceId,deviceStateGeneration:196,lastPwaStandaloneLaunchAt:at(-60000),estimatedAppRemovedAt:at(),lastPushPermanentInvalidAt:at(),lastClientContext:'browser'},[pwa,browser]);
  assert.equal(result.summary,'Yüklü');
});

test('PWA push kaydının kendi yeni negatif kanıtı PWA durumunu operasyonel olarak Yüklü Değil yapar',()=>{
  const fn=pwaFn(),pwa=pushRow('PWA-OWN-FAIL','pwa',-60000);
  pwa.pwaObservedAt=at(-60000);pwa.deliveryHealthEstimatedAt=at();
  const result=fn({deviceId:pwa.deviceId,deviceStateGeneration:196,lastPwaStandaloneLaunchAt:at(-60000)},[pwa]);
  assert.equal(result.summary,'Yüklü Değil');
});

test('notification authority ACK ve negatif teslimat kanıtını yalnız seçili push kaydından alır',()=>{
  const block=between(server,'function notificationStateForPushAuthority','\nfunction notificationFallbackAuthorityState');
  assert.match(block,/lastAck=pushRow\.lastPushDeviceAckAt/);
  assert.match(block,/lastPermanent=pushRow\.lastPushPermanentInvalidAt\|\|pushRow\.permanentInvalidAt/);
  assert.match(block,/estimatedClosedAt=pushRow\.deliveryHealthEstimatedAt/);
  assert.doesNotMatch(block,/a\.lastPushDeviceAckAt/);
  assert.doesNotMatch(block,/a\.lastPushPermanentInvalidAt/);
});

test('admin Bildirim ve Push durumu push authorityden, presence ayrı aggregate edilir',()=>{
  assert.match(server,/pushState=pushAuthorityRow\?notificationStateForPushAuthority\(pushAuthorityRow,pushAuthorityActivity\):notificationFallbackAuthorityState\(ua\)/);
  assert.match(server,/notificationStatus=pushState\.summary/);
  assert.match(server,/pushActive=!!pushAuthorityRow/);
  assert.match(server,/presenceStatus=devices\.some\(x=>x\.presenceStatus==='active'\)\?'Aktif':devices\.some\(x=>x\.presenceStatus==='background'\)\?'Arka Planda':'Çevrimdışı'/);
});

test('client payload browser ve PWA contextini açıkça gönderiyor',()=>{
  assert.match(app,/clientContext=isStandalonePwa\(\)\?'pwa':'browser'/);
  assert.match(app,/presenceState=!navigator\.onLine\?'offline':effectiveVisible/);
  assert.match(app,/clientContext,presenceState/);
});

test('hidden pagehide freeze anında background lifecycle gönderir',()=>{
  assert.match(app,/pagehide'.*?shazForceBackgroundPresence\('pagehide'\)/s);
  assert.match(app,/visibilitychange'.*?shazForceBackgroundPresence\('visibility'\)/s);
  assert.match(app,/freeze'.*?shazForceBackgroundPresence\('freeze'\)/s);
});

test('pageshow focus visible resume foregrounda gelince heartbeat beklemeden foreground çalışır',()=>{
  assert.match(app,/addEventListener\('focus',\(\)=>foreground\('focus'\)/);
  assert.match(app,/addEventListener\('pageshow',e=>foreground/);
  assert.match(app,/visibilityState==='visible'\)foreground\('visibility'\)/);
  assert.match(app,/addEventListener\('resume',\(\)=>foreground\('resume'\)/);
});

test('presence background hemen, 45 saniye sonra offline olur',()=>{
  const now=Date.now(),fn1=presenceFn([{deviceId:'D1',userId:'U1',sessionActive:true,visible:false,focused:false,mobile:true,presenceState:'background',receivedAtMs:now,serverReceivedAt:at()}]);
  assert.equal(fn1('D1',{userId:'U1'},now).status,'background');
  const fn2=presenceFn([{deviceId:'D1',userId:'U1',sessionActive:true,visible:false,focused:false,mobile:true,presenceState:'background',receivedAtMs:now-46000,serverReceivedAt:at(-46000)}]);
  assert.equal(fn2('D1',{userId:'U1'},now).status,'offline');
});

test('birden fazla contextte herhangi gerçek active tab varsa kullanıcı çevrimiçi kalır',()=>{
  assert.match(server,/presenceStatus=devices\.some\(x=>x\.presenceStatus==='active'\)\?'Aktif'/);
});

test('ilk boot sırasında body boş gizlenmiyor ve statik Yükleniyor loaderı app.js olmadan mevcut',()=>{
  assert.match(index,/id="siteBootLoader"/);
  assert.match(index,/>Yükleniyor<\/span>/);
  assert.match(index,/setInterval\(function\(\).*?450\)/s);
  assert.match(index,/html\.siteBooting body>\*:not\(#siteBootLoader\):not\(#siteBootError\)\{visibility:hidden!important\}/);
  assert.doesNotMatch(index,/html\.siteBooting body\{[^}]*visibility:hidden!important;opacity:0!important/);
});

test('boot ölçümü settings catalog ve critical render zamanlarını ayrı tutuyor',()=>{
  for(const key of ['navigationStart','domContentLoaded','settingsResponse','catalogResponse','criticalUiReady','siteVisible','fullyInteractive'])assert.match(index+app,new RegExp(key));
  assert.match(app,/fetch\('\/api\/settings.*?\.then\(r=>\{window\.__shazBootMetrics\.settingsResponse=performance\.now\(\)/s);
  assert.match(app,/fetch\('\/api\/catalog'\)\.then\(r=>\{window\.__shazBootMetrics\.catalogResponse=performance\.now\(\)/);
  assert.match(app,/window\.__shazStopBootDots\?\.\(\);document\.documentElement\.classList\.remove\('siteBooting','siteBootError'\)/);
});

test('install notice site visual ready olduktan 12 saniye sonra tek merkezi scheduler ile gelir',()=>{
  const block=between(app,'function scheduleShazInstallNotice','\nwindow.addEventListener(\'beforeinstallprompt\'');
  assert.match(block,/afterSiteBoot\(/);
  assert.match(block,/12000/);
  assert.match(app,/beforeinstallprompt'.*?shazDeferredInstallPrompt=e;scheduleShazInstallNotice\(\)/s);
  assert.doesNotMatch(app,/setTimeout\(showShazInstallNotice,1200\)/);
  assert.match(app,/appinstalled'.*?shazAppInstalledThisSession=true.*?cancelShazInstallNoticeSchedule\(\)/s);
  assert.match(block,/shazAppInstalledThisSession/);
});

test('Üyeler sıra numarası biraz büyük ve ilk iki kolon kompakt tutuluyor',()=>{
  assert.match(css,/grid-template-columns:40px 25px minmax\(157px,1\.15fr\)/);
  assert.match(css,/\.memberAdminOrderNo\{[^}]*font-size:12px/);
  assert.match(css,/@media\(max-width:1180px\).*?grid-template-columns:38px 24px/s);
  assert.match(css,/@media\(max-width:900px\).*?grid-template-columns:32px 25px/s);
});

test('V217 asset versionları tutarlı, VAPID ve dependencyler değiştirilmedi',()=>{
  assert.match(index,/styles\.css\?v=217/);assert.match(index,/app\.js\?v=217/);assert.match(adminHtml,/styles\.css\?v=217/);assert.match(app,/service-worker\.js\?v=200/);assert.match(sw,/SHAZ_SW_VERSION='200'/);
  assert.doesNotMatch(index+adminHtml+app,/\?v=194/);
  const pkg=JSON.parse(read('package.json'));assert.deepEqual(pkg.dependencies,{express:'^4.21.2',multer:'^2.0.2',xlsx:'^0.18.5',sharp:'^0.34.4','web-push':'^3.6.7'});assert.equal(fs.existsSync(path.join(root,'package-lock.json')),false);
});
