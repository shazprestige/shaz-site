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
function orderQuantity(order={}){return (Array.isArray(order.items)?order.items:[]).reduce((n,x)=>n+Math.max(1,Number(x?.qty||1)),0)||1}
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
  function buildShipmentPayload(order={}){
    const c=order.customer||{},payment=shipmentPayment(order);
    const payload={
      customer:clean(c.fullName,200),
      province_name:clean(c.province,120),
      county_name:clean(c.district,120),
      address:orderAddress(c),
      telephone:clean(c.phone,40),
      branch_code:config.branchCode,
      order_number:clean(order.id,120),
      summary:orderSummary(order),
      quantity:orderQuantity(order),
      consignment_type_id:1,
      amount_type_id:payment.amountTypeId
    };
    if(payment.amount!==null)payload.amount=payment.amount;
    return payload;
  }
  async function requestJson(url,options){
    if(typeof fetchImpl!=='function'){const e=new Error('Sunucuda fetch desteği bulunamadı.');e.code='CARGO_FETCH_UNAVAILABLE';throw e}
    const response=await fetchImpl(url,options),text=await response.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={message:text}}
    if(!response.ok||responseHasError(data)){const e=new Error(clean(data?.message||data?.result||data?.error||`Kargo servisi HTTP ${response.status}`,500));e.code='CARGO_PROVIDER_ERROR';e.httpStatus=response.status;e.providerResponse=redactProviderResponse(data);throw e}
    return redactProviderResponse(data);
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
      labelUrl:clean(row?.label_url||row?.labelUrl||row?.pdf_url||row?.pdfUrl,1000),
      providerStatus:clean(row?.statu_no||row?.status||row?.cargo_status||row?.status_name||row?.sonuc||row?.durum||'',160),
      providerResponse:redactProviderResponse(data)
    };
  }
  async function createShipment({order}={}){
    const data=await requestJson(config.createUrl,{method:'POST',headers:providerHeaders({form:true}),body:formEncode(buildShipmentPayload(order))});
    return resultFromProvider(data);
  }
  async function refreshShipment({shipment}={}){
    if(!config.statusUrlTemplate){const e=new Error('YeşilKar durum sorgulama endpointi henüz tanımlanmadı.');e.code='CARGO_STATUS_NOT_CONFIGURED';throw e}
    const url=fillTemplate(config.statusUrlTemplate,{record_id:shipment?.providerRecordId||'',barcode:shipment?.barcode||'',tracking_number:shipment?.trackingNumber||''});
    const data=await requestJson(url,{method:'GET',headers:providerHeaders()});const result=resultFromProvider(data);
    return {...result,status:providerStatusToCargoStatus(result.providerStatus,shipment?.status||'created')};
  }
  async function fetchLabel({shipment}={}){
    if(!config.labelUrlTemplate)return null;
    const url=fillTemplate(config.labelUrlTemplate,{record_id:shipment?.providerRecordId||'',barcode:shipment?.barcode||'',tracking_number:shipment?.trackingNumber||''});
    return requestJson(url,{method:'GET',headers:providerHeaders()});
  }
  return {config:configuration,buildShipmentPayload,createShipment,refreshShipment,fetchLabel,providerStatusToCargoStatus};
}

module.exports={CARGO_STATUSES,CARGO_STATUS_OPTIONS,createCargoService,providerStatusToCargoStatus,redactProviderResponse};
