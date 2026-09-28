const SHAZ_SW_VERSION='173';
const SHAZ_BADGE_DB='shaz-pwa-badge';
const SHAZ_BADGE_STORE='state';
const SHAZ_BADGE_KEY='unreadCount';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
function badgeDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(SHAZ_BADGE_DB,1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(SHAZ_BADGE_STORE))req.result.createObjectStore(SHAZ_BADGE_STORE)};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function readBadgeCount(){try{const db=await badgeDb();return await new Promise((resolve,reject)=>{const tx=db.transaction(SHAZ_BADGE_STORE,'readonly'),req=tx.objectStore(SHAZ_BADGE_STORE).get(SHAZ_BADGE_KEY);req.onsuccess=()=>resolve(Math.max(0,Number(req.result||0)));req.onerror=()=>reject(req.error)})}catch(_){return 0}}
async function writeBadgeCount(count){try{const db=await badgeDb();await new Promise((resolve,reject)=>{const tx=db.transaction(SHAZ_BADGE_STORE,'readwrite');tx.objectStore(SHAZ_BADGE_STORE).put(Math.max(0,Number(count||0)),SHAZ_BADGE_KEY);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}catch(_){} }
async function setBadge(count){try{if(typeof self.navigator?.setAppBadge==='function')await self.navigator.setAppBadge(count)}catch(_){} }
async function clearBadge(){await writeBadgeCount(0);try{if(typeof self.navigator?.clearAppBadge==='function')await self.navigator.clearAppBadge()}catch(_){} }
async function incrementBadge(){const count=(await readBadgeCount())+1;await writeBadgeCount(count);await setBadge(count);return count}
self.addEventListener('message',event=>{if(event.data?.type==='SHAZ_CLEAR_BADGE')event.waitUntil(clearBadge())});
function safeSameOriginPath(raw){let url='/';try{const u=new URL(String(raw||'/'),self.location.origin);if(u.origin===self.location.origin)url=u.pathname+u.search+u.hash}catch(_){}return url}
async function acknowledgePush(data){const deliveryId=String(data?.deliveryId||'').trim();if(!deliveryId)return;try{await fetch('/api/push/ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deliveryId,subscriptionId:String(data?.subscriptionId||''),receivedAt:new Date().toISOString()})})}catch(_){} }
self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    let data={};
    try{data=event.data?event.data.json():{}}catch(_){try{const text=event.data?.text?.()||'';try{data=JSON.parse(text)}catch(__){data={body:text}}}catch(__){data={}}}
    let title=String(data.title??'').trim().slice(0,80),body=String(data.body??'').trim().slice(0,240);
    if(!title&&!body)return;
    const isManual=String(data.type||'')==='manual';
    const ua=String(self.navigator?.userAgent||'');
    const isIOS=/iPhone|iPad|iPod/i.test(ua)||(/Macintosh/i.test(ua)&&/Mobile/i.test(ua));
    if(isManual){title=title||(isIOS?'':'SHAZ')}else if(!title&&body){title=body;body=''}
    if(!title&&!isManual)return;
    const options={icon:data.icon||'/icon-192.png?v=173',badge:data.badge||'/icon-192.png?v=173',data:{url:safeSameOriginPath(data.url||data.data?.url||'/')}};
    const tag=String(data.tag||'').trim().slice(0,80);if(tag)options.tag=tag;
    if(body)options.body=body;
    await self.registration.showNotification(title,options);
    await incrementBadge();
    await acknowledgePush(data);
  })().catch(err=>console.error('SHAZ push display failed:',String(err?.message||err))));
});
self.addEventListener('pushsubscriptionchange',event=>{
  event.waitUntil((async()=>{
    const oldEndpoint=String(event.oldSubscription?.endpoint||'');let sub=event.newSubscription||null;
    if(!sub&&event.oldSubscription?.options?.applicationServerKey){try{sub=await self.registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:event.oldSubscription.options.applicationServerKey})}catch(_){} }
    if(!sub)return;
    const body=sub.toJSON();if(oldEndpoint)body.oldEndpoint=oldEndpoint;body.pwa=true;
    await fetch('/api/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  })().catch(err=>console.error('SHAZ pushsubscriptionchange sync failed:',String(err?.message||err))));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();const target=safeSameOriginPath(event.notification?.data?.url||'/');
  event.waitUntil(Promise.all([clearBadge(),self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients=>{
    for(const client of clients){try{const u=new URL(client.url);if(u.origin===self.location.origin){await client.focus();if('navigate'in client)await client.navigate(target);return}}catch(_){} }
    return self.clients.openWindow(target);
  })]));
});
