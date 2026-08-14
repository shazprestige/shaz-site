
let settings={},catalog={};
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
  settings.campaignCards=settings.campaignCards||[];
  settings.theme=settings.theme||{};
  show('site');
  setTimeout(()=>{sendPreview();previewTo('header')},600);
}
async function saveAll(){
  await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)});
  await fetch('/api/catalog',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(catalog)});
  sendPreview();
  alert('Kaydedildi.');
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
function shell(title,desc,html){
  $('#view').innerHTML=`<h1>${title}</h1><div class=sectionTip>${desc}</div>${html}<div class=saveBar><button class=btn onclick=saveAll()>Değişiklikleri Kaydet</button></div>`;
}
function input(label,key,val,help,target='header',type='text'){
  return `<div class=field><label><b>${label}</b></label><input class=formControl data-preview-target="${attr(target)}" type="${type}" value="${attr(val)}" oninput="${key}=this.type==='number'?Number(this.value):this.value;changed(this.dataset.previewTarget)"><div class=help>${help}</div></div>`;
}
function textarea(label,key,val,help,target){
  return `<div class=field><label><b>${label}</b></label><textarea class=formControl data-preview-target="${attr(target)}" rows=4 oninput="${key}=this.value;changed(this.dataset.previewTarget)">${esc(val)}</textarea><div class=help>${help}</div></div>`;
}

