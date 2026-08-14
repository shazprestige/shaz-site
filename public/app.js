
let settings={},catalog={},cart=[],favorites=new Set(JSON.parse(localStorage.getItem('shazFavs')||'[]'));
let activeCategory='tum';
let productSort='priceAsc';
let campaignSliderTimer=0,campaignSliderIndex=0,campaignTouchStartX=null;
let checkoutState={payment:'cod',customer:null};
const $=s=>document.querySelector(s);
const money=n=>'₺'+Number(n||0).toLocaleString('tr-TR');

async function init(){
  settings=await fetch('/api/settings').then(r=>r.json());
  catalog=await fetch('/api/catalog').then(r=>r.json());
  apply(); renderCampaignCards(); renderCategories(); renderProducts(); bindCore(); updateFavoriteBadge(); updateCart(); bindFloatingContacts();
}
function bindCore(){
  if($('#overlay')) $('#overlay').onclick=closeDrawer;
  if($('#search')) $('#search').oninput=e=>renderProducts(e.target.value);
  if($('#favLink')) $('#favLink').onclick=e=>{e.preventDefault();showFavorites()};
  if($('#cartBtn')) $('#cartBtn').onclick=checkout;
  if($('#builderSpotlightBtn')) $('#builderSpotlightBtn').onclick=openBuilder;
  if($('#builderSpotlight')) $('#builderSpotlight').onclick=e=>{if(e.target.id!=='builderSpotlightBtn')openBuilder()};
  if($('#sortProducts')) $('#sortProducts').onchange=e=>{productSort=e.target.value;renderProducts($('#search')?.value||'')};
  if($('#categoryMenuBtn')) $('#categoryMenuBtn').onclick=openCategoryHub;
  if($('#categoryHubClose')) $('#categoryHubClose').onclick=closeCategoryHub;
}
function apply(){
  document.documentElement.style.setProperty('--paper',settings.theme?.surface||'#f6f7f8');
  document.documentElement.style.setProperty('--gold',settings.theme?.accent||'#c39a59');
  const announceVisible=settings.header?.showTopStrip!==false;
  if($('#announceWrap')) $('#announceWrap').style.display=announceVisible?'block':'none';
  document.documentElement.style.setProperty('--announce-h',announceVisible?'25px':'0px');
  if($('#campaign')) renderLoopingMarquee($('#campaign'),settings.campaignText||'');
  if($('#brandLogo')){
    $('#brandLogo').src=settings.logoUrl||'/uploads/shaz-logo-transparent.png';
    $('#brandLogo').style.width=(settings.header?.logoWidth||92)+'px';
  }
  if($('#heroTitle')) $('#heroTitle').textContent=settings.heroTitle||'Tarzına uygun saatini seç.';
  if($('#heroSubtitle')) $('#heroSubtitle').textContent=settings.heroSubtitle||'Saatini seç, setini kişiselleştir ve siparişini birkaç adımda tamamla.';
  if($('#wa')) $('#wa').href='https://wa.me/'+settings.whatsapp;
  if($('#ig')) $('#ig').href='https://ig.me/m/'+String(settings.instagram||'').replace(/^@/,'');
  if($('#cargoLink')) $('#cargoLink').href=settings.cargoTrackingUrl||'https://ebranch.araskargo.com.tr/';
}
function renderLoopingMarquee(el,text){
  if(!el)return;
  const t=String(text||'').trim();
  if(!t){stopLiveTicker(el);el.innerHTML='';return}
  const safe=escapeHtml(t);
  // Kısa metinlerde dahi ekran boş kalmasın diye aynı parçadan yeterince üret.
  el.innerHTML=Array.from({length:14},(_,i)=>`<span class="marqueeCopy"${i?' aria-hidden="true"':''}>${safe}</span>`).join('');
  requestAnimationFrame(()=>startLiveTicker(el,38));
}

function stopLiveTicker(track){
  if(track?._shazTickerRaf){cancelAnimationFrame(track._shazTickerRaf);track._shazTickerRaf=0}
}
function startLiveTicker(track,speed=36){
  if(!track)return;
  stopLiveTicker(track);
  // CSS animasyonu bazı mobil tarayıcılarda donuyordu. Hareketi JS ile piksel bazlı yapıyoruz.
  track.style.setProperty('animation','none','important');
  let x=0,last=performance.now(),step=0;
  const measure=()=>{
    const first=track.firstElementChild;
    if(!first)return 0;
    const cs=getComputedStyle(first);
    return first.getBoundingClientRect().width + (parseFloat(cs.marginRight)||0);
  };
  const tick=now=>{
    const newStep=measure();
    if(newStep>1)step=newStep;
    const dt=Math.min(50,Math.max(0,now-last)); last=now;
    if(step>1){
      x-=speed*(dt/1000);
      // Aynı parçalar art arda olduğu için bu modulo geçişi görüntüde sıçrama oluşturmaz.
      while(x<=-step)x+=step;
      track.style.setProperty('transform',`translate3d(${x.toFixed(2)}px,0,0)`,'important');
    }
    track._shazTickerRaf=requestAnimationFrame(tick);
  };
  track._shazTickerRaf=requestAnimationFrame(tick);
}

function renderCampaignCards(){
  const wrap=$('#campaignCards'); if(!wrap)return;
  clearInterval(campaignSliderTimer); campaignSliderTimer=0;
  const cards=(settings.campaignCards||[]).filter(x=>x.enabled!==false&&x.imageUrl).sort((a,b)=>(a.order||0)-(b.order||0));
  if(!cards.length){wrap.innerHTML='';return}
  if(campaignSliderIndex>=cards.length)campaignSliderIndex=0;
  const marquee=String(settings.campaignMarqueeText||'').trim();
  const marqueePos=['center','middle'].includes(settings.campaignMarqueePosition)?settings.campaignMarqueePosition:'full';
  wrap.innerHTML=`<section class="campaignSlider" id="campaignSlider" aria-label="Kampanyalar">
    <div class="campaignSlides">${cards.map((c,i)=>{
      const op=Math.min(.75,Math.max(0,Number(c.overlayOpacity??28)/100));
      return `<article class="campaignSlide ${i===campaignSliderIndex?'isActive':''}" data-slide-index="${i}" data-campaign-id="${escapeAttr(c.id||('slide-'+i))}" style="--campaign-overlay:${op}">
        <div class="campaignSlideBackdrop" style="background-image:url('${escapeAttr(c.imageUrl)}')"></div>
        <img class="campaignSlideImage" src="${escapeAttr(c.imageUrl)}" alt="${escapeAttr(c.title||'SHAZ kampanya')}">
        <div class="campaignSlideShade"></div>
        <div class="campaignContent">
          ${c.title?`<h2>${escapeHtml(c.title)}</h2>`:''}
          ${c.subtitle?`<p>${escapeHtml(c.subtitle)}</p>`:''}
          ${c.buttonText?`<button class="campaignBtn" type="button" data-campaign-target="${escapeAttr(c.targetCategory||'tum')}">${escapeHtml(c.buttonText)}</button>`:''}
        </div>
      </article>`}).join('')}</div>
    ${marquee?`<div class="campaignGlobalMarquee campaignGlobalMarquee--${marqueePos}"><div class="campaignMarqueeTrack">${Array.from({length:12},(_,n)=>`<span class="campaignMarqueeCopy"${n?` aria-hidden="true"`:''}>${escapeHtml(marquee)}</span>`).join('')}</div></div>`:''}
    ${cards.length>1?`<button class="campaignArrow campaignPrev" type="button" aria-label="Önceki fotoğraf">‹</button><button class="campaignArrow campaignNext" type="button" aria-label="Sonraki fotoğraf">›</button><div class="campaignDots">${cards.map((_,i)=>`<button type="button" class="campaignDot ${i===campaignSliderIndex?'isActive':''}" data-slide-dot="${i}" aria-label="${i+1}. fotoğraf"></button>`).join('')}</div>`:''}
  </section>`;
  wrap.querySelectorAll('[data-campaign-target]').forEach(btn=>btn.addEventListener('click',()=>goToCampaignTarget(btn.dataset.campaignTarget)));
  wrap.querySelector('.campaignPrev')?.addEventListener('click',()=>showCampaignSlide(campaignSliderIndex-1,cards.length,true));
  wrap.querySelector('.campaignNext')?.addEventListener('click',()=>showCampaignSlide(campaignSliderIndex+1,cards.length,true));
  wrap.querySelectorAll('[data-slide-dot]').forEach(dot=>dot.addEventListener('click',()=>showCampaignSlide(Number(dot.dataset.slideDot),cards.length,true)));
  const slider=wrap.querySelector('#campaignSlider');
  if(slider){
    slider.addEventListener('touchstart',e=>{campaignTouchStartX=e.touches?.[0]?.clientX??null},{passive:true});
    slider.addEventListener('touchend',e=>{
      if(campaignTouchStartX===null)return;
      const end=e.changedTouches?.[0]?.clientX??campaignTouchStartX;
      const dx=end-campaignTouchStartX;campaignTouchStartX=null;
      if(Math.abs(dx)>45)showCampaignSlide(campaignSliderIndex+(dx<0?1:-1),cards.length,true);
    },{passive:true});
    slider.addEventListener('mouseenter',()=>clearInterval(campaignSliderTimer));
    slider.addEventListener('mouseleave',()=>startCampaignAutoplay(cards.length));
  }
  const campaignTicker=wrap.querySelector('.campaignMarqueeTrack');
  if(campaignTicker)requestAnimationFrame(()=>startLiveTicker(campaignTicker,42));
  startCampaignAutoplay(cards.length);
}
function showCampaignSlide(next,total,userAction=false){
  if(!total)return;
  campaignSliderIndex=(next+total)%total;
  document.querySelectorAll('#campaignSlider .campaignSlide').forEach((el,i)=>el.classList.toggle('isActive',i===campaignSliderIndex));
  document.querySelectorAll('#campaignSlider .campaignDot').forEach((el,i)=>el.classList.toggle('isActive',i===campaignSliderIndex));
  if(userAction)startCampaignAutoplay(total);
}
function startCampaignAutoplay(total){
  clearInterval(campaignSliderTimer);campaignSliderTimer=0;
  if(total<=1)return;
  campaignSliderTimer=setInterval(()=>showCampaignSlide(campaignSliderIndex+1,total,false),3000);
}
function goToCampaignTarget(categoryId){
  const id=categoryId||'tum';
  const cat=id==='tum'?{id:'tum',name:'Tüm Ürünler'}:(catalog.categories||[]).find(c=>c.id===id&&!c.hidden);
  const target=cat||{id:'tum',name:'Tüm Ürünler'};
  setCategory(target.id,target.name,{scroll:true});
}

