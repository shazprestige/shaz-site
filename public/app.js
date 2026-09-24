
let settings={},catalog={},cart=[],favorites=new Set();
const CART_STORAGE_KEY='shazCartV113';
function loadLocalState(){
  try{
    const favRaw=JSON.parse(localStorage.getItem('shazFavs')||'[]');
    favorites=new Set(Array.isArray(favRaw)?favRaw:[]);
    const savedCart=JSON.parse(localStorage.getItem(CART_STORAGE_KEY)||'[]');
    cart=Array.isArray(savedCart)?savedCart:[];
  }catch(_){favorites=new Set();cart=[]}
}
function persistCart(){if(adminPreviewMode)return;try{localStorage.setItem(CART_STORAGE_KEY,JSON.stringify(cart))}catch(_){}}
let activeCategory='tum';
let activeSubcategory='';
let productSort='recommended';
let productStockOnly=false;
const pendingProductNotes={};
let campaignSliderTimer=0,campaignSliderIndex=0,campaignTouchStartX=null;
const categoryHubImagePreloads=[];
function preloadCategoryHubImages(){
  const urls=new Set();
  (catalog.categories||[]).forEach(c=>{
    if(c?.cover)urls.add(String(c.cover));
    (Array.isArray(c?.subcategories)?c.subcategories:[]).forEach(sc=>{if(sc?.cover)urls.add(String(sc.cover))});
  });
  categoryHubImagePreloads.length=0;
  urls.forEach(url=>{
    const img=new Image();
    img.decoding='async';
    img.src=url;
    categoryHubImagePreloads.push(img);
    if(typeof img.decode==='function')img.decode().catch(()=>{});
  });
}
let checkoutState={payment:'cod',customer:null,requestId:null,orderNote:'',appliedCouponIds:[]};
let orderSubmitting=false;
let adminPreviewMode=false;
let activeProductDetailId='',activeProductDetailSource='catalog',activeProductDetailScrollY=0,activeCartDetailScrollTop=0,productHistoryClosing=false;
let productDetailReopenBlockedUntil=0;
const $=s=>document.querySelector(s);
const money=n=>Number(n||0).toLocaleString('tr-TR')+' TL';

function restoreCatalogView(){
  try{
    const saved=JSON.parse(sessionStorage.getItem('shazCatalogView')||'null');
    if(!saved)return;
    const validCategories=new Set(['tum',...(catalog.categories||[]).filter(c=>!c.hidden).map(c=>c.id)]);
    if(validCategories.has(saved.category))activeCategory=saved.category;
    activeSubcategory=String(saved.subcategory||'');
    if(['recommended','priceAsc','priceDesc'].includes(saved.sort))productSort=saved.sort;
    productStockOnly=!!saved.stockOnly;
  }catch(_){ }
}
function persistCatalogView(){
  if(adminPreviewMode)return;
  try{sessionStorage.setItem('shazCatalogView',JSON.stringify({category:activeCategory,subcategory:activeSubcategory,sort:productSort,stockOnly:productStockOnly}))}catch(_){ }
}
function syncCatalogViewControls(){
  const c=activeCategory==='tum'?null:(catalog.categories||[]).find(x=>x.id===activeCategory&&!x.hidden);
  if($('#catalogTitle'))$('#catalogTitle').textContent=c?.name||'Tüm Ürünler';
}

async function init(){
  loadLocalState();applyAccountHeaderHint();
  const settingsRequest=fetch('/api/settings').then(r=>r.json());
  const catalogRequest=fetch('/api/catalog').then(r=>r.json());
  settings=await settingsRequest;
  const priorityLogoUrl=settings.logoUrl||'/uploads/shaz-logo-transparent.png';
  if($('#brandLogo')){
    $('#brandLogo').onload=()=>$('#brandLogo').classList.add('logoReady');
    $('#brandLogo').onerror=()=>$('#brandLogo').classList.remove('logoReady');
    $('#brandLogo').src=priorityLogoUrl;
  }
  catalog=await catalogRequest;
  preloadCategoryHubImages();
  catalog.checkoutCampaigns=Array.isArray(catalog.checkoutCampaigns)?catalog.checkoutCampaigns:[];
  catalog.checkoutUpsells=Array.isArray(catalog.checkoutUpsells)?catalog.checkoutUpsells:[];
  catalog.personalizationPricing=catalog.personalizationPricing||{first:75,second:50,thirdPlus:50};catalog.personalizationPricing.first=75;catalog.personalizationPricing.second=50;catalog.personalizationPricing.thirdPlus=50;
  catalog.builder=(catalog.builder&&typeof catalog.builder==='object')?catalog.builder:{};
  if(catalog.builder.enabled===undefined)catalog.builder.enabled=false;
  settings.paymentMethods=(settings.paymentMethods&&typeof settings.paymentMethods==='object')?settings.paymentMethods:{};
  if(settings.paymentMethods.cod===undefined)settings.paymentMethods.cod=true;
  if(settings.paymentMethods.online===undefined)settings.paymentMethods.online=true;
  (catalog.products||[]).forEach(p=>{
    if(p.writeEnabled===undefined){
      const n=String(((catalog.categories||[]).find(c=>c.id===p.category)||{}).name||p.category||'').toLocaleLowerCase('tr-TR')+' '+String(p.name||'').toLocaleLowerCase('tr-TR');
      p.writeEnabled=!(n.includes('tesb')||n.includes('tesp'));
    }
  });
  restoreCatalogView();
  favorites=new Set([...favorites].filter(id=>(catalog.products||[]).some(p=>p.id===id&&!p.hidden)));
  try{localStorage.setItem('shazFavs',JSON.stringify([...favorites]))}catch(_){}
  syncCatalogViewControls();
  ensureProductHistoryBase();
  apply(); renderCampaignCards(); renderCategories(); renderProducts(); bindCore(); updateFavoriteBadge(); updateCart(); bindFloatingContacts(); renderSiteAnnouncement(); ensureAccountStateReady().catch(()=>{});
  const sharedProductId=productRouteId();
  if(sharedProductId&&catalog.products.some(p=>p.id===sharedProductId)) setTimeout(()=>openProductDetail(sharedProductId,'shared'),0);
  else if(sharedProductId) clearProductRoute();
  if(new URLSearchParams(location.search).get('sharedCart')||new URLSearchParams(location.search).get('s'))setTimeout(()=>openSharedCartFromUrl(),40);
}
function bindCore(){
  if($('#overlay')) $('#overlay').onclick=()=>activeProductDetailId?closeProductDetail():closeDrawer();
  if(!window._shazProductPopBound){
    window._shazProductPopBound=true;
    window.addEventListener('popstate',e=>{
      const routeId=productRouteId();
      if(activeProductDetailId&&!routeId){
        // Geri dönüş hedefini yalnız ürünün gerçekten hangi ekrandan açıldığı belirler.
        // Önceki bir sepet history kaydının normal katalog ürünlerine sızmasına izin verme.
        const src=activeProductDetailSource;
        const restoreY=e.state?.shazScrollY??activeProductDetailScrollY;
        productHistoryClosing=false;
        finalizeProductDetailClose(src,restoreY);
        return;
      }
      if(routeId&&routeId!==activeProductDetailId&&catalog.products.some(p=>p.id===routeId)){
        productHistoryClosing=false;
        openProductDetail(routeId,'route');
      }
      if(isAccountPath(location.pathname)){openAccountRouteIfNeeded();return}
      if($('#drawer')?.classList.contains('drawerAccountMode'))closeDrawer();
    });
  }
  if($('#search')) $('#search').oninput=e=>renderProducts(e.target.value);
  if($('#favLink')) $('#favLink').onclick=e=>{e.preventDefault();toggleFavoritesEntry()};
  if($('#cartBtn')) $('#cartBtn').onclick=checkout;
  if($('#builderSpotlightBtn')) $('#builderSpotlightBtn').onclick=openBuilder;
  if($('#builderSpotlight')) $('#builderSpotlight').onclick=e=>{if(e.target.id!=='builderSpotlightBtn')openBuilder()};
  if($('#sortProductsBtn')) $('#sortProductsBtn').onclick=openSortPanel;
  if($('#filterProductsBtn')) $('#filterProductsBtn').onclick=openFilterPanel;
  if($('#categoryMenuBtn')) $('#categoryMenuBtn').onclick=openCategoryHub;
  if($('#categoryHubClose')) $('#categoryHubClose').onclick=closeCategoryHub;
  if($('#accountBtn')) $('#accountBtn').onclick=openAccountEntry;
  if($('#brandLogo')){const goTop=()=>window.scrollTo({top:0,left:0,behavior:'smooth'});$('#brandLogo').onclick=goTop;$('#brandLogo').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();goTop()}}}
  window.addEventListener('resize',()=>{syncSubcategoryStickyOffset();positionActiveCategoryTab('auto');positionActiveSubcategoryTab('auto')},{passive:true});
  if($('#siteAnnouncementButton')) $('#siteAnnouncementButton').onclick=closeSiteAnnouncement;
}

