const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
const context = { window: {}, crypto: { randomUUID: () => 'test-id' }, setTimeout, clearTimeout, setInterval, clearInterval, navigator: { onLine: true }, fetch: async () => { throw new Error('network should not be used by pure helper tests'); }, Blob, URLSearchParams, Date, Math, JSON, Object, Array, String, Number, Promise, Error };
vm.runInNewContext(source, context);
const sync = context.window.WorkshopDriveSync;

test('v5 record fingerprint is stable regardless of object key order', () => {
  assert.equal(sync.hash({ id: 'x', name: 'Brake Cable', price: 12 }), sync.hash({ price: 12, name: 'Brake Cable', id: 'x' }));
});

test('inventory fingerprint excludes quantity because stock is synchronized as movements', () => {
  const a = sync.cleanRecord('inventory', { id: 'i1', name: 'Brake Cable', quantity: 5, price: 1200 });
  const b = sync.cleanRecord('inventory', { id: 'i1', name: 'Brake Cable', quantity: 2, price: 1200 });
  assert.deepEqual(a, b);
  assert.equal(sync.hash(a), sync.hash(b));
});

test('stock movement fingerprint retains movement delta and identity', () => {
  const a = sync.cleanRecord('stockMovements', { id: 'm1', inventoryId: 'i1', delta: -1 });
  const b = sync.cleanRecord('stockMovements', { id: 'm1', inventoryId: 'i1', delta: -2 });
  assert.notEqual(sync.hash(a), sync.hash(b));
});
