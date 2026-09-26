const SHAZ_SW_VERSION='164';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  let data={};
  try{data=event.data?event.data.json():{}}catch(_){data={body:event.data?.text?.()||''}}
  const title=String(data.title||'SHAZ').slice(0,80);
  const rawUrl=String(data.url||data.data?.url||'/');
  let url='/';try{const u=new URL(rawUrl,self.location.origin);if(u.origin===self.location.origin)url=u.pathname+u.search+u.hash}catch(_){}
  event.waitUntil(self.registration.showNotification(title,{body:String(data.body||'').slice(0,240),icon:data.icon||'/icon-192.png',badge:data.badge||'/icon-192.png',tag:String(data.tag||'').slice(0,80)||undefined,data:{url},renotify:false}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const raw=String(event.notification?.data?.url||'/');let target='/';
  try{const u=new URL(raw,self.location.origin);if(u.origin===self.location.origin)target=u.pathname+u.search+u.hash}catch(_){}
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients=>{
    for(const client of clients){try{const u=new URL(client.url);if(u.origin===self.location.origin){await client.focus();if('navigate' in client)await client.navigate(target);return}}catch(_){}}
    return self.clients.openWindow(target);
  }));
});
