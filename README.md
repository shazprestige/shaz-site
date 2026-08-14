SHAZ PC v18

Bu sürümde yönetim paneli ve sipariş sistemi ciddi şekilde sadeleştirildi.

SİPARİŞ:
- Müşteriden ad soyad, telefon, ek telefon, il, ilçe, mahalle, cadde/sokak, bina no, kat, ev/iş yeri bilgisi alınır.
- Cadde veya sokaktan en az biri zorunludur.
- İş yeri seçilirse iş yeri adı zorunludur.
- Siparişe Türkiye tarih-saat bilgisi ayrıca kaydedilir.
- Yönetim panelinde ürün, set içeriği, setten çıkarılan ürünler, yazdırılacak metin, yazı konumu ve ücret görünür.

YÖNETİM:
Sadece 4 ana menü:
1. Site Ayarları
2. Kategoriler & Ürünler
3. Setler & Kişiselleştirme
4. Siparişler

- Ürün ekleme ayrı yerde değildir; kategori kartının hemen içindedir.
- Ürünler panelde yan yana kartlar halinde görünür.
- Fotoğraf PC'den yüklenir, uploads klasörüne kaydolur ve ürüne otomatik bağlanır.
- Canlı mobil önizleme, düzenlediğin alana otomatik kayar.


V20 EXCEL FORMAT:
- Her müşteri 8 satırdır.
- 1 Ad Soyad
- 2 Telefon (ek telefon Excel'e alınmaz)
- 3 Adres
- 4 İl + İlçe
- 5 Toplam + TL
- 6 kapıda nakit / havale
- 7 @
- 8 Ürünler + kişiselleştirme
- Sağda SİPARİŞ, ADET, HAZIR MI, KARGOYA VERİLDİ Mİ alanları vardır.


V21:
- Sipariş oluşturma ve kişiselleştirme adımlarına geri dönüş geçmişi eklendi.
- Müşteri yanlışlıkla "yazı istemiyorum", ürün çıkarma, adres, kargo bilgilendirme vb. adımlarda karar değiştirirse önceki ekrana dönebilir.
- Kendi Setini Oluştur içindeki mevcut Geri butonları korunur.
- Kapatınca geçmiş temizlenir; yeni siparişte eski adımlara dönülmez.


V23 SIPARIS OZET DUZELTMESI
- Hazır set siparişi Excel'de artık set parçalarına ayrılmaz.
- Örn: "3'lü Özel Set" siparişi "Saat + Çakmak + Cüzdan..." olarak görünmez; doğrudan "3'lü Özel Set" yazar.
- Setten ürün çıkarılmışsa sadece "Çıkarılan: Kemer" gibi ek bilgi görünür.
- Kişiye özel yazı varsa sadece ilgili yazı/konum bilgisi eklenir.
- ADET sütunu set içindeki ürün sayısını değil, satın alınan satış adedini gösterir. Bir set = 1 adet.
- Yönetim panelindeki Sipariş İçeriği de aynı sade kurala geçirildi.


V24 EXCEL AKTARIM TAKIBI
- Excel dosyasının ilk satırında indirme/aktarma tarih ve saati (Türkiye saati) yazar.
- Dosya adı da tarih-saat içerir.
- Excel'e giren tüm siparişler orders.json içinde excelExportedAt / excelExportedAtTR ile işaretlenir.
- Yönetim panelinde her siparişte:
  * Excel’e Aktarılmadı
  * veya Excel’e Aktarıldı · tarih saat
  etiketi görünür.
- Yeni gelen sipariş otomatik olarak "Excel’e Aktarılmadı" görünür.
- Sipariş filtresine "Excel’e Aktarılmadı" ve "Excel’e Aktarıldı" seçenekleri eklendi.
- Excel indirildikten sonra panel otomatik yenilenir.


V25
- Siparişler ekranında sağdaki “Müşteri Gözüyle Canlı Önizleme” tamamen kaldırıldı.
- Siparişler bölümü sağdaki boş alanı da kullanarak genişledi.
- Canlı önizleme yalnızca Site Ayarları / Kategoriler & Ürünler / Setler & Kişiselleştirme ekranlarında kalır.


V26
- Canlı müşteri önizlemesi Site Ayarları / Kategoriler & Ürünler / Setler & Kişiselleştirme ekranlarında yeniden büyütüldü.
- Önizleme yaklaşık 390x780 telefon oranına getirildi.
- Siparişler ekranında önizleme yine tamamen kapalı ve sipariş alanı tam geniş.


V27
- Sağdaki canlı müşteri telefonu soldaki yönetim sayfasından bağımsız sticky hale getirildi.
- Solda aşağı/yukarı inerken sağ telefon kendi yerinde kalır.
- Bir ayarı düzenlerken önizleme otomatik olarak ilgili gerçek müşteri alanına kayar.
- İlgili alan kırmızı çerçeveyle vurgulanır.
- Ürün kartı düzenleniyorsa ilgili ürün kartı kırmızı çerçevelenir.
- Ana başlık, slogan, kayan yazı, Kargom Nerede, WhatsApp ve Instagram kendi alanında vurgulanır.
- Siparişler ekranında canlı önizleme yine kapalıdır.


V28 MILIMETRIK CANLI ONIZLEME
- Sağ önizleme artık her tuş vuruşunda kaydırılmaz.
- Otomatik kaydırma yalnızca yönetim alanına ilk odaklanıldığında 1 kez yapılır.
- Yazı/fiyat/stok değiştirilirken sağ önizleme yerinde sabit kalır; yalnızca içerik güncellenir.
- Sol yönetim ekranının scroll konumu değişiklik sırasında korunur.
- Ürün kartında hedefler ayrıldı:
  * Ürün adı -> yalnızca ürün adı
  * Fiyat -> yalnızca güncel fiyat
  * Eski fiyat -> yalnızca üstü çizili eski fiyat
  * Stok -> yalnızca stok satırı
  * Etiket -> yalnızca etiket
  * Fotoğraf -> yalnızca fotoğraf alanı
- Önizleme içi kaydırma smooth değil, deterministik window.scrollTo ile tam merkeze yapılır.
- Kırmızı çerçeve kartın tamamını değil gerçek düzenlenen elemanın kendi boyutunu sarar.


V29
- Mouse hareketi artık canlı önizleme hedefini değiştirmez.
- Sağ telefon tıklanamaz ve elle kaydırılamaz; sadece soldaki odak alanı kontrol eder.
- Kategori adı/sırası yalnızca ilgili kategori sekmesini hedefler.
- Fiyat yalnızca fiyatı, stok yalnızca stoğu, ürün adı yalnızca ürün adını, etiket yalnızca etiketi hedefler.
- Ürün aktif kategoride görünmüyorsa önizleme otomatik Tüm Ürünler'e geçer.
- Hedef zaten görünüyorsa sağ ekran hiç kaymaz.
- Hedef üst sabit paneldeyse dikey kaydırma yapılmaz.
- Uzun kategori isimleri ellipsis ile sınırlandırılır; üst üste binme yapmaz.
