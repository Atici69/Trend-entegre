const REQUIRED_FIELDS = ['barcode', 'title', 'productMainId', 'brandId', 'categoryId', 'quantity', 'stockCode', 'dimensionalWeight', 'description', 'currencyType', 'listPrice', 'salePrice', 'vatRate', 'images', 'attributes'];

function numeric(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateTrendyolProduct(source, mapping = {}) {
  const errors = [];
  const warnings = [];
  const title = String(source['Ürün Adı'] || '').trim();
  const barcode = String(source['Barkod'] || '').trim();
  const sku = String(source.SKU || '').trim();
  const brand = String(source['Marka'] || '').trim();
  const category = String(mapping.categoryId || '').trim();
  const brandId = String(mapping.brandId || '').trim();
  const salePrice = numeric(source['Satış Fiyatı'] ?? source['Fiyat']);
  const stock = numeric(source.Stok);
  const image = String(source['Görsel URL'] || '').trim();
  const description = String(source.Açıklama || '').trim();
  const dimensionalWeight = numeric(source['Desi'] ?? source.dimensionalWeight);
  const vatRate = numeric(source['KDV Oranı'] ?? source.vatRate);

  if (!title) errors.push('Ürün adı eksik.');
  if (!barcode) errors.push('Barkod eksik.');
  if (!sku) errors.push('Stok kodu (SKU) eksik.');
  if (!brand) errors.push('Marka eksik.');
  if (!brandId) errors.push('Trendyol marka eşleştirmesi yapılmamış.');
  if (!category) errors.push('Trendyol kategori eşleştirmesi yapılmamış.');
  if (salePrice === null || salePrice <= 0) errors.push('Geçerli satış fiyatı bulunamadı.');
  if (stock === null || stock < 0 || !Number.isInteger(stock)) errors.push('Stok miktarı geçerli bir tam sayı olmalıdır.');
  if (dimensionalWeight === null || dimensionalWeight <= 0) errors.push('Desi / dimensionalWeight bilgisi eksik.');
  if (vatRate === null || ![0, 1, 10, 20].includes(vatRate)) errors.push('KDV oranı eksik veya geçersiz (0, 1, 10, 20 olmalı).');
  if (!image) errors.push('Ürün görseli eksik.');
  else {
    try { if (new URL(image).protocol !== 'https:') errors.push('Ürün görseli HTTPS olmalıdır.'); }
    catch { errors.push('Ürün görsel adresi geçersiz.'); }
  }
  if (!description) warnings.push('Ürün açıklaması boş.');
  if (barcode.length > 40) errors.push('Barkod 40 karakterden uzun olamaz.');
  if (category && !mapping.attributes?.length) errors.push('Seçilen Trendyol kategorisinin zorunlu ürün özellikleri eşleştirilmemiş.');
  return {
    ready: errors.length === 0,
    errors,
    warnings,
    normalized: {
      barcode, title, productMainId: sku, stockCode: sku, brand,
      brandId: brandId || null, categoryId: category || null,
      quantity: stock, dimensionalWeight, vatRate, listPrice: salePrice, salePrice,
      currencyType: 'TRY', description, images: image ? [image] : [],
      attributes: Array.isArray(mapping.attributes) ? mapping.attributes : [],
    },
  };
}

export function validateTrendyolFeed(products, mappings = {}) {
  const seen = new Set();
  const rows = products.map((product, index) => {
    const result = validateTrendyolProduct(product, mappings[String(product['Kategori'] || '')] || {});
    const barcode = String(product['Barkod'] || '').trim();
    const duplicate = barcode && seen.has(barcode);
    if (barcode) seen.add(barcode);
    if (duplicate) {
      result.ready = false;
      result.errors.push('Aynı barkod XML içinde birden fazla üründe kullanılmış.');
    }
    return { index, sku: product.SKU || '', title: product['Ürün Adı'] || '', barcode, ...result };
  });
  const ready = rows.filter(row => row.ready).length;
  return {
    total: rows.length,
    ready,
    blocked: rows.length - ready,
    warnings: rows.reduce((sum, row) => sum + row.warnings.length, 0),
    rows,
  };
}
