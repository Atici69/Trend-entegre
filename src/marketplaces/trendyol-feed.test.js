import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTrendyolFeed, validateTrendyolProduct } from './trendyol-feed.js';

const validSource = {
  'Ürün Adı': '925 Ayar Gümüş Bileklik',
  'Barkod': '8691234567890',
  SKU: 'SKU-1',
  'Marka': 'Örnek Marka',
  'Kategori': 'Bileklik',
  'Satış Fiyatı': '1250.00',
  Stok: '5',
  'Görsel URL': 'https://example.com/product.webp',
  Açıklama: 'Ürün açıklaması',
};

test('Trendyol validation blocks missing category, brand and attributes mapping', () => {
  const result = validateTrendyolProduct(validSource);
  assert.equal(result.ready, false);
  assert.ok(result.errors.some(item => item.includes('kategori')));
  assert.ok(result.errors.some(item => item.includes('marka eşleştirmesi')));
});

test('Trendyol validation accepts a product with explicit marketplace mappings', () => {
  const result = validateTrendyolProduct(validSource, {
    categoryId: '123',
    brandId: '456',
    attributes: [{ attributeId: 1, attributeValueId: 2 }],
  });
  assert.equal(result.ready, true);
  assert.equal(result.normalized.salePrice, 1250);
  assert.equal(result.normalized.currencyType, 'TRY');
});

test('Trendyol feed validation flags duplicate barcodes', () => {
  const report = validateTrendyolFeed([validSource, { ...validSource, SKU: 'SKU-2' }], {
    Bileklik: { categoryId: '123', brandId: '456', attributes: [{ attributeId: 1, attributeValueId: 2 }] },
  });
  assert.equal(report.total, 2);
  assert.equal(report.ready, 1);
  assert.equal(report.blocked, 1);
  assert.ok(report.rows[1].errors.some(item => item.includes('Aynı barkod')));
});
