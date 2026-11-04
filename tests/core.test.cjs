const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');

test('invoice totals are calculated to two decimal places', () => {
  const result = core.calculateTotals([
    { qty: 2, unitPrice: 150.25 },
    { qty: 1, unitPrice: 99.50 }
  ], 25, 200);
  assert.deepEqual(result, { subtotal: 400, discount: 25, total: 375, paid: 200, due: 175 });
});

test('invoice totals reject invalid quantities, discounts and overpayments', () => {
  assert.throws(() => core.calculateTotals([{ qty: 0, unitPrice: 10 }], 0, 0));
  assert.throws(() => core.calculateTotals([{ qty: 1.5, unitPrice: 10 }], 0, 0));
  assert.throws(() => core.calculateTotals([{ qty: 1, unitPrice: 10 }], 11, 0));
  assert.throws(() => core.calculateTotals([{ qty: 1, unitPrice: 10 }], 0, 11));
});

test('stock quantities for repeated cart lines are aggregated by inventory ID', () => {
  assert.deepEqual([...core.aggregateCart([
    { inventoryId: 'part-1', qty: 2 },
    { inventoryId: 'part-1', qty: 3 },
    { inventoryId: 'part-2', qty: 1 },
    { inventoryId: null, qty: 4 }
  ])], [['part-1', 5], ['part-2', 1]]);
});

test('CSV protects formula-like user content and escapes quotes', () => {
  assert.equal(core.csvCell('=HYPERLINK("bad")'), `"'=HYPERLINK(""bad"")"`);
  assert.equal(core.csvCell('Rack "A"'), `"Rack ""A"""`);
});

test('customer balances derive from remaining invoice dues', () => {
  const balances = core.deriveCustomerBalances([
    { customerId: 'c1', customerName: 'Anu', due: 120 },
    { customerId: 'c1', customerName: 'Anu', due: 80 },
    { customerId: 'c2', customerName: 'Binu', due: 0 }
  ]);
  assert.deepEqual(balances, [{ customerId: 'c1', name: 'Anu', due: 200, invoices: 2 }]);
});

test('backup validator accepts the current schema and rejects malformed records', () => {
  const data = {
    customers: [], inventory: [], bills: [], payments: [], stockMovements: [], settings: []
  };
  assert.equal(core.validateBackup({ app: 'WorkshopPro', schemaVersion: 2, data }), true);
  assert.equal(core.validateBackup({ app: 'WorkshopPro', schemaVersion: 3, data: { ...data, services: [{ id: 'svc-1', name: 'General service', kind: 'service', quantity: 0 }] } }), true);
  assert.throws(() => core.validateBackup({ app: 'WorkshopPro', schemaVersion: 1, data }));
  assert.throws(() => core.validateBackup({ app: 'WorkshopPro', schemaVersion: 3 }));
  assert.throws(() => core.validateBackup({ app: 'WorkshopPro', schemaVersion: 2, data: { ...data, bills: [{ id: 'x' }, { id: 'x' }] } }));
});

test('keyboard-wedge recognition requires a short consistent key burst', () => {
  assert.equal(core.isFastBarcodeBurst([0, 8, 17, 27, 36, 45], 65, 4), true);
  assert.equal(core.isFastBarcodeBurst([0, 8, 100, 110], 65, 4), false);
  assert.equal(core.isFastBarcodeBurst([0, 8, 17], 65, 4), false);
});

test('legacy PouchDB records migrate into the new linked data model', () => {
  const migrated = core.migrateLegacyPouchDocs([
    { _id: 'cust-1', type: 'customer', name: 'Ravi', vehicleNo: 'kl01ab1234', phone: '9876543210' },
    { _id: 'BRK-001', type: 'inventory', name: 'Brake Pad', price: 250, totalIn: 10, totalSold: 3 },
    { _id: 'ledger-1', type: 'ledger', customer: 'Ravi', vehicleNo: 'KL01AB1234', total: 500, paid: 200, balance: 300, paymentMethod: 'UPI', date: '2026-11-01T12:00:00.000Z', items: [{ id: 'BRK-001', desc: 'Brake Pad', qty: 2, price: 250, total: 500 }] }
  ]);
  assert.deepEqual(migrated.services, []);
  assert.equal(migrated.customers.length, 1);
  assert.equal(migrated.inventory[0].quantity, 7);
  assert.equal(migrated.bills.length, 1);
  assert.equal(migrated.bills[0].customerId, migrated.customers[0].id);
  assert.equal(migrated.bills[0].due, 300);
  assert.equal(migrated.bills[0].items[0].inventoryId, migrated.inventory[0].id);
  assert.equal(migrated.payments[0].amount, 200);
  assert.equal(migrated.stockMovements.find(row => row.delta > 0).delta, 10);
  assert.equal(migrated.stockMovements.find(row => row.delta < 0).delta, -3);
});

test('old PouchDB / Google Drive backup format converts to the current backup schema', () => {
  const oldPayload = { version: '1.0', timestamp: '2026-11-02T10:00:00.000Z', data: [
    { _id: 'cust-old', type: 'customer', name: 'Old Customer' },
    { _id: 'OLD-001', type: 'inventory', name: 'Old Part', price: 80, totalIn: 5, totalSold: 1 },
    { _id: 'bill-old', type: 'ledger', customer: 'Old Customer', total: 160, paid: 80, balance: 80, date: '2026-11-02T10:00:00.000Z', items: [{ id: 'OLD-001', desc: 'Old Part', qty: 2, price: 80, total: 160 }] }
  ] };
  const normalized = core.normalizeBackupPayload(oldPayload);
  assert.equal(normalized.migratedLegacy, true);
  assert.equal(normalized.payload.schemaVersion, 3);
  assert.equal(normalized.payload.data.inventory[0].quantity, 4);
  assert.equal(normalized.payload.data.bills[0].due, 80);
  assert.equal(normalized.payload.data.settings.some(row => row.key === 'legacyMigrationDone' && row.value === true), true);
  assert.equal(core.normalizeBackupPayload(normalized.payload).migratedLegacy, false);
});