function apply(){
  document.documentElement.style.setProperty('--paper',settings.theme?.surface||'#f6f7f8');
  document.documentElement.style.setProperty('--gold',settings.theme?.accent||'#c39a59');
  const announceVisible=settings.header?.showTopStrip!==false;
  if($('#announceWrap')) $('#announceWrap').style.display=announceVisible?'block':'none';
  document.documentElement.style.setProperty('--announce-h',announceVisible?'25px':'0px');
  if($('#campaign')) renderLoopingMarquee($('#campaign'),settings.campaignText||'');
  if($('#brandLogo')){
    const logo=$('#brandLogo');
    const logoUrl=settings.logoUrl||'/uploads/shaz-logo-transparent.png';
    if(logo.getAttribute('src')!==logoUrl)logo.src=logoUrl;
    logo.style.width=(settings.header?.logoWidth||92)+'px';
    if(logo.complete&&logo.naturalWidth>0)logo.classList.add('logoReady');
  }
  if($('#heroTitle')) $('#heroTitle').textContent=settings.heroTitle||'Tarzına uygun saatini seç.';
  if($('#heroSubtitle')) $('#heroSubtitle').textContent=settings.heroSubtitle||'Saatini seç, setini kişiselleştir ve siparişini birkaç adımda tamamla.';
  const spotlight=catalog.builder?.spotlight||{};
  if($('#builderSpotlightEyebrow')) $('#builderSpotlightEyebrow').textContent=spotlight.eyebrow||'KENDİ SETİNİ OLUŞTUR';
  if($('#builderSpotlightTitle')) $('#builderSpotlightTitle').textContent=spotlight.title||'Setini sen seç.';
  if($('#builderSpotlightText')) $('#builderSpotlightText').textContent=spotlight.text||'Ürünlerini bir araya getir, özel set fiyatını anında gör.';
  if($('#builderSpotlight')){
    const card=$('#builderSpotlight');
    const img=String(spotlight.imageUrl||'').trim();
    const reveal=()=>{card.classList.remove('builderImagePending')};
    card.classList.toggle('hasCustomImage',!!img);
    if(img){
      card.classList.remove('builderImagePending');
      const pre=new Image();
      pre.onload=()=>{card.style.backgroundImage=`linear-gradient(90deg,rgba(10,14,20,.82),rgba(20,28,38,.58)),url("${img.replace(/"/g,'%22')}")`;reveal()};
      pre.onerror=()=>{card.style.backgroundImage='';card.classList.remove('hasCustomImage');reveal()};
      pre.src=img;
    }else{card.style.backgroundImage='';reveal()}
  }
  if($('#wa')) $('#wa').href='https://wa.me/'+settings.whatsapp;
  if($('#ig')) $('#ig').href='https://ig.me/m/'+String(settings.instagram||'').replace(/^@/,'');
  if($('#cargoLink')) $('#cargoLink').href=settings.cargoTrackingUrl||'https://ebranch.araskargo.com.tr/';
}
function announcementSignature(cfg={}){
  const raw=[cfg.eyebrow||'',cfg.title||'',cfg.text||'',cfg.buttonText||'',cfg.titleFontSize||30,cfg.textFontSize||14,cfg.buttonFontSize||14].join('|');
  let h=2166136261;
  for(let i=0;i<raw.length;i++){h^=raw.charCodeAt(i);h=Math.imul(h,16777619)}
  return (h>>>0).toString(36);
}
function renderSiteAnnouncement(force=false){
  const wrap=$('#siteAnnouncement'); if(!wrap)return;
  const cfg=settings.siteAnnouncement||{};
  if(cfg.enabled===false||(!cfg.title&&!cfg.text)){wrap.classList.add('hidden');return}
  const isPreview=new URLSearchParams(location.search).get('adminpreview')==='1';
  const signature=announcementSignature(cfg);
  if(!force && !isPreview && sessionStorage.getItem('shazAnnouncementClosed:'+signature)==='1'){wrap.classList.add('hidden');return}
  const titleSize=Math.max(14,Math.min(32,Number(cfg.titleFontSize)||30));
  const textSize=Math.max(12,Math.min(24,Number(cfg.textFontSize)||14));
  const buttonSize=Math.max(12,Math.min(22,Number(cfg.buttonFontSize)||14));
  wrap.style.setProperty('--announcement-title-size',titleSize+'px');
  wrap.style.setProperty('--announcement-text-size',textSize+'px');
  wrap.style.setProperty('--announcement-button-size',buttonSize+'px');
  if($('#siteAnnouncementEyebrow')) $('#siteAnnouncementEyebrow').textContent=cfg.eyebrow||'DUYURU';
  if($('#siteAnnouncementTitle')) $('#siteAnnouncementTitle').textContent=cfg.title||'Duyuru';
  if($('#siteAnnouncementText')) $('#siteAnnouncementText').textContent=cfg.text||'';
  if($('#siteAnnouncementButton')) $('#siteAnnouncementButton').setAttribute('aria-label',cfg.buttonText||'Duyuruyu kapat');
  wrap.dataset.announcementSignature=signature;
  wrap.classList.remove('hidden');
}
function closeSiteAnnouncement(){
  const wrap=$('#siteAnnouncement');
  wrap?.classList.add('hidden');
  if(new URLSearchParams(location.search).get('adminpreview')!=='1'){
    const sig=wrap?.dataset?.announcementSignature||announcementSignature(settings.siteAnnouncement||{});
    sessionStorage.setItem('shazAnnouncementClosed:'+sig,'1');
  }
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
  const rawMarquee=String(settings.campaignMarqueeText||'').trim();
  const oldDefaultMarquee=rawMarquee.toLocaleLowerCase('tr-TR').replace(/[’']/g,"'").includes('yeni ürünlerimizi keşfedin');
  const marquee=(rawMarquee && !oldDefaultMarquee)?rawMarquee:'SHAZ’I KEŞFET • KOLEKSİYONU İNCELE •';
  const marqueePos=['center','middle'].includes(settings.campaignMarqueePosition)?settings.campaignMarqueePosition:'full';
  const marqueeOffset=Math.max(-4,Math.min(48,Number(settings.campaignMarqueeOffset)||0));
  wrap.innerHTML=`<section class="campaignSlider" id="campaignSlider" aria-label="Kampanyalar">
    <div class="campaignSlides">${cards.map((c,i)=>{
      const op=Math.min(.75,Math.max(0,Number(c.overlayOpacity??28)/100));
      const validPos=v=>['top','uppermid','middle','lowermid','bottom'].includes(v)?v:'';
      const titlePos=validPos(c.titlePosition);
      const subtitlePos=validPos(c.subtitlePosition);
      const customLayout=!!(titlePos||subtitlePos);
      const effectiveTitlePos=customLayout?(titlePos||'lowermid'):'';
      const effectiveSubtitlePos=customLayout?(subtitlePos||'bottom'):'';
      const titleSize=Number(c.titleFontSize)>0?Math.max(10,Math.min(80,Number(c.titleFontSize))):0;
      const subtitleSize=Number(c.subtitleFontSize)>0?Math.max(9,Math.min(60,Number(c.subtitleFontSize))):0;
      return `<article class="campaignSlide ${i===campaignSliderIndex?'isActive':''}" data-slide-index="${i}" data-campaign-id="${escapeAttr(c.id||('slide-'+i))}" style="--campaign-overlay:${op}">
        <div class="campaignSlideBackdrop" style="background-image:url('${escapeAttr(c.imageUrl)}')"></div>
        <img class="campaignSlideImage" src="${escapeAttr(c.imageUrl)}" alt="${escapeAttr(c.title||'SHAZ kampanya')}">
        <div class="campaignSlideShade"></div>
        <div class="campaignContent ${customLayout?'campaignContent--customText':''}">
          ${c.title?`<h2 class="${effectiveTitlePos?'campaignTextPlaced campaignTextPos-'+effectiveTitlePos:''}"${titleSize?` style="font-size:${titleSize}px"`:''}>${escapeHtml(c.title)}</h2>`:''}
          ${c.subtitle?`<p class="${effectiveSubtitlePos?'campaignTextPlaced campaignTextPos-'+effectiveSubtitlePos:''}"${subtitleSize?` style="font-size:${subtitleSize}px"`:''}>${escapeHtml(c.subtitle)}</p>`:''}
          ${c.buttonText?`<button class="campaignBtn" type="button" data-campaign-target="${escapeAttr(c.targetCategory||'tum')}">${escapeHtml(c.buttonText)}</button>`:''}
        </div>
      </article>`}).join('')}</div>
    ${marquee?`<div class="campaignGlobalMarquee campaignGlobalMarquee--${marqueePos}" style="--campaign-marquee-offset:${marqueeOffset}px"><div class="campaignMarqueeTrack">${Array.from({length:14},(_,n)=>`<span class="campaignMarqueeCopy"${n?` aria-hidden="true"`:''}>${escapeHtml(marquee)}</span>`).join('')}</div></div>`:''}
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
function visibleSubcategories(category){
  return (Array.isArray(category?.subcategories)?category.subcategories:[]).filter(s=>!s.hidden).sort((a,b)=>(a.order||0)-(b.order||0));
}
function categoryDefaultGroupName(category){
  return String(category?.defaultSubcategoryName||'Ana ürünler');
}
function subcategoryById(category,id){return visibleSubcategories(category).find(s=>s.id===id)||null}
function subcategoryChooserHtml(category){
  const subs=visibleSubcategories(category);if(!subs.length)return '';
  const hasMain=(catalog.products||[]).some(p=>!p.hidden&&p.category===category.id&&!p.subcategoryId);
  const tabs=[];
  if(hasMain)tabs.push({id:'',name:categoryDefaultGroupName(category)});
  subs.forEach(s=>tabs.push(s));
  if(!tabs.length)return '';
  if(activeSubcategory && !tabs.some(s=>s.id===activeSubcategory))activeSubcategory=tabs[0].id||'';
  return `<div class=subcategoryChooser><div class=subcategoryTabs>${tabs.map(s=>`<button class="subcategoryTab ${activeSubcategory===(s.id||'')?'active':''}" onclick="selectSubcategory('${escapeAttr(s.id||'')}')">${escapeHtml(s.name||'Alt kategori')}</button>`).join('')}</div></div>`;
}
function syncSubcategoryStickyOffset(){
  const announce=document.getElementById('announceWrap');
  const header=document.getElementById('stickyHeader');
  const announceH=announce?.getBoundingClientRect().height||0;
  const headerH=header?.getBoundingClientRect().height||0;
  document.documentElement.style.setProperty('--subcategory-sticky-top',`${Math.round(announceH+headerH)}px`);
}
function positionActiveSubcategoryTab(behavior='smooth'){
  const nav=document.querySelector('.subcategoryTabs');
  if(!nav)return;
  const tabs=[...nav.querySelectorAll('.subcategoryTab')];
  const active=tabs.find(x=>x.classList.contains('active'));
  if(!active)return;
  const desired=active.offsetLeft-(nav.clientWidth-active.offsetWidth)/2;
  const max=Math.max(0,nav.scrollWidth-nav.clientWidth);
  nav.scrollTo({left:Math.max(0,Math.min(max,desired)),behavior});
}
function selectSubcategory(id){
  activeSubcategory=id||'';
  persistCatalogView();
  renderProducts($('#search')?.value||'');
  requestAnimationFrame(()=>{syncSubcategoryStickyOffset();positionActiveSubcategoryTab('smooth')});
}

function positionActiveCategoryTab(behavior='smooth'){
  const nav=$('#catalogNav');
  if(!nav)return;
  const tabs=[...nav.querySelectorAll('.tab')];
  const active=tabs.find(x=>x.classList.contains('active'));
  if(!active)return;
  const index=tabs.indexOf(active);
  // İlk üç kategori başlangıçta sabit görünür. Daha sağdaki kategorilerde ise
  // seçili başlığın merkezi ekranın gerçek yatay merkezine gelir. Sonlara
  // gelindiğinde doğal kaydırma sınırı korunur.
  if(index<=2){nav.scrollTo({left:0,behavior});return}
  const navRect=nav.getBoundingClientRect();
  const viewportCenter=(window.innerWidth||document.documentElement.clientWidth)/2;
  const targetX=viewportCenter-navRect.left;
  const desired=active.offsetLeft+active.offsetWidth/2-targetX;
  const max=Math.max(0,nav.scrollWidth-nav.clientWidth);
  nav.scrollTo({left:Math.max(0,Math.min(max,desired)),behavior});
}

function renderCategories(){
  if(activeCategory!=='tum' && !(catalog.categories||[]).some(c=>c.id===activeCategory&&!c.hidden)){activeCategory='tum';activeSubcategory='';persistCatalogView();syncCatalogViewControls()}
  const cats=[{id:'tum',name:'Tüm Ürünler',order:-1},...catalog.categories.filter(c=>!c.hidden&&c.id!=='tum')].sort((a,b)=>(a.order??0)-(b.order??0));
  const nav=$('#catalogNav');
  if(!nav)return;
  nav.innerHTML=cats.map(c=>`<button class="tab ${activeCategory===c.id?'active':''}" title="${escapeAttr(c.name)}" data-category-id="${escapeAttr(c.id)}" data-category-name="${escapeAttr(c.name)}">${escapeHtml(c.name)}</button>`).join('');
  nav.querySelectorAll('.tab').forEach(btn=>{
    btn.addEventListener('click',()=>setCategory(btn.dataset.categoryId,btn.dataset.categoryName,{scroll:true}));
  });
  requestAnimationFrame(()=>{positionActiveCategoryTab('auto');syncSubcategoryStickyOffset()});
  setTimeout(()=>positionActiveCategoryTab('auto'),80);
}

let categoryHubParentId='';
function openCategoryHub(){
  categoryHubParentId='';
  renderCategoryHub();
  $('#categoryHub')?.classList.remove('hidden');
  document.body.classList.add('categoryHubOpen');
}
function closeCategoryHub(){
  categoryHubParentId='';
  $('#categoryHub')?.classList.add('hidden');
  document.body.classList.remove('categoryHubOpen');
}
function categoryHubHead(title,subtitle){
  const top=$('#categoryHub .categoryHubTop');if(!top)return;
  top.innerHTML=`<button class="categoryBack" id="categoryHubClose">←</button><div><b>${escapeHtml(title)}</b><small>${escapeHtml(subtitle)}</small></div>`;
  $('#categoryHubClose').onclick=()=>{if(categoryHubParentId){categoryHubParentId='';renderCategoryHub()}else closeCategoryHub()};
}
function renderCategoryHub(){
  const wrap=$('#categoryHubGrid'); if(!wrap)return;
  if(categoryHubParentId){
    const c=(catalog.categories||[]).find(x=>x.id===categoryHubParentId&&!x.hidden);
    if(!c){categoryHubParentId='';return renderCategoryHub()}
    categoryHubHead(c.name,'Alt kategoriler');
    const subs=visibleSubcategories(c);
    const hasMain=(catalog.products||[]).some(p=>!p.hidden&&p.category===c.id&&!p.subcategoryId);
    const cards=[];
    if(hasMain)cards.push({id:'',name:categoryDefaultGroupName(c),cover:c.cover||''});
    subs.forEach(x=>cards.push(x));
    wrap.innerHTML=cards.map(sc=>`<div class="categoryFreshCell"><button class="categoryFreshCard ${sc.cover?'hasCover':''}" onclick="chooseSubcategoryFromHub('${escapeAttr(c.id)}','${escapeAttr(sc.id||'')}','${escapeAttr(c.name)}')">${sc.cover?`<img class="categoryFreshImage" src="${escapeAttr(sc.cover)}" alt="${escapeAttr(sc.name||'Alt kategori')}">`:`<span class="categoryFreshPlaceholder">${escapeHtml((sc.name||'?').slice(0,1))}</span>`}<span class="categoryFreshShade" aria-hidden="true"></span><span class="categoryFreshCopy"><b>${escapeHtml(sc.name||'Alt kategori')}</b><span>Ürünleri gör →</span></span></button></div>`).join('');
    return;
  }
  categoryHubHead('Kategoriler','Tüm kategoriler');
  const cats=[{id:'tum',name:'Tüm Ürünler',cover:catalog.allProductsCover||'',allProducts:true},...catalog.categories.filter(c=>!c.hidden&&c.id!=='tum').sort((a,b)=>(a.order??0)-(b.order??0))];
  wrap.innerHTML=cats.map(c=>`<div class="categoryFreshCell"><button class="categoryFreshCard ${c.cover?'hasCover':''} ${c.allProducts?'allProductsTile':''}" onclick="chooseCategoryFromHub('${escapeAttr(c.id)}','${escapeAttr(c.name)}')">${c.cover?`<img class="categoryFreshImage" src="${escapeAttr(c.cover)}" alt="${escapeAttr(c.name)}">`:`<span class="categoryFreshPlaceholder">${c.allProducts?'TÜ':escapeHtml((c.name||'?').slice(0,1))}</span>`}<span class="categoryFreshShade" aria-hidden="true"></span><span class="categoryFreshCopy"><b>${escapeHtml(c.name)}</b><span>${c.allProducts?'Tümünü gör →':'Ürünleri gör →'}</span></span></button></div>`).join('');
}
function chooseCategoryFromHub(id,name){
  const c=(catalog.categories||[]).find(x=>x.id===id&&!x.hidden);
  if(c&&visibleSubcategories(c).length){categoryHubParentId=id;renderCategoryHub();return}
  setCategory(id,name,{scroll:false});
  closeCategoryHub();
  scrollCategoryHubToProducts();
}
function chooseSubcategoryFromHub(categoryId,subId,name){
  setCategory(categoryId,name,{scroll:false});
  activeSubcategory=subId||'';
  persistCatalogView();
  renderProducts($('#search')?.value||'');
  closeCategoryHub();
  scrollCategoryHubToProducts();
}
function scrollCategoryHubToProducts(){
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
  activeSubcategory='';
  persistCatalogView();
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

function recommendedOrderIndex(id){
  const order=Array.isArray(catalog.recommendedProductOrder)?catalog.recommendedProductOrder:[];
  const i=order.indexOf(id);
  return i<0?999999:i;
}
function openCatalogChoicePanel(title,bodyHtml){
  document.querySelector('.catalogChoiceOverlay')?.remove();
  const el=document.createElement('div');el.className='catalogChoiceOverlay';
  el.innerHTML=`<div class="catalogChoiceCard"><div class="catalogChoiceHead"><b>${escapeHtml(title)}</b><button type="button" onclick="this.closest('.catalogChoiceOverlay').remove()">×</button></div>${bodyHtml}</div>`;
  el.addEventListener('click',e=>{if(e.target===el)el.remove()});
  document.body.appendChild(el);
}
function setProductSort(value){
  productSort=value;persistCatalogView();renderProducts($('#search')?.value||'');
  document.querySelector('.catalogChoiceOverlay')?.remove();
}
function openSortPanel(){
  openCatalogChoicePanel('Sıralama',`
    <button class="catalogChoiceRow ${productSort==='recommended'?'active':''}" onclick="setProductSort('recommended')">Önerilen sıralama</button>
    <button class="catalogChoiceRow ${productSort==='priceAsc'?'active':''}" onclick="setProductSort('priceAsc')">Fiyata göre (Artan)</button>
    <button class="catalogChoiceRow ${productSort==='priceDesc'?'active':''}" onclick="setProductSort('priceDesc')">Fiyata göre (Azalan)</button>`);
}
function setStockOnly(value){
  productStockOnly=!!value;persistCatalogView();renderProducts($('#search')?.value||'');
}
function openFilterPanel(){
  openCatalogChoicePanel('Filtreleme',`<label class="stockFilterRow"><span>Stoktakiler</span><input type="checkbox" ${productStockOnly?'checked':''} onchange="setStockOnly(this.checked)"><i></i></label>`);
}
function openProductNote(id){
  const p=catalog.products.find(x=>x.id===id);if(!p)return;
  const current=pendingProductNotes[id]||'';
  document.querySelector('.productNoteOverlay')?.remove();
  const el=document.createElement('div');el.className='productNoteOverlay';
  el.innerHTML=`<div class="productNotePaper"><button class="productNoteClose" type="button" onclick="this.closest('.productNoteOverlay').remove()">×</button><div class="productNoteLabel">SİPARİŞ NOTU</div><h3>${escapeHtml(p.name||'Ürün')}</h3><textarea id="productNoteText" maxlength="500" placeholder="Siparişiniz için notunuzu buraya yazın...">${escapeHtml(current)}</textarea><button class="btn productNoteSave" type="button" onclick="saveProductNote('${escapeAttr(id)}')">Notu Kaydet</button></div>`;
  document.body.appendChild(el);
  setTimeout(()=>document.getElementById('productNoteText')?.focus(),30);
}
function saveProductNote(id){
  const text=(document.getElementById('productNoteText')?.value||'').trim();
  if(text)pendingProductNotes[id]=text;else delete pendingProductNotes[id];
  document.querySelector('.productNoteOverlay')?.remove();
  toast(text?'✓ Sipariş notu kaydedildi':'Sipariş notu kaldırıldı');
}
function withPendingProductNote(item,p){
  const note=String(pendingProductNotes[p?.id]||'').trim();
  if(note)item.productNote=note;
  return item;
}

function renderProducts(filter=''){
  const q=(filter||'').toLocaleLowerCase('tr-TR');
  const category=activeCategory==='tum'?null:(catalog.categories||[]).find(c=>c.id===activeCategory&&!c.hidden);
  const subs=visibleSubcategories(category);
  if(category&&subs.length){
    const hasMain=(catalog.products||[]).some(p=>!p.hidden&&p.category===activeCategory&&!p.subcategoryId);
    const validIds=subs.map(s=>s.id);
    if(activeSubcategory && !validIds.includes(activeSubcategory))activeSubcategory=hasMain?'':(validIds[0]||'');
    if(!activeSubcategory && !hasMain)activeSubcategory=validIds[0]||'';
  }else activeSubcategory='';
  let list=catalog.products.filter(x=>!x.hidden&&(activeCategory==='tum'||x.category===activeCategory)&&((x.name||'')+' '+(x.description||'')).toLocaleLowerCase('tr-TR').includes(q));
  if(category&&subs.length){
    list=list.filter(x=>activeSubcategory?x.subcategoryId===activeSubcategory:!x.subcategoryId);
  }
  if(productStockOnly) list=list.filter(x=>!x.soldOutEnabled);
  if(productSort==='recommended') list=[...list].sort((a,b)=>recommendedOrderIndex(a.id)-recommendedOrderIndex(b.id));
  if(productSort==='priceAsc') list=[...list].sort((a,b)=>Number(a.price||0)-Number(b.price||0));
  if(productSort==='priceDesc') list=[...list].sort((a,b)=>Number(b.price||0)-Number(a.price||0));
  if(!$('#productsList')) return;
  const chooser=category?subcategoryChooserHtml(category):'';
  const cards=list.length?list.map(p=>{
    const name=p.name||'SHAZ Ürün';
    const desc='';
    const badgeColor=['orange','purple','red'].includes(p.badgeColor)?p.badgeColor:'orange';
    const shippingRibbonText=p.shippingRibbonText===undefined?'Kargo Bedava':String(p.shippingRibbonText||'');
    const shippingRibbon=(p.shippingRibbonEnabled&&shippingRibbonText.trim())?`<div class="productShippingRibbon" style="--shipping-ribbon-color:${escapeAttr(p.shippingRibbonColor||'#444444')}">${escapeHtml(shippingRibbonText.trim())}</div>`:'';
    return `<div class="card productCardLink" data-product-id="${escapeAttr(p.id)}" role="button" tabindex="0" onclick="openProductDetail('${p.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openProductDetail('${p.id}')}"><div class="photo" data-preview-field="photo">${mainProductImage(p)?`<img src="${escapeAttr(mainProductImage(p))}" alt="${escapeAttr(name)}">`:'⌚'}${p.soldOutEnabled?soldOutVisualBadgeHtml(p,false):(p.badge?`<span class="badge badge-${badgeColor} ${p.badgeShape==='rect'?'badge-rect':''}" data-preview-field="badge"><span class="badgeText">${escapeHtml(p.badge)}</span></span>`:'')}${shippingRibbon}<button class="fav" data-preview-field="favorite" onclick="toggleFav('${p.id}',event)">${favorites.has(p.id)?'♥':'♡'}</button></div><div class="info"><h3 data-preview-field="name">${escapeHtml(name)}</h3>${desc}<div class="price"><span data-preview-field="price">${money(p.price)}</span> ${p.oldPrice?`<span class="old" data-preview-field="oldPrice">${money(p.oldPrice)}</span>`:''}</div></div></div>`;
  }).join(''):(q?`<div class="panel subcategoryEmpty"><b>Bu bölümde henüz ürün yok.</b></div>`:`<div class="panel subcategoryEmpty"><b>Çok yakında ürünler burada olacak.</b><p>Şimdilik diğer kategorilerden alışverişinize devam edebilirsiniz. Anlayışınız için teşekkür eder, keyifli alışverişler dileriz. ☺️</p></div>`);
  $('#productsList').innerHTML=chooser+cards;
  persistCatalogView();
  requestAnimationFrame(()=>{syncSubcategoryStickyOffset();positionActiveSubcategoryTab('auto')});
}
function updateFavoriteBadge(){if($('#favBadge'))$('#favBadge').textContent=favorites.size}
function toggleFav(id,e){e?.stopPropagation();favorites.has(id)?favorites.delete(id):favorites.add(id);localStorage.setItem('shazFavs',JSON.stringify([...favorites]));updateFavoriteBadge();renderProducts($('#search')?.value||'')}
function removeFavorite(id){favorites.delete(id);localStorage.setItem('shazFavs',JSON.stringify([...favorites]));updateFavoriteBadge();renderProducts($('#search')?.value||'');showFavorites()}
function clearFavorites(){if(!favorites.size)return;favorites.clear();localStorage.setItem('shazFavs','[]');updateFavoriteBadge();renderProducts($('#search')?.value||'');showFavorites()}
function showFavorites(){
  const ps=catalog.products.filter(p=>favorites.has(p.id));
  openDrawer(`<div class="accountSubPage"><div class="wizardHead favoritesHead"><h2>Favorilerim <span class="favoritesTitleHeart">♥</span></h2><div class="favoritesHeadActions">${ps.length?`<button class="pill favoritesClear" onclick="clearFavorites()">Favorileri Temizle</button>`:''}<button class="pill favoritesClose" onclick=closeDrawer()>Kapat</button></div></div>
  ${ps.length?`<div class="favoritesList">${ps.map(p=>{const img=mainProductImage(p);return `<div class="favoriteCard"><button type="button" class="favoritePhoto" onclick="openProductDetail('${p.id}','favorites')" aria-label="${escapeAttr(p.name||'Ürün')} ürününü incele">${img?`<img src="${escapeAttr(img)}" alt="${escapeAttr(p.name||'Ürün')}">`:'⌚'}</button><div class="favoriteContent"><div class="favoriteMeta"><b>${escapeHtml(p.name)}</b><span>${money(p.price)}</span></div><div class="favoriteActions"><button class="btn" onclick="openProductDetail('${p.id}','favorites')">Ürünü İncele</button><button class="btn favoriteCartBtn" onclick="startProduct('${p.id}')">Sepete Ekle</button><button class="pill" onclick="removeFavorite('${p.id}')">Favoriden Kaldır</button></div></div></div>`}).join('')}</div>`:`<div class="favoritesEmpty"><div class="favoritesEmptyHeart">♡</div><b>Henüz favoriniz yok.</b><span>Beğendiğiniz ürünlerde kalp simgesine dokunarak buraya ekleyebilirsiniz.</span></div>`}`)
}
function toggleFavFromDetail(id){
  favorites.has(id)?favorites.delete(id):favorites.add(id);
  localStorage.setItem('shazFavs',JSON.stringify([...favorites]));
  updateFavoriteBadge();renderProducts($('#search')?.value||'');
  const b=document.getElementById('productDetailFavBtn');
  if(b){b.textContent=favorites.has(id)?'♥':'♡';b.classList.toggle('active',favorites.has(id));b.setAttribute('aria-label',favorites.has(id)?'Favorilerden kaldır':'Favorilere ekle')}
}
function productSlug(p){
  const clean=v=>String(v||'').trim().toLocaleLowerCase('tr-TR')
    .replaceAll('ı','i').replaceAll('ğ','g').replaceAll('ü','u').replaceAll('ş','s').replaceAll('ö','o').replaceAll('ç','c')
    .replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  const base=clean(p?.name||'urun')||'urun';
  const rawCode=clean(p?.internalCode||'').replace(/^shaz-?/,'');
  return rawCode?`${base}-${rawCode}`:`${base}-${clean(p?.id||'urun')}`;
}
function productShareUrl(id){
  const p=catalog.products.find(x=>x.id===id);
  const u=new URL(location.href);
  u.searchParams.delete('adminpreview');
  u.searchParams.delete('product');
  if(p)u.pathname='/urun/'+encodeURIComponent(productSlug(p));
  u.hash='';
  return u.toString();
}
async function shareProduct(id){
  const p=catalog.products.find(x=>x.id===id); if(!p)return;
  const url=productShareUrl(id);
  const data={title:p.name||'SHAZ Ürün',text:`${p.name||'SHAZ Ürün'} - SHAZ`,url};
  try{
    if(navigator.share){await navigator.share(data);return}
    if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(url);toast('Ürün bağlantısı kopyalandı');return}
    window.prompt('Ürün bağlantısını kopyalayın:',url);
  }catch(e){
    if(e?.name!=='AbortError'){
      try{await navigator.clipboard?.writeText(url);toast('Ürün bağlantısı kopyalandı')}catch(_){window.prompt('Ürün bağlantısını kopyalayın:',url)}
    }
  }
}
function productRouteId(){
  const legacy=new URLSearchParams(location.search).get('product')||'';
  if(legacy)return legacy;
  const m=location.pathname.match(/^\/urun\/([^/]+)\/?$/);
  if(!m)return '';
  let slug='';
  try{slug=decodeURIComponent(m[1])}catch{slug=m[1]}
  return (catalog.products||[]).find(p=>productSlug(p)===slug)?.id||'';
}
function setProductRoute(id,mode='replace',extraState={}){
  if(adminPreviewMode||new URLSearchParams(location.search).get('adminpreview')==='1')return;
  const u=new URL(location.href);
  u.searchParams.delete('product');
  if(id){
    const p=catalog.products.find(x=>x.id===id);
    u.pathname=p?'/urun/'+encodeURIComponent(productSlug(p)):'/';
  }else if(/^\/urun\//.test(u.pathname))u.pathname='/';
  const state={...(history.state||{}),...extraState,shazProduct:id||null};
  history[mode==='push'?'pushState':'replaceState'](state,'',u.pathname+u.search+u.hash);
}
function clearProductRoute(){if(productRouteId()||/^\/urun\//.test(location.pathname))setProductRoute('','replace',{shazProductPushed:false})}
function finalizeProductDetailClose(source=activeProductDetailSource||'catalog',restoreY=activeProductDetailScrollY){
  activeProductDetailId='';activeProductDetailSource='catalog';setProductDetailScrollLock(false);
  if(source==='favorites'){showFavorites();return}
  if(source==='accountFavorites'){showAccountFavorites(false);return}
  if(source==='builder'){builderReturnFromDetail();return}
  if(source==='cart'){checkout(activeCartDetailScrollTop);return}
  closeDrawer();
  if(Number.isFinite(Number(restoreY)))requestAnimationFrame(()=>window.scrollTo({top:Number(restoreY),left:0,behavior:'auto'}));
}
function ensureProductHistoryBase(){
  if(adminPreviewMode||new URLSearchParams(location.search).get('adminpreview')==='1')return;
  const st=history.state||{};
  if(!st.shazBase)history.replaceState({...st,shazBase:true,shazScrollY:window.scrollY||0},'',location.href);
}
function setProductDetailScrollLock(on){
  document.body.classList.toggle('productDetailOpen',!!on);
  document.documentElement.classList.toggle('productDetailOpen',!!on);
}
function openDrawer(html){
  closeSavedAddressSuggestions();
  const markup=String(html||'');
  const isProductDetail=markup.includes('productDetailShell');
  const isWizard=!isProductDetail&&markup.includes('wizardHead');
  const resetFlowScroll=!isProductDetail&&(isWizard||markup.includes('checkoutShell'));
  const isAccount=markup.includes('accountPageShell')||markup.includes('accountShell')||markup.includes('accountSubPage');
  if(!isProductDetail&&activeProductDetailId){activeProductDetailId='';activeProductDetailSource='catalog';clearProductRoute()}
  setProductDetailScrollLock(isProductDetail);
  const drawer=$('#drawer');
  drawer?.classList.toggle('productDetailDrawer',isProductDetail);
  drawer?.classList.toggle('drawerAccountMode',isAccount);
  drawer?.classList.remove('drawerCartMode','drawerAddressMode','drawerUpsellMode','drawerWizardMode');
  if(markup.includes('checkoutShell--cart'))drawer?.classList.add('drawerCartMode');
  else if(markup.includes('checkoutShell--address'))drawer?.classList.add('drawerAddressMode');
  else if(markup.includes('checkoutUpsellShell'))drawer?.classList.add('drawerUpsellMode');
  else if(markup.includes('wizardHead'))drawer?.classList.add('drawerWizardMode');
  document.body.classList.add('drawerOpen');
  document.documentElement.classList.add('drawerOpen');
  if(isAccount)$('#overlay').classList.add('hidden');else $('#overlay').classList.remove('hidden');drawer.classList.remove('hidden');drawer.innerHTML=html;if(isAccount)finishAccountRouteBoot();
  if(isProductDetail||resetFlowScroll)drawer.scrollTop=0;
  requestAnimationFrame(()=>{
    if(isProductDetail||resetFlowScroll){
      drawer.scrollTop=0;
      drawer.querySelectorAll('.checkoutScrollBody').forEach(el=>{el.scrollTop=0});
    }
    drawer.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]),textarea,select').forEach(el=>{if(!el.style.fontSize)el.style.fontSize='16px'});
    // Klavye davranışı yalnız adres ekranında değil, drawer içindeki TÜM yazı alanlarında çalışır.
    // Böylece set kişiselleştirme/yazı ekranlarında da alttaki katalog klavye arkasından görünmez.
    bindDrawerInputFocus();
    bindDrawerScrollGuard();
    if(isAccount)protectAuthInputOverlays()
  });
}
function closeDrawer(){
  closeSavedAddressSuggestions();
  if(activeProductDetailId){activeProductDetailId='';activeProductDetailSource='catalog';clearProductRoute()}
  setProductDetailScrollLock(false);
  document.body.classList.remove('shazKeyboardOpen','drawerOpen');
  document.documentElement.classList.remove('drawerOpen');
  $('#drawer')?.classList.remove('productDetailDrawer','drawerCartMode','drawerAddressMode','drawerUpsellMode','drawerWizardMode','drawerAccountMode');
  $('#overlay').classList.add('hidden');const d=$('#drawer');if(d){d.classList.add('hidden');delete d.dataset.view}
}
function closeProductDetail(source=activeProductDetailSource||'catalog'){
  if(!activeProductDetailId)return closeDrawer();
  productDetailReopenBlockedUntil=Date.now()+300;
  const restoreY=activeProductDetailScrollY;
  if(!adminPreviewMode&&history.state?.shazProductPushed&&productRouteId()){
    productHistoryClosing=true;
    history.back();
    return;
  }
  clearProductRoute();
  finalizeProductDetailClose(source,restoreY);
}
function toast(msg){const t=$('#toast');if(!t)return;t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2200)}
function centerToast(msg,ms=1350){const t=$('#toast');if(!t)return;t.textContent=msg;t.classList.add('toastCenter','show');clearTimeout(t._centerTimer);t._centerTimer=setTimeout(()=>t.classList.remove('show','toastCenter'),ms)}
function finishAccountRouteBoot(){clearTimeout(window.__shazAccountBootTimer);document.documentElement.classList.remove('accountRouteBootSafe')}
function personalizationFeeAt(i){return i===0?75:50}
function cartPersonalizationSlotCount(){
  let slot=0;
  cart.forEach(x=>{
    const writes=Array.isArray(x.writes)?x.writes:Array.isArray(x.setCustomization?.writes)?x.setCustomization.writes:[];
    const photos=Array.isArray(x.photoCustomizations)?x.photoCustomizations:Array.isArray(x.setCustomization?.photoCustomizations)?x.setCustomization.photoCustomizations:[];
    if(x.setCustomization){
      const keys=new Set();
      writes.forEach(w=>keys.add(String(w.itemId||w.item||'set-write')));
      photos.forEach(ph=>keys.add(String(ph.itemId||ph.item||'set-photo')));
      slot+=keys.size;
    }else if(writes.length||photos.length) slot+=1;
  });
  return slot;
}
function nextSingleWriteFee(){return personalizationFeeAt(cartPersonalizationSlotCount())}
function nextWalletPricingPreview(){
  const slotCount=cartPersonalizationSlotCount();
  const slotFee=personalizationFeeAt(slotCount);
  const photoExtraFee=walletPhotoFee();
  return {slotCount,slotFee,writeFee:slotFee,photoExtraFee,totalPhotoOnly:slotFee+photoExtraFee,totalWriteAndPhoto:slotFee+photoExtraFee};
}
function normalizeCartPersonalizationFees(){
  let slot=0;
  cart.forEach(x=>{
    if(x.setCustomization){
      const sw=Array.isArray(x.setCustomization.writes)?x.setCustomization.writes:[];
      const sp=Array.isArray(x.setCustomization.photoCustomizations)?x.setCustomization.photoCustomizations:[];
      const keys=[];[...sw,...sp].forEach(v=>{const k=String(v.itemId||v.item||'set-item');if(!keys.includes(k))keys.push(k)});
      let personalTotal=0;
      keys.forEach(k=>{
        const tier=personalizationFeeAt(slot++);
        const writes=sw.filter(w=>String(w.itemId||w.item||'set-item')===k);
        const photos=sp.filter(ph=>String(ph.itemId||ph.item||'set-item')===k);
        writes.forEach((w,idx)=>{w.fee=idx===0?tier:0;personalTotal+=Number(w.fee||0)});
        photos.forEach((ph,idx)=>{ph.slotFee=(!writes.length&&idx===0)?tier:0;ph.photoExtraFee=walletPhotoFee();ph.fee=Number(ph.slotFee||0)+Number(ph.photoExtraFee||0);personalTotal+=Number(ph.fee||0)});
      });
      const base=Number(x.basePrice??x.product?.price??0);x.basePrice=base;
      const removed=(x.setCustomization.removedIds||[]).map(id=>(x.product.setItems||[]).find(si=>si.id===id)).filter(Boolean).reduce((sum,si)=>sum+Number(si.removeDiscount||0),0);
      x.product={...x.product,price:Math.max(0,base-removed+personalTotal)};
      return;
    }
    const writes=Array.isArray(x.writes)?x.writes:[],photos=Array.isArray(x.photoCustomizations)?x.photoCustomizations:[];
    if(!writes.length&&!photos.length)return;
    const base=Number(x.basePrice??x.product?.price??0);x.basePrice=base;
    const tier=personalizationFeeAt(slot++);let personalTotal=0;
    writes.forEach((w,idx)=>{w.fee=idx===0?tier:0;personalTotal+=Number(w.fee||0)});
    photos.forEach((ph,idx)=>{ph.slotFee=(!writes.length&&idx===0)?tier:0;ph.photoExtraFee=walletPhotoFee();ph.fee=Number(ph.slotFee||0)+Number(ph.photoExtraFee||0);personalTotal+=Number(ph.fee||0)});
    x.product={...x.product,price:base+personalTotal};
  });
}
function updateCart(){
  normalizeCartPersonalizationFees();
  persistCart();
  const count=cart.reduce((s,x)=>s+Number(x.qty||1),0);
  if($('#cartCount')) $('#cartCount').textContent=count;
  if($('#cartBadge')) $('#cartBadge').textContent=count;
}
function closeSoftNotice(){document.querySelector('.softNoticeOverlay')?.remove()}
function showSoftNotice(title,text,actionText='',actionJs=''){
  closeSoftNotice();
  const box=document.createElement('div');
  box.className='softNoticeOverlay';
  box.innerHTML=`<div class="softNoticeCard"><button class="softNoticeClose" type="button" onclick="closeSoftNotice()">×</button><h3>${escapeHtml(title||'Bilgi')}</h3><p>${escapeHtml(text||'')}</p><div class="softNoticeActions softNoticeActions--center">${actionText?`<button type="button" class="btn" onclick="${actionJs}">${escapeHtml(actionText)}</button>`:''}</div></div>`;
  document.body.appendChild(box);
}

/* Yönetim panelindeki canlı önizleme için kaydetmeden geçici değişiklik */
window.addEventListener('message',e=>{
  if(!e.data)return;
  if(e.data.type==='shaz-preview'){
    adminPreviewMode=true;
    if(e.data.settings) settings=structuredClone(e.data.settings);
    if(e.data.catalog) catalog=structuredClone(e.data.catalog);
    if(activeCategory!=='tum' && !(catalog.categories||[]).some(c=>c.id===activeCategory&&!c.hidden)){activeCategory='tum';activeSubcategory=''}
    apply();renderCampaignCards();renderCategories();renderProducts($('#search')?.value||'');
    updateFavoriteBadge();updateCart();$('#siteAnnouncement')?.classList.add('hidden');
    return;
  }
  if(e.data.type==='shaz-preview-set-stage'){
    $('#siteAnnouncement')?.classList.add('hidden');
    const p=catalog.products.find(x=>x.id===e.data.setId);
    if(!p||!p.isSet||!Array.isArray(p.setItems)||!p.setItems.length)return;
    const itemId=e.data.itemId||p.setItems[0].id;
    wiz={product:p,keptIds:p.setItems.map(x=>x.id),writes:[],pendingWriteIds:[itemId],step:1,history:[]};
    if(e.data.stage==='write')renderWriteDetails(true);else renderRemovalSelection(true);
    setTimeout(()=>{
      document.querySelectorAll('.adminPreviewHighlight').forEach(x=>x.classList.remove('adminPreviewHighlight'));
      const stage=e.data.stage==='write'?'write':'remove';
      const el=[...document.querySelectorAll(`[data-set-preview-stage="${stage}"]`)].find(x=>x.dataset.setPreviewItem===itemId);
      if(!el)return;
      el.classList.add('adminPreviewHighlight');
      if(e.data.scroll!==false)el.scrollIntoView({behavior:'auto',block:'center'});
    },40);
    return;
  }
  if(e.data.type==='shaz-preview-product-stage'){
    $('#siteAnnouncement')?.classList.add('hidden');
    const p=catalog.products.find(x=>x.id===e.data.productId); if(!p)return;
    if(e.data.stage==='write') singleWriteStep(p.id);
    else if(e.data.stage==='wallet'){
      if(walletPhotoAvailable(p)) singleWalletPhotoStep(p.id); else startSingleWizard(p);
    } else {
      startSingleWizard(p);
    }
    setTimeout(()=>{
      document.querySelectorAll('.adminPreviewHighlight').forEach(x=>x.classList.remove('adminPreviewHighlight'));
      let el=e.data.stage==='write'?document.querySelector('.recommendedHint'):(document.querySelector('.walletPhotoChoice')||document.querySelector('.walletPhotoCard')||document.querySelector('.wizardCard'));
      if(el){el.classList.add('adminPreviewHighlight');el.scrollIntoView({behavior:'auto',block:'center'});}
    },40);
    return;
  }
  if(e.data.type==='shaz-preview-focus'){
    const target=e.data.target;
    const shouldScroll=e.data.scroll!==false;

    document.querySelectorAll('.adminPreviewHighlight').forEach(x=>x.classList.remove('adminPreviewHighlight'));

    if(target && target.includes('siteAnnouncement'))renderSiteAnnouncement(true); else $('#siteAnnouncement')?.classList.add('hidden');
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
  // Hazır setlerde setItems, ürün çıkarma/kişiselleştirme akışının verisidir.
  // Ürün detayında yalnızca yönetimde özellikle yazılan özellikler gösterilir;
  // böylece aynı içerik adları ikinci kez listelenmez.
  return [...new Set(manual)];
}
function soldOutRemaining(p){const raw=String(p?.soldOutUntil||'').trim();if(!p?.soldOutEnabled||!raw)return '';const t=Date.parse(raw);if(!Number.isFinite(t))return raw;const d=t-Date.now();if(d<=0)return 'Yakında yeniden stokta';const days=Math.floor(d/86400000),hrs=Math.floor((d%86400000)/3600000),mins=Math.floor((d%3600000)/60000),secs=Math.floor((d%60000)/1000);return `${days?days+' gün ':''}${hrs?hrs+' saat ':''}${mins?mins+' dk ':''}${secs+' sn'} sonra yeniden stokta`;}
function soldOutVisualBadgeHtml(p,detail=false){return p?.soldOutEnabled?`<span class="soldOutVisualBadge ${detail?'soldOutVisualBadge--detail':''}">TÜKENDİ</span>`:'';}
function soldOutButtonHtml(p){return p?.soldOutEnabled?`<button class="btn detailAddBtn soldOutBtn ${p.soldOutUntil?'soldOutBtn--timed':'soldOutBtn--plain'}" disabled><span>TÜKENDİ</span>${p.soldOutUntil?`<small data-soldout-id="${escapeAttr(p.id)}">${escapeHtml(soldOutRemaining(p))}</small>`:''}</button>`:`<button class="btn detailAddBtn" onclick="startProduct('${escapeAttr(p.id)}')">Sepete Ekle</button>`;}
function openProductDetail(id,source='catalog'){
  if(!activeProductDetailId&&source==='catalog'&&Date.now()<productDetailReopenBlockedUntil)return;
  const p=catalog.products.find(x=>x.id===id); if(!p)return;
  const wasOpen=!!activeProductDetailId;
  if(!wasOpen)activeProductDetailScrollY=window.scrollY||document.documentElement.scrollTop||0;
  activeProductDetailId=id;activeProductDetailSource=source;
  if(source==='shared'||source==='route'){
    if(productRouteId()!==id)setProductRoute(id,'replace',{shazBase:true,shazProductPushed:false,shazScrollY:activeProductDetailScrollY});
  }else if(productRouteId()!==id){
    ensureProductHistoryBase();
    const returnState={shazReturn:source==='cart'?'cart':null};
    history.replaceState({...history.state,...returnState,shazBase:true,shazScrollY:activeProductDetailScrollY,shazProduct:null,shazProductPushed:false},'',location.pathname+location.search+location.hash);
    setProductRoute(id,'push',{...returnState,shazBase:true,shazProductPushed:true,shazScrollY:activeProductDetailScrollY});
  }
  const features=productFeatureList(p);
  const positions=Array.isArray(p.writePositions)?p.writePositions.filter(Boolean):[];
  const infoBlocks=[];
  if(p.description) infoBlocks.push(`<div class="productInfoPart productTextSized" style="--product-text-wrap:${Math.max(18,Number(p.descriptionWrapCh||70))}ch"><h3>Açıklama</h3><p>${escapeHtml(p.description)}</p></div>`);
  if(features.length) infoBlocks.push(`<div class="productInfoPart productTextSized" style="--product-text-wrap:${Math.max(18,Number(p.featuresWrapCh||70))}ch"><h3>${p.isSet?'Setin içindekiler':'Özellikler'}</h3><div class=detailFeatureList>${features.map(x=>`<div>✓ ${escapeHtml(x)}</div>`).join('')}</div></div>`);
  if(p.isSet&&Array.isArray(p.setItems)&&p.setItems.length){
    const can=p.setItems.filter(x=>setItemWriteAvailable(x)||isWalletSetItem(x));
    const cannot=p.setItems.filter(x=>!(setItemWriteAvailable(x)||isWalletSetItem(x)));
    infoBlocks.push(`<div class="productInfoPart setPersonalizationInfo"><h3>Kişiselleştirme</h3><p class=personalizationIntro>Set içeriğindeki uygun ürünleri sipariş sırasında kişiselleştirebilirsiniz.</p>${can.length?`<div class=personalizationGroup><b>Kişiselleştirme yapılabilir</b>${can.map(x=>`<div class=personalizationLine><span class=miniYes>✓</span>${escapeHtml(x.name)}</div>`).join('')}</div>`:''}${cannot.length?`<div class=personalizationGroup><b>Kişiselleştirme yapılamaz</b>${cannot.map(x=>`<div class=personalizationLine><span class=miniNo>×</span>${escapeHtml(x.name)}</div>`).join('')}</div>`:''}</div>`);
  }
  if(p.writeEnabled!==false&&positions.length&&!p.isSet) infoBlocks.push(`<div class="productInfoPart"><h3>Kişiselleştirme alanları</h3><p>${positions.map(escapeHtml).join(' · ')}</p></div>`);
  const images=productImages(p);
  const closeLabel=(source==='favorites'||source==='accountFavorites')?'← Favorilere Dön':source==='cart'?'Sepete Dön':'Kapat';
  openDrawer(`<div class="productDetailShell">
    <div class="wizardHead productDetailHead"><div class="productDetailTitle"><h2>${escapeHtml(p.name||'SHAZ Ürün')}</h2>${String(p.subtitle||'').trim()?`<div class="productDetailSubtitle">${escapeHtml(String(p.subtitle).trim())}</div>`:''}</div><div class="productDetailHeadActions"><button id="productDetailFavBtn" class="productDetailFav ${favorites.has(p.id)?'active':''}" onclick="toggleFavFromDetail('${escapeAttr(p.id)}')" aria-label="${favorites.has(p.id)?'Favorilerden kaldır':'Favorilere ekle'}">${favorites.has(p.id)?'♥':'♡'}</button><button type="button" class="productDetailShare" onclick="shareProduct('${escapeAttr(p.id)}')" aria-label="Ürünü paylaş" title="Ürünü paylaş"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 11v8h14v-8"/></svg></button><button class="pill productDetailClose" onclick="closeProductDetail('${escapeAttr(source)}')">${closeLabel}</button></div></div>
    ${images.length?`<div class=productDetailGallery>
      <div class="productDetailMedia" data-image-index="0" style="--detail-bg:url(&quot;${escapeAttr(mainProductImage(p))}&quot;)" onclick="handleProductDetailMediaClick(event)" role="button" tabindex="0" aria-label="Fotoğrafı büyüt">${p.soldOutEnabled?soldOutVisualBadgeHtml(p,true):(p.badge?`<span class="badge detailProductBadge badge-${['orange','purple','red'].includes(p.badgeColor)?p.badgeColor:'orange'} ${p.badgeShape==='rect'?'badge-rect':''}"><span class="badgeText">${escapeHtml(p.badge)}</span></span>`:'')}${images.length>1?`<button type="button" class="productDetailGalleryArrow productDetailGalleryArrow--prev" onclick="event.stopPropagation();stepProductDetailImage(-1)" aria-label="Önceki fotoğraf">‹</button><button type="button" class="productDetailGalleryArrow productDetailGalleryArrow--next" onclick="event.stopPropagation();stepProductDetailImage(1)" aria-label="Sonraki fotoğraf">›</button>`:''}<img id=productDetailMain src="${escapeAttr(mainProductImage(p))}" alt="${escapeAttr(p.name||'Ürün')}"></div>
      ${images.length>1?`<div class=productDetailDots aria-label="Ürün fotoğrafları">${images.map((u,i)=>`<button type="button" class="${i===0?'active':''}" data-image-index="${i}" onclick="setProductDetailImage(${i})" aria-label="${i+1}. fotoğraf"></button>`).join('')}</div><div class=productDetailThumbs>${images.map((u,i)=>`<button class="${i===0?'active':''}" data-image-index="${i}" onclick="selectProductDetailImage(this,'${escapeAttr(u)}',${i})"><img src="${escapeAttr(u)}" alt=""></button>`).join('')}</div>`:''}
    </div>`:`<div class=productDetailMedia>${p.soldOutEnabled?soldOutVisualBadgeHtml(p,true):(p.badge?`<span class="badge detailProductBadge badge-${['orange','purple','red'].includes(p.badgeColor)?p.badgeColor:'orange'} ${p.badgeShape==='rect'?'badge-rect':''}"><span class="badgeText">${escapeHtml(p.badge)}</span></span>`:'')}<div class=productDetailPlaceholder>⌚</div></div>`}
    ${infoBlocks.length?`<div class="productDetailInfoBox">${infoBlocks.join('')}</div>`:''}
    <div class="productDetailBottomBar"><div class="productDetailBottomPrice">${money(p.price)}${p.oldPrice?` <span class=old>${money(p.oldPrice)}</span>`:''}</div>${soldOutButtonHtml(p)}</div>
  </div>`);
  bindProductDetailGallery();
}


let productImageViewerIndex=0;
function openProductImageViewer(){
  const images=activeProductDetailImages();if(!images.length)return;
  const media=document.querySelector('.productDetailMedia[data-image-index]');
  productImageViewerIndex=Math.max(0,Math.min(images.length-1,Number(media?.dataset.imageIndex||0)));
  const viewer=document.createElement('div');viewer.className='productImageViewer';
  viewer.innerHTML=`<div class="productImageViewerStage">${images.length>1?`<button type="button" class="productImageViewerArrow prev" onclick="event.stopPropagation();stepProductImageViewer(-1)" aria-label="Önceki fotoğraf">‹</button>`:''}<img id="productImageViewerMain" src="${escapeAttr(images[productImageViewerIndex])}" alt="Ürün fotoğrafı">${images.length>1?`<button type="button" class="productImageViewerArrow next" onclick="event.stopPropagation();stepProductImageViewer(1)" aria-label="Sonraki fotoğraf">›</button>`:''}</div>${images.length>1?`<div class="productImageViewerDots">${images.map((_,i)=>`<button type="button" class="${i===productImageViewerIndex?'active':''}" onclick="event.stopPropagation();setProductImageViewer(${i})" aria-label="${i+1}. fotoğraf"></button>`).join('')}</div>`:''}`;
  viewer.addEventListener('click',e=>{if(e.target===viewer||e.target.classList.contains('productImageViewerStage'))viewer.remove()});
  document.body.appendChild(viewer);
}
function setProductImageViewer(index){
  const images=activeProductDetailImages();if(!images.length)return;productImageViewerIndex=((Number(index)||0)%images.length+images.length)%images.length;
  const img=document.getElementById('productImageViewerMain');if(img)img.src=images[productImageViewerIndex];
  document.querySelectorAll('.productImageViewerDots button').forEach((b,i)=>b.classList.toggle('active',i===productImageViewerIndex));
  setProductDetailImage(productImageViewerIndex);
}
function stepProductImageViewer(delta){setProductImageViewer(productImageViewerIndex+Number(delta||0))}

function bindFloatingContacts(){
  const floating=document.querySelector('.floating');if(!floating)return;
  let raf=0;
  const update=()=>{
    raf=0;
    if(window.innerWidth>700){floating.style.transform='translate3d(0,0,0)';return;}
    const doc=document.documentElement;
    const scrollTop=window.scrollY||doc.scrollTop||0;
    const distanceToBottom=Math.max(0,doc.scrollHeight-(scrollTop+window.innerHeight));
    const travelZone=Math.max(240,Math.min(430,window.innerHeight*.46));
    const progress=Math.max(0,Math.min(1,1-distanceToBottom/travelZone));
    const width=floating.getBoundingClientRect().width||176;
    const right=10;
    const rightLeft=window.innerWidth-right-width;
    const centerLeft=(window.innerWidth-width)/2;
    floating.style.transform=`translate3d(${(centerLeft-rightLeft)*progress}px,0,0)`;
  };
  const schedule=()=>{if(!raf)raf=requestAnimationFrame(update)};
  if(window._shazFloatingUpdate)window.removeEventListener('scroll',window._shazFloatingUpdate);
  window._shazFloatingUpdate=schedule;
  window.addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',schedule,{passive:true});update();
}

let productDetailSwipeStartX=null,productDetailSwipeStartY=null,productDetailSwipeLastX=null,productDetailSwipeStartedAt=0,productDetailSwipeDragging=false,productDetailSwipeDirection=0,productDetailSuppressClickUntil=0;
function activeProductDetailImages(){
  const p=catalog.products.find(x=>x.id===activeProductDetailId);
  return p?productImages(p):[];
}
function updateProductDetailIndicators(normalized,url){
  const media=document.querySelector('.productDetailMedia[data-image-index]');
  if(media){media.dataset.imageIndex=String(normalized);media.style.setProperty('--detail-bg',`url("${String(url||'').replace(/"/g,'%22')}")`)}
  document.querySelectorAll('.productDetailThumbs button').forEach(x=>x.classList.toggle('active',Number(x.dataset.imageIndex)===normalized));
  document.querySelectorAll('.productDetailDots button').forEach(x=>x.classList.toggle('active',Number(x.dataset.imageIndex)===normalized));
}
function clearProductDetailDrag(){
  const media=document.querySelector('.productDetailMedia[data-image-index]'),img=document.getElementById('productDetailMain');
  media?.querySelectorAll('.productDetailDragNeighbor,.productDetailSlideGhost').forEach(x=>x.remove());
  if(img){img.style.transition='';img.style.transform='';img.style.opacity=''}
  productDetailSwipeDragging=false;productDetailSwipeDirection=0;productDetailSwipeStartX=null;productDetailSwipeStartY=null;productDetailSwipeLastX=null;productDetailSwipeStartedAt=0;
}
function setProductDetailImage(index,direction=0){
  const images=activeProductDetailImages();
  if(!images.length)return;
  clearProductDetailDrag();
  const normalized=((Number(index)||0)%images.length+images.length)%images.length;
  const url=images[normalized],img=document.getElementById('productDetailMain');
  if(img){
    const media=img.closest('.productDetailMedia');
    const oldSrc=img.getAttribute('src')||'';
    if(direction&&media&&oldSrc&&oldSrc!==url){
      const ghost=document.createElement('img');ghost.className='productDetailSlideGhost';ghost.src=oldSrc;ghost.alt='';media.appendChild(ghost);
      img.style.transition='none';img.style.transform=`translate3d(${direction>0?'100%':'-100%'},0,0)`;img.src=url;
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        img.style.transition='transform .30s cubic-bezier(.22,.61,.36,1)';ghost.style.transition='transform .30s cubic-bezier(.22,.61,.36,1)';img.style.transform='translate3d(0,0,0)';ghost.style.transform=`translate3d(${direction>0?'-100%':'100%'},0,0)`;
        setTimeout(()=>{ghost.remove();img.style.transition='';img.style.transform=''},330);
      }));
    }else{img.src=url}
    updateProductDetailIndicators(normalized,url);
  }
}
function selectProductDetailImage(btn,url,index){
  const images=activeProductDetailImages();let target=Number(index);if(!Number.isFinite(target))target=images.indexOf(url);if(target<0)target=0;setProductDetailImage(target);
}
function stepProductDetailImage(delta){
  const media=document.querySelector('.productDetailMedia[data-image-index]');if(!media)return;setProductDetailImage(Number(media.dataset.imageIndex||0)+Number(delta||0),Number(delta||0));
}
function handleProductDetailMediaClick(event){
  if(Date.now()<productDetailSuppressClickUntil)return;if(event?.target?.closest?.('.productDetailGalleryArrow'))return;openProductImageViewer();
}
function prepareProductDetailDrag(direction){
  const media=document.querySelector('.productDetailMedia[data-image-index]'),images=activeProductDetailImages();if(!media||images.length<2)return null;
  const current=Number(media.dataset.imageIndex||0),target=((current+direction)%images.length+images.length)%images.length;
  media.querySelectorAll('.productDetailDragNeighbor').forEach(x=>x.remove());
  const neighbor=document.createElement('img');neighbor.className='productDetailDragNeighbor';neighbor.src=images[target];neighbor.alt='';neighbor.dataset.targetIndex=String(target);media.appendChild(neighbor);
  const width=Math.max(1,media.clientWidth);neighbor.style.transform=`translate3d(${direction*width}px,0,0)`;productDetailSwipeDirection=direction;productDetailSwipeDragging=true;return neighbor;
}
function finishProductDetailDrag(commit){
  const media=document.querySelector('.productDetailMedia[data-image-index]'),img=document.getElementById('productDetailMain'),neighbor=media?.querySelector('.productDetailDragNeighbor');
  if(!media||!img||!neighbor){clearProductDetailDrag();return}
  const width=Math.max(1,media.clientWidth),direction=productDetailSwipeDirection,target=Number(neighbor.dataset.targetIndex||0);
  img.style.transition='transform .26s cubic-bezier(.22,.61,.36,1)';neighbor.style.transition='transform .26s cubic-bezier(.22,.61,.36,1)';
  if(commit){img.style.transform=`translate3d(${-direction*width}px,0,0)`;neighbor.style.transform='translate3d(0,0,0)';productDetailSuppressClickUntil=Date.now()+450;setTimeout(()=>{const images=activeProductDetailImages(),url=images[target];img.src=url;updateProductDetailIndicators(target,url);clearProductDetailDrag()},275)}
  else{img.style.transform='translate3d(0,0,0)';neighbor.style.transform=`translate3d(${direction*width}px,0,0)`;setTimeout(clearProductDetailDrag,275)}
}
function bindProductDetailGallery(){
  const media=document.querySelector('.productDetailGallery .productDetailMedia'),images=activeProductDetailImages();if(!media||media.dataset.swipeBound==='1'||images.length<2)return;
  media.dataset.swipeBound='1';images.forEach(src=>{const pre=new Image();pre.src=src});
  media.addEventListener('touchstart',e=>{if(e.touches?.length!==1)return;clearProductDetailDrag();productDetailSwipeStartX=e.touches[0].clientX;productDetailSwipeStartY=e.touches[0].clientY;productDetailSwipeLastX=productDetailSwipeStartX;productDetailSwipeStartedAt=performance.now()},{passive:true});
  media.addEventListener('touchmove',e=>{if(productDetailSwipeStartX===null||productDetailSwipeStartY===null||e.touches?.length!==1)return;const t=e.touches[0],dx=t.clientX-productDetailSwipeStartX,dy=t.clientY-productDetailSwipeStartY;if(!productDetailSwipeDragging&&Math.abs(dx)<7)return;if(Math.abs(dy)>Math.abs(dx)*1.15&&!productDetailSwipeDragging)return;e.preventDefault();const direction=dx<0?1:-1;let neighbor=media.querySelector('.productDetailDragNeighbor');if(!neighbor||productDetailSwipeDirection!==direction)neighbor=prepareProductDetailDrag(direction);if(!neighbor)return;const width=Math.max(1,media.clientWidth),limited=Math.max(-width,Math.min(width,dx)),img=document.getElementById('productDetailMain');if(img){img.style.transition='none';img.style.transform=`translate3d(${limited}px,0,0)`}neighbor.style.transition='none';neighbor.style.transform=`translate3d(${direction*width+limited}px,0,0)`;productDetailSwipeLastX=t.clientX},{passive:false});
  media.addEventListener('touchend',e=>{if(productDetailSwipeStartX===null)return;const t=e.changedTouches?.[0],endX=t?.clientX??productDetailSwipeLastX??productDetailSwipeStartX,dx=endX-productDetailSwipeStartX,width=Math.max(1,media.clientWidth),elapsed=Math.max(1,performance.now()-productDetailSwipeStartedAt),velocity=Math.abs(dx)/elapsed;const commit=productDetailSwipeDragging&&(Math.abs(dx)>width*.18||velocity>.45);if(productDetailSwipeDragging)finishProductDetailDrag(commit);else clearProductDetailDrag()},{passive:true});
  media.addEventListener('touchcancel',()=>{if(productDetailSwipeDragging)finishProductDetailDrag(false);else clearProductDetailDrag()},{passive:true});
}

function startProduct(id){
  const p=catalog.products.find(x=>x.id===id); if(!p)return;
  if(p.soldOutEnabled)return toast('Bu ürün şu anda tükendi.');
  if(p.isSet&&Array.isArray(p.setItems)&&p.setItems.length) return startSetWizard(p);
  startSingleWizard(p);
}

function normalizedTR(v){return String(v||'').toLocaleLowerCase('tr-TR');}
function productCategoryName(p){return (catalog.categories.find(c=>c.id===p?.category)||{}).name||p?.category||'';}
function isWalletProduct(p){return normalizedTR(productCategoryName(p)+' '+(p?.name||'')).includes('cüzdan');}
function walletPhotoAvailable(p){return isWalletProduct(p)&&p?.walletPhotoEnabled!==false;}
function writeAvailable(p){return p?.writeEnabled!==false;}
function isWalletSetItem(item){
  const linked=item?.productId?catalog.products.find(p=>p.id===item.productId):null;
  const looksWallet=normalizedTR((item?.type||'')+' '+(item?.name||'')+' '+productCategoryName(linked)+' '+(linked?.name||'')).includes('cüzdan');
  return looksWallet && item?.walletPhotoEnabled!==false && linked?.walletPhotoEnabled!==false;
}
function setItemWriteAvailable(item){const linked=item?.productId?catalog.products.find(p=>p.id===item.productId):null;return item?.writeEnabled!==false&&linked?.writeEnabled!==false;}
function preferredForSetItem(item){const linked=item?.productId?catalog.products.find(p=>p.id===item.productId):null;return item?.preferredWritePosition||linked?.preferredWritePosition||'';}
function positionOptionHtml(name,pos,index,preferred){
  const pref=String(preferred||'')===String(pos);
  return `<label class=positionChoice><input type=radio name="${name}" value="${escapeAttr(pos)}" ${index===0?'checked':''}> <span>${escapeHtml(pos)}</span>${pref?'<small class=recommendedHint>Genelde tercih edilen</small>':''}</label>`;
}
function walletPhotoFee(){return Number(catalog.walletPhotoFee??25);}
async function uploadCustomerPhoto(file){
  if(!file)throw new Error('Lütfen işlenecek fotoğrafı seçin.');
  const fd=new FormData();fd.append('files',file);
  const response=await fetch('/api/customer-upload',{method:'POST',body:fd});
  let r={};try{r=await response.json()}catch{}
  if(!response.ok||!r.ok||!r.files?.[0]?.url)throw new Error(r.message||'Fotoğraf yüklenemedi.');
  return r.files[0];
}

