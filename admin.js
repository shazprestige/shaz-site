
let settings={},catalog={};
let adminOpenCategory=null,adminProductSearch="",adminOpenProduct=null;
let adminDraggedCategory=null;
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

async function logoutAdmin(){
  await fetch('/api/admin/logout',{method:'POST'});
  location.href='/admin/login';
}
async function load(){
  settings=await fetch('/api/settings').then(r=>r.json());
  catalog=await fetch('/api/catalog').then(r=>r.json());
  catalog.walletPhotoFee=Number(catalog.walletPhotoFee??25);
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
  show('site');
  setTimeout(()=>{sendPreview();previewTo('header')},600);
}
async function saveAll(){
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

function show(tab){
  const adminRoot=document.querySelector('.simpleAdmin');
  const preview=document.querySelector('.previewPane');
  const isOrders=tab==='orders';
  if(preview) preview.style.display=isOrders?'none':'block';
  if(adminRoot) adminRoot.classList.toggle('ordersMode',isOrders);

  if(tab==='site')return renderSite();
  if(tab==='catalog')return renderCatalog();
  if(tab==='custom')return renderCatalog();
  if(tab==='orders')return renderOrders();
}
function campaignCategoryOptions(selected='tum'){
  const seen=new Set();
  const cats=[{id:'tum',name:'Tüm Ürünler'},...(catalog.categories||[]).filter(c=>!c.hidden&&c.id!=='tum')];
  return cats.filter(c=>c?.id&&!seen.has(c.id)&&seen.add(c.id)).map(c=>`<option value="${attr(c.id)}" ${String(selected||'tum')===String(c.id)?'selected':''}>${esc(c.name||c.id)}</option>`).join('');
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
  const pricing=catalog.personalizationPricing;
  const allowed=catalog.categories.filter(c=>c.id!=='tum'&&!isSetCategory(c.id)).map(c=>{
    const checked=(catalog.builder.allowedCategories||[]).includes(c.id);
    return `<label class=setItemToggle><span><b>${esc(c.name)}</b><small class=muted>Müşterinin kendi setini oluştururken seçebileceği kategori</small></span><input type=checkbox ${checked?'checked':''} onchange="toggleBuilderCategory('${attr(c.id)}',this.checked)"></label>`;
  }).join('');
  const categoryOptions=catalog.categories.filter(c=>c.id!=='tum').sort((a,b)=>(a.order||0)-(b.order||0)).map(c=>`<option value="${attr(c.id)}">${esc(c.name)}</option>`).join('');
  return `<div class="panel unifiedCatalogSettings">
    <details class=simpleAdminDetails><summary>Genel ürün / set ayarları <small>Ürünlerle ilgili ortak ayarlar</small></summary><div class=simpleDetailsBody>
      <div class=grid3>
        ${input('İlk ürün yazısı','catalog.personalizationPricing.first',pricing.first,'Müşteri ilk ürüne yazı eklerse uygulanacak ücret.','.drawer','number')}
        ${input('İkinci ürün yazısı','catalog.personalizationPricing.second',pricing.second,'Müşteri ikinci ürüne yazı eklerse uygulanacak ücret.','.drawer','number')}
        ${input('3. ve sonrası','catalog.personalizationPricing.thirdPlus',pricing.thirdPlus,'Üçüncü ve sonraki her yazılı ürün için ücret.','.drawer','number')}
        ${input('Cüzdana fotoğraf işleme','catalog.walletPhotoFee',catalog.walletPhotoFee??25,'Fotoğraf işlemesi normal yazı ücretlerinden bağımsız ek ücrettir.','.drawer','number')}
      </div>
      <details class=nestedAdminDetails><summary>Kendi Setini Oluştur kategorileri</summary><div class=setItemList>${allowed}</div><div class=help>Burada seçtiklerin yalnızca müşterinin “Kendi Setini Oluştur” akışında görünür.</div></details>
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
      catalog.products.push({id,name:`Yeni Ürün ${start+n+1}`,description:'',features:[],category:categoryId,price:0,oldPrice:0,stock:0,badge:'',badgeColor:'orange',image:f.url,images:[f.url],hidden:false,setEligible:!readySet,isSet:readySet,setItems:[],writePositions:[],preferredWritePosition:''});
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

function renderCatalog(){
  const cats=catalog.categories.filter(c=>c.id!=='tum').sort((a,b)=>(a.order||0)-(b.order||0));
  if(!adminOpenCategory||!cats.some(c=>c.id===adminOpenCategory))adminOpenCategory=cats[0]?.id||null;
  const nav=cats.map(c=>{
    const count=catalog.products.filter(p=>p.category===c.id).length;
    return `<button class="categoryJumpBtn ${adminOpenCategory===c.id?'active':''}" draggable="true" data-category-drag-id="${attr(c.id)}" onclick="jumpAdminCategory('${attr(c.id)}')" ondragstart="categoryDragStart(event,'${attr(c.id)}')" ondragover="categoryDragOver(event,'${attr(c.id)}')" ondrop="categoryDrop(event,'${attr(c.id)}')" ondragend="categoryDragEnd(event)"><span class=categoryDragGrip aria-hidden=true>⠿</span>${esc(c.name)} <span>${count}</span></button>`;
  }).join('');
  const active=cats.find(c=>c.id===adminOpenCategory);
  let html=catalogGlobalTools()+`<div class="panel catalogControlPanel">
    <div class=campaignAdminHead><div><h2>Kategoriler & Ürünler</h2><div class=help>Kategori seç; yalnızca o kategorinin ürünleri açılır. Sıralamayı değiştirmek için kategori başlıklarını sürükleyip bırak.</div></div><button class=btn style="max-width:200px" onclick=addCategory()>＋ Kategori Ekle</button></div>
    <div class=catalogToolbar>
      <div class=categoryQuickNav>${nav}</div>
      <div class=adminProductSearch><input class=formControl value="${attr(adminProductSearch)}" placeholder="Bu kategoride ürün ara..." oninput="filterAdminProducts(this.value)"></div>
    </div>
  </div>`;
  html+=active?categoryBlock(active):'<div class=panel>Henüz kategori yok.</div>';
  shell('Kategoriler & Ürünler','Bir ürünün içine girdiğinde fotoğraf, açıklama, fiyat, stok, etiket, kişiselleştirme ve hazır set içeriği dahil tüm ayarlarını aynı yerde yönetirsin.',html);
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
function jumpAdminCategory(id){
  adminOpenCategory=id;
  adminProductSearch='';
  adminOpenProduct=null;
  renderCatalog();
  requestAnimationFrame(()=>document.querySelector('.catalogControlPanel')?.scrollIntoView({behavior:'smooth',block:'start'}));
}
function toggleAdminCategory(id){
  adminOpenCategory=id;
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
        </div>
      </details>
      <div class=adminProductCompactList>${ps.map(p=>productCompactRow(p)).join('')||(q?'<div class=emptyAdmin>Bu kategoride aramana uyan ürün yok.</div>':'<div class=emptyAdmin>Bu kategoride henüz ürün yok. Yukarıdaki “Yeni Ürün Ekle” ile başlayabilirsin.</div>')}</div>
    </div>
  </section>`;
}
function productCompactRow(p){
  const i=catalog.products.findIndex(x=>x.id===p.id);
  const img=p.image||productImages(p)[0]||'';
  const open=adminOpenProduct===p.id;
  return `<div class="adminProductCompact ${open?'editing':''}">
    <div class=adminProductCompactHead>
      <button class=adminProductCompactMain onclick="toggleAdminProduct('${attr(p.id)}')">
        <span class=compactThumb>${img?`<img src="${attr(img)}">`:'Fotoğraf yok'}</span>
        <span class=compactMeta><b>${esc(p.name||'Yeni Ürün')}</b><small>₺${Number(p.price||0).toLocaleString('tr-TR')} · Stok ${Number(p.stock||0)}${p.isSet?' · Hazır set':''}</small></span>
        <span class=compactEdit>${open?'Düzenlemeyi kapat':'Düzenle'}</span>
      </button>
      <button class=duplicateBtn onclick="duplicateProduct(${i})">⧉ Çoğalt</button>
    </div>
    ${open?`<div class=compactEditor>${productCard(p,true)}</div>`:''}
  </div>`;
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
function productCard(p,embedded=false){
  const i=catalog.products.findIndex(x=>x.id===p.id);
  const root=`[data-product-id="${p.id}"]`;
  const t=field=>`${root} [data-preview-field="${field}"]`;
  const setContentShortcut=p.isSet?renderInlineSetEditor(p,i):'';
  return `<article class=adminProductCard id="admin-product-${attr(p.id)}">
    <div class=adminProductImage>${(p.image||productImages(p)[0])?`<img src="${attr(p.image||productImages(p)[0])}">`:'<span>Fotoğraf yok</span>'}</div>

    <div class=field><label><b>Ürün adı</b></label>
      <input class=formControl data-preview-target="${attr(t('name'))}" value="${attr(p.name)}"
        oninput="catalog.products[${i}].name=this.value;changed(this.dataset.previewTarget)">
    </div>

    <div class=field><label><b>Ürün açıklaması</b></label>
      <textarea class=formControl data-preview-target="${attr(t('description'))}" rows=3 placeholder="Müşterinin ürün kartında okuyacağı kısa açıklama"
        oninput="catalog.products[${i}].description=this.value;changed(this.dataset.previewTarget)">${esc(p.description||'')}</textarea>
      <div class=help>Örn: Paslanmaz çelik kasa, günlük kullanıma uygun, şık ve sade tasarım.</div>
    </div>

    <div class=field><label><b>Özellikler / tikli maddeler</b></label>
      <textarea class=formControl data-preview-target="${attr(root)}" rows=3 placeholder="Her satıra bir özellik yaz
UV400 koruma
Paslanmaz çelik kasa"
        oninput="catalog.products[${i}].features=this.value.split('\n').map(x=>x.trim()).filter(Boolean);changed(this.dataset.previewTarget)">${esc((p.features||[]).join('\n'))}</textarea>
      <div class=help>Ürünü İncele ekranında ✓ işaretli maddeler halinde görünür. Hazır sette set içeriği de ayrıca otomatik görünür.</div>
    </div>

    <div class=field><label><b>Yazı / kişiselleştirme konumları</b></label>
      <input class=formControl data-preview-target=".drawer" value="${attr((p.writePositions||[]).join(', '))}" placeholder="Örn: Arka kapak, Kordon"
        oninput="catalog.products[${i}].writePositions=this.value.split(',').map(x=>x.trim()).filter(Boolean);changed(this.dataset.previewTarget)">
      <div class=help>Örn. saatte “Arka kapak, Kordon”. Ön yüz / arka yüz zorunlu değil; burayı istediğin gibi değiştir.</div>
    </div>
    <div class=field><label><b>Genelde tercih edilen konum</b></label>
      <select class=formControl data-preview-target=".drawer" onfocus="changed(this.dataset.previewTarget)" onchange="catalog.products[${i}].preferredWritePosition=this.value;changed(this.dataset.previewTarget)">
        ${preferredPositionOptions(p.writePositions||[],p.preferredWritePosition||'')}
      </select>
      <div class=help>Müşteri kararsız kaldığında yardımcı olmak için seçtiğin konumun yanında “Genelde tercih edilen” ibaresi görünür. Seçim zorunlu değildir.</div>
    </div>

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
    </div>

    <div class=field><label><b>Ürün fotoğrafları</b></label>
      <input id="prodFile${i}" data-preview-target="${attr(t('photo'))}" type=file accept="image/*" multiple>
      <button class=smallBtn onclick="uploadProductImages(${i})">Seçilen Fotoğrafları Yükle</button>
      <div class=help>Aynı ürüne 1, 3, 10 veya 50 fotoğrafı tek seferde seçebilirsin. İlk fotoğraf ana kapak olur; aşağıdan ana fotoğrafı değiştirebilirsin.</div>
      ${productGalleryAdmin(p,i)}
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
      <div class=field><label><b>Yazı konumları</b></label><input class=formControl value="${attr((it.writePositions||linked?.writePositions||[]).join(', '))}" placeholder="Arka kapak, Kordon" onfocus="previewSetStage('${attr(p.id)}','${attr(it.id)}','write')" oninput="catalog.products[${pi}].setItems[${ii}].writePositions=this.value.split(',').map(x=>x.trim()).filter(Boolean);changedSetStage('${attr(p.id)}','${attr(it.id)}','write')"><div class=help>Virgülle ayırdığın her ifade müşteriye ayrı seçim olur: “Arka kapak, Kordon” → 2 seçenek.</div></div>
      <div class=field><label><b>Genelde tercih edilen konum</b></label><select class=formControl onfocus="previewSetStage('${attr(p.id)}','${attr(it.id)}','write')" onchange="catalog.products[${pi}].setItems[${ii}].preferredWritePosition=this.value;changedSetStage('${attr(p.id)}','${attr(it.id)}','write')">${preferredPositionOptions(it.writePositions||linked?.writePositions||[],it.preferredWritePosition||linked?.preferredWritePosition||'')}</select><div class=help>Müşteride bu konumun yanında “Genelde tercih edilen” görünür; diğer seçenekler aynen kalır.</div></div>
      <button class=dangerBtn onclick="removeSetItem(${pi},${ii});renderCatalog()">Bu İçeriği Setten Çıkar</button>
    </div>`;
  }).join('');
  return `<details class="inlineSetEditor simpleAdminDetails"><summary>Set içeriği <small>${(p.setItems||[]).length} ürün/parça tanımlı</small></summary><div class=simpleDetailsBody>
    <div class=setFlowExplain><b>Bu alan müşteride neyi değiştirir?</b><span>Sette hangi ürünlerin bulunduğunu, müşterinin hangi ürünü çıkarabileceğini, çıkınca kaç TL düşeceğini ve yazı konumlarını belirler.</span></div>
    <div class=setAddBar><select id="inlineSetAdd-${attr(p.id)}" class=formControl><option value="">Katalogdan ürün seç...</option>${options}</select><button class=smallBtn onclick="addExistingProductToInlineSet('${attr(p.id)}')">＋ Seçili Ürünü Ekle</button><button class=smallBtn onclick="addBlankInlineSetItem('${attr(p.id)}')">＋ Listede Yoksa Elle Ekle</button></div>
    ${rows||'<div class=emptyAdmin>Henüz set içeriği yok. Yukarıdan katalog ürünü seç veya elle içerik ekle.</div>'}
  </div></details>`;
}
function addExistingProductToInlineSet(setId){
  const set=catalog.products.find(x=>x.id===setId),sel=$('#inlineSetAdd-'+CSS.escape(setId));
  if(!set||!sel?.value)return alert('Önce bir ürün seç.');
  const p=catalog.products.find(x=>x.id===sel.value);if(!p)return;
  set.setItems=set.setItems||[];
  set.setItems.push({id:'setitem-'+Date.now()+'-'+Math.random().toString(36).slice(2,5),productId:p.id,name:p.name,type:(catalog.categories.find(c=>c.id===p.category)||{}).name||p.category,removeDiscount:Number(p.price||0),writePositions:[...(p.writePositions||[])],preferredWritePosition:p.preferredWritePosition||''});
  changed('.drawer');renderCatalog();
}
function addBlankInlineSetItem(setId){
  const set=catalog.products.find(x=>x.id===setId);if(!set)return;
  set.setItems=set.setItems||[];
  set.setItems.push({id:'setitem-'+Date.now()+'-'+Math.random().toString(36).slice(2,5),productId:'',name:'Yeni içerik',type:'',removeDiscount:0,writePositions:[],preferredWritePosition:''});
  changed('.drawer');renderCatalog();
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
  return `<details class="copySettingsPanel simpleAdminDetails"><summary>Bu bilgileri diğer ürünlerde kullan <small>Tekrar yazmak yerine seçtiklerine kopyala</small></summary><div class=simpleDetailsBody>
    <div class=copySettingsExplain><b>Nasıl çalışır?</b> Önce hangi bilgilerin kopyalanacağını seç, sonra aşağıdan kategori ve ürünleri işaretle. <b>Ürün adı, fotoğraflar ve stok hiçbir zaman otomatik kopyalanmaz.</b></div>
    <div class=copyFieldChoices>
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=description checked> Açıklama</label>
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=features checked> Özellikler</label>
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=writePositions checked> Yazı konumları</label>
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=price> Fiyat</label>
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=oldPrice> Eski fiyat</label>
      <label><input type=checkbox class="copyField-${attr(p.id)}" value=badge> Etiket + etiket rengi</label>
      ${p.isSet?`<label><input type=checkbox class="copyField-${attr(p.id)}" value=setItems> Set içeriği + çıkarılınca düşecek TL + yazı konumları</label>`:''}
    </div>
    <div class=copyCategoryGroups>${groups||'<div class=emptyAdmin>Kopyalanabilecek başka ürün yok.</div>'}</div>
    <button class=btn onclick="applyProductInfoToSelected('${attr(p.id)}')">Seçtiğim Bilgileri İşaretli Ürünlere Uygula</button>
    <div class=help>Bu işlem fotoğrafları değiştirmez. Set içeriğini seçersen yalnızca hazır set olan hedeflere set içeriği kopyalanır.</div>
  </div></details>`;
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
      if(f==='description')t.description=src.description||'';
      else if(f==='features')t.features=[...(src.features||[])];
      else if(f==='writePositions'){t.writePositions=[...(src.writePositions||[])];t.preferredWritePosition=src.preferredWritePosition||'';}
      else if(f==='price')t.price=Number(src.price||0);
      else if(f==='oldPrice')t.oldPrice=Number(src.oldPrice||0);
      else if(f==='badge'){t.badge=src.badge||'';t.badgeColor=src.badgeColor||'orange';}
      else if(f==='setItems' && src.isSet && t.isSet){t.setItems=(src.setItems||[]).map((it,n)=>({...JSON.parse(JSON.stringify(it)),id:'setitem-'+Date.now()+'-'+n+'-'+Math.random().toString(36).slice(2,5)}));}
    });
    count++;
  });
  changed('#products');renderCatalog();
  alert(`${count} ürüne seçtiğin bilgiler uygulandı. Kalıcı olması için “Değişiklikleri Kaydet”e bas.`);
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
  catalog.products.push({id,name:'Yeni Ürün',description:'',features:[],category:categoryId,price:0,oldPrice:0,stock:0,badge:'',badgeColor:'orange',image:'',images:[],hidden:false,setEligible:!readySet,isSet:readySet,setItems:[],writePositions:[],preferredWritePosition:''});
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
    return `<label class=setItemToggle><span><b>${esc(c.name)}</b><small class=muted>Set oluşturma ekranında kategori adımı</small></span><input type=checkbox ${checked?'checked':''} onchange="toggleBuilderCategory('${attr(c.id)}',this.checked)"></label>`;
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
      <div class=field><label><b>Yazı konumları</b></label><input class=formControl value="${attr((it.writePositions||linked?.writePositions||[]).join(', '))}" placeholder="Arka kapak, Kordon" onfocus="previewSetStage('${attr(p.id)}','${attr(it.id)}','write')" oninput="catalog.products[${pi}].setItems[${ii}].writePositions=this.value.split(',').map(x=>x.trim()).filter(Boolean);changedSetStage('${attr(p.id)}','${attr(it.id)}','write')"><div class=help>Virgülden önce/sonra yazdığın her ifade müşteriye ayrı konum seçeneği olur. Örn. “Arka kapak, Kordon”.</div></div>
      <div class=field><label><b>Genelde tercih edilen konum</b></label><select class=formControl onfocus="previewSetStage('${attr(p.id)}','${attr(it.id)}','write')" onchange="catalog.products[${pi}].setItems[${ii}].preferredWritePosition=this.value;changedSetStage('${attr(p.id)}','${attr(it.id)}','write')">${preferredPositionOptions(it.writePositions||linked?.writePositions||[],it.preferredWritePosition||linked?.preferredWritePosition||'')}</select><div class=help>Seçtiğin konum müşteride tavsiye ibaresiyle gösterilir.</div></div>
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
  set.setItems.push({id:'setitem-'+Date.now(),productId:p.id,name:p.name,type:(catalog.categories.find(c=>c.id===p.category)||{}).name||p.category,removeDiscount:Number(p.price||0),writePositions:[...(p.writePositions||[])],preferredWritePosition:p.preferredWritePosition||''});
  changed('.drawer');renderCustom();
}
function addBlankSetItem(setId){
  const set=catalog.products.find(x=>x.id===setId); if(!set)return;
  set.setItems=set.setItems||[];set.setItems.push({id:'setitem-'+Date.now(),name:'Yeni içerik',type:'',removeDiscount:0,writePositions:[],preferredWritePosition:''});
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
