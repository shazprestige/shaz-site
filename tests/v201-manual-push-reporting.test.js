const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const admin=fs.readFileSync(path.join(root,'public/admin.js'),'utf8');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');

function adminMatch(re,label){const m=admin.match(re);assert.ok(m,`${label} bulunamadı`);return m[0]}
function outcomeFn(){const src=adminMatch(/function manualPushOutcomeText\(r=\{\}\)\{.*?\}(?=\nfunction renderManualPushResult)/s,'manualPushOutcomeText');return Function(`${src};return manualPushOutcomeText;`)()}
function renderHarness(){
  const outcome=adminMatch(/function manualPushOutcomeText\(r=\{\}\)\{.*?\}(?=\nfunction renderManualPushResult)/s,'manualPushOutcomeText');
  const render=adminMatch(/function renderManualPushResult\(r\)\{.*?\n\}(?=\nfunction applyManualPushDeliveryUpdate)/s,'renderManualPushResult');
  const el={textContent:'',innerHTML:'',querySelector(){return {removeAttribute(){}}}};
  const fn=Function('el',`function $(q){return el}function esc(v){return String(v??'').replace(/[&<>\"]/g,'')} ${outcome};${render};return renderManualPushResult;`)(el);
  return {el,fn};
}
function mainHtml(payload){const {el,fn}=renderHarness();fn(payload);return el.innerHTML.split('<details>')[0]}

const selected=(count,extra={})=>({ok:true,scope:'selected',selectedMemberCount:count,memberScopeCount:count,selectedMemberNames:Array.from({length:count},(_,i)=>`Üye ${i+1}`),...extra});

test('TEST 1: 2 seçili, 1 ACK, 1 aktif cihaz yok => 2 / 1 / 1 ve kısmi başarı',()=>{
  const r=selected(2,{targetCount:1,providerAccepted:1,providerRejected:0,deviceAckCount:1,ackWindowExpired:false});
  const main=mainHtml(r);assert.match(main,/Hedef cihaz: <b>2<\/b>/);assert.match(main,/Teslim edildi: <b>1<\/b>/);assert.match(main,/Teslim edilemeyen: <b>1<\/b>/);assert.match(main,/⚠ 2 üyeden 1'ine bildirim teslim edildi, 1'ine teslim edilemedi\./);assert.doesNotMatch(main,/✓ Bildirim teslim edildi/);
});

test('TEST 2: 2 seçili, ikisine ACK => tam başarı',()=>{
  const r=selected(2,{targetCount:2,providerAccepted:2,providerRejected:0,deviceAckCount:2});
  const main=mainHtml(r);assert.match(main,/Hedef cihaz: <b>2<\/b>/);assert.match(main,/Teslim edildi: <b>2<\/b>/);assert.match(main,/Teslim edilemeyen: <b>0<\/b>/);assert.match(main,/✓ Bildirimler 2 üyenin tamamına teslim edildi\./);
});

test('TEST 3: 2 seçili, ikisinde de aktif push cihazı yok => 0 teslim, 2 başarısız',()=>{
  const r=selected(2,{targetCount:0,providerAccepted:0,providerRejected:0,deviceAckCount:0});
  const main=mainHtml(r);assert.match(main,/Hedef cihaz: <b>2<\/b>/);assert.match(main,/Teslim edildi: <b>0<\/b>/);assert.match(main,/Teslim edilemeyen: <b>2<\/b>/);assert.match(main,/✕ Seçilen 2 üyeye bildirim teslim edilemedi\./);
});

test('TEST 4: 5 seçili, 3 teslim => 2 teslim edilemeyen',()=>{
  const r=selected(5,{targetCount:5,providerAccepted:5,providerRejected:0,deviceAckCount:3,ackWindowExpired:true});
  const main=mainHtml(r);assert.match(main,/Hedef cihaz: <b>5<\/b>/);assert.match(main,/Teslim edildi: <b>3<\/b>/);assert.match(main,/Teslim edilemeyen: <b>2<\/b>/);
});

test('TEST 5: tek seçili başarılı teslim mevcut metni korur',()=>{
  const r=selected(1,{selectedMemberNames:['Eren'],targetCount:1,providerAccepted:1,providerRejected:0,deviceAckCount:1});
  const main=mainHtml(r);assert.match(main,/Hedef cihaz: <b>1<\/b>/);assert.match(main,/Teslim edildi: <b>1<\/b>/);assert.match(main,/Teslim edilemeyen: <b>0<\/b>/);assert.match(main,/✓ Bildirim teslim edildi\./);
});

test('TEST 6: tek seçili aktif cihaz yok => 1 başarısız',()=>{
  const r=selected(1,{selectedMemberNames:['Ibo'],targetCount:0,providerAccepted:0,providerRejected:0,deviceAckCount:0});
  const main=mainHtml(r);assert.match(main,/Hedef cihaz: <b>1<\/b>/);assert.match(main,/Teslim edildi: <b>0<\/b>/);assert.match(main,/Teslim edilemeyen: <b>1<\/b>/);assert.match(main,/✕ Seçilen 1 üyeye bildirim teslim edilemedi\./);
});

test('ACK beklenirken seçili üye başarısız sayacı erken finalleştirilmez',()=>{
  const r=selected(2,{targetCount:1,providerAccepted:1,providerRejected:0,deviceAckCount:0,ackWindowExpired:false});
  const main=mainHtml(r);assert.match(main,/Teslim edilemeyen: <b>0<\/b>/);assert.match(main,/Teslim teyidi bekleniyor/);
});

test('provider hatası alan seçili üye final raporda başarısız sayılır',()=>{
  const r=selected(2,{targetCount:2,providerAccepted:1,providerRejected:1,deviceAckCount:1,failureStatuses:{503:1}});
  const main=mainHtml(r);assert.match(main,/Teslim edildi: <b>1<\/b>/);assert.match(main,/Teslim edilemeyen: <b>1<\/b>/);assert.match(main,/⚠ 2 üyeden 1'ine bildirim teslim edildi, 1'ine teslim edilemedi\./);
});

test('seçili üye ana sayımı gerçek endpoint target sayısından ayrıdır, teknik target detayda kalır',()=>{
  const {el,fn}=renderHarness();fn(selected(2,{targetCount:1,providerAccepted:1,deviceAckCount:1}));assert.match(el.innerHTML,/Hedef cihaz: <b>2<\/b>/);assert.match(el.innerHTML,/Gerçek push endpoint hedefi: 1/);assert.match(el.innerHTML,/<summary>Detayları Göster<\/summary>/);
});

test('push gönderim/authority/ACK sunucu koduna V201 raporlama için dokunulmaz',()=>{
  assert.match(server,/const result=await sendPushRows\(manualTargets,payload/);assert.match(server,/function applyPushDeliveryAck/);assert.match(server,/keepLatestAuthoritativePushTargets/);
});