/* SINGLE PRODUCT FLOW */
function startSingleWizard(p){
  const wallet=walletPhotoAvailable(p), canWrite=writeAvailable(p);
  if(!wallet&&!canWrite)return addSingleNoText(p.id);
  openDrawer(`<div class=wizardHead><button class="pill backPill" onclick=closeDrawer()>← Geri</button><div><div class=wizardProgress>1 / 2</div><h2>${p.name}</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
  ${p.description?`<div class="productDetailIntro"><b>Ürün açıklaması</b><p>${escapeHtml(p.description)}</p></div>`:''}<div class=wizardCard><h3>Ürününüzü kişiselleştirmek ister misiniz?</h3>
  <div class=choiceStack><button class="choiceBtn" onclick='addSingleNoText(${JSON.stringify(p.id)})'>Hayır, birebir bu şekilde istiyorum</button>${canWrite?`<button class="choiceBtn primary" onclick='singleWriteStep(${JSON.stringify(p.id)})'>Evet, yazı yazdırmak istiyorum</button>`:''}${wallet?`<button class="choiceBtn walletPhotoChoice" onclick='singleWalletPhotoStep(${JSON.stringify(p.id)})'>📷 Cüzdana fotoğraf işleme istiyorum</button>`:''}</div>${wallet?`<p class=muted>Fotoğrafı tek başına seçebilirsiniz. İsterseniz fotoğrafın üstüne/altına ayrı yazı ekleyebilir, ayrıca cüzdanın kendi ön/iç yüzüne normal yazı da isteyebilirsiniz.</p>`:''}</div>`);
}
function addSingleNoText(id){const p=catalog.products.find(x=>x.id===id);cart.push(withPendingProductNote({product:p,qty:1,personalized:false},p));updateCart();closeDrawer();toast('✓ Ürün sepete eklendi')}
function singleWriteStep(id){
  const p=catalog.products.find(x=>x.id===id);
  const positions=defaultPositionsForProduct(p);
  const nextFee=nextSingleWriteFee();
  const used=cartPersonalizationSlotCount();
  openDrawer(`<div class=wizardHead><button class="pill backPill" onclick='startSingleWizard(catalog.products.find(x=>x.id===${JSON.stringify(p.id)}))'>← Geri</button><div><div class=wizardProgress>2 / 2</div><h2>${p.name}</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
  <div class=priceInfo><b>Yazı ücretlendirmesi</b><br>${used?`Sepetinizde ${used} kişiselleştirilmiş ürün var. Bu ürünün yazı ücreti şu an +${money(nextFee)} olarak hesaplanır.`:`Bu sepetteki ilk kişiselleştirme için +${money(nextFee)} uygulanır.`}</div>
  <div class=writeItem><h3>${p.name}</h3><div class=positionChoices>${positions.map((x,i)=>positionOptionHtml('singlePos',x,i,p.preferredWritePosition)).join('')}</div><input class=writeInput id=singleText placeholder="Yazdırmak istediğiniz yazıyı girin"></div>
  <div class="wizardBottomAction"><button class=btn onclick='finishSingleWrite(${JSON.stringify(p.id)})'>Sepete Ekle</button></div>`);
}
function finishSingleWrite(id){
  const p=catalog.products.find(x=>x.id===id), text=$('#singleText').value.trim(), pos=document.querySelector('input[name=singlePos]:checked')?.value;
  if(!text)return alert('Lütfen yazdırmak istediğiniz yazıyı girin.');
  const fee=nextSingleWriteFee();
  cart.push(withPendingProductNote({product:{...p,price:p.price+fee},basePrice:p.price,qty:1,personalized:true,writes:[{item:p.name,position:pos,text,fee}]},p));
  updateCart();closeDrawer();toast('✓ Ürün sepete eklendi');
}
function singleWalletPhotoStep(id){
  const p=catalog.products.find(x=>x.id===id);if(!p)return;
  const positions=defaultPositionsForProduct(p),pricing=nextWalletPricingPreview();
  const sıra=pricing.slotCount+1;
  openDrawer(`<div class=wizardHead><button class="pill backPill" onclick='startSingleWizard(catalog.products.find(x=>x.id===${JSON.stringify(p.id)}))'>← Geri</button><div><div class=wizardProgress>Cüzdan kişiselleştirme</div><h2>${p.name}</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
    <div class=priceInfo><b>Bu ürünün kişiselleştirme ücreti</b><br>Sepet sırasına göre ${sıra}. kişiselleştirilmiş ürün: <b>+${money(pricing.slotFee)}</b>. Fotoğraf işleme ayrıca <b>+${money(pricing.photoExtraFee)}</b>. Yani fotoğraf seçerseniz bu ürün için toplam kişiselleştirme <b>+${money(pricing.totalPhotoOnly)}</b> olur.${pricing.slotCount?` Sepet değişirse bu tutar otomatik yeniden hesaplanır.`:''}</div>
    <div class="wizardCard walletPhotoCard"><h3>İşlenecek fotoğrafı yükleyin</h3><p><b>En sağlıklı sonuç için</b> fotoğrafın çok karanlık, aşırı parlak veya patlamış olmamasına dikkat edin. Net ve kontrastı dengeli fotoğraflar daha iyi sonuç verir. <b>Genelde göz fotoğrafları özellikle iyi sonuç verir.</b></p><input id=walletPhotoFile class=formControl type=file accept="image/*">
      <label class=walletToggle><input id=walletCaptionToggle type=checkbox onchange="document.querySelector('#walletCaptionFields').classList.toggle('hidden',!this.checked)"> Fotoğrafın üstüne veya altına yazı da eklemek istiyorum</label>
      <div id=walletCaptionFields class="walletCaptionFields hidden"><input id=walletCaptionText class=writeInput placeholder="Fotoğrafla birlikte işlenecek yazı"><select id=walletCaptionPosition class=formControl><option value=below>Fotoğrafın altında</option><option value=above>Fotoğrafın üstünde</option></select></div>
    </div>
    ${writeAvailable(p)?`<div class=wizardCard><label class=walletToggle><input id=walletRegularWriteToggle type=checkbox onchange="document.querySelector('#walletRegularWriteFields').classList.toggle('hidden',!this.checked)"> Fotoğraftan ayrı olarak cüzdanın ön/iç yüzüne normal yazı da istiyorum</label>
      <div id=walletRegularWriteFields class="hidden"><div class=priceInfo>Normal yazı aynı ürünün kişiselleştirme hakkı içindedir; ayrıca yeni bir 75/50/50 TL sırası açmaz. Fotoğraf ek ücreti +${money(pricing.photoExtraFee)} olarak kalır.</div><div class=positionChoices>${positions.map((x,i)=>positionOptionHtml('walletRegularPos',x,i,p.preferredWritePosition)).join('')}</div><input id=walletRegularText class=writeInput placeholder="Cüzdanın ön/iç yüzüne yazılacak metin"></div>
    </div>`:''}
    <button class=btn id=walletPhotoSubmit onclick='finishSingleWalletPhoto(${JSON.stringify(p.id)},this)'>Fotoğrafı Yükle ve Sepete Ekle</button>`);
}
async function finishSingleWalletPhoto(id,button){
  const p=catalog.products.find(x=>x.id===id), file=$('#walletPhotoFile')?.files?.[0];
  if(!file)return alert('Lütfen cüzdana işlenecek fotoğrafı seçin.');
  const captionOn=$('#walletCaptionToggle')?.checked, caption=captionOn?($('#walletCaptionText')?.value.trim()||''):'';
  if(captionOn&&!caption)return alert('Fotoğrafla birlikte istediğiniz yazıyı girin.');
  const regularOn=writeAvailable(p)&&!!$('#walletRegularWriteToggle')?.checked, regularText=regularOn?($('#walletRegularText')?.value.trim()||''):'';
  if(regularOn&&!regularText)return alert('Cüzdana yazdırmak istediğiniz normal yazıyı girin.');
  const old=button?.textContent||'';if(button){button.disabled=true;button.textContent='Fotoğraf yükleniyor…'}
  try{
    const up=await uploadCustomerPhoto(file), tier=nextSingleWriteFee(), photoExtra=walletPhotoFee();
    const writes=regularOn?[{item:p.name,position:document.querySelector('input[name=walletRegularPos]:checked')?.value,text:regularText,fee:tier}]:[];
    const photo={item:p.name,imageUrl:up.url,originalName:up.name||file.name,caption,captionPosition:$('#walletCaptionPosition')?.value||'below',slotFee:regularOn?0:tier,photoExtraFee:photoExtra,fee:(regularOn?0:tier)+photoExtra};
    cart.push(withPendingProductNote({product:{...p,price:Number(p.price||0)+tier+photoExtra},basePrice:p.price,qty:1,personalized:true,writes,photoCustomizations:[photo]},p));
    updateCart();closeDrawer();toast('✓ Fotoğraflı cüzdan sepete eklendi');
  }catch(e){alert(e.message||'Fotoğraf yüklenemedi.');if(button){button.disabled=false;button.textContent=old}}
}


/* SET WIZARD */
let wiz=null;
function startSetWizard(p){
  wiz={product:p, keptIds:p.setItems.map(x=>x.id), writes:[], photoCustomizations:[], personalizationPlan:[], personalizationPlanDraft:[], writeDrafts:{}, photoDrafts:{}, photoFileDrafts:{}, orderNote:'', step:1, history:[], currentScreen:'removeQuestion'};
  renderRemoveQuestion();
}
function head(title,canBack=true){return `<div class=wizardHead>${canBack?'<button class="pill backPill" onclick=setWizardBack()>← Geri</button>':''}<div><div class=wizardProgress>Adım ${wiz?.step||1}</div><h2>${title}</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>`}
function setWizardSnapshot(screen){
  if(!wiz)return;
  wiz.history=wiz.history||[];
  wiz.history.push({screen,step:wiz.step,keptIds:[...(wiz.keptIds||[])],writes:JSON.parse(JSON.stringify(wiz.writes||[])),photoCustomizations:JSON.parse(JSON.stringify(wiz.photoCustomizations||[])),personalizationPlan:JSON.parse(JSON.stringify(wiz.personalizationPlan||[])),orderNote:String(wiz.orderNote||'')});
  if(wiz.history.length>20)wiz.history.shift();
}
function setWizardNext(screen){setWizardSnapshot(screen);wiz.step=(wiz.step||1)+1}
function setWizardBack(){
  captureSetWizardDrafts();
  if(!wiz?.history?.length){closeDrawer();return;}
  const prev=wiz.history.pop();
  wiz.step=prev.step;wiz.keptIds=prev.keptIds;wiz.writes=prev.writes;wiz.photoCustomizations=prev.photoCustomizations||[];wiz.personalizationPlan=prev.personalizationPlan||[];wiz.orderNote=String(prev.orderNote||'');
  if(prev.screen==='removeQuestion')renderRemoveQuestion(true);
  else if(prev.screen==='removalSelection')renderRemovalSelection(true);
  else if(prev.screen==='writeQuestion')renderWriteQuestion(true);
  else if(prev.screen==='writeSelection')renderWriteSelection(true);
  else if(prev.screen==='writeDetails')renderWriteDetails(true);
  else if(prev.screen==='walletPhotoQuestion')renderWalletPhotoQuestion(true);
  else if(prev.screen==='walletPhotoDetails')renderWalletPhotoDetails(true);
  else if(prev.screen==='orderNoteQuestion')renderSetOrderNoteQuestion(true);
  else if(prev.screen==='orderNoteDetails')renderSetOrderNoteDetails(true);
  else if(prev.screen==='summary')renderSetSummary(true);
}
function captureSetPersonalizationPlanDraft(){
  if(!wiz||!document.querySelector('[data-personalize-row]'))return;
  wiz.personalizationPlanDraft=collectSetPersonalizationPlan();
}
function captureSetWriteDrafts(){
  if(!wiz)return;
  wiz.writeDrafts=wiz.writeDrafts||{};
  document.querySelectorAll('[data-write-id]').forEach(card=>{
    const id=card.dataset.writeId;if(!id)return;
    const input=document.getElementById('text-'+id);
    const selected=document.querySelector(`input[name="pos-${CSS.escape(id)}"]:checked`);
    const current=wiz.writeDrafts[id]||{};
    wiz.writeDrafts[id]={...current,text:input?input.value:(current.text||''),position:selected?.value||current.position||''};
  });
}
function captureSetPhotoDrafts(){
  if(!wiz)return;
  wiz.photoDrafts=wiz.photoDrafts||{};wiz.photoFileDrafts=wiz.photoFileDrafts||{};
  document.querySelectorAll('.walletPhotoCard[data-photo-plan]').forEach(card=>{
    const itemId=card.dataset.photoPlan,idx=Number(card.dataset.photoIndex);if(!itemId||!Number.isFinite(idx))return;
    const fileInput=document.getElementById(`setWalletPhotoFile-${idx}`),file=fileInput?.files?.[0];
    if(file)wiz.photoFileDrafts[itemId]=file;
    const current=wiz.photoDrafts[itemId]||{};
    const captionOn=!!document.getElementById(`setWalletCaptionToggle-${idx}`)?.checked;
    const regularToggle=document.getElementById(`setWalletRegularToggle-${idx}`);
    const regularOn=regularToggle?!!regularToggle.checked:false;
    const selected=document.querySelector(`input[name="set-wallet-pos-${idx}"]:checked`);
    wiz.photoDrafts[itemId]={
      ...current,
      captionOn,
      caption:document.getElementById(`setWalletCaptionText-${idx}`)?.value||'',
      captionPosition:document.getElementById(`setWalletCaptionPosition-${idx}`)?.value||'below',
      regularOn,
      regularText:document.getElementById(`setWalletRegularText-${idx}`)?.value||'',
      regularPosition:selected?.value||current.regularPosition||''
    };
  });
}
function captureSetOrderNoteDraft(){
  if(!wiz)return;
  const input=document.getElementById('setOrderNoteText');
  if(input)wiz.orderNote=input.value;
}
function captureSetWizardDrafts(){captureSetPersonalizationPlanDraft();captureSetWriteDrafts();captureSetPhotoDrafts();captureSetOrderNoteDraft()}
function restoreSetPhotoFileInputs(){
  if(!wiz?.photoFileDrafts)return;
  document.querySelectorAll('input[type="file"][data-photo-item-id]').forEach(input=>{
    const file=wiz.photoFileDrafts[input.dataset.photoItemId];if(!file||typeof DataTransfer==='undefined')return;
    try{const dt=new DataTransfer();dt.items.add(file);input.files=dt.files}catch{}
  });
}

function renderRemoveQuestion(restoring=false){
  wiz.currentScreen='removeQuestion';
  openDrawer(head(wiz.product.name)+`<div class=wizardCard><h3>Setinizin içerisinden çıkarmak istediğiniz bir ürün var mı?</h3>
  <div class=choiceStack><button class="choiceBtn" onclick=keepAllSetItems()>Hayır, çıkarmak istemiyorum. Seti birebir almak istiyorum.</button><button class="choiceBtn primary" onclick=renderRemovalSelection()>Evet, bir veya daha fazla ürün çıkarmak istiyorum.</button></div></div>`);
}
function keepAllSetItems(){wiz.keptIds=wiz.product.setItems.map(x=>x.id);renderWriteQuestion()}
function renderRemovalSelection(restoring=false){
  if(!restoring)setWizardNext('removeQuestion');
  wiz.currentScreen='removalSelection';
  openDrawer(head('Set içeriğini düzenle')+`<div class=wizardCard><h3>Size gönderilmesini istediğiniz ürünler işaretli kalsın.</h3><p>Çıkarmak istediğiniz ürünün tikini kaldırın. Çıkardığınız ürünün tanımlı tutarı toplamdan düşer.</p>
  <div class=setItemList>${wiz.product.setItems.map(x=>`<label class=setItemToggle data-set-preview-stage="remove" data-set-preview-item="${escapeAttr(x.id)}"><span><b>${x.name}</b><div class=muted>Çıkarılırsa -${money(x.removeDiscount)}</div></span><input type=checkbox class=keepItem data-id="${x.id}" ${wiz.keptIds.includes(x.id)?'checked':''} onchange=handleRemovalToggle(this)></label>`).join('')}</div>
  <div id=removeSummary></div></div><div class=setRemovalActions><div class=setRemovalFooterTotal><span>Set tutarı</span><b id=removeFooterTotal>${money(wiz.product.price)}</b></div><button class=btn onclick=confirmRemoval()>Devam Et</button></div>`);
  refreshRemovalSummary();
}
let removalFriendlyMessage='';
function handleRemovalToggle(el){
  const checked=[...document.querySelectorAll('.keepItem:checked')];
  if(checked.length<2){
    el.checked=true;
    removalFriendlyMessage='Hazır sette en az 2 ürün kalmalıdır. Tek ürün almak isterseniz ilgili kategoriden ürünü doğrudan seçebilirsiniz.';
    showSoftNotice('Setinizi koruyalım','Hazır sette en az 2 ürün kalmalıdır. Tek ürün almak isterseniz ilgili kategoriden doğrudan seçim yapabilirsiniz.','Kategoriyi Gör →','goToRemainingSetItemCategory();closeSoftNotice()');
  }else removalFriendlyMessage='';
  refreshRemovalSummary();
}
function goToRemainingSetItemCategory(){
  const kept=[...document.querySelectorAll('.keepItem:checked')].map(x=>x.dataset.id);
  const item=wiz?.product?.setItems?.find(x=>kept.includes(x.id));
  const linked=item?.productId?(catalog.products||[]).find(p=>p.id===item.productId):null;
  closeDrawer();
  openCategoryHub();
  if(linked){
    const cat=(catalog.categories||[]).find(c=>c.id===linked.category&&!c.hidden);
    if(cat&&visibleSubcategories(cat).length){categoryHubParentId=cat.id;renderCategoryHub();}
  }
}
function refreshRemovalSummary(){
  const kept=[...document.querySelectorAll('.keepItem:checked')].map(x=>x.dataset.id);
  const removed=wiz.product.setItems.filter(x=>!kept.includes(x.id)), remain=wiz.product.setItems.filter(x=>kept.includes(x.id));
  const removedTotal=removed.reduce((sum,x)=>sum+Number(x.removeDiscount||0),0);
  const currentTotal=Math.max(0,Number(wiz.product.price||0)-removedTotal);
  const footerTotal=$('#removeFooterTotal');if(footerTotal)footerTotal.textContent=money(currentTotal);
  $('#removeSummary').innerHTML=`<div class=removalSplitSummary><div class=remainingList><b>Size gelecek ürünler:</b><br>${remain.length?remain.map(x=>'✓ '+x.name).join('<br>'):'Hiç ürün kalmadı.'}</div><div class=removedList><b>Çıkardığınız ürünler:</b><br>${removed.length?removed.map(x=>'✕ '+x.name+' (-'+money(x.removeDiscount)+')').join('<br>'):'—'}</div></div>${removalFriendlyMessage?`<div class=removalFriendlyNote><b>Setinizi koruyalım</b><span>${escapeHtml(removalFriendlyMessage)}</span><button type=button class=smallInlineBtn onclick=goToRemainingSetItemCategory()>Kategoriyi Gör →</button></div>`:''}`;
}
function confirmRemoval(){
  wiz.keptIds=[...document.querySelectorAll('.keepItem:checked')].map(x=>x.dataset.id);
  if(wiz.keptIds.length<2){removalFriendlyMessage='Hazır sette en az 2 ürün kalmalıdır. Tek ürün almak isterseniz ilgili kategoriden ürünü doğrudan seçebilirsiniz.';refreshRemovalSummary();return;}
  renderWriteQuestion();
}
function renderWriteQuestion(restoring=false){
  if(!restoring)setWizardNext(wiz.currentScreen||'removeQuestion');
  wiz.currentScreen='writeQuestion';
  const available=wiz.product.setItems.filter(x=>wiz.keptIds.includes(x.id)&&(setItemWriteAvailable(x)||isWalletSetItem(x)));
  if(!available.length){wiz.writes=[];wiz.photoCustomizations=[];wiz.personalizationPlan=[];return renderSetSummary();}
  openDrawer(head(wiz.product.name)+`<div class=wizardCard><h3>${available.length>1?'Ürünlerinizi':'Ürününüzü'} kişiselleştirmek ister misiniz?</h3>
  <div class=priceInfo><b>Kişiselleştirme ücret sırası:</b><br>İlk ürün +${money(catalog.personalizationPricing?.first||75)}<br>Sonraki her ürün için +${money(catalog.personalizationPricing?.second||50)}</div>
  <div class=choiceStack><button class=choiceBtn onclick=finishSetWithoutWrite()>Hayır, kişiselleştirme istemiyorum</button><button class="choiceBtn primary" onclick=renderWriteSelection()>Evet, kişiselleştirmek istiyorum</button></div></div>`);
}
function finishSetWithoutWrite(){wiz.writes=[];wiz.photoCustomizations=[];wiz.personalizationPlan=[];wiz.personalizationPlanDraft=[];wiz.writeDrafts={};wiz.photoDrafts={};wiz.photoFileDrafts={};renderSetSummary()}
function renderWriteSelection(restoring=false){
  if(!restoring)setWizardNext('writeQuestion');
  wiz.currentScreen='writeSelection';
  const kept=wiz.product.setItems.filter(x=>wiz.keptIds.includes(x.id)&&(setItemWriteAvailable(x)||isWalletSetItem(x)));
  const remembered=Object.fromEntries(((wiz.personalizationPlanDraft?.length?wiz.personalizationPlanDraft:wiz.personalizationPlan)||[]).map(x=>[x.itemId,x.mode]));
  openDrawer(head('Kişiselleştirilecek ürünleri seçin')+`<div class=wizardCard><div class=priceInfo><b>Ücret sırası otomatik hesaplanır:</b><br>İlk ürün +${money(catalog.personalizationPricing?.first||75)} · Sonraki her ürün için +${money(catalog.personalizationPricing?.second||50)}.</div>
  <div class=writeSelectGrid>${kept.map(x=>{
    const wallet=isWalletSetItem(x),canWrite=setItemWriteAvailable(x),mode=remembered[x.id]||'none';
    if(wallet){
      return `<div class=setItemToggle data-personalize-row="${escapeAttr(x.id)}"><span><b>${escapeHtml(x.name)}</b><div class=muted>Bu cüzdan için istediğiniz işlemi seçin.</div></span><div class=choiceStack>
        <label class=positionChoice><input type=radio name="set-mode-${escapeAttr(x.id)}" value=none ${mode==='none'?'checked':''}> <span>Hayır, birebir bu şekilde istiyorum</span></label>
        ${canWrite?`<label class=positionChoice><input type=radio name="set-mode-${escapeAttr(x.id)}" value=write ${mode==='write'?'checked':''}> <span>Evet, yazı yazdırmak istiyorum</span></label>`:''}
        <label class=positionChoice><input type=radio name="set-mode-${escapeAttr(x.id)}" value=photo ${mode==='photo'?'checked':''}> <span>📷 Cüzdana fotoğraf işleme istiyorum</span></label>
      </div></div>`;
    }
    return `<div class=setItemToggle data-personalize-row="${escapeAttr(x.id)}"><span><b>${escapeHtml(x.name)}</b><div class=muted>Bu ürüne yazı eklemek istiyorsanız seçin.</div></span><label class=positionChoice><input type=checkbox class=writePick data-id="${escapeAttr(x.id)}" ${mode==='write'?'checked':''}> <span>Yazı yazdırmak istiyorum</span></label></div>`;
  }).join('')}</div><div id=writeFeePreview></div></div>
  <div class="wizardBottomAction"><button class=btn onclick=renderWriteDetails()>Seçtiklerimle Devam Et</button></div>`);
  document.querySelectorAll('[data-personalize-row] input').forEach(el=>el.addEventListener('change',refreshWriteFeePreview));
  refreshWriteFeePreview();
}
function feeForIndex(i){return i===0?75:50}
function collectSetPersonalizationPlan(){
  const writes=[],photos=[];
  wiz.product.setItems.filter(x=>wiz.keptIds.includes(x.id)).forEach(x=>{
    let mode='none';
    if(isWalletSetItem(x))mode=document.querySelector(`input[name="set-mode-${CSS.escape(x.id)}"]:checked`)?.value||'none';
    else if(document.querySelector(`.writePick[data-id="${CSS.escape(x.id)}"]`)?.checked)mode='write';
    if(mode==='write')writes.push({itemId:x.id,item:x.name,mode});
    else if(mode==='photo')photos.push({itemId:x.id,item:x.name,mode});
  });
  return [...writes,...photos].map((x,i)=>({...x,slotFee:feeForIndex(i)}));
}
function refreshWriteFeePreview(){
  const plan=collectSetPersonalizationPlan();
  $('#writeFeePreview').innerHTML=plan.length?`<div class=remainingList><b>Kişiselleştirme seçimi:</b><br>${plan.map((x,i)=>`${i+1}. ${escapeHtml(x.item)} — ${x.mode==='photo'?'Fotoğraf':'Yazı'} +${money(x.slotFee)}${x.mode==='photo'?` + ${money(walletPhotoFee())} fotoğraf işlemesi`:''}`).join('<br>')}</div>`:'';
}
function renderWriteDetails(restoring=false){
  if(!restoring){
    wiz.personalizationPlan=collectSetPersonalizationPlan();
    wiz.personalizationPlanDraft=JSON.parse(JSON.stringify(wiz.personalizationPlan||[]));
    const activePhotoIds=new Set((wiz.personalizationPlan||[]).filter(x=>x.mode==='photo').map(x=>x.itemId));
    wiz.photoCustomizations=(wiz.photoCustomizations||[]).filter(x=>activePhotoIds.has(x.itemId));
  }
  const plan=wiz.personalizationPlan||[];
  if(!plan.length){wiz.writes=[];return renderSetSummary();}
  const writePlan=plan.filter(x=>x.mode==='write');
  if(!restoring)setWizardNext('writeSelection');
  if(!writePlan.length){wiz.writes=[];return renderWalletPhotoDetails(true);}
  wiz.currentScreen='writeDetails';
  openDrawer(head('Yazı detayları')+`<div class=wizardCard><h3>Yazı seçtiğiniz ürünlerin konumunu ve metnini girin.</h3>
  ${writePlan.map(x=>{
    const item=wiz.product.setItems.find(it=>it.id===x.itemId),confirmed=(wiz.writes||[]).find(w=>w.itemId===x.itemId)||{},saved={...confirmed,...((wiz.writeDrafts||{})[x.itemId]||{})};
    return `<div class=writeItem data-write-id="${escapeAttr(x.itemId)}" data-fee="${Number(x.slotFee||0)}" data-set-preview-stage="write" data-set-preview-item="${escapeAttr(x.itemId)}"><div class=writeItemTop><b>${escapeHtml(item.name)}</b><span>+${money(x.slotFee)}</span></div><div class=writeDetails><div class=muted>${escapeHtml(item.name)} yazısı nereye işlensin?</div><div class=positionChoices>${(item.writePositions||[]).map((pos,j)=>positionOptionHtml('pos-'+item.id,pos,j,saved.position||preferredForSetItem(item))).join('')||'<span class=muted>Bu ürün için henüz yazı konumu tanımlı değil.</span>'}</div><input class=writeInput id="text-${escapeAttr(item.id)}" value="${escapeAttr(saved.text||'')}" placeholder="${escapeAttr(item.name)} üzerine yazdırmak istediğiniz yazı"></div></div>`;
  }).join('')}</div>
  <div class="wizardBottomAction"><button class=btn onclick=confirmWriteDetails()>${plan.some(x=>x.mode==='photo')?'Fotoğraf Detayına Devam Et':'Devam Et'}</button></div>`);
  writePlan.forEach(x=>{
    const confirmed=(wiz.writes||[]).find(w=>w.itemId===x.itemId)||{},saved={...confirmed,...((wiz.writeDrafts||{})[x.itemId]||{})};
    if(saved.position)document.querySelectorAll(`input[name="pos-${CSS.escape(x.itemId)}"]`).forEach(r=>{r.checked=r.value===saved.position});
  });
  document.querySelectorAll('[data-write-id] input').forEach(el=>el.addEventListener(el.type==='text'?'input':'change',captureSetWriteDrafts));
}
function confirmWriteDetails(){
  captureSetWriteDrafts();
  const cards=[...document.querySelectorAll('[data-write-id]')],writes=[];
  for(const c of cards){
    const id=c.dataset.writeId,item=wiz.product.setItems.find(x=>x.id===id),text=$('#text-'+id).value.trim(),position=document.querySelector(`input[name="pos-${id}"]:checked`)?.value;
    if(!text)return alert(item.name+' için yazıyı girin.');
    writes.push({itemId:id,item:item.name,position,text,fee:Number(c.dataset.fee)});
  }
  wiz.writes=writes;
  if((wiz.personalizationPlan||[]).some(x=>x.mode==='photo'))renderWalletPhotoDetails(); else renderSetSummary();
}
function keptWalletItems(){return (wiz?.product?.setItems||[]).filter(x=>wiz.keptIds.includes(x.id)&&isWalletSetItem(x));}
function maybeWalletPhotoStep(){renderSetSummary()}
function renderWalletPhotoQuestion(restoring=false){renderWriteSelection(restoring)}
function renderWalletPhotoDetails(restoring=false){
  const photoPlan=(wiz.personalizationPlan||[]).filter(x=>x.mode==='photo');
  if(!photoPlan.length)return renderSetSummary();
  if(!restoring)setWizardNext('writeDetails');
  wiz.currentScreen='walletPhotoDetails';
  openDrawer(head('Cüzdana fotoğraf işleme')+`<div class=priceInfo><b>Fotoğraf kişiselleştirmesi</b><br>Seçtiğiniz cüzdan, kişiselleştirme sırasındaki 75/50/50 TL ücretini alır. <b>Fotoğraf işleme bunun üzerine ayrıca +${money(walletPhotoFee())}</b> eklenir. Örnek: bu cüzdan 3. kişiselleştirilmiş ürünse +${money(catalog.personalizationPricing?.thirdPlus||50)} kişiselleştirme + ${money(walletPhotoFee())} fotoğraf işleme uygulanır.</div>
  ${photoPlan.map((plan,idx)=>{
    const item=wiz.product.setItems.find(x=>x.id===plan.itemId),positions=item?.writePositions||[],existingPhoto=(wiz.photoCustomizations||[]).find(x=>x.itemId===plan.itemId)||{},existingWrite=(wiz.writes||[]).find(x=>x.itemId===plan.itemId)||{},draft=(wiz.photoDrafts||{})[plan.itemId]||{},fileDraft=(wiz.photoFileDrafts||{})[plan.itemId];
    const captionOn=('captionOn' in draft)?!!draft.captionOn:!!existingPhoto.caption,caption=('caption' in draft)?draft.caption:(existingPhoto.caption||''),captionPosition=draft.captionPosition||existingPhoto.captionPosition||'below';
    const regularOn=('regularOn' in draft)?!!draft.regularOn:!!existingWrite.text,regularText=('regularText' in draft)?draft.regularText:(existingWrite.text||''),regularPosition=draft.regularPosition||existingWrite.position||preferredForSetItem(item);
    const preservedFileName=fileDraft?.name||existingPhoto.originalName||'';
    return `<div class="wizardCard walletPhotoCard" data-photo-plan="${escapeAttr(plan.itemId)}" data-photo-index="${idx}"><h3>${escapeHtml(item?.name||plan.item)} için fotoğraf yükleyin</h3><p><b>En sağlıklı sonuç için</b> fotoğrafın çok karanlık, aşırı parlak veya patlamış olmamasına dikkat edin. Net ve kontrastı dengeli fotoğraflar daha iyi sonuç verir. <b>Genelde göz fotoğrafları özellikle iyi sonuç verir.</b></p><input id="setWalletPhotoFile-${idx}" data-photo-item-id="${escapeAttr(plan.itemId)}" class=formControl type=file accept="image/*">${preservedFileName?`<div class=muted>Seçtiğiniz fotoğraf korunuyor: ${escapeHtml(preservedFileName)}</div>`:''}
      <label class=walletToggle><input id="setWalletCaptionToggle-${idx}" type=checkbox ${captionOn?'checked':''} onchange="document.querySelector('#setWalletCaptionFields-${idx}').classList.toggle('hidden',!this.checked)"> Fotoğrafın üstüne veya altına yazı da eklemek istiyorum</label>
      <div id="setWalletCaptionFields-${idx}" class="walletCaptionFields ${captionOn?'':'hidden'}"><input id="setWalletCaptionText-${idx}" class=writeInput value="${escapeAttr(caption)}" placeholder="Fotoğrafla birlikte işlenecek yazı"><select id="setWalletCaptionPosition-${idx}" class=formControl><option value=below ${captionPosition==='below'?'selected':''}>Fotoğrafın altında</option><option value=above ${captionPosition==='above'?'selected':''}>Fotoğrafın üstünde</option></select></div>
      ${setItemWriteAvailable(item)?`<label class=walletToggle><input id="setWalletRegularToggle-${idx}" type=checkbox ${regularOn?'checked':''} onchange="document.querySelector('#setWalletRegularFields-${idx}').classList.toggle('hidden',!this.checked)"> Fotoğraftan ayrı olarak cüzdanın ön/iç yüzüne normal yazı da istiyorum</label>
      <div id="setWalletRegularFields-${idx}" class="${regularOn?'':'hidden'}"><div class=positionChoices>${positions.map((pos,j)=>positionOptionHtml('set-wallet-pos-'+idx,pos,j,regularPosition)).join('')}</div><input id="setWalletRegularText-${idx}" class=writeInput value="${escapeAttr(regularText)}" placeholder="Cüzdanın ön/iç yüzüne yazılacak metin"></div>`:''}
    </div>`;
  }).join('')}<div class="wizardBottomAction"><button class=btn onclick=finishSetWalletPhoto(this)>Fotoğrafları Yükle ve Devam Et</button></div>`);
  photoPlan.forEach((plan,idx)=>{
    const existingWrite=(wiz.writes||[]).find(x=>x.itemId===plan.itemId)||{},draft=(wiz.photoDrafts||{})[plan.itemId]||{},position=draft.regularPosition||existingWrite.position||'';
    if(position)document.querySelectorAll(`input[name="set-wallet-pos-${idx}"]`).forEach(r=>{r.checked=r.value===position});
  });
  document.querySelectorAll('.walletPhotoCard input,.walletPhotoCard select').forEach(el=>el.addEventListener(el.type==='text'?'input':'change',captureSetPhotoDrafts));
  restoreSetPhotoFileInputs();
}
async function finishSetWalletPhoto(button){
  captureSetPhotoDrafts();
  const photoPlan=(wiz.personalizationPlan||[]).filter(x=>x.mode==='photo');
  if(!photoPlan.length)return renderSetSummary();
  const old=button?.textContent||'';if(button){button.disabled=true;button.textContent='Fotoğraf yükleniyor…'}
  try{
    const photos=[],extraWrites=[];
    for(let idx=0;idx<photoPlan.length;idx++){
      const plan=photoPlan[idx],item=wiz.product.setItems.find(x=>x.id===plan.itemId),draft=(wiz.photoDrafts||{})[plan.itemId]||{},existingPhoto=(wiz.photoCustomizations||[]).find(x=>x.itemId===plan.itemId)||null;
      const file=document.getElementById(`setWalletPhotoFile-${idx}`)?.files?.[0]||(wiz.photoFileDrafts||{})[plan.itemId]||null;
      if(!file&&!existingPhoto?.imageUrl)throw new Error((item?.name||'Cüzdan')+' için işlenecek fotoğrafı seçin.');
      const captionOn=!!draft.captionOn,caption=captionOn?(draft.caption||'').trim():'';
      if(captionOn&&!caption)throw new Error((item?.name||'Cüzdan')+' için fotoğraf yazısını girin.');
      const regularOn=setItemWriteAvailable(item)&&!!draft.regularOn,regularText=regularOn?(draft.regularText||'').trim():'';
      if(regularOn&&!regularText)throw new Error((item?.name||'Cüzdan')+' için normal yazıyı girin.');
      const up=file?await uploadCustomerPhoto(file):{url:existingPhoto.imageUrl,name:existingPhoto.originalName||''};
      if(file&&wiz.photoFileDrafts)delete wiz.photoFileDrafts[plan.itemId];
      let photoFee;
      if(regularOn){
        extraWrites.push({itemId:item.id,item:item.name,position:draft.regularPosition||preferredForSetItem(item),text:regularText,fee:Number(plan.slotFee||0)});
        photoFee=walletPhotoFee();
      }else photoFee=Number(plan.slotFee||0)+walletPhotoFee();
      photos.push({itemId:item.id,item:item.name,imageUrl:up.url,originalName:up.name||file?.name||existingPhoto?.originalName||'',caption,captionPosition:draft.captionPosition||'below',fee:photoFee});
    }
    const photoIds=new Set(photoPlan.map(x=>x.itemId));
    wiz.writes=[...(wiz.writes||[]).filter(w=>!photoIds.has(w.itemId)),...extraWrites];
    wiz.photoCustomizations=photos;
    renderSetSummary();
  }catch(e){alert(e.message||'Fotoğraf yüklenemedi.');if(button){button.disabled=false;button.textContent=old}}
}

function renderSetOrderNoteQuestion(restoring=false){
  if(!restoring)setWizardNext(wiz.currentScreen||'writeQuestion');
  wiz.currentScreen='orderNoteQuestion';
  openDrawer(head(wiz.product.name)+`<div class=wizardCard><h3>Siparişinize not eklemek ister misiniz?</h3>
  <div class=choiceStack><button class=choiceBtn onclick=finishSetWithoutOrderNote()>Hayır, sipariş notu eklemek istemiyorum</button><button class="choiceBtn primary" onclick=renderSetOrderNoteDetails()>Evet, siparişime not eklemek istiyorum</button></div></div>`);
}
function finishSetWithoutOrderNote(){wiz.orderNote='';renderSetSummary()}
function renderSetOrderNoteDetails(restoring=false){
  if(!restoring)setWizardNext('orderNoteQuestion');
  wiz.currentScreen='orderNoteDetails';
  openDrawer(head('Sipariş notu')+`<div class=wizardCard><h3>Siparişiniz için notunuzu yazın.</h3><textarea id=setOrderNoteText class="formControl setOrderNoteText" maxlength=500 placeholder="Sipariş notunuzu buraya yazın...">${escapeHtml(String(wiz.orderNote||''))}</textarea></div><div class="wizardBottomAction"><button class=btn onclick=confirmSetOrderNote()>Notu Kaydet ve Özeti Gör</button></div>`);
  document.getElementById('setOrderNoteText')?.addEventListener('input',captureSetOrderNoteDraft);
}
function confirmSetOrderNote(){captureSetOrderNoteDraft();wiz.orderNote=String(wiz.orderNote||'').trim();renderSetSummary()}

