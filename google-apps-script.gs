/**
 * SHAZ — Google E-Tablo kalıcı sipariş kaydı
 *
 * Bu kod Google E-Tablo > Uzantılar > Apps Script içine yapıştırılır.
 * Script Properties içinde SHAZ_WEBHOOK_SECRET anahtarı tanımlanmalıdır.
 *
 * Görünen düzen:
 * A: müşterinin 8 satırlık sipariş fişi
 * B: SİPARİŞ
 * C: ADET
 * D: HAZIR MI
 * E: KARGOYA VERİLDİ Mİ
 *
 * F:G:H sistem alanlarıdır ve otomatik gizlenir:
 * F = Sipariş kodu
 * G = Sipariş tarihi
 * H = Tekilleştirme requestId
 */

const SHEET_NAME = 'Siparişler';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents || '{}');
    const expected = PropertiesService.getScriptProperties().getProperty('SHAZ_WEBHOOK_SECRET');
    if (!expected || data.secret !== expected) {
      return json_({ok:false, message:'Yetkisiz istek.'});
    }

    if (data.action === 'ping') return json_({ok:true, version:'V70', sheet:SHEET_NAME});
    if (data.action === 'create') return createOrder_(data);
    if (data.action === 'status') return updateStatus_(data);

    return json_({ok:false, message:'Geçersiz işlem.'});
  } catch (err) {
    return json_({ok:false, message:String(err && err.message || err)});
  }
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.getRange('A1:H1').setValues([[
      '', 'SİPARİŞ', 'ADET', 'HAZIR MI', 'KARGOYA VERİLDİ Mİ',
      'SİSTEM_KODU', 'SİPARİŞ_TARİHİ', 'REQUEST_ID'
    ]]);
    sh.getRange('A1:H1')
      .setFontWeight('bold')
      .setHorizontalAlignment('center')
      .setBackground('#e7e7e7');

    sh.setColumnWidth(1, 310);
    sh.setColumnWidth(2, 380);
    sh.setColumnWidth(3, 75);
    sh.setColumnWidth(4, 110);
    sh.setColumnWidth(5, 150);
  }

  sh.hideColumns(6, 3);
  sh.setFrozenRows(1);
  return sh;
}

function createOrder_(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheet_();
    const requestId = String(data.requestId || '');
    if (!requestId) throw new Error('requestId eksik.');

    // Aynı sipariş ağ hatası nedeniyle yeniden gönderilirse ikinci kez yazma.
    const last = sh.getLastRow();
    if (last >= 2) {
      const reqIds = sh.getRange(2, 8, last - 1, 1).getValues().flat();
      const pos = reqIds.indexOf(requestId);
      if (pos >= 0) {
        const existingId = String(sh.getRange(pos + 2, 6).getValue());
        return json_({ok:true, id:existingId, duplicate:true});
      }
    }

    const order = data.order || {};
    const id = String((data.order||{}).id || '') || nextOrderId_(sh);
    const customerNo = Number(id.replace(/^SHZ/i,'')) || 1;
    const c = order.customer || {};
    const details = orderDetails_(order);

    // 1 müşteri = başlık + 8 bilgi satırı + ayırıcı.
    // Sayfada önceden hazırlanmış / birleştirilmiş boş bloklar bulunabiliyor.
    // Bir sonraki bloğu kullanmadan önce yalnızca o bloğun birleşimlerini çözüyoruz.
    // Böylece "birleştirilen aralıktaki tüm hücreleri seçmelisiniz" hatası oluşmaz.
    const headerRow = nextHeaderRow_(sh);
    const start = headerRow + 1;
    const separatorRow = start + 8;
    ensureRows_(sh, separatorRow);
    prepareOrderBlock_(sh, headerRow, separatorRow);

    sh.getRange(headerRow,1,1,5).merge();
    sh.getRange(headerRow,1)
      .setValue(customerNo + '. MÜŞTERİ • ' + id + ' • ' + String(order.createdAtTR || ''))
      .setFontWeight('bold')
      .setHorizontalAlignment('left')
      .setVerticalAlignment('middle')
      .setBackground('#d9d9d9');

    const left = [
      String(c.fullName || ''),
      phoneNumber_(c.phone), // ikinci telefon kasıtlı olarak yazılmaz
      fullAddress_(c),
      [c.province, c.district].filter(Boolean).join(' '),
      Number(order.total || 0).toLocaleString('tr-TR') + ' TL',
      paymentText_(order.payment),
      '@',
      details
    ];

    const rows = left.map((v, i) => [
      v,
      i === 0 ? details : '',
      i === 0 ? itemCount_(order) : '',
      '',
      '',
      i === 0 ? id : '',
      i === 0 ? String(order.createdAtTR || '') : '',
      i === 0 ? requestId : ''
    ]);
    sh.getRange(start, 1, 8, 8).setValues(rows);

    // Sipariş açıklaması ve adet alanları blok boyunca tek parça.
    sh.getRange(start,2,8,1).merge();
    sh.getRange(start,3,8,1).merge();

    // D/E birleşik değil: ortadaki hücre gerçek tıklanabilir Google checkbox.
    const checkboxRow = start + 3;
    sh.getRange(checkboxRow,4).insertCheckboxes().setValue(false);
    sh.getRange(checkboxRow,5).insertCheckboxes().setValue(false);

    sh.getRange(start,1,8,1)
      .setBackground('#93c47d')
      .setFontWeight('bold')
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle')
      .setWrap(true);

    sh.getRange(start,2,8,4)
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle')
      .setWrap(true);

    sh.getRange(start,1,8,5)
      .setBorder(true,true,true,true,true,true,'#6b6b6b',SpreadsheetApp.BorderStyle.SOLID);

    // Fotoğraf bağlantıları setValues ile düz metin kalabildiği için URL parçalarını
    // gerçek tıklanabilir RichText bağlantısına dönüştürüyoruz.
    setRichTextLinks_(sh.getRange(start,2), details);
    setRichTextLinks_(sh.getRange(start+7,1), details);

    sh.setRowHeights(start,7,22);
    sh.setRowHeight(start+7,38);
    sh.setRowHeight(headerRow,24);

    // Belirgin müşteri ayırıcı satırı.
    sh.getRange(separatorRow,1,1,5).merge();
    sh.getRange(separatorRow,1)
      .setValue('')
      .setBackground('#b7b7b7');
    sh.setRowHeight(separatorRow,10);

    // Görünümü bozmadan sipariş tarihi not olarak da durur.
    sh.getRange(start,1).setNote('Sipariş: '+id+'\nTarih: '+String(order.createdAtTR||''));

    return json_({ok:true, id:id});
  } finally {
    lock.releaseLock();
  }
}