function show(tab){
  const adminRoot=document.querySelector('.simpleAdmin');
  const preview=document.querySelector('.previewPane');
  const isOrders=tab==='orders';
  if(preview) preview.style.display=isOrders?'none':'block';
  if(adminRoot) adminRoot.classList.toggle('ordersMode',isOrders);

  if(tab==='site')return renderSite();
  if(tab==='catalog')return renderCatalog();
  if(tab==='custom')return renderCustom();
  if(tab==='orders')return renderOrders();
}
function renderSite(){
  let campaigns=(settings.campaignCards||[]).map((c,i)=>`
    <div class=campaignAdmin>
      <div class=campaignAdminHead><b>Kampanya ${i+1}: ${esc(c.name||'')}</b><button class=dangerBtn onclick="removeCampaign(${i})">Sil</button></div>
      <div class="campaignQuickSettings">
        <label><input data-preview-target="#campaignCards" type=checkbox ${c.enabled!==false?'checked':''} onchange="settings.campaignCards[${i}].enabled=this.checked;changed(this.dataset.previewTarget)"> Sitede göster</label>
        <label>Sıra <input class=formControl data-preview-target="#campaignCards" type=number value="${Number(c.order||i+1)}" oninput="settings.campaignCards[${i}].order=Number(this.value);changed(this.dataset.previewTarget)"></label>
      </div>
      <div class=grid2>
        ${input('Kampanya adı',`settings.campaignCards[${i}].name`,c.name||'','Panelde tanıman için.','#campaignCards')}
        ${input('Kayan yazı',`settings.campaignCards[${i}].marqueeText`,c.marqueeText||'','Fotoğrafın üzerinde sola akar.','#campaignCards')}
        ${input('Başlık',`settings.campaignCards[${i}].title`,c.title||'','Kampanya fotoğrafının üzerindeki ana başlık.','#campaignCards')}
        ${input('Açıklama',`settings.campaignCards[${i}].subtitle`,c.subtitle||'','Başlığın altındaki açıklama.','#campaignCards')}
        ${input('Buton yazısı',`settings.campaignCards[${i}].buttonText`,c.buttonText||'','Kampanya butonunda görünür.','#campaignCards')}
        ${input('Buton bağlantısı',`settings.campaignCards[${i}].buttonLink`,c.buttonLink||'#products','Butona basılınca gidilecek yer.','#campaignCards')}
      </div>
      <div class=field><label><b>Kampanya fotoğrafı</b></label><input id="campFile${i}" data-preview-target="#campaignCards" type=file accept="image/*"><button class=smallBtn onclick="uploadCampaign(${i})">Fotoğrafı Yükle</button><div class=help>Fotoğraf uploads klasörüne kaydolur ve kampanyaya bağlanır.</div></div>
    </div>`).join('');
  shell('Site Ayarları','Teknik ölçü ayarlarını kaldırdım. Burada gerçekten kullanacağın yazılar, bağlantılar, renkler ve kampanyalar tek ekranda.',
  `<div class=panel><h2>Üst Alan</h2>
    ${input('En üstte akan yazı','settings.campaignText',settings.campaignText||'','Siyah ince şeritte akan metin.','.announce')}
    ${input('Ana başlık','settings.heroTitle',settings.heroTitle||'','Logo ve kampanya alanının altındaki ana başlık.','.hero h1')}
    ${input('Slogan','settings.heroSubtitle',settings.heroSubtitle||'','Ana başlığın altındaki slogan.','.hero p')}
    ${input('WhatsApp numarası','settings.whatsapp',settings.whatsapp||'','Yeşil iletişim butonu.','.contactBtn.wa')}
    ${input('Instagram kullanıcı adı','settings.instagram',settings.instagram||'','Siyah iletişim butonu.','.contactBtn.ig')}
    ${input('Kargom Nerede bağlantısı','settings.cargoTrackingUrl',settings.cargoTrackingUrl||'https://ebranch.araskargo.com.tr/','Üstteki paket ikonunun açacağı resmi Aras Kargo sayfası.','.cargoAction')}
  </div>
  <div class="panel grid2"><h2 style="grid-column:1/-1">Renkler</h2>
    ${input('Site arka planı','settings.theme.surface',settings.theme.surface||'#f6f7f8','Tüm sitenin ana zemin rengi.','body','color')}
    ${input('Altın vurgu','settings.theme.accent',settings.theme.accent||'#c39a59','Başlık ve küçük vurgu alanları.','.hero','color')}
  </div>
  <div class=panel><div class=campaignAdminHead><h2>Kampanyalar</h2><button class=smallBtn onclick=addCampaign()>＋ Kampanya Ekle</button></div><div class=help>Fotoğraf + kayan yazı + başlık + buton alanları.</div></div>
  ${campaigns}
  <div class=panel><h2>Sipariş Sonu Yazıları</h2>
    ${textarea('Kişiye özel ürün onay metni','settings.personalizedNotice',settings.personalizedNotice||'','Yazılı kapıda ödeme siparişinde çıkar.','.drawer')}
    ${textarea('Kargo bilgilendirme metni','settings.shippingNotice',settings.shippingNotice||'','Sipariş oluşturulmadan hemen önce çıkar.','.drawer')}
    ${input('Sipariş tamamlandı başlığı','settings.successTitle',settings.successTitle||'','Son ekrandaki başlık.','.drawer')}
    ${input('Sipariş teşekkür yazısı','settings.successMessage',settings.successMessage||'','Son ekrandaki mesaj.','.drawer')}
  </div>`);
}
function addCampaign(){
  settings.campaignCards.push({id:'kampanya-'+Date.now(),name:'Yeni Kampanya',enabled:true,order:settings.campaignCards.length+1,imageUrl:'',marqueeText:'YENİ ÜRÜNLERİMİZİ KEŞFEDİN •',title:'Yeni ürünlerimizi keşfedin.',subtitle:'Yeni koleksiyona göz atın.',buttonText:'ÜRÜNLERİ GÖR',buttonLink:'#products',height:330,overlayOpacity:28});
  changed('#campaignCards');renderSite();
}
function removeCampaign(i){if(confirm('Kampanya silinsin mi?')){settings.campaignCards.splice(i,1);changed('#campaignCards');renderSite()}}
async function uploadCampaign(i){
  const f=$('#campFile'+i)?.files?.[0];if(!f)return alert('Fotoğraf seç.');
  const fd=new FormData();fd.append('files',f);
  const r=await fetch('/api/upload',{method:'POST',body:fd}).then(r=>r.json());
  if(r.files?.[0]){settings.campaignCards[i].imageUrl=r.files[0].url;changed('#campaignCards');renderSite()}
}

