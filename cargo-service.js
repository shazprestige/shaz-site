'use strict';

const CARGO_STATUSES=Object.freeze({
  not_created:{code:'not_created',label:'Kargo Oluşturulmadı'},
  creating:{code:'creating',label:'Kargo Oluşturuluyor'},
  created:{code:'created',label:'Kargo Oluşturuldu'},
  handed_over:{code:'handed_over',label:'Kargoya Verildi'},
  out_for_delivery:{code:'out_for_delivery',label:'Dağıtımda'},
  delivered:{code:'delivered',label:'Teslim Edildi'},
  returned:{code:'returned',label:'İade'},
  cancelled:{code:'cancelled',label:'İptal'},
  error:{code:'error',label:'Hata'}
});
const CARGO_STATUS_OPTIONS=Object.freeze(Object.values(CARGO_STATUSES));

function clean(value,max=500){return String(value??'').trim().slice(0,max)}
function orderAddress(customer={}){
  if(customer.deliveryMode==='branch')return ['ARAS KARGO ŞUBE TESLİM',customer.branchName].filter(Boolean).join(' - ');
  const road=[customer.neighborhood,customer.avenue,customer.street].filter(Boolean).join(' ');
  const nums=[customer.buildingNo?`No:${customer.buildingNo}`:'',customer.floor?`Kat:${customer.floor}`:'',customer.doorNo?`Daire:${customer.doorNo}`:''].filter(Boolean).join(' ');
  return [road,customer.fullAddress,nums,customer.businessName].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
}
function orderSummary(order={}){
  return (Array.isArray(order.items)?order.items:[]).map(x=>{
    const name=clean(x?.product?.name||x?.name||'Ürün',120),qty=Math.max(1,Number(x?.qty||1));
    return `${name} x${qty}`;
  }).join(', ').slice(0,1000);
}
// Ürün adedi fiziksel kargo paketi adedi değildir. Ayrı bir paket adedi tanımlanmamışsa tek paket gönderilir.
function orderQuantity(order={}){const parcels=Number(order.cargoPackageCount);return Number.isSafeInteger(parcels)&&parcels>=1&&parcels<=20?parcels:1}
function redactProviderResponse(value,depth=0){
  if(depth>5)return '[omitted]';
  if(Array.isArray(value))return value.slice(0,50).map(x=>redactProviderResponse(x,depth+1));
  if(value&&typeof value==='object'){
    const out={};
    for(const [k,v] of Object.entries(value)){
      if(/api.?key|secret|authorization|token|password|credential|from/i.test(k)){out[k]='[redacted]';continue}
      out[k]=redactProviderResponse(v,depth+1);
    }
    return out;
  }
  if(typeof value==='string')return value.slice(0,4000);
  return value;
}
function providerStatusToCargoStatus(raw,current='created'){
  const original=clean(raw,120),code=original.padStart(2,'0');
  if(code==='00')return 'created';
  if(code==='01'||code==='40'||code==='41'||code==='50'||code==='60')return 'handed_over';
  if(code==='42')return 'out_for_delivery';
  if(code==='10')return 'delivered';
  if(['20','21','22','23','24'].includes(code))return 'returned';
  const s=original.toLocaleLowerCase('tr-TR');
  if(!s)return current;
  if(/teslim edilemedi|teslimat şubesinde|teslimat subesinde|transfer sürecinde|transfer surecinde|kabul edildi|kargoya.*ver|handed|accepted.*branch/.test(s))return 'handed_over';
  if(/kurye dağıtımda|kurye dagitimda|dağıtımda|dagitimda|out.?for.?delivery/.test(s))return 'out_for_delivery';
  if(/teslim edildi|^teslim$|delivered/.test(s))return 'delivered';
  if(/iade|return/.test(s))return 'returned';
  if(/iptal|cancel/.test(s))return 'cancelled';
  if(/hata|error|fail/.test(s))return 'error';
  if(/oluştur|olustur|created|created shipment|kabul bekliyor/.test(s))return 'created';
  return current;
}
function providerEventDateToIso(value){
  const raw=clean(value,120);if(!raw)return '';
  const tr=raw.match(/^(\d{2})[.\/-](\d{2})[.\/-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if(tr){const [,d,m,y,h='00',min='00',sec='00']=tr,dt=new Date(`${y}-${m}-${d}T${String(h).padStart(2,'0')}:${min}:${sec}+03:00`);return Number.isNaN(dt.getTime())?'':dt.toISOString()}
  const dt=new Date(raw);return Number.isNaN(dt.getTime())?'':dt.toISOString();
}
function providerMovementTextFromRow(row={}){
  for(const key of ['last_movement','lastMovement','movement_text','movementText','hareket','hareket_aciklama','hareketAciklama','statu_aciklama','statuAciklama','status_description','statusDescription','durum_aciklama','durumAciklama','status_name','sonuc','durum']){
    const value=clean(row?.[key],1000);if(value)return value;
  }
  return '';
}
function providerStatusAtFromRow(row={}){
  for(const key of ['delivered_at','deliveredAt','delivery_date','deliveryDate','delivery_datetime','deliveryDateTime','teslim_tarihi','teslimTarihi','teslimat_tarihi','teslimatTarihi','status_at','statusAt','statu_tarihi','statuTarihi','durum_tarihi','durumTarihi','hareket_tarihi','hareketTarihi','movement_at','movementAt','degisimTarih','degisim_tarihi','sonuctarihi']){
    const iso=providerEventDateToIso(row?.[key]);if(iso)return iso;
  }
  return '';
}
function providerMovementToWorkflowStage({status='',movementText='',currentStage=''}={}){
  if(status==='delivered')return 'delivered';
  if(status==='returned')return 'returned';
  const text=clean(movementText,1000),s=text.toLocaleLowerCase('tr-TR');
  const branchWaiting=/şubede\s*bekliyor|subede\s*bekliyor|şubeden\s*(?:teslim|alın|alin|alacak)|subeden\s*(?:teslim|alın|alin|alacak)|(?:alıcı|alici|müşteri|musteri).{0,50}(?:şubeden|subeden|şubesinden|subesinden).{0,50}(?:teslim|alacak|alın|alin)|(?:alıcı|alici).{0,40}gelmesi.{0,40}bekleniyor|teslim\s*edilemedi.{0,60}(?:şubede|subede)|(?:şubede|subede).{0,60}(?:alıcı|alici|müşteri|musteri).{0,40}bekleniyor/.test(s);
  const redistribution=status==='out_for_delivery'||/yeniden.{0,30}(?:dağıtıma|dagitima)\s*çıktı|(?:dağıtıma|dagitima)\s*çıktı|kurye\s*(?:dağıtımda|dagitimda)|out.?for.?delivery/.test(s);
  if(currentStage==='branch_waiting'){
    if(branchWaiting)return 'branch_waiting';
    if(redistribution)return 'in_transit';
    return null;
  }
  if(branchWaiting)return 'branch_waiting';
  if(status==='handed_over'||status==='out_for_delivery')return 'in_transit';
  return null;
}
function fillTemplate(template,vars={}){
  let out=clean(template,1000);
  for(const [k,v] of Object.entries(vars))out=out.replaceAll(`{${k}}`,encodeURIComponent(clean(v,300)));
  return out;
}
function formEncode(payload={}){
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries(payload)){
    if(value===undefined||value===null||value==='')continue;
    params.set(key,String(value));
  }
  return params.toString();
}
function responseHasError(data){return data?.error===true||String(data?.error||'').toLowerCase()==='true'}
function providerRows(data){
  const out=[],seen=new Set(),containerKeys=['data','result','results','rows','records','consignments','list','items'];
  const visit=(value,depth=0)=>{
    if(depth>4||value===null||value===undefined)return;
    if(Array.isArray(value)){for(const item of value)visit(item,depth+1);return}
    if(typeof value!=='object')return;
    const hasShipmentField=['barcode','cargo_barcode','barkod','musteribarkod','gonderino','kurcikno','record_id','recordId','kayitno','id','order_number','orderNumber','order_no','orderNo','sipno','sip_no','siparis_no','siparisNo'].some(k=>Object.prototype.hasOwnProperty.call(value,k));
    if(hasShipmentField&&!seen.has(value)){seen.add(value);out.push(value)}
    for(const key of containerKeys)if(value[key]&&value[key]!==value)visit(value[key],depth+1);
  };
  visit(data);return out;
}
function providerOrderNumberFromRow(row={}){
  for(const key of ['order_number','orderNumber','order_no','orderNo','sipno','sip_no','siparis_no','siparisNo','siparisno','siparis_numarasi','siparisNumarasi']){const value=clean(row?.[key],160);if(value)return value}
  return '';
}
function providerRowCreatedAt(row={}){
  for(const key of ['created_at','createdAt','create_date','createDate','ekleme_tarihi','eklemeTarihi','kayit_tarihi','kayitTarihi','date_added','dateAdded','alimtarihi','alim_tarihi','degisimTarih','degisim_tarihi']){const iso=providerEventDateToIso(row?.[key]);if(iso)return iso}
  return '';
}
function providerRowMatchesOrder(row,{orderNumber='',order=null}={}){
  if(providerOrderNumberFromRow(row)!==clean(orderNumber,160))return false;
  const c=order?.customer||{},digits=v=>String(v||'').replace(/\D/g,'').slice(-10),rowPhone=digits(row?.telephone||row?.phone||row?.gsm||row?.telno||row?.customer_phone||row?.customerPhone||row?.alici_telefon||row?.aliciTelefon),orderPhone=digits(c.phone);
  if(rowPhone&&orderPhone&&rowPhone!==orderPhone)return false;
  const created=providerRowCreatedAt(row),orderCreated=providerEventDateToIso(order?.createdAt||'');
  if(created&&orderCreated&&new Date(created).getTime()<new Date(orderCreated).getTime()-6*60*60*1000)return false;
  return true;
}

function createCargoService({env=process.env,fetchImpl=global.fetch}={}){
  const config={
    provider:'yesilkar',
    cargoCompany:'Aras Kargo / YeşilKar',
    createUrl:clean(env.YESILKAR_CREATE_URL,1000),
    statusUrlTemplate:clean(env.YESILKAR_STATUS_URL_TEMPLATE,1000),
    labelUrlTemplate:clean(env.YESILKAR_LABEL_URL_TEMPLATE,1000),
    authHeaderName:clean(env.YESILKAR_AUTH_HEADER_NAME,120),
    // PDF'de API Authorization değerinin API KEY olduğu belirtiliyor.
    // Ayrı YESILKAR_AUTH_HEADER_VALUE verilmezse güvenli environment değişkeni olan YESILKAR_API_KEY kullanılır.
    authHeaderValue:clean(env.YESILKAR_AUTH_HEADER_VALUE||env.YESILKAR_API_KEY,2000),
    apiKeyHeaderName:clean(env.YESILKAR_API_KEY_HEADER_NAME,120),
    apiKey:clean(env.YESILKAR_API_KEY,2000),
    fromHeaderName:clean(env.YESILKAR_FROM_HEADER_NAME,120),
    apiFrom:clean(env.YESILKAR_API_FROM,1000),
    branchCode:clean(env.YESILKAR_BRANCH_CODE,120),
    amountTypeId:clean(env.YESILKAR_AMOUNT_TYPE_ID,120)
  };
  function configuration(){
    const required=['createUrl','authHeaderName','authHeaderValue','fromHeaderName','apiFrom','branchCode','amountTypeId'];
    const missing=required.filter(k=>!config[k]);
    if(config.apiKeyHeaderName&&!config.apiKey)missing.push('apiKey');
    return {provider:config.provider,cargoCompany:config.cargoCompany,configured:missing.length===0,missing};
  }
  function providerHeaders({form=false}={}){
    const state=configuration();
    if(!state.configured){const e=new Error('YeşilKar / Aras API bağlantısı henüz yapılandırılmadı. Gerçek API bilgileri girilmeden kargo oluşturulamaz.');e.code='CARGO_INTEGRATION_NOT_CONFIGURED';throw e}
    const headers={'User-Agent':'Mozilla/5.0 SHAZ-Kargo-Entegrasyonu'};
    if(form)headers['Content-Type']='application/x-www-form-urlencoded';
    headers[config.authHeaderName]=config.authHeaderValue;
    headers[config.fromHeaderName]=config.apiFrom;
    if(config.apiKeyHeaderName&&config.apiKey)headers[config.apiKeyHeaderName]=config.apiKey;
    return headers;
  }
  function shipmentPayment(order={}){
    const p=clean(order.payment,120).toLocaleLowerCase('tr-TR');
    const isDoorCard=/kapıda.*(kart|kredi)|door.*card/.test(p);
    const isCod=p==='cod'||/kapıda|cash.?on.?delivery/.test(p);
    if(isDoorCard)return {amountTypeId:'6',amount:Number(order.total||0).toFixed(2)};
    if(isCod)return {amountTypeId:config.amountTypeId||'3',amount:Number(order.total||0).toFixed(2)};
    // PDF'ye göre amount_type_id=3 + boş amount tahsilatsız gönderidir.
    return {amountTypeId:config.amountTypeId||'3',amount:null};
  }
  function buildShipmentPayload(order={},options={}){
    const c=order.customer||{},payment=shipmentPayment(order);
    const payload={
      customer:clean(c.fullName,200),
      province_name:clean(c.province,120),
      county_name:clean(c.district,120),
      address:orderAddress(c),
      telephone:clean(c.phone,40),
      branch_code:config.branchCode,
      order_number:clean(options.orderNumber||order.id,120),
      summary:orderSummary(order),
      quantity:orderQuantity(order),
      consignment_type_id:2,
      amount_type_id:payment.amountTypeId
    };
    if(payment.amount!==null)payload.amount=payment.amount;
    return payload;
  }
  // Yalnız durum/arama GET isteklerini yavaşlat. Yeni kargo oluşturma POST isteği
  // otomatik durum sorgularının 429 beklemesine takılmamalıdır.
  const PROVIDER_GET_GAP_MS=3000,PROVIDER_RATE_LIMIT_PAUSE_MS=30*60*1000;
  let lastReadAt=0,readQueue=Promise.resolve(),rateLimitUntil=0,manualVerifyRetryAt=0;
  function rateLimitStatus(){return {active:Date.now()<rateLimitUntil,retryAfterMs:Math.max(0,rateLimitUntil-Date.now())}}
  function rateLimitedError(){const e=new Error('Yeşilkar hız sınırı nedeniyle kargo sorguları geçici olarak durduruldu. Lütfen daha sonra tekrar deneyin.');e.code='CARGO_RATE_LIMITED';e.httpStatus=429;e.retryAfterMs=rateLimitStatus().retryAfterMs;return e}
  function noteRateLimit(response){
    const raw=response?.headers?.get?.('retry-after');let duration=PROVIDER_RATE_LIMIT_PAUSE_MS;
    if(raw){const seconds=Number(raw),target=Number.isFinite(seconds)?Date.now()+seconds*1000:Date.parse(raw);if(Number.isFinite(target))duration=Math.max(duration,target-Date.now())}
    rateLimitUntil=Math.max(rateLimitUntil,Date.now()+Math.min(2*60*60*1000,duration));
  }
  function manualVerificationWaitError(){
    const minutes=Math.max(1,Math.ceil((manualVerifyRetryAt-Date.now())/60000));
    const e=new Error(`Yeşilkar'ın hız sınırı nedeniyle manuel kargo doğrulaması şu an tekrar denenemiyor. ${minutes} dakika sonra yeniden dene. Rabia'nın mevcut kargosu değişmedi.`);
    e.code='CARGO_MANUAL_RATE_LIMITED';e.httpStatus=429;e.retryAfterMs=Math.max(0,manualVerifyRetryAt-Date.now());return e;
  }
  async function requestJson(url,options={},control={}){
    if(typeof fetchImpl!=='function'){const e=new Error('Sunucuda fetch desteği bulunamadı.');e.code='CARGO_FETCH_UNAVAILABLE';throw e}
    const isRead=String(options.method||'GET').toUpperCase()==='GET',isManualVerification=isRead&&control.manualVerification===true;
    if(isRead&&!isManualVerification&&rateLimitStatus().active)throw rateLimitedError();
    if(isManualVerification&&Date.now()<manualVerifyRetryAt)throw manualVerificationWaitError();
    const send=async()=>{
      if(isRead&&!isManualVerification&&rateLimitStatus().active)throw rateLimitedError();
      const response=await fetchImpl(url,options),body=await response.text();let data={};
      try{data=body?JSON.parse(body):{}}catch{data={message:body}}
      if(response.status===429||/429\s*Too Many Requests|IP has been blocked due to too many requests/i.test(body)){
        noteRateLimit(response);
        if(isManualVerification){
          manualVerifyRetryAt=Date.now()+5*60*1000;
          const e=new Error('Yeşilkar manuel kargo sorgusunu da hız sınırı nedeniyle reddetti. Kargo bağlanmadı. En az 5 dakika sonra tekrar dene.');
          e.code='CARGO_MANUAL_PROVIDER_RATE_LIMITED';e.httpStatus=429;e.retryAfterMs=5*60*1000;throw e;
        }
        if(isRead)throw rateLimitedError();
        const e=new Error('Yeşilkar yeni kargo oluşturma isteğini hız sınırı nedeniyle reddetti. Gönderi oluşmadıysa daha sonra tekrar deneyin.');
        e.code='CARGO_CREATE_RATE_LIMITED';e.httpStatus=429;throw e;
      }
      if(!response.ok||responseHasError(data)){
        const message=clean(data?.message||data?.result||data?.error||`Kargo servisi HTTP ${response.status}`,500);
        const e=new Error(/<\/?[a-z][\s\S]*>/i.test(message)?`Yeşilkar servisi HTTP ${response.status} hatası döndürdü.`:message);
        e.code='CARGO_PROVIDER_ERROR';e.httpStatus=response.status;e.providerResponse=redactProviderResponse(data);throw e;
      }
      return redactProviderResponse(data);
    };
    if(!isRead)return send();
    const task=readQueue.then(async()=>{
      if(!isManualVerification&&rateLimitStatus().active)throw rateLimitedError();
      if(isManualVerification&&Date.now()<manualVerifyRetryAt)throw manualVerificationWaitError();
      const wait=PROVIDER_GET_GAP_MS-(Date.now()-lastReadAt);
      if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));
      if(!isManualVerification&&rateLimitStatus().active)throw rateLimitedError();
      if(isManualVerification&&Date.now()<manualVerifyRetryAt)throw manualVerificationWaitError();
      // Panelde bilinçli doğrulama sırasında otomatik sorgu beklemesini bir kez aş.
      // Ardışık tıklamalar Yeşilkar'ı tekrar sıkıştırmasın.
      if(isManualVerification&&rateLimitStatus().active)manualVerifyRetryAt=Date.now()+5*60*1000;
      lastReadAt=Date.now();return send();
    });
    readQueue=task.catch(()=>{});return task;
  }
  function resultFromProvider(data={}){
    let row=data?.data&&typeof data.data==='object'?data.data:data;
    if(Array.isArray(row))row=row[0]||{};
    if(row&&typeof row==='object'){
      const nested=row.result||row.results||row.rows||row.records||row.consignments;
      if(Array.isArray(nested))row=nested[0]||row;
      else if(nested&&typeof nested==='object'&&!('barcode' in row))row=nested;
    }
    return {
      barcode:clean(row?.barcode||row?.cargo_barcode||row?.barkod||row?.musteribarkod||row?.gonderino,160),
      trackingNumber:clean(row?.tracking_number||row?.trackingNumber||row?.tracking_no||row?.takip_no||row?.gonderino||row?.kurcikno,160),
      recordId:clean(row?.record_id||row?.recordId||row?.id||row?.kayitno,160),
      providerOrderNumber:providerOrderNumberFromRow(row),
      labelUrl:clean(row?.label_url||row?.labelUrl||row?.pdf_url||row?.pdfUrl,1000),
      providerStatus:clean(row?.statu_no||row?.status||row?.cargo_status||row?.status_name||row?.sonuc||row?.durum||'',160),
      providerMovementText:providerMovementTextFromRow(row),
      providerStatusAt:providerStatusAtFromRow(row),
      providerResponse:redactProviderResponse(data)
    };
  }
  async function createShipment({order,orderNumber}={}){
    const data=await requestJson(config.createUrl,{method:'POST',headers:providerHeaders({form:true}),body:formEncode(buildShipmentPayload(order,{orderNumber}))});
    return resultFromProvider(data);
  }
  function providerLookupBase(kind){
    const sources=[config.statusUrlTemplate,config.createUrl].filter(Boolean);
    for(const source of sources){
      try{
        const url=new URL(String(source).split('?')[0]);
        if(!/\/restapi\/client\//i.test(url.pathname))continue;
        url.pathname=kind==='cargo'?'/restapi/client/cargo':'/restapi/client/consignments';url.search='';url.hash='';return url;
      }catch{}
    }
    return null;
  }
  function providerNotFoundOrLookupUnsupported(error){const code=clean(error?.providerResponse?.code||error?.providerResponse?.hata,40);return code==='101'||code==='102'||error?.httpStatus===404}
  async function lookupShipmentByOrderNumber({orderNumber,currentStatus='created',order=null}={}){
    const wanted=clean(orderNumber,160);if(!wanted)return null;
    if(config.statusUrlTemplate&&config.statusUrlTemplate.includes('{order_number}')){
      const url=fillTemplate(config.statusUrlTemplate,{record_id:'',barcode:'',tracking_number:'',order_number:wanted});
      const data=await requestJson(url,{method:'GET',headers:providerHeaders()}),rows=providerRows(data),matched=rows.find(row=>providerRowMatchesOrder(row,{orderNumber:wanted,order}));
      const result=matched?resultFromProvider(matched):resultFromProvider(data);
      if(result.providerOrderNumber&&result.providerOrderNumber!==wanted)return null;
      if(result.barcode||result.trackingNumber||result.recordId)return {...result,status:providerStatusToCargoStatus(result.providerStatus,currentStatus)};
    }
    const cargoBase=providerLookupBase('cargo');
    if(cargoBase){
      const url=new URL(cargoBase);url.searchParams.set('sipno',wanted);
      try{
        const data=await requestJson(url.toString(),{method:'GET',headers:providerHeaders()}),rows=providerRows(data),matched=rows.find(row=>providerRowMatchesOrder(row,{orderNumber:wanted,order}));
        if(matched){const result=resultFromProvider(matched);return {...result,status:providerStatusToCargoStatus(result.providerStatus,currentStatus)}}
      }catch(error){if(!providerNotFoundOrLookupUnsupported(error))throw error}
      const digits=String(order?.customer?.phone||'').replace(/\D/g,'').slice(-10);
      const orderDate=new Date(order?.createdAt||'');
      if(digits&&Number.isFinite(orderDate.getTime())){
        const trDate=delta=>{const dt=new Date(orderDate.getTime()+delta*86400000);return `${String(dt.getUTCDate()).padStart(2,'0')}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${dt.getUTCFullYear()}`};
        const phoneUrl=new URL(cargoBase);phoneUrl.searchParams.set('telno',digits);phoneUrl.searchParams.set('alim_start',trDate(-1));phoneUrl.searchParams.set('alim_end',trDate(2));
        try{
          const data=await requestJson(phoneUrl.toString(),{method:'GET',headers:providerHeaders()}),rows=providerRows(data),matched=rows.find(row=>providerRowMatchesOrder(row,{orderNumber:wanted,order}));
          if(matched){const result=resultFromProvider(matched);return {...result,status:providerStatusToCargoStatus(result.providerStatus,currentStatus)}}
        }catch(error){if(!providerNotFoundOrLookupUnsupported(error))throw error}
      }
    }
    return null;
  }
  async function lookupShipmentByBarcode({barcode,currentStatus='created',orderNumber='',order=null}={}){
    const wantedBarcode=clean(barcode,160),wantedOrder=clean(orderNumber,160);if(!wantedBarcode)return null;
    const base=providerLookupBase('consignments');if(!base)return null;
    const url=new URL(base);url.searchParams.set('barcode',wantedBarcode);
    const data=await requestJson(url.toString(),{method:'GET',headers:providerHeaders()}),rows=providerRows(data),row=rows[0]||data,result=resultFromProvider(row);
    const returnedBarcode=clean(result.barcode||result.trackingNumber,160);if(returnedBarcode&&returnedBarcode!==wantedBarcode&&clean(row?.musteribarkod,160)!==wantedBarcode)return null;
    const providerOrder=providerOrderNumberFromRow(row)||result.providerOrderNumber;
    if(wantedOrder&&providerOrder&&providerOrder!==wantedOrder)return null;
    if(wantedOrder&&!providerOrder){
      const cargoBase=providerLookupBase('cargo');if(!cargoBase)return null;
      const cargoUrl=new URL(cargoBase);cargoUrl.searchParams.set('barkod',wantedBarcode);
      let cargoData;try{cargoData=await requestJson(cargoUrl.toString(),{method:'GET',headers:providerHeaders()})}catch(error){if(providerNotFoundOrLookupUnsupported(error))return null;throw error}
      const cargoRows=providerRows(cargoData),matched=cargoRows.find(x=>providerRowMatchesOrder(x,{orderNumber:wantedOrder,order}));if(!matched)return null;
    }
    return {...result,barcode:result.barcode||wantedBarcode,status:providerStatusToCargoStatus(result.providerStatus,currentStatus)};
  }
  // Kullanıcının site üzerinden değil, WebPostman panelinden oluşturduğu kabul edilmiş gönderi.
  // Yalnız var olan kargo kaydı okunur; burada yeni bir gönderi oluşturulmaz.
  function manualIdentity(value){return clean(value,240).replace(/ı/g,'i').replace(/İ/g,'I').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]/g,'')}
  async function lookupManualShipment({shipmentNumber,order}={}){
    const wanted=clean(shipmentNumber,24);
    if(!/^\d{10,20}$/.test(wanted)){const e=new Error('Yeşilkar gönderi numarası yalnız rakam içermeli.');e.code='CARGO_MANUAL_NUMBER_INVALID';throw e}
    const base=providerLookupBase('cargo');if(!base){const e=new Error('Yeşilkar gönderi durum sorgusu yapılandırılmamış.');e.code='CARGO_STATUS_NOT_CONFIGURED';throw e}
    const url=new URL(base);url.searchParams.set('gonderino',wanted);
    const data=await requestJson(url.toString(),{method:'GET',headers:providerHeaders()},{manualVerification:true});
    const sameNumber=row=>['gonderino','barkod','barkod_no','cikisno','musteribarkod','kurcikno'].some(k=>clean(row?.[k],50)===wanted);
    const row=providerRows(data).find(sameNumber);
    if(!row){const e=new Error('Bu numarayla eşleşen gerçek Yeşilkar kargo kaydı bulunamadı.');e.code='CARGO_MANUAL_NOT_FOUND';throw e}
    const c=order?.customer||{},expectedName=manualIdentity(c.fullName||[c.firstName,c.lastName].filter(Boolean).join(' ')),expectedCity=manualIdentity(c.province),expectedCounty=manualIdentity(c.district);
    const returnedName=manualIdentity([row.aliciadi||row.alici_adi||row.customer||row.alici_ad,row.alicisoyad||row.alici_soyad].filter(Boolean).join(' ')||row.alici_adi_soyadi||row.customer_name||row.recipient_name);
    const returnedCity=manualIdentity(row.sehiradi||row.alici_sehir||row.province_name||row.alici_il);
    const returnedCounty=manualIdentity(row.ilce||row.alici_ilce||row.county_name);
    // Bir manuel kaydın SHAZ sipariş numarası yoktur. Bu yüzden alıcı, il ve ilçe
    // doğrulanmadan yalnız barkod numarasına güvenip başka müşteriye bağlamıyoruz.
    if(!expectedName||!expectedCity||!expectedCounty||!returnedName||!returnedCity||!returnedCounty||returnedName!==expectedName||returnedCity!==expectedCity||returnedCounty!==expectedCounty){
      const e=new Error('Yeşilkar kaydındaki alıcı adı, il ve ilçe SHAZ siparişiyle doğrulanamadı. Bu kargo otomatik bağlanmadı.');e.code='CARGO_MANUAL_RECIPIENT_MISMATCH';throw e;
    }
    const digits=x=>String(x||'').replace(/\D/g,'').slice(-10),providerPhone=digits(row.telno||row.telephone||row.alici_telefon||row.phone),orderPhone=digits(c.phone);
    if(providerPhone&&orderPhone&&providerPhone!==orderPhone){const e=new Error('Yeşilkar kaydındaki telefon numarası SHAZ siparişiyle uyuşmuyor.');e.code='CARGO_MANUAL_RECIPIENT_MISMATCH';throw e}
    const result=resultFromProvider(row),status=providerStatusToCargoStatus(result.providerStatus,'created');
    return {...result,barcode:wanted,trackingNumber:wanted,recordId:'',providerOrderNumber:'',status,externalManual:true,providerResponse:redactProviderResponse(row)};
  }
  async function refreshShipment({shipment,order}={}){
    if(shipment?.externalManual)return lookupManualShipment({shipmentNumber:shipment.trackingNumber||shipment.barcode,order});
    if(!config.statusUrlTemplate){const e=new Error('YeşilKar durum sorgulama endpointi henüz tanımlanmadı.');e.code='CARGO_STATUS_NOT_CONFIGURED';throw e}
    const url=fillTemplate(config.statusUrlTemplate,{record_id:shipment?.providerRecordId||'',barcode:shipment?.barcode||'',tracking_number:shipment?.trackingNumber||'',order_number:shipment?.providerOrderNumber||shipment?.orderId||''});
    const data=await requestJson(url,{method:'GET',headers:providerHeaders()});const result=resultFromProvider(data);
    return {...result,status:providerStatusToCargoStatus(result.providerStatus,shipment?.status||'created')};
  }
  async function fetchLabel({shipment}={}){
    if(!config.labelUrlTemplate)return null;
    const url=fillTemplate(config.labelUrlTemplate,{record_id:shipment?.providerRecordId||'',barcode:shipment?.barcode||'',tracking_number:shipment?.trackingNumber||''});
    return requestJson(url,{method:'GET',headers:providerHeaders()});
  }
  return {config:configuration,rateLimitStatus,buildShipmentPayload,createShipment,lookupShipmentByOrderNumber,lookupShipmentByBarcode,lookupManualShipment,refreshShipment,fetchLabel,providerStatusToCargoStatus,providerMovementToWorkflowStage,resultFromProvider};
}

module.exports={CARGO_STATUSES,CARGO_STATUS_OPTIONS,createCargoService,providerStatusToCargoStatus,providerMovementToWorkflowStage,redactProviderResponse};