function ensureRows_(sh, lastNeededRow) {
  if (lastNeededRow <= sh.getMaxRows()) return;
  sh.insertRowsAfter(sh.getMaxRows(), lastNeededRow - sh.getMaxRows() + 20);
}

function nextHeaderRow_(sh) {
  // Hazır şablonda aşağıda biçimlendirilmiş boş bloklar bulunduğu için getLastRow()+1
  // tek başına güvenilir değildir. A sütunundaki gerçek müşteri başlıklarını bulup
  // bir sonraki 10 satırlık bloğa geçiyoruz: başlık + 8 satır + ayırıcı.
  const max = Math.max(2, sh.getLastRow());
  const vals = sh.getRange(2, 1, max - 1, 1).getDisplayValues().flat();
  let lastHeader = 0;
  vals.forEach((v, i) => {
    if (/MÜŞTERİ/i.test(String(v || ''))) lastHeader = i + 2;
  });
  if (lastHeader) return lastHeader + 10;
  return 2;
}

function prepareOrderBlock_(sh, headerRow, separatorRow) {
  // block.breakApart() bazı hazır şablon birleşimlerinde kısmi kesişim hatası verebiliyor.
  // Bu yüzden yalnızca gerçekten kesişen birleşik aralıkları kendi tam aralıkları üzerinden ayırıyoruz.
  const rowCount = separatorRow - headerRow + 1;
  const block = sh.getRange(headerRow, 1, rowCount, 8);
  const merges = block.getMergedRanges();
  merges.forEach(r => r.breakApart());
  block.clearContent();
  block.clearNote();
  sh.getRange(headerRow, 4, rowCount, 2).clearDataValidations();
}

function phoneNumber_(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const normalized = /^05\d{9}$/.test(digits) ? digits.slice(1) : digits;
  return /^5\d{9}$/.test(normalized) ? Number(normalized) : String(value || '');
}

function setRichTextLinks_(range, text) {
  const value = String(text || '');
  if (!value) return;
  const builder = SpreadsheetApp.newRichTextValue().setText(value);
  const regex = /https?:\/\/[^\s|]+/g;
  let match;
  while ((match = regex.exec(value)) !== null) {
    let url = match[0].replace(/[),.;]+$/g, '');
    const start = match.index;
    const end = start + url.length;
    if (end > start) {
      const linkStyle = SpreadsheetApp.newTextStyle().setForegroundColor('#1155cc').setUnderline(true).build();
      builder.setLinkUrl(start, end, url).setTextStyle(start, end, linkStyle);
    }
  }
  range.setRichTextValue(builder.build());
}