function calcSetPrice(){
  const removed=wiz.product.setItems.filter(x=>!wiz.keptIds.includes(x.id)).reduce((s,x)=>s+Number(x.removeDiscount||0),0);
  const writeFee=wiz.writes.reduce((s,x)=>s+Number(x.fee||0),0);
  const photoFee=(wiz.photoCustomizations||[]).reduce((s,x)=>s+Number(x.fee||0),0);
  return {base:Number(wiz.product.price),removed,writeFee,photoFee,total:Math.max(0,Number(wiz.product.price)-removed+writeFee+photoFee)};
}
function renderSetSummary(restoring=false){
  if(!restoring)setWizardNext(wiz.currentScreen||'orderNoteQuestion');
  wiz.currentScreen='summary';
  const pr=calcSetPrice(), kept=wiz.product.setItems.filter(x=>wiz.keptIds.includes(x.id)), removed=wiz.product.setItems.filter(x=>!wiz.keptIds.includes(x.id));
  openDrawer(head('Sipariş özeti')+`${removed.length?`<div class=wizardCard><div class=removalSplitSummary><div class=remainingList><b>Size gelecek ürünler:</b><br>${kept.map(x=>'✓ '+escapeHtml(x.name)).join('<br>')}</div><div class=removedList><b>Setten çıkardığınız ürünler:</b><br>${removed.map(x=>'✕ '+escapeHtml(x.name)+' (-'+money(x.removeDiscount)+')').join('<br>')}</div></div></div>`:`<div class=wizardCard><h3>Size gönderilecek ürünler</h3>${kept.map(x=>`<div class=summaryLine><span>✓ ${x.name}</span><span></span></div>`).join('')}</div>`}
  ${wiz.writes.length?`<div class=wizardCard><h3>Kişiye özel yazılar</h3>${wiz.writes.map(x=>`<div class=summaryLine><span><b>${x.item}</b><br><span class=muted>${x.position}: “${x.text}”</span></span><span>+${money(x.fee)}</span></div>`).join('')}</div>`:''}
  ${(wiz.photoCustomizations||[]).length?`<div class=wizardCard><h3>Cüzdan fotoğrafı</h3>${wiz.photoCustomizations.map(x=>`<div class=summaryLine><span><b>${x.item}</b>${x.caption?`<br><span class=muted>${x.captionPosition==='above'?'Fotoğrafın üstünde':'Fotoğrafın altında'}: “${escapeHtml(x.caption)}”</span>`:''}</span><span>+${money(x.fee)}</span></div>`).join('')}</div>`:''}
  <div class=wizardCard><div class=summaryLine><span>Set fiyatı</span><span>${money(pr.base)}</span></div>${pr.removed?`<div class=summaryLine><span>Çıkarılan ürünler</span><span>-${money(pr.removed)}</span></div>`:''}${pr.writeFee?`<div class=summaryLine><span>Yazı işlemleri</span><span>+${money(pr.writeFee)}</span></div>`:''}${pr.photoFee?`<div class=summaryLine><span>Fotoğraf işlemesi</span><span>+${money(pr.photoFee)}</span></div>`:''}<div class="summaryLine summaryTotal"><span>Toplam</span><span>${money(pr.total)}</span></div></div>
  <div class="wizardFinalAction"><button class=btn onclick=addSetToCart()>Sepete Ekle</button></div>`);
}
function addSetToCart(){
  const pr=calcSetPrice();
  const item={product:{...wiz.product,price:pr.total},basePrice:wiz.product.price,qty:1,personalized:wiz.writes.length>0||(wiz.photoCustomizations||[]).length>0,setCustomization:{keptIds:wiz.keptIds,removedIds:wiz.product.setItems.filter(x=>!wiz.keptIds.includes(x.id)).map(x=>x.id),writes:wiz.writes,photoCustomizations:wiz.photoCustomizations||[]}};
  cart.push(item);
  updateCart(); closeDrawer(); toast('✓ Ürün sepete eklendi');
}

/* CART + CHECKOUT */

function campaignProductMatches(rule,p){
  if(!p)return false;
  const excluded=rule.excludedProductIds||[];
  if(excluded.includes(p.id))return false;
  const scope=rule.scopeType||'category';
  if(scope==='all')return true;
  if(scope==='products')return (rule.productIds||[]).includes(p.id);
  return (rule.categoryIds||[]).includes(p.category);
}
function campaignUnitWeight(rule,p){
  return Math.max(1,Math.min(10,Number(rule?.productUnitCounts?.[p?.id]||1)));
}
function physicalCartUnits(){
  const units=[];
  cart.forEach((x,cartIndex)=>{
    const qty=Math.max(1,Number(x.qty||1));
    for(let n=0;n<qty;n++)units.push({key:`${cartIndex}:${n}`,price:Number(x.product?.price||0),cartIndex,product:x.product});
  });
  return units;
}
function cartUnitsForCampaign(rule){
  return physicalCartUnits().filter(u=>campaignProductMatches(rule,u.product)).map(u=>({...u,weight:campaignUnitWeight(rule,u.product),productId:u.product?.id||''}));
}
function campaignWeightedCount(rule){return cartUnitsForCampaign(rule).reduce((s,u)=>s+u.weight,0)}
function campaignBenefitText(rule){
  const v=Number(rule.discountValue||0);
  if(rule.discountType==='percent')return `%${v} indirim`;
  if(rule.discountType==='bundlePrice')return `${money(v)} kampanya toplamı`;
  return `${money(v)} indirim`;
}
function campaignApplicationDiscount(rule,units){
  const v=Math.max(0,Number(rule.discountValue||0));
  if(rule.discountType==='fixed')return v;
  const subtotal=units.reduce((s,u)=>s+Number(u.price||0),0);
  if(rule.discountType==='percent')return subtotal*Math.max(0,Math.min(100,v))/100;
  if(rule.discountType==='bundlePrice')return Math.max(0,subtotal-v);
  return v;
}
function campaignMaxUses(rule,totalWeight){
  const q=Math.max(1,Number(rule.minQty||1));
  if(totalWeight<q)return 0;
  if(!rule.repeatable)return 1;
  const natural=Math.floor(totalWeight/q);
  const limit=Math.max(1,Number(rule.maxApplications||1));
  return Math.min(natural,limit);
}
function campaignCandidateGroups(rule,allUnits,maxCandidates=700){
  const q=Math.max(1,Number(rule.minQty||1));
  const eligible=[];
  allUnits.forEach((u,index)=>{if(campaignProductMatches(rule,u.product))eligible.push({index,unit:u,weight:campaignUnitWeight(rule,u.product)})});
  const totalWeight=eligible.reduce((s,x)=>s+x.weight,0);
  const maxUses=campaignMaxUses(rule,totalWeight);
  if(!maxUses)return {groups:[],totalWeight,maxUses};
  const groups=[],seen=new Set();
  function walk(pos,sum,chosen){
    if(groups.length>=maxCandidates)return;
    if(sum>=q){
      const key=chosen.map(x=>x.index).join(',');
      if(!seen.has(key)){
        seen.add(key);
        const units=chosen.map(x=>x.unit);
        let mask=0n;chosen.forEach(x=>{mask|=(1n<<BigInt(x.index))});
        groups.push({mask,units,discount:Math.max(0,campaignApplicationDiscount(rule,units))});
      }
      return;
    }
    if(pos>=eligible.length)return;
    let possible=sum;
    for(let i=pos;i<eligible.length;i++)possible+=eligible[i].weight;
    if(possible<q)return;
    walk(pos+1,sum+eligible[pos].weight,[...chosen,eligible[pos]]);
    walk(pos+1,sum,chosen);
  }
  walk(0,0,[]);
  groups.sort((a,b)=>b.discount-a.discount || a.units.length-b.units.length);
  return {groups,totalWeight,maxUses};
}
function optimizeCampaignApplications(rules){
  const allUnits=physicalCartUnits();
  if(!allUnits.length||!rules.length)return [];
  const prepared=rules.map(rule=>({rule,...campaignCandidateGroups(rule,allUnits,allUnits.length>22?220:700)})).filter(x=>x.groups.length&&x.maxUses>0);
  if(!prepared.length)return [];
  const memo=new Map();
  function dfs(usedMask,counts){
    const key=usedMask.toString()+'|'+counts.join(',');
    if(memo.has(key))return memo.get(key);
    let best={value:0,apps:[]};
    for(let ri=0;ri<prepared.length;ri++){
      const pr=prepared[ri];
      if((counts[ri]||0)>=pr.maxUses)continue;
      for(const g of pr.groups){
        if((usedMask&g.mask)!==0n)continue;
        const nextCounts=counts.slice();nextCounts[ri]=(nextCounts[ri]||0)+1;
        const tail=dfs(usedMask|g.mask,nextCounts);
        const value=g.discount+tail.value;
        if(value>best.value+0.0001)best={value,apps:[{rule:pr.rule,discount:g.discount,mask:g.mask,units:g.units},...tail.apps]};
      }
    }
    memo.set(key,best);return best;
  }
  return dfs(0n,Array(prepared.length).fill(0)).apps;
}
function optimizeCampaignsExclusive(rules){
  return optimizeCampaignApplications(rules).map(x=>({rule:x.rule,discount:x.discount}));
}
function campaignPromptForRule(rule,selectedApps,usedExclusiveMask=0n){
  const q=Math.max(1,Number(rule.minQty||1));
  const maxUses=rule.repeatable?Math.max(1,Number(rule.maxApplications||1)):1;
  const usedCount=selectedApps.filter(x=>x.rule.id===rule.id).length;
  if(usedCount>=maxUses)return null;
  let availableWeight=0;
  physicalCartUnits().forEach((unit,index)=>{
    if(!campaignProductMatches(rule,unit.product))return;
    const bit=(1n<<BigInt(index));
    if(rule.allowDoubleCount!==true && (usedExclusiveMask&bit)!==0n)return;
    availableWeight+=campaignUnitWeight(rule,unit.product);
  });
  const remainder=availableWeight%q;
  const remaining=availableWeight===0?q:(remainder===0?q:q-remainder);
  return {id:rule.id,name:rule.name||'Kampanya',remaining,benefit:campaignBenefitText(rule),completed:usedCount,nextUse:usedCount+1,usesLeft:maxUses-usedCount,maxUses,repeatable:!!rule.repeatable};
}
function calculateCartCampaignsCore(){
  const subtotal=cart.reduce((a,x)=>a+Number(x.product?.price||0)*Math.max(1,Number(x.qty||1)),0);
  const active=(catalog.checkoutCampaigns||[]).filter(r=>r&&r.enabled!==false);
  const applied=[];

  active.filter(r=>r.allowDoubleCount===true).forEach(rule=>{
    optimizeCampaignApplications([rule]).forEach(x=>{
      if(x.discount>0)applied.push({id:x.rule.id,name:x.rule.name||'Kampanya',discount:Number(x.discount.toFixed(2)),uses:1,rule:x.rule,mask:x.mask||0n});
    });
  });

  const exclusive=active.filter(r=>r.allowDoubleCount!==true);
  const exclusiveApps=optimizeCampaignApplications(exclusive);
  exclusiveApps.forEach(x=>{
    if(x.discount>0)applied.push({id:x.rule.id,name:x.rule.name||'Kampanya',discount:Number(x.discount.toFixed(2)),uses:1,rule:x.rule,mask:x.mask||0n});
  });

  const merged=[];
  applied.forEach(a=>{
    const found=merged.find(x=>x.id===a.id);
    if(found){found.discount=Number((found.discount+a.discount).toFixed(2));found.uses=(found.uses||1)+(a.uses||1)}else merged.push({...a});
  });
  let remaining=subtotal;
  merged.sort((a,b)=>b.discount-a.discount).forEach(a=>{a.discount=Math.min(a.discount,Math.max(0,remaining));remaining-=a.discount});
  const usedExclusiveMask=exclusiveApps.reduce((mask,x)=>mask|(x.mask||0n),0n);
  const prompts=active.map(rule=>campaignPromptForRule(rule,exclusiveApps,usedExclusiveMask)).filter(Boolean).sort((a,b)=>a.remaining-b.remaining||a.completed-b.completed||a.name.localeCompare(b.name,'tr'));
  const discount=Number(merged.reduce((s,a)=>s+a.discount,0).toFixed(2));
  return {subtotal,discount,total:Math.max(0,Number((subtotal-discount).toFixed(2))),applied:merged,prompts};
}

function nextCampaignGuidance(){
  const active=(catalog.checkoutCampaigns||[]).filter(r=>r&&r.enabled!==false);
  if(!active.length)return null;
  const now=calculateCartCampaignsCore();
  const nowDiscount=Number(now.discount||0);
  // 1..12 ek ürün içinde indirimi ilk artıran noktayı bul. Böylece müşteri sadece sıradaki gerçek adıma yönlendirilir.
  const candidates=(catalog.products||[]).filter(p=>!p.hidden&&active.some(r=>campaignProductMatches(r,p)));
  if(!candidates.length)return null;
  const sample=candidates.sort((a,b)=>Number(a.price||0)-Number(b.price||0))[0];
  const original=cart;
  try{
    for(let add=1;add<=12;add++){
      const extras=Array.from({length:add},()=>({product:sample,qty:1,personalized:false}));
      cart=[...original,...extras];
      const next=calculateCartCampaignsCore();
      if(Number(next.discount||0)>nowDiscount+.001){
        const gained=(next.applied||[]).find(n=>{const old=(now.applied||[]).find(o=>o.id===n.id);return Number(n.discount||0)>Number(old?.discount||0)+.001})||next.applied?.[0];
        return {remaining:add,name:gained?.name||'Kampanya',benefit:money(Number(next.discount||0)-nowDiscount)};
      }
    }
  }finally{cart=original}
  return null;
}
function calculateCartCampaigns(){
  const result=calculateCartCampaignsCore();
  const next=nextCampaignGuidance();
  result.prompts=next?[next]:[];
  return result;
}
function shareCartFromCheckout(){
  normalizeCartPersonalizationFees();
  const campaign=calculateCartCampaigns();
  const payload={v:1,items:cart.map(x=>({name:x.product?.name||'Ürün',price:Number(x.product?.price||0),image:mainProductImage(x.product)||'',qty:Number(x.qty||1),basePrice:Number(x.basePrice??x.product?.price??0),writes:(x.writes||x.setCustomization?.writes||[]).map(w=>({item:w.item,text:w.text,position:w.position,fee:Number(w.fee||0)})),photos:(x.photoCustomizations||x.setCustomization?.photoCustomizations||[]).map(ph=>({item:ph.item,fee:Number(ph.fee||0)}))})),subtotal:campaign.subtotal,discount:campaign.discount,total:campaign.total,applied:(campaign.applied||[]).map(a=>({name:a.name,discount:a.discount}))};
  fetch('/api/shared-cart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).then(r=>r.json()).then(r=>{
    if(!r.ok||!r.id)throw new Error('share');
    const url=new URL(location.origin+location.pathname);url.searchParams.set('s',r.id);
    const text='SHAZ sepetimi seninle paylaştım.';
    if(navigator.share){navigator.share({title:'SHAZ Sepetim',text,url:url.toString()}).catch(()=>{});return;}
    navigator.clipboard?.writeText(url.toString()).then(()=>toast('Sepet bağlantısı kopyalandı')).catch(()=>toast('Sepet paylaşılamadı'));
  }).catch(()=>toast('Sepet paylaşılamadı'));
}

function renderSharedCart(data){
  const items=Array.isArray(data.items)?data.items:[];
  openDrawer(`<div class="checkoutShell sharedCartShell"><div class="checkoutTop"><div><h2>Paylaşılan Sepet</h2><p>Bu ekran, size gönderilen SHAZ sepetinin fiyat ve ürün özetidir.</p></div><button class="pill" onclick="closeDrawer()">Kapat</button></div><div class="checkoutProductPanel">${items.map(x=>`<div class="orderCartItem"><div class="cartItemMain">${x.image?`<div class="cartItemThumb"><img src="${escapeAttr(x.image)}" alt=""></div>`:''}<div class="cartItemCopy"><b>${escapeHtml(x.name)}</b>${(x.writes||[]).map(w=>`<div class=muted>Yazı: ${w.item?escapeHtml(w.item)+' · ':''}${w.position?escapeHtml(w.position)+' · ':''}“${escapeHtml(w.text||'')}” · +${money(w.fee||0)}</div>`).join('')}${(x.photos||[]).map(ph=>`<div class=muted>Fotoğraf işlemesi · +${money(ph.fee||0)}</div>`).join('')}</div><div class="cartItemRight"><strong>${money(x.price)}</strong></div></div></div>`).join('')}</div><div class="checkoutPriceBreakdown"><div><span>Ara toplam</span><strong>${money(data.subtotal)}</strong></div>${(data.applied||[]).map(a=>`<div class="checkoutDiscountLine"><span>${escapeHtml(a.name)}</span><strong>-${money(a.discount)}</strong></div>`).join('')}<div class="checkoutTotal"><span>Toplam</span><strong>${money(data.total)}</strong></div></div><button class="btn sharedCartShopBtn" onclick="history.replaceState({},'',location.pathname);closeDrawer()">Alışverişe Git →</button></div>`);
}
function openSharedCartFromUrl(){
  const params=new URLSearchParams(location.search),shortId=params.get('s'),raw=params.get('sharedCart');
  if(shortId){fetch('/api/shared-cart/'+encodeURIComponent(shortId)).then(r=>r.json()).then(r=>{if(r.ok&&r.cart)renderSharedCart(r.cart)}).catch(()=>{});return true}
  if(!raw)return false;
  try{renderSharedCart(JSON.parse(decodeURIComponent(escape(atob(raw)))));return true}catch(e){console.warn('Paylaşılan sepet açılamadı',e);return false}
}

function checkoutCouponSelectionState(baseTotal,ids=checkoutState.appliedCouponIds){
  const unique=[...new Set((ids||[]).map(String))],selected=unique.map(id=>currentAccountCoupons.find(x=>String(x.id)===id&&x.status==='active')).filter(Boolean),base=Math.max(0,Number(baseTotal||0));
  if(!selected.length)return {ok:true,coupons:[],requiredMin:0};
  if(selected.length===1){const requiredMin=Math.max(0,Number(selected[0].minCartAmount||0));return base>=requiredMin?{ok:true,coupons:selected,requiredMin}:{ok:false,coupons:selected,requiredMin,message:`Bu kupon için minimum sepet tutarı ${money(requiredMin)}.`}}
  if(selected.some(c=>c.discountType==='percent'))return {ok:false,coupons:selected,requiredMin:0,message:'Yüzdelik kuponlar başka kuponlarla birleştirilemez.'};
  if(selected.some(c=>c.stackable!==true))return {ok:false,coupons:selected,requiredMin:0,message:'Bu kuponlardan biri diğer kuponlarla birlikte kullanılamaz.'};
  const requiredMin=selected.reduce((sum,c)=>sum+Math.max(0,Number(c.minCartAmount||0)),0);
  return base>=requiredMin?{ok:true,coupons:selected,requiredMin}:{ok:false,coupons:selected,requiredMin,message:`Seçtiğiniz kuponları birlikte kullanmak için indirim öncesi sepet toplamınız en az ${money(requiredMin)} olmalı.`}
}
function couponCartResult(baseTotal,ids=checkoutState.appliedCouponIds){
  const state=checkoutCouponSelectionState(baseTotal,ids);if(!state.ok)return {coupons:[],discount:0,total:Math.max(0,Number(baseTotal||0)),invalidMessage:state.message};
  let remaining=Math.max(0,Number(baseTotal||0)),discount=0;const selected=[];
  for(const c of state.coupons){let amount=c.discountType==='fixed'?Number(c.value||0):remaining*(Number(c.value||0)/100);if(c.discountType==='percent'&&Number(c.maxDiscountAmount||0)>0)amount=Math.min(amount,Number(c.maxDiscountAmount));amount=Math.max(0,Math.min(remaining,Math.round(amount*100)/100));remaining=Math.max(0,Math.round((remaining-amount)*100)/100);discount=Math.round((discount+amount)*100)/100;selected.push({...c,discount:amount})}
  return {coupons:selected,discount,total:remaining}
}
function checkoutCouponMessage(text){document.querySelector('.checkoutCouponToast')?.remove();const el=document.createElement('div');el.className='checkoutCouponToast';el.textContent=text;document.body.appendChild(el);requestAnimationFrame(()=>el.classList.add('show'));setTimeout(()=>el.classList.add('leaving'),1200);setTimeout(()=>el.remove(),1900)}
function toggleCheckoutCouponPanel(){checkoutState.couponPanelOpen=!checkoutState.couponPanelOpen;checkout(document.querySelector('.checkoutScrollBody')?.scrollTop||0)}
function toggleCheckoutCoupon(id){
  if(!currentAccountUser)return checkoutCouponMessage('Kupon kullanmak için üye hesabıyla giriş yapmalısınız.');
  const c=currentAccountCoupons.find(x=>String(x.id)===String(id)&&x.status==='active');if(!c)return checkoutCouponMessage('Bu kupon şu anda kullanılamıyor.');
  const campaign=calculateCartCampaigns(),ids=[...(checkoutState.appliedCouponIds||[])],pos=ids.findIndex(x=>String(x)===String(id));
  if(pos>=0){ids.splice(pos,1);checkoutState.appliedCouponIds=ids;checkoutState.couponPanelOpen=true;return checkout(document.querySelector('.checkoutScrollBody')?.scrollTop||0)}
  const candidate=[...ids,c.id],state=checkoutCouponSelectionState(campaign.total,candidate);if(!state.ok)return checkoutCouponMessage(state.message);
  ids.push(c.id);checkoutState.appliedCouponIds=ids;checkoutState.couponPanelOpen=true;checkoutState.couponSkipConfirmed=false;checkout(document.querySelector('.checkoutScrollBody')?.scrollTop||0)
}
function checkoutCouponsHtml(baseTotal){
  if(!currentAccountUser)return '';
  const rows=activeAccountCoupons();if(!rows.length)return '';
  const selected=new Set((checkoutState.appliedCouponIds||[]).map(String)),open=!!checkoutState.couponPanelOpen||selected.size>0;
  return `<section class="checkoutCouponPanel ${open?'is-open':''}"><button type="button" class="checkoutCouponToggle" onclick="toggleCheckoutCouponPanel()"><span>Kupon Kullan${selected.size?` · ${selected.size} seçili`:''}</span><b>${open?'−':'+'}</b></button><div class="checkoutCouponCollapsible" ${open?'':'hidden'}><div class="checkoutCouponPanelHead"><b>Kuponlarım</b><small>Uygun kuponlarınızı sepetinize uygulayabilirsiniz.</small></div><div class="checkoutCouponChoices">${rows.map(c=>{const applied=selected.has(String(c.id)),ex=couponExpiryInfo(c),min=Number(c.minCartAmount||0);return `<div class="checkoutCouponChoice ${applied?'is-applied':''}"><div><strong>${escapeHtml(couponDiscountLabel(c))}</strong><b>${escapeHtml(c.code||'')}</b>${String(c.title||'').trim()?`<small>${escapeHtml(c.title)}</small>`:''}${min?`<small>Minimum sepet: ${money(min)}</small>`:''}${c.discountType==='percent'&&Number(c.maxDiscountAmount||0)>0?`<small>Maksimum indirim: ${money(c.maxDiscountAmount)}</small>`:''}<small>${c.stackable?'Diğer uygun kuponlarla birlikte kullanılabilir':'Tek başına kullanılabilir'}</small><small class="${ex.urgent?'couponExpiryUrgent':''}">${escapeHtml(ex.text)}</small></div><button type="button" onclick="toggleCheckoutCoupon('${escapeAttr(c.id)}')">${applied?'Kaldır':'Uygula'}</button></div>`}).join('')}</div></div></section>`
}
function checkout(restoreScrollTop=null){
  normalizeCartPersonalizationFees();
  if(!cart.length)return openDrawer('<div class="checkoutEmpty"><h2>Sepetiniz boş</h2><p>Beğendiğiniz ürünleri sepete ekleyerek siparişe başlayabilirsiniz.</p><button class="btn" onclick="closeDrawer()">Ürünlere Dön</button></div>');
  const campaign=calculateCartCampaigns(),couponPricing=couponCartResult(campaign.total),itemCount=cart.reduce((n,x)=>n+Number(x.qty||1),0),next=campaign.prompts?.[0];
  checkoutState.appliedCouponIds=couponPricing.coupons.map(c=>c.id);
  openDrawer(`<div class="checkoutShell checkoutShell--cart"><div class="checkoutStickyTop"><div class="checkoutTop"><div><h2>Sepetiniz</h2><p>Ürünleri kontrol edin; ardından teslimat ve ödemeye geçin.</p></div><div class="checkoutTopActions"><button type="button" class="checkoutMiniAction" onclick="shareCartFromCheckout()"><span class="checkoutMiniIcon">⤴</span><small>Sepeti paylaş</small></button><button class="pill" onclick=closeDrawer()>Kapat</button></div></div><div class="checkoutBackRow"><button type="button" class="checkoutBackBtn" onclick="closeDrawer()">← Alışverişe dön</button></div><div class="checkoutSteps"><span class="active">1 Sepet</span><span>2 Teslimat</span><span>3 Onay</span></div></div>
    <div class="checkoutScrollBody"><div class="cartToolbar"><span>${itemCount} ürün</span><button type="button" class="cartClearBtn" onclick="clearCartFromCheckout()">Sepeti boşalt</button></div><div class="checkoutProductPanel">${cart.map((x,i)=>cartItemSummary(x,i)).join('')}</div>${checkoutCouponsHtml(campaign.total)}</div>
    <div class="checkoutStickyBottom">${next?`<div class="campaignPromptBox campaignPromptBox--next"><b>${escapeHtml(next.name)}:</b> <strong>${next.remaining} ürün daha ekle</strong> → ${escapeHtml(next.benefit)} indirim kazan.</div>`:''}<div class="checkoutPriceBreakdown"><div><span>Ara toplam</span><strong>${money(campaign.subtotal)}</strong></div>${campaign.applied.map(x=>`<div class="checkoutDiscountLine"><span>${escapeHtml(x.name)}</span><strong>-${money(x.discount)}</strong></div>`).join('')}${couponPricing.coupons.map(c=>`<div class="checkoutDiscountLine checkoutCouponDiscountLine"><span>Kupon · ${escapeHtml(c.code||'')}</span><strong>-${money(c.discount)}</strong></div>`).join('')}<div class="checkoutTotal"><span>Toplam</span><strong>${money(couponPricing.total)}</strong></div></div><button class="btn checkoutPrimary" onclick="proceedToAddressWithUpsell()">Teslimat ve Ödemeye Geç →</button></div></div>`);
  if(Number.isFinite(Number(restoreScrollTop)))requestAnimationFrame(()=>{const scroller=document.querySelector('.drawer.drawerCartMode .checkoutScrollBody');if(scroller)scroller.scrollTop=Math.max(0,Number(restoreScrollTop)||0)})
}
let cartEditBackup=null;
function openCartItemProduct(i){const x=cart[i];if(!x?.product?.id)return;const scroller=document.querySelector('.drawer.drawerCartMode .checkoutScrollBody');activeCartDetailScrollTop=scroller?.scrollTop||0;openProductDetail(x.product.id,'cart')}
function editCartItem(i){
  const x=cart[i];if(!x)return;
  const writes=x.writes||x.setCustomization?.writes||[];
  const photos=x.photoCustomizations||x.setCustomization?.photoCustomizations||[];
  const fields=writes.map((w,n)=>`<label class="cartEditField"><span>${escapeHtml(w.item||'Ürün')} · ${escapeHtml(w.position||'Yazı')}</span><input class="formControl" data-cart-edit-write="${n}" value="${escapeAttr(w.text||'')}"></label>`).join('');
  showSoftNotice('Ürünü düzenle',writes.length?'Yazıları burada değiştirebilirsiniz. Ürünün diğer seçeneklerini yeniden seçmek için ürün ekranını açın.':photos.length?'Fotoğraf seçiminiz korunuyor. Ürünün diğer seçenekleri için ürün ekranını açabilirsiniz.':'Bu üründe mevcut bir kişiselleştirme yok. Ürün ekranından seçenekleri yeniden açabilirsiniz.','','');
  const card=document.querySelector('.softNoticeCard');if(!card)return;
  card.insertAdjacentHTML('beforeend',`${fields?`<div class="cartEditFields">${fields}</div>`:''}${photos.length?`<div class="cartEditPhotoNote">📷 ${photos.length} fotoğraf işlemesi mevcut.</div>`:''}<div class="cartEditActions">${writes.length?`<button class="btn" type="button" onclick="saveCartItemEdits(${i})">Değişiklikleri Kaydet</button>`:''}<button class="pill" type="button" onclick="closeSoftNotice();openCartItemProduct(${i})">Ürün Ekranını Aç</button></div>`);
}
function saveCartItemEdits(i){
  const x=cart[i];if(!x)return;
  const writes=x.writes||x.setCustomization?.writes||[];
  [...document.querySelectorAll('[data-cart-edit-write]')].forEach(inp=>{const w=writes[Number(inp.dataset.cartEditWrite)];if(w)w.text=inp.value.trim()});
  closeSoftNotice();normalizeCartPersonalizationFees();checkout();toast('✓ Ürün güncellendi');
}
function restoreCartEditIfNeeded(){}
function removeCartItem(i){
  if(i<0||i>=cart.length)return;
  cart.splice(i,1);if(!cart.length){checkoutState.appliedCouponIds=[];checkoutState.couponPanelOpen=false;checkoutState.couponSkipConfirmed=false;}updateCart();
  if(cart.length) checkout(); else closeDrawer();
}
function clearCartFromCheckout(){
  if(!cart.length)return;
  if(!confirm('Sepetteki tüm ürünler kaldırılsın mı?'))return;
  cart=[];checkoutState.appliedCouponIds=[];updateCart();closeDrawer();toast('Sepet boşaltıldı');
}

function cartItemSummary(x,i){
  const lines=[],priceLines=[],basePrice=Number(x.basePrice??x.product?.price??0);
  priceLines.push(`<div><span>Ürün fiyatı</span><strong>${money(basePrice)}</strong></div>`);
  if(x.setCustomization){
    const removed=(x.setCustomization.removedIds||[]).map(id=>(x.product.setItems||[]).find(s=>s.id===id)).filter(Boolean);
    if(removed.length){removed.forEach(item=>priceLines.push(`<div class="isDiscount"><span>Çıkarılan · ${escapeHtml(item.name)}</span><strong>-${money(item.removeDiscount||0)}</strong></div>`));}
  }
  if(x.builderItems?.length)lines.push(`<div class=muted>Set içeriği: ${x.builderItems.map(p=>escapeHtml(p.name)).join(', ')}</div>`);
  if(String(x.productNote||'').trim())lines.push(`<div class="cartProductNote"><b>Sipariş notu:</b> ${escapeHtml(String(x.productNote).trim())}</div>`);
  const writes=x.writes||x.setCustomization?.writes||[];
  if(writes.length){
    writes.forEach(w=>{if(Number(w.fee||0))priceLines.push(`<div><span>${x.setCustomization?'Kişiselleştirme · '+escapeHtml(w.item||'Ürün'):'Kişiselleştirme'}${w.position?` · ${escapeHtml(w.position)}`:''}${w.text?` · “${escapeHtml(w.text)}”`:''}</span><strong>+${money(w.fee)}</strong></div>`)});
  }
  const photos=x.photoCustomizations||x.setCustomization?.photoCustomizations||[];
  if(photos.length){photos.forEach(ph=>{
    const slotFee=Number(ph.slotFee||0),extra=Number(ph.photoExtraFee??(Number(ph.fee||0)-slotFee));
    if(slotFee)priceLines.push(`<div><span>Kişiselleştirme · ${escapeHtml(ph.item||'Cüzdan')}${ph.caption?` · “${escapeHtml(ph.caption)}”`:''}</span><strong>+${money(slotFee)}</strong></div>`);
    if(extra>0)priceLines.push(`<div><span>Fotoğraf işleme · ${escapeHtml(ph.item||'Cüzdan')}</span><strong>+${money(extra)}</strong></div>`);
    else if(Number(ph.fee||0)>0&&!slotFee)priceLines.push(`<div><span>Fotoğraf işleme · ${escapeHtml(ph.item||'Cüzdan')}${ph.caption?` · “${escapeHtml(ph.caption)}”`:''}</span><strong>+${money(ph.fee)}</strong></div>`);
  })}
  const cartImg=mainProductImage(x.product)||(x.builderItems||[]).find(y=>y?.image)?.image||'';
  return `<div class="orderCartItem"><div class="cartItemMain cartItemClickable" onclick="openCartItemProduct(${i})">${cartImg?`<div class="cartItemThumb"><img src="${escapeAttr(cartImg)}" alt="${escapeAttr(x.product.name||'Ürün')}"></div>`:''}<div class="cartItemCopy"><b>${escapeHtml(x.product.name)}</b>${lines.join('')}${priceLines.length>1?`<div class="cartItemBreakdown">${priceLines.join('')}</div>`:''}</div><div class="cartItemRight"><strong>${money(x.product.price)}</strong><div class="cartItemActions"><button type="button" class="cartEditBtn" onclick="event.stopPropagation();editCartItem(${i})">Düzenle</button><button type="button" class="cartRemoveBtn" onclick="event.stopPropagation();removeCartItem(${i})">Kaldır</button></div></div></div></div>`;
}

