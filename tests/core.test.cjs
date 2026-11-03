const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');

test('calculates subtotal, discount, paid and due accurately', () => {
  const result = core.calculateTotals([
    { qty: 2, unitPrice: 100 },
    { qty: 1, unitPrice: 50.50 }
  ], 20.50, 100);
  assert.deepEqual(result, { subtotal: 250.5, discount: 20.5, total: 230, paid: 100, due: 130 });
});

test('rejects over-discount and overpayment', () => {
  assert.throws(() => core.calculateTotals([{ qty: 1, unitPrice: 10 }], 11, 0), /Discount/);
  assert.throws(() => core.calculateTotals([{ qty: 1, unitPrice: 10 }], 0, 11), /Amount received/);
});

test('rejects fractional or zero quantities', () => {
  assert.throws(() => core.calculateTotals([{ qty: 0, unitPrice: 10 }], 0, 0), /quantity/);
  assert.throws(() => core.calculateTotals([{ qty: 1.2, unitPrice: 10 }], 0, 0), /quantity/);
});

test('aggregates stock deduction for repeated inventory rows', () => {
  const result = core.aggregateCart([
    { inventoryId: 'a', qty: 2 },
    { inventoryId: 'a', qty: 3 },
    { inventoryId: null, qty: 1 },
    { inventoryId: 'b', qty: 4 }
  ]);
  assert.deepEqual([...result.entries()], [['a', 5], ['b', 4]]);
});

test('CSV output escapes commas, quotes and line breaks safely', () => {
  const csv = core.toCSV([{ name: 'Brake, pad', note: 'He said "fit it"\nsoon' }], [
    { label: 'Name', value: 'name' }, { label: 'Note', value: 'note' }
  ]);
  assert.match(csv, /"Brake, pad"/);
  assert.match(csv, /"He said ""fit it""\nsoon"/);
});

test('derives due balances across bills for the same customer', () => {
  const balances = core.deriveCustomerBalances([
    { customerId: 'c1', customerName: 'Asha', due: 20 },
    { customerId: 'c1', customerName: 'Asha', due: 30 },
    { customerId: 'c2', customerName: 'Binu', due: 0 }
  ]);
  assert.deepEqual(balances, [{ customerId: 'c1', name: 'Asha', due: 50, invoices: 2 }]);
});

test('validates a version 2 backup and rejects an invalid schema', () => {
  const payload = { app: 'WorkshopPro', schemaVersion: 2, data: {
    customers: [], inventory: [], bills: [], payments: [], stockMovements: [], settings: []
  } };
  assert.equal(core.validateBackup(payload), true);
  assert.throws(() => core.validateBackup({ ...payload, schemaVersion: 1 }), /Unsupported/);
});

test('neutralizes cells that could be interpreted as spreadsheet formulas', () => {
  const csv = core.toCSV([{ value: '=HYPERLINK(\"http://bad\")' }], [{ label: 'Value', value: 'value' }]);
  assert.match(csv, /\"'=HYPERLINK/);
});