function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function escapeAttr(s){return String(s??'').replace(/"/g,'&quot;')}
function productImages(p){
  const list=Array.isArray(p?.images)?p.images.filter(Boolean):[];
  if(p?.image&&!list.includes(p.image))list.unshift(p.image);
  return [...new Set(list)];
}
function mainProductImage(p){return p?.image||productImages(p)[0]||''}
function renderCategories(){
  const cats=[{id:'tum',name:'Tüm Ürünler',order:-1},...catalog.categories.filter(c=>!c.hidden&&c.id!=='tum')].sort((a,b)=>(a.order??0)-(b.order??0));
  const nav=$('#catalogNav');
  if(!nav)return;
  nav.innerHTML=cats.map(c=>`<button class="tab ${activeCategory===c.id?'active':''}" title="${escapeAttr(c.name)}" data-category-id="${escapeAttr(c.id)}" data-category-name="${escapeAttr(c.name)}">${escapeHtml(c.name)}</button>`).join('');
  nav.querySelectorAll('.tab').forEach(btn=>{
    btn.addEventListener('click',()=>setCategory(btn.dataset.categoryId,btn.dataset.categoryName,{scroll:true}));
  });
}

function openCategoryHub(){
  renderCategoryHub();
  $('#categoryHub')?.classList.remove('hidden');
  document.body.classList.add('categoryHubOpen');
}
function closeCategoryHub(){
  $('#categoryHub')?.classList.add('hidden');
  document.body.classList.remove('categoryHubOpen');
}
function renderCategoryHub(){
  const wrap=$('#categoryHubGrid'); if(!wrap)return;
  const cats=catalog.categories.filter(c=>!c.hidden&&c.id!=='tum').sort((a,b)=>(a.order??0)-(b.order??0));
  wrap.innerHTML=cats.map(c=>`<button class="categoryTile ${c.cover?'hasCover':''}" ${c.cover?`style="--cat-cover:url('${escapeAttr(c.cover)}')"`:''} onclick="chooseCategoryFromHub('${escapeAttr(c.id)}','${escapeAttr(c.name)}')">
    <div class="categoryTileText"><b>${escapeHtml(c.name)}</b><span>Ürünleri gör →</span></div>
    <div class="categoryTileMedia">${c.cover?`<img src="${escapeAttr(c.cover)}" alt="${escapeAttr(c.name)}">`:`<span class="categoryPlaceholder">${escapeHtml((c.name||'?').slice(0,1))}</span>`}</div>
  </button>`).join('');
}
function chooseCategoryFromHub(id,name){
  // Hub kapanırken body overflow açıldıktan sonra scroll yap.
  setCategory(id,name,{scroll:false});
  closeCategoryHub();
  setTimeout(()=>{
    const target=document.getElementById('products');
    if(!target)return;
    const header=document.querySelector('.siteHeader');
    const offset=(header?.getBoundingClientRect().height||105)+8;
    const y=Math.max(0,target.getBoundingClientRect().top+window.scrollY-offset);
    window.scrollTo({top:y,left:0,behavior:'smooth'});
  },60);
}

function setCategory(id,name,opts={}){
  activeCategory=id;
  if($('#catalogTitle')) $('#catalogTitle').textContent=name;
  renderCategories(); renderProducts($('#search')?.value||'');
  // Üst kategori sekmesinden seçim yapıldığında ürün alanına gerçekten götür.
  if(opts.scroll!==false){
    requestAnimationFrame(()=>{
      // Her kategoride başlığı aynı noktaya getir. Eski hesap yalnızca varsayımsal
      // 105px kullanıyordu; bu yüzden kampanya/hero alanının lacivert kısmı
      // kategoriye göre farklı miktarda ekranda kalabiliyordu.
      const target=document.querySelector('#products .sectionHead');
      if(!target)return;
      const announce=document.getElementById('announceWrap');
      const header=document.getElementById('stickyHeader');
      const announceH=announce?.getBoundingClientRect().height||0;
      const headerH=header?.getBoundingClientRect().height||0;
      const visualGap=28;
      const offset=announceH+headerH+visualGap;
      const y=Math.max(0,target.getBoundingClientRect().top+window.scrollY-offset);
      window.scrollTo({top:y,left:0,behavior:'smooth'});
    });
  }
}
function renderProducts(filter=''){
  const q=(filter||'').toLocaleLowerCase('tr-TR');
  let list=catalog.products.filter(x=>!x.hidden&&(activeCategory==='tum'||x.category===activeCategory)&&((x.name||'')+' '+(x.description||'')).toLocaleLowerCase('tr-TR').includes(q));
  if(productSort==='priceAsc') list=[...list].sort((a,b)=>Number(a.price||0)-Number(b.price||0));
  if(productSort==='priceDesc') list=[...list].sort((a,b)=>Number(b.price||0)-Number(a.price||0));
  if(!$('#productsList')) return;
  $('#productsList').innerHTML=list.length?list.map(p=>{
    const name=p.name||'SHAZ Ürün';
    const desc=p.description?`<p class="productDescription" data-preview-field="description">${escapeHtml(p.description)}</p>`:'';
    const badgeColor=['orange','purple','red'].includes(p.badgeColor)?p.badgeColor:'orange';
    return `<div class="card productCardLink" data-product-id="${escapeAttr(p.id)}" role="button" tabindex="0" onclick="openProductDetail('${p.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openProductDetail('${p.id}')}"><div class="photo" data-preview-field="photo">${mainProductImage(p)?`<img src="${escapeAttr(mainProductImage(p))}" alt="${escapeAttr(name)}">`:'⌚'}${p.badge?`<span class="badge badge-${badgeColor}" data-preview-field="badge">${escapeHtml(p.badge)}</span>`:''}<button class="fav" data-preview-field="favorite" onclick="toggleFav('${p.id}',event)">${favorites.has(p.id)?'♥':'♡'}</button></div><div class="info"><h3 data-preview-field="name">${escapeHtml(name)}</h3>${desc}<div class="price"><span data-preview-field="price">${money(p.price)}</span> ${p.oldPrice?`<span class="old" data-preview-field="oldPrice">${money(p.oldPrice)}</span>`:''}</div>${settings.productStockVisible?`<div class="muted" data-preview-field="stock">Stok: ${Number(p.stock||0)}</div>`:''}</div></div>`;
  }).join(''):`<div class="panel"><b>Bu kategoride henüz ürün yok.</b></div>`;
}
function updateFavoriteBadge(){if($('#favBadge'))$('#favBadge').textContent=favorites.size}
function toggleFav(id,e){e?.stopPropagation();favorites.has(id)?favorites.delete(id):favorites.add(id);localStorage.setItem('shazFavs',JSON.stringify([...favorites]));updateFavoriteBadge();renderProducts($('#search')?.value||'')}
function removeFavorite(id){favorites.delete(id);localStorage.setItem('shazFavs',JSON.stringify([...favorites]));updateFavoriteBadge();renderProducts($('#search')?.value||'');showFavorites()}
function clearFavorites(){if(!favorites.size)return;favorites.clear();localStorage.setItem('shazFavs','[]');updateFavoriteBadge();renderProducts($('#search')?.value||'');showFavorites()}
function showFavorites(){const ps=catalog.products.filter(p=>favorites.has(p.id));openDrawer(`<div class=wizardHead><h2>Favorilerim</h2><button class="pill" onclick=closeDrawer()>Kapat</button></div>${ps.length?`<div style="display:flex;justify-content:flex-end;margin:0 0 14px"><button class="pill" onclick="clearFavorites()">Favorileri Temizle</button></div>${ps.map(p=>`<div class=wizardCard><b>${escapeHtml(p.name)}</b><br>${money(p.price)}<br><br><div style="display:flex;gap:8px;flex-wrap:wrap"><button class=btn onclick="openProductDetail('${p.id}','favorites')">Ürünü İncele</button><button class="pill" onclick="removeFavorite('${p.id}')">Favoriden Kaldır</button></div></div>`).join('')}`:'Henüz favoriniz yok.'}`)}
function openDrawer(html){$('#overlay').classList.remove('hidden');$('#drawer').classList.remove('hidden');$('#drawer').innerHTML=html}
function closeDrawer(){$('#overlay').classList.add('hidden');$('#drawer').classList.add('hidden')}
function toast(msg){const t=$('#toast');if(!t)return;t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2200)}
function updateCart(){
  const count=cart.reduce((s,x)=>s+Number(x.qty||1),0);
  if($('#cartCount')) $('#cartCount').textContent=count;
  if($('#cartBadge')) $('#cartBadge').textContent=count;
}

/* Yönetim panelindeki canlı önizleme için kaydetmeden geçici değişiklik */
window.addEventListener('message',e=>{
  if(!e.data)return;
  if(e.data.type==='shaz-preview'){
    if(e.data.settings) settings=structuredClone(e.data.settings);
    if(e.data.catalog) catalog=structuredClone(e.data.catalog);
    apply();renderCampaignCards();renderCategories();renderProducts($('#search')?.value||'');
    updateFavoriteBadge();updateCart();
    return;
  }
  if(e.data.type==='shaz-preview-focus'){
    const target=e.data.target;
    const shouldScroll=e.data.scroll!==false;

    document.querySelectorAll('.adminPreviewHighlight').forEach(x=>x.classList.remove('adminPreviewHighlight'));

    let el=target?document.querySelector(target):null;

    // Ürün görünür değilse önizlemeyi Tüm Ürünler'e al.
    if(!el && target && target.includes('[data-product-id=')){
      activeCategory='tum';
      if($('#catalogTitle')) $('#catalogTitle').textContent='Tüm Ürünler';
      renderCategories();
      renderProducts($('#search')?.value||'');
      el=document.querySelector(target);
    }
    if(!el)return;

    el.classList.add('adminPreviewHighlight');
    if(!shouldScroll)return;

    const header=document.querySelector('header');

    // Üst sabit paneldeki hedef için dikey kaydırma yapma.
    if(el.closest('header')){
      const tabs=el.closest('.tabs');
      if(tabs){
        const er=el.getBoundingClientRect();
        const tr=tabs.getBoundingClientRect();
        if(er.left<tr.left || er.right>tr.right){
          const desired=tabs.scrollLeft + (er.left-tr.left) - (tr.width-er.width)/2;
          tabs.scrollLeft=Math.max(0,desired);
        }
      }
      return;
    }

    const viewportH=window.innerHeight||document.documentElement.clientHeight;
    const headerH=header?.getBoundingClientRect().height||0;
    const topSafe=headerH+18;
    const bottomSafe=24;
    const visibleBottom=viewportH-bottomSafe;
    const rect=el.getBoundingClientRect();

    // Zaten görünüyorsa dokunma.
    if(rect.top>=topSafe && rect.bottom<=visibleBottom)return;

    const usable=Math.max(120,visibleBottom-topSafe);
    const currentY=window.scrollY||document.documentElement.scrollTop||0;
    const desiredTop=topSafe + Math.max(0,(usable-rect.height)/2);
    const desired=currentY + rect.top - desiredTop;
    const maxY=Math.max(0,document.documentElement.scrollHeight-viewportH);
    const exactY=Math.max(0,Math.min(maxY,desired));

    window.scrollTo({top:exactY,left:0,behavior:'auto'});
  }
});

function productFeatureList(p){
  const manual=Array.isArray(p.features)?p.features.filter(Boolean):[];
  const setFeatures=(p.isSet&&Array.isArray(p.setItems))?p.setItems.map(x=>x.name).filter(Boolean):[];
  return [...new Set([...manual,...setFeatures])];
}
function openProductDetail(id,source='catalog'){
  const p=catalog.products.find(x=>x.id===id); if(!p)return;
  const features=productFeatureList(p);
  const positions=Array.isArray(p.writePositions)?p.writePositions.filter(Boolean):[];
  const infoBlocks=[];
  if(p.description) infoBlocks.push(`<div class="productInfoPart"><h3>Açıklama</h3><p>${escapeHtml(p.description)}</p></div>`);
  if(features.length) infoBlocks.push(`<div class="productInfoPart"><h3>${p.isSet?'Setin içindekiler':'Özellikler'}</h3><div class=detailFeatureList>${features.map(x=>`<div>✓ ${escapeHtml(x)}</div>`).join('')}</div></div>`);
  if(positions.length&&!p.isSet) infoBlocks.push(`<div class="productInfoPart"><h3>Kişiselleştirme alanları</h3><p>${positions.map(escapeHtml).join(' · ')}</p></div>`);
  openDrawer(`<div class="productDetailShell">
    <div class="wizardHead productDetailHead"><div class="productDetailTitle"><div class=wizardProgress>ÜRÜN DETAYI</div><h2>${escapeHtml(p.name||'SHAZ Ürün')}</h2></div>${source==='favorites'?`<button class="pill productDetailClose" onclick="showFavorites()">← Favorilere Dön</button>`:`<button class="pill productDetailClose" onclick="closeDrawer()">Kapat</button>`}</div>
    ${productImages(p).length?`<div class=productDetailGallery>
      <div class="productDetailMedia" onclick="openProductImageViewer()" role="button" tabindex="0" aria-label="Fotoğrafı büyüt"><img id=productDetailMain src="${escapeAttr(mainProductImage(p))}" alt="${escapeAttr(p.name||'Ürün')}"></div>
      ${productImages(p).length>1?`<div class=productDetailThumbs>${productImages(p).map((u,i)=>`<button class="${i===0?'active':''}" onclick="selectProductDetailImage(this,'${escapeAttr(u)}')"><img src="${escapeAttr(u)}" alt=""></button>`).join('')}</div>`:''}
    </div>`:'<div class=productDetailMedia><div class=productDetailPlaceholder>⌚</div></div>'}
    ${infoBlocks.length?`<div class="productDetailInfoBox">${infoBlocks.join('')}</div>`:''}
    <div class="productDetailBottomBar"><div class="productDetailBottomPrice">${money(p.price)}${p.oldPrice?` <span class=old>${money(p.oldPrice)}</span>`:''}</div><button class="btn detailAddBtn" onclick="startProduct('${escapeAttr(p.id)}')">Sepete Ekle</button></div>
  </div>`);
}


function openProductImageViewer(){
  const img=document.getElementById('productDetailMain');
  if(!img?.src)return;
  const viewer=document.createElement('div');
  viewer.className='productImageViewer';
  viewer.innerHTML=`<button class="imageViewerClose" type="button" aria-label="Kapat">×</button><img src="${escapeAttr(img.src)}" alt="${escapeAttr(img.alt||'Ürün fotoğrafı')}">`;
  viewer.addEventListener('click',e=>{if(e.target===viewer||e.target.closest('.imageViewerClose'))viewer.remove()});
  document.body.appendChild(viewer);
}

function bindFloatingContacts(){
  const floating=document.querySelector('.floating');
  if(!floating)return;
  let raf=0;
  const update=()=>{
    raf=0;
    if(window.innerWidth>700){
      floating.style.transform='translate3d(0,0,0)';
      return;
    }
    const doc=document.documentElement;
    const maxScroll=Math.max(1,doc.scrollHeight-window.innerHeight);
    const ratio=Math.max(0,Math.min(1,(window.scrollY||0)/maxScroll));
    // İlk bölümde sağda kalır; aşağı indikçe yatay olarak merkeze kayar.
    const progress=Math.max(0,Math.min(1,(ratio-.22)/.55));
    const width=floating.getBoundingClientRect().width||176;
    const currentRight=10;
    const centeredLeft=(window.innerWidth-width)/2;
    const currentLeft=window.innerWidth-currentRight-width;
    const shift=centeredLeft-currentLeft;
    floating.style.transform=`translate3d(${shift*progress}px,0,0)`;
  };
  const schedule=()=>{if(!raf)raf=requestAnimationFrame(update)};
  window.addEventListener('scroll',schedule,{passive:true});
  window.addEventListener('resize',schedule,{passive:true});
  update();
}

function selectProductDetailImage(btn,url){
  const img=document.getElementById('productDetailMain');if(img)img.src=url;
  document.querySelectorAll('.productDetailThumbs button').forEach(x=>x.classList.remove('active'));
  btn?.classList.add('active');
}

function startProduct(id){
  const p=catalog.products.find(x=>x.id===id); if(!p)return;
  if(p.isSet&&Array.isArray(p.setItems)&&p.setItems.length) return startSetWizard(p);
  startSingleWizard(p);
}

/* SINGLE PRODUCT FLOW */
function startSingleWizard(p){
  openDrawer(`<div class=wizardHead><div><div class=wizardProgress>1 / 2</div><h2>${p.name}</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
  ${p.description?`<div class="productDetailIntro"><b>Ürün açıklaması</b><p>${escapeHtml(p.description)}</p></div>`:''}<div class=wizardCard><h3>Ürününüzün üzerine herhangi bir yazı yazdırmak ister misiniz?</h3>
  <div class=choiceStack><button class="choiceBtn" onclick='addSingleNoText(${JSON.stringify(p.id)})'>Hayır, birebir bu şekilde istiyorum</button><button class="choiceBtn primary" onclick='singleWriteStep(${JSON.stringify(p.id)})'>Evet, yazı yazdırmak istiyorum</button></div></div>`);
}
function addSingleNoText(id){const p=catalog.products.find(x=>x.id===id);cart.push({product:p,qty:1,personalized:false});updateCart();closeDrawer();toast('✓ Ürün sepete eklendi')}
function singleWriteStep(id){
  const p=catalog.products.find(x=>x.id===id);
  const positions=defaultPositionsForProduct(p);
  openDrawer(`<div class=wizardHead><div><div class=wizardProgress>2 / 2</div><h2>${p.name}</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
  <div class=priceInfo><b>Yazı ücretlendirmesi:</b><br>İlk ürün +${money(catalog.personalizationPricing?.first||75)} · İkinci ürün +${money(catalog.personalizationPricing?.second||50)} · 3. ve sonrası +${money(catalog.personalizationPricing?.thirdPlus||25)}</div>
  <div class=writeItem><h3>${p.name}</h3><div class=positionChoices>${positions.map((x,i)=>`<label class=positionChoice><input type=radio name=singlePos value="${x}" ${i===0?'checked':''}> ${x}</label>`).join('')}</div><input class=writeInput id=singleText placeholder="Yazdırmak istediğiniz yazıyı girin"></div>
  <button class=btn onclick='finishSingleWrite(${JSON.stringify(p.id)})'>Sepete Ekle</button>`);
}
function finishSingleWrite(id){
  const p=catalog.products.find(x=>x.id===id), text=$('#singleText').value.trim(), pos=document.querySelector('input[name=singlePos]:checked')?.value;
  if(!text)return alert('Lütfen yazdırmak istediğiniz yazıyı girin.');
  const fee=catalog.personalizationPricing?.first||75;
  cart.push({product:{...p,price:p.price+fee},basePrice:p.price,qty:1,personalized:true,writes:[{item:p.name,position:pos,text,fee}]});
  updateCart();closeDrawer();toast('✓ Ürün sepete eklendi');
}

/* SET WIZARD */
let wiz=null;
function startSetWizard(p){
  wiz={product:p, keptIds:p.setItems.map(x=>x.id), writes:[], step:1, history:[]};
  renderRemoveQuestion();
}
function head(title,canBack=true){return `<div class=wizardHead>${canBack?'<button class="pill backPill" onclick=setWizardBack()>← Geri</button>':''}<div><div class=wizardProgress>Adım ${wiz?.step||1}</div><h2>${title}</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>`}
function setWizardSnapshot(screen){
  if(!wiz)return;
  wiz.history=wiz.history||[];
  wiz.history.push({screen,step:wiz.step,keptIds:[...(wiz.keptIds||[])],writes:JSON.parse(JSON.stringify(wiz.writes||[]))});
  if(wiz.history.length>20)wiz.history.shift();
}
function setWizardNext(screen){setWizardSnapshot(screen);wiz.step=(wiz.step||1)+1}
function setWizardBack(){
  if(!wiz?.history?.length)return;
  const prev=wiz.history.pop();
  wiz.step=prev.step;wiz.keptIds=prev.keptIds;wiz.writes=prev.writes;
  if(prev.screen==='removeQuestion')renderRemoveQuestion(true);
  else if(prev.screen==='removalSelection')renderRemovalSelection(true);
  else if(prev.screen==='writeQuestion')renderWriteQuestion(true);
  else if(prev.screen==='writeSelection')renderWriteSelection(true);
  else if(prev.screen==='writeDetails')renderWriteDetails(true);
  else if(prev.screen==='summary')renderSetSummary(true);
}

function renderRemoveQuestion(restoring=false){
  openDrawer(head(wiz.product.name,false)+`<div class=wizardCard><h3>Setinizin içerisinden çıkarmak istediğiniz bir ürün var mı?</h3><p>Seti birebir almak istiyorsanız ilk seçeneği seçin. Bir veya daha fazla ürün çıkarmak isterseniz ikinci seçeneğe geçin.</p>
  <div class=choiceStack><button class="choiceBtn" onclick=keepAllSetItems()>Hayır, çıkarmak istemiyorum. Seti birebir almak istiyorum.</button><button class="choiceBtn primary" onclick=renderRemovalSelection()>Evet, bir veya daha fazla ürün çıkarmak istiyorum.</button></div></div>`);
}
function keepAllSetItems(){wiz.keptIds=wiz.product.setItems.map(x=>x.id);renderWriteQuestion()}
function renderRemovalSelection(restoring=false){
  if(!restoring)setWizardNext('removeQuestion');
  openDrawer(head('Set içeriğini düzenle')+`<div class=wizardCard><h3>Size gönderilmesini istediğiniz ürünler işaretli kalsın.</h3><p>Çıkarmak istediğiniz ürünün tikini kaldırın. Çıkardığınız ürünün tanımlı tutarı toplamdan düşer.</p>
  <div class=setItemList>${wiz.product.setItems.map(x=>`<label class=setItemToggle><span><b>${x.name}</b><div class=muted>Çıkarılırsa -${money(x.removeDiscount)}</div></span><input type=checkbox class=keepItem data-id="${x.id}" ${wiz.keptIds.includes(x.id)?'checked':''} onchange=refreshRemovalSummary()></label>`).join('')}</div>
  <div id=removeSummary></div></div><button class=btn onclick=confirmRemoval()>Devam Et</button>`);
  refreshRemovalSummary();
}
function refreshRemovalSummary(){
  const kept=[...document.querySelectorAll('.keepItem:checked')].map(x=>x.dataset.id);
  const removed=wiz.product.setItems.filter(x=>!kept.includes(x.id)), remain=wiz.product.setItems.filter(x=>kept.includes(x.id));
  $('#removeSummary').innerHTML=`<div class=remainingList><b>Size gelecek ürünler:</b><br>${remain.length?remain.map(x=>'✓ '+x.name).join('<br>'):'Hiç ürün kalmadı.'}</div>${removed.length?`<div class=removedList><b>Çıkardığınız ürünler:</b><br>${removed.map(x=>'✕ '+x.name+' (-'+money(x.removeDiscount)+')').join('<br>')}</div>`:''}`;
}
function confirmRemoval(){
  wiz.keptIds=[...document.querySelectorAll('.keepItem:checked')].map(x=>x.dataset.id);
  if(!wiz.keptIds.length)return alert('Sette en az bir ürün kalmalıdır.');
  renderWriteQuestion();
}
function renderWriteQuestion(restoring=false){
  if(!restoring)setWizardNext(wiz.history?.length&&wiz.history[wiz.history.length-1]?.screen==='removalSelection'?'removalSelection':'removeQuestion');
  const count=wiz.keptIds.length;
  openDrawer(head(wiz.product.name)+`<div class=wizardCard><h3>${count>1?'Ürünlerinizin':'Ürününüzün'} üzerine yazı yazdırmak ister misiniz?</h3>
  <div class=priceInfo><b>Yazı ücretlendirmesi:</b><br>İlk ürün yazısı +${money(catalog.personalizationPricing?.first||75)}<br>İkinci ürün yazısı +${money(catalog.personalizationPricing?.second||50)}<br>3. ve sonraki her ürün +${money(catalog.personalizationPricing?.thirdPlus||25)}</div>
  <div class=choiceStack><button class=choiceBtn onclick=finishSetWithoutWrite()>Hayır, yazı istemiyorum</button><button class="choiceBtn primary" onclick=renderWriteSelection()>Evet, yazı yazdırmak istiyorum</button></div></div>`);
}
function finishSetWithoutWrite(){wiz.writes=[];renderSetSummary()}
function renderWriteSelection(restoring=false){
  if(!restoring)setWizardNext('writeQuestion');
  const kept=wiz.product.setItems.filter(x=>wiz.keptIds.includes(x.id));
  openDrawer(head('Yazı yazdırılacak ürünleri seçin')+`<div class=wizardCard><div class=priceInfo><b>Ücret sırası otomatik hesaplanır:</b><br>1. seçilen ürün +${money(catalog.personalizationPricing?.first||75)} · 2. seçilen +${money(catalog.personalizationPricing?.second||50)} · 3. ve sonrası +${money(catalog.personalizationPricing?.thirdPlus||25)}</div>
  <div class=writeSelectGrid>${kept.map(x=>`<label class=setItemToggle><span><b>${x.name}</b><div class=muted>Bu ürüne yazı eklemek için işaretleyin</div></span><input type=checkbox class=writePick data-id="${x.id}" ${(wiz.pendingWriteIds||[]).includes(x.id)?'checked':''} onchange=refreshWriteFeePreview()></label>`).join('')}</div><div id=writeFeePreview></div></div>
  <button class=btn onclick=renderWriteDetails()>Seçtiklerimle Devam Et</button>`);
  refreshWriteFeePreview();
}
function feeForIndex(i){return i===0?(catalog.personalizationPricing?.first||75):i===1?(catalog.personalizationPricing?.second||50):(catalog.personalizationPricing?.thirdPlus||25)}
function refreshWriteFeePreview(){
  const ids=[...document.querySelectorAll('.writePick:checked')].map(x=>x.dataset.id);
  const items=wiz.product.setItems.filter(x=>ids.includes(x.id));
  $('#writeFeePreview').innerHTML=ids.length?`<div class=remainingList><b>Yazı seçimi:</b><br>${items.map((x,i)=>`${i+1}. ${x.name} +${money(feeForIndex(i))}`).join('<br>')}<br><br><b>Toplam yazı ücreti: ${money(ids.reduce((s,_,i)=>s+feeForIndex(i),0))}</b></div>`:'';
}
function renderWriteDetails(restoring=false){
  let ids;
  if(restoring){ids=wiz.pendingWriteIds||[]}else{ids=[...document.querySelectorAll('.writePick:checked')].map(x=>x.dataset.id);wiz.pendingWriteIds=[...ids]}
  if(!ids.length)return alert('En az bir ürün seçin veya geri dönüp yazı istemiyorum seçeneğini kullanın.');
  const items=ids.map(id=>wiz.product.setItems.find(x=>x.id===id));
  if(!restoring)setWizardNext('writeSelection');
  openDrawer(head('Yazı detayları')+`<div class=wizardCard><h3>Her ürün için konumu seçin ve yazıyı girin.</h3><p>Bütün alanlar açık halde gösterilir; tek tek pencere açılmaz.</p>
  ${items.map((x,i)=>`<div class=writeItem data-write-id="${x.id}" data-fee="${feeForIndex(i)}"><div class=writeItemTop><b>${x.name}</b><span>+${money(feeForIndex(i))}</span></div><div class=writeDetails><div class=muted>${x.name} yazısı nereye işlensin?</div><div class=positionChoices>${x.writePositions.map((pos,j)=>`<label class=positionChoice><input type=radio name="pos-${x.id}" value="${pos}" ${j===0?'checked':''}> ${pos}</label>`).join('')}</div><input class=writeInput id="text-${x.id}" placeholder="${x.name} üzerine yazdırmak istediğiniz yazı"></div></div>`).join('')}</div>
  <button class=btn onclick=confirmWriteDetails()>Özeti Gör</button>`);
}
function confirmWriteDetails(){
  const cards=[...document.querySelectorAll('[data-write-id]')], writes=[];
  for(const c of cards){
    const id=c.dataset.writeId, item=wiz.product.setItems.find(x=>x.id===id), text=$('#text-'+id).value.trim(), position=document.querySelector(`input[name="pos-${id}"]:checked`)?.value;
    if(!text)return alert(item.name+' için yazıyı girin.');
    writes.push({itemId:id,item:item.name,position,text,fee:Number(c.dataset.fee)});
  }
  wiz.writes=writes; renderSetSummary();
}
function calcSetPrice(){
  const removed=wiz.product.setItems.filter(x=>!wiz.keptIds.includes(x.id)).reduce((s,x)=>s+Number(x.removeDiscount||0),0);
  const writeFee=wiz.writes.reduce((s,x)=>s+Number(x.fee||0),0);
  return {base:Number(wiz.product.price),removed,writeFee,total:Math.max(0,Number(wiz.product.price)-removed+writeFee)};
}
function renderSetSummary(restoring=false){
  if(!restoring){
    const last=wiz.history?.[wiz.history.length-1]?.screen;
    setWizardNext(last==='writeDetails'?'writeDetails':'writeQuestion');
  }
  const pr=calcSetPrice(), kept=wiz.product.setItems.filter(x=>wiz.keptIds.includes(x.id)), removed=wiz.product.setItems.filter(x=>!wiz.keptIds.includes(x.id));
  openDrawer(head('Sipariş özeti')+`<div class=wizardCard><h3>Size gönderilecek ürünler</h3>${kept.map(x=>`<div class=summaryLine><span>✓ ${x.name}</span><span></span></div>`).join('')}</div>
  ${removed.length?`<div class=wizardCard><h3>Setten çıkardığınız ürünler</h3>${removed.map(x=>`<div class=summaryLine><span>✕ ${x.name}</span><span>-${money(x.removeDiscount)}</span></div>`).join('')}</div>`:''}
  ${wiz.writes.length?`<div class=wizardCard><h3>Kişiye özel yazılar</h3>${wiz.writes.map(x=>`<div class=summaryLine><span><b>${x.item}</b><br><span class=muted>${x.position}: “${x.text}”</span></span><span>+${money(x.fee)}</span></div>`).join('')}</div>`:''}
  <div class=wizardCard><div class=summaryLine><span>Set fiyatı</span><span>${money(pr.base)}</span></div>${pr.removed?`<div class=summaryLine><span>Çıkarılan ürünler</span><span>-${money(pr.removed)}</span></div>`:''}${pr.writeFee?`<div class=summaryLine><span>Yazı işlemleri</span><span>+${money(pr.writeFee)}</span></div>`:''}<div class="summaryLine summaryTotal"><span>Toplam</span><span>${money(pr.total)}</span></div></div>
  <button class=btn onclick=addSetToCart()>Sepete Ekle</button>`);
}
function addSetToCart(){
  const pr=calcSetPrice();
  cart.push({product:{...wiz.product,price:pr.total},basePrice:wiz.product.price,qty:1,personalized:wiz.writes.length>0,setCustomization:{keptIds:wiz.keptIds,removedIds:wiz.product.setItems.filter(x=>!wiz.keptIds.includes(x.id)).map(x=>x.id),writes:wiz.writes}});
  updateCart(); closeDrawer(); toast('✓ Ürün sepete eklendi');
}

/* CART + CHECKOUT */

function checkout(){
  if(!cart.length)return openDrawer('<div class="checkoutEmpty"><h2>Sepetiniz boş</h2><p>Beğendiğiniz ürünleri sepete ekleyerek siparişe başlayabilirsiniz.</p><button class="btn" onclick="closeDrawer()">Ürünlere Dön</button></div>');
  const total=cart.reduce((a,x)=>a+Number(x.product.price||0),0);
  openDrawer(`<div class="checkoutShell"><div class="checkoutTop"><div><h2>Sepetiniz</h2><p>Ürünlerinizi kontrol edin, ardından teslimat bilgilerinize geçin.</p></div><button class="pill" onclick=closeDrawer()>Kapat</button></div>
    <div class="checkoutSteps"><span class="active">1 Sepet</span><span>2 Teslimat</span><span>3 Onay</span></div>
    <div class="cartToolbar"><span>${cart.reduce((n,x)=>n+Number(x.qty||1),0)} ürün</span><button type="button" class="cartClearBtn" onclick="clearCartFromCheckout()">Sepeti boşalt</button></div>
    <div class="checkoutProductPanel">${cart.map((x,i)=>cartItemSummary(x,i)).join('')}</div>
    <div class="checkoutTotal"><span>Toplam</span><strong>${money(total)}</strong></div>
    <div class="checkoutPayment"><label for="pay"><b>Ödeme yöntemi</b><small>Ödeme tercihinizi seçin.</small></label><select id="pay" class="formControl"><option value="cod">Kapıda ödeme</option><option value="online">Online ödeme</option></select></div>
    <button class="btn checkoutPrimary" onclick="addressStep()">Teslimat Bilgilerine Geç →</button></div>`);
}

function removeCartItem(i){
  if(i<0||i>=cart.length)return;
  cart.splice(i,1);updateCart();
  if(cart.length) checkout(); else closeDrawer();
}
function clearCartFromCheckout(){
  if(!cart.length)return;
  if(!confirm('Sepetteki tüm ürünler kaldırılsın mı?'))return;
  cart=[];updateCart();closeDrawer();toast('Sepet boşaltıldı');
}

function cartItemSummary(x,i){
  const lines=[];
  if(x.setCustomization){
    const removed=(x.setCustomization.removedIds||[]).map(id=>(x.product.setItems||[]).find(s=>s.id===id)?.name).filter(Boolean);
    if(removed.length) lines.push(`<div class=muted>Çıkarılan: ${removed.map(escapeHtml).join(', ')}</div>`);
    const writes=x.setCustomization.writes||[];
    if(writes.length) lines.push(`<div class=muted>Yazılar: ${writes.map(w=>`${escapeHtml(w.item)} — ${escapeHtml(w.position)}: “${escapeHtml(w.text)}”`).join('<br>')}</div>`);
  }
  if(x.builderItems?.length) lines.push(`<div class=muted>Set içeriği: ${x.builderItems.map(p=>escapeHtml(p.name)).join(', ')}</div>`);
  const writes=x.writes||x.setCustomization?.writes||[];
  if(!x.setCustomization && writes.length) lines.push(`<div class=muted>Yazı: ${writes.map(w=>`${escapeHtml(w.item)} — ${escapeHtml(w.position)}: “${escapeHtml(w.text)}”`).join('<br>')}</div>`);
  return `<div class="orderCartItem"><div class="cartItemMain"><div><b>${escapeHtml(x.product.name)}</b>${lines.join('')}</div><div class="cartItemRight"><strong>${money(x.product.price)}</strong><button type="button" class="cartRemoveBtn" onclick="removeCartItem(${i})">Kaldır</button></div></div></div>`;
}

function addressStep(){
  checkoutState.payment=$('#pay')?.value||checkoutState.payment||'cod';
  const c=checkoutState.customer||{};
  const branch=c.deliveryMode==='branch';
  openDrawer(`<div class="checkoutShell"><div class="checkoutTop"><div><span class="checkoutEyebrow">TESLİMAT BİLGİLERİ</span><h2>Siparişinizi nereye gönderelim?</h2><p>Size ulaşabilmemiz ve kargoyu doğru yere gönderebilmemiz için bilgileri girin.</p></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
    <div class="checkoutBackRow"><button type="button" class="checkoutBackBtn" onclick="checkout()">← Sepete dön</button><small>* zorunlu alan</small></div>
    <div class="checkoutSteps"><span>1 Sepet</span><span class="active">2 Teslimat</span><span>3 Onay</span></div>
    <div class="addressCompact">
      ${addrInput('Ad Soyad *','fullName',c.fullName)}
      ${addrInput('Telefon *','phone',c.phone,'tel')}
      <div class="field fieldWide"><label><b>2. Telefon Numarası</b><small class="fieldHelp">Teslimatın sorunsuz gerçekleşmesi için ulaşılabilecek ikinci bir numara yazın; anne, baba, arkadaş vb. olabilir.</small></label><input class=formControl id=addr-extraPhone type=tel value="${escapeAttr(c.extraPhone||'')}" placeholder="Örn: 05xx xxx xx xx"></div>

      <label class="branchChoice fieldWide"><input id="addr-branchToggle" type="checkbox" ${branch?'checked':''} onchange="toggleBranchDelivery()"><span><b>Kargom Aras Kargo şubesine gelsin</b><small>Adrese değil, seçtiğiniz Aras Kargo şubesinden teslim alırsınız.</small></span></label>

      ${addrInput('İl *','province',c.province)}
      ${addrInput('İlçe *','district',c.district)}

      <div id="homeAddressFields" class="addressModeFields fieldWide" style="${branch?'display:none':''}">
        ${addrInput('Mahalle *','neighborhood',c.neighborhood)}
        <div class="field fieldWide"><label><b>Tam adres *</b><small class="fieldHelp">Cadde/sokak, bina no, kat ve daire bilgilerini tek alana yazın.</small></label><textarea class=formControl id=addr-fullAddress rows=3 placeholder="Örn: Bağlarbaşı Mah. Atatürk Cad. No:12 Kat:2 Daire:5">${escapeHtml(c.fullAddress||c.avenue||'')}</textarea></div>
      </div>

      <div id="branchAddressFields" class="addressModeFields fieldWide" style="${branch?'':'display:none'}">
        <div class="branchInfo">📍 <b>Aras Kargo şube adını net yazın.</b><br>Google Haritalar'dan kontrol edip şubenin tam adını girin. Aynı ilçede birden fazla şube olabilir.<br><span>Örnek: İstanbul / Kadıköy — Aras Kargo Kadıköy Şubesi</span></div>
        <div class="field fieldWide"><label><b>Aras Kargo şube adı *</b></label><input class=formControl id=addr-branchName value="${escapeAttr(c.branchName||'')}" placeholder="Örn: Aras Kargo Kadıköy Şubesi"></div>
      </div>

      <div class="field fieldWide"><label><b>Teslimat notu</b><small class="fieldHelp">İsterseniz kurye veya teslimat için kısa bir not ekleyin.</small></label><textarea class=formControl id=addr-note rows=2 placeholder="İsteğe bağlı">${escapeHtml(c.note||'')}</textarea></div>
    </div>
    <button class="btn checkoutPrimary" onclick="saveAddressAndContinue()">Bilgilerimi Kontrol Et →</button></div>`);
}

function addrInput(label,id,value='',type='text'){
  return `<div class=field><label><b>${label}</b></label><input class=formControl id="addr-${id}" type="${type}" value="${escapeAttr(value||'')}"></div>`;
}
function toggleBranchDelivery(){
  const on=!!$('#addr-branchToggle')?.checked;
  if($('#homeAddressFields')) $('#homeAddressFields').style.display=on?'none':'grid';
  if($('#branchAddressFields')) $('#branchAddressFields').style.display=on?'grid':'none';
}
function saveAddressAndContinue(){
  const g=id=>($('#addr-'+id)?.value||'').trim();
  const branch=!!$('#addr-branchToggle')?.checked;
  const customer={
    fullName:g('fullName'),phone:g('phone'),extraPhone:g('extraPhone'),province:g('province'),district:g('district'),
    deliveryMode:branch?'branch':'address', branchName:branch?g('branchName'):'',
    neighborhood:branch?'Aras Kargo Şube Teslim':g('neighborhood'), fullAddress:branch?'':g('fullAddress'),
    avenue:branch?g('branchName'):g('fullAddress'), street:'',buildingNo:'',floor:'',doorNo:'',placeType:'home',businessName:'',note:g('note')
  };
  if(!customer.fullName||!customer.phone||!customer.province||!customer.district)return alert('Lütfen * işaretli zorunlu alanları doldurun.');
  if(branch&&!customer.branchName)return alert('Teslim almak istediğiniz Aras Kargo şubesinin tam adını yazın.');
  if(!branch&&(!customer.neighborhood||!customer.fullAddress))return alert('Mahalle ve tam adres alanlarını doldurun.');
  checkoutState.customer=customer;
  showAddressConfirmation(customer);
}
function customerAddressText(c){
  if(c.deliveryMode==='branch') return `${c.province} / ${c.district} — ${c.branchName}`;
  return `${c.neighborhood}, ${c.fullAddress} — ${c.district} / ${c.province}`;
}
function showAddressConfirmation(c){
  document.querySelector('.addressCheckModal')?.remove();
  const el=document.createElement('div');
  el.className='addressCheckModal';
  el.innerHTML=`<div class="addressCheckCard"><button class="addressCheckX" onclick="this.closest('.addressCheckModal').remove()">×</button><span class="checkoutEyebrow">ADRES KONTROLÜ</span><h3>Bilgilerinizi kontrol edin</h3><p class="addressCheckHint">Yanlış veya eksik adres, kargonun gecikmesine neden olabilir.</p><div class="addressCheckData"><b>${escapeHtml(c.fullName)}</b><span>${escapeHtml(c.phone)}${c.extraPhone?` · 2. tel: ${escapeHtml(c.extraPhone)}`:''}</span><strong>${c.deliveryMode==='branch'?'📦 Şubeden teslim':'📍 Adrese teslim'}</strong><span>${escapeHtml(customerAddressText(c))}</span>${c.deliveryMode==='branch'?'<small>Şube adını Google Haritalar’dan kontrol ettiğinizden emin olun.</small>':''}</div><div class="addressCheckActions"><button class="pill" onclick="this.closest('.addressCheckModal').remove()">Düzenle</button><button class="btn" onclick="confirmAddressAndContinue()">Bilgiler doğru, devam et →</button></div></div>`;
  document.body.appendChild(el);
}
function confirmAddressAndContinue(){
  document.querySelector('.addressCheckModal')?.remove();
  continueAfterAddress();
}
function continueAfterAddress(){
  const hasPersonal=cart.some(x=>x.personalized);
  if(checkoutState.payment==='cod'&&hasPersonal){
    openDrawer(`<div class="checkoutShell"><div class="checkoutTop"><div><span class="checkoutEyebrow">SİPARİŞ ONAYI</span><h2>Kişiye özel ürün bilgilendirmesi</h2></div></div><div class="checkoutBackRow"><button type="button" class="checkoutBackBtn" onclick="addressStep()">← Teslimata dön</button></div><div class="checkoutSteps"><span>1 Sepet</span><span>2 Teslimat</span><span class="active">3 Onay</span></div><div class=notice>${settings.personalizedNotice}</div><button class="btn checkoutPrimary" onclick="shippingNotice(true)">Onaylıyorum, devam et →</button></div>`);
  }else shippingNotice(false);
}
function shippingNotice(personalApproved=false){
  openDrawer(`<div class="checkoutShell"><div class="checkoutTop"><div><span class="checkoutEyebrow">SON ADIM</span><h2>Kargo bilgilendirmesi</h2><p>Siparişinizi oluşturmadan önce kısa bilgilendirmeyi okuyun.</p></div></div><div class="checkoutBackRow"><button type="button" class="checkoutBackBtn" onclick="addressStep()">← Teslimata dön</button></div><div class="checkoutSteps"><span>1 Sepet</span><span>2 Teslimat</span><span class="active">3 Onay</span></div><div class=notice>${settings.shippingNotice}</div><button class="btn checkoutPrimary" onclick="finalizeOrder(${personalApproved})">Siparişi Oluştur ✓</button></div>`);
}
async function finalizeOrder(personalApproved){
  if(!checkoutState.customer)return addressStep();
  const order={
    items:cart,
    customer:checkoutState.customer,
    payment:checkoutState.payment,
    personalApproval:personalApproved?{approved:true,method:'button',at:new Date().toISOString()}:null,
    shippingNoticeAccepted:true,
    total:cart.reduce((a,x)=>a+Number(x.product.price||0),0)
  };
  const r=await fetch('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(order)}).then(r=>r.json());
  cart=[];checkoutState={payment:'cod',customer:null};updateCart();success(r.order.id);
}
function success(id){
  openDrawer(`<div class=success><div class=check>✅</div><h2>${settings.successTitle}</h2><p>${settings.successMessage}</p><p><b>${settings.successTagline}</b></p><p>Sipariş No: ${id}</p><div class=actions><a class="contactBtn wa" href="https://wa.me/${settings.whatsapp}"><span class="contactIcon brandIcon waIcon" aria-hidden="true"><svg viewBox="0 0 24 24" role="img"><path fill="currentColor" d="M12 2a9.5 9.5 0 0 0-8.21 14.27L2.5 21.5l5.38-1.25A9.5 9.5 0 1 0 12 2Zm0 17.2a7.7 7.7 0 0 1-3.92-1.07l-.28-.17-3.19.74.77-3.1-.18-.29A7.7 7.7 0 1 1 12 19.2Zm4.23-5.76c-.23-.12-1.37-.68-1.58-.76-.21-.08-.36-.12-.52.12-.15.23-.6.76-.74.92-.14.15-.27.17-.5.06-.23-.12-.98-.36-1.86-1.15-.69-.61-1.15-1.36-1.29-1.59-.13-.23-.01-.35.1-.46.1-.1.23-.27.35-.4.12-.14.15-.23.23-.39.08-.15.04-.29-.02-.4-.06-.12-.52-1.25-.71-1.71-.19-.45-.38-.39-.52-.4h-.44c-.15 0-.4.06-.61.29-.21.23-.8.78-.8 1.9 0 1.11.82 2.19.93 2.34.12.15 1.6 2.44 3.88 3.42.54.23.96.37 1.29.48.54.17 1.04.15 1.43.09.44-.07 1.37-.56 1.56-1.1.19-.54.19-1 .13-1.1-.06-.1-.21-.15-.44-.27Z"/></svg></span><span><b>Aklınıza takılan bir şey mi var?</b><small>Buraya tıkla ve iletişime geç</small></span></a><a class="contactBtn ig" href="https://ig.me/m/${String(settings.instagram||'').replace(/^@/,'')}"><span class="contactIcon brandIcon igIcon" aria-hidden="true"><svg viewBox="0 0 24 24" role="img"><rect x="3.2" y="3.2" width="17.6" height="17.6" rx="5.2" ry="5.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.1" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.4" cy="6.9" r="1.2" fill="currentColor"/></svg></span><span><b>Aklınıza takılan bir şey mi var?</b><small>Buraya tıkla ve iletişime geç</small></span></a></div></div>`);
}


/* CUSTOM BUILDER — kategori adımlı */
let customBuilder=null;

function getBuilderCategories(){
  const b=catalog.builder||{};
  const allowed=(b.allowedCategories||[]).filter(id=>id!=='setler'&&id!=='tum');
  const ordered=(b.categoryOrder||[]).filter(id=>allowed.includes(id));
  allowed.forEach(id=>{if(!ordered.includes(id))ordered.push(id)});
  return ordered.map(id=>catalog.categories.find(c=>c.id===id)).filter(Boolean).filter(c=>!c.hidden);
}
function getBuilderProducts(categoryId){
  return catalog.products.filter(p=>
    !p.hidden &&
    !p.isSet &&
    p.category!=='setler' &&
    p.category===categoryId &&
    p.setEligible!==false
  );
}
function openBuilder(){
  const cats=getBuilderCategories();
  if(!cats.length){
    return openDrawer(`<div class=wizardHead><h2>Kendi Setini Oluştur</h2><button class=pill onclick=closeDrawer()>Kapat</button></div><div class=builderEmptyCategory>Şu anda set oluşturma için açık kategori bulunmuyor.</div>`);
  }
  customBuilder={categories:cats,index:0,selections:{},writes:[]};
  renderBuilderCategoryStep();
}
function renderBuilderCategoryStep(){
  const cat=customBuilder.categories[customBuilder.index];
  const products=getBuilderProducts(cat.id);
  const total=customBuilder.categories.length;
  const selectedId=customBuilder.selections[cat.id]||null;
  const progress=((customBuilder.index+1)/total)*100;
  const chosenCount=Object.values(customBuilder.selections).filter(Boolean).length;

  openDrawer(`<div class=wizardHead><div><div class=wizardProgress>Kendi Setini Oluştur</div><h2>${escapeHtml(cat.name)}</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
    <div class=builderStepMeta><span class=builderStepName>${customBuilder.index+1}. ADIM / ${total}</span><span class=builderChosen>${chosenCount} ürün seçildi</span></div>
    <div class=builderProgressBar><div class=builderProgressFill style="width:${progress}%"></div></div>
    <div class=wizardCard>
      <h3>${escapeHtml(cat.name)} kategorisinden hangisini setinize eklemek istersiniz?</h3>
      <p class=muted>Bu kategoride yalnızca normal tekli ürünler gösterilir. Hazır setler burada görünmez.</p>
      ${products.length?`<div class=builderProductGrid>${products.map(p=>`
        <div class="builderProductCard ${selectedId===p.id?'selected':''}" onclick="builderChoose('${escapeAttr(cat.id)}','${escapeAttr(p.id)}')">
          <div class=builderProductPhoto>${mainProductImage(p)?`<img src="${escapeAttr(mainProductImage(p))}" alt="${escapeAttr(p.name)}">`:'⌚'}<span class=builderSelectMark>${selectedId===p.id?'✓':''}</span></div>
          <div class=builderProductBody><b>${escapeHtml(p.name)}</b><small>${money(p.price)} tekli satış fiyatı</small></div>
        </div>`).join('')}</div>`:`<div class=builderEmptyCategory>Bu kategoride set oluşturmaya açık tekli ürün bulunmuyor.</div>`}
      <button class=builderSkip onclick="builderSkipCurrent()">Bu kategoriden ürün eklemek istemiyorum</button>
    </div>
    <div class=builderNav>
      ${customBuilder.index>0?`<button class="btn secondary" onclick=builderPrev()>← Geri</button>`:''}
      <button class=btn onclick=builderNext()>${customBuilder.index===total-1?'Seçimlerimi Gör':'Devam Et →'}</button>
    </div>`);
}
function builderChoose(categoryId,productId){
  customBuilder.selections[categoryId]=productId;
  renderBuilderCategoryStep();
}
function builderSkipCurrent(){
  customBuilder.selections[customBuilder.categories[customBuilder.index].id]=null;
  builderNext();
}
function builderPrev(){if(customBuilder.index>0){customBuilder.index--;renderBuilderCategoryStep()}}
function builderNext(){
  if(customBuilder.index<customBuilder.categories.length-1){customBuilder.index++;renderBuilderCategoryStep();return}
  renderBuilderSelectionSummary();
}
function getBuilderSelectedProducts(){
  return customBuilder.categories.map(c=>{
    const id=customBuilder.selections[c.id];
    return id?catalog.products.find(p=>p.id===id):null;
  }).filter(Boolean);
}
function getBuilderRule(count){
  return (catalog.builder?.pricingRules||[]).find(r=>Number(r.count)===Number(count));
}
function builderTotalFor(count){
  const rule=getBuilderRule(count);
  return rule?Number(rule.pricePerItem||0)*count:0;
}
function renderBuilderSelectionSummary(){
  const selected=getBuilderSelectedProducts();
  const min=Number(catalog.builder?.minItems||1);
  const max=Number(catalog.builder?.maxItems||99);
  const valid=selected.length>=min&&selected.length<=max;
  const total=builderTotalFor(selected.length);
  const rule=getBuilderRule(selected.length);

  openDrawer(`<div class=wizardHead><div><div class=wizardProgress>Seçim Özeti</div><h2>Setiniz</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
    <div class=wizardCard>
      <h3>Seçtiğiniz ürünler</h3>
      <div class=builderSummaryItems>${selected.length?selected.map(p=>`
        <div class=builderSummaryItem>
          <div class=builderSummaryThumb>${mainProductImage(p)?`<img src="${escapeAttr(mainProductImage(p))}">`:'⌚'}</div>
          <div class=builderSummaryInfo><b>${escapeHtml(p.name)}</b><small>${escapeHtml((catalog.categories.find(c=>c.id===p.category)||{}).name||p.category)}</small></div>
        </div>`).join(''):'<div class=builderEmptyCategory>Henüz ürün seçmediniz.</div>'}</div>
    </div>
    <div class=wizardCard>
      <div class=summaryLine><span>Seçilen ürün sayısı</span><span>${selected.length}</span></div>
      <div class=summaryLine><span>Minimum gerekli</span><span>${min}</span></div>
      ${rule?`<div class=summaryLine><span>Özel set ürün başı fiyatı</span><span>${money(rule.pricePerItem)}</span></div>`:''}
      <div class="summaryLine summaryTotal"><span>Set toplamı</span><span>${rule?money(total):'Fiyat tanımlı değil'}</span></div>
    </div>
    ${!valid?`<div class=notice>Bu seti tamamlamak için en az ${min}, en fazla ${max} ürün seçmelisiniz.</div>`:''}
    ${valid&&!rule?`<div class=notice>${selected.length} ürün için yönetim panelinde özel set fiyatı tanımlanmamış.</div>`:''}
    <div class=builderNav><button class="btn secondary" onclick=builderEditSelections()>← Seçimleri Düzenle</button><button class=btn ${valid&&rule?'':'disabled'} onclick="${valid&&rule?'builderAskWrite()':"alert('Önce geçerli ürün sayısı ve fiyat kuralı gerekli.')"}">Devam Et</button></div>`);
}
function builderEditSelections(){customBuilder.index=0;renderBuilderCategoryStep()}

function defaultPositionsForProduct(p){
  if(Array.isArray(p.writePositions)&&p.writePositions.length)return p.writePositions;
  const cat=((catalog.categories.find(c=>c.id===p.category)||{}).name||p.category||'').toLocaleLowerCase('tr-TR');
  if(cat.includes('saat'))return ['Arka kapak','Kordon'];
  if(cat.includes('cüzdan'))return ['Ön yüz','İç yüz'];
  if(cat.includes('çakmak'))return ['Ön yüz','Arka yüz'];
  if(cat.includes('kemer'))return ['Toka','Kemer ucu'];
  if(cat.includes('bileklik'))return ['Ön yüz','Arka yüz'];
  if(cat.includes('tesp')||cat.includes('tesb'))return ['Püskül / metal parça','Uygun görülen alan'];
  return ['Ön yüz','Arka yüz'];
}
function builderAskWrite(){
  const selected=getBuilderSelectedProducts();
  openDrawer(`<div class=wizardHead><div><div class=wizardProgress>Kişiselleştirme</div><h2>Set ürünlerinize yazı ister misiniz?</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
    <div class=priceInfo><b>Yazı ücretlendirmesi:</b><br>İlk ürün +${money(catalog.personalizationPricing?.first||75)} · İkinci ürün +${money(catalog.personalizationPricing?.second||50)} · 3. ve sonrası +${money(catalog.personalizationPricing?.thirdPlus||25)}</div>
    <div class=wizardCard><p>${selected.length} ürünlük setiniz hazır. İsterseniz seçtiğiniz ürünlerden bazılarına kişiye özel yazı ekleyebilirsiniz.</p>
    <div class=choiceStack><button class=choiceBtn onclick=builderFinishNoWrite()>Hayır, yazı istemiyorum</button><button class="choiceBtn primary" onclick=builderWriteSelection()>Evet, yazı eklemek istiyorum</button></div></div>`);
}
function builderFinishNoWrite(){customBuilder.writes=[];renderBuilderFinalSummary()}
function builderWriteSelection(){
  const selected=getBuilderSelectedProducts();
  openDrawer(`<div class=wizardHead><div><div class=wizardProgress>Yazı Seçimi</div><h2>Hangi ürünlere yazı yazılsın?</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
    <div class=priceInfo>İşaretleme sırasına göre ücret: 1. ürün ${money(catalog.personalizationPricing?.first||75)}, 2. ürün ${money(catalog.personalizationPricing?.second||50)}, 3. ve sonrası ${money(catalog.personalizationPricing?.thirdPlus||25)}.</div>
    <div class=wizardCard>${selected.map(p=>`<label class=setItemToggle><span><b>${escapeHtml(p.name)}</b></span><input type=checkbox class=builderWritePick data-id="${escapeAttr(p.id)}"></label>`).join('')}</div>
    <button class=btn onclick=builderWriteDetails()>Seçtiklerimle Devam Et</button>`);
}
function builderFeeForIndex(i){return i===0?(catalog.personalizationPricing?.first||75):i===1?(catalog.personalizationPricing?.second||50):(catalog.personalizationPricing?.thirdPlus||25)}
function builderWriteDetails(){
  const ids=[...document.querySelectorAll('.builderWritePick:checked')].map(x=>x.dataset.id);
  if(!ids.length)return alert('En az bir ürün seçin veya geri dönüp yazı istemiyorum seçeneğini seçin.');
  const selected=ids.map(id=>catalog.products.find(p=>p.id===id)).filter(Boolean);
  openDrawer(`<div class=wizardHead><div><div class=wizardProgress>Yazı Detayları</div><h2>Yazıları belirleyin</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
    <div class=wizardCard>${selected.map((p,i)=>{
      const positions=defaultPositionsForProduct(p);
      return `<div class=builderWriteCard data-product-id="${escapeAttr(p.id)}" data-fee="${builderFeeForIndex(i)}">
        <div class=builderWriteTop><b>${escapeHtml(p.name)}</b><span>+${money(builderFeeForIndex(i))}</span></div>
        <div class=builderWriteDetails>
          <div class=muted>Yazı konumu</div>
          <div class=positionChoices>${positions.map((pos,j)=>`<label class=positionChoice><input type=radio name="builder-pos-${escapeAttr(p.id)}" value="${escapeAttr(pos)}" ${j===0?'checked':''}> ${escapeHtml(pos)}</label>`).join('')}</div>
          <input class=writeInput id="builder-text-${escapeAttr(p.id)}" placeholder="${escapeAttr(p.name)} için yazı">
        </div>
      </div>`;
    }).join('')}</div><button class=btn onclick=builderConfirmWrites()>Son Özeti Gör</button>`);
}
function builderConfirmWrites(){
  const cards=[...document.querySelectorAll('.builderWriteCard')],writes=[];
  for(const c of cards){
    const id=c.dataset.productId,p=catalog.products.find(x=>x.id===id),text=$('#builder-text-'+id)?.value.trim();
    const pos=document.querySelector(`input[name="builder-pos-${id}"]:checked`)?.value;
    if(!text)return alert((p?.name||'Ürün')+' için yazıyı girin.');
    writes.push({productId:id,item:p?.name||id,position:pos,text,fee:Number(c.dataset.fee||0)});
  }
  customBuilder.writes=writes;renderBuilderFinalSummary();
}
function renderBuilderFinalSummary(){
  const selected=getBuilderSelectedProducts(),rule=getBuilderRule(selected.length);
  const base=builderTotalFor(selected.length);
  const writeFee=(customBuilder.writes||[]).reduce((s,w)=>s+Number(w.fee||0),0);
  const total=base+writeFee;
  openDrawer(`<div class=wizardHead><div><div class=wizardProgress>Son Kontrol</div><h2>Kendi Setiniz Hazır</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
    <div class=wizardCard><h3>Setin içindekiler</h3><div class=builderSummaryItems>${selected.map(p=>`<div class=builderSummaryItem><div class=builderSummaryThumb>${mainProductImage(p)?`<img src="${escapeAttr(mainProductImage(p))}">`:'⌚'}</div><div class=builderSummaryInfo><b>${escapeHtml(p.name)}</b><small>${escapeHtml((catalog.categories.find(c=>c.id===p.category)||{}).name||'')}</small></div></div>`).join('')}</div></div>
    ${customBuilder.writes?.length?`<div class=wizardCard><h3>Kişiye özel yazılar</h3>${customBuilder.writes.map(w=>`<div class=summaryLine><span><b>${escapeHtml(w.item)}</b><br><span class=muted>${escapeHtml(w.position)}: “${escapeHtml(w.text)}”</span></span><span>+${money(w.fee)}</span></div>`).join('')}</div>`:''}
    <div class=wizardCard>
      <div class=summaryLine><span>${selected.length} ürün özel set</span><span>${money(base)}</span></div>
      ${writeFee?`<div class=summaryLine><span>Yazı işlemleri</span><span>+${money(writeFee)}</span></div>`:''}
      <div class="summaryLine summaryTotal"><span>Toplam</span><span>${money(total)}</span></div>
    </div>
    <button class=btn onclick=builderAddToCart()>Setimi Sepete Ekle</button>`);
}
function builderAddToCart(){
  const selected=getBuilderSelectedProducts(),base=builderTotalFor(selected.length),writeFee=(customBuilder.writes||[]).reduce((s,w)=>s+Number(w.fee||0),0),total=base+writeFee;
  const customProduct={id:'custom-'+Date.now(),name:`Kendi Setim (${selected.length} ürün)`,price:total,stock:999,isSet:true};
  cart.push({product:customProduct,basePrice:base,qty:1,personalized:(customBuilder.writes||[]).length>0,builderItems:selected.map(p=>({id:p.id,name:p.name,category:p.category,image:mainProductImage(p)})),writes:customBuilder.writes||[]});
  updateCart();closeDrawer();toast('✓ Kendi setiniz sepete eklendi');
}

init();