function normalizeTRMobile(raw){
  const digits=String(raw||'').replace(/\D/g,'');
  if(/^5\d{9}$/.test(digits))return {ok:true,value:digits};
  if(/^05\d{9}$/.test(digits))return {ok:true,value:digits.slice(1)};
  return {ok:false,value:digits};
}
function phoneValidationMessage(label='Telefon numarası'){
  return `${label} eksik veya fazla. Lütfen numarayı kontrol edin.`;
}
const TR_PROVINCES=['Adana','Adıyaman','Afyonkarahisar','Ağrı','Aksaray','Amasya','Ankara','Antalya','Ardahan','Artvin','Aydın','Balıkesir','Bartın','Batman','Bayburt','Bilecik','Bingöl','Bitlis','Bolu','Burdur','Bursa','Çanakkale','Çankırı','Çorum','Denizli','Diyarbakır','Düzce','Edirne','Elazığ','Erzincan','Erzurum','Eskişehir','Gaziantep','Giresun','Gümüşhane','Hakkari','Hatay','Iğdır','Isparta','İstanbul','İzmir','Kahramanmaraş','Karabük','Karaman','Kars','Kastamonu','Kayseri','Kırıkkale','Kırklareli','Kırşehir','Kilis','Kocaeli','Konya','Kütahya','Malatya','Manisa','Mardin','Mersin','Muğla','Muş','Nevşehir','Niğde','Ordu','Osmaniye','Rize','Sakarya','Samsun','Siirt','Sinop','Sivas','Şanlıurfa','Şırnak','Tekirdağ','Tokat','Trabzon','Tunceli','Uşak','Van','Yalova','Yozgat','Zonguldak'];
function trKey(v){return String(v||'').trim().toLocaleLowerCase('tr-TR').replace(/\s+/g,' ')}
function canonicalProvince(v){const key=trKey(v);return TR_PROVINCES.find(x=>trKey(x)===key)||''}
function stripAddressSuffix(v,type){
  let s=String(v||'').trim();
  const patterns=type==='neighborhood'?/\s+(mahallesi|mahalle|mah\.?|mh\.?)$/iu:type==='avenue'?/\s+(caddesi|cadde|cad\.?|cd\.?)$/iu:/\s+(sokağı|sokak|sok\.?|sk\.?)$/iu;
  return s.replace(patterns,'').trim();
}
function addressPart(v,type){
  const clean=stripAddressSuffix(v,type);
  if(!clean)return '';
  return `${clean} ${type==='neighborhood'?'MH.':type==='avenue'?'CD.':'SK.'}`;
}
function focusDrawerField(el){
  if(!el)return;
  const drawer=$('#drawer');
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    const topGuard=(drawer?.querySelector('.checkoutStickyTop,.wizardHead')?.getBoundingClientRect().height||0)+14;
    const bottomGuard=(drawer?.querySelector('.checkoutStickyBottom,.wizardBottomAction')?.getBoundingClientRect().height||0)+18;
    const r=el.getBoundingClientRect(),vh=window.visualViewport?.height||window.innerHeight;
    if(r.top<topGuard||r.bottom>vh-bottomGuard)el.scrollIntoView({block:'center',behavior:'smooth'});
  }));
}
function syncDrawerVisualViewport(){
  const drawer=$('#drawer'),vv=window.visualViewport;if(!drawer)return;
  const keyboardOpen=document.body.classList.contains('shazKeyboardOpen');
  // Klavye kapalıyken visualViewport.offsetTop'u drawer konumuna taşımıyoruz.
  // iOS hızlı kaydırmada bu değer anlık değiştiği için sabit üst/alt alanlar zıplıyordu.
  if(!keyboardOpen){
    drawer.style.removeProperty('--shaz-vvh');
    drawer.style.setProperty('--shaz-vvtop','0px');
    return;
  }
  const h=Math.max(240,Math.round(vv?.height||window.innerHeight));
  const top=Math.max(0,Math.round(vv?.offsetTop||0));
  drawer.style.setProperty('--shaz-vvh',h+'px');drawer.style.setProperty('--shaz-vvtop',top+'px');
  const active=drawer.querySelector('input:focus,textarea:focus,select:focus');if(active)setTimeout(()=>focusDrawerField(active),40);
}
function bindDrawerScrollGuard(){
  const drawer=$('#drawer');if(!drawer)return;
  const scrollEl=drawer.querySelector('.checkoutScrollBody')||drawer;
  if(scrollEl.dataset.shazScrollGuard==='1')return;
  scrollEl.dataset.shazScrollGuard='1';
  let lastY=0;
  const nudgeFromEdge=()=>{
    const max=Math.max(0,scrollEl.scrollHeight-scrollEl.clientHeight);
    if(max<=2)return;
    if(scrollEl.scrollTop<=0)scrollEl.scrollTop=1;
    else if(scrollEl.scrollTop>=max)scrollEl.scrollTop=max-1;
  };
  scrollEl.addEventListener('touchstart',e=>{
    if(e.touches?.length!==1)return;
    lastY=e.touches[0].clientY;nudgeFromEdge();
  },{passive:true});
  scrollEl.addEventListener('touchmove',e=>{
    if(e.touches?.length!==1)return;
    const y=e.touches[0].clientY,dy=y-lastY;lastY=y;
    const max=Math.max(0,scrollEl.scrollHeight-scrollEl.clientHeight);
    if(max<=1)return;
    const atTop=scrollEl.scrollTop<=0,atBottom=scrollEl.scrollTop>=max;
    if((atTop&&dy>0)||(atBottom&&dy<0))e.preventDefault();
  },{passive:false});
  // iOS momentum scroll, parmak bırakıldıktan sonra da sınırın dışına esnemeye çalışabilir.
  // Kaydırılan orta alanı 1px içeride tutarak üst/alt sabit katmanın lastik gibi sürüklenmesini kesiyoruz.
  let clampRaf=0;
  scrollEl.addEventListener('scroll',()=>{
    if(clampRaf)return;
    clampRaf=requestAnimationFrame(()=>{clampRaf=0;nudgeFromEdge()});
  },{passive:true});
}
let drawerViewportBound=false;
function bindDrawerInputFocus(){
  const drawer=$('#drawer');if(!drawer)return;syncDrawerVisualViewport();
  if(!drawerViewportBound&&window.visualViewport){window.visualViewport.addEventListener('resize',syncDrawerVisualViewport,{passive:true});window.visualViewport.addEventListener('scroll',syncDrawerVisualViewport,{passive:true});drawerViewportBound=true}
  drawer.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]),textarea,select').forEach(el=>{
    const beforeKeyboard=()=>document.body.classList.add('shazKeyboardOpen');
    // iOS klavyeyi açmadan hemen önce arka planı gizle; focus anını beklemek bazı cihazlarda geç kalıyordu.
    el.addEventListener('pointerdown',beforeKeyboard,{passive:true});
    el.addEventListener('touchstart',beforeKeyboard,{passive:true});
    el.addEventListener('focus',()=>{document.body.classList.add('shazKeyboardOpen');syncDrawerVisualViewport();setTimeout(()=>focusDrawerField(el),120);setTimeout(()=>focusDrawerField(el),320)},{passive:true});
    el.addEventListener('blur',()=>setTimeout(()=>{
      if(!drawer.querySelector('input:focus,textarea:focus,select:focus')){document.body.classList.remove('shazKeyboardOpen');syncDrawerVisualViewport()}
    },120),{passive:true});
  });
}
function addressStep(forceManual=false){
  if(currentAccountUser&&currentAccountAddresses.length&&!forceManual)return showSavedAddressCheckout();
  checkoutState.payment=$('#pay')?.value||checkoutState.payment||'cod';
  if(currentAccountUser&&!checkoutState.manualAddressFromSaved){
    const memberPrefill=memberCheckoutPrefill();
    if(!checkoutState.customer)checkoutState.customer=memberPrefill;
    else if(currentAccountAddresses.length===1)checkoutState.customer={...checkoutState.customer,...memberPrefill,extraPhone:checkoutState.customer.extraPhone||'',note:checkoutState.customer.note||''};
  }
  const c=checkoutState.customer||{};
  const branch=c.deliveryMode==='branch';
  openDrawer(`<div class="checkoutShell checkoutShell--address">
    <div class="checkoutStickyTop addressStickyTop">
      <div class="checkoutTop"><div><span class="checkoutEyebrow">TESLİMAT BİLGİLERİ</span><h2>Siparişinizi nereye gönderelim?</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
      <div class="checkoutBackRow"><button type="button" class="checkoutBackBtn" onclick="checkoutAddressBack()">← Geri</button><small>* zorunlu alan</small></div>
      <div class="checkoutSteps"><span>1 Sepet</span><span class="active">2 Teslimat</span><span>3 Onay</span></div>
    </div>
    <div class="checkoutScrollBody addressScrollBody">
      <div class="addressCompact addressCompactV114">
        <div class="field fieldWide">${addrInputInner('Ad Soyad *','fullName',c.fullName,'text','Adınızı ve soyadınızı yazın')}</div>
        <div class="addressPair phonePair fieldWide">
          <div class="field"><label><b>Telefon *</b><small class="fieldHelp phoneHelp">05xx xxx xx xx veya<br>5xx xxx xx xx</small></label><input class=formControl id=addr-phone type=tel inputmode=numeric autocomplete=tel value="${escapeAttr(c.phone||'')}" placeholder="05xx xxx xx xx" ${currentAccountUser&&checkoutState.manualAddressFromSaved?`data-address-suggest="phone" onfocus="openSavedAddressSuggestions(this,'phone')" oninput="closeSavedAddressSuggestions()"`:''}></div>
          <div class="field"><label><b>2. Telefon Numarası *</b><small class="fieldHelp">Size ulaşamamamız halinde kullanabileceğimiz ikinci numara zorunludur.</small></label><input class=formControl id=addr-extraPhone type=tel inputmode=numeric autocomplete=tel value="${escapeAttr(c.extraPhone||'')}" placeholder="05xx xxx xx xx" ${currentAccountUser&&checkoutState.manualAddressFromSaved?`data-address-suggest="extraPhone" onfocus="openSavedAddressSuggestions(this,'extraPhone')" oninput="closeSavedAddressSuggestions()"`:''}></div>
        </div>
        <label class="branchChoice fieldWide"><input id="addr-branchToggle" type="checkbox" ${branch?'checked':''} onchange="toggleBranchDelivery()"><span><b>Kargom Aras Kargo şubesine gelsin</b><small>Adrese değil, seçtiğiniz Aras Kargo şubesinden teslim alırsınız.</small></span></label>
        <div class="addressPair fieldWide">
          <div class="field">${addrInputInner('İl *','province',c.province,'text','Örn: İstanbul')}</div>
          <div class="field">${addrInputInner('İlçe *','district',c.district,'text','Örn: Kadıköy')}</div>
        </div>
        <div id="homeAddressFields" class="addressModeFields fieldWide addressModeFieldsV114" style="${branch?'display:none':''}">
          <div class="addressTriple">
            <div class="field">${addrInputInner('Mahalle *','neighborhood',stripAddressSuffix(c.neighborhood,'neighborhood'),'text','Örn: Atatürk')}</div>
            <div class="field">${addrInputInner('Cadde','avenue',stripAddressSuffix(c.avenue,'avenue'),'text','Örn: Bağdat')}</div>
            <div class="field">${addrInputInner('Sokak','street',stripAddressSuffix(c.street,'street'),'text','Örn: Reşat')}</div>
          </div>
          <div class="field fieldWide"><label><b>Adres devamı *</b><small class="fieldHelp">Bina no, kat, daire ve gerekiyorsa site/apartman adını yazın.</small></label><textarea class=formControl id=addr-fullAddress rows=2 placeholder="Örn: No:12 Kat:2 Daire:5" ${currentAccountUser&&checkoutState.manualAddressFromSaved?`data-address-suggest="fullAddress" onfocus="openSavedAddressSuggestions(this,'fullAddress')" oninput="closeSavedAddressSuggestions()"`:''}>${escapeHtml(c.fullAddress||'')}</textarea></div>
        </div>
        <div id="branchAddressFields" class="addressModeFields fieldWide" style="${branch?'':'display:none'}">
          <div class="branchInfo">📍 <b>Aras Kargo şube adını net yazın.</b><br>Google Haritalar'dan kontrol edip şubenin tam adını girin.</div>
          <div class="field fieldWide"><label><b>Aras Kargo şube adı *</b></label><input class=formControl id=addr-branchName value="${escapeAttr(c.branchName||'')}" placeholder="Örn: Aras Kargo Kadıköy Şubesi"></div>
        </div>
        <div class="field fieldWide checkoutPaymentField"><label><b>Ödeme yöntemi *</b></label>${(()=>{const cod=settings.paymentMethods?.cod!==false,online=settings.paymentMethods?.online!==false;const available=[...(cod?['cod']:[]),...(online?['online']:[])];if(!available.includes(checkoutState.payment))checkoutState.payment=available[0]||'';if(!available.length)return '<div class="formControl paymentUnavailable">Şu anda aktif ödeme yöntemi bulunmuyor.</div>';return `<select id="pay" class="formControl">${cod?`<option value="cod" ${checkoutState.payment==='cod'?'selected':''}>Kapıda ödeme</option>`:''}${online?`<option value="online" ${checkoutState.payment==='online'?'selected':''}>Online ödeme</option>`:''}</select>`})()}</div>
        <div class="field fieldWide"><label><b>Teslimat notu</b><small class="fieldHelp">İsteğe bağlı</small></label><textarea class=formControl id=addr-note rows=2 placeholder="Teslimat notu">${escapeHtml(c.note||'')}</textarea></div>
      </div>
    </div>
    <div class="checkoutStickyBottom addressStickyBottom"><button class="btn checkoutPrimary" onclick="saveAddressAndContinue()">Bilgilerimi Kontrol Et →</button></div>
  </div>`);
}
function savedAddressDisplay(a){return [normalizeAddressDisplayPart(a.neighborhood,'neighborhood'),normalizeAddressDisplayPart(a.avenue,'avenue'),normalizeAddressDisplayPart(a.street,'street'),a.fullAddress,a.district,a.province].filter(Boolean).join(' · ')}
function showSavedAddressCheckout(){
  checkoutState.payment=checkoutState.payment||'cod';checkoutState.manualAddressFromSaved=false;
  const preferred=checkoutState.selectedAddressId||currentAccountAddresses.find(a=>a.isDefault)?.id||currentAccountAddresses[0]?.id||'';checkoutState.selectedAddressId=preferred;
  const c=checkoutState.customer||{},preferredAddress=currentAccountAddresses.find(a=>a.id===preferred)||{};
  const preferredExtra=displayAccountPhone(preferredAddress.extraPhone||'');
  const cards=currentAccountAddresses.map(a=>`<label class="savedCheckoutAddress ${a.id===preferred?'is-selected':''}" data-extra-phone="${escapeAttr(displayAccountPhone(a.extraPhone||''))}"><input type="radio" name="savedCheckoutAddress" value="${escapeAttr(a.id)}" ${a.id===preferred?'checked':''} onchange="selectSavedCheckoutAddress('${escapeAttr(a.id)}')"><div class="savedCheckoutAddressHead"><b>${escapeHtml(a.title||'Adres')}</b>${a.isDefault?'<span>Varsayılan Adres</span>':''}</div><strong>${escapeHtml(a.fullName||[currentAccountUser.firstName,currentAccountUser.lastName].filter(Boolean).join(' '))}</strong><small class="savedPhoneLine"><b>${escapeHtml(displayAccountPhone(a.phone||currentAccountUser.phone||''))}</b><span>SMS ve bilgilendirmelerin geleceği numara</span></small>${a.extraPhone?`<small class="savedPhoneLine"><b>${escapeHtml(displayAccountPhone(a.extraPhone))}</b><span>SMS gönderilmez · Yedek numara</span></small>`:''}<p>${escapeHtml(savedAddressDisplay(a))}</p></label>`).join('');
  openDrawer(`<div class="checkoutShell checkoutShell--address savedAddressCheckout"><div class="checkoutStickyTop addressStickyTop"><div class="checkoutTop"><div><span class="checkoutEyebrow">TESLİMAT BİLGİLERİ</span><h2>Kayıtlı adresinizden birini seçin</h2></div><button class="pill" onclick="closeDrawer()">Kapat</button></div><div class="checkoutBackRow"><button type="button" class="checkoutBackBtn" onclick="checkout()">← Sepete dön</button></div><div class="checkoutSteps"><span>1 Sepet</span><span class="active">2 Teslimat</span><span>3 Onay</span></div></div><div class="checkoutScrollBody addressScrollBody"><div class="savedCheckoutAddressList">${cards}</div><button class="savedNewAddressBtn" type="button" onclick="openNewCheckoutAddress()">＋ Yeni Adres</button><div class="savedCheckoutExtras"><div class="field" id="saved-extraPhone-field" style="${preferredExtra?'display:none':''}"><label><b>2. Telefon Numarası *</b><small class="fieldHelp">Size ulaşamazsak kullanabileceğimiz farklı bir numara.</small></label><input class="formControl" id="saved-extraPhone" type="tel" inputmode="numeric" value="${escapeAttr(preferredExtra||displayAccountPhone(c.extraPhone||''))}" placeholder="05xx xxx xx xx"></div><div class="field checkoutPaymentField"><label><b>Ödeme yöntemi *</b></label>${(()=>{const cod=settings.paymentMethods?.cod!==false,online=settings.paymentMethods?.online!==false,available=[...(cod?['cod']:[]),...(online?['online']:[])];if(!available.includes(checkoutState.payment))checkoutState.payment=available[0]||'';return `<select id="saved-pay" class="formControl">${cod?`<option value="cod" ${checkoutState.payment==='cod'?'selected':''}>Kapıda ödeme</option>`:''}${online?`<option value="online" ${checkoutState.payment==='online'?'selected':''}>Online ödeme</option>`:''}</select>`})()}</div><div class="field"><label><b>Teslimat notu</b><small class="fieldHelp">İsteğe bağlı</small></label><textarea class="formControl" id="saved-note" rows="2" placeholder="Teslimat notu">${escapeHtml(c.note||'')}</textarea></div></div></div><div class="checkoutStickyBottom addressStickyBottom"><button class="btn checkoutPrimary" onclick="useSavedAddressAndContinue()">Bilgilerimi Kontrol Et →</button></div></div>`)
}
function openNewCheckoutAddress(){checkoutState.manualAddressFromSaved=true;checkoutState.customer={};addressStep(true)}
function checkoutAddressBack(){if(checkoutState.manualAddressFromSaved&&currentAccountUser&&currentAccountAddresses.length){checkoutState.manualAddressFromSaved=false;showSavedAddressCheckout();return}checkout()}
function selectSavedCheckoutAddress(id){
  checkoutState.selectedAddressId=id;
  const selected=currentAccountAddresses.find(x=>x.id===id)||{},extra=displayAccountPhone(selected.extraPhone||'');
  document.querySelectorAll('.savedCheckoutAddress').forEach(el=>el.classList.toggle('is-selected',el.querySelector('input')?.value===id));
  const field=$('#saved-extraPhone-field'),input=$('#saved-extraPhone');if(field)field.style.display=extra?'none':'';if(input)input.value=extra||''
}
function useSavedAddressAndContinue(){
  const id=document.querySelector('input[name="savedCheckoutAddress"]:checked')?.value||checkoutState.selectedAddressId,a=currentAccountAddresses.find(x=>x.id===id);if(!a)return alert('Lütfen bir teslimat adresi seçin.');
  const primary=normalizeTRMobile(a.phone||currentAccountUser?.phone||''),storedExtra=displayAccountPhone(a.extraPhone||''),extra=normalizeTRMobile(storedExtra||$('#saved-extraPhone')?.value||'');if(!primary.ok)return alert(phoneValidationMessage('Telefon numarası'));if(!extra.ok)return alert('Lütfen geçerli bir 2. telefon numarası girin.');if(primary.value===extra.value)return alert('İki telefon numarası aynı olamaz. Lütfen farklı bir 2. telefon numarası girin.');
  checkoutState.payment=$('#saved-pay')?.value||checkoutState.payment||'cod';checkoutState.selectedAddressId=a.id;
  const customer={savedAddressId:a.id,fullName:a.fullName||[currentAccountUser.firstName,currentAccountUser.lastName].filter(Boolean).join(' '),phone:primary.value,extraPhone:extra.value,email:currentAccountUser.email||'',province:a.province||'',district:a.district||'',deliveryMode:'address',branchName:'',neighborhood:a.neighborhood||'',avenue:a.avenue||'',street:a.street||'',fullAddress:a.fullAddress||'',buildingNo:a.buildingNo||'',floor:a.floor||'',doorNo:a.doorNo||'',placeType:'home',businessName:'',note:($('#saved-note')?.value||'').trim()};
  checkoutState.customer=customer;showAddressConfirmation(customer)
}
function addrInputInner(label,id,value='',type='text',placeholder=''){
  const suggest=currentAccountUser&&checkoutState.manualAddressFromSaved?` data-address-suggest="${escapeAttr(id)}" onfocus="openSavedAddressSuggestions(this,'${escapeAttr(id)}')" oninput="closeSavedAddressSuggestions()"`:'';
  return `<label><b>${label}</b></label><input class=formControl id="addr-${id}" type="${type}" value="${escapeAttr(value||'')}" ${placeholder?`placeholder="${escapeAttr(placeholder)}"`:''}${suggest}>`;
}
function addressSuggestionValues(field){const map={fullName:'fullName',phone:'phone',extraPhone:'extraPhone',province:'province',district:'district',neighborhood:'neighborhood',avenue:'avenue',street:'street',fullAddress:'fullAddress'};const key=map[field]||field;return [...new Set((currentAccountAddresses||[]).map(a=>{let v=a?.[key]||'';if(field==='phone'||field==='extraPhone')v=displayAccountPhone(v);if(['neighborhood','avenue','street'].includes(field))v=stripAddressSuffix(v,field==='neighborhood'?'neighborhood':field==='avenue'?'avenue':'street');return String(v||'').trim()}).filter(Boolean))]}
let activeSavedAddressSuggestionInput=null;
function closeSavedAddressSuggestions(){document.querySelector('.savedAddressSuggestionMenu')?.remove();activeSavedAddressSuggestionInput=null}
function positionSavedAddressSuggestions(box,input){if(!box||!input||!document.body.contains(input)){closeSavedAddressSuggestions();return}const r=input.getBoundingClientRect(),gap=4,viewportH=window.visualViewport?.height||window.innerHeight,viewportTop=window.visualViewport?.offsetTop||0;box.style.width=Math.max(160,r.width)+'px';box.style.left=Math.max(8,Math.min(r.left,window.innerWidth-Math.max(160,r.width)-8))+'px';const bh=Math.min(box.scrollHeight||180,210),spaceBelow=viewportTop+viewportH-r.bottom,top=spaceBelow>=bh+gap?r.bottom+gap:Math.max(viewportTop+8,r.top-bh-gap);box.style.top=top+'px'}
function openSavedAddressSuggestions(input,field){closeSavedAddressSuggestions();if(!input||!checkoutState.manualAddressFromSaved||document.activeElement!==input)return;const values=addressSuggestionValues(field);if(!values.length)return;const box=document.createElement('div');box.className='savedAddressSuggestionMenu';box.innerHTML=values.map(v=>`<button type="button" onpointerdown="event.preventDefault()" data-value="${escapeAttr(v)}">${escapeHtml(v)}</button>`).join('');box.querySelectorAll('button').forEach(b=>b.onclick=()=>{input.value=b.dataset.value||'';closeSavedAddressSuggestions();input.focus({preventScroll:true})});document.body.appendChild(box);activeSavedAddressSuggestionInput=input;positionSavedAddressSuggestions(box,input);requestAnimationFrame(()=>positionSavedAddressSuggestions(box,input))}
if(!window._shazAddressSuggestionBound){window._shazAddressSuggestionBound=true;window.addEventListener('resize',()=>{const b=document.querySelector('.savedAddressSuggestionMenu');if(b&&activeSavedAddressSuggestionInput)positionSavedAddressSuggestions(b,activeSavedAddressSuggestionInput)},{passive:true});window.visualViewport?.addEventListener('resize',()=>{const b=document.querySelector('.savedAddressSuggestionMenu');if(b&&activeSavedAddressSuggestionInput)positionSavedAddressSuggestions(b,activeSavedAddressSuggestionInput)},{passive:true});document.addEventListener('pointerdown',e=>{const b=document.querySelector('.savedAddressSuggestionMenu');if(b&&!b.contains(e.target)&&e.target!==activeSavedAddressSuggestionInput)closeSavedAddressSuggestions()},true)}
function addrInput(label,id,value='',type='text'){return `<div class=field>${addrInputInner(label,id,value,type)}</div>`}
function toggleBranchDelivery(){
  const on=!!$('#addr-branchToggle')?.checked;
  if($('#homeAddressFields')) $('#homeAddressFields').style.display=on?'none':'grid';
  if($('#branchAddressFields')) $('#branchAddressFields').style.display=on?'grid':'none';
}
function saveAddressAndContinue(){
  const availablePayments=[...(settings.paymentMethods?.cod!==false?['cod']:[]),...(settings.paymentMethods?.online!==false?['online']:[])];
  if(!availablePayments.length)return alert('Şu anda kullanılabilir bir ödeme yöntemi bulunmuyor.');
  checkoutState.payment=$('#pay')?.value||availablePayments[0];
  const g=id=>($('#addr-'+id)?.value||'').trim();
  const branch=!!$('#addr-branchToggle')?.checked;
  const fullName=g('fullName').replace(/\s+/g,' ').trim();
  if(!fullName)return alert('Lütfen adınızı ve soyadınızı yazın.');
  if(!fullName.includes(' '))return alert('Lütfen soyadınızı da yazın.');
  const province=canonicalProvince(g('province'));
  if(!province)return alert('İl bilgisi geçerli değil. Lütfen Türkiye’deki 81 ilden birini doğru yazın.');
  const primaryPhone=normalizeTRMobile(g('phone'));
  const extraRaw=g('extraPhone');
  if(!extraRaw)return alert('Lütfen size ulaşamamamız halinde kullanabileceğimiz 2. telefon numarasını da yazın.');
  const extraPhone=normalizeTRMobile(extraRaw);
  if(!primaryPhone.ok)return alert(phoneValidationMessage('Telefon numarası'));
  if(!extraPhone.ok)return alert(phoneValidationMessage('2. telefon numarası'));
  if(extraPhone.value && primaryPhone.value===extraPhone.value)return alert('İki telefon numarası aynı olamaz. Lütfen yedek olarak farklı bir telefon numarası girin.');
  const neighborhood=addressPart(g('neighborhood'),'neighborhood');
  const avenue=addressPart(g('avenue'),'avenue');
  const street=addressPart(g('street'),'street');
  if(!branch&&!avenue&&!street)return alert('Lütfen cadde veya sokak bilgilerinden en az birini giriniz.');
  const customer={
    fullName,phone:primaryPhone.value,extraPhone:extraPhone.value,province,district:g('district'),
    deliveryMode:branch?'branch':'address',branchName:branch?g('branchName'):'',
    neighborhood,avenue,street,fullAddress:g('fullAddress'),
    buildingNo:'',floor:'',doorNo:'',placeType:'home',businessName:'',note:g('note')
  };
  if(!customer.phone||!customer.province||!customer.district)return alert('Lütfen * işaretli zorunlu alanları doldurun.');
  if(branch&&!customer.branchName)return alert('Teslim almak istediğiniz Aras Kargo şubesinin tam adını yazın.');
  if(!branch&&(!g('neighborhood')||!customer.fullAddress))return alert('Mahalle ve adres devamı alanlarını doldurun.');
  checkoutState.customer=customer;
  showAddressConfirmation(customer);
}
function customerAddressText(c){
  if(c.deliveryMode==='branch')return [`${c.province} / ${c.district} — ${c.branchName}`,[c.neighborhood,c.avenue,c.street,c.fullAddress].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
  return [c.neighborhood,c.avenue,c.street,c.fullAddress].filter(Boolean).join(' ') + ` — ${c.district} / ${c.province}`;
}
function checkoutRequestedDetailsHtml(){
  return cart.map(x=>{
    const p=x.product||{},lines=[],qty=Math.max(1,Number(x.qty||1));
    if(x.setCustomization){
      const setItems=Array.isArray(p.setItems)?p.setItems:[];
      const keptIds=x.setCustomization.keptIds||[];
      const removedIds=x.setCustomization.removedIds||[];
      const kept=setItems.filter(it=>keptIds.includes(it.id)).map(it=>it.name).filter(Boolean);
      const removed=setItems.filter(it=>removedIds.includes(it.id)).map(it=>it.name).filter(Boolean);
      if(kept.length)lines.push(`<span><b>Size gelecek:</b> ${kept.map(escapeHtml).join(', ')}</span>`);
      if(removed.length)lines.push(`<span><b>Setten çıkarılan:</b> ${removed.map(escapeHtml).join(', ')}</span>`);
    }
    const writes=x.writes||x.setCustomization?.writes||[];
    writes.forEach(w=>lines.push(`<span><b>${escapeHtml(w.item||p.name||'Ürün')} yazısı:</b> ${escapeHtml(w.text||'')}${w.position?` (${escapeHtml(w.position)})`:''}</span>`));
    const photos=x.photoCustomizations||x.setCustomization?.photoCustomizations||[];
    photos.forEach(ph=>lines.push(`<span><b>${escapeHtml(ph.item||p.name||'Cüzdan')}:</b> Fotoğraf işleme${ph.caption?` · ${ph.captionPosition==='above'?'Üst yazı':'Alt yazı'}: ${escapeHtml(ph.caption)}`:''}</span>`));
    if(String(x.productNote||'').trim())lines.push(`<span class=addressCheckOrderNote><b>Sipariş notu:</b> ${escapeHtml(String(x.productNote).trim())}</span>`);
    return `<div class=addressCheckOrderItem><b>${escapeHtml(p.name||'Ürün')}${qty>1?` × ${qty}`:''}</b>${lines.join('')}</div>`;
  }).join('');
}

function checkoutOrderNoteText(){
  return String(checkoutState.orderNote||'').trim();
}
function openCheckoutOrderNote(){
  document.querySelector('.productNoteOverlay')?.remove();
  const el=document.createElement('div');el.className='productNoteOverlay';
  el.innerHTML=`<div class="productNotePaper"><button class="productNoteClose" type="button" onclick="this.closest('.productNoteOverlay').remove()">×</button><div class="productNoteLabel">SİPARİŞ NOTU</div><h3>Notunuzu yazın</h3><textarea id="checkoutOrderNoteText" maxlength="500" placeholder="Siparişiniz için notunuzu buraya yazın...">${escapeHtml(checkoutOrderNoteText())}</textarea><button class="btn productNoteSave" type="button" onclick="saveCheckoutOrderNote()">Notu Kaydet</button></div>`;
  document.body.appendChild(el);
  setTimeout(()=>document.getElementById('checkoutOrderNoteText')?.focus(),30);
}
function saveCheckoutOrderNote(){
  checkoutState.orderNote=(document.getElementById('checkoutOrderNoteText')?.value||'').trim();
  document.querySelector('.productNoteOverlay')?.remove();
  if(checkoutState.customer)showAddressConfirmation(checkoutState.customer);
  toast(checkoutState.orderNote?'✓ Sipariş notu kaydedildi':'Sipariş notu kaldırıldı');
}

function showAddressConfirmation(c){
  closeSavedAddressSuggestions();
  document.querySelector('.addressCheckModal')?.remove();
  const el=document.createElement('div');el.className='addressCheckModal';
  const orderNote=checkoutOrderNoteText();
  el.innerHTML=`<div class="addressCheckCard"><button class="addressCheckX" onclick="this.closest('.addressCheckModal').remove()">×</button><span class="checkoutEyebrow">ADRES KONTROLÜ</span><h3>Bilgilerinizi kontrol edin</h3><p class="addressCheckHint">Adres bilgileriniz eksik veya hatalıysa kargonuz teslim edilemeden geri dönebilir.</p><div class="addressCheckData"><b>${escapeHtml(c.fullName)}</b><span>${escapeHtml(c.phone)}${c.extraPhone?` · 2. tel: ${escapeHtml(c.extraPhone)}`:''}</span><strong>${c.deliveryMode==='branch'?'📦 Şubeden teslim':'📍 Adrese teslim'}</strong><span>${escapeHtml(customerAddressText(c))}</span>${c.deliveryMode==='branch'?'<small>Şube adını Google Haritalar’dan kontrol ettiğinizden emin olun.</small>':''}${String(c.note||'').trim()?`<span><b>Teslimat notu:</b> ${escapeHtml(String(c.note).trim())}</span>`:''}</div><div class="addressCheckOrderReview"><strong>Siparişiniz için seçtikleriniz</strong>${checkoutRequestedDetailsHtml()}</div><div class="addressCheckNoteArea">${orderNote?`<div class="addressCheckOrderNotePreview"><b>Sipariş notu</b><span>${escapeHtml(orderNote)}</span></div>`:''}<button type="button" class="productNoteTrigger addressCheckNoteTrigger" onclick="openCheckoutOrderNote()">＋ ${orderNote?'Sipariş notunu düzenle':'Siparişime not eklemek istiyorum'}</button></div><div class="addressCheckActions"><button class="pill" onclick="this.closest('.addressCheckModal').remove()">Düzenle</button><button class="btn" onclick="confirmAddressAndContinue()">Bilgiler doğru, devam et →</button></div></div>`;
  document.body.appendChild(el);
}
function confirmAddressAndContinue(){document.querySelector('.addressCheckModal')?.remove();continueAfterAddress();}
let checkoutLegalAcceptances={preInformation:false,distanceSales:false,personalization:false,personalizationNotice:false};
let publicLegalDocuments=[];
async function loadPublicLegalDocuments(){
  try{const r=await fetch('/api/legal-documents').then(x=>x.json());publicLegalDocuments=Array.isArray(r.documents)?r.documents:[]}catch(_){publicLegalDocuments=[]}
  return publicLegalDocuments;
}
function legalDocument(type){return publicLegalDocuments.find(d=>d.type===type&&d.active!==false)||null}
function openLegalDocument(type){
  const doc=legalDocument(type);document.querySelector('.legalDocOverlay')?.remove();
  const el=document.createElement('div');el.className='legalDocOverlay';
  el.innerHTML=`<div class="legalDocCard"><div class="legalDocHead"><b>${escapeHtml(doc?.title||'Hukuki Metin')}</b><button class="pill" onclick="this.closest('.legalDocOverlay').remove()">Kapat</button></div><div class="legalDocBody">${String(doc?.content||'').trim()?escapeHtml(doc.content):'<div class="legalMissing">Bu metin şu anda görüntülenemiyor.</div>'}</div></div>`;
  el.addEventListener('click',e=>{if(e.target===el)el.remove()});document.body.appendChild(el);
}
async function continueAfterAddress(){await showOrderApproval()}
function cartNeedsPersonalizationApproval(){return cart.some(x=>!!x?.personalized||(x?.writes||[]).some(w=>String(w?.text||'').trim())||(x?.photoCustomizations||[]).length||(x?.setCustomization?.writes||[]).some(w=>String(w?.text||'').trim())||(x?.setCustomization?.photoCustomizations||[]).length)}
async function showOrderApproval(){
  await loadPublicLegalDocuments();const hasPersonal=cartNeedsPersonalizationApproval();
  checkoutLegalAcceptances={preInformation:false,distanceSales:false,personalization:!hasPersonal,personalizationNotice:!hasPersonal};
  const details=checkoutRequestedDetailsHtml();
  openDrawer(`<div class="checkoutShell"><div class="checkoutTop"><div><span class="checkoutEyebrow">SİPARİŞ ONAYI</span><h2>Sipariş ve Sözleşme Onayı</h2><p>Siparişinizi oluşturmadan önce sözleşmeleri ve sipariş bilgilerinizi kontrol edin.</p></div></div><div class="checkoutBackRow"><button type="button" class="checkoutBackBtn" onclick="addressStep()">← Teslimata dön</button></div><div class="checkoutSteps"><span>1 Sepet</span><span>2 Teslimat</span><span class="active">3 Onay</span></div><div id="approvalError" class="approvalError hidden">Lütfen kırmızı işaretli zorunlu onayları tamamlayın.</div><div class="orderApprovalChecks"><div class="wizardCard orderApprovalProductInfo"><h3>Ürün ve Kişiselleştirme Bilgileri</h3>${details}</div><label class="orderApprovalCheck" data-approval-key="preInformation"><input id="approvePre" type="checkbox" onchange="checkoutLegalAcceptances.preInformation=this.checked;updateOrderApprovalState()"><span><button type="button" class="legalOpenBtn" onclick="event.preventDefault();openLegalDocument('PRE_INFORMATION')">Ön Bilgilendirme Formu</button>'nu okudum ve bilgilendirildim.</span></label><label class="orderApprovalCheck" data-approval-key="distanceSales"><input id="approveDistance" type="checkbox" onchange="checkoutLegalAcceptances.distanceSales=this.checked;updateOrderApprovalState()"><span><button type="button" class="legalOpenBtn" onclick="event.preventDefault();openLegalDocument('DISTANCE_SALES')">Mesafeli Satış Sözleşmesi</button>'ni okudum ve kabul ediyorum.</span></label>${hasPersonal?`<label class="orderApprovalCheck" data-approval-key="personalization"><input id="approvePersonal" type="checkbox" onchange="checkoutLegalAcceptances.personalization=this.checked;updateOrderApprovalState()"><span>Kişiselleştirme bilgilerimi kontrol ettim, verdiğim bilgilerin doğru olduğunu onaylıyorum ve ürünün talebim doğrultusunda kişiye özel hazırlanacağını biliyorum.</span></label><label class="orderApprovalCheck" data-approval-key="personalizationNotice"><input id="approvePersonalNotice" type="checkbox" onchange="checkoutLegalAcceptances.personalizationNotice=this.checked;updateOrderApprovalState()"><span>Kişiye özel ürünlerde genel cayma hakkı istisnası hakkında bilgilendirildim.</span></label><div class="personalLegalNotice">İsim, yazı, tarih, fotoğraf, logo, renk, ölçü veya benzeri kişisel talebe göre özel hazırlanan ürünlerde genel cayma hakkı istisnası uygulanabilir. Ancak ürün yanlış hazırlanmış, kırık/bozuk, ayıplı veya siparişe uygun değilse tüketicinin kanuni hakları devam eder.</div>`:''}</div><button id="approvalContinueBtn" class="btn checkoutPrimary approvalContinueBtn is-incomplete" onclick="approveOrderAndContinue()">Onayla, kargo bilgilendirmesine geç →</button></div>`);requestAnimationFrame(updateOrderApprovalState)
}
function requiredOrderApprovalKeys(){return cartNeedsPersonalizationApproval()?['preInformation','distanceSales','personalization','personalizationNotice']:['preInformation','distanceSales']}
function updateOrderApprovalState(){const required=requiredOrderApprovalKeys(),complete=required.every(k=>!!checkoutLegalAcceptances[k]),btn=$('#approvalContinueBtn');if(btn){btn.classList.toggle('is-incomplete',!complete);btn.classList.toggle('is-complete',complete);btn.setAttribute('aria-disabled',complete?'false':'true')}document.querySelectorAll('.orderApprovalCheck').forEach(el=>{const key=el.dataset.approvalKey;el.classList.toggle('approvalMissing',el.classList.contains('approvalTouched')&&required.includes(key)&&!checkoutLegalAcceptances[key])});if(complete)$('#approvalError')?.classList.add('hidden')}
function approveOrderAndContinue(){
  const required=requiredOrderApprovalKeys(),missing=required.filter(k=>!checkoutLegalAcceptances[k]);
  if(missing.length){const err=$('#approvalError');if(err)err.classList.remove('hidden');document.querySelectorAll('.orderApprovalCheck').forEach(el=>{const key=el.dataset.approvalKey;if(missing.includes(key)){el.classList.add('approvalTouched','approvalMissing')}else el.classList.remove('approvalMissing')});updateOrderApprovalState();return}
  shippingNotice(cartNeedsPersonalizationApproval());
}
function shippingNotice(personalApproved=false){
  openDrawer(`<div class="checkoutShell"><div class="checkoutTop"><div><span class="checkoutEyebrow">SON ADIM</span><h2>Kargo bilgilendirmesi</h2><p>Siparişinizi oluşturmadan önce kısa bilgilendirmeyi okuyun.</p></div></div><div class="checkoutBackRow"><button type="button" class="checkoutBackBtn" onclick="showOrderApproval()">← Sipariş onayına dön</button></div><div class="checkoutSteps"><span>1 Sepet</span><span>2 Teslimat</span><span class="active">3 Onay</span></div><div class=notice>${settings.shippingNotice}</div><button class="btn checkoutPrimary" onclick="finalizeOrder(${personalApproved},this)">Siparişi Oluştur ✓</button><small class="checkoutSubmitStatus" id="checkoutSubmitStatus"></small></div>`);
}

function newOrderRequestId(){
  try{return crypto.randomUUID()}catch{return 'shaz-'+Date.now()+'-'+Math.random().toString(36).slice(2)}
}
async function finalizeOrder(personalApproved,button){
  normalizeCartPersonalizationFees();
  // Çift/çoklu tıklama aynı siparişi birden fazla kez göndermesin.
  if(orderSubmitting)return;
  if(!checkoutState.customer){
    alert('Teslimat bilgileri bulunamadı. Lütfen teslimat adımını kontrol edin.');
    return;
  }
  if(!cart.length){alert('Sepetiniz boş.');return}
  if(!checkoutState.requestId)checkoutState.requestId=newOrderRequestId();
  const campaign=calculateCartCampaigns();
  const couponPricing=couponCartResult(campaign.total);
  checkoutState.appliedCouponIds=couponPricing.coupons.map(c=>c.id);
  const order={
    requestId:checkoutState.requestId,
    items:cart,
    customer:checkoutState.customer,
    payment:checkoutState.payment,
    orderNote:checkoutOrderNoteText(),
    personalApproval:personalApproved?{approved:true,method:'button',at:new Date().toISOString()}:null,
    shippingNoticeAccepted:true,
    legalAcceptances:{...checkoutLegalAcceptances},
    userId:currentAccountUser?.id||null,
    customerId:currentAccountUser?.customerId||null,
    subtotal:campaign.subtotal,
    discountTotal:campaign.discount,
    appliedCampaigns:(campaign.applied||[]).map(a=>({id:a.id||'',name:a.name||'Kampanya',discount:Number(a.discount||0),uses:Number(a.uses||1)})),
    preCouponTotal:campaign.total,
    appliedCouponIds:couponPricing.coupons.map(c=>c.id),
    couponDiscountTotal:couponPricing.discount,
    total:couponPricing.total
  };
  const orderPayload=JSON.stringify(order,(key,value)=>typeof value==='bigint'?value.toString():value);
  // Ağ/önbellek kaynaklı geçici bir sorunda sipariş taslağı müşterinin cihazında da korunsun.
  try{localStorage.setItem('shaz_pending_order_v63',orderPayload)}catch{}
  const btn=button||document.querySelector('.checkoutPrimary');
  const status=document.querySelector('#checkoutSubmitStatus');
  const oldText=btn?.textContent||'Siparişi Oluştur ✓';
  orderSubmitting=true;
  if(btn){btn.disabled=true;btn.textContent='Siparişiniz oluşturuluyor…'}
  if(status)status.textContent='Lütfen bekleyin, siparişiniz kaydediliyor.';
  try{
    const response=await fetch('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:orderPayload});
    let r={};
    try{r=await response.json()}catch{}
    if(!response.ok||!r.ok||!r.order?.id)throw new Error(r.message||'Sipariş oluşturulamadı. Lütfen tekrar deneyin.');
    cart=[];
    checkoutState={payment:'cod',customer:null,requestId:null,orderNote:'',appliedCouponIds:[]};
    updateCart();
    try{localStorage.removeItem('shaz_pending_order_v63')}catch{}
    if(currentAccountUser){
      Promise.all([apiJson('/api/account/addresses'),apiJson('/api/account/coupons')]).then(([a,c])=>{
        currentAccountAddresses=Array.isArray(a.addresses)?a.addresses:[];
        currentAccountCoupons=Array.isArray(c.coupons)?c.coupons:[];
        updateCouponNotificationBadges();
      }).catch(()=>{});
    }
    success(r.order.id);
  }catch(err){
    console.error('Sipariş oluşturma hatası:',err);
    // Adres/sepet kesinlikle sıfırlanmaz. Aynı requestId korunur; tekrar denendiğinde
    // sunucu/Google E-Tablo daha önce kaydetmişse ikinci sipariş üretmeden mevcut siparişi döndürür.
    orderSubmitting=false;
    if(btn){btn.disabled=false;btn.textContent='Tekrar Dene ↻'}
    if(status){
      status.innerHTML='<b>Sipariş henüz kaydedilemedi.</b><br>Bilgileriniz duruyor. Bağlantıyı kontrol edip <b>Tekrar Dene</b> butonuna basın.';
      status.classList.add('submitError');
    }
    return;
  }finally{
    orderSubmitting=false;
  }
}
function success(id){
  openDrawer(`<div class="success successCentered"><div class=check>✅</div><h2>${settings.successTitle}</h2><p>${settings.successMessage}</p><p class=successTagline>𝓟𝓻𝓮𝓼𝓽𝓲𝓳𝓲𝓷 𝓖𝓮𝓻ç𝓮𝓴 𝓢𝓪𝓱𝓲𝓹𝓵𝓮𝓻𝓲𝓷𝓮.</p><p class=successOrderNo>Sipariş No: <b>${id}</b></p><div class=actions><a class="contactBtn wa" href="https://wa.me/${settings.whatsapp}" target="_blank" rel="noopener"><span class="contactIcon brandIcon waIcon" aria-hidden="true"><svg viewBox="0 0 24 24" role="img"><path fill="currentColor" d="M12 2a9.5 9.5 0 0 0-8.21 14.27L2.5 21.5l5.38-1.25A9.5 9.5 0 1 0 12 2Zm0 17.2a7.7 7.7 0 0 1-3.92-1.07l-.28-.17-3.19.74.77-3.1-.18-.29A7.7 7.7 0 1 1 12 19.2Zm4.23-5.76c-.23-.12-1.37-.68-1.58-.76-.21-.08-.36-.12-.52.12-.15.23-.6.76-.74.92-.14.15-.27.17-.5.06-.23-.12-.98-.36-1.86-1.15-.69-.61-1.15-1.36-1.29-1.59-.13-.23-.01-.35.1-.46.1-.1.23-.27.35-.4.12-.14.15-.23.23-.39.08-.15.04-.29-.02-.4-.06-.12-.52-1.25-.71-1.71-.19-.45-.38-.39-.52-.4h-.44c-.15 0-.4.06-.61.29-.21.23-.8.78-.8 1.9 0 1.11.82 2.19.93 2.34.12.15 1.6 2.44 3.88 3.42.54.23.96.37 1.29.48.54.17 1.04.15 1.43.09.44-.07 1.37-.56 1.56-1.1.19-.54.19-1 .13-1.1-.06-.1-.21-.15-.44-.27Z"/></svg></span><span><b>Aklınıza takılan bir şey mi var?</b><small>Buraya tıkla ve iletişime geç</small></span></a><a class="contactBtn ig" href="https://ig.me/m/${String(settings.instagram||'').replace(/^@/,'')}" target="_blank" rel="noopener"><span class="contactIcon brandIcon igIcon" aria-hidden="true"><svg viewBox="0 0 24 24" role="img"><rect x="3.2" y="3.2" width="17.6" height="17.6" rx="5.2" ry="5.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.1" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.4" cy="6.9" r="1.2" fill="currentColor"/></svg></span><span><b>Aklınıza takılan bir şey mi var?</b><small>Buraya tıkla ve iletişime geç</small></span></a></div><button type="button" class="btn successHomeBtn" onclick="closeDrawer();window.scrollTo({top:0,left:0,behavior:'auto'})">Web Sitesine Dön</button></div>`);
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
  const eligible=catalog.products.filter(p=>
    !p.hidden &&
    !p.isSet &&
    p.category!=='setler' &&
    p.category===categoryId &&
    p.setEligible!==false
  );
  const configured=catalog.builder?.allowedProducts?.[categoryId];
  return Array.isArray(configured)?eligible.filter(p=>configured.includes(p.id)):eligible;
}
function builderBackFromCategory(){
  if(!customBuilder||customBuilder.index<=0){closeDrawer();return;}
  customBuilder.index--;renderBuilderCategoryStep();
}
function builderBackToLastCategory(){
  if(!customBuilder){closeDrawer();return;}
  customBuilder.index=Math.max(0,customBuilder.categories.length-1);renderBuilderCategoryStep();
}
function builderBackFromPhotoDetails(){
  if((customBuilder?.personalizationPlan||[]).some(x=>x.mode==='write'))builderWriteDetails(true);
  else builderWriteSelection();
}
function builderBackFromFinalSummary(){
  const plan=customBuilder?.personalizationPlan||[];
  if(plan.some(x=>x.mode==='photo'))return builderWalletPhotoDetails();
  if(plan.some(x=>x.mode==='write'))return builderWriteDetails(true);
  builderAskWrite();
}

function openBuilder(){
  if(catalog.builder?.enabled===false){
    return openDrawer(`<div class=builderUnavailableShell><div class=wizardHead><button class="pill backPill" onclick=closeDrawer()>← Geri</button><div><div class=wizardProgress>ÇOK YAKINDA</div><h2>Kendi Setini Oluştur</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div><div class=builderUnavailableCard><h3>Kendi setinizi dilediğiniz gibi oluşturabileceksiniz.</h3><p>Çok yakında burası hizmetinizde olacak. Anlayışınız için teşekkür eder, keyifli alışverişler dileriz. ☺️</p><button type=button class=btn onclick=closeDrawer()>Alışverişe Devam Et</button></div></div>`);
  }
  const cats=getBuilderCategories();
  if(!cats.length){
    return openDrawer(`<div class=wizardHead><button class="pill backPill" onclick=closeDrawer()>← Geri</button><h2>Kendi Setini Oluştur</h2><button class=pill onclick=closeDrawer()>Kapat</button></div><div class=builderEmptyCategory>Şu anda set oluşturma için açık kategori bulunmuyor.</div>`);
  }
  customBuilder={categories:cats,index:0,selections:{},writes:[],photoCustomizations:[],personalizationPlan:[]};
  renderBuilderCategoryStep();
}
function renderBuilderCategoryStep(){
  const cat=customBuilder.categories[customBuilder.index];
  const products=getBuilderProducts(cat.id);
  const total=customBuilder.categories.length;
  const selectedId=customBuilder.selections[cat.id]||null;
  const progress=((customBuilder.index+1)/total)*100;
  const chosenCount=Object.values(customBuilder.selections).filter(Boolean).length;

  openDrawer(`<div class=builderScreen><div class=builderStickyStack><div class=builderTopSticky><div class=wizardHead><button class="pill backPill" onclick=builderBackFromCategory()>← Geri</button><div><div class=wizardProgress>Kendi Setini Oluştur</div><h2>${escapeHtml(cat.name)}</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
    <div class="builderAllShownBar"><div class="builderAllShown builderAllShownSticky">Tüm ${escapeHtml(cat.name)} gösteriliyor</div></div>
    <div class=builderStepMeta><span class=builderStepName>${customBuilder.index+1}. ADIM / ${total}</span><span class=builderChosen>${chosenCount} ürün seçildi</span></div>
    <div class=builderProgressBar><div class=builderProgressFill style="width:${progress}%"></div></div></div></div>
    <div class=wizardCard builderCategoryCard>
      <h3>${escapeHtml(cat.name)} kategorisinden hangisini setinize eklemek istersiniz?</h3>
      <p class=muted>Bu kategoride yalnızca normal tekli ürünler gösterilir. Hazır setler burada görünmez.</p>
      ${products.length?`<div class=builderProductGrid>${products.map(p=>`
        <div class="builderProductCard ${selectedId===p.id?'selected':''}" onclick="builderChoose('${escapeAttr(cat.id)}','${escapeAttr(p.id)}')">
          <div class=builderProductPhoto>${mainProductImage(p)?`<img src="${escapeAttr(mainProductImage(p))}" alt="${escapeAttr(p.name)}">`:'⌚'}<span class=builderSelectMark></span></div>
          <div class=builderProductBody><b>${escapeHtml(p.name)}</b><small>${money(p.price)} tekli satış fiyatı</small><button type="button" class="builderInspectBtn" onclick="event.stopPropagation();builderInspectProduct('${escapeAttr(p.id)}')">Ürünü İncele</button></div>
        </div>`).join('')}</div>`:`<div class=builderEmptyCategory>Bu kategoride set oluşturmaya açık tekli ürün bulunmuyor.</div>`}
    </div>
    ${builderPriceDockHtml()}</div>`);
}
function builderChoose(categoryId,productId){
  customBuilder.selections[categoryId]=customBuilder.selections[categoryId]===productId?null:productId;
  renderBuilderCategoryStep();
}
function builderInspectProduct(productId){openProductDetail(productId,'builder')}
function builderReturnFromDetail(){renderBuilderCategoryStep()}
function builderSkipCurrent(){
  customBuilder.selections[customBuilder.categories[customBuilder.index].id]=null;
  builderNext();
}
function builderPrev(){if(customBuilder.index>0){customBuilder.index--;renderBuilderCategoryStep()}}
function builderNext(){
  if(customBuilder.index<customBuilder.categories.length-1){customBuilder.index++;renderBuilderCategoryStep();return}
  if(getBuilderSelectedProducts().length<2){alert('Kendi setinizi oluşturmak için en az 2 ürün seçmelisiniz.');return}
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
function builderPriceForProduct(product,count){
  const map=catalog.builder?.productPricing?.[product?.id];
  const key=String(count);
  if(map&&Object.prototype.hasOwnProperty.call(map,key)){
    const value=Number(map[key]);
    return Number.isFinite(value)&&value>=0?value:null;
  }
  const single=Number(product?.price||0);
  return Number.isFinite(single)&&single>=0?single:null;
}
function builderCurrentPricing(){
  const selected=getBuilderSelectedProducts();
  const count=selected.length;
  const retail=selected.reduce((sum,p)=>sum+Number(p?.price||0),0);
  const prices=selected.map(p=>({product:p,price:builderPriceForProduct(p,count)}));
  const complete=count>0&&prices.every(x=>x.price!==null);
  const total=complete?prices.reduce((sum,x)=>sum+Number(x.price||0),0):0;
  return {selected,count,retail,prices,complete,total,savings:complete?Math.max(0,retail-total):0};
}
function builderTotalFor(count){
  const snap=builderCurrentPricing();
  return Number(count)===snap.count&&snap.complete?snap.total:0;
}
function builderPriceDockHtml(){
  const snap=builderCurrentPricing();
  const priceHtml=snap.count?`<div class="builderDockPrice"><div><span>Şu anki setiniz</span><strong>${snap.complete?money(snap.total):'Fiyat tanımlı değil'}</strong></div>${snap.complete?`<small>Ayrı ayrı ${money(snap.retail)}${snap.savings>0?` · <b>${money(snap.savings)} avantaj</b>`:''}<br>Ürün sayısı arttıkça ürünlerin set fiyatı değişebilir.</small>`:`<small>${snap.count} ürün seçildi. Seçili ürünlerden en az biri için bu adet fiyatı tanımlı değil.</small>`}</div>`:`<div class="builderDockPrice"><div><span>Şu anki setiniz</span><strong>0 TL</strong></div><small>Bir ürün seçtiğiniz anda set toplamı burada güncellenir.</small></div>`;
  const hasBack=customBuilder.index>0;
  return `<div class="builderStickyDock">${priceHtml}<div class="builderDockActions ${hasBack?'':'noBack'}">${hasBack?`<button class="builderDockBack" onclick="builderPrev()">← Geri</button>`:''}<button class="builderDockSkip" onclick="builderSkipCurrent()">Bu kategoriden ürün eklemek istemiyorum</button><button class="builderDockNext" onclick="builderNext()">${customBuilder.index===customBuilder.categories.length-1?'Seçimlerimi Gör':'Devam Et →'}</button></div></div>`;
}
function renderBuilderSelectionSummary(){
  const pricing=builderCurrentPricing();
  const selected=pricing.selected;
  const min=2;
  const valid=selected.length>=min;
  const total=pricing.total;

  openDrawer(`<div class=wizardHead><button class="pill backPill" onclick=builderBackToLastCategory()>← Geri</button><div><div class=wizardProgress>Seçim Özeti</div><h2>Setiniz</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
    <div class=wizardCard>
      <h3>Seçtiğiniz ürünler</h3>
      <div class=builderSummaryItems>${selected.length?selected.map(p=>{const setPrice=builderPriceForProduct(p,selected.length);return `
        <div class=builderSummaryItem>
          <div class=builderSummaryThumb>${mainProductImage(p)?`<img src="${escapeAttr(mainProductImage(p))}">`:'⌚'}</div>
          <div class=builderSummaryInfo><b>${escapeHtml(p.name)}</b><small>${escapeHtml((catalog.categories.find(c=>c.id===p.category)||{}).name||p.category)}</small></div>
          ${setPrice!==null?`<div class="builderSummaryPrices"><del>${money(Number(p.price||0))}</del><strong>${money(setPrice)} set fiyatı</strong></div>`:''}
        </div>`}).join(''):'<div class=builderEmptyCategory>Henüz ürün seçmediniz.</div>'}</div>
    </div>
    <div class=wizardCard>
      <div class=summaryLine><span>Seçilen ürün sayısı</span><span>${selected.length}</span></div>
      ${selected.length?`<div class="summaryLine builderRetailTotal"><span>Ayrı ayrı alınsaydı</span><span><del>${money(selected.reduce((sum,p)=>sum+Number(p.price||0),0))}</del></span></div>`:''}
      ${pricing.complete&&selected.reduce((sum,p)=>sum+Number(p.price||0),0)>total?`<div class="summaryLine builderSavingsLine"><span>Set avantajı</span><span>-${money(selected.reduce((sum,p)=>sum+Number(p.price||0),0)-total)}</span></div>`:''}
      <div class="summaryLine summaryTotal"><span>Set toplamı</span><span>${pricing.complete?money(total):'Fiyat tanımlı değil'}</span></div>
    </div>
    ${!valid?`<div class=notice>Kendi setinizi oluşturmak için en az ${min} ürün seçmelisiniz.</div>`:''}
    ${valid&&!pricing.complete?`<div class=notice>${selected.length} ürünlük seçimde en az bir ürünün set fiyatı tanımlanmamış. Yönetim panelinden ürün bazlı fiyatları kontrol edin.</div>`:''}
    <div class=builderNav><button class="btn secondary" onclick=builderEditSelections()>← Seçimleri Düzenle</button><button class=btn ${valid&&pricing.complete?'':'disabled'} onclick="${valid&&pricing.complete?'builderAskWrite()':"alert('Önce en az 2 ürün seçin ve bu adet için tüm seçili ürünlerin set fiyatını tanımlayın.')"}">Devam Et</button></div>`);
}
function builderEditSelections(){customBuilder.index=0;renderBuilderCategoryStep()}

function defaultPositionsForProduct(p){
  if(!writeAvailable(p))return [];
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
  if(!selected.some(p=>writeAvailable(p)||walletPhotoAvailable(p))){customBuilder.writes=[];customBuilder.photoCustomizations=[];return renderBuilderFinalSummary();}
  openDrawer(`<div class=wizardHead><button class="pill backPill" onclick=renderBuilderSelectionSummary()>← Geri</button><div><div class=wizardProgress>Kişiselleştirme</div><h2>Set ürünlerinizi kişiselleştirmek ister misiniz?</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
    <div class=priceInfo><b>Kişiselleştirme ücret sırası:</b><br>İlk ürün +${money(catalog.personalizationPricing?.first||75)} · Sonraki her ürün için +${money(catalog.personalizationPricing?.second||50)}.</div>
    <div class=wizardCard><p>${selected.length} ürünlük setiniz hazır. Cüzdanlarda normal yazı yerine doğrudan fotoğraf işlemeyi de seçebilirsiniz.</p>
    <div class=choiceStack><button class=choiceBtn onclick=builderFinishNoWrite()>Hayır, kişiselleştirme istemiyorum</button><button class="choiceBtn primary" onclick=builderWriteSelection()>Evet, kişiselleştirmek istiyorum</button></div></div>`);
}
function builderFinishNoWrite(){customBuilder.writes=[];customBuilder.photoCustomizations=[];customBuilder.personalizationPlan=[];renderBuilderFinalSummary()}
function builderWriteSelection(){
  const selected=getBuilderSelectedProducts().filter(p=>writeAvailable(p)||walletPhotoAvailable(p));
  const remembered=Object.fromEntries((customBuilder.personalizationPlan||[]).map(x=>[x.productId,x.mode]));
  openDrawer(`<div class=wizardHead><button class="pill backPill" onclick=builderAskWrite()>← Geri</button><div><div class=wizardProgress>Kişiselleştirme Seçimi</div><h2>Hangi işlemleri istiyorsunuz?</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
    <div class=priceInfo>Ücret, kişiselleştirilen ürün sırasına göre otomatik hesaplanır.</div>
    <div class=wizardCard>${selected.map(p=>{
      const wallet=walletPhotoAvailable(p),canWrite=writeAvailable(p),mode=remembered[p.id]||'none';
      if(wallet)return `<div class=setItemToggle data-builder-personalize-row="${escapeAttr(p.id)}"><span><b>${escapeHtml(p.name)}</b></span><div class=choiceStack>
        <label class=positionChoice><input type=radio name="builder-mode-${escapeAttr(p.id)}" value=none ${mode==='none'?'checked':''}> <span>Hayır, birebir bu şekilde istiyorum</span></label>
        ${canWrite?`<label class=positionChoice><input type=radio name="builder-mode-${escapeAttr(p.id)}" value=write ${mode==='write'?'checked':''}> <span>Evet, yazı yazdırmak istiyorum</span></label>`:''}
        <label class=positionChoice><input type=radio name="builder-mode-${escapeAttr(p.id)}" value=photo ${mode==='photo'?'checked':''}> <span>📷 Cüzdana fotoğraf işleme istiyorum</span></label>
      </div></div>`;
      return `<div class=setItemToggle data-builder-personalize-row="${escapeAttr(p.id)}"><span><b>${escapeHtml(p.name)}</b></span><label class=positionChoice><input type=checkbox class=builderWritePick data-id="${escapeAttr(p.id)}" ${mode==='write'?'checked':''}> <span>Yazı yazdırmak istiyorum</span></label></div>`;
    }).join('')}<div id=builderFeePreview></div></div>
    <button class=btn onclick=builderWriteDetails()>Seçtiklerimle Devam Et</button>`);
  document.querySelectorAll('[data-builder-personalize-row] input').forEach(el=>el.addEventListener('change',builderRefreshFeePreview));
  builderRefreshFeePreview();
}
function builderFeeForIndex(i){return i===0?75:50}
function collectBuilderPersonalizationPlan(){
  const plan=[];
  getBuilderSelectedProducts().forEach(p=>{
    let mode='none';
    if(walletPhotoAvailable(p))mode=document.querySelector(`input[name="builder-mode-${CSS.escape(p.id)}"]:checked`)?.value||'none';
    else if(document.querySelector(`.builderWritePick[data-id="${CSS.escape(p.id)}"]`)?.checked)mode='write';
    if(mode!=='none')plan.push({productId:p.id,item:p.name,mode,slotFee:builderFeeForIndex(plan.length)});
  });
  return plan;
}
function builderRefreshFeePreview(){
  const plan=collectBuilderPersonalizationPlan();
  const el=$('#builderFeePreview');if(!el)return;
  el.innerHTML=plan.length?`<div class=remainingList><b>Seçiminiz:</b><br>${plan.map((x,i)=>`${i+1}. ${escapeHtml(x.item)} — ${x.mode==='photo'?'Fotoğraf':'Yazı'} +${money(x.slotFee)}${x.mode==='photo'&&plan.length>1?` + ${money(walletPhotoFee())} fotoğraf işlemesi`:''}`).join('<br>')}</div>`:'';
}
function builderWriteDetails(restoring=false){
  if(!restoring){customBuilder.personalizationPlan=collectBuilderPersonalizationPlan();customBuilder.photoCustomizations=[];}
  const plan=customBuilder.personalizationPlan||[];
  if(!plan.length){customBuilder.writes=[];return renderBuilderFinalSummary();}
  const writePlan=plan.filter(x=>x.mode==='write');
  if(!writePlan.length){customBuilder.writes=[];return builderWalletPhotoDetails();}
  openDrawer(`<div class=wizardHead><button class="pill backPill" onclick=builderWriteSelection()>← Geri</button><div><div class=wizardProgress>Yazı Detayları</div><h2>Yazıları belirleyin</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
    <div class=wizardCard>${writePlan.map(plan=>{
      const p=catalog.products.find(x=>x.id===plan.productId),positions=defaultPositionsForProduct(p);
      return `<div class=builderWriteCard data-product-id="${escapeAttr(p.id)}" data-fee="${Number(plan.slotFee||0)}">
        <div class=builderWriteTop><b>${escapeHtml(p.name)}</b><span>+${money(plan.slotFee)}</span></div>
        <div class=builderWriteDetails><div class=muted>Yazı konumu</div><div class=positionChoices>${positions.map((pos,j)=>positionOptionHtml('builder-pos-'+p.id,pos,j,(customBuilder.writes||[]).find(w=>w.productId===p.id)?.position||p.preferredWritePosition)).join('')}</div><input class=writeInput id="builder-text-${escapeAttr(p.id)}" value="${escapeAttr((customBuilder.writes||[]).find(w=>w.productId===p.id)?.text||'')}" placeholder="${escapeAttr(p.name)} için yazı"></div>
      </div>`;
    }).join('')}</div><button class=btn onclick=builderConfirmWrites()>${plan.some(x=>x.mode==='photo')?'Fotoğraf Detayına Devam Et':'Son Özeti Gör'}</button>`);
}
function builderConfirmWrites(){
  const cards=[...document.querySelectorAll('.builderWriteCard')],writes=[];
  for(const c of cards){
    const id=c.dataset.productId,p=catalog.products.find(x=>x.id===id),text=$('#builder-text-'+id)?.value.trim();
    const pos=document.querySelector(`input[name="builder-pos-${id}"]:checked`)?.value;
    if(!text)return alert((p?.name||'Ürün')+' için yazıyı girin.');
    writes.push({productId:id,item:p?.name||id,position:pos,text,fee:Number(c.dataset.fee||0)});
  }
  customBuilder.writes=writes;
  if((customBuilder.personalizationPlan||[]).some(x=>x.mode==='photo'))builderWalletPhotoDetails();else renderBuilderFinalSummary();
}
function builderWalletProducts(){return getBuilderSelectedProducts().filter(walletPhotoAvailable);}
function builderMaybeWalletPhoto(){renderBuilderFinalSummary()}
function builderWalletPhotoQuestion(){builderWriteSelection()}
function builderWalletPhotoDetails(){
  const plan=(customBuilder.personalizationPlan||[]).filter(x=>x.mode==='photo');
  if(!plan.length)return renderBuilderFinalSummary();
  openDrawer(`<div class=wizardHead><button class="pill backPill" onclick=builderBackFromPhotoDetails()>← Geri</button><div><div class=wizardProgress>Cüzdan Fotoğrafı</div><h2>Fotoğraf detayları</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
    <div class=priceInfo>Cüzdan fotoğrafı kişiselleştirme sırasına dahildir. Başka kişiselleştirilmiş ürün de varsa fotoğraf işlemesi için ayrıca +${money(walletPhotoFee())} uygulanır. Yalnızca cüzdan fotoğrafı seçildiyse toplam kişiselleştirme ücreti ${money(catalog.personalizationPricing?.first||75)} olarak kalır.</div>
    ${plan.map((entry,idx)=>{
      const p=catalog.products.find(x=>x.id===entry.productId),positions=defaultPositionsForProduct(p);
      return `<div class="wizardCard walletPhotoCard"><h3>${escapeHtml(p?.name||entry.item)}</h3><p><b>En sağlıklı sonuç için</b> fotoğrafın çok karanlık, aşırı parlak veya patlamış olmamasına dikkat edin. Net ve kontrastı dengeli fotoğraflar daha iyi sonuç verir. <b>Genelde göz fotoğrafları özellikle iyi sonuç verir.</b></p><input id="builderWalletPhotoFile-${idx}" class=formControl type=file accept="image/*">
      <label class=walletToggle><input id="builderWalletCaptionToggle-${idx}" type=checkbox onchange="document.querySelector('#builderWalletCaptionFields-${idx}').classList.toggle('hidden',!this.checked)"> Fotoğrafın üstüne veya altına yazı da eklemek istiyorum</label><div id="builderWalletCaptionFields-${idx}" class="walletCaptionFields hidden"><input id="builderWalletCaptionText-${idx}" class=writeInput placeholder="Fotoğrafla birlikte işlenecek yazı"><select id="builderWalletCaptionPosition-${idx}" class=formControl><option value=below>Fotoğrafın altında</option><option value=above>Fotoğrafın üstünde</option></select></div>
      ${writeAvailable(p)?`<label class=walletToggle><input id="builderWalletRegularToggle-${idx}" type=checkbox onchange="document.querySelector('#builderWalletRegularFields-${idx}').classList.toggle('hidden',!this.checked)"> Fotoğraftan ayrı olarak cüzdanın ön/iç yüzüne normal yazı da istiyorum</label><div id="builderWalletRegularFields-${idx}" class=hidden><div class=positionChoices>${positions.map((pos,j)=>positionOptionHtml('builder-wallet-pos-'+idx,pos,j,p.preferredWritePosition)).join('')}</div><input id="builderWalletRegularText-${idx}" class=writeInput placeholder="Cüzdanın ön/iç yüzüne yazılacak metin"></div>`:''}
      </div>`;
    }).join('')}<button class=btn onclick=finishBuilderWalletPhoto(this)>Fotoğrafları Yükle ve Son Özeti Gör</button>`);
}
async function finishBuilderWalletPhoto(button){
  const plan=(customBuilder.personalizationPlan||[]).filter(x=>x.mode==='photo');
  if(!plan.length)return renderBuilderFinalSummary();
  const onlyPersonalization=(customBuilder.personalizationPlan||[]).length===1;
  const old=button?.textContent||'';if(button){button.disabled=true;button.textContent='Fotoğraf yükleniyor…'}
  try{
    const photos=[],extraWrites=[];
    for(let idx=0;idx<plan.length;idx++){
      const entry=plan[idx],p=catalog.products.find(x=>x.id===entry.productId),file=$(`#builderWalletPhotoFile-${idx}`)?.files?.[0];
      if(!p||!file)throw new Error((p?.name||'Cüzdan')+' için işlenecek fotoğrafı seçin.');
      const captionOn=$(`#builderWalletCaptionToggle-${idx}`)?.checked,caption=captionOn?($(`#builderWalletCaptionText-${idx}`)?.value.trim()||''):'';
      if(captionOn&&!caption)throw new Error(p.name+' için fotoğraf yazısını girin.');
      const regularOn=writeAvailable(p)&&!!$(`#builderWalletRegularToggle-${idx}`)?.checked,regularText=regularOn?($(`#builderWalletRegularText-${idx}`)?.value.trim()||''):'';
      if(regularOn&&!regularText)throw new Error(p.name+' için normal yazıyı girin.');
      const up=await uploadCustomerPhoto(file);
      let photoFee;
      if(regularOn){
        extraWrites.push({productId:p.id,item:p.name,position:document.querySelector(`input[name="builder-wallet-pos-${idx}"]:checked`)?.value,text:regularText,fee:Number(entry.slotFee||0)});
        photoFee=walletPhotoFee();
      }else{
        photoFee=Number(entry.slotFee||0)+(onlyPersonalization?0:walletPhotoFee());
      }
      photos.push({productId:p.id,item:p.name,imageUrl:up.url,originalName:up.name||file.name,caption,captionPosition:$(`#builderWalletCaptionPosition-${idx}`)?.value||'below',fee:photoFee});
    }
    customBuilder.writes=[...(customBuilder.writes||[]),...extraWrites];
    customBuilder.photoCustomizations=photos;
    renderBuilderFinalSummary();
  }catch(e){alert(e.message||'Fotoğraf yüklenemedi.');if(button){button.disabled=false;button.textContent=old}}
}

function renderBuilderFinalSummary(){
  const pricing=builderCurrentPricing(),selected=pricing.selected;
  const base=pricing.complete?pricing.total:0;
  const writeFee=(customBuilder.writes||[]).reduce((s,w)=>s+Number(w.fee||0),0);
  const photoFee=(customBuilder.photoCustomizations||[]).reduce((s,w)=>s+Number(w.fee||0),0);
  const total=base+writeFee+photoFee;
  openDrawer(`<div class=wizardHead><button class="pill backPill" onclick=builderBackFromFinalSummary()>← Geri</button><div><div class=wizardProgress>Son Kontrol</div><h2>Kendi Setiniz Hazır</h2></div><button class=pill onclick=closeDrawer()>Kapat</button></div>
    <div class=wizardCard><h3>Setin içindekiler</h3><div class=builderSummaryItems>${selected.map(p=>`<div class=builderSummaryItem><div class=builderSummaryThumb>${mainProductImage(p)?`<img src="${escapeAttr(mainProductImage(p))}">`:'⌚'}</div><div class=builderSummaryInfo><b>${escapeHtml(p.name)}</b><small>${escapeHtml((catalog.categories.find(c=>c.id===p.category)||{}).name||'')}</small></div></div>`).join('')}</div></div>
    ${customBuilder.writes?.length?`<div class=wizardCard><h3>Kişiye özel yazılar</h3>${customBuilder.writes.map(w=>`<div class=summaryLine><span><b>${escapeHtml(w.item)}</b><br><span class=muted>${escapeHtml(w.position)}: “${escapeHtml(w.text)}”</span></span><span>+${money(w.fee)}</span></div>`).join('')}</div>`:''}
    ${customBuilder.photoCustomizations?.length?`<div class=wizardCard><h3>Cüzdan fotoğrafı</h3>${customBuilder.photoCustomizations.map(ph=>`<div class=summaryLine><span><b>${escapeHtml(ph.item)}</b>${ph.caption?`<br><span class=muted>${ph.captionPosition==='above'?'Fotoğrafın üstünde':'Fotoğrafın altında'}: “${escapeHtml(ph.caption)}”</span>`:''}</span><span>+${money(ph.fee)}</span></div>`).join('')}</div>`:''}
    <div class=wizardCard>
      <div class=summaryLine><span>${selected.length} ürün özel set</span><span>${money(base)}</span></div>
      ${writeFee?`<div class=summaryLine><span>Yazı işlemleri</span><span>+${money(writeFee)}</span></div>`:''}
      ${photoFee?`<div class=summaryLine><span>Fotoğraf işlemesi</span><span>+${money(photoFee)}</span></div>`:''}
      <div class="summaryLine summaryTotal"><span>Toplam</span><span>${money(total)}</span></div>
    </div>
    <button class=btn onclick=builderAddToCart()>Setimi Sepete Ekle</button>`);
}
function builderAddToCart(){
  const pricing=builderCurrentPricing(),selected=pricing.selected,base=pricing.complete?pricing.total:0,writeFee=(customBuilder.writes||[]).reduce((s,w)=>s+Number(w.fee||0),0),photoFee=(customBuilder.photoCustomizations||[]).reduce((s,w)=>s+Number(w.fee||0),0),total=base+writeFee+photoFee;
  const customProduct={id:'custom-'+Date.now(),name:`Kendi Setim (${selected.length} ürün)`,price:total,isSet:true};
  cart.push({product:customProduct,basePrice:base,qty:1,personalized:(customBuilder.writes||[]).length>0||(customBuilder.photoCustomizations||[]).length>0,builderItems:selected.map(p=>({id:p.id,name:p.name,category:p.category,image:mainProductImage(p)})),writes:customBuilder.writes||[],photoCustomizations:customBuilder.photoCustomizations||[]});
  updateCart();closeDrawer();toast('✓ Kendi setiniz sepete eklendi');
}


// ---------- v153 gerçek müşteri hesabı / üyelik ----------
let currentAccountUser=null;
let currentAccountAddresses=[];
let currentAccountCoupons=[];
let accountStateReady=false,accountStateLoading=null;
let couponNoticeTimer=0;
const COUPON_NOTICE_MS=30*60*1000;
function accountHeaderHintKey(){return 'shazAccountHeaderHint'}
function setAccountHeaderHint(user){try{if(user?.firstName)localStorage.setItem(accountHeaderHintKey(),String(user.firstName));else localStorage.removeItem(accountHeaderHintKey())}catch(_){}}
function applyAccountHeaderHint(){try{const name=localStorage.getItem(accountHeaderHintKey());const t=$('#accountBtnText');if(name&&t)t.textContent=name}catch(_){}}
function displayAccountPhone(v){const d=String(v||'').replace(/\D/g,'');if(/^905\d{9}$/.test(d))return '0'+d.slice(2);if(/^5\d{9}$/.test(d))return '0'+d;if(/^05\d{9}$/.test(d))return d;return String(v||'')}
function normalizeAddressDisplayPart(v,type){const clean=stripAddressSuffix(v,type);return clean?`${clean} ${type==='neighborhood'?'MH.':type==='avenue'?'CD.':'SK.'}`:''}
function memberCheckoutPrefill(){
  const u=currentAccountUser||{},a=currentAccountAddresses.length===1?currentAccountAddresses[0]:(currentAccountAddresses.find(x=>x.isDefault)||currentAccountAddresses[0]||{});
  return {fullName:[u.firstName,u.lastName].filter(Boolean).join(' '),phone:displayAccountPhone(u.phone||''),extraPhone:displayAccountPhone(a.extraPhone||''),email:u.email||'',deliveryMode:'address',province:a.province||'',district:a.district||'',neighborhood:normalizeAddressDisplayPart(a.neighborhood||'','neighborhood'),avenue:normalizeAddressDisplayPart(a.avenue||'','avenue'),street:normalizeAddressDisplayPart(a.street||'','street'),fullAddress:a.fullAddress||'',buildingNo:a.buildingNo||'',floor:a.floor||'',doorNo:a.doorNo||'',note:''};
}
async function apiJson(url,options={}){const r=await fetch(url,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});let j={};try{j=await r.json()}catch{}if(!r.ok||j.ok===false)throw new Error(j.message||'İşlem tamamlanamadı.');return j}
async function loadAccountState(){
  try{
    const r=await apiJson('/api/auth/me');currentAccountUser=r.user||null;
    if(currentAccountUser){
      setAccountHeaderHint(currentAccountUser);
      const [a,f,c]=await Promise.all([apiJson('/api/account/addresses'),apiJson('/api/account/favorites'),apiJson('/api/account/coupons')]);
      currentAccountAddresses=a.addresses||[];
      currentAccountCoupons=Array.isArray(c.coupons)?c.coupons:[];
      const serverFavs=new Set(f.productIds||[]),localFavs=[...favorites];
      for(const id of localFavs)if(!serverFavs.has(id))await apiJson('/api/account/favorites/'+encodeURIComponent(id),{method:'POST'}).catch(()=>{});
      favorites=new Set([...serverFavs,...localFavs]);
      updateCouponNotificationBadges();
      maybeShowCouponAnnouncement();
      ensureCouponNoticeTimer();
    }else{
      currentAccountAddresses=[];currentAccountCoupons=[];favorites.clear();setAccountHeaderHint(null);updateCouponNotificationBadges()
    }
    updateAccountHeader();updateFavoriteBadge();renderProducts($('#search')?.value||'');openAccountRouteIfNeeded();
  }catch(_){currentAccountUser=null;currentAccountAddresses=[];currentAccountCoupons=[];updateAccountHeader();updateCouponNotificationBadges();openAccountRouteIfNeeded();finishAccountRouteBoot()}
  finally{accountStateReady=true}
}
function ensureAccountStateReady(){if(accountStateReady)return Promise.resolve(currentAccountUser);if(accountStateLoading)return accountStateLoading;accountStateLoading=loadAccountState().finally(()=>{accountStateReady=true;accountStateLoading=null});return accountStateLoading}
function updateAccountHeader(){const t=$('#accountBtnText');if(t)t.textContent=currentAccountUser?(currentAccountUser.firstName||'Hesabım'):'Üyelik'}
function isAccountPath(pathname=location.pathname){return pathname==='/giris'||pathname==='/kayit'||pathname==='/sifre-sifirla'||pathname.startsWith('/hesabim')}
function syncAccountRoute(path,mode='push'){if(location.pathname===path)return;history[mode==='replace'?'replaceState':'pushState']({...history.state,shazAccount:true},'',path)}
function leaveAccountArea(){finishAccountRouteBoot();closeAccountPopover();closeDrawer();if(location.pathname!=='/')history.replaceState({...history.state,shazAccount:false},'','/');window.scrollTo({top:0,left:0,behavior:'auto'})}
function accountNeedsCompletion(u){return !!u&&(!String(u.firstName||'').trim()||!String(u.lastName||'').trim()||!String(u.phone||'').trim()||!String(u.birthDate||'').trim())}
function openAccountRouteIfNeeded(){const path=location.pathname;if(path==='/giris')return showLogin(false);if(path==='/kayit')return showRegister(false);if(path==='/sifre-sifirla')return showResetPassword(false);if(!path.startsWith('/hesabim'))return;if(!currentAccountUser)return showLogin(false);if(accountNeedsCompletion(currentAccountUser))return showSocialProfileCompletion(false);if(path==='/hesabim/siparisler')return showAccountOrders(false);if(/^\/hesabim\/siparisler\/[^/]+$/.test(path))return showAccountOrderDetail(decodeURIComponent(path.split('/').pop()),false);if(path==='/hesabim/bilgiler')return showAccountProfile(false);if(path==='/hesabim/adresler')return showAccountAddresses(false);if(path==='/hesabim/favoriler')return showAccountFavorites(false);if(path==='/hesabim/kuponlar')return showAccountCoupons(false);if(path==='/hesabim/sifre')return showChangePassword(false);showAccountHome(false)}
function closeAccountPopover(){document.querySelector('.accountEntryPopover')?.remove()}
function accountLogoUrl(){return settings.logoUrl||'/uploads/shaz-logo-transparent.png'}
function accountBrandPane(){return `<div class="accountBrandPane"><img src="${escapeAttr(accountLogoUrl())}" alt="SHAZ"><div class="accountBrandDivider"></div><div class="accountBrandTagline">Türkiye'nin Erkek Aksesuar Markası</div></div>`}
function accountMobileBar(backAction='leaveAccountArea()'){return `<div class="accountMobileBar"><button type="button" class="accountMobileBack" onclick="${backAction}">←</button><img src="${escapeAttr(accountLogoUrl())}" alt="SHAZ"><button type="button" class="accountMobileClose" onclick="leaveAccountArea()">×</button></div>`}
function accountAuthPage(title,subtitle,body,backAction='leaveAccountArea()'){return `<div class="accountPageShell authAccountPage">${accountBrandPane()}<section class="accountPagePanel">${accountMobileBar(backAction)}<div class="authCenter"><h1>${title}</h1><p class="authLead">${subtitle}</p>${body}</div></section></div>`}
function accountStandardPage(body,backAction='showAccountHome()'){return `<div class="accountPageShell accountStandardPage"><section class="accountPagePanel accountPagePanelSingle">${accountMobileBar(backAction)}<div class="accountCenteredContent">${body}</div></section></div>`}
async function openAccountEntry(){const pop=document.querySelector('.accountEntryPopover');if(pop){pop.remove();return}const drawer=$('#drawer');if(drawer&&!drawer.classList.contains('hidden')&&drawer.classList.contains('drawerAccountMode')){leaveAccountArea();return}if(!accountStateReady)await ensureAccountStateReady();currentAccountUser?showAccountHome():showAuthChoice()}
async function toggleFavoritesEntry(){const pop=document.querySelector('.accountEntryPopover');if(pop)pop.remove();const drawer=$('#drawer');if(drawer&&!drawer.classList.contains('hidden')&&drawer.dataset.view==='favorites-main'){closeDrawer();return}if(!accountStateReady)await ensureAccountStateReady();showFavorites()}
function showAuthChoice(){
  closeAccountPopover();
  const el=document.createElement('div');el.className='accountEntryPopover';
  el.innerHTML=`<button class="accountEntryPrimary" onclick="closeAccountPopover();showLogin()">Giriş Yap</button><button class="accountEntryRow" onclick="closeAccountPopover();showRegister()"><span>${accountMenuIcon('profile')}</span><b>Üye Ol</b></button><a class="accountEntryRow" href="https://ebranch.araskargo.com.tr/" target="_blank" rel="noopener"><span>${accountMenuIcon('orders')}</span><b>Sipariş Takip</b></a>`;
  document.body.appendChild(el);setTimeout(()=>document.addEventListener('pointerdown',accountPopoverOutside,{once:true}),0)
}
function accountPopoverOutside(e){const p=document.querySelector('.accountEntryPopover');if(p&&!p.contains(e.target)&&!e.target.closest('#accountBtn,#favLink'))p.remove()}
function authEyeSvg(visible=false){return visible?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.7"/></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.3A10.9 10.9 0 0 1 12 4c5.5 0 9 5.4 9 8a9.6 9.6 0 0 1-2.1 3.8M6.2 6.2C4.2 7.7 3 10.1 3 12c0 2.6 3.5 8 9 8 1.5 0 2.8-.4 4-1"/></svg>'}
function authPasswordField(id,placeholder,autocomplete,watchMode=''){const watch=watchMode?`;updateAuthSubmitState('${watchMode}')`:'';const coarse=!!window.matchMedia?.('(pointer:coarse)').matches,mode=coarse?'type="text" data-password-mask="css" class="formControl authCssPasswordMask"':'type="password" class="formControl"';return `<div class="authPasswordWrap"><input id="${id}" ${mode} autocomplete="${autocomplete}" placeholder="${placeholder}" oninput="flashPasswordChar(this,event)${watch}"><span class="authLastCharFlash" aria-hidden="true"><span class="authLastCharText"></span><i class="authFlashCaret"></i></span><button type="button" tabindex="-1" class="authEye" onmousedown="event.preventDefault()" onpointerdown="event.preventDefault();document.getElementById('${id}')?.focus({preventScroll:true})" onclick="toggleAuthPassword('${id}',this)" aria-label="Şifreyi göster">${authEyeSvg(false)}</button></div>`}
function toggleAuthPassword(id,btn){const x=document.getElementById(id);if(!x)return;const start=x.selectionStart,end=x.selectionEnd,cssMask=x.dataset.passwordMask==='css',visible=cssMask?!x.classList.contains('is-visible'):x.type==='password';if(cssMask)x.classList.toggle('is-visible',visible);else x.type=visible?'text':'password';btn.classList.toggle('active',visible);btn.innerHTML=authEyeSvg(visible);btn.setAttribute('aria-label',visible?'Şifreyi gizle':'Şifreyi göster');const wrap=x.parentElement,flash=wrap?.querySelector('.authLastCharFlash');if(flash){flash.classList.remove('show');clearTimeout(flash._hideTimer)}wrap?.classList.remove('maskFlashActive');requestAnimationFrame(()=>{try{x.focus({preventScroll:true});if(start!==null&&end!==null)x.setSelectionRange(start,end)}catch(_){}})}
function flashPasswordChar(input,e){if(window.matchMedia?.('(pointer:coarse)').matches)return;const wrap=input?.parentElement,flash=wrap?.querySelector('.authLastCharFlash'),text=flash?.querySelector('.authLastCharText'),masked=input?.dataset?.passwordMask==='css'?!input.classList.contains('is-visible'):input?.type==='password';if(!flash||!text||!masked||!e?.data)return;const ch=String(e.data).slice(-1);if(!ch)return;const len=String(input.value||'').length;text.textContent='•'.repeat(Math.max(0,len-1))+ch;flash.classList.add('show');wrap.classList.add('maskFlashActive');clearTimeout(flash._hideTimer);flash._hideTimer=setTimeout(()=>{flash.classList.remove('show');wrap.classList.remove('maskFlashActive')},420)}
function authInputShield(inner){return `<div class="authInputShield">${inner}</div>`}
function protectAuthInputOverlays(){document.querySelectorAll('.authInputShield').forEach(w=>{const clean=()=>[...w.children].forEach(n=>{if(!(n instanceof HTMLInputElement)&&!n.classList?.contains('authShieldAllowed')){n.style.setProperty('display','none','important');n.setAttribute('aria-hidden','true')}});clean();if(w._shazObserver)w._shazObserver.disconnect();w._shazObserver=new MutationObserver(clean);w._shazObserver.observe(w,{childList:true})})}
function validAccountIdentifier(v){const x=String(v||'').trim();if(!x)return false;if(x.includes('@'))return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);return x.replace(/\D/g,'').length>=10}
function updateAuthSubmitState(mode){let ready=false,btn=null;if(mode==='login'){btn=$('#loginSubmit');ready=validAccountIdentifier($('#loginEmail')?.value)&&String($('#loginPassword')?.value||'').length>0}else if(mode==='register'){btn=$('#registerSubmit');const email=String($('#regEmail')?.value||'').trim(),phone=String($('#regPhone')?.value||'').replace(/\D/g,''),birth=String($('#regBirth')?.value||'').trim();ready=!!String($('#regFirst')?.value||'').trim()&&!!String($('#regLast')?.value||'').trim()&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&phone.length>=10&&String($('#regPass')?.value||'').length>0&&String($('#regPass2')?.value||'').length>0&&birth.length===10}else if(mode==='forgot'){btn=$('#forgotSubmit');ready=validAccountIdentifier($('#forgotIdentifier')?.value)}if(btn){btn.classList.toggle('is-ready',!!ready);btn.setAttribute('aria-disabled',ready?'false':'true')}}
function socialAuthButtons(){return `<div class="authOr"><span></span><b>YA DA</b><span></span></div><div class="socialAuthButtons"><button type="button" class="socialAuthBtn google" onclick="startGoogleLogin(this)" aria-label="Google ile devam et">G</button><button type="button" class="socialAuthBtn apple" onclick="startAppleLogin(this)" aria-label="Apple ile devam et"></button></div>`}
function formatBirthDateInput(el){let d=String(el.value||'').replace(/\D/g,'').slice(0,8);if(d.length>4)d=d.slice(0,2)+'.'+d.slice(2,4)+'.'+d.slice(4);else if(d.length>2)d=d.slice(0,2)+'.'+d.slice(2);el.value=d;clearAuthFieldError(el)}
function clearAuthFieldError(el){if(!el)return;el.classList.remove('authFieldError');el.removeAttribute('aria-invalid')}
function setAuthFieldError(el){if(!el)return;el.classList.add('authFieldError');el.setAttribute('aria-invalid','true');el.addEventListener('input',()=>clearAuthFieldError(el),{once:true})}
function showAuthErrors(message,ids=[]){ids.forEach(id=>setAuthFieldError(document.getElementById(id)));const box=document.getElementById('authFormMessage');if(box){box.textContent=message;box.classList.remove('hidden')}else alert(message);document.getElementById(ids[0])?.focus()}
function protectedEmailAttrs(){return ' data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-protonpass-ignore="true" data-form-type="other" data-ignore="true" spellcheck="false" '}
async function finishAccountLogin(user){currentAccountUser=user;setAccountHeaderHint(user);await loadAccountState();if(accountNeedsCompletion(currentAccountUser))return showSocialProfileCompletion();history.replaceState({...history.state,shazAccount:false},'','/');closeDrawer();closeAccountPopover();window.scrollTo({top:0,left:0,behavior:'auto'});centerToast(`Hoşgeldin ${currentAccountUser?.firstName||''}`.trim(),1500)}
function showLogin(updateRoute=true){closeAccountPopover();if(updateRoute)syncAccountRoute('/giris');const body=`<div id="authFormMessage" class="authFormMessage hidden"></div><div class="authForm kigiliAuthForm">${authInputShield(`<input id="loginEmail" class="formControl" type="text" inputmode="email" autocomplete="username" ${protectedEmailAttrs()} placeholder="E-posta adresi veya telefon" oninput="updateAuthSubmitState('login')">`)}${authPasswordField('loginPassword','Şifre','current-password','login')}<button id="loginSubmit" class="btn authSubmit" onclick="loginAccount(this)">OTURUM AÇ</button></div><button class="authTextLink authForgot" type="button" onclick="showForgotPassword()">ŞİFREMİ UNUTTUM</button><div class="authSwitch">Hesabınız yok mu? <button type="button" onclick="showRegister()">HESAP OLUŞTUR</button></div>${socialAuthButtons()}`;openDrawer(accountAuthPage('Giriş yap','Hesabınız varsa lütfen giriş yapın.',body));requestAnimationFrame(()=>updateAuthSubmitState('login'))}
async function loginAccount(btn){const login=$('#loginEmail'),pass=$('#loginPassword'),missing=[];if(!String(login?.value||'').trim())missing.push('loginEmail');if(!String(pass?.value||''))missing.push('loginPassword');if(missing.length)return showAuthErrors('E-posta/telefon ve şifre alanlarını doldurun.',missing);try{btn.disabled=true;const r=await apiJson('/api/auth/login',{method:'POST',body:JSON.stringify({login:login.value,password:pass.value})});await finishAccountLogin(r.user)}catch(e){showAuthErrors(e.message,['loginEmail','loginPassword'])}finally{btn.disabled=false}}
function birthDateToIso(v){const x=String(v||'').trim();if(!x)return '';if(/^\d{4}-\d{2}-\d{2}$/.test(x))return x;const m=x.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);if(!m)return null;const d=Number(m[1]),mo=Number(m[2]),y=Number(m[3]),dt=new Date(Date.UTC(y,mo-1,d));if(dt.getUTCFullYear()!==y||dt.getUTCMonth()!==mo-1||dt.getUTCDate()!==d)return null;return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`}
function birthDateToTr(v){const m=String(v||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?`${m[3]}.${m[2]}.${m[1]}`:String(v||'')}
function showRegister(updateRoute=true){closeAccountPopover();if(updateRoute)syncAccountRoute('/kayit');const watch=`oninput="updateAuthSubmitState('register')"`;const body=`<div id="authFormMessage" class="authFormMessage hidden"></div><div class="authForm kigiliAuthForm"><div class="authPair"><input id="regFirst" class="formControl" autocomplete="given-name" placeholder="Ad *" ${watch}><input id="regLast" class="formControl" autocomplete="family-name" placeholder="Soyad *" ${watch}></div>${authInputShield(`<input id="regEmail" class="formControl" type="text" inputmode="email" autocomplete="email" ${protectedEmailAttrs()} placeholder="E-posta adresi *" oninput="updateAuthSubmitState('register')">`)}<input id="regPhone" class="formControl" type="tel" inputmode="tel" autocomplete="tel" placeholder="Telefon Numarası *" ${watch}>${authPasswordField('regPass','Şifre *','new-password','register')}${authPasswordField('regPass2','Şifre Tekrar *','new-password','register')}<div class="birthDateField"><label for="regBirth">Doğum Tarihi *</label><input id="regBirth" class="formControl" type="text" inputmode="numeric" maxlength="10" autocomplete="bday" oninput="formatBirthDateInput(this);updateAuthSubmitState('register')" placeholder="gg.aa.yyyy"></div><div class="authInfoLine">ⓘ 6698 sayılı Kişisel Verilerin Korunması Kanunu kapsamında <button type="button" onclick="openLegalDocument('KVKK')">Üye Aydınlatma Metni</button>'mize buradan ulaşabilirsiniz.</div><div class="authChecks"><label class="authCheck"><input id="regMail" type="checkbox"><span>Kampanya, indirim ve fırsatlardan <b>E-posta</b> aracılığıyla haberdar olmak istiyorum.</span></label><label class="authCheck"><input id="regSms" type="checkbox"><span>Kampanya, indirim ve fırsatlardan <b>SMS</b> aracılığıyla haberdar olmak istiyorum.</span></label></div><div class="authLegalLinks"><button type="button" onclick="openLegalDocument('MEMBERSHIP')">Üyelik Sözleşmesi</button><button type="button" onclick="openLegalDocument('PRIVACY')">Gizlilik Politikası</button><button type="button" onclick="openLegalDocument('COOKIE')">Çerez Politikası</button></div><button id="registerSubmit" class="btn authSubmit" onclick="registerAccount(this)">HESAP OLUŞTUR</button></div>${socialAuthButtons()}<div class="authSwitch">Zaten hesabınız var mı? <button type="button" class="authSwitchBlue" onclick="showLogin()">GİRİŞ YAP</button></div>`;openDrawer(accountAuthPage('Hesap oluştur','Devam etmek için bilgilerinizi girin. Zaten bir hesabınız varsa, <button type="button" class="authLeadLink" onclick="showLogin()">giriş yapın.</button>',body));loadPublicLegalDocuments();requestAnimationFrame(()=>updateAuthSubmitState('register'))}
async function registerAccount(btn){const fields={regFirst:'Ad',regLast:'Soyad',regEmail:'E-posta',regPhone:'Telefon',regPass:'Şifre',regPass2:'Şifre Tekrar',regBirth:'Doğum Tarihi'},missing=[];Object.keys(fields).forEach(id=>{clearAuthFieldError(document.getElementById(id));if(!String(document.getElementById(id)?.value||'').trim())missing.push(id)});if(missing.length)return showAuthErrors('Eksik alanlar: '+missing.map(id=>fields[id]).join(', ')+'.',missing);const p=$('#regPass')?.value||'',p2=$('#regPass2')?.value||'',birth=birthDateToIso($('#regBirth')?.value),email=String($('#regEmail')?.value||'').trim(),phone=String($('#regPhone')?.value||'').trim();if(!email.includes('@'))return showAuthErrors('Lütfen geçerli bir e-posta adresi girin.',['regEmail']);if(phone.replace(/\D/g,'').length<10)return showAuthErrors('Lütfen geçerli bir telefon numarası girin.',['regPhone']);if(p.length<8)return showAuthErrors('Şifre en az 8 karakter olmalıdır.',['regPass']);if(p!==p2)return showAuthErrors('Şifreler eşleşmiyor.',['regPass','regPass2']);if(!birth)return showAuthErrors('Doğum tarihini gg.aa.yyyy şeklinde girin.',['regBirth']);try{btn.disabled=true;const r=await apiJson('/api/auth/register',{method:'POST',body:JSON.stringify({firstName:$('#regFirst')?.value,lastName:$('#regLast')?.value,email,phone,password:p,birthDate:birth,smsMarketingConsent:!!$('#regSms')?.checked,emailMarketingConsent:!!$('#regMail')?.checked})});await finishAccountLogin(r.user)}catch(e){showAuthErrors(e.message,[])}finally{btn.disabled=false}}
function showForgotPassword(updateRoute=true){if(updateRoute)syncAccountRoute('/giris');const body=`<div id="authFormMessage" class="authFormMessage hidden"></div><div class="authForm kigiliAuthForm">${authInputShield(`<input id="forgotIdentifier" class="formControl" type="text" inputmode="email" autocomplete="username" ${protectedEmailAttrs()} placeholder="E-posta veya telefon numarası" oninput="updateAuthSubmitState('forgot')">`)}<button id="forgotSubmit" class="btn authSubmit" onclick="requestPasswordReset(this)">ŞİFRE SIFIRLAMA BAĞLANTISI GÖNDER</button></div><button class="authTextLink" type="button" onclick="showLogin(false)">GİRİŞ EKRANINA DÖN</button>`;openDrawer(accountAuthPage('Şifremi unuttum','Hesabınıza kayıtlı e-posta adresini veya telefon numaranızı girin. Sıfırlama bağlantısı hesabınıza kayıtlı e-posta adresine gönderilir.',body,'showLogin(false)'));requestAnimationFrame(()=>updateAuthSubmitState('forgot'))}
async function requestPasswordReset(btn){const identifier=String($('#forgotIdentifier')?.value||'').trim();if(!identifier)return showAuthErrors('E-posta adresinizi veya telefon numaranızı girin.',['forgotIdentifier']);try{btn.disabled=true;const r=await apiJson('/api/auth/forgot-password',{method:'POST',body:JSON.stringify({identifier})});alert(r.message||'İşlem tamamlandı.')}catch(e){showAuthErrors(e.message,[])}finally{btn.disabled=false}}
function showResetPassword(updateRoute=true){if(updateRoute&&location.pathname!=='/sifre-sifirla')syncAccountRoute('/sifre-sifirla');const token=new URLSearchParams(location.search).get('token')||'';const body=`<div class="authForm kigiliAuthForm">${authPasswordField('resetPass','Yeni Şifre','new-password')}${authPasswordField('resetPass2','Yeni Şifre Tekrar','new-password')}<button class="btn authSubmit is-ready" onclick="finishPasswordReset(this,'${escapeAttr(token)}')">ŞİFREMİ GÜNCELLE</button></div>`;openDrawer(accountAuthPage('Yeni şifre oluştur','Yeni şifrenizi belirleyin.',body,'showLogin()'))}
async function finishPasswordReset(btn,token){const a=$('#resetPass')?.value||'',b=$('#resetPass2')?.value||'';if(a!==b)return alert('Şifreler eşleşmiyor.');try{btn.disabled=true;await apiJson('/api/auth/reset-password',{method:'POST',body:JSON.stringify({token,password:a})});alert('Şifreniz güncellendi.');history.replaceState({},'', '/giris');showLogin(false)}catch(e){alert(e.message)}finally{btn.disabled=false}}
let authSocialConfig=null;
async function getSocialConfig(){if(authSocialConfig)return authSocialConfig;authSocialConfig=await apiJson('/api/auth/social-config');return authSocialConfig}
function loadExternalScript(src,id){return new Promise((resolve,reject)=>{if(document.getElementById(id))return resolve();const script=document.createElement('script');script.id=id;script.src=src;script.async=true;script.onload=resolve;script.onerror=()=>reject(new Error('Bağlantı yüklenemedi.'));document.head.appendChild(script)})}
async function startGoogleLogin(btn){try{btn.disabled=true;const c=await getSocialConfig();if(!c.googleClientId)throw new Error('Google ile devam özelliği henüz etkinleştirilmemiş.');await loadExternalScript('https://accounts.google.com/gsi/client','shaz-google-gsi');google.accounts.id.initialize({client_id:c.googleClientId,callback:async response=>{try{const out=await apiJson('/api/auth/social/google',{method:'POST',body:JSON.stringify({credential:response.credential})});await finishAccountLogin(out.user)}catch(e){alert(e.message)}}});google.accounts.id.prompt()}catch(e){alert(e.message||'Google ile giriş tamamlanamadı.')}finally{btn.disabled=false}}
async function startAppleLogin(btn){try{btn.disabled=true;const c=await getSocialConfig();if(!c.appleClientId||!c.appleRedirectUri)throw new Error('Apple ile devam özelliği henüz etkinleştirilmemiş.');await loadExternalScript('https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js','shaz-apple-auth');AppleID.auth.init({clientId:c.appleClientId,scope:'name email',redirectURI:c.appleRedirectUri,usePopup:true});const response=await AppleID.auth.signIn();const out=await apiJson('/api/auth/social/apple',{method:'POST',body:JSON.stringify({identityToken:response?.authorization?.id_token,firstName:response?.user?.name?.firstName||'',lastName:response?.user?.name?.lastName||''})});await finishAccountLogin(out.user)}catch(e){if(String(e?.error||'')!=='popup_closed_by_user')alert(e.message||'Apple ile giriş tamamlanamadı.')}finally{btn.disabled=false}}
function showSocialProfileCompletion(updateRoute=true){if(!currentAccountUser)return showLogin(updateRoute);if(updateRoute)syncAccountRoute('/hesabim/bilgiler');const u=currentAccountUser;const body=`<div class="accountShell"><div class="wizardHead"><h2>Hesabınızı tamamlayın</h2></div><p class="accountCompletionLead">Google/Apple hesabınızla üyeliğiniz oluşturuldu. Sipariş ve teslimat işlemleri için zorunlu bilgileri tamamlayın.</p><div id="authFormMessage" class="authFormMessage hidden"></div><div class="accountForm"><div class="authPair"><input id="completeFirst" class="formControl" value="${escapeAttr(u.firstName||'')}" placeholder="Ad *"><input id="completeLast" class="formControl" value="${escapeAttr(u.lastName||'')}" placeholder="Soyad *"></div><input id="completePhone" class="formControl" type="tel" inputmode="tel" autocomplete="tel" value="${escapeAttr(u.phone||'')}" placeholder="Telefon *"><div class="birthDateField"><label for="completeBirth">Doğum Tarihi *</label><input id="completeBirth" class="formControl" type="text" inputmode="numeric" maxlength="10" value="${escapeAttr(birthDateToTr(u.birthDate||''))}" oninput="formatBirthDateInput(this)" placeholder="gg.aa.yyyy"></div><button class="btn" onclick="saveSocialProfileCompletion(this)">DEVAM ET</button></div></div>`;openDrawer(accountStandardPage(body,'leaveAccountArea()'))}
async function saveSocialProfileCompletion(btn){const ids=['completeFirst','completeLast','completePhone','completeBirth'],missing=ids.filter(id=>!String(document.getElementById(id)?.value||'').trim());if(missing.length)return showAuthErrors('Lütfen tüm zorunlu alanları doldurun.',missing);const birth=birthDateToIso($('#completeBirth')?.value);if(!birth)return showAuthErrors('Doğum tarihini gg.aa.yyyy şeklinde girin.',['completeBirth']);try{btn.disabled=true;const response=await apiJson('/api/account/profile',{method:'PATCH',body:JSON.stringify({firstName:$('#completeFirst')?.value,lastName:$('#completeLast')?.value,email:currentAccountUser.email,phone:$('#completePhone')?.value,birthDate:birth,smsMarketingConsent:!!currentAccountUser.smsMarketingConsent,emailMarketingConsent:!!currentAccountUser.emailMarketingConsent})});currentAccountUser=response.user;updateAccountHeader();showAccountHome()}catch(e){showAuthErrors(e.message,[])}finally{btn.disabled=false}}
function accountMenuIcon(type){const icons={orders:'<svg viewBox="0 0 24 24"><path d="M6 7h12l-1 13H7L6 7Zm3 0V5a3 3 0 0 1 6 0v2"/></svg>',profile:'<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',address:'<svg viewBox="0 0 24 24"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>',favorite:'<svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.9-8.6a5.5 5.5 0 0 0-.1-7.8Z"/></svg>',coupon:'<svg viewBox="0 0 24 24"><path d="M3 8a2 2 0 0 0 0 4v5h18v-5a2 2 0 0 0 0-4V3H3v5Z"/><path d="M12 6v8"/></svg>',password:'<svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',logout:'<svg viewBox="0 0 24 24"><path d="M10 17l5-5-5-5M15 12H3M14 3h7v18h-7"/></svg>'};return icons[type]||''}
function showAccountHome(updateRoute=true){
  if(!currentAccountUser)return showLogin(updateRoute);
  if(accountNeedsCompletion(currentAccountUser))return showSocialProfileCompletion(updateRoute);
  if(updateRoute)syncAccountRoute('/hesabim');
  const couponCount=couponNoticeCount();
  const body=`<div class="accountShell accountShellMenu"><div class="accountHero accountMenuHero"><div><h2>Merhaba ${escapeHtml(currentAccountUser.firstName||'')}</h2></div></div><div class="accountMenuList"><button class="accountMenuRow" onclick="showAccountOrders()"><span class="accountMenuIcon">${accountMenuIcon('orders')}</span><b>Siparişlerim</b><span class="accountMenuArrow">›</span></button><button class="accountMenuRow" onclick="showAccountProfile()"><span class="accountMenuIcon">${accountMenuIcon('profile')}</span><b>Hesap Bilgilerim</b><span class="accountMenuArrow">›</span></button><button class="accountMenuRow" onclick="showAccountAddresses()"><span class="accountMenuIcon">${accountMenuIcon('address')}</span><b>Adreslerim</b><span class="accountMenuArrow">›</span></button><button class="accountMenuRow" onclick="showAccountFavorites()"><span class="accountMenuIcon">${accountMenuIcon('favorite')}</span><b>Favorilerim</b><span class="accountMenuArrow">›</span></button><button class="accountMenuRow" onclick="showAccountCoupons()"><span class="accountMenuIcon">${accountMenuIcon('coupon')}</span><b>Kuponlarım</b><span class="accountMenuNoticeBadge ${couponCount?'':'hidden'}" data-coupon-notice-badge>${couponCount||''}</span><span class="accountMenuArrow">›</span></button><div class="accountMenuDivider"></div><button class="accountMenuRow" onclick="showChangePassword()"><span class="accountMenuIcon">${accountMenuIcon('password')}</span><b>Şifre Değiştir</b><span class="accountMenuArrow">›</span></button><button class="accountMenuRow" onclick="confirmLogoutAccount()"><span class="accountMenuIcon">${accountMenuIcon('logout')}</span><b>Çıkış Yap</b><span class="accountMenuArrow">›</span></button></div></div>`;
  openDrawer(accountStandardPage(body,'leaveAccountArea()'))
}
function accountProfileRuleText(){const r=currentAccountUser?.profileRules||{},parts=[];if(Number(r.nameWaitMs||0)>0)parts.push(`Ad / Soyad için ${profileWaitText(r.nameWaitMs)} kaldı.`);else parts.push('Ad / Soyad 30 günde 1 kez değiştirilebilir.');if(Number(r.phoneWaitMs||0)>0)parts.push(`Telefon için ${profileWaitText(r.phoneWaitMs)} kaldı.`);else parts.push('Telefon 7 günde 1 kez değiştirilebilir ve doğrulanmadan aktif olmaz.');parts.push('E-posta doğrulanmadan aktif olmaz.');parts.push(r.birthDateChangeAvailable===false?'Doğum tarihi kullanıcı tarafından daha önce değiştirildi; artık yalnız yönetim değiştirebilir.':'Doğum tarihini hesabınızdan yalnızca 1 kez değiştirebilirsiniz.');return parts}
function profileWaitText(ms){const d=Math.floor(ms/86400000),h=Math.floor((ms%86400000)/3600000),m=Math.max(1,Math.ceil((ms%3600000)/60000));return [d?`${d} gün`:'',h?`${h} saat`:'',!d&&!h?`${m} dakika`:''].filter(Boolean).join(' ')}
async function showAccountProfile(updateRoute=true){if(updateRoute)syncAccountRoute('/hesabim/bilgiler');const u=currentAccountUser,rules=accountProfileRuleText();openDrawer(accountStandardPage(`<div class="accountShell accountCenteredSubPage accountTopSubPage"><div class="wizardHead"><button class="pill" onclick="showAccountHome()">← Geri</button><h2>Hesap Bilgilerim</h2></div><div id="authFormMessage" class="authFormMessage hidden"></div><div class="accountProfileRules">${rules.map(x=>`<small>${escapeHtml(x)}</small>`).join('')}${u.pendingEmailChange?`<small><b>Bekleyen e-posta doğrulaması:</b> ${escapeHtml(u.pendingEmailChange.email||'')}</small>`:''}${u.pendingPhoneChange?`<small><b>Bekleyen telefon doğrulaması:</b> ${escapeHtml(displayAccountPhone(u.pendingPhoneChange.phone||''))}</small><div class="pendingPhoneVerify"><input id="pendingPhoneCode" class="formControl" inputmode="numeric" maxlength="8" placeholder="Doğrulama kodu"><button type="button" class="smallBtn" onclick="verifyPendingPhoneChange(this)">Telefonu Doğrula</button></div>`:''}</div><div class="accountForm"><div class="authPair"><input id="accFirst" class="formControl" value="${escapeAttr(u.firstName||'')}" placeholder="Ad *"><input id="accLast" class="formControl" value="${escapeAttr(u.lastName||'')}" placeholder="Soyad *"></div>${authInputShield(`<input id="accEmail" class="formControl" type="text" inputmode="email" ${protectedEmailAttrs()} value="${escapeAttr(u.email||'')}" placeholder="E-posta *">`)}<input id="accPhone" class="formControl" type="tel" value="${escapeAttr(displayAccountPhone(u.phone||''))}" placeholder="Telefon *"><div class="birthDateField"><label for="accBirth">Doğum Tarihi *</label><input id="accBirth" class="formControl" type="text" inputmode="numeric" maxlength="10" value="${escapeAttr(birthDateToTr(u.birthDate||''))}" oninput="formatBirthDateInput(this)" placeholder="gg.aa.yyyy"></div><label class="authCheck"><input id="accSms" type="checkbox" ${u.smsMarketingConsent?'checked':''}> SMS pazarlama izni</label><label class="authCheck"><input id="accMail" type="checkbox" ${u.emailMarketingConsent?'checked':''}> E-posta pazarlama izni</label><button class="btn" onclick="saveAccountProfile(this)">Kaydet</button></div></div>`,'showAccountHome()'))}
async function verifyPendingPhoneChange(btn){const code=String($('#pendingPhoneCode')?.value||'').trim();if(!code)return alert('Doğrulama kodunu girin.');try{btn.disabled=true;const r=await apiJson('/api/account/verify-phone-change',{method:'POST',body:JSON.stringify({code})});currentAccountUser=r.user;updateAccountHeader();toast('✓ Telefon numarası doğrulandı');showAccountProfile(false)}catch(e){alert(e.message)}finally{btn.disabled=false}}
async function saveAccountProfile(btn){const required=['accFirst','accLast','accEmail','accPhone','accBirth'],missing=required.filter(id=>!String(document.getElementById(id)?.value||'').trim());if(missing.length)return showAuthErrors('Lütfen kırmızı işaretli zorunlu alanları doldurun.',missing);const birth=birthDateToIso($('#accBirth')?.value);if(!birth)return showAuthErrors('Doğum tarihini gg.aa.yyyy şeklinde girin.',['accBirth']);try{btn.disabled=true;const r=await apiJson('/api/account/profile',{method:'PATCH',body:JSON.stringify({firstName:$('#accFirst')?.value,lastName:$('#accLast')?.value,email:$('#accEmail')?.value,phone:$('#accPhone')?.value,birthDate:birth,smsMarketingConsent:!!$('#accSms')?.checked,emailMarketingConsent:!!$('#accMail')?.checked})});currentAccountUser=r.user;updateAccountHeader();toast(r.message||'✓ Hesap bilgileri güncellendi');showAccountProfile(false)}catch(e){alert(e.message)}finally{btn.disabled=false}}
function accountOrderStatusIndex(status){const s=String(status||'new').toLocaleLowerCase('tr-TR');if(['delivered','teslim','teslim_edildi','completed'].includes(s)||s.includes('teslim'))return 3;if(['shipped','kargoya_verildi'].includes(s)||s.includes('kargo'))return 2;if(['prepared','preparing','hazırlanıyor','hazirlanıyor','hazırlandı','hazirlandi'].includes(s)||s.includes('hazır')||s.includes('hazir'))return 1;return 0}
function accountOrderStatusLabel(status){return ['Siparişiniz alındı','Siparişiniz hazırlanıyor','Kargoya verildi','Teslim edildi'][accountOrderStatusIndex(status)]}
function accountOrderTimeline(status){const ix=accountOrderStatusIndex(status),labels=['Siparişiniz alındı','Siparişiniz hazırlanıyor','Kargoya verildi','Teslim edildi'];return `<div class="accountOrderTimeline">${labels.map((label,i)=>`${i?`<span class="accountOrderTrack ${i<=ix?'is-done':''}"></span>`:''}<div class="accountOrderStep ${i<=ix?'is-done':''} ${i===ix?'is-current':''}"><i></i><small>${label}</small></div>`).join('')}</div>`}
function accountPaymentLabel(payment){const raw=typeof payment==='string'?payment:(payment?.method||payment?.label||'');const s=String(raw||'').toLocaleLowerCase('tr-TR');if(s==='cod'||s.includes('kapıda')||s.includes('kapida'))return 'Kapıda Ödeme';if(s==='online'||s.includes('online'))return 'Online Ödeme';return String(raw||'')}
function accountOrderItemImage(x){return mainProductImage(x?.product)||(x?.builderItems||[]).find(y=>y?.image)?.image||''}
function accountOrderThumbs(items=[]){const imgs=(items||[]).map(accountOrderItemImage).filter(Boolean);return imgs.length?`<div class="accountOrderThumbs">${imgs.slice(0,4).map((img,i)=>`<span><img src="${escapeAttr(img)}" alt="Sipariş ürünü ${i+1}"></span>`).join('')}${imgs.length>4?`<b>+${imgs.length-4}</b>`:''}</div>`:''}
async function showAccountOrders(updateRoute=true){if(updateRoute)syncAccountRoute('/hesabim/siparisler');try{const r=await apiJson('/api/account/orders');const rows=(r.orders||[]).map(o=>`<div class="accountOrder"><div class="accountOrderTop"><b>Sipariş #${escapeHtml(o.dailyDisplayId||o.id)}</b><span>${money(o.total)}</span></div><small>${escapeHtml(o.createdAtTR||o.createdAt||'')}</small>${accountOrderThumbs(o.items||[])}<div class="accountOrderListStatus">${escapeHtml(accountOrderStatusLabel(o.status))}</div><div class="accountRowActions"><button class="smallBtn" onclick="showAccountOrderDetail('${escapeAttr(o.id)}')">Detay</button></div></div>`).join('')||'<div class="accountEmptyState">Henüz hesabınıza bağlı sipariş bulunmuyor.</div>';openDrawer(accountStandardPage(`<div class="accountShell accountCenteredSubPage accountTopSubPage"><div class="wizardHead"><button class="pill" onclick="showAccountHome()">← Geri</button><h2>Siparişlerim</h2></div>${rows}</div>`,'showAccountHome()'))}catch(e){alert(e.message)}}
function accountOrderPersonalizationHtml(x){
  const name=x.product?.name||'Ürün',writes=x.writes||x.setCustomization?.writes||[],photos=x.photoCustomizations||x.setCustomization?.photoCustomizations||[],parts=[];
  if(x.builderItems?.length)parts.push(`<div class="accountPersonalLine"><b>Set içeriği</b><span>${x.builderItems.map(p=>escapeHtml(p.name||'Ürün')).join(', ')}</span></div>`);
  if(x.setCustomization){const removed=(x.setCustomization.removedIds||[]).map(id=>(x.product?.setItems||[]).find(s=>s.id===id)?.name).filter(Boolean);if(removed.length)parts.push(`<div class="accountPersonalLine"><b>Çıkarılan ürünler</b><span>${removed.map(escapeHtml).join(', ')}</span></div>`)}
  writes.forEach(w=>parts.push(`<div class="accountPersonalLine"><b>${escapeHtml(w.item||name)}</b><span>Konum: ${escapeHtml(w.position||'Belirtilmedi')}</span><span>Yazı: “${escapeHtml(w.text||'')}”</span>${Number(w.fee||0)?`<span>Ücret: +${money(w.fee)}</span>`:''}</div>`));
  photos.forEach(ph=>parts.push(`<div class="accountPersonalLine accountPersonalPhoto"><b>${escapeHtml(ph.item||name)} · Fotoğraf işlemesi</b>${ph.imageUrl?`<img src="${escapeAttr(ph.imageUrl)}" alt="Kişiselleştirme fotoğrafı">`:''}${ph.caption?`<span>Yazı: “${escapeHtml(ph.caption)}”</span>`:''}${ph.captionPosition?`<span>Konum: ${ph.captionPosition==='above'?'Fotoğrafın üstünde':ph.captionPosition==='below'?'Fotoğrafın altında':escapeHtml(ph.captionPosition)}</span>`:''}${Number(ph.fee||0)?`<span>Ücret: +${money(ph.fee)}</span>`:''}</div>`));
  if(String(x.productNote||'').trim())parts.push(`<div class="accountPersonalLine"><b>Sipariş notu</b><span>${escapeHtml(String(x.productNote).trim())}</span></div>`);
  return parts.length?`<div class="accountPersonalBox"><strong>Ürün ve Kişiselleştirme Bilgileri</strong>${parts.join('')}</div>`:''
}
function accountOrderItemDetailHtml(x){const img=accountOrderItemImage(x),qty=Number(x.qty||1),price=Number(x.product?.price||0);return `<div class="accountOrderItem"><div class="accountOrderItemMain">${img?`<div class="accountOrderItemImage"><img src="${escapeAttr(img)}" alt="${escapeAttr(x.product?.name||'Ürün')}"></div>`:''}<div class="accountOrderItemCopy"><b>${escapeHtml(x.product?.name||'Ürün')}</b><span>Adet: ${qty}</span><strong>${money(price*qty)}</strong></div></div>${accountOrderPersonalizationHtml(x)}</div>`}
function accountOrderPricingHtml(o){const subtotal=Number(o.subtotal??o.preCouponTotal??o.total??0),campaignDiscount=Number(o.discountTotal||0),couponDiscount=Number(o.couponDiscountTotal||0),rows=[];rows.push(`<div><span>Ara toplam</span><b>${money(subtotal)}</b></div>`);(o.appliedCampaigns||[]).forEach(x=>rows.push(`<div class="accountOrderDiscount"><span>${escapeHtml(x.name||'Kampanya indirimi')}</span><b>-${money(x.discount||0)}</b></div>`));if(!o.appliedCampaigns?.length&&campaignDiscount>0)rows.push(`<div class="accountOrderDiscount"><span>Kampanya indirimi</span><b>-${money(campaignDiscount)}</b></div>`);(o.appliedCoupons||[]).forEach(x=>rows.push(`<div class="accountOrderDiscount"><span>Kupon · ${escapeHtml(x.code||'')}</span><b>-${money(x.discount||0)}</b></div>`));if(!o.appliedCoupons?.length&&couponDiscount>0)rows.push(`<div class="accountOrderDiscount"><span>Kupon indirimi</span><b>-${money(couponDiscount)}</b></div>`);const itemFees=(o.items||[]).reduce((sum,x)=>sum+((x.writes||x.setCustomization?.writes||[]).reduce((n,w)=>n+Number(w.fee||0),0))+((x.photoCustomizations||x.setCustomization?.photoCustomizations||[]).reduce((n,ph)=>n+Number(ph.fee||0),0)),0);if(itemFees>0)rows.push(`<div><span>Kişiselleştirme / ek hizmetler</span><b>${money(itemFees)}</b></div>`);rows.push(`<div class="accountOrderPricingTotal"><span>Ödenen toplam</span><strong>${money(o.total)}</strong></div>`);return `<div class="wizardCard accountOrderPricing"><h3>Ödeme Özeti</h3>${rows.join('')}</div>`}
async function showAccountOrderDetail(id,updateRoute=true){if(updateRoute)syncAccountRoute('/hesabim/siparisler/'+encodeURIComponent(id));try{const r=await apiJson('/api/account/orders/'+encodeURIComponent(id));const o=r.order,c=o.customer||{},tracking=o.trackingNo||o.shipping?.trackingNo||o.cargoTrackingNo||'',payment=accountPaymentLabel(o.payment);openDrawer(accountStandardPage(`<div class="accountShell accountCenteredSubPage accountTopSubPage"><div class="wizardHead"><button class="pill" onclick="showAccountOrders()">← Geri</button><h2>Sipariş #${escapeHtml(o.dailyDisplayId||o.id)}</h2></div>${accountOrderTimeline(o.status)}<div class="wizardCard accountOrderMeta"><div><b>Durum</b><span>${escapeHtml(accountOrderStatusLabel(o.status))}</span></div><div><b>Sipariş Tarihi</b><span>${escapeHtml(o.createdAtTR||o.createdAt||'')}</span></div>${payment?`<div><b>Ödeme</b><span>${escapeHtml(payment)}</span></div>`:''}${tracking?`<div><b>Kargo Takip</b><span>${escapeHtml(String(tracking))}</span></div>`:''}<div><b>Telefon</b><span>${escapeHtml(c.phone||currentAccountUser?.phone||'')}</span></div><div class="accountOrderAddress"><b>Teslimat</b><span>${escapeHtml(customerAddressText(c)||'')}</span></div>${String(c.note||'').trim()?`<div class="accountOrderAddress"><b>Teslimat Notu</b><span>${escapeHtml(String(c.note).trim())}</span></div>`:''}${String(o.orderNote||'').trim()?`<div class="accountOrderAddress"><b>Sipariş Notu</b><span>${escapeHtml(String(o.orderNote).trim())}</span></div>`:''}</div><div class="wizardCard accountOrderProducts"><h3>Ürünler</h3>${(o.items||[]).map(accountOrderItemDetailHtml).join('')}</div>${accountOrderPricingHtml(o)}</div>`,'showAccountOrders()'))}catch(e){alert(e.message)}}
async function showAccountAddresses(updateRoute=true){
  if(updateRoute)syncAccountRoute('/hesabim/adresler');
  try{
    const response=await apiJson('/api/account/addresses');currentAccountAddresses=response.addresses||[];
    const rows=currentAccountAddresses.map(a=>{const title=escapeHtml(a.title||'Adres');return `<div class="accountAddress ${a.isDefault?'is-default':''}" data-account-address-id="${escapeAttr(a.id)}" role="button" tabindex="0" onclick="if(!event.target.closest('button,input'))setDefaultAccountAddress('${escapeAttr(a.id)}')" onkeydown="if((event.key==='Enter'||event.key===' ')&&!event.target.closest('button,input')){event.preventDefault();setDefaultAccountAddress('${escapeAttr(a.id)}')}"><div class="accountAddressDefaultPick"><input type="radio" name="accountDefaultAddress" ${a.isDefault?'checked':''} aria-label="Varsayılan adres olarak seç" onclick="event.stopPropagation();setDefaultAccountAddress('${escapeAttr(a.id)}')"></div><div class="accountAddressBody"><div class="accountAddressTitle"><b>${title}</b><span class="accountDefaultTag ${a.isDefault?'':'hidden'}">Varsayılan Adres</span></div><span class="accountAddressText">${escapeHtml([normalizeAddressDisplayPart(a.neighborhood,'neighborhood'),normalizeAddressDisplayPart(a.avenue,'avenue'),normalizeAddressDisplayPart(a.street,'street'),a.fullAddress,a.district,a.province].filter(Boolean).join(' '))}</span><div class="accountAddressPhones"><span><b>${escapeHtml(displayAccountPhone(a.phone||''))}</b><small>SMS ve bilgilendirmelerin geleceği numara</small></span>${a.extraPhone?`<span><b>${escapeHtml(displayAccountPhone(a.extraPhone))}</b><small>SMS gönderilmez · Yedek numara</small></span>`:''}</div><div class="accountRowActions"><button class="smallBtn" onclick="event.stopPropagation();showAddressForm('${escapeAttr(a.id)}')">Düzenle</button><button class="smallBtn" onclick="event.stopPropagation();deleteAccountAddress('${escapeAttr(a.id)}')">Sil</button></div></div></div>`}).join('');
    openDrawer(accountStandardPage(`<div class="accountShell accountAddressesPage accountCenteredSubPage accountTopSubPage"><div class="wizardHead accountAddressHead"><button class="pill" onclick="showAccountHome()">← Geri</button><h2>Adreslerim</h2><button class="accountNewAddressTop" type="button" onclick="showAddressForm('')">+ Yeni Adres</button></div>${rows||'<div class="accountEmptyState">Kayıtlı adresiniz yok.</div>'}</div>`,'showAccountHome()'))
  }catch(e){alert(e.message)}
}
function applyDefaultAccountAddressUI(id){currentAccountAddresses.forEach(a=>a.isDefault=a.id===id);document.querySelectorAll('[data-account-address-id]').forEach(card=>{const on=card.dataset.accountAddressId===id;card.classList.toggle('is-default',on);const radio=card.querySelector('input[name="accountDefaultAddress"]');if(radio)radio.checked=on;card.querySelector('.accountDefaultTag')?.classList.toggle('hidden',!on)})}
async function setDefaultAccountAddress(id){const a=currentAccountAddresses.find(x=>x.id===id);if(!a||a.isDefault)return;const old=currentAccountAddresses.find(x=>x.isDefault)?.id||'';applyDefaultAccountAddressUI(id);try{await apiJson('/api/account/addresses/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify({isDefault:true})})}catch(e){if(old)applyDefaultAccountAddressUI(old);alert(e.message)}}
function accountAddressField(label,id,value='',type='text',placeholder=''){return `<label class="accountAddressEditField"><span>${escapeHtml(label)}</span><input id="${id}" class="formControl" type="${type}" ${type==='tel'?'inputmode="tel"':''} value="${escapeAttr(value||'')}" placeholder="${escapeAttr(placeholder||label)}"></label>`}
function showAddressForm(id=''){const a=currentAccountAddresses.find(x=>x.id===id)||{},fullName=a.fullName||[currentAccountUser.firstName,currentAccountUser.lastName].filter(Boolean).join(' '),phone=displayAccountPhone(a.phone||currentAccountUser.phone||'');openDrawer(accountStandardPage(`<div class="accountShell accountCenteredSubPage accountTopSubPage"><div class="wizardHead"><button class="pill" onclick="showAccountAddresses()">← Geri</button><h2>${id?'Adresi Düzenle':'Yeni Adres'}</h2></div><div class="accountForm accountAddressEditForm">${accountAddressField('Adres Başlığı','aaTitle',a.title||'')}${accountAddressField('Ad Soyad','aaFullName',fullName)}<label class="accountAddressEditField"><span>1. Telefon Numarası</span><input id="aaPhone" class="formControl" type="tel" inputmode="tel" value="${escapeAttr(phone)}" placeholder="05xx xxx xx xx"><small>SMS ve bilgilendirmelerin geleceği numara</small></label><label class="accountAddressEditField"><span>2. Telefon Numarası (isteğe bağlı)</span><input id="aaExtraPhone" class="formControl" type="tel" inputmode="tel" value="${escapeAttr(displayAccountPhone(a.extraPhone||''))}" placeholder="05xx xxx xx xx"><small>SMS gönderilmez · Yedek numara</small></label><div class="authPair">${accountAddressField('İl','aaProvince',a.province||'')}${accountAddressField('İlçe','aaDistrict',a.district||'')}</div>${accountAddressField('Mahalle','aaNeighborhood',stripAddressSuffix(a.neighborhood||'','neighborhood'))}<div class="authPair">${accountAddressField('Cadde','aaAvenue',stripAddressSuffix(a.avenue||'','avenue'))}${accountAddressField('Sokak','aaStreet',stripAddressSuffix(a.street||'','street'))}</div><label class="accountAddressEditField"><span>Adres Devamı</span><textarea id="aaFullAddress" class="formControl" placeholder="Bina no, kat, daire, site/apartman adı">${escapeHtml(a.fullAddress||'')}</textarea></label><button class="btn" onclick="saveAccountAddress('${escapeAttr(id)}',this)">Kaydet</button></div></div>`,'showAccountAddresses()'))}
async function saveAccountAddress(id,btn){try{btn.disabled=true;const body={title:$('#aaTitle')?.value,fullName:$('#aaFullName')?.value,phone:$('#aaPhone')?.value,extraPhone:$('#aaExtraPhone')?.value,province:$('#aaProvince')?.value,district:$('#aaDistrict')?.value,neighborhood:$('#aaNeighborhood')?.value,avenue:$('#aaAvenue')?.value,street:$('#aaStreet')?.value,fullAddress:$('#aaFullAddress')?.value};await apiJson('/api/account/addresses'+(id?'/'+encodeURIComponent(id):''),{method:id?'PATCH':'POST',body:JSON.stringify(body)});showAccountAddresses()}catch(e){alert(e.message)}finally{btn.disabled=false}}
async function deleteAccountAddress(id){if(!confirm('Adres silinsin mi?'))return;try{await apiJson('/api/account/addresses/'+encodeURIComponent(id),{method:'DELETE'});showAccountAddresses()}catch(e){alert(e.message)}}
function couponDiscountLabel(c){return c.discountType==='fixed'?`${Number(c.value||0).toLocaleString('tr-TR')} TL İNDİRİM`:`%${Number(c.value||0).toLocaleString('tr-TR')} İNDİRİM`}
function couponExpiryParts(value){const m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})/);if(!m)return null;return {y:Number(m[1]),m:Number(m[2]),d:Number(m[3])}}
function couponExpirySortValue(c){const p=couponExpiryParts(c?.expiresAt);return p?Date.UTC(p.y,p.m-1,p.d):Number.MAX_SAFE_INTEGER}
function couponExpiryInfo(c){
  if(c.status==='expired')return {text:'Süresi dolmuş',urgent:true,days:-1};
  if(c.status==='used')return {text:'Kullanılmış',urgent:false,days:Infinity};
  const p=couponExpiryParts(c.expiresAt);if(!p)return {text:'Son kullanım tarihi yok',urgent:false,days:Infinity};
  const today=new Date(),todayDay=Date.UTC(today.getFullYear(),today.getMonth(),today.getDate()),expDay=Date.UTC(p.y,p.m-1,p.d),days=Math.round((expDay-todayDay)/86400000),date=`${String(p.d).padStart(2,'0')}.${String(p.m).padStart(2,'0')}.${p.y}`;
  if(days===0)return {text:`Son kullanım: ${date} · SON GÜN`,urgent:true,days};
  if(days>0&&days<=3)return {text:`Son kullanım: ${date} · ${days} gün kaldı`,urgent:true,days};
  return {text:`Son kullanım: ${date}`,urgent:false,days};
}
function sortedAccountCoupons(rows=currentAccountCoupons){return [...(rows||[])].sort((a,b)=>{const sa=a.status==='active'?0:1,sb=b.status==='active'?0:1;if(sa!==sb)return sa-sb;return couponExpirySortValue(a)-couponExpirySortValue(b)})}
function activeAccountCoupons(){return sortedAccountCoupons().filter(c=>c.status==='active')}
function couponNoticeKey(){return currentAccountUser?`shazCouponNoticeViewed:${currentAccountUser.id}`:''}
function couponNoticeSignatureKey(){return currentAccountUser?`shazCouponNoticeSignature:${currentAccountUser.id}`:''}
function couponPopupSeenIdsKey(){return currentAccountUser?`shazCouponPopupSeenIds:${currentAccountUser.id}`:''}
function storedIdSet(key){try{const a=JSON.parse(localStorage.getItem(key)||'[]');return new Set(Array.isArray(a)?a.map(String):[])}catch(_){return new Set()}}
function saveIdSet(key,set){try{localStorage.setItem(key,JSON.stringify([...set]))}catch(_){}}
function couponIdentity(c){return String(c?.id||`${c?.code||''}:${c?.createdAt||''}`)}
function couponNoticeSignature(){return activeAccountCoupons().map(c=>`${couponIdentity(c)}:${c.updatedAt||c.createdAt||''}:${c.status||''}`).join('|')}
function couponNoticeDue(){if(!currentAccountUser||!activeAccountCoupons().length)return false;try{const sig=couponNoticeSignature(),seen=localStorage.getItem(couponNoticeSignatureKey())||'',last=Number(localStorage.getItem(couponNoticeKey())||0);return sig!==seen||!last||Date.now()-last>=COUPON_NOTICE_MS}catch(_){return true}}
function couponNoticeCount(){return couponNoticeDue()?activeAccountCoupons().length:0}
function newPopupAccountCoupons(){if(!currentAccountUser)return[];const seen=storedIdSet(couponPopupSeenIdsKey());return activeAccountCoupons().filter(c=>!seen.has(couponIdentity(c)))}
function updateCouponNotificationBadges(){const count=couponNoticeCount(),head=$('#accountCouponBadge');if(head){head.textContent=count?String(count):'';head.classList.toggle('hidden',!count)}document.querySelectorAll('[data-coupon-notice-badge]').forEach(el=>{el.textContent=count?String(count):'';el.classList.toggle('hidden',!count)})}
function markCouponNotificationsViewed(){if(!currentAccountUser)return;try{localStorage.setItem(couponNoticeKey(),String(Date.now()));localStorage.setItem(couponNoticeSignatureKey(),couponNoticeSignature())}catch(_){}updateCouponNotificationBadges()}
async function refreshAccountCoupons(){if(!currentAccountUser)return;try{const r=await apiJson('/api/account/coupons');currentAccountCoupons=Array.isArray(r.coupons)?r.coupons:[];updateCouponNotificationBadges();maybeShowCouponAnnouncement()}catch(_){}}
function ensureCouponNoticeTimer(){if(couponNoticeTimer)return;couponNoticeTimer=setInterval(()=>{if(currentAccountUser)refreshAccountCoupons()},60*1000)}
function couponCopyIcon(){return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>'}
async function copyCouponCode(code,btn){const text=String(code||'');try{await navigator.clipboard.writeText(text)}catch(_){const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove()}if(btn){btn.classList.add('copied');const old=btn.getAttribute('aria-label');btn.setAttribute('aria-label','Kopyalandı');setTimeout(()=>{btn.classList.remove('copied');btn.setAttribute('aria-label',old||'Kupon kodunu kopyala')},900)}toast('Kupon kodu kopyalandı')}
function couponRuleDetails(c){const rows=[];if(Number(c.minCartAmount||0)>0)rows.push(`Minimum sepet: ${money(c.minCartAmount)}`);if(c.discountType==='percent'&&Number(c.maxDiscountAmount||0)>0)rows.push(`Maksimum indirim: ${money(c.maxDiscountAmount)}`);rows.push(c.stackable?'Diğer uygun kuponlarla birlikte kullanılabilir':'Diğer kuponlarla birlikte kullanılamaz');return rows}
function couponRulesHtml(c,cls='couponRuleList'){const rows=couponRuleDetails(c);return rows.length?`<div class="${cls}">${rows.map(x=>`<small>${escapeHtml(x)}</small>`).join('')}</div>`:''}
function maybeShowCouponAnnouncement(){
  if(!currentAccountUser||document.querySelector('.couponNoticeOverlay'))return;
  const rows=newPopupAccountCoupons();if(!rows.length)return;
  const seen=storedIdSet(couponPopupSeenIdsKey());rows.forEach(c=>seen.add(couponIdentity(c)));saveIdSet(couponPopupSeenIdsKey(),seen);
  const el=document.createElement('div');el.className='couponNoticeOverlay';
  el.innerHTML=`<div class="couponNoticeCard"><button type="button" class="couponNoticeClose" onclick="this.closest('.couponNoticeOverlay').remove()">×</button><span class="couponNoticeEyebrow">ÜYEYE ÖZEL KUPON</span><h3>Hesabınıza kupon tanımlandı</h3><div class="couponNoticeList">${rows.map(c=>{const ex=couponExpiryInfo(c);return `<div class="couponNoticeItem"><div class="couponNoticeCode"><b>${escapeHtml(c.code||'')}</b><button type="button" class="couponCopyBtn" onclick="copyCouponCode('${escapeAttr(c.code||'')}',this)" aria-label="Kupon kodunu kopyala">${couponCopyIcon()}</button></div><strong>${escapeHtml(couponDiscountLabel(c))}</strong>${String(c.title||'').trim()?`<p>${escapeHtml(c.title)}</p>`:''}${couponRulesHtml(c,'couponNoticeRules')}<small class="${ex.urgent?'couponExpiryUrgent':''}">${escapeHtml(ex.text)}</small></div>`}).join('')}</div><button type="button" class="btn" onclick="this.closest('.couponNoticeOverlay').remove();showAccountCoupons()">Kuponlarımı Gör</button></div>`;
  document.body.appendChild(el)
}
async function showAccountCoupons(updateRoute=true){if(updateRoute)syncAccountRoute('/hesabim/kuponlar');try{const r=await apiJson('/api/account/coupons');currentAccountCoupons=Array.isArray(r.coupons)?r.coupons:[];markCouponNotificationsViewed();const rows=sortedAccountCoupons();const html=rows.length?`<div class="accountCouponList">${rows.map(c=>{const ex=couponExpiryInfo(c);return `<div class="accountCouponCard ${c.status!=='active'?'is-muted':''}"><div class="accountCouponMain"><div class="accountCouponCode"><b>${escapeHtml(c.code||'')}</b><button type="button" class="couponCopyBtn" onclick="copyCouponCode('${escapeAttr(c.code||'')}',this)" aria-label="Kupon kodunu kopyala">${couponCopyIcon()}</button></div><span>${escapeHtml(c.title||'Üyeye özel kupon')}</span></div><strong>${escapeHtml(couponDiscountLabel(c))}</strong>${couponRulesHtml(c)}<small class="${ex.urgent?'couponExpiryUrgent':''}">${escapeHtml(ex.text)}</small></div>`}).join('')}</div>`:'<div class="accountEmptyState">Şu anda hesabınıza tanımlı kupon bulunmuyor.</div>';openDrawer(accountStandardPage(`<div class="accountShell accountCenteredSubPage accountTopSubPage"><div class="wizardHead"><button class="pill" onclick="showAccountHome()">← Geri</button><h2>Kuponlarım</h2></div>${html}</div>`,'showAccountHome()'))}catch(e){alert(e.message)}}
function showChangePassword(updateRoute=true){if(updateRoute)syncAccountRoute('/hesabim/sifre');openDrawer(accountStandardPage(`<div class="accountShell accountCenteredSubPage accountTopSubPage"><div class="wizardHead"><button class="pill" onclick="showAccountHome()">← Geri</button><h2>Şifre Değiştir</h2></div><div class="accountForm">${authPasswordField('oldPass','Mevcut şifre','current-password')}${authPasswordField('newPass','Yeni şifre','new-password')}${authPasswordField('newPass2','Yeni şifre tekrar','new-password')}<button class="btn" onclick="changeAccountPassword(this)">Şifreyi Değiştir</button></div></div>`,'showAccountHome()'))}
async function changeAccountPassword(btn){if($('#newPass')?.value!==$('#newPass2')?.value)return alert('Şifreler eşleşmiyor.');try{btn.disabled=true;await apiJson('/api/account/password',{method:'POST',body:JSON.stringify({currentPassword:$('#oldPass')?.value,newPassword:$('#newPass')?.value})});toast('✓ Şifre değiştirildi');showAccountHome()}catch(e){alert(e.message)}finally{btn.disabled=false}}
function confirmLogoutAccount(){if(document.querySelector('.accountLogoutConfirm'))return;const el=document.createElement('div');el.className='accountLogoutConfirm';el.innerHTML=`<div class="accountLogoutConfirmCard"><b>Çıkış yapılsın mı?</b><div><button type="button" onclick="this.closest('.accountLogoutConfirm').remove();logoutAccount()">Evet</button><button type="button" onclick="this.closest('.accountLogoutConfirm').remove()">Hayır</button></div></div>`;document.body.appendChild(el)}
async function logoutAccount(){try{await apiJson('/api/auth/logout',{method:'POST',body:'{}'})}catch{}currentAccountUser=null;currentAccountAddresses=[];currentAccountCoupons=[];checkoutState.appliedCouponIds=[];favorites.clear();setAccountHeaderHint(null);updateAccountHeader();updateCouponNotificationBadges();updateFavoriteBadge();renderProducts($('#search')?.value||'');closeDrawer();history.replaceState({...history.state,shazAccount:false},'','/');window.scrollTo({top:0,left:0,behavior:'auto'});centerToast('✓ Başarıyla çıkış yapıldı')}
toggleFavFromDetail=async function(id){if(!currentAccountUser)return showAuthChoice();try{const active=favorites.has(id);await apiJson('/api/account/favorites/'+encodeURIComponent(id),{method:active?'DELETE':'POST',body:active?undefined:'{}'});active?favorites.delete(id):favorites.add(id);updateFavoriteBadge();renderProducts($('#search')?.value||'');const b=document.getElementById('productDetailFavBtn');if(b){b.textContent=favorites.has(id)?'♥':'♡';b.classList.toggle('active',favorites.has(id))}}catch(e){alert(e.message)}};
const _localToggleFav=toggleFav;
toggleFav=async function(id,e){e?.stopPropagation();if(!currentAccountUser)return showAuthChoice();try{const active=favorites.has(id);await apiJson('/api/account/favorites/'+encodeURIComponent(id),{method:active?'DELETE':'POST',body:active?undefined:'{}'});active?favorites.delete(id):favorites.add(id);updateFavoriteBadge();renderProducts($('#search')?.value||'')}catch(err){alert(err.message)}};
removeFavorite=async function(id){if(!currentAccountUser)return showAuthChoice();try{await apiJson('/api/account/favorites/'+encodeURIComponent(id),{method:'DELETE'});favorites.delete(id);updateFavoriteBadge();renderProducts($('#search')?.value||'');showFavorites()}catch(e){alert(e.message)}};
function favoriteAccountCardsHtml(ps,source){return ps.length?`<div class="memberFavoritesGrid">${ps.map(p=>{const img=mainProductImage(p),account=source==='accountFavorites';return `<div class="memberFavoriteCard"><button type="button" class="memberFavoritePhoto" onclick="openProductDetail('${p.id}','${source}')">${img?`<img src="${escapeAttr(img)}" alt="${escapeAttr(p.name||'Ürün')}">`:'⌚'}</button><div class="memberFavoriteInfo"><b>${escapeHtml(p.name)}</b><span>${money(p.price)}</span><div class="memberFavoriteActions"><button class="smallBtn favoriteUnifiedAction" onclick="openProductDetail('${p.id}','${source}')">Ürünü İncele</button><button class="smallBtn favoriteUnifiedAction" onclick="${account?`removeFavoriteFromAccount('${p.id}')`:`removeFavorite('${p.id}')`}">Favoriden Kaldır</button></div></div></div>`}).join('')}</div>`:'<div class="accountEmptyState">Henüz favori ürününüz bulunmuyor.</div>'}
function showAccountFavorites(updateRoute=true){if(!currentAccountUser)return showLogin(updateRoute);if(updateRoute)syncAccountRoute('/hesabim/favoriler');const ps=catalog.products.filter(p=>favorites.has(p.id)),content=favoriteAccountCardsHtml(ps,'accountFavorites');openDrawer(accountStandardPage(`<div class="accountShell memberFavoritesPage accountCenteredSubPage accountTopSubPage"><div class="wizardHead"><button class="pill" onclick="showAccountHome()">← Geri</button><h2>Favorilerim</h2></div>${content}</div>`,'showAccountHome()'))}
async function removeFavoriteFromAccount(id){try{await apiJson('/api/account/favorites/'+encodeURIComponent(id),{method:'DELETE'});favorites.delete(id);updateFavoriteBadge();renderProducts($('#search')?.value||'');showAccountFavorites(false)}catch(e){alert(e.message)}}
showFavorites=function(){if(!currentAccountUser)return showAuthChoice();const ps=catalog.products.filter(p=>favorites.has(p.id)),content=favoriteAccountCardsHtml(ps,'favorites');openDrawer(accountStandardPage(`<div class="accountShell memberFavoritesPage accountCenteredSubPage accountTopSubPage"><div class="wizardHead"><button class="pill favoritesHomeBack" onclick="closeDrawer()">← Ana Sayfa</button><h2>Favorilerim</h2></div>${content}</div>`,'closeDrawer()'));const d=$('#drawer');if(d)d.dataset.view='favorites-main'};

init();

/* V117 - öneri akışı: çoklu ekleme + kişiselleştirme + net fiyat bilgisi */
let pendingUpsellRule=null;
function cartHasUpsellTrigger(rule){const ids=new Set(rule.triggerProductIds||[]);return cart.some(x=>x?.product&&x.product.category===rule.triggerCategoryId&&((rule.triggerMode||'all')==='all'||ids.has(x.product.id)))}
function upsellSpecialPrice(rule,p){const v=rule?.productPrices?.[p?.id];return v!==undefined&&v!==null&&v!==''?Math.max(0,Number(v||0)):Math.max(0,Number(rule?.specialPrice||0))}
function eligibleUpsellProducts(rule){const ids=new Set(rule.offerProductIds||[]);return (catalog.products||[]).filter(p=>!p.hidden&&!p.soldOutEnabled&&p.category===rule.offerCategoryId&&((rule.offerMode||'all')==='all'||ids.has(p.id)))}
function findCheckoutUpsell(){return (catalog.checkoutUpsells||[]).find(r=>r&&r.enabled!==false&&r.triggerCategoryId&&r.offerCategoryId&&Number(r.specialPrice||0)>=0&&cartHasUpsellTrigger(r)&&eligibleUpsellProducts(r).length)}
function proceedToAddressWithUpsell(){if(currentAccountUser&&activeAccountCoupons().length&&!(checkoutState.appliedCouponIds||[]).length&&!checkoutState.couponSkipConfirmed)return showUnusedCouponConfirm();proceedToAddressWithUpsellConfirmed()}
function proceedToAddressWithUpsellConfirmed(){const r=findCheckoutUpsell();if(!r)return addressStep();pendingUpsellRule=r;showCheckoutUpsell(r)}
function showUnusedCouponConfirm(){document.querySelector('.couponSkipConfirm')?.remove();const el=document.createElement('div');el.className='couponSkipConfirm';el.innerHTML=`<div class="couponSkipConfirmCard"><b>İndirim kuponu kullanmadınız</b><p>Hesabınızda kullanılabilir kupon bulunuyor. Kullanmak ister misiniz?</p><div><button type="button" onclick="this.closest('.couponSkipConfirm').remove();checkoutState.couponPanelOpen=true;checkout()">Evet</button><button type="button" onclick="this.closest('.couponSkipConfirm').remove();checkoutState.couponSkipConfirmed=true;proceedToAddressWithUpsellConfirmed()">Hayır</button></div></div>`;document.body.appendChild(el)}
function showCheckoutUpsell(r){
 const ps=eligibleUpsellProducts(r),cat=(catalog.categories||[]).find(c=>c.id===r.offerCategoryId),catName=String(cat?.name||'ürün').trim().replace(/ler$|lar$/iu,'').toLocaleLowerCase('tr-TR');
 openDrawer(`<div class="checkoutShell checkoutUpsellShell"><div class="checkoutStickyTop"><div class="checkoutTop upsellHero"><div><span class="checkoutEyebrow">SİZE ÖZEL FIRSAT</span><h2>Setinize ekstra ${escapeHtml(catName)} eklemek ister misiniz?</h2><p>İstediğiniz kadar ürün ekleyebilirsiniz. Her eklemeden sonra güncel toplamınızı göreceksiniz.</p></div></div><div class="checkoutBackRow"><button type="button" class="checkoutBackBtn" onclick="checkout()">← Sepete dön</button></div></div><div class="checkoutScrollBody"><div class="checkoutUpsellGrid">${ps.map(p=>{const img=mainProductImage(p);return `<article class="checkoutUpsellCard" onclick="openUpsellProduct('${escapeAttr(p.id)}')">${img?`<img src="${escapeAttr(img)}" alt="${escapeAttr(p.name||'Ürün')}">`:''}<div class="checkoutUpsellInfo"><b>${escapeHtml(p.name||'Ürün')}</b><div class="checkoutUpsellPrices"><span class="checkoutUpsellOld">${money(p.price)}</span><strong>${money(upsellSpecialPrice(r,p))}</strong></div><button class="btn" onclick="event.stopPropagation();addCheckoutUpsell('${escapeAttr(p.id)}')">Sepete Ekle</button></div></article>`}).join('')}</div></div><div class="checkoutStickyBottom checkoutUpsellBottom"><button type="button" class="pill checkoutUpsellNo" onpointerdown="event.preventDefault()" onclick="event.preventDefault();event.stopPropagation();skipCheckoutUpsell()">Hayır, istemiyorum</button></div></div>`)
}
function openUpsellProduct(id){const r=pendingUpsellRule,p=(catalog.products||[]).find(x=>x.id===id);if(!r||!p)return;const special=upsellSpecialPrice(r,p),original=p.price;p.price=special;openProductDetail(id,'upsell');p.price=original}
function upsellCartTotal(){normalizeCartPersonalizationFees();return calculateCartCampaigns().total}
function addCheckoutUpsell(productId){
 const r=pendingUpsellRule,p=(catalog.products||[]).find(x=>x.id===productId);if(!r||!p)return;const special=upsellSpecialPrice(r,p),before=upsellCartTotal();
 const offered={...p,price:special};
 if(writeAvailable(p)&&!p.isSet){return showUpsellPersonalization(offered,r,before)}
 finalizeUpsellAdd(offered,r,before,null)
}
function showUpsellPersonalization(p,r,before){const fee=nextSingleWriteFee();openDrawer(`<div class="wizardHead"><button class="pill backPill" onclick="showCheckoutUpsell(pendingUpsellRule)">← Geri</button><div><div class="wizardProgress">Özel fırsat</div><h2>${escapeHtml(p.name)}</h2></div></div><div class="wizardCard"><h3>${escapeHtml(p.name)} ürününüze yazı yazdırmak ister misiniz?</h3><p class="muted">Sepetinizdeki kişiselleştirme sırasına göre bu ürün için yazı ücreti <b>+${money(fee)}</b>.</p><div class="choiceStack"><button class="choiceBtn" onclick="finalizeUpsellAdd(catalog.products.find(x=>x.id==='${escapeAttr(p.id)}'),pendingUpsellRule,${before},null,true)">Hayır, yazısız ekle</button><button class="choiceBtn primary" onclick="showUpsellWriteForm('${escapeAttr(p.id)}',${before})">Evet, yazı yazdır</button></div></div>`)}
function showUpsellWriteForm(id,before){const base=(catalog.products||[]).find(x=>x.id===id),r=pendingUpsellRule;if(!base||!r)return;const p={...base,price:upsellSpecialPrice(r,base)},fee=nextSingleWriteFee(),positions=defaultPositionsForProduct(base);openDrawer(`<div class="wizardHead"><button class="pill backPill" onclick="showUpsellPersonalization({...catalog.products.find(x=>x.id==='${escapeAttr(id)}'),price:${p.price}},pendingUpsellRule,${before})">← Geri</button><div><h2>${escapeHtml(p.name)}</h2></div></div><div class="writeItem"><div class="positionChoices">${positions.map((x,i)=>positionOptionHtml('upsellPos',x,i,p.preferredWritePosition)).join('')}</div><input class="writeInput" id="upsellText" placeholder="Yazdırmak istediğiniz yazıyı girin"></div><div class="wizardBottomAction"><button class="btn" onclick="finishUpsellWrite('${escapeAttr(id)}',${before})">Sepete Ekle · +${money(fee)}</button></div>`)}
function finishUpsellWrite(id,before){const base=(catalog.products||[]).find(x=>x.id===id),r=pendingUpsellRule,text=$('#upsellText')?.value.trim(),pos=document.querySelector('input[name=upsellPos]:checked')?.value;if(!text)return alert('Lütfen yazdırmak istediğiniz yazıyı girin.');const fee=nextSingleWriteFee(),special=upsellSpecialPrice(r,base);finalizeUpsellAdd({...base,price:special+fee},r,before,{item:base.name,position:pos,text,fee},false,special)}
function finalizeUpsellAdd(p,r,before,write=null,restoreSpecial=false,baseSpecial=null){if(restoreSpecial){const base=(catalog.products||[]).find(x=>x.id===p.id);p={...base,price:upsellSpecialPrice(r,base)}}const special=baseSpecial??Number(p.price||0);cart.push({product:p,basePrice:special,qty:1,personalized:!!write,writes:write?[write]:[],upsell:{ruleId:r.id,normalPrice:Number((catalog.products||[]).find(x=>x.id===p.id)?.price||0),specialPrice:special}});updateCart();showUpsellAdded(p,before)}
function showUpsellAdded(p,before){const after=upsellCartTotal();openDrawer(`<div class="checkoutShell upsellAddedShell"><div class="wizardCard upsellAddedCard"><span class="checkoutEyebrow">ÜRÜNÜNÜZ SEPETE EKLENDİ</span><h2>${escapeHtml(p.name)}</h2><div class="upsellTotalChange"><span>Önceki toplam <b>${money(before)}</b></span><span>Güncel toplam <strong>${money(after)}</strong></span></div><div class="choiceStack"><button class="choiceBtn primary" onclick="showCheckoutUpsell(pendingUpsellRule)">Bir adet daha almak istiyorum</button><button class="choiceBtn" onclick="skipCheckoutUpsell()">Teslimat bilgilerine geç</button></div></div></div>`)}
function skipCheckoutUpsell(){pendingUpsellRule=null;addressStep()}


/* V118 — tükendi geri sayımı saniyelik canlı güncelleme */
setInterval(()=>{document.querySelectorAll('[data-soldout-id]').forEach(el=>{const p=(catalog.products||[]).find(x=>x.id===el.dataset.soldoutId);if(p)el.textContent=soldOutRemaining(p)})},1000);
