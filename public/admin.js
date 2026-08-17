
let settings={},catalog={};
let adminOpenCategory=sessionStorage.getItem('shazAdminCategory')||null,adminProductSearch="",adminOpenProduct=null;
let adminDraggedCategory=null;
let adminDraggedProduct=null;
let adminBuilderPricingCategory="";
let adminBuilderPricingProduct="";
let adminOpenCampaignId=sessionStorage.getItem('shazAdminOpenCampaign')||'';
let setBulkDraft={};
let currentPreviewTarget=null;
let previewFocusToken=0;
function preserveAdminViewport(fn){
  const x=window.scrollX,y=window.scrollY;
  fn();
  requestAnimationFrame(()=>window.scrollTo(x,y));
}
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const attr=s=>String(s??'').replace(/"/g,'&quot;');

document.addEventListener('focusin',e=>{
  const el=e.target.closest?.('[data-preview-target]');
  const target=el?.dataset?.previewTarget;
  if(target)previewTo(target,true);
});
let adminPreviewSyncTimer=null;
function scheduleAdminPreviewSync(){clearTimeout(adminPreviewSyncTimer);adminPreviewSyncTimer=setTimeout(()=>sendPreview(),25)}
document.addEventListener('change',scheduleAdminPreviewSync);
document.addEventListener('click',e=>{if(e.target.closest('button,input,select,label,summary'))scheduleAdminPreviewSync()});

async function logoutAdmin(){
  await fetch('/api/admin/logout',{method:'POST'});
  location.href='/admin/login';
}
async function load(){
  settings=await fetch('/api/settings').then(r=>r.json());
  catalog=await fetch('/api/catalog').then(r=>r.json());
  catalog.walletPhotoFee=Number(catalog.walletPhotoFee??25);
  catalog.checkoutCampaigns=Array.isArray(catalog.checkoutCampaigns)?catalog.checkoutCampaigns:[];
  catalog.checkoutUpsells=Array.isArray(catalog.checkoutUpsells)?catalog.checkoutUpsells:[];
  catalog.builder=(catalog.builder&&typeof catalog.builder==='object')?catalog.builder:{};
  if(catalog.builder.enabled===undefined)catalog.builder.enabled=false;
  (catalog.products||[]).forEach(p=>{
    if(adminIsWalletProduct(p)&&p.walletPhotoEnabled===undefined)p.walletPhotoEnabled=true;
    if(p.soldOutEnabled===undefined)p.soldOutEnabled=false;
    if(p.soldOutUntil===undefined)p.soldOutUntil='';
    if(p.writeEnabled===undefined){
      const n=adminNormalizedTR(adminCategoryName(p)+' '+(p?.name||''));
      p.writeEnabled=!(n.includes('tesb')||n.includes('tesp'));
    }
  });
  settings.campaignCards=settings.campaignCards||[];
  settings.siteAnnouncement=settings.siteAnnouncement||{enabled:false,eyebrow:'DUYURU',title:'',text:'',buttonText:'Kapat'};
  settings.campaignCards.forEach((c,i)=>{
    if(c.enabled===undefined)c.enabled=true;
    if(!c.id)c.id='kampanya-'+Date.now()+'-'+i;
    if(!c.targetCategory)c.targetCategory='tum';
    if(!c.buttonText)c.buttonText='ÜRÜNLERİ GÖR';
  });
  // V45: üst kayan yazı artık slayta değil sliderın tamamına bağlı tek ayardır.
  if(settings.campaignMarqueeText===undefined){
    settings.campaignMarqueeText=(settings.campaignCards.find(c=>c.marqueeText)?.marqueeText)||'';
  }
  if(!['full','center','middle'].includes(settings.campaignMarqueePosition))settings.campaignMarqueePosition='full';
  settings.theme=settings.theme||{};
  settings.paymentMethods=(settings.paymentMethods&&typeof settings.paymentMethods==='object')?settings.paymentMethods:{};
  if(settings.paymentMethods.cod===undefined)settings.paymentMethods.cod=true;
  if(settings.paymentMethods.online===undefined)settings.paymentMethods.online=true;
  const savedTab=sessionStorage.getItem('shazAdminTab')||'site';
  show(['site','catalog','custom','discounts','upsells','orders','builderAccess','soldout'].includes(savedTab)?savedTab:'site');
  setTimeout(()=>{sendPreview();previewTo('header')},600);
}
async function saveAll(){
  syncVisibleProductFeatures();
  const r=await fetch('/api/admin/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings,catalog})}).then(r=>r.json());
  if(!r.ok)return alert(r.message||'Kaydedilemedi.');
  sendPreview();
  alert(r.github?.ok?'Kaydedildi ve GitHub’a kalıcı olarak işlendi.':'Kaydedildi. GitHub kalıcı kayıt henüz bağlı değil.');
}
function sendPreview(){
  const f=$('#previewFrame');
  if(f?.contentWindow)f.contentWindow.postMessage({type:'shaz-preview',settings,catalog},'*');
}
function previewTo(target,scroll=true){
  currentPreviewTarget=target||currentPreviewTarget;
  const f=$('#previewFrame');
  if(!f?.contentWindow||!currentPreviewTarget)return;
  const token=++previewFocusToken;
  // Önce güncel veriyi gönder; render bittikten sonra kesin hedefi işaretle.
  f.contentWindow.postMessage({type:'shaz-preview',settings,catalog},'*');
  setTimeout(()=>{
    if(token!==previewFocusToken)return;
    f.contentWindow.postMessage({type:'shaz-preview-focus',target:currentPreviewTarget,scroll},'*');
  },80);
}
function changed(target){
  if(target)currentPreviewTarget=target;
  preserveAdminViewport(()=>{
    const f=$('#previewFrame');
    if(!f?.contentWindow)return;
    f.contentWindow.postMessage({type:'shaz-preview',settings,catalog},'*');
    // Yazı yazarken scroll yok. Render sonrası yalnızca aynı küçük alanı tekrar çerçevele.
    setTimeout(()=>f.contentWindow.postMessage({type:'shaz-preview-focus',target:currentPreviewTarget,scroll:false},'*'),60);
  });
}
function previewSetStage(setId,itemId,stage='remove',scroll=true){
  const f=$('#previewFrame');
  if(!f?.contentWindow||!setId)return;
  const token=++previewFocusToken;
  f.contentWindow.postMessage({type:'shaz-preview',settings,catalog},'*');
  setTimeout(()=>{
    if(token!==previewFocusToken)return;
    f.contentWindow.postMessage({type:'shaz-preview-set-stage',setId,itemId,stage,scroll},'*');
  },80);
}
function changedSetStage(setId,itemId,stage='remove'){
  preserveAdminViewport(()=>previewSetStage(setId,itemId,stage,false));
}
function shell(title,desc,html){
  $('#view').innerHTML=`<h1>${title}</h1><div class=sectionTip>${desc}</div>${html}<div class=saveBar><button class=btn onclick=saveAll()>Değişiklikleri Kaydet</button></div>`;
}
function input(label,key,val,help,target='header',type='text'){
  return `<div class=field><label><b>${label}</b></label><input class=formControl data-preview-target="${attr(target)}" type="${type}" value="${attr(val)}" oninput="${key}=this.type==='number'?Number(this.value):this.value;changed(this.dataset.previewTarget)"><div class=help>${help}</div></div>`;
}
function textarea(label,key,val,help,target){
  return `<div class=field><label><b>${label}</b></label><textarea class=formControl data-preview-target="${attr(target)}" rows=4 oninput="${key}=this.value;changed(this.dataset.previewTarget)">${esc(val)}</textarea><div class=help>${help}</div></div>`;
}
function preferredPositionOptions(positions,selected=''){
  const vals=[...new Set((positions||[]).filter(Boolean))];
  return `<option value="">Tercih işareti yok</option>`+vals.map(x=>`<option value="${attr(x)}" ${String(selected||'')===String(x)?'selected':''}>${esc(x)}</option>`).join('');
}

function adminNormalizedTR(v){return String(v||'').toLocaleLowerCase('tr-TR')}
function adminCategoryName(p){return (catalog.categories||[]).find(c=>c.id===p?.category)?.name||p?.category||''}
function adminIsWalletProduct(p){return adminNormalizedTR(adminCategoryName(p)+' '+(p?.name||'')).includes('cüzdan')}
function adminIsWalletSetItem(it){
  const linked=it?.productId?(catalog.products||[]).find(p=>p.id===it.productId):null;
  return adminNormalizedTR((it?.type||'')+' '+(it?.name||'')+' '+adminCategoryName(linked)+' '+(linked?.name||'')).includes('cüzdan');
}
function adminSetItemWriteEnabled(it){
  const linked=it?.productId?(catalog.products||[]).find(p=>p.id===it.productId):null;
  return it?.writeEnabled!==false && linked?.writeEnabled!==false;
}
function previewProductStage(productId,stage='write'){
  const f=$('#previewFrame'); if(!f?.contentWindow)return;
  sendPreview();
  setTimeout(()=>f.contentWindow.postMessage({type:'shaz-preview-product-stage',productId,stage},'*'),70);
}
function syncPreferredSelect(input,selectId,productIndex){
  const sel=document.getElementById(selectId); if(!sel)return;
  const current=catalog.products[productIndex].preferredWritePosition||'';
  sel.innerHTML=preferredPositionOptions(catalog.products[productIndex].writePositions||[],current);
  if(current && !(catalog.products[productIndex].writePositions||[]).includes(current)){
    catalog.products[productIndex].preferredWritePosition=''; sel.value='';
  }
}
function syncSetPreferredSelect(selectId,productIndex,itemIndex){
  const sel=document.getElementById(selectId); if(!sel)return;
  const item=catalog.products?.[productIndex]?.setItems?.[itemIndex]; if(!item)return;
  const current=item.preferredWritePosition||'';
  const positions=item.writePositions||[];
  sel.innerHTML=preferredPositionOptions(positions,current);
  if(current && !positions.includes(current)){item.preferredWritePosition='';sel.value='';}
}

function show(tab){
  try{sessionStorage.setItem('shazAdminTab',tab)}catch(_){}
  const adminRoot=document.querySelector('.simpleAdmin');
  const preview=document.querySelector('.previewPane');
  const isOrders=tab==='orders';
  if(preview) preview.style.display=isOrders?'none':'block';
  if(adminRoot) adminRoot.classList.toggle('ordersMode',isOrders);

  if(tab==='site')return renderSite();
  if(tab==='catalog')return renderCatalog();
  if(tab==='custom')return renderCatalog();
  if(tab==='discounts')return renderDiscountCampaigns();
  if(tab==='upsells')return renderUpsells();
  if(tab==='builderAccess')return renderBuilderAccessSettings();
  if(tab==='soldout')return renderSoldOutPanel();
  if(tab==='orders')return renderOrders();
}

function adminSoldOutRemainingText(p){
  const raw=String(p?.soldOutUntil||'').trim();
  if(!raw)return 'Süre belirtilmedi';
  const t=Date.parse(raw);if(!Number.isFinite(t))return raw;
  const d=t-Date.now();if(d<=0)return 'Süre doldu';
  const days=Math.floor(d/86400000),hrs=Math.floor((d%86400000)/3600000),mins=Math.floor((d%3600000)/60000),secs=Math.floor((d%60000)/1000);
  return `${days?days+' gün ':''}${hrs} saat ${mins} dk ${secs} sn`;
}
function localDateTimeValue(ms){const d=new Date(ms),pad=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;}
function setSoldOutUntil(productId,value){const p=(catalog.products||[]).find(x=>x.id===productId);if(!p)return;p.soldOutEnabled=true;p.soldOutUntil=value||'';changed('#products');renderSoldOutPanel();}
function addSoldOutDays(productId,days){const p=(catalog.products||[]).find(x=>x.id===productId);if(!p)return;const parsed=Date.parse(String(p.soldOutUntil||''));const base=Number.isFinite(parsed)&&parsed>Date.now()?parsed:Date.now();p.soldOutEnabled=true;p.soldOutUntil=localDateTimeValue(base+(Number(days)||0)*86400000);changed('#products');renderSoldOutPanel();}
function openSoldOutProduct(productId){
  const p=(catalog.products||[]).find(x=>x.id===productId);if(!p)return;
  const validCategory=(catalog.categories||[]).some(c=>c.id===p.category)?p.category:'tum';
  adminOpenCategory=validCategory;adminOpenProduct=p.id;adminProductSearch='';
  try{sessionStorage.setItem('shazAdminCategory',validCategory);sessionStorage.setItem('shazAdminTab','catalog')}catch(_){}
  show('catalog');
  const focus=()=>{
    const el=document.getElementById('admin-product-'+p.id);
    if(el){el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.add('soldOutOpenedProduct');setTimeout(()=>el.classList.remove('soldOutOpenedProduct'),1400);}
  };
  requestAnimationFrame(()=>requestAnimationFrame(focus));
  setTimeout(focus,180);
}
function openSoldOutImage(productId){openAdminProductImage(productId)}
function toggleSoldOutDateEditor(productId){
  const row=document.querySelector(`[data-soldout-admin-id="${CSS.escape(String(productId))}"]`);if(!row)return;
  const editor=row.querySelector('.soldOutPanelControls');if(!editor)return;
  const willOpen=editor.hidden;document.querySelectorAll('.soldOutPanelControls').forEach(x=>x.hidden=true);editor.hidden=!willOpen;
  if(willOpen){const input=editor.querySelector('input[type="datetime-local"]');setTimeout(()=>{try{input?.showPicker?.()}catch(_){input?.focus()}},20);}
}
function soldOutRowClick(e,productId){
  if(e.target.closest('button,input,select,label,a'))return;
  openSoldOutProduct(productId);
}
function renderSoldOutPanel(){
  const products=(catalog.products||[]).filter(p=>p.soldOutEnabled);
  const rows=products.map(p=>{
    const img=p.image||productImages(p)[0]||'',cat=adminCategoryName(p)||'Kategori yok';
    return `<div class="soldOutPanelRow" data-soldout-admin-id="${attr(p.id)}" onclick="soldOutRowClick(event,'${attr(p.id)}')" title="Ürünün yönetim ekranını aç">
      <div class="soldOutPanelProduct">${img?`<img src="${attr(img)}" alt="${attr(p.name||'Ürün')}">`:''}<div><b>${esc(p.name||'Ürün')}</b><small>${esc(cat)}</small></div></div>
      <div class="soldOutPanelCountdown"><b>${esc(adminSoldOutRemainingText(p))}</b><small>${p.soldOutUntil?esc(String(p.soldOutUntil).replace('T',' ')):'Yeniden stok zamanı girilmemiş.'}</small></div>
      <div class="soldOutPanelControls" hidden><input data-soldout-date-id="${attr(p.id)}" class=formControl type=datetime-local value="${attr(p.soldOutUntil||'')}" onchange="setSoldOutUntil('${attr(p.id)}',this.value)"><div class=soldOutDayButtons><button type=button class=smallBtn onclick="addSoldOutDays('${attr(p.id)}',1)">+1 gün</button><button type=button class=smallBtn onclick="addSoldOutDays('${attr(p.id)}',5)">+5 gün</button></div></div>
      <div class=soldOutPanelActions>
        <button type=button class=smallBtn onclick="toggleSoldOutDateEditor('${attr(p.id)}')">Tarih Ayarla</button>
        <button type=button class=smallBtn onclick="openSoldOutImage('${attr(p.id)}')">Büyüt</button>
        <button type=button class=smallBtn onclick="openSoldOutProduct('${attr(p.id)}')">Ürünü Aç</button>
      </div>
    </div>`
  }).join('');
  shell('Tükendi / Süreli Ürünler','“Tükendi” işareti açık ürünleri, kalan sürelerini ve yeniden stok tarihlerini tek yerde yönetirsin.',`<div class="panel soldOutPanel"><div class=soldOutPanelHead><b>${products.length} ürün işaretli</b><span>Satıra tıklayarak ürünü açabilir; Tarih, +1 gün ve +5 gün ile yeniden stok zamanını yönetebilirsin.</span></div><div class=soldOutPanelList>${rows||'<div class=emptyAdmin>Şu anda “Tükendi” işaretli ürün yok.</div>'}</div></div>`);
  clearInterval(window.__soldOutAdminTimer);window.__soldOutAdminTimer=setInterval(()=>{document.querySelectorAll('[data-soldout-admin-id]').forEach(row=>{const p=(catalog.products||[]).find(x=>x.id===row.dataset.soldoutAdminId),b=row.querySelector('.soldOutPanelCountdown b');if(p&&b)b.textContent=adminSoldOutRemainingText(p)})},1000);
}
function renderBuilderAccessSettings(){
  catalog.builder=(catalog.builder&&typeof catalog.builder==='object')?catalog.builder:{};
  if(catalog.builder.enabled===undefined)catalog.builder.enabled=false;
  settings.paymentMethods=(settings.paymentMethods&&typeof settings.paymentMethods==='object')?settings.paymentMethods:{};
  if(settings.paymentMethods.cod===undefined)settings.paymentMethods.cod=true;
  if(settings.paymentMethods.online===undefined)settings.paymentMethods.online=true;
  const enabled=catalog.builder.enabled!==false;
  const codEnabled=settings.paymentMethods.cod!==false;
  const onlineEnabled=settings.paymentMethods.online!==false;
  const previewTarget='#builderSpotlight';
  shell('Açma / Kapama','Müşteriye açık olacak ana özellikleri ve ödeme yöntemlerini tek yerden açıp kapatabilirsin.',`
    <div class="panel builderAccessAdmin">
      <label class=setItemToggle data-preview-target="${previewTarget}">
        <span><b>Kendi Setini Oluştur</b><small class=muted>Açıkken mevcut set oluşturma akışı çalışır. Kapalıyken müşteriye geçici bilgilendirme ekranı gösterilir.</small></span>
        <input type=checkbox ${enabled?'checked':''} onchange="catalog.builder.enabled=this.checked;changed('${previewTarget}');renderBuilderAccessSettings()">
      </label>
      <label class=setItemToggle data-preview-target=".checkoutPaymentField">
        <span><b>Kapıda ödeme</b><small class=muted>Kapalıysa müşteri ödeme yöntemi olarak Kapıda ödeme seçeneğini göremez.</small></span>
        <input type=checkbox ${codEnabled?'checked':''} onchange="settings.paymentMethods.cod=this.checked;changed('.checkoutPaymentField');renderBuilderAccessSettings()">
      </label>
      <label class=setItemToggle data-preview-target=".checkoutPaymentField">
        <span><b>Online ödeme</b><small class=muted>Kapalıysa müşteri ödeme yöntemi olarak Online ödeme seçeneğini göremez.</small></span>
        <input type=checkbox ${onlineEnabled?'checked':''} onchange="settings.paymentMethods.online=this.checked;changed('.checkoutPaymentField');renderBuilderAccessSettings()">
      </label>
      <div class="builderAccessStatus ${enabled?'isOpen':'isClosed'}">
        <b>Kendi Setini Oluştur: ${enabled?'Açık':'Kapalı'}</b>
        <span>Kapıda ödeme: <b>${codEnabled?'Açık':'Kapalı'}</b> · Online ödeme: <b>${onlineEnabled?'Açık':'Kapalı'}</b></span>
      </div>
      ${!enabled?`<div class=builderAccessPreview><span class=gold>ÇOK YAKINDA</span><h3>Kendi setinizi dilediğiniz gibi oluşturabileceksiniz.</h3><p>Çok yakında burası hizmetinizde olacak. Anlayışınız için teşekkür eder, keyifli alışverişler dileriz. ☺️</p><button type=button class=btn disabled>Alışverişe Devam Et</button></div>`:''}
    </div>`);
  requestAnimationFrame(()=>previewTo(previewTarget,true));
}

function campaignCategoryOptions(selected='tum'){
  const seen=new Set();
  const cats=[{id:'tum',name:'Tüm Ürünler'},...(catalog.categories||[]).filter(c=>!c.hidden&&c.id!=='tum')];
  return cats.filter(c=>c?.id&&!seen.has(c.id)&&seen.add(c.id)).map(c=>`<option value="${attr(c.id)}" ${String(selected||'tum')===String(c.id)?'selected':''}>${esc(c.name||c.id)}</option>`).join('');
}
function campaignTextPositionOptions(selected=''){
  const opts=[
    ['', 'Mevcut konum'],
    ['top','En üst'],
    ['uppermid','Üst ile orta arası'],
    ['middle','Tam orta'],
    ['lowermid','Orta ile alt arası'],
    ['bottom','En alt']
  ];
  return opts.map(([v,n])=>`<option value="${v}" ${String(selected||'')===v?'selected':''}>${n}</option>`).join('');
}
function renderSite(){
  const cards=(settings.campaignCards||[]).sort((a,b)=>(a.order||0)-(b.order||0));
  const campaigns=cards.map((c,i)=>{
    const slideTarget=`[data-campaign-id="${c.id}"]`;
    const contentTarget=`${slideTarget} .campaignContent`;
    const buttonTarget=`${slideTarget} .campaignBtn`;
    return `
    <div class="campaignAdmin campaignSlideAdmin">
      <div class=campaignAdminHead>
        <div><b>Slayt ${i+1}</b><div class=help>${c.imageUrl?'Fotoğraf hazır':'Henüz fotoğraf yok'}</div></div>
        <div class=campaignAdminActions>
          <button class=smallBtn ${i===0?'disabled':''} onclick="moveCampaign(${i},-1)">↑</button>
          <button class=smallBtn ${i===cards.length-1?'disabled':''} onclick="moveCampaign(${i},1)">↓</button>
          <button class=dangerBtn onclick="removeCampaign(${i})">Sil</button>
        </div>
      </div>
      ${c.imageUrl?`<img class=campaignAdminPreview src="${attr(c.imageUrl)}" alt="Slayt ${i+1}">`:''}
      <div class=campaignSimpleRow>
        <label class=campaignShowToggle><input data-preview-target='${attr(slideTarget)}' type=checkbox ${c.enabled!==false?'checked':''} onchange="settings.campaignCards[${i}].enabled=this.checked;changed(this.dataset.previewTarget)"> Sitede göster</label>
        <div class=campaignFileRow><input id="campFile${i}" type=file accept="image/*"><button class=smallBtn onclick="uploadCampaign(${i})">Fotoğrafı Değiştir</button></div>
      </div>
      <div class=grid2>
        ${input('Başlık',`settings.campaignCards[${i}].title`,c.title||'','Fotoğrafın üzerindeki büyük yazı.',contentTarget)}
        ${input('Kısa açıklama',`settings.campaignCards[${i}].subtitle`,c.subtitle||'','Başlığın altındaki kısa yazı.',contentTarget)}
        <div class=field><label><b>Başlık konumu</b></label><select class=formControl data-preview-target='${attr(contentTarget)}' onchange="settings.campaignCards[${i}].titlePosition=this.value;changed(this.dataset.previewTarget)">${campaignTextPositionOptions(c.titlePosition||'')}</select><div class=help>En üst, üst-orta arası, tam orta, orta-alt arası veya en alt konumlarından birini seçebilirsin.</div></div>
        <div class=field><label><b>Kısa açıklama konumu</b></label><select class=formControl data-preview-target='${attr(contentTarget)}' onchange="settings.campaignCards[${i}].subtitlePosition=this.value;changed(this.dataset.previewTarget)">${campaignTextPositionOptions(c.subtitlePosition||'')}</select><div class=help>Kısa açıklamayı başlıktan bağımsız olarak farklı bir yüksekliğe taşıyabilirsin.</div></div>
        ${input('Başlık yazı boyutu (px)',`settings.campaignCards[${i}].titleFontSize`,c.titleFontSize||'','Boş/0 bırakırsan mevcut otomatik boyut kullanılır.',contentTarget,'number')}
        ${input('Kısa açıklama yazı boyutu (px)',`settings.campaignCards[${i}].subtitleFontSize`,c.subtitleFontSize||'','Boş/0 bırakırsan mevcut otomatik boyut kullanılır.',contentTarget,'number')}
        ${input('Buton yazısı',`settings.campaignCards[${i}].buttonText`,c.buttonText||'ÜRÜNLERİ GÖR','Örn: Ürünleri Gör, Keşfet, Setlere Bak.',buttonTarget)}
        <div class=field><label><b>Buton nereye gitsin?</b></label><select class=formControl data-preview-target='${attr(buttonTarget)}' onchange="settings.campaignCards[${i}].targetCategory=this.value;changed(this.dataset.previewTarget)">${campaignCategoryOptions(c.targetCategory||'tum')}</select><div class=help>Sadece sitendeki kategorilerden seç. Müşteri butona basınca o kategori açılır.</div></div>
      </div>
    </div>`;
  }).join('');
  shell('Site Ayarları','Sık kullandığın ayarlar burada. Slider bölümü özellikle sade tutuldu.',
  `<div class=panel><h2>Üst Alan</h2>
    ${input('En üstte akan yazı','settings.campaignText',settings.campaignText||'','Siyah ince şeritte akan metin.','.announce')}
    ${input('Ana başlık','settings.heroTitle',settings.heroTitle||'','Slider alanının altındaki ana başlık.','.hero h1')}
    ${input('Slogan','settings.heroSubtitle',settings.heroSubtitle||'','Ana başlığın altındaki slogan.','.hero p')}
    ${input('WhatsApp numarası','settings.whatsapp',settings.whatsapp||'','Yeşil iletişim butonu.','.contactBtn.wa')}
    ${input('Instagram kullanıcı adı','settings.instagram',settings.instagram||'','Siyah iletişim butonu.','.contactBtn.ig')}
    ${input('Kargom Nerede bağlantısı','settings.cargoTrackingUrl',settings.cargoTrackingUrl||'https://ebranch.araskargo.com.tr/','Üstteki paket ikonunun açacağı resmi Aras Kargo sayfası.','.cargoAction')}
  </div>
  <details class="panel simpleAdminDetails announcementAdmin"><summary>Duyuru Panosu <small>Siteye girince müşterinin önüne çıkar</small></summary><div class="simpleDetailsBody">
    <label class=setItemToggle data-preview-target=".siteAnnouncement"><span><b>Duyuruyu göster</b><small class=muted>Kapalıysa müşterinin karşısına çıkmaz.</small></span><input type=checkbox ${settings.siteAnnouncement?.enabled?'checked':''} onchange="settings.siteAnnouncement.enabled=this.checked;changed('.siteAnnouncement')"></label>
    <div class=grid2>
      ${input('Üst küçük başlık','settings.siteAnnouncement.eyebrow',settings.siteAnnouncement?.eyebrow||'DUYURU','Örn: KAMPANYA, BUGÜNE ÖZEL.','.siteAnnouncement')}
      ${input('Ana duyuru başlığı','settings.siteAnnouncement.title',settings.siteAnnouncement?.title||'','Müşterinin ilk gördüğü büyük başlık.','.siteAnnouncement')}
    </div>
    ${textarea('Duyuru metni','settings.siteAnnouncement.text',settings.siteAnnouncement?.text||'','Kampanya veya bilgilendirme metnini buraya yaz.','.siteAnnouncement')}
    ${input('Kapat butonu yazısı','settings.siteAnnouncement.buttonText',settings.siteAnnouncement?.buttonText||'Kapat','Örn: Kapat, Alışverişe Devam Et.','.siteAnnouncementButton')}
    <div class=help><b>Müşteride nerede görünür?</b> Site ilk açıldığında ekranın ortasında çıkar. Müşteri kapattıktan sonra sitede normal şekilde devam eder.</div>
  </div></details>
  <div class="panel grid2"><h2 style="grid-column:1/-1">Renkler</h2>
    ${input('Site arka planı','settings.theme.surface',settings.theme.surface||'#ffffff','Tüm sitenin ana zemin rengi.','body','color')}
    ${input('Altın vurgu','settings.theme.accent',settings.theme.accent||'#c39a59','Başlık ve küçük vurgu alanları.','.hero','color')}
  </div>
  <div class="panel campaignSliderAdminIntro">
    <div><h2>Ana Fotoğraf Sliderı</h2><div class=help>Fotoğraflar otomatik olarak <b>3 saniyede bir</b> değişir. En fazla <b>10 fotoğrafı</b> aynı anda ekleyebilirsin.</div></div>
    <div class=campaignBulkUpload><input id=campaignBulkFiles type=file accept="image/*" multiple><button class=btn onclick=uploadCampaignBulk()>Seçtiğim Fotoğrafları Slayt Olarak Ekle</button></div>
    <div class=campaignGlobalSettings>
      ${input('Slider üst kayan yazı','settings.campaignMarqueeText',settings.campaignMarqueeText||'','Bu tek yazı bütün fotoğraflarda aynı kalır; fotoğraf değişse de kendi halinde akmaya devam eder.','.campaignGlobalMarquee')}
      <div class=field><label><b>Kayan yazı konumu</b></label><select class=formControl data-preview-target=".campaignGlobalMarquee" onchange="settings.campaignMarqueePosition=this.value;changed(this.dataset.previewTarget)"><option value="full" ${!['center','middle'].includes(settings.campaignMarqueePosition)?'selected':''}>Üstte tam şerit</option><option value="center" ${settings.campaignMarqueePosition==='center'?'selected':''}>Üst ortada</option><option value="middle" ${settings.campaignMarqueePosition==='middle'?'selected':''}>Tam ortada</option></select><div class=help>“Tam ortada” seçersen kayan yazı reklam görselinin orta hizasında akar.</div></div>
    </div>
    <div class=help>Her slaytta sadece fotoğraf, başlık, kısa açıklama ve buton hedefi var. Kayan yazı tek ayardır.</div>
  </div>
  ${campaigns||'<div class=panel><b>Henüz slider fotoğrafı yok.</b><div class=help>Yukarıdan fotoğraf seçip ekle.</div></div>'}
  <div class=panel><h2>Sipariş Sonu Yazıları</h2>
    ${textarea('Kişiye özel ürün onay metni','settings.personalizedNotice',settings.personalizedNotice||'','Yazılı kapıda ödeme siparişinde çıkar.','.drawer')}
    ${textarea('Kargo bilgilendirme metni','settings.shippingNotice',settings.shippingNotice||'','Sipariş oluşturulmadan hemen önce çıkar.','.drawer')}
    ${input('Sipariş tamamlandı başlığı','settings.successTitle',settings.successTitle||'','Son ekrandaki başlık.','.drawer')}
    ${input('Sipariş teşekkür yazısı','settings.successMessage',settings.successMessage||'','Son ekrandaki mesaj.','.drawer')}
  </div>`);
}
function addCampaign(imageUrl=''){
  settings.campaignCards=settings.campaignCards||[];
  settings.campaignCards.push({id:'kampanya-'+Date.now()+'-'+Math.random().toString(36).slice(2,6),enabled:true,order:settings.campaignCards.length+1,imageUrl,title:'Yeni ürünlerimizi keşfedin.',subtitle:'Yeni koleksiyona göz atın.',buttonText:'ÜRÜNLERİ GÖR',targetCategory:'tum',overlayOpacity:28});
  changed('#campaignCards');renderSite();
}
function moveCampaign(i,dir){
  const list=settings.campaignCards||[]; const j=i+dir;
  if(j<0||j>=list.length)return;
  [list[i],list[j]]=[list[j],list[i]];
  list.forEach((c,n)=>c.order=n+1);
  changed('#campaignCards');renderSite();
}
function removeCampaign(i){if(confirm('Bu slayt silinsin mi?')){settings.campaignCards.splice(i,1);settings.campaignCards.forEach((c,n)=>c.order=n+1);changed('#campaignCards');renderSite()}}
async function saveCampaignStateQuick(){
  const r=await fetch('/api/admin/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings,catalog})}).then(r=>r.json());
  if(!r.ok)throw new Error(r.message||'Kaydedilemedi');
  return r;
}
async function uploadCampaign(i){
  const f=$('#campFile'+i)?.files?.[0];if(!f)return alert('Fotoğraf seç.');
  const fd=new FormData();fd.append('files',f);
  const r=await fetch('/api/upload',{method:'POST',body:fd}).then(r=>r.json());
  if(!r.ok||!r.files?.[0])return alert(r.message||'Fotoğraf yüklenemedi.');
  settings.campaignCards[i].imageUrl=r.files[0].url;
  await saveCampaignStateQuick();
  changed('#campaignCards');renderSite();
}
async function uploadCampaignBulk(){
  const input=$('#campaignBulkFiles');
  const selected=[...(input?.files||[])];
  if(!selected.length)return alert('Önce fotoğraf seç.');
  if(selected.length>10)return alert('Tek seferde en fazla 10 fotoğraf seçebilirsin.');
  try{
    const fd=new FormData();selected.forEach(f=>fd.append('files',f));
    const r=await fetch('/api/upload',{method:'POST',body:fd}).then(r=>r.json());
    if(!r.ok||!r.files?.length)throw new Error(r.message||'Fotoğraflar yüklenemedi.');
    settings.campaignCards=settings.campaignCards||[];
    r.files.forEach((f,j)=>settings.campaignCards.push({id:'kampanya-'+Date.now()+'-'+j+'-'+Math.random().toString(36).slice(2,6),enabled:true,order:settings.campaignCards.length+1,imageUrl:f.url,title:'',subtitle:'',buttonText:'ÜRÜNLERİ GÖR',targetCategory:'tum',overlayOpacity:28}));
    await saveCampaignStateQuick();
    changed('#campaignCards');renderSite();
  }catch(e){
    alert(e.message||'Fotoğraflar yüklenemedi. Lütfen tekrar dene.');
  }
}

function catalogGlobalTools(){
  catalog.personalizationPricing=catalog.personalizationPricing||{first:75,second:50,thirdPlus:25};
  catalog.builder=catalog.builder||{allowedCategories:[],categoryOrder:[],pricingRules:[]};
  if(catalog.builder.enabled===undefined)catalog.builder.enabled=false;
  catalog.builder.allowedCategories=Array.isArray(catalog.builder.allowedCategories)?catalog.builder.allowedCategories:[];
  catalog.builder.categoryOrder=Array.isArray(catalog.builder.categoryOrder)?catalog.builder.categoryOrder:[];
  catalog.builder.allowedProducts=(catalog.builder.allowedProducts&&typeof catalog.builder.allowedProducts==='object')?catalog.builder.allowedProducts:{};
  catalog.builder.productPricing=(catalog.builder.productPricing&&typeof catalog.builder.productPricing==='object')?catalog.builder.productPricing:{};
  catalog.builder.spotlight=(catalog.builder.spotlight&&typeof catalog.builder.spotlight==='object')?catalog.builder.spotlight:{};
  if(catalog.builder.spotlight.eyebrow===undefined)catalog.builder.spotlight.eyebrow='KENDİ SETİNİ OLUŞTUR';
  if(catalog.builder.spotlight.title===undefined)catalog.builder.spotlight.title='Setini sen seç.';
  if(catalog.builder.spotlight.text===undefined)catalog.builder.spotlight.text='Ürünlerini bir araya getir, özel set fiyatını anında gör.';
  if(catalog.builder.spotlight.imageUrl===undefined)catalog.builder.spotlight.imageUrl='';
  const pricing=catalog.personalizationPricing;
  const allowed=catalog.categories.filter(c=>c.id!=='tum'&&!isSetCategory(c.id)).map(c=>{
    const checked=(catalog.builder.allowedCategories||[]).includes(c.id);
    return `<label class=setItemToggle><span><b>${esc(c.name)}</b><small class=muted>Müşterinin kendi setini oluştururken seçebileceği kategori</small></span><input type=checkbox ${checked?'checked':''} onclick="event.stopPropagation()" onchange="toggleBuilderCategory('${attr(c.id)}',this.checked)"></label>`;
  }).join('');
  const builderOrderHtml=renderBuilderOrderRowsHtml();
  const categoryOptions=catalog.categories.filter(c=>c.id!=='tum').sort((a,b)=>(a.order||0)-(b.order||0)).map(c=>`<option value="${attr(c.id)}">${esc(c.name)}</option>`).join('');
  return `<div class="panel unifiedCatalogSettings">
    <details class=simpleAdminDetails><summary>Genel ürün / set ayarları <small>Ürünlerle ilgili ortak ayarlar</small></summary><div class=simpleDetailsBody>
      <div class=grid3>
        ${input('İlk ürün yazısı','catalog.personalizationPricing.first',pricing.first,'Müşteri ilk ürüne yazı eklerse uygulanacak ücret.','.drawer','number')}
        ${input('İkinci ürün yazısı','catalog.personalizationPricing.second',pricing.second,'Müşteri ikinci ürüne yazı eklerse uygulanacak ücret.','.drawer','number')}
        ${input('3. ve sonrası','catalog.personalizationPricing.thirdPlus',pricing.thirdPlus,'Üçüncü ve sonraki her yazılı ürün için ücret.','.drawer','number')}
        ${input('Cüzdana fotoğraf işleme','catalog.walletPhotoFee',catalog.walletPhotoFee??25,'Fotoğraf işlemesi normal yazı ücretlerinden bağımsız ek ücrettir.','.drawer','number')}
      </div>
      <details class=nestedAdminDetails><summary>Kendi Setini Oluştur kategorileri</summary><div class=setItemList>${allowed}</div><div class=help>Burada seçtiklerin yalnızca müşterinin “Kendi Setini Oluştur” akışında görünür.</div><div class=builderOrderBox><b>Müşteride gösterilecek sıra</b><div class=help>Yalnızca soldaki ⠿ tutamacından tutup sürükle. Sıralama sırasında bu ekrandan çıkılmaz.</div><div id=builderOrderRows>${builderOrderHtml}</div></div>${renderBuilderProductPricingAdmin()}<div class=builderSpotlightAdmin><b>Ana sayfadaki “Kendi Setini Oluştur” alanı</b><div class=grid2>${input('Üst küçük yazı','catalog.builder.spotlight.eyebrow',catalog.builder.spotlight.eyebrow,'Örn. KENDİ SETİNİ OLUŞTUR','#builderSpotlight')}${input('Başlık','catalog.builder.spotlight.title',catalog.builder.spotlight.title,'Örn. Setini sen seç.','#builderSpotlight')}${textarea('Açıklama','catalog.builder.spotlight.text',catalog.builder.spotlight.text,'Kartta görünecek açıklama.','#builderSpotlight')}<div class=field><label><b>Arka plan fotoğrafı (isteğe bağlı)</b></label><input id=builderSpotlightFile type=file accept="image/*"><div class=builderSpotlightUploadRow><button type=button class=smallBtn onclick=uploadBuilderSpotlightImage()>Fotoğraf Yükle</button>${catalog.builder.spotlight.imageUrl?'<button type=button class=smallBtn onclick=removeBuilderSpotlightImage()>Fotoğrafı Kaldır</button>':''}</div><div class=help>Fotoğraf eklemezsen mevcut koyu tasarım aynen kalır.</div></div></div></div></details>
    </div></details>
    <details class=simpleAdminDetails><summary>Toplu ürün yükle <small>Birden fazla fotoğraf = ayrı ayrı ürün</small></summary><div class=simpleDetailsBody>
      <div class=grid2><div class=field><label><b>Hangi kategoriye yüklensin?</b></label><select id=bulkUploadCategory class=formControl>${categoryOptions}</select><div class=help>Örn. Saat seçip 20 fotoğraf yüklersen 20 ayrı saat ürünü oluşur.</div></div>
      <div class=field><label><b>Ürün fotoğraflarını seç</b></label><input id=bulkProductFiles type=file accept="image/*" multiple><div class=help>Her seçilen fotoğraf ayrı bir yeni ürünün ana fotoğrafı olur.</div></div></div>
      <button class=btn id=bulkProductUploadBtn onclick=bulkCreateProductsFromPhotos()>Seçili Fotoğrafları Ayrı Ürünler Olarak Yükle</button>
      <div class=bulkUploadStatus id=bulkUploadStatus></div>
    </div></details>
  </div>`;
}
async function bulkCreateProductsFromPhotos(){
  const categoryId=$('#bulkUploadCategory')?.value;
  const files=[...($('#bulkProductFiles')?.files||[])];
  if(!categoryId)return alert('Önce kategori seç.');
  if(!files.length)return alert('En az bir fotoğraf seç.');
  const btn=$('#bulkProductUploadBtn'),status=$('#bulkUploadStatus');
  if(btn){btn.disabled=true;btn.textContent=`${files.length} ürün yükleniyor...`}
  if(status)status.textContent=`0 / ${files.length} fotoğraf yüklendi.`;
  try{
    const fd=new FormData(); files.forEach(f=>fd.append('files',f));
    const r=await fetch('/api/upload',{method:'POST',body:fd}).then(x=>x.json());
    if(!r.ok||!(r.files||[]).length)throw new Error(r.message||'Fotoğraflar yüklenemedi.');
    const readySet=isSetCategory(categoryId);
    const start=catalog.products.filter(p=>p.category===categoryId).length;
    (r.files||[]).forEach((f,n)=>{
      const id='urun-'+Date.now()+'-'+n+'-'+Math.random().toString(36).slice(2,6);
      catalog.products.push({id,name:`Yeni Ürün ${start+n+1}`,subtitle:'',description:'',features:[],category:categoryId,price:0,oldPrice:0,stock:0,badge:'',badgeColor:'orange',image:f.url,images:[f.url],hidden:false,setEligible:!readySet,isSet:readySet,setItems:[],writePositions:[],preferredWritePosition:'',writeEnabled:true,walletPhotoEnabled:true,subcategoryId:''});
      if(status)status.textContent=`${n+1} / ${(r.files||[]).length} ürün hazırlandı.`;
    });
    const saved=await fetch('/api/admin/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings,catalog})}).then(x=>x.json());
    if(!saved.ok)throw new Error(saved.message||'Ürünler kaydedilemedi.');
    adminOpenCategory=categoryId;adminProductSearch='';adminOpenProduct=null;
    if(status)status.textContent=`Tamamlandı: ${(r.files||[]).length} ayrı ürün oluşturuldu.`;
    changed('#products');renderCatalog();
  }catch(e){if(status)status.textContent='Hata: '+(e.message||'Yükleme başarısız.');alert(e.message||'Yükleme başarısız.');}
  finally{if(btn){btn.disabled=false;btn.textContent='Seçili Fotoğrafları Ayrı Ürünler Olarak Yükle'}}
}

function discountCampaignProductChoice(rule,index,p,mode='include'){
  const image=p.image||p.images?.[0]||'';
  const checked=mode==='exclude'?!(rule.excludedProductIds||[]).includes(p.id):(rule.productIds||[]).includes(p.id);
  const handler=mode==='exclude'?`toggleDiscountCampaignCategoryProduct(${index},'${attr(p.id)}',this.checked)`:`toggleDiscountCampaignProduct(${index},'${attr(p.id)}',this.checked)`;
  const unitCount=Math.max(1,Math.min(10,Number(rule.productUnitCounts?.[p.id]||1)));
  return `<div class="campaignProductChoiceWrap ${checked?'isIncluded':'isExcluded'}"><label class="campaignProductChoice"><input type=checkbox ${checked?'checked':''} onchange="${handler}">${image?`<img src="${attr(image)}" alt="">`:'<span class=campaignProductNoImage>—</span>'}<span><b>${esc(p.name||'Ürün')}</b><small>${Number(p.price||0)} TL</small></span></label><label class=campaignUnitCount>Bu ürün kampanyada <select onchange="setDiscountCampaignProductUnits(${index},'${attr(p.id)}',this.value)">${Array.from({length:10},(_,n)=>`<option value="${n+1}" ${unitCount===n+1?'selected':''}>${n+1} adet</option>`).join('')}</select> sayılsın</label></div>`;
}
function discountCampaignScopeProducts(rule,index){
  const scope=rule.scopeType||'category';
  if(scope==='all'){
    const groups=(catalog.categories||[]).filter(c=>c.id!=='tum').map(c=>{
      const ps=(catalog.products||[]).filter(p=>p.category===c.id);
      if(!ps.length)return '';
      return `<details class="campaignScopeGroup"><summary>${esc(c.name||c.id)} <small>${ps.length} ürün · tümü dahil</small></summary><div class="campaignScopeProductGrid">${ps.map(p=>discountCampaignProductChoice(rule,index,p,'exclude')).join('')}</div></details>`;
    }).join('');
    return `<div class=campaignScopeBox><b>Tüm ürünler içinde özel seçim</b><div class=help>Varsayılan olarak tüm ürünler kampanyaya dahildir. İstemediğin modelin tikini kaldırabilir; çift/üçlü ürünleri kampanyada kaç adet sayacağını ayrıca seçebilirsin.</div>${groups||'<div class=help>Ürün bulunamadı.</div>'}</div>`;
  }
  if(scope==='products'){
    const groups=(catalog.categories||[]).filter(c=>c.id!=='tum').map(c=>{
      const ps=(catalog.products||[]).filter(p=>p.category===c.id);
      if(!ps.length)return '';
      return `<details class="campaignScopeGroup"><summary>${esc(c.name||c.id)} <small>${ps.length} ürün</small></summary><div class="campaignScopeProductGrid">${ps.map(p=>discountCampaignProductChoice(rule,index,p,'include')).join('')}</div></details>`;
    }).join('');
    return `<div class=campaignScopeBox><b>Uygulanacak ürünler</b>${groups||'<div class=help>Ürün bulunamadı.</div>'}</div>`;
  }
  const selected=new Set(rule.categoryIds||[]);
  const categories=(catalog.categories||[]).filter(c=>c.id!=='tum');
  const categoryChoices=categories.map(c=>`<label><input type=checkbox ${selected.has(c.id)?'checked':''} onchange="toggleDiscountCampaignCategory(${index},'${attr(c.id)}',this.checked)"> ${esc(c.name||c.id)}</label>`).join('');
  const selectedGroups=categories.filter(c=>selected.has(c.id)).map(c=>{
    const ps=(catalog.products||[]).filter(p=>p.category===c.id);
    return `<div class="campaignSelectedCategory"><div class=campaignSelectedCategoryHead><b>${esc(c.name||c.id)}</b><small>${ps.length} ürün · istemediklerinin tikini kaldır</small></div>${ps.length?`<div class=campaignScopeProductGrid>${ps.map(p=>discountCampaignProductChoice(rule,index,p,'exclude')).join('')}</div>`:'<div class=help>Bu kategoride ürün bulunamadı.</div>'}</div>`;
  }).join('');
  return `<div class=campaignScopeBox><b>Uygulanacak kategoriler</b><div class=campaignScopeChoices>${categoryChoices}</div>${selectedGroups?`<div class=campaignCategoryProductPicker>${selectedGroups}</div>`:'<div class=help>Bir kategori seçtiğinde o kategorideki ürünler burada açılır; istemediğin modellerin tikini kaldırabilirsin.</div>'}</div>`;
}
function discountTypeHelp(rule){
  if(rule.discountType==='percent')return 'Eşiğe ulaşınca kampanyaya dahil ürünlerin toplamından bu yüzde düşer.';
  if(rule.discountType==='bundlePrice')return 'Örn. minimum 3 ve değer 1300 ise, kampanyaya uyan ilk 3 ürünün kampanya toplamı 1300 TL olur.';
  return 'Eşiğe ulaşınca sepet toplamından bu TL tutarı bir kez düşer.';
}
function renderDiscountCampaigns(){
  catalog.checkoutCampaigns=Array.isArray(catalog.checkoutCampaigns)?catalog.checkoutCampaigns:[];
  catalog.checkoutCampaigns.forEach(r=>{r.productUnitCounts=r.productUnitCounts||{};if(r.repeatable===undefined)r.repeatable=false;if(r.maxApplications===undefined||Number(r.maxApplications)<1)r.maxApplications=1;if(r.allowDoubleCount===undefined)r.allowDoubleCount=false;});
  const cards=catalog.checkoutCampaigns.map((r,i)=>`<details class="panel simpleAdminDetails discountCampaignAdmin" data-campaign-admin-id="${attr(r.id)}" ${adminOpenCampaignId===r.id?'open':''} ontoggle="if(this.open){adminOpenCampaignId='${attr(r.id)}';sessionStorage.setItem('shazAdminOpenCampaign',adminOpenCampaignId)}else if(adminOpenCampaignId==='${attr(r.id)}'){adminOpenCampaignId='';sessionStorage.removeItem('shazAdminOpenCampaign')}"><summary><span>${esc(r.name||('Kampanya '+(i+1)))}</span><small>${r.enabled!==false?'Aktif':'Kapalı'} · ${Math.max(1,Number(r.minQty||1))} kampanya adedi</small></summary><div class=simpleDetailsBody>
    <div class=campaignRuleHead><label class=setItemToggle><span><b>Kampanya aktif</b><small class=muted>İstediğinde kapatabilirsin; silmek zorunda değilsin.</small></span><input type=checkbox ${r.enabled!==false?'checked':''} onchange="catalog.checkoutCampaigns[${i}].enabled=this.checked;changed('.drawer')"></label><button class=dangerBtn onclick="removeDiscountCampaign(${i})">Kampanyayı Sil</button></div>
    <div class=grid2>
      ${input('Kampanya adı',`catalog.checkoutCampaigns[${i}].name`,r.name||'Yeni Kampanya','Müşteri sepette bu adı görür.','.drawer')}
      ${input('Kampanya için gerekli adet',`catalog.checkoutCampaigns[${i}].minQty`,Math.max(1,Number(r.minQty||1)),'Buradaki adet normal sepet satırı değil, kampanya adedidir. Örneğin çift saat ürününü aşağıda 2 adet saydırabilirsin.','.drawer','number')}
      <div class=field><label><b>Kampanya hangi ürünlerde?</b></label><select class=formControl onchange="catalog.checkoutCampaigns[${i}].scopeType=this.value;rerenderDiscountCampaigns('${attr(r.id)}')"><option value=category ${(r.scopeType||'category')==='category'?'selected':''}>Kategori seç</option><option value=products ${r.scopeType==='products'?'selected':''}>Tek tek ürün seç</option><option value=all ${r.scopeType==='all'?'selected':''}>Tüm ürünler</option></select><div class=help>Bir kategori seçtiğinde içindeki modeller aşağıda açılır; istemediğini çıkarabilir ve her ürünün kampanya sayısını ayrı belirleyebilirsin.</div></div>
      <div class=field><label><b>İndirim türü</b></label><select class=formControl onchange="catalog.checkoutCampaigns[${i}].discountType=this.value;rerenderDiscountCampaigns('${attr(r.id)}')"><option value=fixed ${(r.discountType||'fixed')==='fixed'?'selected':''}>Sabit TL indirim</option><option value=percent ${r.discountType==='percent'?'selected':''}>Yüzdelik indirim</option><option value=bundlePrice ${r.discountType==='bundlePrice'?'selected':''}>Kampanyalı toplam fiyat</option></select><div class=help>${discountTypeHelp(r)}</div></div>
      ${input(r.discountType==='percent'?'İndirim yüzdesi':r.discountType==='bundlePrice'?'Kampanyalı toplam fiyat':'İndirim tutarı',`catalog.checkoutCampaigns[${i}].discountValue`,Number(r.discountValue||0),r.discountType==='percent'?'Örn: 15 = %15 indirim.':r.discountType==='bundlePrice'?'Örn: 1300 = seçilen kampanya adedi toplam 1300 TL.':'Örn: 400 = toplamdan 400 TL düşer.','.drawer','number')}
      <label class=setItemToggle><span><b>Aynı kampanya tekrar uygulanabilsin</b><small class=muted><b>Açık:</b> kampanya uygun ürün grubu oluştuğu kadar tekrar çalışabilir; aşağıdaki üst sınırı aşmaz. <b>Kapalı:</b> sepette yalnızca 1 kez çalışır. Örn. 3'lü kampanyada 6 uygun ürün + sınır 2 ⇒ kampanya 2 kez uygulanır.</small></span><input type=checkbox ${r.repeatable?'checked':''} onchange="catalog.checkoutCampaigns[${i}].repeatable=this.checked;if(this.checked&&Number(catalog.checkoutCampaigns[${i}].maxApplications||0)<2)catalog.checkoutCampaigns[${i}].maxApplications=2;changed('.drawer');rerenderDiscountCampaigns('${attr(r.id)}')"></label>
      <div class=field><label><b>En fazla kaç kez uygulansın?</b></label><input class=formControl type=number min=1 value="${Math.max(1,Number(r.maxApplications||1))}" ${r.repeatable?'':'disabled'} oninput="catalog.checkoutCampaigns[${i}].maxApplications=Math.max(1,Number(this.value||1));changed('.drawer')"><div class=help>${r.repeatable?'Burada sınırsız seçeneği yoktur. 1 = en fazla 1 kez, 2 = en fazla 2 kez, 3 = en fazla 3 kez. Örn. 3’lü kampanya + 6 uygun ürün + sınır 2 ⇒ iki ayrı 3’lü grup indirim alır.':'Tekrar kapalıyken bu alan devre dışıdır ve kampanya yalnızca 1 kez uygulanır.'}</div></div>
      <label class=setItemToggle><span><b>Aynı ürünleri başka kampanyada tekrar say</b><small class=muted><b>Kapalı (önerilen):</b> aynı fiziksel ürün iki kampanyada birden kullanılamaz; sistem toplam indirimi en yüksek geçerli dağılımı seçer. Örn. 6 ürün varsa 3+3 ile 2+2+2 seçeneklerini karşılaştırır. <b>Açık:</b> aynı ürün farklı kampanyalarda yeniden sayılabilir ve indirimler üst üste binebilir.</small></span><input type=checkbox ${r.allowDoubleCount?'checked':''} onchange="catalog.checkoutCampaigns[${i}].allowDoubleCount=this.checked;changed('.drawer')"></label>
    </div>
    ${discountCampaignScopeProducts(r,i)}
    <div class=campaignRuleNote><b>Nasıl hesaplanır?</b> Aynı ürünleri başka kampanyada tekrar say seçeneği kapalıysa sistem ürünleri kampanyalar arasında paylaştırır ve müşteriye en yüksek toplam indirimi veren geçerli kombinasyonu seçer. Örnek: 3 ürün varsa 3’lü kampanya, 5 ürün varsa 3+2, 6 ürün varsa 3+3 veya 2+2+2 seçeneklerinden daha avantajlı olan uygulanır. Tekrar uygulanabilsin açıksa aynı kampanya da belirlediğin üst sınıra kadar birden fazla kez çalışır.</div>
  </div></details>`).join('');
  shell('Kampanyalar','Sepet indirimi kuralları burada. Her kampanya kapalı kutu halinde durur; açıp yalnızca o kampanyayı düzenlersin.',`<div class=panel><div class=campaignCreateRow><div><h2>Sepet Kampanyaları</h2><div class=help>Ürünleri kategori/model bazında seçebilir, bir ürünün kampanyada 1/2/3… adet sayılmasını belirleyebilir ve kampanyaların üst üste binmesini engelleyebilirsin.</div></div><button class=btn onclick=addDiscountCampaign()>+ Kampanya Ekle</button></div><div class=campaignRuleNote>Varsayılan güvenli davranış: aynı uygun ürünler iki ayrı kampanyada tekrar sayılmaz. İstersen kampanya içinden bunu özellikle açabilirsin.</div></div>${cards||'<div class=panel><b>Henüz sepet kampanyası yok.</b><div class=help>“Kampanya Ekle” ile ilk kampanyanı oluştur.</div></div>'}`);
}
function rerenderDiscountCampaigns(id){
  if(id){adminOpenCampaignId=id;try{sessionStorage.setItem('shazAdminOpenCampaign',id)}catch(_){}}
  const x=window.scrollX,y=window.scrollY;renderDiscountCampaigns();requestAnimationFrame(()=>window.scrollTo(x,y));
}
function addDiscountCampaign(){
  catalog.checkoutCampaigns=catalog.checkoutCampaigns||[];
  catalog.checkoutCampaigns.push({id:'sepet-'+Date.now()+'-'+Math.random().toString(36).slice(2,6),name:'Yeni Kampanya',enabled:true,scopeType:'category',categoryIds:[],productIds:[],excludedProductIds:[],productUnitCounts:{},minQty:3,discountType:'fixed',discountValue:0,repeatable:false,maxApplications:1,allowDoubleCount:false});
  adminOpenCampaignId=catalog.checkoutCampaigns[catalog.checkoutCampaigns.length-1].id;sessionStorage.setItem('shazAdminOpenCampaign',adminOpenCampaignId);
  renderDiscountCampaigns();
}
function removeDiscountCampaign(i){if(confirm('Bu kampanya silinsin mi?')){const id=catalog.checkoutCampaigns[i]?.id;catalog.checkoutCampaigns.splice(i,1);if(adminOpenCampaignId===id){adminOpenCampaignId='';sessionStorage.removeItem('shazAdminOpenCampaign')}renderDiscountCampaigns()}}
function toggleDiscountCampaignCategory(i,id,on){
  const r=catalog.checkoutCampaigns[i];r.categoryIds=r.categoryIds||[];r.excludedProductIds=r.excludedProductIds||[];
  if(on&&!r.categoryIds.includes(id))r.categoryIds.push(id);
  if(!on){r.categoryIds=r.categoryIds.filter(x=>x!==id);const ids=new Set((catalog.products||[]).filter(p=>p.category===id).map(p=>p.id));r.excludedProductIds=r.excludedProductIds.filter(x=>!ids.has(x));}
  changed('.drawer');rerenderDiscountCampaigns(r.id);
}
function toggleDiscountCampaignCategoryProduct(i,id,on){
  const r=catalog.checkoutCampaigns[i];r.excludedProductIds=r.excludedProductIds||[];
  if(!on&&!r.excludedProductIds.includes(id))r.excludedProductIds.push(id);
  if(on)r.excludedProductIds=r.excludedProductIds.filter(x=>x!==id);
  changed('.drawer');
}
function toggleDiscountCampaignProduct(i,id,on){const r=catalog.checkoutCampaigns[i];r.productIds=r.productIds||[];if(on&&!r.productIds.includes(id))r.productIds.push(id);if(!on)r.productIds=r.productIds.filter(x=>x!==id);changed('.drawer');rerenderDiscountCampaigns(r.id)}
function setDiscountCampaignProductUnits(i,id,value){const r=catalog.checkoutCampaigns[i];if(!r)return;r.productUnitCounts=r.productUnitCounts||{};r.productUnitCounts[id]=Math.max(1,Math.min(10,Number(value||1)));changed('.drawer')}

let adminCategoryNavScrollLeft=0;
function renderCatalog(){
  const realCats=catalog.categories.filter(c=>c.id!=='tum').sort((a,b)=>(a.order||0)-(b.order||0));
  const cats=[{id:'tum',name:'Tüm Ürünler',__allProducts:true},...realCats];
  if(!adminOpenCategory||!cats.some(c=>c.id===adminOpenCategory))adminOpenCategory=realCats[0]?.id||'tum';
  const nav=cats.map(c=>{const count=c.__allProducts?catalog.products.length:catalog.products.filter(p=>p.category===c.id).length;if(c.__allProducts)return `<button class="categoryJumpBtn ${adminOpenCategory==='tum'?'active':''}" onclick="jumpAdminCategory('tum')">${esc(c.name)} <span>${count}</span></button>`;return `<button class="categoryJumpBtn ${adminOpenCategory===c.id?'active':''}" draggable="true" data-category-drag-id="${attr(c.id)}" onclick="jumpAdminCategory('${attr(c.id)}')" ondragstart="categoryDragStart(event,'${attr(c.id)}')" ondragover="categoryDragOver(event,'${attr(c.id)}')" ondrop="categoryDrop(event,'${attr(c.id)}')" ondragend="categoryDragEnd(event)"><span class=categoryDragGrip aria-hidden=true>⠿</span>${esc(c.name)} <span>${count}</span></button>`}).join('');
  const active=cats.find(c=>c.id===adminOpenCategory);
  let html=catalogGlobalTools()+`<div class="panel catalogControlPanel"><div class=campaignAdminHead><div><h2>Kategoriler & Ürünler</h2><div class=help>Kategori seç; yalnızca o kategorinin ürünleri açılır. “Tüm Ürünler” kartının kapak fotoğrafını da buradan yönetebilirsin. Sıralamayı değiştirmek için diğer kategori başlıklarını sürükleyip bırak.</div></div><div class=catalogHeadActions><div class=adminProductSearch><input class=formControl value="${attr(adminProductSearch)}" placeholder="Bu kategoride ürün ara..." oninput="filterAdminProducts(this.value)"></div><button class=btn style="max-width:160px" onclick=addCategory()>＋ Kategori Ekle</button></div></div><div class=catalogToolbar><div class=categoryQuickNav>${nav}</div></div></div>`;
  html+=active?(active.__allProducts?allProductsCategoryBlock():categoryBlock(active)):'<div class=panel>Henüz kategori yok.</div>';
  shell('Kategoriler & Ürünler','Bir ürünün içine girdiğinde fotoğraf, açıklama, fiyat, stok, etiket, kişiselleştirme ve hazır set içeriği dahil tüm ayarlarını aynı yerde yönetirsin.',html);
  requestAnimationFrame(()=>{
    initProductTextLayoutEditors();
    const nav=document.querySelector('.categoryQuickNav');
    if(nav)nav.scrollLeft=adminCategoryNavScrollLeft;
    positionActiveAdminCategoryTab('auto');
  });
}
function categoryDragStart(e,id){
  adminDraggedCategory=id;
  e.currentTarget?.classList.add('dragging');
  if(e.dataTransfer){e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',id)}
}
function categoryDragOver(e,id){
  if(!adminDraggedCategory||adminDraggedCategory===id)return;
  e.preventDefault();
  if(e.dataTransfer)e.dataTransfer.dropEffect='move';
  e.currentTarget?.classList.add('dragOver');
}
function categoryDrop(e,targetId){
  e.preventDefault();
  const sourceId=adminDraggedCategory||(e.dataTransfer?.getData('text/plain')||'');
  document.querySelectorAll('.categoryJumpBtn.dragOver').forEach(x=>x.classList.remove('dragOver'));
  if(!sourceId||sourceId===targetId)return categoryDragEnd(e);
  const ordered=catalog.categories.filter(c=>c.id!=='tum').sort((a,b)=>(a.order||0)-(b.order||0));
  const from=ordered.findIndex(c=>c.id===sourceId),to=ordered.findIndex(c=>c.id===targetId);
  if(from<0||to<0)return categoryDragEnd(e);
  const [moved]=ordered.splice(from,1);ordered.splice(to,0,moved);
  ordered.forEach((c,i)=>c.order=i+1);
  adminOpenCategory=sourceId;
  adminDraggedCategory=null;
  changed('header');
  renderCatalog();
}
function categoryDragEnd(e){
  adminDraggedCategory=null;
  document.querySelectorAll('.categoryJumpBtn.dragging,.categoryJumpBtn.dragOver').forEach(x=>x.classList.remove('dragging','dragOver'));
}
function positionActiveAdminCategoryTab(behavior='smooth'){
  const nav=document.querySelector('.categoryQuickNav');
  const active=nav?.querySelector('.categoryJumpBtn.active');
  if(!nav||!active)return;
  const desired=active.offsetLeft+active.offsetWidth/2-nav.clientWidth/2;
  const max=Math.max(0,nav.scrollWidth-nav.clientWidth);
  nav.scrollTo({left:Math.max(0,Math.min(max,desired)),behavior});
}
function jumpAdminCategory(id){
  const nav=document.querySelector('.categoryQuickNav');
  if(nav)adminCategoryNavScrollLeft=nav.scrollLeft;
  adminOpenCategory=id;try{sessionStorage.setItem('shazAdminCategory',id)}catch(_){}
  adminProductSearch='';
  adminOpenProduct=null;
  renderCatalog();
}
function toggleAdminCategory(id){
  adminOpenCategory=id;try{sessionStorage.setItem('shazAdminCategory',id)}catch(_){}
  renderCatalog();
}
function filterAdminProducts(value){
  adminProductSearch=(value||'').trim();
  renderCatalog();
}
function toggleAdminProduct(id){
  adminOpenProduct=adminOpenProduct===id?null:id;
  renderCatalog();
  if(adminOpenProduct)requestAnimationFrame(()=>document.getElementById('admin-product-'+id)?.scrollIntoView({behavior:'smooth',block:'nearest'}));
}

function allProductsCategoryBlock(){const cover=catalog.allProductsCover||'';return `<section class="categoryAdminBlock open" id="admin-cat-tum"><div class=categoryAdminHeader><div class=categoryHeaderMain><span><h2>Tüm Ürünler</h2><span class=help>Bu kart müşteri tarafındaki Kategoriler ekranının ilk kutusudur.</span></span></div></div><div class=categoryAdminBody><div class="panel allProductsCoverAdmin"><div class=field><label><b>Tüm Ürünler kapak fotoğrafı</b></label><input id=allProductsCoverFile type=file accept="image/*"><button type=button class=smallBtn onclick=uploadAllProductsCover()>Fotoğrafı Yükle</button><div class=help>Yüklediğin görsel yalnızca “Tüm Ürünler” kategori kartında görünür.</div>${cover?`<img src="${attr(cover)}" class=allProductsCoverPreview>`:''}</div></div></div></section>`;}
async function uploadAllProductsCover(){const f=document.getElementById('allProductsCoverFile')?.files?.[0];if(!f)return alert('Önce bir fotoğraf seç.');const fd=new FormData();fd.append('files',f);const r=await fetch('/api/upload',{method:'POST',body:fd}).then(x=>x.json());if(!r.ok||!r.files?.[0])return alert(r.message||'Fotoğraf yüklenemedi.');catalog.allProductsCover=r.files[0].url;await fetch('/api/admin/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings,catalog})});changed('#categoryHub');renderCatalog();}
function categoryBlock(c){
  const ci=catalog.categories.findIndex(x=>x.id===c.id);
  const allPs=catalog.products.filter(p=>p.category===c.id);
  const q=adminProductSearch.toLocaleLowerCase('tr-TR');
  const ps=q?allPs.filter(p=>`${p.name||''} ${p.description||''} ${(p.features||[]).join(' ')}`.toLocaleLowerCase('tr-TR').includes(q)):allPs;
  const catTarget=`[data-category-id="${c.id}"]`;
  return `<section class="categoryAdminBlock open" id="admin-cat-${attr(c.id)}">
    <div class=categoryAdminHeader>
      <div class=categoryHeaderMain style="cursor:default"><span><h2>${esc(c.name)}</h2><span class=help>${q?`${ps.length} eşleşme / `:''}${allPs.length} ürün</span></span></div>
      <button class="smallBtn addProductPrimary" onclick="addProduct('${attr(c.id)}')">＋ Yeni Ürün Ekle</button>
    </div>
    <div class=categoryAdminBody>
      <details class=categorySettingsDetails><summary>Kategori ayarları</summary>
        <div class="grid2 compactCategorySettings">
          ${input('Kategori adı',`catalog.categories[${ci}].name`,c.name,'Aynı ad hem üst menüde hem Kategoriler ekranında görünür.',catTarget)}
          <div class=field><label><b>Sıralama</b></label><div class=categoryOrderHint>Üstteki kategori başlığını sürükleyip istediğin yere bırak.</div></div>
          <div class=field><label><b>Kategori kapak fotoğrafı</b></label><input id="catFile${ci}" type=file accept="image/*"><button class=smallBtn onclick="uploadCategoryCover(${ci})">Fotoğrafı Yükle</button><div class=help>Bu görsel Kategoriler ekranındaki kutuda görünür.</div>${c.cover?`<img src="${attr(c.cover)}" style="width:100%;max-height:120px;object-fit:cover;border-radius:8px">`:''}</div>
          <div class=field><label><b>Kategoriyi gizle</b></label><label><input data-preview-target="${attr(catTarget)}" type=checkbox ${c.hidden?'checked':''} onchange="catalog.categories[${ci}].hidden=this.checked;changed(this.dataset.previewTarget)"> Gizli</label></div>
          <div class=field><label><b>Kategoriyi sil</b></label><button type=button class="smallBtn dangerSoft" onclick="deleteCategory('${attr(c.id)}')">Bu kategoriyi sil</button><div class=help>İçinde ürün varsa yanlışlıkla veri kaybı olmaması için silme engellenir.</div></div>
        </div>
        ${renderSubcategoryAdmin(c)}
      </details>
      <div class=adminProductCompactList>${ps.map(p=>productCompactRow(p)).join('')||(q?'<div class=emptyAdmin>Bu kategoride aramana uyan ürün yok.</div>':'<div class=emptyAdmin>Bu kategoride henüz ürün yok. Yukarıdaki “Yeni Ürün Ekle” ile başlayabilirsin.</div>')}</div>
    </div>
  </section>`;
}
function openAdminProductImage(productId){
  const p=(catalog.products||[]).find(x=>x.id===productId);if(!p)return;
  const img=p.image||productImages(p)[0]||'';if(!img)return alert('Bu üründe fotoğraf yok.');
  document.querySelector('.adminImageModal')?.remove();
  const m=document.createElement('div');m.className='adminImageModal';m.innerHTML=`<div class=adminImageModalCard><button type=button class=adminImageModalClose onclick="this.closest('.adminImageModal').remove()">×</button><img src="${attr(img)}" alt="${attr(p.name||'Ürün')}"><b>${esc(p.name||'Ürün')}</b></div>`;m.addEventListener('click',e=>{if(e.target===m)m.remove()});document.body.appendChild(m);
}
function productCompactRow(p){
  const i=catalog.products.findIndex(x=>x.id===p.id);
  const img=p.image||productImages(p)[0]||'';
  const open=adminOpenProduct===p.id;
  const quickSub=productCompactSubcategorySelect(p,i);
  return `<div class="adminProductCompact ${open?'editing':''}" data-product-sort-id="${attr(p.id)}" ondragover="productDragOver(event,'${attr(p.id)}')" ondrop="productDrop(event,'${attr(p.id)}')">
    <div class=adminProductCompactHead>
      <span class=productDragHandle draggable="true" title="Tut ve sürükle" ondragstart="productDragStart(event,'${attr(p.id)}')" ondragend="productDragEnd(event)">⠿</span>
      <button class=adminProductCompactMain onclick="toggleAdminProduct('${attr(p.id)}')">
        <span class=compactThumb>${img?`<img src="${attr(img)}">`:'Fotoğraf yok'}</span>
        <span class=compactMeta><b>${esc(p.name||'Yeni Ürün')}</b><small>₺${Number(p.price||0).toLocaleString('tr-TR')} · Stok ${Number(p.stock||0)}${p.isSet?' · Hazır set':''}</small></span>
        <span class=compactEdit>${open?'Kapat':'Düzenle'}</span>
      </button>
      <div class=compactQuickActions>
        ${quickSub}
        <button class=duplicateBtn type=button onclick="openAdminProductImage('${attr(p.id)}')">Büyüt</button>
        <button class=duplicateBtn type=button onclick="quickToggleProductHidden('${attr(p.id)}')">${p.hidden?'Göster':'Gizle'}</button>
        <button class=duplicateBtn onclick="duplicateProduct(${i})">⧉</button>
      </div>
    </div>
    ${open?`<div class=compactEditor>${productCard(p,true)}</div>`:''}
  </div>`;
}
function productCompactSubcategorySelect(p,i){
  const c=catalog.categories.find(x=>x.id===p.category),subs=categorySubcategories(c);if(!subs.length)return '';
  const options=[`<option value="" ${!p.subcategoryId?'selected':''}>${esc(c.defaultSubcategoryName||'Ana ürünler')}</option>`,...subs.map(s=>`<option value="${attr(s.id)}" ${p.subcategoryId===s.id?'selected':''}>${esc(s.name||'Alt kategori')}${s.hidden?' (gizli)':''}</option>`)].join('');
  return `<label class=compactSubcategoryQuick title="Alt kategori seç"><span>Alt kategori</span><select onchange="catalog.products[${i}].subcategoryId=this.value;changed('#products')">${options}</select></label>`;
}
function categorySubcategories(category){
  if(!category)return [];
  category.subcategories=Array.isArray(category.subcategories)?category.subcategories:[];
  category.subcategories.forEach((s,i)=>{if(s.order===undefined)s.order=i+1;if(s.hidden===undefined)s.hidden=false;if(!s.id)s.id='alt-'+Date.now()+'-'+i});
  return category.subcategories.sort((a,b)=>(a.order||0)-(b.order||0));
}
function renderSubcategoryAdmin(category){
  const subs=categorySubcategories(category);
  const rows=subs.map((s,pos)=>`<div class=subcategoryAdminRow>
    <span class=subcategoryOrderBtns><button type=button class=smallBtn onclick="moveSubcategory('${attr(category.id)}','${attr(s.id)}',-1)" ${pos===0?'disabled':''}>↑</button><button type=button class=smallBtn onclick="moveSubcategory('${attr(category.id)}','${attr(s.id)}',1)" ${pos===subs.length-1?'disabled':''}>↓</button></span>
    <input class=formControl value="${attr(s.name||'Alt kategori')}" oninput="updateSubcategoryName('${attr(category.id)}','${attr(s.id)}',this.value)">
    <label class=subcategoryCoverBtn>Kapak<input id="subcat-file-${attr(s.id)}" type=file accept="image/*" onchange="uploadSubcategoryCover('${attr(category.id)}','${attr(s.id)}',this)"></label>
    ${s.cover?`<img class=subcategoryCoverPreview src="${attr(s.cover)}">`:'<span class=subcategoryNoCover>Fotoğraf yok</span>'}
    <label class=subcategoryHiddenLabel><input type=checkbox ${s.hidden?'checked':''} onchange="toggleSubcategoryHidden('${attr(category.id)}','${attr(s.id)}',this.checked)"> Gizle</label>
    <button type=button class="smallBtn dangerSoft" onclick="removeSubcategory('${attr(category.id)}','${attr(s.id)}')">Sil</button>
  </div>`).join('');
  return `<div class=subcategoryAdminBox><div class=subcategoryAdminHead><span><b>Alt kategoriler</b><small>Sadece bu ana kategorinin içinde görünür. Kapak fotoğrafı da ekleyebilirsin.</small></span><button type=button class=smallBtn onclick="addSubcategory('${attr(category.id)}')">＋ Alt kategori ekle</button></div>
    <div class=subcategoryDefaultName><label><b>Mevcut / ana ürün grubunun adı</b></label><input class=formControl value="${attr(category.defaultSubcategoryName||'Ana ürünler')}" placeholder="Örn. Erkek Kol Saatleri" oninput="setDefaultSubcategoryName('${attr(category.id)}',this.value)"></div>
    ${subs.length?`<div class=subcategoryAdminList>${rows}</div>`:'<div class=help>Alt kategori yok. Mevcut ürünler normal şekilde görünmeye devam eder.</div>'}
  </div>`;
}
function setDefaultSubcategoryName(categoryId,value){const c=catalog.categories.find(x=>x.id===categoryId);if(!c)return;c.defaultSubcategoryName=value;changed('#products')}
function addSubcategory(categoryId){
  const c=catalog.categories.find(x=>x.id===categoryId);if(!c)return;
  const subs=categorySubcategories(c),id='alt-'+Date.now()+'-'+Math.random().toString(36).slice(2,6);
  subs.push({id,name:'Yeni Alt Kategori',cover:'',hidden:false,order:subs.length+1});
  changed('#products');renderCatalog();
}
function updateSubcategoryName(categoryId,subId,value){const c=catalog.categories.find(x=>x.id===categoryId),s=categorySubcategories(c).find(x=>x.id===subId);if(!s)return;s.name=value;changed('#products')}
function toggleSubcategoryHidden(categoryId,subId,on){const c=catalog.categories.find(x=>x.id===categoryId),s=categorySubcategories(c).find(x=>x.id===subId);if(!s)return;s.hidden=!!on;changed('#products');renderCatalog()}
function moveSubcategory(categoryId,subId,dir){
  const c=catalog.categories.find(x=>x.id===categoryId);if(!c)return;const subs=categorySubcategories(c);const i=subs.findIndex(x=>x.id===subId),j=i+(dir<0?-1:1);if(i<0||j<0||j>=subs.length)return;
  [subs[i],subs[j]]=[subs[j],subs[i]];subs.forEach((s,n)=>s.order=n+1);c.subcategories=subs;changed('#products');renderCatalog();
}
function removeSubcategory(categoryId,subId){
  const c=catalog.categories.find(x=>x.id===categoryId);if(!c)return;
  const used=(catalog.products||[]).filter(p=>p.category===categoryId&&p.subcategoryId===subId).length;
  if(!confirm(used?`Bu alt kategoride ${used} ürün var. Alt kategori silinirse ürünler ana kategoriye döner. Devam edilsin mi?`:'Bu alt kategori silinsin mi?'))return;
  c.subcategories=categorySubcategories(c).filter(x=>x.id!==subId);c.subcategories.forEach((s,n)=>s.order=n+1);(catalog.products||[]).forEach(p=>{if(p.category===categoryId&&p.subcategoryId===subId)p.subcategoryId='' });changed('#products');renderCatalog();
}
async function uploadSubcategoryCover(categoryId,subId,inputEl){
  const f=inputEl?.files?.[0];if(!f)return;const c=catalog.categories.find(x=>x.id===categoryId),s=categorySubcategories(c).find(x=>x.id===subId);if(!s)return;
  const fd=new FormData();fd.append('files',f);const r=await fetch('/api/upload',{method:'POST',body:fd}).then(x=>x.json());if(!r.ok||!r.files?.[0])return alert(r.message||'Fotoğraf yüklenemedi.');s.cover=r.files[0].url;await fetch('/api/admin/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings,catalog})});changed('#products');renderCatalog();
}
function productSubcategoryField(p,i){
  const c=catalog.categories.find(x=>x.id===p.category),subs=categorySubcategories(c);if(!subs.length)return '';
  const opts=subs.map(s=>`<option value="${attr(s.id)}" ${p.subcategoryId===s.id?'selected':''}>${esc(s.name||'Alt kategori')}${s.hidden?' (gizli)':''}</option>`).join('');
  return `<div class="field productSubcategoryField"><label><b>Alt kategori</b></label><select class=formControl onchange="catalog.products[${i}].subcategoryId=this.value;changed('#products')"><option value="" ${!p.subcategoryId?'selected':''}>Ana ürünler</option>${opts}</select><div class=help>Bu ürün ana kategoride hangi alt başlık altında görünsün?</div></div>`;
}
function builderOrderedCategoryIds(){
  catalog.builder=catalog.builder||{allowedCategories:[],categoryOrder:[],pricingRules:[]};
  const allowed=(catalog.builder.allowedCategories||[]).filter(id=>catalog.categories.some(c=>c.id===id));
  const order=(catalog.builder.categoryOrder||[]).filter(id=>allowed.includes(id));allowed.forEach(id=>{if(!order.includes(id))order.push(id)});catalog.builder.categoryOrder=order;return order;
}
function renderBuilderOrderRowsHtml(){
  const builderOrder=builderOrderedCategoryIds();
  if(!builderOrder.length)return '<div class=help>Önce yukarıdan en az bir kategori seç.</div>';
  return builderOrder.map((id,pos)=>{
    const c=catalog.categories.find(x=>x.id===id);if(!c)return '';
    const products=builderAdminProductsForCategory(id);
    const explicit=Array.isArray(catalog.builder.allowedProducts?.[id]);
    const selected=explicit?catalog.builder.allowedProducts[id]:products.map(p=>p.id);
    return `<div class=builderOrderRow data-builder-category="${attr(id)}"><span class=builderDragHandle title="Tut ve sürükle" onclick="event.preventDefault();event.stopPropagation()" onpointerdown="builderCategoryPointerDown(event,'${attr(id)}')">⠿</span><span class=builderOrderText><b>${pos+1}. ${esc(c.name)}</b><small>Tutup sürükleyerek sırala</small></span><details class=builderProductPicker><summary>Ürünler <em>${selected.length}/${products.length}</em></summary><div class=builderMiniProductList>${products.length?products.map(p=>{const img=p.image||productImages(p)[0]||'';return `<label class=builderMiniProduct><input type=checkbox ${selected.includes(p.id)?'checked':''} onclick="event.stopPropagation()" onchange="toggleBuilderProduct('${attr(id)}','${attr(p.id)}',this.checked)">${img?`<span class=builderMiniThumb><img src="${attr(img)}" alt=""></span>`:'<span class="builderMiniThumb noImage">—</span>'}<span class=builderMiniName>${esc(p.name)}</span></label>`}).join(''):'<small>Bu kategoride uygun ürün yok.</small>'}</div></details></div>`;
  }).join('');
}
let builderDraggedCategoryId='';
let builderPointerState=null;
function builderCategoryPointerDown(ev,id){
  if(ev.button!==undefined&&ev.button!==0)return;
  ev.preventDefault();ev.stopPropagation();
  const handle=ev.currentTarget,row=handle.closest('.builderOrderRow'),box=row?.parentElement;
  if(!row||!box)return;
  builderDraggedCategoryId=id;
  builderPointerState={id,handle,row,box,startY:ev.clientY,moved:false};
  row.classList.add('builderDragging');
  try{handle.setPointerCapture(ev.pointerId)}catch(e){}
  const move=e=>builderCategoryPointerMove(e);
  const up=e=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',up);handle.removeEventListener('pointercancel',up);builderCategoryPointerUp(e)};
  handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',up);handle.addEventListener('pointercancel',up);
}
function builderCategoryPointerMove(ev){
  const st=builderPointerState;if(!st)return;ev.preventDefault();ev.stopPropagation();
  if(Math.abs(ev.clientY-st.startY)>3)st.moved=true;
  const rows=[...st.box.querySelectorAll('.builderOrderRow')].filter(x=>x!==st.row);
  const over=rows.find(r=>{const b=r.getBoundingClientRect();return ev.clientY>=b.top&&ev.clientY<=b.bottom});
  if(!over)return;
  const b=over.getBoundingClientRect();
  if(ev.clientY<b.top+b.height/2)st.box.insertBefore(st.row,over);else st.box.insertBefore(st.row,over.nextSibling);
}
function builderCategoryPointerUp(ev){
  const st=builderPointerState;if(!st)return;ev.preventDefault();ev.stopPropagation();
  st.row.classList.remove('builderDragging');
  const order=[...st.box.querySelectorAll('.builderOrderRow')].map(r=>r.dataset.builderCategory).filter(Boolean);
  catalog.builder.categoryOrder=order;
  [...st.box.querySelectorAll('.builderOrderRow .builderOrderText b')].forEach((b,i)=>{b.textContent=(i+1)+'. '+b.textContent.replace(/^\d+\.\s*/, '')});
  builderPointerState=null;builderDraggedCategoryId='';
  changed('.builderCard');
}
// Eski dış çağrılar varsa güvenli biçimde etkisiz kalsın.
function builderCategoryDragStart(ev,id){ev?.preventDefault?.();ev?.stopPropagation?.()}
function builderCategoryDragOver(ev){ev?.preventDefault?.();ev?.stopPropagation?.()}
function builderCategoryDrop(ev,targetId){ev?.preventDefault?.();ev?.stopPropagation?.()}
function normalizedBuilderPricingRules(){
  catalog.builder=catalog.builder||{};
  catalog.builder.pricingRules=Array.isArray(catalog.builder.pricingRules)?catalog.builder.pricingRules:[];
  catalog.builder.pricingRules=catalog.builder.pricingRules.map(r=>({count:Math.max(1,Number(r.count||1)),pricePerItem:Math.max(0,Number(r.pricePerItem||0))})).sort((a,b)=>a.count-b.count);
  return catalog.builder.pricingRules;
}
function addBuilderPricingRule(){
  const rules=normalizedBuilderPricingRules();
  const next=rules.length?Math.max(...rules.map(r=>Number(r.count||0)))+1:1;
  rules.push({count:next,pricePerItem:0});changed('.builderCard');renderCatalog();
}
function removeBuilderPricingRule(i){
  const rules=normalizedBuilderPricingRules();rules.splice(i,1);changed('.builderCard');renderCatalog();
}
function updateBuilderPricingRule(i,key,value){
  const rules=normalizedBuilderPricingRules();if(!rules[i])return;
  rules[i][key]=key==='count'?Math.max(1,Number(value||1)):Math.max(0,Number(value||0));
  rules.sort((a,b)=>a.count-b.count);changed('.builderCard');
}
async function uploadBuilderSpotlightImage(){
  const f=document.getElementById('builderSpotlightFile')?.files?.[0];if(!f)return alert('Önce fotoğraf seç.');
  const fd=new FormData();fd.append('files',f);
  const r=await fetch('/api/upload',{method:'POST',body:fd}).then(x=>x.json());
  if(!r.ok||!r.files?.[0])return alert(r.message||'Fotoğraf yüklenemedi.');
  catalog.builder=catalog.builder||{};catalog.builder.spotlight=catalog.builder.spotlight||{};catalog.builder.spotlight.imageUrl=r.files[0].url;
  changed('#builderSpotlight');renderCatalog();
}
function removeBuilderSpotlightImage(){catalog.builder=catalog.builder||{};catalog.builder.spotlight=catalog.builder.spotlight||{};catalog.builder.spotlight.imageUrl='';changed('#builderSpotlight');renderCatalog()}
function builderAdminProductsForCategory(categoryId){return (catalog.products||[]).filter(p=>!p.hidden&&!p.isSet&&p.category!=='setler'&&p.category===categoryId&&p.setEligible!==false)}

function ensureBuilderProductPricing(){
  catalog.builder=catalog.builder||{};
  catalog.builder.productPricing=(catalog.builder.productPricing&&typeof catalog.builder.productPricing==='object')?catalog.builder.productPricing:{};
  return catalog.builder.productPricing;
}
function builderLegacyPriceForCount(count){
  const rule=(catalog.builder?.pricingRules||[]).find(r=>Number(r.count)===Number(count));
  return rule?Number(rule.pricePerItem||0):null;
}
function builderPricingCategoryIds(){
  const ordered=builderOrderedCategoryIds();
  if(ordered.length)return ordered;
  return (catalog.categories||[]).filter(c=>c.id!=='tum'&&!isSetCategory(c.id)).sort((a,b)=>(a.order||0)-(b.order||0)).map(c=>c.id);
}
function builderPricingCountsForProduct(productId){
  catalog.builder=catalog.builder||{};
  const explicit=Object.keys(ensureBuilderProductPricing()[productId]||{}).map(Number).filter(n=>Number.isFinite(n)&&n>=2);
  const legacy=(catalog.builder?.pricingRules||[]).map(r=>Number(r.count)).filter(n=>Number.isFinite(n)&&n>=2);
  const saved=(Array.isArray(catalog.builder.pricingCounts)?catalog.builder.pricingCounts:[]).map(Number).filter(n=>Number.isFinite(n)&&n>=2&&n<=50);
  if(saved.length)return [...new Set([...saved,...explicit])].sort((a,b)=>a-b);
  const savedMax=Number(catalog.builder.pricingMaxCount||0);
  const maxBase=Math.max(7,builderPricingCategoryIds().length,...legacy,...explicit,savedMax);
  const max=Math.max(2,Math.min(50,maxBase));
  const out=[];for(let i=2;i<=max;i++)out.push(i);
  return out;
}
function addBuilderPricingCount(){
  catalog.builder=catalog.builder||{};
  const counts=builderPricingCountsForProduct(adminBuilderPricingProduct);
  const current=Math.max(1,...counts);
  const next=Math.min(50,current+1);
  if(current>=50)return alert('En fazla 50 ürünlü set fiyatı tanımlayabilirsin.');
  catalog.builder.pricingCounts=[...new Set([...counts,next])].sort((a,b)=>a-b);
  catalog.builder.pricingMaxCount=Math.max(...catalog.builder.pricingCounts);
  changed('.builderCard');
  refreshBuilderProductPricingAdmin();
}
function removeBuilderPricingCount(count){
  catalog.builder=catalog.builder||{};
  const n=Number(count);
  if(!Number.isFinite(n)||n<2)return;
  if(!confirm(`${n} ürünlü set fiyat alanı kaldırılsın mı? Bu adede özel girdiğin ürün fiyatları da temizlenecek.`))return;
  const counts=builderPricingCountsForProduct(adminBuilderPricingProduct).filter(x=>Number(x)!==n);
  catalog.builder.pricingCounts=counts;
  catalog.builder.pricingMaxCount=counts.length?Math.max(...counts):0;
  const pricing=ensureBuilderProductPricing();
  Object.keys(pricing).forEach(productId=>{
    if(pricing[productId]&&typeof pricing[productId]==='object'){
      delete pricing[productId][String(n)];
      if(!Object.keys(pricing[productId]).length)delete pricing[productId];
    }
  });
  changed('.builderCard');
  refreshBuilderProductPricingAdmin();
}
function renderBuilderProductPricingAdmin(){
  const pricing=ensureBuilderProductPricing();
  const catIds=builderPricingCategoryIds();
  if(!catIds.includes(adminBuilderPricingCategory))adminBuilderPricingCategory=catIds[0]||'';
  const category=(catalog.categories||[]).find(c=>c.id===adminBuilderPricingCategory);
  const products=category?builderAdminProductsForCategory(category.id):[];
  if(!products.some(p=>p.id===adminBuilderPricingProduct))adminBuilderPricingProduct=products[0]?.id||'';
  const selected=products.find(p=>p.id===adminBuilderPricingProduct)||null;
  const catsHtml=catIds.map(id=>{const c=catalog.categories.find(x=>x.id===id);return c?`<button type=button class="builderPricingCat ${id===adminBuilderPricingCategory?'active':''}" onclick="selectBuilderPricingCategory('${attr(id)}')">${esc(c.name)}</button>`:''}).join('');
  const productsHtml=products.length?products.map(p=>{const img=p.image||productImages(p)[0]||'';return `<button type=button class="builderPricingProduct ${p.id===adminBuilderPricingProduct?'active':''}" onclick="selectBuilderPricingProduct('${attr(p.id)}')">${img?`<span class=builderPricingProductImg><img src="${attr(img)}" alt=""></span>`:'<span class="builderPricingProductImg noImage">—</span>'}<span><b>${esc(p.name||'Yeni Ürün')}</b><small>${Number(p.price||0).toLocaleString('tr-TR')} TL tekli</small></span></button>`}).join(''):'<div class=help>Bu kategoride Kendi Setini Oluştur için açık ürün yok.</div>';
  let editor='<div class=help>Önce fiyatını ayarlamak istediğin ürünü seç.</div>';
  if(selected){
    const counts=builderPricingCountsForProduct(selected.id);
    const productMap=pricing[selected.id]||{};
    const img=selected.image||productImages(selected)[0]||'';
    editor=`<div class=builderPricingSelected><div class=builderPricingSelectedHead>${img?`<img src="${attr(img)}" alt="">`:''}<div><b>${esc(selected.name||'Yeni Ürün')}</b><small>Toplam sette kaç ürün olduğuna göre bu ürünün sete eklenecek fiyatını yaz.</small></div></div><div class=builderProductPriceGrid>${counts.map(count=>{const has=Object.prototype.hasOwnProperty.call(productMap,String(count));const own=has?Number(productMap[String(count)]):'';const single=Number(selected.price||0);return `<label class=builderProductPriceCell><span class=builderPriceCellHead><span>${count} ürünlü sette</span><button type=button class=builderPriceRemoveBtn title="${count} ürünlü alanı kaldır" aria-label="${count} ürünlü alanı kaldır" onclick="event.preventDefault();event.stopPropagation();removeBuilderPricingCount(${count})">×</button></span><input class=formControl type=number min=0 step=1 value="${has?own:''}" placeholder="Tekli fiyat: ${single.toLocaleString('tr-TR')} TL" oninput="setBuilderProductPrice('${attr(selected.id)}',${count},this.value)"><small>${has?'Bu ürüne özel fiyat':`Boşsa tekli gerçek fiyat: ${single.toLocaleString('tr-TR')} TL`}</small></label>`}).join('')}<button type=button class="builderProductPriceCell builderPriceAddCell" onclick="addBuilderPricingCount()"><span>${Math.max(...counts)+1} ürünlü sette</span><b>＋</b><small>Yeni adet kuralı ekle</small></button></div></div>`;
  }
  return `<div class=builderPricingAdmin id=builderProductPricingAdmin><div class=builderPricingTitle><b>Kendi Setini Oluştur özel fiyatları</b><span>Ürüne göre fiyatlandırma</span></div><div class=help>Önce kategori ve ürünü seç. Örneğin çakmak 3 ürünlü sette 100 TL, 5 ürünlü sette 15 TL olabilir. Bir adet için özel fiyatı boş bırakırsan o ürünün normal tekli satış fiyatı kullanılır.</div><div class=builderPricingCats>${catsHtml||'<span class=help>Önce Kendi Setini Oluştur için kategori aç.</span>'}</div><div class=builderPricingWorkspace><div class=builderPricingProducts>${productsHtml}</div><div class=builderPricingEditor>${editor}</div></div></div>`;
}
function refreshBuilderProductPricingAdmin(){
  const host=document.getElementById('builderProductPricingAdmin');
  if(host)host.outerHTML=renderBuilderProductPricingAdmin();
}
function selectBuilderPricingCategory(id){
  adminBuilderPricingCategory=id;adminBuilderPricingProduct='';
  refreshBuilderProductPricingAdmin();
}
function selectBuilderPricingProduct(id){
  adminBuilderPricingProduct=id;
  refreshBuilderProductPricingAdmin();
}
function setBuilderProductPrice(productId,count,value){
  const pricing=ensureBuilderProductPricing();
  pricing[productId]=(pricing[productId]&&typeof pricing[productId]==='object')?pricing[productId]:{};
  const v=String(value??'').trim();
  if(v==='')delete pricing[productId][String(count)];
  else pricing[productId][String(count)]=Math.max(0,Number(v||0));
  if(!Object.keys(pricing[productId]).length)delete pricing[productId];
  changed('.builderCard');
}
function toggleBuilderProduct(categoryId,productId,checked){
  catalog.builder=catalog.builder||{};catalog.builder.allowedProducts=(catalog.builder.allowedProducts&&typeof catalog.builder.allowedProducts==='object')?catalog.builder.allowedProducts:{};
  const all=builderAdminProductsForCategory(categoryId).map(p=>p.id);let list=Array.isArray(catalog.builder.allowedProducts[categoryId])?[...catalog.builder.allowedProducts[categoryId]]:[...all];
  if(checked){if(!list.includes(productId))list.push(productId)}else list=list.filter(id=>id!==productId);
  catalog.builder.allowedProducts[categoryId]=list.filter(id=>all.includes(id));
  const row=document.querySelector(`.builderOrderRow[data-builder-category="${CSS.escape(categoryId)}"]`);
  const em=row?.querySelector('.builderProductPicker summary em');if(em)em.textContent=`${catalog.builder.allowedProducts[categoryId].length}/${all.length}`;
  changed('.builderCard');
}

async function uploadCategoryCover(ci){
  const f=$('#catFile'+ci)?.files?.[0]; if(!f)return alert('Kategori fotoğrafı seç.');
  const fd=new FormData(); fd.append('files',f);
  const r=await fetch('/api/upload',{method:'POST',body:fd}).then(r=>r.json());
  if(r.files?.[0]){catalog.categories[ci].cover=r.files[0].url;await fetch('/api/admin/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings,catalog})});changed('#categoryHub');renderCatalog();}
}

function previewCategory(id,name){previewTo(`[data-category-id="${id}"]`,true);}
function productImages(p){
  const list=Array.isArray(p.images)?p.images.filter(Boolean):[];
  if(p.image&&!list.includes(p.image))list.unshift(p.image);
  return [...new Set(list)];
}
function productGalleryAdmin(p,i){
  const imgs=productImages(p);
  if(!imgs.length)return '<div class="help">Henüz ürün fotoğrafı yok.</div>';
  return `<div class=adminGallery>${imgs.map((url,gi)=>`<div class="adminGalleryItem ${url===p.image?'main':''}">
    <img src="${attr(url)}">
    <div class=adminGalleryActions>
      ${url===p.image?'<span>Ana fotoğraf</span>':`<button type=button onclick="makeMainPhoto(${i},${gi})">Ana yap</button>`}
      <button type=button onclick="removeProductPhoto(${i},${gi})">Kaldır</button>
    </div>
  </div>`).join('')}</div>`;
}
function updateProductFeatures(productId,value){
  const p=(catalog.products||[]).find(x=>x.id===productId);
  if(!p)return;
  p.features=String(value||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  changed(`[data-product-id=\"${productId}\"]`);
}
function syncVisibleProductFeatures(){
  document.querySelectorAll('[data-product-features-id]').forEach(el=>{
    const p=(catalog.products||[]).find(x=>x.id===el.dataset.productFeaturesId);
    if(p)p.features=String(el.value||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  });
}
function updateProductTextLayout(productId,kind,el){
  const p=(catalog.products||[]).find(x=>x.id===productId);
  if(!p||!el)return;
  const width=Math.round(el.getBoundingClientRect().width||0);
  if(width<180)return;
  const key=kind==='description'?'descriptionEditorWidth':'featuresEditorWidth';
  const wrapKey=kind==='description'?'descriptionWrapCh':'featuresWrapCh';
  p[key]=width;
  p[wrapKey]=Math.max(18,Math.min(120,Math.round(width/8)));
  changed(`[data-product-id="${productId}"]`);
}
function initProductTextLayoutEditors(){
  document.querySelectorAll('[data-product-layout-id]').forEach(el=>{
    if(el.dataset.resizeBound)return;
    el.dataset.resizeBound='1';
    const id=el.dataset.productLayoutId,kind=el.dataset.productLayoutKind;
    let timer=null;
    const ro=new ResizeObserver(()=>{clearTimeout(timer);timer=setTimeout(()=>updateProductTextLayout(id,kind,el),120)});
    ro.observe(el);
  });
}

function moveProductWithinCategory(productId,direction){
  const i=(catalog.products||[]).findIndex(x=>x.id===productId);
  if(i<0)return;
  const p=catalog.products[i];
  const same=(catalog.products||[]).map((x,idx)=>({x,idx})).filter(o=>o.x.category===p.category);
  const pos=same.findIndex(o=>o.idx===i);
  const other=same[pos+(direction<0?-1:1)];
  if(!other)return;
  [catalog.products[i],catalog.products[other.idx]]=[catalog.products[other.idx],catalog.products[i]];
  changed('#products');
  renderCatalog();
}
function productDragStart(e,id){
  adminDraggedProduct=id;
  document.addEventListener('dragover',adminProductDragViewport);
  const card=e.currentTarget?.closest('.adminProductCompact');
  card?.classList.add('dragging');
  if(e.dataTransfer){
    e.dataTransfer.effectAllowed='move';
    e.dataTransfer.setData('text/plain',id);
    try{e.dataTransfer.setData('application/x-shaz-product',id)}catch(_){ }
  }
}
function adminProductDragViewport(e){if(adminDraggedProduct)adminProductDragAutoScroll(e)}
function adminProductDragAutoScroll(e){
  const edge=150,maxStep=12,y=Number(e.clientY||0),h=window.innerHeight||document.documentElement.clientHeight||800;
  let step=0;if(y<edge)step=-Math.max(3,Math.round((edge-y)/edge*maxStep));else if(y>h-edge)step=Math.max(3,Math.round((y-(h-edge))/edge*maxStep));
  if(!step)return;
  const content=document.querySelector('.simpleAdmin .content');
  const canScrollContent=content&&content.scrollHeight>content.clientHeight+2;
  if(canScrollContent)content.scrollTop+=step;else window.scrollBy(0,step);
}
function productDragOver(e,id){
  if(!adminDraggedProduct||adminDraggedProduct===id)return;
  e.preventDefault();e.stopPropagation();
  adminProductDragAutoScroll(e);
  if(e.dataTransfer)e.dataTransfer.dropEffect='move';
  document.querySelectorAll('.adminProductCompact.dragOver').forEach(x=>x.classList.remove('dragOver'));
  e.currentTarget?.classList.add('dragOver');
}
function productDrop(e,targetId){
  e.preventDefault();e.stopPropagation();
  const sourceId=adminDraggedProduct||(e.dataTransfer?.getData('application/x-shaz-product')||e.dataTransfer?.getData('text/plain')||'');
  const products=catalog.products||[];
  const from=products.findIndex(p=>p.id===sourceId),to=products.findIndex(p=>p.id===targetId);
  if(from<0||to<0||from===to)return productDragEnd(e);
  const source=products[from],target=products[to];
  if(!source||!target||source.category!==target.category)return productDragEnd(e);
  // İki sütunlu yönetim görünümünde bırakılan kartla birebir yer değiştirir.
  // Önce/sonra tahmini kullanılmadığı için ürün yanlış aralığa sıçramaz.
  [products[from],products[to]]=[products[to],products[from]];
  adminDraggedProduct=null;
  changed('#products');
  renderCatalog();
}
function productDragEnd(e){
  adminDraggedProduct=null;
  document.removeEventListener('dragover',adminProductDragViewport);
  document.querySelectorAll('.adminProductCompact.dragging,.adminProductCompact.dragOver').forEach(x=>x.classList.remove('dragging','dragOver'));
}

function quickToggleProductHidden(productId){
  const p=(catalog.products||[]).find(x=>x.id===productId);
  if(!p)return;
  p.hidden=!p.hidden;
  changed('#products');
  renderCatalog();
}
function productCard(p,embedded=false){
  const i=catalog.products.findIndex(x=>x.id===p.id);
  const root=`[data-product-id="${p.id}"]`;
  const t=field=>`${root} [data-preview-field="${field}"]`;
  const setContentShortcut=p.isSet?renderInlineSetEditor(p,i):'';
  return `<article class=adminProductCard id="admin-product-${attr(p.id)}">
    <div class="field productNameField"><label><b>Ürün adı</b></label>
      <input class=formControl data-preview-target="${attr(t('name'))}" value="${attr(p.name)}"
        oninput="catalog.products[${i}].name=this.value;changed(this.dataset.previewTarget)">
    </div>
    <div class="field productSubtitleField"><label><b>Ürün alt başlığı</b></label>
      <input class=formControl value="${attr(p.subtitle||'')}" placeholder="Örn: Erkek kol saati · Yeni koleksiyon"
        oninput="catalog.products[${i}].subtitle=this.value;changed(this.dataset.previewTarget)" data-preview-target="${attr(root)}">
      <div class=help>Ürün detayına girildiğinde marka/model adının hemen altında görünür. Boş bırakırsan gösterilmez.</div>
    </div>
    ${productSubcategoryField(p,i)}

    <div class="field photoAdminCompact"><label><b>Ürün fotoğrafları</b></label>
      <div class=photoUploadRow><input id="prodFile${i}" data-preview-target="${attr(t('photo'))}" type=file accept="image/*" multiple><button class=smallBtn onclick="uploadProductImages(${i})">Fotoğraf Yükle</button><button type=button class=smallBtn onclick="openAdminProductImage('${attr(p.id)}')">Fotoğrafı Büyüt</button></div>
      ${productGalleryAdmin(p,i)}
    </div>

    <div class="field productTextField"><label><b>Ürün açıklaması</b></label>
      <textarea class="formControl productLayoutTextarea" data-product-layout-id="${attr(p.id)}" data-product-layout-kind="description" data-preview-target="${attr(t('description'))}" rows=3 style="width:${Math.max(240,Number(p.descriptionEditorWidth||420))}px" placeholder="Müşterinin ürün kartında okuyacağı kısa açıklama"
        oninput="catalog.products[${i}].description=this.value;changed(this.dataset.previewTarget)">${esc(p.description||'')}</textarea>
      <div class=help>Kutuyu sağ alt köşesinden genişletip daraltabilirsin; seçtiğin genişlik müşterideki satır kırılımına da yansır.</div>
    </div>

    <div class="field productTextField"><label><b>Özellikler / tikli maddeler</b></label>
      <textarea class="formControl productLayoutTextarea" data-product-layout-id="${attr(p.id)}" data-product-layout-kind="features" data-product-features-id="${attr(p.id)}" data-preview-target="${attr(root)}" rows=3 style="width:${Math.max(240,Number(p.featuresEditorWidth||420))}px" placeholder="Her satıra bir özellik yaz
UV400 koruma
Paslanmaz çelik kasa"
        oninput="updateProductFeatures('${attr(p.id)}',this.value)" onchange="updateProductFeatures('${attr(p.id)}',this.value)">${esc((Array.isArray(p.features)?p.features:String(p.features||'').split(/\r?\n/)).filter(Boolean).join('\n'))}</textarea>
      <div class=help>Her satır ayrı özellik olur. Kutuyu genişletip daralttığında müşterideki satır kırılımı da buna göre korunur.</div>
    </div>

    <div class="panel soldOutAdmin"><label class=setItemToggle><span><b>Sepete Ekle yerine “Tükendi” göster</b><small class=muted>İşaretliyken müşteri bu ürünü sepete ekleyemez.</small></span><input type=checkbox ${p.soldOutEnabled?'checked':''} onchange="catalog.products[${i}].soldOutEnabled=this.checked;if(!this.checked)catalog.products[${i}].soldOutUntil='';renderCatalog();changed('${attr(root)}')"></label>${p.soldOutEnabled?`<div class=field><label><b>Yeniden stok zamanı</b></label><input class=formControl type=datetime-local value="${attr(p.soldOutUntil||'')}" onchange="catalog.products[${i}].soldOutUntil=this.value;changed('${attr(root)}')"><div class=help>Ürün detayındaki kırmızı TÜKENDİ butonunun altında otomatik geri sayım olarak görünür.</div></div>`:''}</div>

    ${!p.isSet?`<label class=setItemToggle><span><b>Yazı işlemini müşteriye kapat</b><small class=muted>Örn. tesbihte yazı yapılmıyorsa bunu işaretle. Müşteriye yazı seçeneği hiç gösterilmez.</small></span><input type=checkbox ${p.writeEnabled===false?'checked':''} onchange="catalog.products[${i}].writeEnabled=!this.checked;changed('.drawer');previewProductStage('${attr(p.id)}','write')"></label>
    <div class=field><label><b>Yazı / kişiselleştirme konumları</b></label>
      <input class=formControl data-preview-target=".drawer" value="${attr((p.writePositions||[]).join(', '))}" placeholder="Örn: Arka kapak, Kordon"
        onfocus="previewProductStage('${attr(p.id)}','write')" oninput="catalog.products[${i}].writePositions=this.value.split(',').map(x=>x.trim()).filter(Boolean);syncPreferredSelect(this,'preferred-${attr(p.id)}',${i});changed(this.dataset.previewTarget);previewProductStage('${attr(p.id)}','write')">
      <div class=help>Örn. saatte “Arka kapak, Kordon”. Virgülle ayırdığın her ifade müşteride ayrı seçenek olur.</div>
    </div>
    <div class=field><label><b>⭐ Genelde tercih edilen</b></label>
      <select id="preferred-${attr(p.id)}" class=formControl onfocus="previewProductStage('${attr(p.id)}','write')" onchange="catalog.products[${i}].preferredWritePosition=this.value;changed('.drawer');previewProductStage('${attr(p.id)}','write')">
        ${preferredPositionOptions(p.writePositions||[],p.preferredWritePosition||'')}
      </select>
      <div class=help>Buradan bir konum seçersen müşteride o seçeneğin yanında <b>“Genelde tercih edilen”</b> yazar. Yazı konumunu yukarıda değiştirirken bu liste de anında güncellenir.</div>
    </div>`:''}
    ${adminIsWalletProduct(p)?`<div class=walletAdminBox>
      <label class=setItemToggle><span><b>📷 Cüzdana fotoğraf işleme</b><small class=muted>Müşteriye “Cüzdana fotoğraf işleme istiyorum” seçeneğini gösterir.</small></span><input type=checkbox ${p.walletPhotoEnabled!==false?'checked':''} onchange="catalog.products[${i}].walletPhotoEnabled=this.checked;changed('.drawer');previewProductStage('${attr(p.id)}','wallet-toggle')"></label>
      <div class=twoMini><div class=field><label><b>Fotoğraf işleme ücreti</b></label><input class=formControl type=number value="${Number(catalog.walletPhotoFee??25)}" onfocus="previewProductStage('${attr(p.id)}','wallet')" oninput="catalog.walletPhotoFee=Number(this.value);changed('.drawer');previewProductStage('${attr(p.id)}','wallet')"><div class=help>Normal yazı ücretlerinden bağımsız eklenir.</div></div></div>
      <div class=help>Bu kutunun tikini kaldırırsan fotoğraf seçeneği yalnızca bu cüzdanda müşteriye gösterilmez. Normal yazı seçenekleri etkilenmez.</div>
    </div>`:''}

    <div class=twoMini>
      <div class=field><label>Fiyat</label>
        <input class=formControl data-preview-target="${attr(t('price'))}" type=number value="${Number(p.price||0)}"
          oninput="catalog.products[${i}].price=Number(this.value);changed(this.dataset.previewTarget)">
      </div>
      <div class=field><label>Eski fiyat</label>
        <input class=formControl data-preview-target="${attr(t('oldPrice'))}" type=number value="${Number(p.oldPrice||0)}"
          oninput="catalog.products[${i}].oldPrice=Number(this.value);changed(this.dataset.previewTarget)">
      </div>
      <div class=field><label>Stok</label>
        <input class=formControl data-preview-target="${attr(t('stock'))}" type=number value="${Number(p.stock||0)}"
          oninput="catalog.products[${i}].stock=Number(this.value);changed(this.dataset.previewTarget)">
      </div>
      <div class=field><label>Ürün etiketi</label>
        <input class=formControl data-preview-target="${attr(t('badge'))}" value="${attr(p.badge||'')}" placeholder="Örn: Sınırlı stok, En çok satan"
          oninput="catalog.products[${i}].badge=this.value;changed(this.dataset.previewTarget)">
        <div class=help>Boş bırakırsan etiketi göstermez.</div>
      </div>
      <div class=field><label>Etiket rengi</label>
        <select class=formControl data-preview-target="${attr(t('badge'))}" onchange="catalog.products[${i}].badgeColor=this.value;changed(this.dataset.previewTarget)">
          <option value="orange" ${(p.badgeColor||'orange')==='orange'?'selected':''}>Turuncu</option>
          <option value="purple" ${p.badgeColor==='purple'?'selected':''}>Mor</option>
          <option value="red" ${p.badgeColor==='red'?'selected':''}>Kırmızı</option>
        </select>
      </div>
      <div class=field><label>Kart üzeri kısa şerit</label>
        <label class=shippingRibbonAdminToggle><input data-preview-target="${attr(root)}" type=checkbox ${p.shippingRibbonEnabled?'checked':''} onchange="catalog.products[${i}].shippingRibbonEnabled=this.checked;changed(this.dataset.previewTarget)"> Göster</label>
        <input class=formControl data-preview-target="${attr(root)}" value="${attr(p.shippingRibbonText||'Kargo Bedava')}" placeholder="Örn: Kargo Bedava" oninput="catalog.products[${i}].shippingRibbonText=this.value;changed(this.dataset.previewTarget)">
        <div class=shippingRibbonColorRow><input data-preview-target="${attr(root)}" type=color value="${attr(p.shippingRibbonColor||'#444444')}" oninput="catalog.products[${i}].shippingRibbonColor=this.value;changed(this.dataset.previewTarget)"><span>Şerit rengi</span></div>
        <div class=help>Yalnızca bu ürün kartının fotoğrafının alt kenarında görünür. Değişiklik yaptığında sağdaki müşteri önizlemesinde anında bu ürün kartı gösterilir.</div>
      </div>
    </div>

    <div class=productToggles>
      <label><input data-preview-target="${attr(root)}" type=checkbox ${p.hidden?'checked':''}
        onchange="catalog.products[${i}].hidden=this.checked;changed(this.dataset.previewTarget)"> Gizle</label>
      <label><input data-preview-target="${attr(root)}" type=checkbox ${p.isSet?'checked':''}
        onchange="catalog.products[${i}].isSet=this.checked;if(this.checked){catalog.products[${i}].setEligible=false;catalog.products[${i}].setItems=catalog.products[${i}].setItems||[]}changed(this.dataset.previewTarget);renderCatalog()"> Hazır set</label>
      <label><input data-preview-target="${attr(root)}" type=checkbox ${p.setEligible?'checked':''} ${p.isSet?'disabled':''}
        onchange="catalog.products[${i}].setEligible=this.checked;changed(this.dataset.previewTarget)"> Kendi sette kullanılabilir</label>
    </div>
    ${setContentShortcut}
    ${renderCopyProductSettingsPanel(p,i)}

    <div class=productAdminActions>
      ${embedded?'':`<button class=duplicateBtn onclick="duplicateProduct(${i})">⧉ Aynısını Çoğalt</button>`}
      <button class=dangerBtn onclick="deleteProduct(${i})">Ürünü Sil</button>
    </div>
  </article>`;
}
function renderInlineSetEditor(p,pi){
  const candidates=catalog.products.filter(x=>!x.isSet&&x.id!==p.id);
  const options=candidates.map(x=>`<option value="${attr(x.id)}">${esc(x.name)} — ${esc((catalog.categories.find(c=>c.id===x.category)||{}).name||'')}</option>`).join('');
  const rows=(p.setItems||[]).map((it,ii)=>{
    const linked=it.productId?catalog.products.find(x=>x.id===it.productId):null;
    return `<div class=setAdminRow data-set-admin-item="${attr(it.id)}">
      <div class=setAdminRowTitle><b>${ii+1}. ${esc(it.name||linked?.name||'İçerik')}</b><small>Müşterinin set içeriğinde ve “ürün çıkar” adımında göreceği kalem</small></div>
      <div class=field><label><b>Ürün / içerik adı</b></label><input class=formControl value="${attr(it.name||linked?.name||'')}" onfocus="previewSetStage('${attr(p.id)}','${attr(it.id)}','remove')" oninput="catalog.products[${pi}].setItems[${ii}].name=this.value;changedSetStage('${attr(p.id)}','${attr(it.id)}','remove')"><div class=help>Bu isim müşterinin setten ürün çıkarma ekranında aynen görünür.</div></div>
      <div class=field><label><b>Çıkarılırsa düşecek TL</b></label><input class=formControl type=number value="${Number(it.removeDiscount||0)}" onfocus="previewSetStage('${attr(p.id)}','${attr(it.id)}','remove')" oninput="catalog.products[${pi}].setItems[${ii}].removeDiscount=Number(this.value);changedSetStage('${attr(p.id)}','${attr(it.id)}','remove')"><div class=help>Müşteri bu ürünü setten çıkarırsa set toplamından tam bu tutar düşer.</div></div>
      <label class=setItemToggle><span><b>Yazı işlemini müşteriye kapat</b><small class=muted>Bu set içindeki bu üründe yazı yapılamıyorsa işaretle.</small></span><input type=checkbox ${adminSetItemWriteEnabled(it)?'':'checked'} onchange="catalog.products[${pi}].setItems[${ii}].writeEnabled=!this.checked;changedSetStage('${attr(p.id)}','${attr(it.id)}','write')"></label>
      <div class=field><label><b>Yazı konumları</b></label><input class=formControl value="${attr((it.writePositions||linked?.writePositions||[]).join(', '))}" placeholder="Arka kapak, Kordon" onfocus="previewSetStage('${attr(p.id)}','${attr(it.id)}','write')" oninput="catalog.products[${pi}].setItems[${ii}].writePositions=this.value.split(',').map(x=>x.trim()).filter(Boolean);syncSetPreferredSelect('set-pref-inline-${attr(p.id)}-${attr(it.id)}',${pi},${ii});changedSetStage('${attr(p.id)}','${attr(it.id)}','write')"><div class=help>Virgülle ayırdığın her ifade müşteriye ayrı seçim olur: “Arka kapak, Kordon” → 2 seçenek.</div></div>
      <div class=field><label><b>Genelde tercih edilen konum</b></label><select id="set-pref-inline-${attr(p.id)}-${attr(it.id)}" class=formControl onfocus="previewSetStage('${attr(p.id)}','${attr(it.id)}','write')" onchange="catalog.products[${pi}].setItems[${ii}].preferredWritePosition=this.value;changedSetStage('${attr(p.id)}','${attr(it.id)}','write')">${preferredPositionOptions(it.writePositions||linked?.writePositions||[],it.preferredWritePosition||linked?.preferredWritePosition||'')}</select><div class=help>Yazı konumunu değiştirirken seçenekler anında yenilenir; seçtiğin konum müşteride “Genelde tercih edilen” olarak görünür.</div></div>
      ${adminIsWalletSetItem(it)?`<label class=setItemToggle><span><b>📷 Bu sette cüzdan fotoğrafı göster</b><small class=muted>Kapatırsan müşteriye bu set içindeki cüzdan için fotoğraf seçeneği sunulmaz.</small></span><input type=checkbox ${it.walletPhotoEnabled!==false && linked?.walletPhotoEnabled!==false?'checked':''} onchange="catalog.products[${pi}].setItems[${ii}].walletPhotoEnabled=this.checked;changedSetStage('${attr(p.id)}','${attr(it.id)}','write')"></label>`:''}
      <button class=dangerBtn onclick="removeSetItem(${pi},${ii});renderCatalog()">Bu İçeriği Setten Çıkar</button>
    </div>`;
  }).join('');
  return `<details class="inlineSetEditor simpleAdminDetails"><summary>Set içeriği <small>${(p.setItems||[]).length} ürün/parça tanımlı</small></summary><div class=simpleDetailsBody>
    <div class=setFlowExplain><b>Bu alan müşteride neyi değiştirir?</b><span>Sette hangi ürünlerin bulunduğunu, müşterinin hangi ürünü çıkarabileceğini, çıkınca kaç TL düşeceğini ve yazı konumlarını belirler.</span></div>
    <div class=setAddBar><select id="inlineSetAdd-${attr(p.id)}" class=formControl><option value="">Katalogdan ürün seç...</option>${options}</select><button class=smallBtn onclick="addExistingProductToInlineSet('${attr(p.id)}')">＋ Seçili Ürünü Ekle</button><button class=smallBtn onclick="addBlankInlineSetItem('${attr(p.id)}')">＋ Listede Yoksa Elle Ekle</button></div>
    ${rows||'<div class=emptyAdmin>Henüz set içeriği yok. Yukarıdan katalog ürünü seç veya elle içerik ekle.</div>'}
  </div></details>`;
}
function rerenderInlineSetEditorStable(setId){
  adminOpenProduct=setId;
  preserveAdminViewport(()=>renderCatalog());
  requestAnimationFrame(()=>{
    const article=document.getElementById('admin-product-'+setId);
    const details=article?.querySelector('.inlineSetEditor');
    if(details)details.open=true;
  });
}
function addExistingProductToInlineSet(setId){
  const set=catalog.products.find(x=>x.id===setId),sel=$('#inlineSetAdd-'+CSS.escape(setId));
  if(!set||!sel?.value)return alert('Önce bir ürün seç.');
  const p=catalog.products.find(x=>x.id===sel.value);if(!p)return;
  set.setItems=set.setItems||[];
  set.setItems.push({id:'setitem-'+Date.now()+'-'+Math.random().toString(36).slice(2,5),productId:p.id,name:p.name,type:(catalog.categories.find(c=>c.id===p.category)||{}).name||p.category,removeDiscount:Number(p.price||0),writePositions:[...(p.writePositions||[])],preferredWritePosition:p.preferredWritePosition||'',walletPhotoEnabled:p.walletPhotoEnabled!==false});
  changed('.drawer');rerenderInlineSetEditorStable(setId);
}
function addBlankInlineSetItem(setId){
  const set=catalog.products.find(x=>x.id===setId);if(!set)return;
  set.setItems=set.setItems||[];
  set.setItems.push({id:'setitem-'+Date.now()+'-'+Math.random().toString(36).slice(2,5),productId:'',name:'Yeni içerik',type:'',removeDiscount:0,writePositions:[],preferredWritePosition:'',writeEnabled:true,walletPhotoEnabled:true});
  changed('.drawer');rerenderInlineSetEditorStable(setId);
}
function renderCopyProductSettingsPanel(p,i){
  const categories=catalog.categories.filter(c=>c.id!=='tum').sort((a,b)=>(a.order||0)-(b.order||0));
  const groups=categories.map(c=>{
    const products=catalog.products.filter(x=>x.category===c.id&&x.id!==p.id);
    if(!products.length)return '';
    return `<details class=copyCategoryGroup><summary>${esc(c.name)} <small>${products.length} ürün</small></summary><div class=copyProductList>
      <label class=copySelectAll><input type=checkbox onchange="toggleCopyCategory('${attr(p.id)}','${attr(c.id)}',this.checked)"> Bu kategoridekilerin hepsini seç</label>
      ${products.map(x=>`<label><input type=checkbox class="copyTarget-${attr(p.id)} copyCat-${attr(p.id)}-${attr(c.id)}" value="${attr(x.id)}"> ${esc(x.name||'Yeni Ürün')}</label>`).join('')}
    </div></details>`;
  }).join('');
  return `<details class="copySettingsPanel simpleAdminDetails"><summary>Ürün ayarlarını diğer ürünlerde kullan <small>İstediğin ayarları seçip topluca uygula</small></summary><div class=simpleDetailsBody>
    <div class=copySettingsExplain><b>Nasıl çalışır?</b> Bu üründe yaptığın ayarlardan hangilerini çoğaltmak istediğini seç, sonra hedef kategori/ürünleri işaretle. <b>Fotoğraflar ve stok güvenlik için otomatik kopyalanmaz.</b></div>
    <div class=copyFieldChoices>
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=name> Ürün adı</label>
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=subtitle> Ürün alt başlığı</label>
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=description checked> Açıklama</label>
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=features checked> Özellikler</label>
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=writePositions checked> Yazı konumları + tercih edilen konum</label>
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=writeEnabled> Yazı işlemi açık/kapalı</label>
      ${adminIsWalletProduct(p)?`<label><input type=checkbox class="copyField-${attr(p.id)}" value=walletPhotoEnabled> Cüzdan fotoğraf işleme açık/kapalı</label>`:''}
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=price> Fiyat</label>
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=oldPrice> Eski fiyat</label>
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=badge> Ürün etiketi + etiket rengi</label>
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=shippingRibbon> Kart şeridi / Kargo Bedava + yazı + renk</label>
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=setEligible> Kendi sette kullanılabilir</label>
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=hidden> Ürün görünürlüğü (Gizle)</label>
      ${p.isSet?`<label><input type=checkbox class="copyField-${attr(p.id)}" value=setItems> Set içeriği + çıkarılınca düşecek TL + yazı konumları</label>`:''}
    </div>
    <label class="copySelectAll copySelectAllGlobal"><input type=checkbox onchange="toggleCopyAllTargets('${attr(p.id)}',this.checked)"> Tüm ürünleri seç</label><div class=copyCategoryGroups>${groups||'<div class=emptyAdmin>Kopyalanabilecek başka ürün yok.</div>'}</div>
    <button class=btn onclick="applyProductInfoToSelected('${attr(p.id)}')">Seçtiğim Bilgileri İşaretli Ürünlere Uygula</button>
    <div class=help>Bu işlem fotoğrafları değiştirmez. Set içeriğini seçersen yalnızca hazır set olan hedeflere set içeriği kopyalanır.</div>
  </div></details>`;
}
function toggleCopyAllTargets(sourceId,checked){
  document.querySelectorAll(`.copyTarget-${CSS.escape(sourceId)}`).forEach(x=>x.checked=checked);
  document.querySelectorAll(`.copyCategoryGroup .copySelectAll input`).forEach(x=>x.checked=checked);
}
function toggleCopyCategory(sourceId,catId,checked){
  document.querySelectorAll(`.copyCat-${CSS.escape(sourceId)}-${CSS.escape(catId)}`).forEach(x=>x.checked=checked);
}
function applyProductInfoToSelected(sourceId){
  const src=catalog.products.find(x=>x.id===sourceId);if(!src)return;
  const fields=[...document.querySelectorAll(`.copyField-${CSS.escape(sourceId)}:checked`)].map(x=>x.value);
  const targetIds=[...document.querySelectorAll(`.copyTarget-${CSS.escape(sourceId)}:checked`)].map(x=>x.value);
  if(!fields.length)return alert('Önce kopyalanacak en az bir bilgi seç.');
  if(!targetIds.length)return alert('Önce en az bir hedef ürün seç.');
  if(!confirm(`${targetIds.length} ürüne seçtiğin bilgiler uygulansın mı?`))return;
  let count=0;
  targetIds.forEach(id=>{
    const t=catalog.products.find(x=>x.id===id);if(!t)return;
    fields.forEach(f=>{
      if(f==='name')t.name=src.name||'';
      else if(f==='subtitle')t.subtitle=src.subtitle||'';
      else if(f==='description')t.description=src.description||'';
      else if(f==='features')t.features=[...(src.features||[])];
      else if(f==='writePositions'){t.writePositions=[...(src.writePositions||[])];t.preferredWritePosition=src.preferredWritePosition||'';}
      else if(f==='writeEnabled')t.writeEnabled=src.writeEnabled!==false;
      else if(f==='walletPhotoEnabled' && adminIsWalletProduct(t))t.walletPhotoEnabled=src.walletPhotoEnabled!==false;
      else if(f==='price')t.price=Number(src.price||0);
      else if(f==='oldPrice')t.oldPrice=Number(src.oldPrice||0);
      else if(f==='badge'){t.badge=src.badge||'';t.badgeColor=src.badgeColor||'orange';}
      else if(f==='shippingRibbon'){t.shippingRibbonEnabled=!!src.shippingRibbonEnabled;t.shippingRibbonText=src.shippingRibbonText||'Kargo Bedava';t.shippingRibbonColor=src.shippingRibbonColor||'#444444';}
      else if(f==='setEligible' && !t.isSet)t.setEligible=src.setEligible!==false;
      else if(f==='hidden')t.hidden=!!src.hidden;
      else if(f==='setItems' && src.isSet && t.isSet){t.setItems=(src.setItems||[]).map((it,n)=>({...JSON.parse(JSON.stringify(it)),id:'setitem-'+Date.now()+'-'+n+'-'+Math.random().toString(36).slice(2,5)}));}
    });
    count++;
  });
  changed('#products');renderCatalog();
  alert(`${count} ürüne seçtiğin bilgiler uygulandı. Kalıcı olması için “Değişiklikleri Kaydet”e bas.`);
}

function deleteCategory(categoryId){
  const c=(catalog.categories||[]).find(x=>x.id===categoryId);if(!c)return;
  const productCount=(catalog.products||[]).filter(p=>p.category===categoryId).length;
  if(productCount){alert(`“${c.name||'Bu kategori'}” içinde ${productCount} ürün var. Ürün kaybını önlemek için önce ürünleri başka kategoriye taşı veya sil.`);return;}
  if(!confirm(`“${c.name||'Bu kategori'}” kategorisi silinsin mi?`))return;
  catalog.categories=(catalog.categories||[]).filter(x=>x.id!==categoryId);
  if(catalog.builder){
    catalog.builder.allowedCategories=(catalog.builder.allowedCategories||[]).filter(id=>id!==categoryId);
    catalog.builder.categoryOrder=(catalog.builder.categoryOrder||[]).filter(id=>id!==categoryId);
    if(catalog.builder.allowedProducts&&typeof catalog.builder.allowedProducts==='object')delete catalog.builder.allowedProducts[categoryId];
  }
  (catalog.categories||[]).filter(x=>x.id!=='tum').sort((a,b)=>(a.order||0)-(b.order||0)).forEach((x,i)=>x.order=i+1);
  adminOpenCategory=(catalog.categories||[]).filter(x=>x.id!=='tum').sort((a,b)=>(a.order||0)-(b.order||0))[0]?.id||null;
  adminOpenProduct=null;adminProductSearch='';adminCategoryNavScrollLeft=0;
  changed('#products');renderCatalog();
}
function addCategory(){
  const id='kategori-'+Date.now();
  catalog.categories.push({id,name:'Yeni Kategori',order:catalog.categories.length+1,hidden:false,cover:''});
  changed('#products');renderCatalog();
}
function isSetCategory(categoryId){
  const c=catalog.categories.find(x=>x.id===categoryId);
  const n=String(c?.name||'').trim().toLocaleLowerCase('tr-TR');
  return categoryId==='setler'||n==='set'||n==='setler';
}
function addProduct(categoryId){
  const id='urun-'+Date.now();
  const readySet=isSetCategory(categoryId);
  catalog.products.push({id,name:'Yeni Ürün',subtitle:'',description:'',features:[],category:categoryId,price:0,oldPrice:0,stock:0,badge:'',badgeColor:'orange',image:'',images:[],hidden:false,setEligible:!readySet,isSet:readySet,setItems:[],writePositions:[],preferredWritePosition:'',writeEnabled:true,walletPhotoEnabled:true,subcategoryId:''});
  adminOpenCategory=categoryId;adminProductSearch='';adminOpenProduct=id;
  changed('#products');renderCatalog();
  setTimeout(()=>document.getElementById('admin-product-'+id)?.scrollIntoView({behavior:'smooth',block:'nearest'}),80);
}
function duplicateProduct(i){
  const source=catalog.products[i];
  if(!source)return;
  const copy=JSON.parse(JSON.stringify(source));
  copy.id='urun-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);
  copy.name=(source.name||'Yeni Ürün')+' Kopya';
  // Fotoğraflar bilinçli olarak kopyalanmaz; yeni ürün yeni görsel bekler.
  copy.image='';
  copy.images=[];
  if(Array.isArray(copy.setItems))copy.setItems=copy.setItems.map((x,n)=>({...x,id:'setitem-'+Date.now()+'-'+n+'-'+Math.random().toString(36).slice(2,5)}));
  catalog.products.splice(i+1,0,copy);
  adminOpenCategory=copy.category;
  adminProductSearch='';
  adminOpenProduct=copy.id;
  changed('#products');
  renderCatalog();
  setTimeout(()=>document.getElementById('admin-product-'+copy.id)?.scrollIntoView({behavior:'smooth',block:'center'}),80);
}
function deleteProduct(i){if(confirm('Ürün silinsin mi?')){catalog.products.splice(i,1);changed('#products');renderCatalog()}}
async function uploadProductImages(i){
  const fsx=[...($('#prodFile'+i)?.files||[])];if(!fsx.length)return alert('En az bir fotoğraf seç.');
  const fd=new FormData();fsx.forEach(f=>fd.append('files',f));
  const btn=$('#prodFile'+i)?.parentElement?.querySelector('button');if(btn){btn.disabled=true;btn.textContent=`${fsx.length} fotoğraf yükleniyor...`;}
  try{
    const r=await fetch('/api/upload',{method:'POST',body:fd}).then(r=>r.json());
    if(!r.ok)throw new Error(r.message||'Yükleme başarısız.');
    const pid=catalog.products[i].id;
    const current=productImages(catalog.products[i]);
    const added=(r.files||[]).map(x=>x.url);
    catalog.products[i].images=[...new Set([...current,...added])];
    if(!catalog.products[i].image)catalog.products[i].image=catalog.products[i].images[0]||'';
    const saved=await fetch('/api/admin/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({settings,catalog})}).then(x=>x.json());
    if(!saved.ok)throw new Error(saved.message||'Fotoğraf bağlantıları kaydedilemedi.');
    changed(`[data-product-id="${pid}"] [data-preview-field="photo"]`);
    renderCatalog();
    setTimeout(()=>previewTo(`[data-product-id="${pid}"] [data-preview-field="photo"]`,false),80);
  }catch(e){alert(e.message||'Fotoğraflar yüklenemedi.');}
  finally{if(btn){btn.disabled=false;btn.textContent='Seçilen Fotoğrafları Yükle';}}
}
function makeMainPhoto(i,gi){
  const imgs=productImages(catalog.products[i]),url=imgs[gi];if(!url)return;
  catalog.products[i].images=imgs;catalog.products[i].image=url;
  changed(`[data-product-id="${catalog.products[i].id}"] [data-preview-field="photo"]`);renderCatalog();
}
function removeProductPhoto(i,gi){
  const imgs=productImages(catalog.products[i]);const removed=imgs[gi];imgs.splice(gi,1);
  catalog.products[i].images=imgs;
  if(catalog.products[i].image===removed)catalog.products[i].image=imgs[0]||'';
  changed(`[data-product-id="${catalog.products[i].id}"] [data-preview-field="photo"]`);renderCatalog();
}

function renderCustom(){
  catalog.personalizationPricing=catalog.personalizationPricing||{first:75,second:50,thirdPlus:25};
  catalog.builder=catalog.builder||{allowedCategories:[],categoryOrder:[],pricingRules:[]};
  const pricing=catalog.personalizationPricing;
  const readySets=catalog.products.filter(p=>p.isSet);
  const sets=readySets.map(p=>renderSetAdminPanel(p)).join('');
  const allowed=catalog.categories.filter(c=>c.id!=='tum'&&c.id!=='setler').map(c=>{
    const checked=(catalog.builder.allowedCategories||[]).includes(c.id);
    return `<label class=setItemToggle><span><b>${esc(c.name)}</b><small class=muted>Set oluşturma ekranında kategori adımı</small></span><input type=checkbox ${checked?'checked':''} onclick="event.stopPropagation()" onchange="toggleBuilderCategory('${attr(c.id)}',this.checked)"></label>`;
  }).join('');
  shell('Setler & Kişiselleştirme','Hazır set içeriğini, ürünü çıkarınca düşecek fiyatı ve yazı konumlarını burada yönetirsin. Her alanın altında müşteride neyi değiştirdiği yazıyor; alana dokununca sağdaki telefon ilgili adımı kırmızı çerçeveyle gösterir.',
  `<details class="panel simpleAdminDetails"><summary>Yazı ücretleri <small>Kişiselleştirme fiyatları</small></summary><div class="grid2 simpleDetailsBody">
    ${input('İlk ürün yazısı','catalog.personalizationPricing.first',pricing.first,'İlk seçilen yazılı ürün.','.drawer','number')}
    ${input('İkinci ürün yazısı','catalog.personalizationPricing.second',pricing.second,'İkinci seçilen yazılı ürün.','.drawer','number')}
    ${input('3. ve sonrası','catalog.personalizationPricing.thirdPlus',pricing.thirdPlus,'Üçüncü ve sonraki her ürün.','.drawer','number')}
    ${input('Cüzdana fotoğraf işleme','catalog.walletPhotoFee',catalog.walletPhotoFee??25,'Fotoğraf işlemesi yazı ücretlerinden bağımsızdır; her fotoğraf için bu tutar ayrıca eklenir.','.drawer','number')}
  </div></details>
  <details class="panel simpleAdminDetails"><summary>Kendi Setini Oluştur <small>Kullanılacak kategoriler</small></summary><div class=simpleDetailsBody><div class=help>Müşteri set oluştururken hangi kategori adımlarını göreceğini seç.</div><div class=setItemList>${allowed}</div></div></details>
  ${renderBulkSetSettings(readySets)}
  <div class="panel readySetsIntro"><h2>Hazır Setler</h2><div class=help>Tek bir sete özel farklılık gerekiyorsa o seti aç. Normalde ortak ayarları yukarıdan tek seferde uygulaman yeterli.</div></div>
  ${sets||'<div class=panel><b>Henüz hazır set yok.</b><div class=help>Kategoriler & Ürünler bölümünden bir üründe “Hazır set” seçeneğini aç.</div></div>'}`);
}
function normalizeSetGroupName(v){
  return String(v||'').trim().toLocaleLowerCase('tr-TR').replace(/\s+/g,' ');
}
function setItemGroupInfo(it){
  const linked=it.productId?catalog.products.find(x=>x.id===it.productId):null;
  const linkedCat=linked?(catalog.categories.find(c=>c.id===linked.category)||{}).name:'';
  const label=(it.type||linkedCat||it.name||linked?.name||'Set ürünü').trim();
  return {key:normalizeSetGroupName(label),label,linked};
}
function getBulkSetGroups(sets){
  const groups=new Map();
  sets.forEach(set=>(set.setItems||[]).forEach(it=>{
    const info=setItemGroupInfo(it);if(!info.key)return;
    if(!groups.has(info.key))groups.set(info.key,{key:info.key,label:info.label,count:0,removeDiscount:Number(it.removeDiscount||0),writePositions:[...(it.writePositions||info.linked?.writePositions||[])],preferredWritePosition:it.preferredWritePosition||info.linked?.preferredWritePosition||'',sampleSetId:set.id,sampleItemId:it.id});
    groups.get(info.key).count++;
  }));
  return [...groups.values()].map(g=>{
    const draft=setBulkDraft[g.key];
    return draft?{...g,...draft}:g;
  });
}
function renderBulkSetSettings(sets){
  const groups=getBulkSetGroups(sets);
  if(!sets.length)return '';
  return `<details class="panel simpleAdminDetails bulkSetSettings"><summary>Ortak set ayarları <small>${sets.length} hazır sete tek tuşla uygula</small></summary>
    <div class=simpleDetailsBody>
      <div class=bulkSetNote><b>Ne işe yarar?</b> Örneğin bütün setlerde “Cüzdan çıkarılırsa 180 TL düşsün” veya “Saat yazısı Arka kapak / Kordon olsun” diyorsan tek tek set açma. Değeri burada yazıp alttaki butona bas. <b>Set içeriğine ürün eklemez, ürün silmez.</b></div>
      <div class=bulkSetRows>${groups.map(g=>`<div class=bulkSetRow>
        <div class=bulkSetName><b>${esc(g.label)}</b><small>${g.count} sette/kalemde kullanılıyor</small></div>
        <div class=field><label>Setten çıkarılırsa düşecek fiyat</label><input class=formControl type=number value="${Number(g.removeDiscount||0)}" onfocus="previewSetStage('${attr(g.sampleSetId)}','${attr(g.sampleItemId)}','remove')" oninput='setBulkDraft[${JSON.stringify(g.key)}]={...(setBulkDraft[${JSON.stringify(g.key)}]||{}),removeDiscount:Number(this.value)}'><div class=help>Müşteri “bu ürünü istemiyorum” derse set toplamından bu tutar düşer. Sağdaki telefon çıkarma adımını gösterir.</div></div>
        <div class=field><label>Yazı konumları</label><input class=formControl value="${attr((g.writePositions||[]).join(', '))}" placeholder="Örn: Arka kapak, Kordon" onfocus="previewSetStage('${attr(g.sampleSetId)}','${attr(g.sampleItemId)}','write')" oninput='setBulkDraft[${JSON.stringify(g.key)}]={...(setBulkDraft[${JSON.stringify(g.key)}]||{}),writePositions:this.value.split(",").map(x=>x.trim()).filter(Boolean)}'><div class=help>Virgülle ayırdığın her ifade müşteriye ayrı seçim olur. Örn. “Arka kapak, Kordon” → iki seçenek çıkar.</div></div>
        <div class=field><label>Genelde tercih edilen konum</label><select class=formControl onfocus="previewSetStage('${attr(g.sampleSetId)}','${attr(g.sampleItemId)}','write')" onchange='setBulkDraft[${JSON.stringify(g.key)}]={...(setBulkDraft[${JSON.stringify(g.key)}]||{}),preferredWritePosition:this.value}'>${preferredPositionOptions(g.writePositions||[],g.preferredWritePosition||'')}</select><div class=help>Bu ortak gruptaki setlerde müşteriye hangi konumu tavsiye edeceğini seçer.</div></div>
      </div>`).join('')||'<div class=emptyAdmin>Hazır setlerin içinde henüz ürün yok.</div>'}</div>
      ${groups.length?'<button class="btn bulkApplyBtn" onclick="applyBulkSetSettings()">Bu Ortak Ayarları Tüm Hazır Setlere Uygula</button>':''}
    </div>
  </details>`;
}
function applyBulkSetSettings(){
  const sets=catalog.products.filter(p=>p.isSet);
  const groups=getBulkSetGroups(sets);
  let changedCount=0;
  groups.forEach(g=>{
    const draft=setBulkDraft[g.key]||{removeDiscount:g.removeDiscount,writePositions:g.writePositions,preferredWritePosition:g.preferredWritePosition};
    sets.forEach(set=>(set.setItems||[]).forEach(it=>{
      if(setItemGroupInfo(it).key!==g.key)return;
      it.removeDiscount=Number(draft.removeDiscount??g.removeDiscount??0);
      it.writePositions=[...(draft.writePositions??g.writePositions??[])];
      it.preferredWritePosition=draft.preferredWritePosition??g.preferredWritePosition??'';
      changedCount++;
    }));
  });
  changed('.drawer');
  setBulkDraft={};
  renderCustom();
  alert(`${changedCount} set içi ürün satırı topluca güncellendi. Değişiklikleri Kaydet'e basınca kalıcı olur.`);
}
function renderSetAdminPanel(p){
  const pi=catalog.products.findIndex(x=>x.id===p.id);
  const candidates=catalog.products.filter(x=>!x.isSet && x.id!==p.id);
  const options=candidates.map(x=>`<option value="${attr(x.id)}">${esc(x.name)} — ${esc((catalog.categories.find(c=>c.id===x.category)||{}).name||'')}</option>`).join('');
  const rows=(p.setItems||[]).map((it,ii)=>{
    const linked=it.productId?catalog.products.find(x=>x.id===it.productId):null;
    return `<div class=setAdminRow data-set-admin-item="${attr(it.id)}">
      <div class=setAdminRowTitle><b>${ii+1}. İçerik</b><small>Müşterinin sette göreceği ürün/parça</small></div>
      <div class=field><label><b>Ürün / içerik adı</b></label><input class=formControl value="${attr(it.name||linked?.name||'')}" onfocus="previewSetStage('${attr(p.id)}','${attr(it.id)}','remove')" oninput="catalog.products[${pi}].setItems[${ii}].name=this.value;changedSetStage('${attr(p.id)}','${attr(it.id)}','remove')"><div class=help>${linked?'Katalogdan bağlı: '+esc(linked.name):'Elle tanımlı içerik.'} Bu isim müşterinin “setten ürün çıkarma” ekranında aynen görünür.</div></div>
      <div class=field><label><b>Setten çıkarılırsa düşecek fiyat</b></label><input class=formControl type=number value="${Number(it.removeDiscount||0)}" onfocus="previewSetStage('${attr(p.id)}','${attr(it.id)}','remove')" oninput="catalog.products[${pi}].setItems[${ii}].removeDiscount=Number(this.value);changedSetStage('${attr(p.id)}','${attr(it.id)}','remove')"><div class=help>Müşteri bu içeriğin tikini kaldırırsa set fiyatından tam olarak bu tutar düşer.</div></div>
      <label class=setItemToggle><span><b>Yazı işlemini müşteriye kapat</b><small class=muted>Bu set içindeki bu üründe yazı yapılamıyorsa işaretle.</small></span><input type=checkbox ${adminSetItemWriteEnabled(it)?'':'checked'} onchange="catalog.products[${pi}].setItems[${ii}].writeEnabled=!this.checked;changedSetStage('${attr(p.id)}','${attr(it.id)}','write')"></label>
      <div class=field><label><b>Yazı konumları</b></label><input class=formControl value="${attr((it.writePositions||linked?.writePositions||[]).join(', '))}" placeholder="Arka kapak, Kordon" onfocus="previewSetStage('${attr(p.id)}','${attr(it.id)}','write')" oninput="catalog.products[${pi}].setItems[${ii}].writePositions=this.value.split(',').map(x=>x.trim()).filter(Boolean);syncSetPreferredSelect('set-pref-${attr(p.id)}-${attr(it.id)}',${pi},${ii});changedSetStage('${attr(p.id)}','${attr(it.id)}','write')"><div class=help>Virgülden önce/sonra yazdığın her ifade müşteriye ayrı konum seçeneği olur. Örn. “Arka kapak, Kordon”.</div></div>
      <div class=field><label><b>Genelde tercih edilen konum</b></label><select id="set-pref-${attr(p.id)}-${attr(it.id)}" class=formControl onfocus="previewSetStage('${attr(p.id)}','${attr(it.id)}','write')" onchange="catalog.products[${pi}].setItems[${ii}].preferredWritePosition=this.value;changedSetStage('${attr(p.id)}','${attr(it.id)}','write')">${preferredPositionOptions(it.writePositions||linked?.writePositions||[],it.preferredWritePosition||linked?.preferredWritePosition||'')}</select><div class=help>Yazı konumunu değiştirirken seçenekler anında yenilenir; seçtiğin konum müşteride tavsiye ibaresiyle gösterilir.</div></div>
      <button class=dangerBtn onclick="removeSetItem(${pi},${ii})">Bu İçeriği Setten Çıkar</button>
    </div>`;
  }).join('');
  return `<details class="panel setAdminDetails" data-set-admin="${attr(p.id)}"><summary><span><b>${esc(p.name)}</b><small>${(p.setItems||[]).length} içerik tanımlı</small></span><span class=setDetailsOpenText>Aç / Düzenle</span></summary><div class=setAdminDetailsBody>
    <div class=setFlowExplain><b>Bu bölüm müşteride neyi belirler?</b><span>① Setin içinde hangi ürünler var → ② Müşteri hangisini çıkarabilir ve kaç TL düşer → ③ Yazı isterse hangi konumları seçebilir.</span></div>
    <div class=setAddBar><select id="setAdd-${attr(p.id)}" class=formControl><option value="">Katalogdan ürün seç...</option>${options}</select><button class=smallBtn onclick="addExistingProductToSet('${attr(p.id)}')">＋ Seçili Ürünü Ekle</button><button class=smallBtn onclick="addBlankSetItem('${attr(p.id)}')">＋ Listede Yoksa Elle Ekle</button></div>
    <div class=help>Sette olmayan ürünü ekleme. Örneğin sette Saat + Gözlük + Kemer varsa yalnızca onları ekle; Cüzdan yoksa ekleme. Künye gibi listede olmayan bir şey varsa “Elle Ekle” ile adını yaz.</div>
    ${rows||'<div class=emptyAdmin>Bu setin içeriği henüz tanımlı değil. Yukarıdan katalogdan seç veya elle içerik ekle.</div>'}
  </div></details>`;
}
function openSetEditor(setId){
  const p=catalog.products.find(x=>x.id===setId);if(!p)return;
  adminOpenCategory=p.category;adminProductSearch='';adminOpenProduct=p.id;
  show('catalog');
  requestAnimationFrame(()=>document.getElementById('admin-product-'+p.id)?.scrollIntoView({behavior:'smooth',block:'center'}));
}
function addExistingProductToSet(setId){
  const set=catalog.products.find(x=>x.id===setId),sel=$('#setAdd-'+CSS.escape(setId));
  if(!set||!sel?.value)return alert('Önce bir ürün seç.');
  const p=catalog.products.find(x=>x.id===sel.value); if(!p)return;
  set.setItems=set.setItems||[];
  set.setItems.push({id:'setitem-'+Date.now(),productId:p.id,name:p.name,type:(catalog.categories.find(c=>c.id===p.category)||{}).name||p.category,removeDiscount:Number(p.price||0),writePositions:[...(p.writePositions||[])],preferredWritePosition:p.preferredWritePosition||'',walletPhotoEnabled:p.walletPhotoEnabled!==false});
  changed('.drawer');renderCustom();
}
function addBlankSetItem(setId){
  const set=catalog.products.find(x=>x.id===setId); if(!set)return;
  set.setItems=set.setItems||[];set.setItems.push({id:'setitem-'+Date.now(),name:'Yeni içerik',type:'',removeDiscount:0,writePositions:[],preferredWritePosition:'',writeEnabled:true,walletPhotoEnabled:true});
  changed('.drawer');renderCustom();
}
function removeSetItem(pi,ii){
  if(!confirm('Bu ürün set içeriğinden çıkarılsın mı?'))return;
  catalog.products[pi].setItems.splice(ii,1);changed('.drawer');renderCustom();
}
function toggleBuilderCategory(id,checked){
  catalog.builder.allowedCategories=catalog.builder.allowedCategories||[];
  catalog.builder.categoryOrder=catalog.builder.categoryOrder||[];
  if(checked){if(!catalog.builder.allowedCategories.includes(id))catalog.builder.allowedCategories.push(id);if(!catalog.builder.categoryOrder.includes(id))catalog.builder.categoryOrder.push(id)}
  else{catalog.builder.allowedCategories=catalog.builder.allowedCategories.filter(x=>x!==id);catalog.builder.categoryOrder=catalog.builder.categoryOrder.filter(x=>x!==id)}
  const rows=document.getElementById('builderOrderRows');if(rows)rows.innerHTML=renderBuilderOrderRowsHtml();
  if(!checked&&adminBuilderPricingCategory===id){adminBuilderPricingCategory='';adminBuilderPricingProduct=''}
  refreshBuilderProductPricingAdmin();
  changed('.builderCard');
}

let orderCache=[];
async function renderOrders(){
  orderCache=await fetch('/api/orders').then(r=>r.json());
  const html=`<div class=panel><div class=orderToolbar>
    <div class=field><label><b>Tarih</b></label><input id=orderDate class=formControl type=date onchange=paintOrders()></div>
    <div class=field><label><b>Durum</b></label><select id=orderStatusFilter class=formControl onchange=paintOrders()><option value=all>Tümü</option><option value=new>Yeni</option><option value=prepared>Hazırlandı</option><option value=shipped>Kargoya Verildi</option><option value=notexported>Excel’e Aktarılmadı</option><option value=exported>Excel’e Aktarıldı</option></select></div>
    <button class=smallBtn onclick="selectVisibleOrders(true)">Görünenlerin Hepsini Seç</button><button class=smallBtn onclick="selectVisibleOrders(false)">Seçimi Kaldır</button>
    <button class=smallBtn onclick="exportOrdersExcel()">⬇ Siparişleri Excel'e Aktar</button>
    <button class=smallBtn onclick="syncOrdersToSheet(event)">↻ E-Tablo'ya Şimdi Gönder</button>
    <button class=smallBtn onclick="testSheetConnection(event)">🔌 E-Tablo Bağlantısını Test Et</button>
  </div><div id=sheetSyncStatus class=sheetSyncStatus>Google E-Tablo durumu kontrol ediliyor…</div><div class=bulkStatus><b>Seçilen siparişleri:</b><button class=statusNew onclick="bulkOrderStatus('new')">Yeni</button><button class=statusPrepared onclick="bulkOrderStatus('prepared')">✓ Hazırlandı</button><button class=statusShipped onclick="bulkOrderStatus('shipped')">📦 Kargoya Verildi</button></div></div><div id=ordersList></div>`;
  shell('Siparişler','Tarihe göre bakabilir, siparişleri tek tek veya toplu seçebilir, Hazırlandı/Kargoya Verildi durumunu verebilir ve hepsini Excel’e aktarabilirsin.',html);paintOrders();loadSheetSyncStatus();
}
async function exportOrdersExcel(){
  const btn=event?.currentTarget;
  if(btn){btn.disabled=true;btn.textContent='Excel hazırlanıyor...';}
  try{
    const r=await fetch('/api/orders/export.xlsx');
    if(!r.ok)throw new Error('Excel oluşturulamadı');
    const blob=await r.blob();
    const cd=r.headers.get('Content-Disposition')||'';
    const m=cd.match(/filename=([^;]+)/i);
    const filename=m?m[1].replace(/["']/g,''):'SHAZ-Siparisler.xlsx';
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);

    // Sunucu indirdiğimiz siparişleri işaretledi; paneli anında yenile.
    orderCache=await fetch('/api/orders').then(x=>x.json());
    paintOrders();
  }catch(e){alert(e.message||'Excel indirilemedi.');}
  finally{
    if(btn){btn.disabled=false;btn.textContent="⬇ Siparişleri Excel'e Aktar";}
  }
}
function orderLocalDate(o){
  const tr=String(o?.createdAtTR||'').trim();
  const m=tr.match(/^(\d{2})[.\/-](\d{2})[.\/-](\d{4})/);
  if(m)return `${m[3]}-${m[2]}-${m[1]}`;
  try{
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(o?.createdAt||''));
    const val=Object.fromEntries(parts.map(x=>[x.type,x.value]));
    if(val.year&&val.month&&val.day)return `${val.year}-${val.month}-${val.day}`;
  }catch(e){}
  return String(o?.createdAt||'').slice(0,10);
}
function filteredOrders(){
  const d=$('#orderDate')?.value||'';
  const st=$('#orderStatusFilter')?.value||'all';
  return orderCache.filter(o=>{
    const dateOk=!d||orderLocalDate(o)===d;
    let statusOk=true;
    if(st==='notexported')statusOk=!o.excelExportedAt;
    else if(st==='exported')statusOk=!!o.excelExportedAt;
    else if(st!=='all')statusOk=(o.status||'new')===st;
    return dateOk&&statusOk;
  });
}
async function loadSheetSyncStatus(){
  const box=$('#sheetSyncStatus'); if(!box)return;
  try{
    const r=await fetch('/api/orders/sync-status'); const d=await r.json();
    if(!r.ok)throw new Error(d.message||'Durum alınamadı');
    const cfg=d.configured?'✅ Render bağlantı bilgileri mevcut':'❌ Render bağlantı bilgileri eksik';
    const pend=d.pending?` · ${d.pending} sipariş E-Tablo bekliyor`:' · Bekleyen sipariş yok';
    const err=d.lastError?`<br><b>Son hata:</b> ${esc(d.lastError)}`:'';
    box.className='sheetSyncStatus '+(d.pending||!d.configured?'warn':'ok');
    box.innerHTML=`<b>Google E-Tablo:</b> ${cfg}${pend}${err}`;
  }catch(e){box.className='sheetSyncStatus warn';box.textContent='Google E-Tablo durumu okunamadı: '+e.message}
}
async function syncOrdersToSheet(ev){
  const b=ev?.currentTarget; if(b){b.disabled=true;b.textContent='Gönderiliyor…'}
  try{const r=await fetch('/api/orders/sync',{method:'POST'});const d=await r.json();if(!r.ok)throw new Error(d.message||'Senkronizasyon başarısız');await loadSheetSyncStatus();orderCache=await fetch('/api/orders').then(x=>x.json());paintOrders()}
  catch(e){alert('E-Tablo senkronizasyon hatası: '+e.message)}
  finally{if(b){b.disabled=false;b.textContent="↻ E-Tablo'ya Şimdi Gönder"}}
}
async function testSheetConnection(ev){
  const b=ev?.currentTarget;if(b){b.disabled=true;b.textContent='Test ediliyor…'}
  try{
    const r=await fetch('/api/orders/sheets-test',{method:'POST'});
    const d=await r.json();
    if(!r.ok||!d.ok){const err=new Error(d.message||'Bağlantı başarısız');err.code=d.code||'';throw err}
    alert('Google E-Tablo bağlantısı çalışıyor. '+(d.version?('Apps Script '+d.version):''));
  }catch(e){
    if(e.code==='OLD_APPS_SCRIPT')alert('Google E-Tablo bağlantısı VAR; sorun Render keylerinde değil.\n\n'+e.message);
    else alert('Google E-Tablo bağlantı hatası: '+e.message);
  }
  finally{if(b){b.disabled=false;b.textContent='🔌 E-Tablo Bağlantısını Test Et'};loadSheetSyncStatus()}
}
function paintOrders(){const list=$('#ordersList');if(!list)return;const os=filteredOrders();list.innerHTML=os.length?os.map(orderCard).join(''):'<div class=panel>Bu filtrede sipariş yok.</div>'}
function selectVisibleOrders(on){document.querySelectorAll('.orderSelect').forEach(x=>x.checked=on)}
async function bulkOrderStatus(status){const ids=[...document.querySelectorAll('.orderSelect:checked')].map(x=>x.value);if(!ids.length)return alert('Önce en az bir sipariş seç.');await fetch('/api/orders/status',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids,status})});orderCache=await fetch('/api/orders').then(r=>r.json());paintOrders()}
async function oneOrderStatus(id,status){await fetch('/api/orders/status',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[id],status})});orderCache=await fetch('/api/orders').then(r=>r.json());paintOrders()}
function statusText(s){return s==='shipped'?'Kargoya Verildi':s==='prepared'?'Hazırlandı':'Yeni'}
function orderCard(o){
  const c=o.customer||{}; const st=o.status||'new';
  const addr=c.deliveryMode==='branch'?`Aras Kargo Şube Teslim · ${c.branchName||''} · ${c.district||''} · ${c.province||''}`:[c.neighborhood,c.fullAddress||c.avenue,c.street,c.buildingNo?`Bina ${c.buildingNo}`:'',c.floor?`Kat ${c.floor}`:'',c.doorNo?`Daire ${c.doorNo}`:'',c.district,c.province].filter(Boolean).join(' · ');
  return `<div class="orderAdminCard status-${st}">
    <div class=orderAdminTop><div class=orderIdentity><input class=orderSelect type=checkbox value="${esc(o.id)}"><div><b class=orderId>${esc(o.id)}</b><div class=orderTime>🗓 ${esc(o.createdAtTR||formatTR(o.createdAt))}</div>${o.sheetSyncStatus==='synced'?`<div class=sheetSynced>✅ Google E-Tablo'ya düştü</div>`:`<div class=sheetPending>⏳ Google E-Tablo bekliyor${o.sheetSyncError?` · ${esc(o.sheetSyncError)}`:''}</div>`}${o.excelExportedAt?`<div class=excelExported>📊 Excel’e Aktarıldı · ${esc(o.excelExportedAtTR||formatTR(o.excelExportedAt))}</div>`:`<div class=excelNotExported>● İndirilen Excel’e aktarılmadı</div>`}</div></div><div><span class="statusBadge ${st}">${statusText(st)}</span><div class=orderTotal>₺${Number(o.total||0).toLocaleString('tr-TR')}</div></div></div>
    <div class=orderColumns><div><h4>Müşteri</h4><b>${esc(c.fullName||'Adres bilgisi eski siparişte yok')}</b><br>${esc(c.phone||'')} ${c.extraPhone?`<br>2. Tel: ${esc(c.extraPhone)}`:''}<br><span class=muted>${esc(addr)}</span>${c.placeType==='business'?`<br><b>İş yeri:</b> ${esc(c.businessName||'')}`:''}${c.note?`<br><b>Not:</b> ${esc(c.note)}`:''}</div><div><h4>Sipariş İçeriği</h4>${(o.items||[]).map(orderItemDetails).join('')}</div></div>
    <div class=orderActions><button onclick="oneOrderStatus('${esc(o.id)}','new')">Yeni</button><button onclick="oneOrderStatus('${esc(o.id)}','prepared')">✓ Hazırlandı</button><button onclick="oneOrderStatus('${esc(o.id)}','shipped')">📦 Kargoya Verildi</button></div>
    <div class=orderMeta>Ödeme: <b>${o.payment==='cod'?'Kapıda ödeme':'Online ödeme'}</b> · Kişiye özel onay: <b>${o.personalApproval?.approved?'ALINDI':'YOK'}</b> · Kargo bilgilendirmesi: <b>${o.shippingNoticeAccepted?'GÖRÜLDÜ':'YOK'}</b></div>
  </div>`;
}
function orderItemDetails(x){
  const name=x.product?.name||'Ürün';
  let d=`<div class=orderLine><b>${esc(name)}</b> — ₺${Number(x.product?.price||0).toLocaleString('tr-TR')}`;

  // Hazır setin içindeki tüm parçaları tekrar yazmıyoruz.
  // Yalnızca müşteri bir parça çıkardıysa gösteriyoruz.
  if(x.setCustomization){
    const removed=(x.setCustomization.removedIds||[])
      .map(id=>(x.product?.setItems||[]).find(s=>s.id===id)?.name)
      .filter(Boolean);
    if(removed.length)d+=`<div class=orderSub><b>Setten çıkarılan:</b> ${removed.map(esc).join(', ')}</div>`;
  }

  // Sadece gerçekten seçilmiş kişiselleştirmeleri göster.
  const writes=x.writes||x.setCustomization?.writes||[];
  if(writes.length)d+=`<div class=orderWrites><b>Yazdırılacaklar:</b>${writes.map(w=>`<div>✍️ ${esc(w.item||name)} — ${esc(w.position||'')} → <b>“${esc(w.text||'')}”</b>${Number(w.fee||0)?` (+₺${Number(w.fee).toLocaleString('tr-TR')})`:''}</div>`).join('')}</div>`;
  const photos=x.photoCustomizations||x.setCustomization?.photoCustomizations||[];
  if(photos.length)d+=`<div class=orderWrites><b>Fotoğraf işlemesi:</b>${photos.map(ph=>`<div class=orderPhotoCustomization>🖼️ ${esc(ph.item||'Cüzdan')} · +₺${Number(ph.fee||catalog.walletPhotoFee||25).toLocaleString('tr-TR')}${ph.imageUrl?` · <a href="${attr(ph.imageUrl)}" target="_blank" rel="noopener">Fotoğrafı aç</a>`:''}${ph.caption?`<br>Yazı: <b>“${esc(ph.caption)}”</b> · ${ph.captionPosition==='above'?'Fotoğrafın üstünde':'Fotoğrafın altında'}`:''}</div>`).join('')}</div>`;

  return d+'</div>';
}
function formatTR(iso){
  if(!iso)return '';
  try{return new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',dateStyle:'short',timeStyle:'medium'}).format(new Date(iso))}catch(e){return iso}
}
load();

/* V116 - Sepet sonu ekstra ürün önerileri: kararlı yönetim, görseller, tümünü seç, ürün bazlı fiyat */
function upsellCategoryOptions(selected=''){
  return `<option value="">Kategori seç</option>`+(catalog.categories||[]).filter(c=>c.id!=='tum'&&!c.hidden).map(c=>`<option value="${attr(c.id)}" ${String(selected)===String(c.id)?'selected':''}>${esc(c.name||c.id)}</option>`).join('');
}
function upsellProductsFor(rule,mode){const catId=mode==='trigger'?rule.triggerCategoryId:rule.offerCategoryId;return (catalog.products||[]).filter(p=>!p.hidden&&catId&&p.category===catId)}
function upsellRerender(i){renderUpsells(i)}
function upsellProductChecks(rule,index,mode){
  const catId=mode==='trigger'?rule.triggerCategoryId:rule.offerCategoryId,key=mode==='trigger'?'triggerProductIds':'offerProductIds',selected=new Set(rule[key]||[]),ps=upsellProductsFor(rule,mode);
  if(!catId)return '<div class=help>Önce kategori seç.</div>';
  const allOn=ps.length&&ps.every(p=>selected.has(p.id));
  return `<div class="upsellBulkRow"><button type="button" class=smallBtn onclick="setAllUpsellProducts(${index},'${mode}',${allOn?'false':'true'})">${allOn?'Tümünün seçimini kaldır':'Tümünü seç'}</button><small>${selected.size} ürün seçili</small></div><div class="campaignScopeProductGrid upsellProductGrid">${ps.map(p=>{const img=p.image||(p.images||[])[0]||'';return `<label class="campaignProductChoice upsellProductChoice"><input type=checkbox ${selected.has(p.id)?'checked':''} onchange="toggleUpsellProduct(${index},'${mode}','${attr(p.id)}',this.checked)">${img?`<img src="${attr(img)}" alt="">`:''}<span><b>${esc(p.name||'Ürün')}</b><small>${Number(p.price||0).toLocaleString('tr-TR')} TL</small></span></label>`}).join('')||'<div class=help>Bu kategoride ürün yok.</div>'}</div>`;
}
function upsellOfferProductsEditor(rule,index){
  const ps=upsellProductsFor(rule,'offer'),selected=new Set(rule.offerProductIds||[]);rule.productPrices=rule.productPrices||{};
  if(!rule.offerCategoryId)return '<div class=help>Önce önerilecek kategoriyi seç.</div>';
  const allOn=ps.length&&ps.every(p=>selected.has(p.id));
  return `<div class="upsellBulkRow"><button type="button" class=smallBtn onclick="setAllUpsellProducts(${index},'offer',${allOn?'false':'true'})">${allOn?'Tümünün seçimini kaldır':'Tümünü seç'}</button><small>${selected.size} ürün seçili</small></div><div class=upsellInlineBulk><input id="upsellBulkPrice-${index}" class=formControl type=number min=0 placeholder="Hepsine aynı fiyat"><button type=button class=smallBtn onclick="applyUpsellBulkPrice(${index})">Hepsine uygula</button></div><div class=upsellSelectPriceGrid>${ps.map(p=>{const img=p.image||(p.images||[])[0]||'',v=rule.productPrices[p.id]??rule.specialPrice??0;return `<div class=upsellSelectPriceRow><label class=upsellSelectMain><input type=checkbox ${selected.has(p.id)?'checked':''} onchange="toggleUpsellProduct(${index},'offer','${attr(p.id)}',this.checked)">${img?`<img src="${attr(img)}" alt="">`:''}<span><b>${esc(p.name||'Ürün')}</b><small>Normal: ${Number(p.price||0).toLocaleString('tr-TR')} TL</small></span></label><label class=upsellInlinePrice><span>Özel fiyat</span><input class=formControl type=number min=0 value="${attr(v)}" oninput="setUpsellProductPrice(${index},'${attr(p.id)}',this.value)"></label></div>`}).join('')||'<div class=help>Bu kategoride ürün yok.</div>'}</div>`;
}
function upsellPriceEditor(rule,index){
  const ps=upsellProductsFor(rule,'offer'),selected=new Set(rule.offerProductIds||[]),shown=(rule.offerMode||'all')==='all'?ps:ps.filter(p=>selected.has(p.id));rule.productPrices=rule.productPrices||{};
  if(!rule.offerCategoryId)return '';
  return `<div class="campaignScopeBox upsellPricesBox"><div class=upsellBulkPrice><b>Ürün bazlı özel fiyatlar</b><div><input id="upsellBulkPrice-${index}" class=formControl type=number min=0 placeholder="Hepsine aynı fiyat"><button type=button class=smallBtn onclick="applyUpsellBulkPrice(${index})">Hepsine uygula</button></div></div><div class=upsellPriceGrid>${shown.map(p=>{const img=p.image||(p.images||[])[0]||'',v=rule.productPrices[p.id]??rule.specialPrice??0;return `<div class=upsellPriceRow>${img?`<img src="${attr(img)}" alt="">`:''}<span><b>${esc(p.name||'Ürün')}</b><small>Normal: ${Number(p.price||0).toLocaleString('tr-TR')} TL</small></span><label>Özel fiyat<input class=formControl type=number min=0 value="${attr(v)}" oninput="setUpsellProductPrice(${index},'${attr(p.id)}',this.value)"></label></div>`}).join('')||'<div class=help>Fiyat girmek için önerilecek ürün seç.</div>'}</div></div>`;
}
function renderUpsells(openIndex=null){
  catalog.checkoutUpsells=Array.isArray(catalog.checkoutUpsells)?catalog.checkoutUpsells:[];
  const cards=catalog.checkoutUpsells.map((r,i)=>`<details class="panel simpleAdminDetails" ${openIndex===i?'open':''}><summary><span>${esc(r.name||('Öneri '+(i+1)))}</span><small>${r.enabled!==false?'Aktif':'Kapalı'}</small></summary><div class=simpleDetailsBody>
    <div class=campaignRuleHead><label class=setItemToggle><span><b>Öneri aktif</b><small class=muted>Kapalıyken müşteriye gösterilmez.</small></span><input type=checkbox ${r.enabled!==false?'checked':''} onchange="catalog.checkoutUpsells[${i}].enabled=this.checked;changed('.drawer')"></label><button class=dangerBtn onclick="removeUpsell(${i})">Öneriyi Sil</button></div>
    <div class=grid2>${input('Yönetim adı',`catalog.checkoutUpsells[${i}].name`,r.name||'Yeni ekstra ürün önerisi','Sadece yönetimde ayırt etmek için.','.drawer')}
    <div class=field><label><b>Müşteri hangi kategoriden ürün aldığında?</b></label><select class=formControl onchange="catalog.checkoutUpsells[${i}].triggerCategoryId=this.value;catalog.checkoutUpsells[${i}].triggerProductIds=[];upsellRerender(${i})">${upsellCategoryOptions(r.triggerCategoryId||'')}</select><div class=help>Bu kategori tetikleyicidir.</div></div>
    <div class=field><label><b>Bu kategoride hangi ürünler tetiklesin?</b></label><select class=formControl onchange="catalog.checkoutUpsells[${i}].triggerMode=this.value;upsellRerender(${i})"><option value=all ${(r.triggerMode||'all')==='all'?'selected':''}>Kategorideki tüm ürünler</option><option value=selected ${r.triggerMode==='selected'?'selected':''}>Sadece işaretlediğim ürünler</option></select></div>
    <div class=field><label><b>Müşteriye hangi kategoriyi öner?</b></label><select class=formControl onchange="catalog.checkoutUpsells[${i}].offerCategoryId=this.value;catalog.checkoutUpsells[${i}].offerProductIds=[];catalog.checkoutUpsells[${i}].productPrices={};upsellRerender(${i})">${upsellCategoryOptions(r.offerCategoryId||'')}</select><div class=help>Kategori seçilince o kategorideki ürünler aşağıda açılır.</div></div>
    <div class=field><label><b>Önerilecek ürünler</b></label><select class=formControl onchange="catalog.checkoutUpsells[${i}].offerMode=this.value;upsellRerender(${i})"><option value=all ${(r.offerMode||'all')==='all'?'selected':''}>Kategorideki tüm ürünler</option><option value=selected ${r.offerMode==='selected'?'selected':''}>Sadece işaretlediğim ürünler</option></select></div>
    ${input('Varsayılan özel fiyat (TL)',`catalog.checkoutUpsells[${i}].specialPrice`,Number(r.specialPrice||0),'Ürün bazında ayrı fiyat girmezsen bu fiyat kullanılır.','.drawer','number')}</div>
    ${(r.triggerMode==='selected')?`<div class=campaignScopeBox><b>Tetikleyecek ürünleri seç</b>${upsellProductChecks(r,i,'trigger')}</div>`:''}
    <div class=campaignScopeBox><b>Önerilecek ürünleri seç ve özel fiyatını gir</b>${upsellOfferProductsEditor(r,i)}</div>
  </div></details>`).join('');
  shell('Ekstra Ürün Önerileri','Müşteri “Teslimat ve Ödemeye Geç” dediğinde seçtiğin koşula göre son ürün önerisi gösterilir.',`<div class=panel><div class=campaignCreateRow><div><h2>Sepet Sonu Önerileri</h2><div class=help>Kategori, ürün ve ürün bazlı özel fiyatları ayrı ayrı yönetebilirsin.</div></div><button class=btn onclick=addUpsell()>+ Öneri Ekle</button></div></div>${cards||'<div class=panel><b>Henüz ekstra ürün önerisi yok.</b></div>'}`);
}
function addUpsell(){catalog.checkoutUpsells=catalog.checkoutUpsells||[];catalog.checkoutUpsells.push({id:'upsell-'+Date.now(),name:'Yeni ekstra ürün önerisi',enabled:true,triggerCategoryId:'',triggerMode:'all',triggerProductIds:[],offerCategoryId:'',offerMode:'all',offerProductIds:[],specialPrice:0,productPrices:{}});renderUpsells(catalog.checkoutUpsells.length-1)}
function removeUpsell(i){if(confirm('Bu öneri silinsin mi?')){catalog.checkoutUpsells.splice(i,1);renderUpsells()}}
function toggleUpsellProduct(i,mode,id,on){const r=catalog.checkoutUpsells[i],key=mode==='trigger'?'triggerProductIds':'offerProductIds';r[key]=r[key]||[];if(on&&!r[key].includes(id))r[key].push(id);if(!on)r[key]=r[key].filter(x=>x!==id);changed('.drawer');if(mode==='offer')renderUpsells(i)}
function setAllUpsellProducts(i,mode,on){const r=catalog.checkoutUpsells[i],key=mode==='trigger'?'triggerProductIds':'offerProductIds';r[key]=on?upsellProductsFor(r,mode).map(p=>p.id):[];renderUpsells(i)}
function setUpsellProductPrice(i,id,value){const r=catalog.checkoutUpsells[i];r.productPrices=r.productPrices||{};r.productPrices[id]=Math.max(0,Number(value||0));changed('.drawer')}
function applyUpsellBulkPrice(i){const r=catalog.checkoutUpsells[i],el=document.getElementById('upsellBulkPrice-'+i),v=Math.max(0,Number(el?.value||0));r.specialPrice=v;r.productPrices=r.productPrices||{};const selected=new Set(r.offerProductIds||[]);upsellProductsFor(r,'offer').filter(p=>(r.offerMode||'all')==='all'||selected.has(p.id)).forEach(p=>r.productPrices[p.id]=v);renderUpsells(i)}

