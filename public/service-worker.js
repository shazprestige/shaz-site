const SHAZ_SW_VERSION='167';
const SHAZ_BADGE_DB='shaz-pwa-badge';
const SHAZ_BADGE_STORE='state';
const SHAZ_BADGE_KEY='unreadCount';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
function badgeDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(SHAZ_BADGE_DB,1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(SHAZ_BADGE_STORE))req.result.createObjectStore(SHAZ_BADGE_STORE)};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function readBadgeCount(){try{const db=await badgeDb();return await new Promise((resolve,reject)=>{const tx=db.transaction(SHAZ_BADGE_STORE,'readonly'),req=tx.objectStore(SHAZ_BADGE_STORE).get(SHAZ_BADGE_KEY);req.onsuccess=()=>resolve(Math.max(0,Number(req.result||0)));req.onerror=()=>reject(req.error)})}catch(_){return 0}}
async function writeBadgeCount(count){try{const db=await badgeDb();await new Promise((resolve,reject)=>{const tx=db.transaction(SHAZ_BADGE_STORE,'readwrite');tx.objectStore(SHAZ_BADGE_STORE).put(Math.max(0,Number(count||0)),SHAZ_BADGE_KEY);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}catch(_){}}
async function setBadge(count){try{if(typeof self.navigator?.setAppBadge==='function')await self.navigator.setAppBadge(count)}catch(_){}}
async function clearBadge(){await writeBadgeCount(0);try{if(typeof self.navigator?.clearAppBadge==='function')await self.navigator.clearAppBadge()}catch(_){}}
async function incrementBadge(){const count=(await readBadgeCount())+1;await writeBadgeCount(count);await setBadge(count);return count}
self.addEventListener('message',event=>{if(event.data?.type==='SHAZ_CLEAR_BADGE')event.waitUntil(clearBadge())});
self.addEventListener('push',event=>{
  let data={};
  try{data=event.data?event.data.json():{}}catch(_){data={body:event.data?.text?.()||''}}
  let title=String(data.title??'').trim().slice(0,80);
  let body=String(data.body??'').trim().slice(0,240);
  if(!title&&body){title=body;body=''}
  if(!title&&!body)return;
  const rawUrl=String(data.url||data.data?.url||'/');
  let url='/';try{const u=new URL(rawUrl,self.location.origin);if(u.origin===self.location.origin)url=u.pathname+u.search+u.hash}catch(_){}
  const options={icon:data.icon||'/icon-192.png?v=167',badge:data.badge||'/icon-192.png?v=167',tag:String(data.tag||'').trim().slice(0,80)||undefined,data:{url},renotify:false};
  if(body)options.body=body;
  event.waitUntil(Promise.all([self.registration.showNotification(title,options),incrementBadge()]));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const raw=String(event.notification?.data?.url||'/');let target='/';
  try{const u=new URL(raw,self.location.origin);if(u.origin===self.location.origin)target=u.pathname+u.search+u.hash}catch(_){}
  event.waitUntil(Promise.all([clearBadge(),self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients=>{
    for(const client of clients){try{const u=new URL(client.url);if(u.origin===self.location.origin){await client.focus();if('navigate' in client)await client.navigate(target);return}}catch(_){}}
    return self.clients.openWindow(target);
  })]));
});