function updateStatus_(data) {
  const ids = Array.isArray(data.ids) ? data.ids.map(String) : [];
  const status = String(data.status || '');
  if (!['new','prepared','shipped'].includes(status)) throw new Error('Geçersiz durum.');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheet_();
    const last = sh.getLastRow();
    if (last < 2) return json_({ok:true, updated:0});

    const idValues = sh.getRange(2,6,last-1,1).getValues().flat().map(String);
    let updated = 0;

    ids.forEach(id => {
      const idx = idValues.indexOf(id);
      if (idx < 0) return;

      // F'deki sipariş kodu 8 bilgi satırının ilk satırındadır.
      const orderStartRow = idx + 2;
      const checkboxRow = orderStartRow + 3;

      const ready = status === 'prepared' || status === 'shipped';
      const shipped = status === 'shipped';

      sh.getRange(checkboxRow,4).setValue(ready);
      sh.getRange(checkboxRow,5).setValue(shipped);
      updated++;
    });

    return json_({ok:true, updated:updated});
  } finally {
    lock.releaseLock();
  }
}

function nextOrderId_(sh) {
  const props = PropertiesService.getScriptProperties();
  let counter = Number(props.getProperty('SHAZ_ORDER_COUNTER') || 0);

  // İlk kurulumda mevcut gizli F sütunundaki en yüksek SHZ numarasını da hesaba kat.
  if (!counter && sh.getLastRow() >= 2) {
    const ids = sh.getRange(2,6,sh.getLastRow()-1,1).getValues().flat();
    counter = ids.reduce((m,id)=>{
      const n = Number(String(id||'').replace(/^SHZ/i,''));
      return Number.isFinite(n) ? Math.max(m,n) : m;
    },0);
  }

  counter += 1;
  props.setProperty('SHAZ_ORDER_COUNTER', String(counter));
  return 'SHZ' + counter;
}

function paymentText_(payment) {
  const p = String(payment || '').toLowerCase();
  if (p === 'cod' || p.includes('kapıda') || p.includes('cash')) return 'kapıda nakit';
  if (p.includes('iban') || p.includes('havale') || p.includes('transfer') || p === 'online' || p === 'bank') return 'havale';
  return p;
}

function fullAddress_(c) {
  if (c.deliveryMode === 'branch') return ('ARAS KARGO ŞUBE TESLİM — ' + (c.branchName || '')).trim();
  if (c.fullAddress) return [c.neighborhood, c.fullAddress].filter(Boolean).join(' ');
  const road = [c.neighborhood, c.avenue, c.street].filter(Boolean).join(' ');
  const nums = [
    c.buildingNo ? 'no:' + c.buildingNo : '',
    c.floor ? 'kat:' + c.floor : '',
    c.doorNo ? 'daire:' + c.doorNo : ''
  ].filter(Boolean).join(' ');
  const biz = c.placeType === 'business' && c.businessName ? ' ' + c.businessName : '';
  return [road, nums].filter(Boolean).join(' ') + biz;
}

function itemCount_(o) {
  return (o.items || []).reduce((n,x)=>n + Math.max(1, Number(x.qty || 1)), 0) || 1;
}

function orderDetails_(o) {
  const lines = [];
  (o.items || []).forEach(x => {
    const name = x.product && x.product.name ? x.product.name : 'Ürün';
    const internalCode = String((x.product && x.product.internalCode) || '').trim();
    let line = internalCode ? (name + ' | ' + internalCode) : name;

    // Hazır seti parçalara ayırmıyoruz; yalnızca çıkarılan varsa ekliyoruz.
    if (x.setCustomization) {
      const removed = (x.setCustomization.removedIds || [])
        .map(id => ((x.product && x.product.setItems) || []).find(s => s.id === id))
        .filter(Boolean)
        .map(s => s.name);
      if (removed.length) line += ' | Çıkarılan ürünler (' + removed.join(', ') + ')';
    }

    const writes = x.writes || (x.setCustomization && x.setCustomization.writes) || [];
    if (writes.length) {
      const w = writes.map(a => {
        const item = a.item || name;
        const pos = a.position ? ' (' + a.position + ')' : '';
        return item + ': ' + (a.text || '') + pos;
      });
      line += ' | Yazı: ' + w.join(' | ');
    }

    if (String(x.productNote || '').trim()) line += ' | Ürün notu: ' + String(x.productNote).trim();

    const photos = x.photoCustomizations || (x.setCustomization && x.setCustomization.photoCustomizations) || [];
    if (photos.length) {
      const p = photos.map(a => {
        const item = a.item || name;
        const caption = a.caption ? ' | Fotoğraf yazısı (' + (a.captionPosition === 'above' ? 'üstte' : 'altta') + '): ' + a.caption : '';
        return item + ': ' + String(a.imageUrl || '') + caption;
      });
      line += ' | Fotoğraf: ' + p.join(' | ');
    }

    lines.push(line);
  });
  return lines.join(' + ') || 'Ürün';
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
