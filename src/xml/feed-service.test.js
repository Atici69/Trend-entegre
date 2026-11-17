import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProducts, clampProductLimit } from './feed-service.js';

test('parseProducts maps a standard product feed', () => {
  const xml = '<?xml version="1.0"?><products><product><id>p-1</id><name>Test Ürün</name><price>125.50</price><stock>4</stock></product></products>';
  const products = parseProducts(xml);
  assert.equal(products.length, 1);
  assert.equal(products[0]['Ürün ID'], 'p-1');
  assert.equal(products[0]['Ürün Adı'], 'Test Ürün');
  assert.equal(products[0].Fiyat, '125.50');
  assert.equal(products[0].Stok, '4');
});

test('parseProducts rejects empty, invalid and entity-bearing XML', () => {
  assert.throws(() => parseProducts(''));
  assert.throws(() => parseProducts('<products><product></products>'));
  assert.throws(() => parseProducts('<!DOCTYPE x [<!ENTITY e "bad">]><products><product><name>&e;</name></product></products>'));
});

test('clampProductLimit enforces supported limits', () => {
  assert.equal(clampProductLimit('10', 100), 10);
  assert.equal(clampProductLimit('all', 6000), 5000);
  assert.throws(() => clampProductLimit('11', 100));
});
