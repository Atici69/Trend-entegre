const REQUIRED_FIELDS = ['barcode', 'title', 'productMainId', 'brandId', 'categoryId', 'quantity', 'stockCode', 'dimensionalWeight', 'description', 'listPrice', 'salePrice', 'vatRate', 'origin', 'images', 'attributes'];

function numeric(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateTrendyolProduct(source, mapping = {}) {
  const errors = [];
  const warnings = [];
  const title = String(source['Ürün Adı'] || '').trim();
  const barcode = String(source['Barkod'] || '').trim().replace(/\\s+/g, '');
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
  const origin = String(source['Menşei'] ?? source.origin ?? '').trim().toUpperCase();

  if (!title) errors.push('Ürün adı eksik.');
  if (title.length > 100) errors.push('Ürün adı Trendyol için 100 karakteri aşamaz.');
  if (!barcode) errors.push('Barkod eksik.');
  if (!sku) errors.push('Stok kodu (SKU) eksik.');
  if (!brand) errors.push('Marka eksik.');
  if (!brandId) errors.push('Trendyol marka eşleştirmesi yapılmamış.');
  if (!category) errors.push('Trendyol kategori eşleştirmesi yapılmamış.');
  if (salePrice === null || salePrice <= 0) errors.push('Geçerli satış fiyatı bulunamadı.');
  if (stock === null || stock < 0 || !Number.isInteger(stock)) errors.push('Stok miktarı geçerli bir tam sayı olmalıdır.');
  if (dimensionalWeight === null || dimensionalWeight <= 0) errors.push('Desi / dimensionalWeight bilgisi eksik.');
  if (vatRate === null || ![0, 1, 10, 20].includes(vatRate)) errors.push('KDV oranı eksik veya geçersiz (0, 1, 10, 20 olmalı).');
  if (!/^[A-Z]{2}$/.test(origin)) errors.push('Menşei ülke kodu eksik veya geçersiz (iki harfli ülke kodu gerekli).');
  if (!image) errors.push('Ürün görseli eksik.');
  else {
    try { if (new URL(image).protocol !== 'https:') errors.push('Ürün görseli HTTPS olmalıdır.'); }
    catch { errors.push('Ürün görsel adresi geçersiz.'); }
  }
  if (!description) errors.push('Ürün açıklaması eksik.');
  if (barcode.length > 40) errors.push('Barkod 40 karakterden uzun olamaz.');
  if (barcode && !/^[\p{L}\p{N}._-]+$/u.test(barcode.replace(/\s+/g, ''))) errors.push('Barkod yalnızca harf, rakam, nokta, tire ve alt çizgi içerebilir.');
  const requiredAttributes = Array.isArray(mapping.requiredAttributes) ? mapping.requiredAttributes : null;
  if (category && requiredAttributes === null) errors.push('Seçilen Trendyol kategorisinin zorunlu özellikleri henüz kontrol edilmemiş.');
  else if (category && requiredAttributes.length) {
    const mappedAttributeIds = new Set((Array.isArray(mapping.attributes) ? mapping.attributes : []).map(attribute => String(attribute.attributeId || '')));
    const missingAttributes = requiredAttributes.filter(attribute => !mappedAttributeIds.has(String(attribute.attributeId || '')));
    if (missingAttributes.length) errors.push('Zorunlu Trendyol özellikleri eksik: ' + missingAttributes.map(attribute => attribute.name || attribute.attributeId).join(', ') + '.');
  }
  return {
    ready: errors.length === 0,
    errors,
    warnings,
    normalized: {
      barcode, title, productMainId: sku, stockCode: sku, brand,
      brandId: brandId ? Number(brandId) : null, categoryId: category ? Number(category) : null,
      quantity: stock, dimensionalWeight, vatRate, origin, listPrice: salePrice, salePrice,
      description, images: image ? [{ url: image }] : [],
      attributes: Array.isArray(mapping.attributes) ? mapping.attributes.map(attribute => ({
        attributeId: Number(attribute.attributeId),
        ...(attribute.attributeValueId ? { attributeValueId: Number(attribute.attributeValueId) } : {}),
        ...(attribute.customValue ? { customAttributeValue: attribute.customValue } : {}),
      })) : [],
    },
  };
}

export function validateTrendyolFeed(products, mappings = {}) {
  const seen = new Set();
  const rows = products.map((product, index) => {
    const result = validateTrendyolProduct(product, mappings[String(product['Kategori'] || '')] || {});
    const barcode = String(product['Barkod'] || '').trim().replace(/\\s+/g, '');
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
