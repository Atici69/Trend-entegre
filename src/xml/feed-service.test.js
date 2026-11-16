import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProducts, clampProductLimit } from './feed-service.js';

test('parses common supplier product fields and namespaced XML tags', () => {
  const xml = `<?xml version="1.0"?>
  <rss><channel><item>
    <g:id>SKU-100</g:id><g:title>Test Ürün</g:title>
    <g:price>125.50 TRY</g:price><g:availability>in_stock</g:availability>
    <g:image_link>https://cdn.example.com/image.jpg</g:image_link>
    <g:brand>Örnek Marka</g:brand><g:description>Açıklama</g:description>
  </item></channel></rss>`;
  const [product] = parseProducts(xml);
  assert.equal(product['Ürün ID'], 'SKU-100');
  assert.equal(product['Ürün Adı'], 'Test Ürün');
  assert.equal(product['Fiyat'], '125.50 TRY');
  assert.equal(product['Görsel URL'], 'https://cdn.example.com/image.jpg');
  assert.equal(product['Marka'], 'Örnek Marka');
});

test('parses Turkish supplier tags and multiple products', () => {
  const xml = `<Urunler><Urun><UrunKodu>U-1</UrunKodu><UrunAdi>Birinci</UrunAdi><Barkod>8690000000001</Barkod><Stok>4</Stok><Fiyat>10</Fiyat></Urun><Urun><UrunKodu>U-2</UrunKodu><UrunAdi>İkinci</UrunAdi><StokAdedi>8</StokAdedi></Urun></Urunler>`;
  const products = parseProducts(xml);
  assert.equal(products.length, 2);
  assert.equal(products[0]['Ürün Adı'], 'Birinci');
  assert.equal(products[0].Barkod, '8690000000001');
  assert.equal(products[1].Stok, '8');
});

test('rejects DTD and external entity declarations', () => {
  const xml = `<!DOCTYPE products [<!ENTITY x SYSTEM "file:///etc/passwd">]><products><product><name>&x;</name></product></products>`;
  assert.throws(() => parseProducts(xml), /DTD|varlıkları/);
});

test('rejects invalid XML and feeds without product entries', () => {
  assert.throws(() => parseProducts('<products><product></products>'), /geçersiz/i);
  assert.throws(() => parseProducts('<catalog><brand>Only metadata</brand></catalog>'), /Ürün kayıtları/);
});

test('enforces export limits and supports all up to the product ceiling', () => {
  assert.equal(clampProductLimit('10', 30), 10);
  assert.equal(clampProductLimit('all', 6000), 5000);
  assert.throws(() => clampProductLimit('11', 30), /Ürün adedi/);
});
