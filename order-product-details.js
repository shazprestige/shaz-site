'use strict';
const orderProducts=o=>{
  const blocks=[];
  (o.items||[]).forEach(x=>{
    const name=x.product?.name||'Ürün';
    const internalCode=String(x.product?.internalCode||'').trim();
    const title=internalCode?`${name} | ${internalCode}`:name;
    const lines=[title];
    if(x.setCustomization){
      const setItems=Array.isArray(x.product?.setItems)?x.product.setItems:[];
      const keptIds=Array.isArray(x.setCustomization.keptIds)?x.setCustomization.keptIds:[];
      const removedIds=Array.isArray(x.setCustomization.removedIds)?x.setCustomization.removedIds:[];
      const removed=setItems.filter(it=>removedIds.includes(it.id)).map(it=>it.name).filter(Boolean);
      if(removed.length){
        const sent=(keptIds.length?setItems.filter(it=>keptIds.includes(it.id)):setItems.filter(it=>!removedIds.includes(it.id))).map(it=>it.name).filter(Boolean);
        if(sent.length)lines.push(`• Gönderilecek ürünler: ${sent.join(', ')} (Çıkarılan ürünler: ${removed.join(', ')})`);
      }
    }
    const writes=x.writes||x.setCustomization?.writes||[];
    writes.forEach(w=>{
      const item=w.item||name;
      const pos=w.position?` (${w.position})`:'';
      lines.push(`• Yazı — ${item}: “${w.text||''}”${pos}`);
    });
    const photos=x.photoCustomizations||x.setCustomization?.photoCustomizations||[];
    photos.forEach(ph=>{
      const item=ph.item||name;
      const caption=ph.caption?` · Fotoğraf yazısı (${ph.captionPosition==='above'?'üstte':'altta'}): ${ph.caption}`:'';
      lines.push(`• Fotoğraf — ${item}: ${ph.imageUrl||''}${caption}`);
    });
    blocks.push(lines.join('\n'));
  });
  return blocks.join('\n\n')||'Ürün';
 };

module.exports={orderProducts};