function renderCatalog(){
  const cats=catalog.categories.filter(c=>c.id!=='tum').sort((a,b)=>(a.order||0)-(b.order||0));
  let html=`<div class=panel><div class=campaignAdminHead><div><h2>Kategoriler & Ürünler</h2><div class=help>İstediğin kadar ürün ekleyebilirsin. Ürünü hangi kategoride göstermek istiyorsan o kategorinin altındaki Ürün Ekle butonunu kullan.</div></div><button class=btn style="max-width:200px" onclick=addCategory()>＋ Kategori Ekle</button></div></div>`;
  html+=cats.map(c=>categoryBlock(c)).join('');
  shell('Kategoriler & Ürünler','Kategori ayarları ve o kategoriye ait bütün ürünler aynı yerde. Ürün kartları yan yana dizilir; istediğin kadar ürün ekleyebilirsin.',html);
}
function categoryBlock(c){
  const ci=catalog.categories.findIndex(x=>x.id===c.id);
  const ps=catalog.products.filter(p=>p.category===c.id);
  const catTarget=`[data-category-id="${c.id}"]`;
  return `<section class=categoryAdminBlock id="admin-cat-${attr(c.id)}">
    <div class=categoryAdminHeader>
      <div><h2>${esc(c.name)}</h2><div class=help>${ps.length} ürün</div></div>
      <button class=smallBtn onclick="addProduct('${attr(c.id)}')">＋ Bu Kategoriye Ürün Ekle</button>
    </div>
    <div class="grid2 compactCategorySettings">
      ${input('Kategori adı',`catalog.categories[${ci}].name`,c.name,'Aynı ad hem üst menüde hem Kategoriler ekranında görünür.',catTarget)}
      ${input('Sıra',`catalog.categories[${ci}].order`,c.order||0,'Aynı sıra hem üst menüde hem Kategoriler ekranında kullanılır.',catTarget,'number')}
      <div class=field><label><b>Kategori kapak fotoğrafı</b></label><input id="catFile${ci}" type=file accept="image/*"><button class=smallBtn onclick="uploadCategoryCover(${ci})">Fotoğrafı Yükle</button><div class=help>Bu görsel Kategoriler ekranındaki kutuda görünür. Üstteki kategori sekmesiyle aynı kategori kaydına bağlıdır.</div>${c.cover?`<img src="${attr(c.cover)}" style="width:100%;max-height:120px;object-fit:cover;border-radius:8px">`:''}</div>
      <div class=field><label><b>Kategoriyi gizle</b></label><label><input data-preview-target="${attr(catTarget)}" type=checkbox ${c.hidden?'checked':''} onchange="catalog.categories[${ci}].hidden=this.checked;changed(this.dataset.previewTarget)"> Gizli</label></div>
    </div>
    <div class=adminProductGrid>${ps.map(p=>productCard(p)).join('')||'<div class=emptyAdmin>Bu kategoride henüz ürün yok.</div>'}</div>
  </section>`;
}

async function uploadCategoryCover(ci){
  const f=$('#catFile'+ci)?.files?.[0]; if(!f)return alert('Kategori fotoğrafı seç.');
  const fd=new FormData(); fd.append('files',f);
  const r=await fetch('/api/upload',{method:'POST',body:fd}).then(r=>r.json());
  if(r.files?.[0]){catalog.categories[ci].cover=r.files[0].url;changed('#categoryHub');renderCatalog();}
}

