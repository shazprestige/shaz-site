const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const server=read('server.js');
const app=read('public/app.js');
const admin=read('public/admin.js');
const styles=read('public/styles.css');
const index=read('public/index.html');
const adminHtml=read('admin.html');
const pkg=JSON.parse(read('package.json'));

test('login history yalnız gerçek auth/session creation akışında ve server zamanı ile tutuluyor',()=>{
  const calls=[...server.matchAll(/recordAccountLogin\(/g)].length;
  assert.equal(calls,3,'1 fonksiyon tanımı + 2 gerçek auth çağrısı beklenir');
  assert.match(server,/serverTimestamp:at/);
  assert.match(server,/sessionId:String\(sessionId/);
  assert.match(server,/loginEventId:eventId/);
  assert.match(server,/String\(x\.sessionId\|\|''\)===String\(sessionId\)/);
});

test('presence state machine 10 sn heartbeat, 45 sn online grace ve 1 sn self-heal kullanıyor',()=>{
  assert.match(server,/PRESENCE_HEARTBEAT_MS=10000/);
  assert.match(server,/PRESENCE_ONLINE_MS=45000/);
  assert.match(server,/PRESENCE_TAB_RETENTION_MS=10\*60\*1000/);
  assert.match(app,/SHAZ_PRESENCE_HEARTBEAT_MS=10000/);
  assert.match(app,/SHAZ_PRESENCE_LOCAL_CHECK_MS=1000/);
  assert.equal([...server.matchAll(/function recordCustomerPresence\(/g)].length,1);
  assert.match(app,/if\(visible&&\(shazPresenceIsMobile\(\)\|\|focused\)\)return 'ACTIVE'/);
  assert.doesNotMatch(app,/visibilityState==='visible'&&document\.hasFocus\?\.\(\)===true/);
  assert.match(server,/recent=tabs\.filter\(x=>x\.sessionActive===true&&now-Number\(x\.receivedAtMs\|\|0\)<=PRESENCE_ONLINE_MS/);
  assert.match(server,/active=recent\.filter/);
  assert.match(server,/background=recent\.filter/);
});

test('foreground lifecycle ve multi-tab koordinasyonu self-healing çalışacak sinyalleri içeriyor',()=>{
  for(const token of ["addEventListener('focus'","addEventListener('blur'","addEventListener('online'","addEventListener('offline'","addEventListener('pagehide'","addEventListener('pageshow'","addEventListener('visibilitychange'","addEventListener('freeze'","addEventListener('resume'","addEventListener('appinstalled'"]) assert.match(app,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(app,/e\.persisted\?'pageshow-bfcache':'pageshow'/);
  assert.match(app,/new BroadcastChannel\('shaz-presence-v1'\)/);
  assert.match(app,/tabId:shazTabId/);
  assert.match(server,/const tabKey=deviceId\+'\|'\+tabId/);
  assert.match(server,/Number\(oldTab\.clientSequence\|\|0\)>=incomingSeq/);
});

test('PWA installation presence dışı güçlü kanıtlarla hesaplanıyor ve permanent/temporary ayrılıyor',()=>{
  assert.match(server,/VERIFIED_INSTALLED/);
  assert.match(server,/PROBABLY_INSTALLED/);
  assert.match(server,/INVALIDATED/);
  assert.match(server,/UNKNOWN/);
  assert.match(server,/lastPwaInstalledSignalAt/);
  assert.match(server,/lastPwaStandaloneLaunchAt/);
  assert.match(app,/standalone_launch/);
  assert.match(server,/lastPushAcceptedAt/);
  assert.match(server,/lastPushPermanentInvalidAt/);
  assert.match(server,/lastStatus===404\|\|lastStatus===410/);
  assert.match(server,/temporaryFailureCount=Number\(target\.temporaryFailureCount\|\|0\)\+1/);
  assert.doesNotMatch(server,/PWA kapandı.*kaldır/i);
});

test('bildirim doğrulaması permission, permissionState ve subscription sinyallerini ayrı topluyor',()=>{
  assert.match(app,/Notification\.permission/);
  assert.match(app,/pushManager\.getSubscription\(\)/);
  assert.match(app,/pushManager\.permissionState/);
  assert.match(app,/navigator\.permissions\?\.query\?\.\(\{name:'notifications'\}\)/);
  assert.match(server,/lastNotificationVerifiedAt/);
  assert.match(server,/pushPermissionState/);
  assert.match(server,/pushSubscriptionState/);
});

test('KPI ve filtreler server-side authoritative endpointlerden geliyor',()=>{
  assert.match(server,/app\.get\('\/api\/admin\/users\/summary'/);
  assert.match(server,/app\.get\('\/api\/admin\/users\/ids'/);
  assert.match(server,/function filterAdminMembers\(/);
  assert.match(server,/function memberSummary\(/);
  assert.match(server,/Cache-Control','no-store/);
  for(const key of ['totalMembers','pwaInstalledVerified','activeNow','backgroundNow','notificationPermissionGranted','pushActive','smsConsentGranted','emailConsentGranted']) assert.match(server,new RegExp(key));
  assert.match(admin,/memberKpiGrid/);
  assert.match(admin,/Filtre sonucu:/);
  assert.match(admin,/Filtreleri temizle/);
  assert.doesNotMatch(admin,/Diğer filtreler/);
});

test('realtime reconnect, snapshot reconciliation ve version guard içeriyor',()=>{
  assert.match(server,/adminActivityStreams=new Set\(\)/);
  assert.match(server,/serverTimestamp:new Date\(\)\.toISOString\(\)/);
  assert.match(admin,/new EventSource\('\/api\/admin\/activity-stream'\)/);
  assert.match(admin,/Math\.min\(30000,1000\*Math\.pow\(2,memberActivityReconnectAttempt\+\+\)\)/);
  assert.match(admin,/if\(version&&version<current\)return/);
  assert.match(admin,/memberListRequestSeq/);
  assert.match(admin,/cache:'no-store'/);
});

test('header checkbox tüm filtre sonucunu server ids endpointinden seçiyor ve filtre değişince seçim temizleniyor',()=>{
  assert.match(admin,/\/api\/admin\/users\/ids\?/);
  assert.match(admin,/toggleAllFilteredMembers/);
  assert.match(admin,/all\.indeterminate=selectedMemberIds\.size>0&&!all\.checked/);
  assert.match(admin,/selectedMemberIds\.clear\(\)/);
  assert.doesNotMatch(admin,/Filtrelenen tüm üyeleri seç/);
});

test('WhatsApp yalnız doğrulanabilir desktop deep-link davranışını kaydediyor',()=>{
  assert.match(server,/\/api\/admin\/whatsapp\/templates/);
  assert.match(server,/\/api\/admin\/whatsapp\/media/);
  assert.match(server,/\/api\/admin\/whatsapp\/preference/);
  assert.match(server,/\/api\/admin\/whatsapp\/opened/);
  assert.match(server,/status:mode==='cloud_api'\?'queued':'opened'/);
  assert.match(admin,/function normalizeWhatsappPhone/);
  assert.match(admin,/https:\/\/wa\.me\//);
  assert.match(admin,/WhatsApp'ta Aç/);
  assert.match(admin,/Kuyruk tamamlandı/);
  assert.match(admin,/Fotoğraf\/video normal WhatsApp bağlantısında otomatik eklenemez/i);
});

test('SMS/Mail tek sütunda başlık ve satır iki kolonlu hizalanıyor',()=>{
  assert.match(admin,/memberConsentHeader/);
  assert.match(admin,/<b>SMS<\/b><b>Mail<\/b>/);
  assert.match(admin,/memberConsentState/);
  assert.match(styles,/\.memberConsentHeader\{display:grid!important;grid-template-columns:1fr 1fr!important/);
  assert.match(styles,/\.memberConsentState small\{display:grid!important;grid-template-columns:1fr 1fr!important/);
});


test('push audit sonucu ve tarih filtresi authoritative akışta tutuluyor',()=>{
  assert.match(server,/lastPushResult='accepted'/);
  assert.match(server,/lastPushResult='permanent_invalid'/);
  assert.match(server,/lastPushResult='temporary_failure'/);
  assert.match(server,/lastPushHttpStatus/);
  assert.match(server,/lastPushErrorCode/);
  assert.match(admin,/function applyMemberDateRange\(\).*selectedMemberIds\.clear\(\).*renderMembers\(true\)/s);
  assert.match(admin,/function clearMemberDateRange\(\).*selectedMemberIds\.clear\(\).*renderMembers\(true\)/s);
  assert.match(admin,/Kalıcı geçersiz:/);
  assert.match(admin,/Cihaz tarafından alındı:/);
  assert.match(admin,/Teslim teyidi bekleniyor:/);
});

test('WhatsApp Türkiye numara normalizasyonu beklenen örnekleri verir',()=>{
  const match=admin.match(/function normalizeWhatsappPhone\(raw\)\{.*?\}(?=\nfunction memberDebugTitle)/s);
  assert.ok(match,'normalizeWhatsappPhone bulunamadı');
  const fn=Function(`${match[0]}; return normalizeWhatsappPhone;`)();
  assert.equal(fn('0532 123 45 67'),'+905321234567');
  assert.equal(fn('905321234567'),'+905321234567');
  assert.equal(fn('+90 532 123 45 67'),'+905321234567');
  assert.equal(fn('5321234567'),'+905321234567');
  assert.equal(fn('12345'),'');
});

test('cache bust v216 ve ilk ekran loader koruması aktif',()=>{
  assert.match(index,/app\.js\?v=216/);
  assert.match(index,/styles\.css\?v=200/);
  assert.match(adminHtml,/styles\.css\?v=216/);
  assert.match(adminHtml,/admin\.js\?v=216/);
  assert.match(app,/service-worker\.js\?v=200/);
  assert.match(index,/id="siteBootLoader"/);
  assert.match(index,/Yükleniyor/);
  assert.doesNotMatch(index,/html\.siteBooting body\{[^}]*visibility:hidden!important;opacity:0!important/);
  assert.match(app,/waitForInitialVisualAssets/);
});

test('dependency listesi değişmedi ve package-lock yapay olarak üretilmedi',()=>{
  assert.deepEqual(pkg.dependencies,{express:'^4.21.2',multer:'^2.0.2',xlsx:'^0.18.5',sharp:'^0.34.4','web-push':'^3.6.7'});
  assert.equal(fs.existsSync(path.join(root,'package-lock.json')),false);
});


test('üye satırı v186 çalışan doğrudan click ve klavye bağlantısını kullanıyor',()=>{
  assert.match(admin,/onclick="memberRowClick\(event,'\$\{attr\(u\.id\)\}'\)"/);
  assert.match(admin,/onkeydown="memberRowKey\(event,'\$\{attr\(u\.id\)\}'\)"/);
  assert.doesNotMatch(admin,/data-member-detail-id/);
  assert.doesNotMatch(admin,/closest\?\.\('\.memberAdminRow\[data-member-detail-id\]'/);
});

test('üye Excel aktarımı seçim varsa yalnız seçilenleri, seçim yoksa filtre sonucunu kullanıyor',()=>{
  assert.match(admin,/if\(selectedMemberIds\.size\)q\.set\('selectedIds',\[\.\.\.selectedMemberIds\]\.join\(','\)\)/);
  assert.match(server,/const selectedIds=\[\.\.\.new Set\(String\(req\.query\.selectedIds\|\|''\)/);
  assert.match(server,/selectedIds\.length\?adminMemberRows\(\)\.filter\(u=>selectedIds\.includes\(String\(u\.id\)\)\):filterAdminMembers\(adminMemberRows\(\),req\.query\)/);
});

test('normal tarayıcı yükleme bildirimi native prompt desteğine veya 24 saat gizleme kaydına bağlı değil',()=>{
  assert.match(app,/function showShazInstallNotice\(\)\{if\(adminPreviewMode\|\|shazAppInstalledThisSession\|\|isStandalonePwa\(\)\|\|document\.querySelector\('\.shazInstallNotice'\)\)return;/);
  assert.doesNotMatch(app,/shazInstallNoticeDismissed/);
  assert.doesNotMatch(app,/shazInstallNoticeDismissedAt/);
  assert.doesNotMatch(app,/manualEligible/);
  assert.match(app,/function scheduleShazInstallNotice\(\).*?afterSiteBoot\(\(\)=>\{.*?setTimeout\(\(\)=>\{.*?showShazInstallNotice\(\).*?\},12000\)/s);
  assert.match(app,/window\.addEventListener\('beforeinstallprompt',e=>\{e\.preventDefault\(\);shazDeferredInstallPrompt=e;scheduleShazInstallNotice\(\)\}/);
  assert.match(app,/window\.addEventListener\('load',scheduleShazInstallNotice/);
  assert.doesNotMatch(app,/setTimeout\(showShazInstallNotice,1200\)/);
});


test('push provider kabulü ile cihaz ACK sonucu ayrı raporlanıyor ve hızlı polling yapılıyor',()=>{
  assert.match(admin,/Push servisi kabul etti:/);
  assert.match(admin,/Push servisi reddetti:/);
  assert.match(admin,/Cihaz tarafından alındı:/);
  assert.match(admin,/Teslim teyidi bekleniyor:/);
  assert.match(admin,/renderManualPushResult\(\{sending:true\}\)/);
  assert.match(admin,/Date\.now\(\)-started<10000/);
  assert.match(admin,/setTimeout\(r,150\)/);
  assert.match(server,/pendingAck:Math\.max\(0,accepted-acked\)/);
  assert.match(server,/app\.post\('\/api\/push\/ack'/);
  assert.match(server,/lastPushDeviceAckAt/);
});

test('tek üye push hedeflemesi yalnız seçilen üye/customer scope ile sınırlı ve aynı cihaz stale endpointleri invalid ediyor',()=>{
  assert.match(server,/selectedScope\?\(x\.userId\?targetUserIds\.has\(String\(x\.userId\)\):targetCustomerIds\.has\(String\(x\.customerId\|\|''\)\)\)/);
  assert.match(server,/async function normalizeActivePushTargets/);
  assert.match(server,/if\(!deviceId\)continue/);
  assert.match(server,/function markPushSuperseded\(row,at,reason='superseded_endpoint'\)/);
  assert.match(server,/staleSubscriptionsInvalidated/);
  const normalize=server.match(/async function normalizeActivePushTargets\(.*?(?=\nasync function sendPushRows)/s)?.[0]||'';
  assert.doesNotMatch(normalize,/permanentInvalidAt/);
});

test('foreground bildirim doğrulaması 60 saniyelik cachei force ile aşarak gerçek permission ve subscriptionı yeniden okuyor',()=>{
  assert.match(app,/async function verifyShazForegroundState/);
  assert.match(app,/navigator\.serviceWorker\.getRegistration\('\/'\)/);
  assert.match(app,/reg\.pushManager\.getSubscription\(\)/);
  assert.match(app,/Notification\.permission==='denied'/);
  assert.match(app,/else if\(permission==='granted'\)\{if\(!sub\)/);
  assert.match(app,/reconcileShazPush\(reg,true\)/);
  for(const token of ["foreground('focus')","foreground(e.persisted?'pageshow-bfcache':'pageshow')","foreground('visibility')","foreground('resume')"]) assert.match(app,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(server,/permission==='granted'&&pushState==='active'&&hasPush/);
  assert.match(server,/permission==='granted'&&pushState!=='active'\)return \{\.\.\.base,summary:'Kapalı'/);
});

test('SMS ve e-posta pazarlama tercihleri optimistic UI kullanıyor ve hata halinde rollback yapıyor',()=>{
  assert.match(app,/const marketingConsentInFlight=new Set\(\)/);
  assert.match(app,/currentAccountUser\[field\]=next/);
  assert.match(app,/input\.checked=next/);
  assert.match(app,/currentAccountUser\[field\]=old/);
  assert.match(app,/input\.checked=old/);
  assert.match(app,/PATCH|marketing-consent/);
  assert.match(app,/\/api\/account\/marketing-consent/);
});

test('üye detay drawer kökü sekme ve canlı güncellemede yeniden oluşturulmuyor',()=>{
  const open=admin.match(/function openMemberDetail\(.*?(?=\nfunction refreshOpenMemberDetail)/s)?.[0]||'';
  const tab=admin.match(/function setMemberDetailTab\(.*?(?=\nfunction startMemberGeneralEdit)/s)?.[0]||'';
  assert.match(open,/if\(overlay\)\{refreshOpenMemberDetail\(previousId===activeMemberPanelId\);return\}/);
  assert.equal((open.match(/document\.body\.appendChild\(el\)/g)||[]).length,1);
  assert.doesNotMatch(open,/\.remove\(\)/);
  assert.match(tab,/refreshOpenMemberDetail\(true\)/);
  assert.doesNotMatch(tab,/openMemberDetail\(/);
  assert.match(admin,/applyRealtimeMemberUpdate\(payload\).*refreshOpenMemberDetail\(true\)/s);
  assert.match(admin,/refreshMemberActivityNow\(\).*refreshOpenMemberDetail\(true\)/s);
});

test('splash ana UI hazır olunca iki frame içinde açılıyor; görsel/font bekleme arka planda kalıyor',()=>{
  const finish=app.match(/function finishSiteBoot\(\).*?(?=\nfunction bindCore)/s)?.[0]||'';
  assert.match(finish,/criticalUiReady=performance\.now\(\)/);
  assert.match(finish,/requestAnimationFrame\(\(\)=>requestAnimationFrame/);
  assert.match(finish,/classList\.remove\('siteBooting','siteBootError'\)/);
  assert.match(finish,/siteVisible=performance\.now\(\)/);
  assert.match(finish,/waitForInitialVisualAssets\(\)\.catch\(\(\)=>\{\}\)/);
  assert.doesNotMatch(finish,/await waitForInitialVisualAssets/);
  assert.match(app,/window\.__shazBootMetrics/);
});
