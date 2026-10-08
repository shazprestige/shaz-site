'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createCargoService}=require('../cargo-service');
const env={YESILKAR_CREATE_URL:'https://example.test/restapi/client/consignment/add',YESILKAR_STATUS_URL_TEMPLATE:'https://example.test/restapi/client/consignments?barcode={barcode}',YESILKAR_AUTH_HEADER_NAME:'Authorization',YESILKAR_API_KEY:'test-only',YESILKAR_FROM_HEADER_NAME:'From',YESILKAR_API_FROM:'test@example.com',YESILKAR_BRANCH_CODE:'DY',YESILKAR_AMOUNT_TYPE_ID:'3'};
const order={id:'SHZ112',customer:{fullName:'Rabia Akça',phone:'05012345678',province:'Konya',district:'Meram'},total:1200};
const example={error:false,data:[{gonderino:'210490400001',aliciadi:'RABİA',alicisoyad:'AKÇA',sehiradi:'KONYA',ilce:'MERAM',telno:'',statu_no:'01'}]};
const response=data=>({ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify(data)});
test('Yeşilkar panelinde oluşturulan gerçek gönderiyi kimlik eşleştirmesiyle bulur, yeni POST göndermez',async()=>{
  const calls=[];const service=createCargoService({env,fetchImpl:async(url,options)=>{calls.push({url,method:options.method||'GET'});return response(example)}});
  const result=await service.lookupManualShipment({shipmentNumber:'210490400001',order});
  assert.equal(result.barcode,'210490400001');assert.equal(result.trackingNumber,'210490400001');assert.equal(result.externalManual,true);assert.equal(result.status,'handed_over');
  assert.equal(calls.length,1);assert.match(calls[0].url,/\/restapi\/client\/cargo\?gonderino=210490400001/);assert.equal(calls[0].method,'GET');
});
test('Yanlış müşteri adına veya ilçeye ait manuel kargo bağlanamaz',async()=>{
  for(const update of [{aliciadi:'ZEYNEP'},{ilce:'SELÇUKLU'},{sehiradi:'ANKARA'}]){
    const service=createCargoService({env,fetchImpl:async()=>response({...example,data:[{...example.data[0],...update}]})});
    await assert.rejects(service.lookupManualShipment({shipmentNumber:'210490400001',order}),e=>e.code==='CARGO_MANUAL_RECIPIENT_MISMATCH');
  }
});
test('Doğrulanmamış numara, boş teslimat bilgisi ve yanlış telefon reddedilir',async()=>{
  const testCases=[{gonderino:'210490400002'},{ilce:''},{telno:'05399999999'}];
  for(const update of testCases){const service=createCargoService({env,fetchImpl:async()=>response({...example,data:[{...example.data[0],...update}]})});await assert.rejects(service.lookupManualShipment({shipmentNumber:'210490400001',order}));}
  const service=createCargoService({env,fetchImpl:async()=>response(example)});
  await assert.rejects(service.lookupManualShipment({shipmentNumber:'DY0000000008',order}),e=>e.code==='CARGO_MANUAL_NUMBER_INVALID');
});
test('Manuel bağlantı doğru servisten teslimat durumunu güncelleyebilir',async()=>{
  const calls=[];const service=createCargoService({env,fetchImpl:async(url,options)=>{calls.push(url);return response({...example,data:[{...example.data[0],statu_no:'10',sonuc:'Teslim Edildi'}]})}});
  const res=await service.refreshShipment({shipment:{barcode:'210490400001',trackingNumber:'210490400001',externalManual:true,status:'handed_over'},order});
  assert.equal(res.status,'delivered');assert.equal(calls.length,1);assert.match(calls[0],/\/cargo\?/);
});
test('Mevcut SHZ siparişine manuel link endpointi var; DY geçmişi korunur',()=>{
  const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8'),admin=fs.readFileSync(path.join(__dirname,'..','public','admin.js'),'utf8');
  assert.match(server,/attachManualCargoShipment\(orderId,number\)/);
  assert.match(server,/rows\.push\(shipment\);writeJson\('cargo_records\.json',rows\)/);
  assert.match(server,/\/api\/admin\/cargo\/orders\/:id\/attach-manual/);
  assert.match(server,/lookupManualShipment\(\{shipmentNumber,order:found\.order\}\)/);
  assert.match(server,/cargoService\.refreshShipment\(\{shipment,order:found\.order\}\)/);
  assert.match(admin,/Yeşilkar Manuel Kargo Bağla/);
  assert.match(admin,/Yeni kargo oluşturulmaz/);
  assert.match(admin,/!row\?\.externalManual/);
});