function previewCategory(id,name){previewTo(`[data-category-id="${id}"]`,true);}
function productCard(p){
  const i=catalog.products.findIndex(x=>x.id===p.id);
  const root=`[data-product-id="${p.id}"]`;
  const t=field=>`${root} [data-preview-field="${field}"]`;
  return `<article class=adminProductCard>
    <div class=adminProductImage>${p.image?`<img src="${attr(p.image)}">`:'<span>Fotoğraf yok</span>'}</div>

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
      <div class=field><label>Etiket</label>
        <input class=formControl data-preview-target="${attr(t('badge'))}" value="${attr(p.badge||'')}"
          oninput="catalog.products[${i}].badge=this.value;changed(this.dataset.previewTarget)">
      </div>
    </div>

    <div class=field><label><b>Fotoğraf</b></label>
      <input id="prodFile${i}" data-preview-target="${attr(t('photo'))}" type=file accept="image/*">
      <button class=smallBtn onclick="uploadProductImage(${i})">PC'den Yükle</button>
      <div class=help>Dosya uploads klasörüne kaydolur; ürün otomatik bağlanır.</div>
    </div>

    <div class=productToggles>
      <label><input data-preview-target="${attr(root)}" type=checkbox ${p.hidden?'checked':''}
        onchange="catalog.products[${i}].hidden=this.checked;changed(this.dataset.previewTarget)"> Gizle</label>
      <label><input data-preview-target="${attr(root)}" type=checkbox ${p.isSet?'checked':''}
        onchange="catalog.products[${i}].isSet=this.checked;if(this.checked){catalog.products[${i}].setEligible=false;catalog.products[${i}].setItems=catalog.products[${i}].setItems||[]}changed(this.dataset.previewTarget);renderCatalog()"> Hazır set</label>
      <label><input data-preview-target="${attr(root)}" type=checkbox ${p.setEligible?'checked':''} ${p.isSet?'disabled':''}
        onchange="catalog.products[${i}].setEligible=this.checked;changed(this.dataset.previewTarget)"> Kendi sette kullanılabilir</label>
    </div>

    <button class=dangerBtn onclick="deleteProduct(${i})">Ürünü Sil</button>
  </article>`;
}
function addCategory(){
  const id='kategori-'+Date.now();
  catalog.categories.push({id,name:'Yeni Kategori',order:catalog.categories.length+1,hidden:false,cover:''});
  changed('#products');renderCatalog();
}
function addProduct(categoryId){
  catalog.products.push({id:'urun-'+Date.now(),name:'Yeni Ürün',description:'',features:[],category:categoryId,price:0,oldPrice:0,stock:0,badge:'',image:'',hidden:false,setEligible:categoryId!=='setler',isSet:false,setItems:[],writePositions:[]});
  changed('#products');renderCatalog();
}
function deleteProduct(i){if(confirm('Ürün silinsin mi?')){catalog.products.splice(i,1);changed('#products');renderCatalog()}}
async function uploadProductImage(i){
  const f=$('#prodFile'+i)?.files?.[0];if(!f)return alert('Fotoğraf seç.');
  const fd=new FormData();fd.append('files',f);
  const r=await fetch('/api/upload',{method:'POST',body:fd}).then(r=>r.json());
  if(r.files?.[0]){
    const pid=catalog.products[i].id;
    catalog.products[i].image=r.files[0].url;
    changed(`[data-product-id="${pid}"] [data-preview-field="photo"]`);
    renderCatalog();
    // renderCatalog sonrası admin scroll konumunu ve preview hedefini koru
    setTimeout(()=>previewTo(`[data-product-id="${pid}"] [data-preview-field="photo"]`,false),80);
  }
}

function renderCustom(){
  catalog.personalizationPricing=catalog.personalizationPricing||{first:75,second:50,thirdPlus:25};
  catalog.builder=catalog.builder||{allowedCategories:[],categoryOrder:[],pricingRules:[]};
  const pricing=catalog.personalizationPricing;
  const sets=catalog.products.filter(p=>p.isSet).map(p=>renderSetAdminPanel(p)).join('');
  const allowed=catalog.categories.filter(c=>c.id!=='tum'&&c.id!=='setler').map(c=>{
    const checked=(catalog.builder.allowedCategories||[]).includes(c.id);
    return `<label class=setItemToggle><span><b>${esc(c.name)}</b><small class=muted>Set oluşturma ekranında kategori adımı</small></span><input type=checkbox ${checked?'checked':''} onchange="toggleBuilderCategory('${attr(c.id)}',this.checked)"></label>`;
  }).join('');
  shell('Setler & Kişiselleştirme','Her hazır setin içeriğini ayrı ayrı kurabilirsin. Sete eklediğin ürünler müşteriye tikli görünür ve müşteri isterse tek tek çıkarabilir.',
  `<div class="panel grid2"><h2 style="grid-column:1/-1">Yazı Ücretleri</h2>
    ${input('İlk ürün yazısı','catalog.personalizationPricing.first',pricing.first,'İlk seçilen yazılı ürün.','.drawer','number')}
    ${input('İkinci ürün yazısı','catalog.personalizationPricing.second',pricing.second,'İkinci seçilen yazılı ürün.','.drawer','number')}
    ${input('3. ve sonrası','catalog.personalizationPricing.thirdPlus',pricing.thirdPlus,'Üçüncü ve sonraki her ürün.','.drawer','number')}
  </div>
  <div class=panel><h2>Kendi Setini Oluştur — Kategoriler</h2><div class=help>Müşteri 1 ürün de seçebilir, 2 ürün de; işaretlediğin bütün kategorileri kullanabilir.</div><div class=setItemList>${allowed}</div></div>
  <div class=panel><h2>Hazır Setler</h2><div class=help>Bir ürünü “Hazır set” olarak işaretlediğinde burada görünür. Her setin içeriği birbirinden bağımsızdır.</div></div>
  ${sets||'<div class=panel><b>Henüz hazır set yok.</b><div class=help>Kategoriler & Ürünler bölümünden bir üründe “Hazır set” seçeneğini aç.</div></div>'}`);
}
function renderSetAdminPanel(p){
  const pi=catalog.products.findIndex(x=>x.id===p.id);
  const candidates=catalog.products.filter(x=>!x.isSet && x.id!==p.id);
  const options=candidates.map(x=>`<option value="${attr(x.id)}">${esc(x.name)} — ${esc((catalog.categories.find(c=>c.id===x.category)||{}).name||'')}</option>`).join('');
  const rows=(p.setItems||[]).map((it,ii)=>{
    const linked=it.productId?catalog.products.find(x=>x.id===it.productId):null;
    return `<div class=setAdminRow>
      <div class=field><label><b>Set içi ürün</b></label><input class=formControl value="${attr(it.name||linked?.name||'')}" oninput="catalog.products[${pi}].setItems[${ii}].name=this.value;changed('.drawer')"><div class=help>${linked?'Katalogdaki ürün: '+esc(linked.name):'Elle tanımlı set ürünü'}</div></div>
      ${input('Çıkarılırsa düşecek TL',`catalog.products[${pi}].setItems[${ii}].removeDiscount`,Number(it.removeDiscount||0),'Müşteri bu ürünün tikini kaldırırsa toplamdan düşer.','.drawer','number')}
      <div class=field><label><b>Yazı konumları</b></label><input class=formControl value="${attr((it.writePositions||linked?.writePositions||[]).join(', '))}" placeholder="Arka kapak, Kordon" oninput="catalog.products[${pi}].setItems[${ii}].writePositions=this.value.split(',').map(x=>x.trim()).filter(Boolean);changed('.drawer')"><div class=help>Bu set içindeki bu ürüne özel konumlar.</div></div>
      <button class=dangerBtn onclick="removeSetItem(${pi},${ii})">Bu Ürünü Setten Çıkar</button>
    </div>`;
  }).join('');
  return `<div class=panel data-set-admin="${attr(p.id)}"><div class=campaignAdminHead><div><h2>${esc(p.name)}</h2><div class=help>${(p.setItems||[]).length} ürün · Her setin içeriği ayrı tutulur.</div></div></div>
    <div class=setAddBar><select id="setAdd-${attr(p.id)}" class=formControl><option value="">Katalogdan ürün seç...</option>${options}</select><button class=smallBtn onclick="addExistingProductToSet('${attr(p.id)}')">＋ Seçili Ürünü Ekle</button><button class=smallBtn onclick="addBlankSetItem('${attr(p.id)}')">＋ Elle İçerik Ekle</button></div>
    <div class=help>Setin içinde olan her ürün müşteri ekranında tikli görünür. Müşteri tik kaldırırsa “çıkarılırsa düşecek TL” kadar indirim uygulanır.</div>
    ${rows||'<div class=emptyAdmin>Bu setin içeriği boş. Yukarıdan ürün ekle.</div>'}
  </div>`;
}
function addExistingProductToSet(setId){
  const set=catalog.products.find(x=>x.id===setId),sel=$('#setAdd-'+CSS.escape(setId));
  if(!set||!sel?.value)return alert('Önce bir ürün seç.');
  const p=catalog.products.find(x=>x.id===sel.value); if(!p)return;
  set.setItems=set.setItems||[];
  set.setItems.push({id:'setitem-'+Date.now(),productId:p.id,name:p.name,type:(catalog.categories.find(c=>c.id===p.category)||{}).name||p.category,removeDiscount:Number(p.price||0),writePositions:[...(p.writePositions||[])]});
  changed('.drawer');renderCustom();
}
function addBlankSetItem(setId){
  const set=catalog.products.find(x=>x.id===setId); if(!set)return;
  set.setItems=set.setItems||[];set.setItems.push({id:'setitem-'+Date.now(),name:'Yeni set ürünü',type:'',removeDiscount:0,writePositions:[]});
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
  </div><div class=bulkStatus><b>Seçilen siparişleri:</b><button class=statusNew onclick="bulkOrderStatus('new')">Yeni</button><button class=statusPrepared onclick="bulkOrderStatus('prepared')">✓ Hazırlandı</button><button class=statusShipped onclick="bulkOrderStatus('shipped')">📦 Kargoya Verildi</button></div></div><div id=ordersList></div>`;
  shell('Siparişler','Tarihe göre bakabilir, siparişleri tek tek veya toplu seçebilir, Hazırlandı/Kargoya Verildi durumunu verebilir ve hepsini Excel’e aktarabilirsin.',html);paintOrders();
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
function filteredOrders(){
  const d=$('#orderDate')?.value||'';
  const st=$('#orderStatusFilter')?.value||'all';
  return orderCache.filter(o=>{
    const dateOk=!d||String(o.createdAt||'').slice(0,10)===d;
    let statusOk=true;
    if(st==='notexported')statusOk=!o.excelExportedAt;
    else if(st==='exported')statusOk=!!o.excelExportedAt;
    else if(st!=='all')statusOk=(o.status||'new')===st;
    return dateOk&&statusOk;
  });
}
function paintOrders(){const list=$('#ordersList');if(!list)return;const os=filteredOrders();list.innerHTML=os.length?os.map(orderCard).join(''):'<div class=panel>Bu filtrede sipariş yok.</div>'}
function selectVisibleOrders(on){document.querySelectorAll('.orderSelect').forEach(x=>x.checked=on)}
async function bulkOrderStatus(status){const ids=[...document.querySelectorAll('.orderSelect:checked')].map(x=>x.value);if(!ids.length)return alert('Önce en az bir sipariş seç.');await fetch('/api/orders/status',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids,status})});orderCache=await fetch('/api/orders').then(r=>r.json());paintOrders()}
async function oneOrderStatus(id,status){await fetch('/api/orders/status',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[id],status})});orderCache=await fetch('/api/orders').then(r=>r.json());paintOrders()}
function statusText(s){return s==='shipped'?'Kargoya Verildi':s==='prepared'?'Hazırlandı':'Yeni'}
function orderCard(o){
  const c=o.customer||{}; const st=o.status||'new';
  const addr=[c.neighborhood,c.avenue,c.street,c.buildingNo?`Bina ${c.buildingNo}`:'',c.floor?`Kat ${c.floor}`:'',c.doorNo?`Daire ${c.doorNo}`:'',c.district,c.province].filter(Boolean).join(' · ');
  return `<div class="orderAdminCard status-${st}">
    <div class=orderAdminTop><div class=orderIdentity><input class=orderSelect type=checkbox value="${esc(o.id)}"><div><b class=orderId>${esc(o.id)}</b><div class=orderTime>🗓 ${esc(o.createdAtTR||formatTR(o.createdAt))}</div>${o.excelExportedAt?`<div class=excelExported>📊 Excel’e Aktarıldı · ${esc(o.excelExportedAtTR||formatTR(o.excelExportedAt))}</div>`:`<div class=excelNotExported>● Excel’e Aktarılmadı</div>`}</div></div><div><span class="statusBadge ${st}">${statusText(st)}</span><div class=orderTotal>₺${Number(o.total||0).toLocaleString('tr-TR')}</div></div></div>
    <div class=orderColumns><div><h4>Müşteri</h4><b>${esc(c.fullName||'Adres bilgisi eski siparişte yok')}</b><br>${esc(c.phone||'')} ${c.extraPhone?`<br>Ek: ${esc(c.extraPhone)}`:''}<br><span class=muted>${esc(addr)}</span>${c.placeType==='business'?`<br><b>İş yeri:</b> ${esc(c.businessName||'')}`:''}${c.note?`<br><b>Not:</b> ${esc(c.note)}`:''}</div><div><h4>Sipariş İçeriği</h4>${(o.items||[]).map(orderItemDetails).join('')}</div></div>
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

  return d+'</div>';
}
function formatTR(iso){
  if(!iso)return '';
  try{return new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',dateStyle:'short',timeStyle:'medium'}).format(new Date(iso))}catch(e){return iso}
}
load();
