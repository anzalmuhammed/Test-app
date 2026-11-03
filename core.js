(function (root) {
  'use strict';

  function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function calculateTotals(items, discountValue, paidValue) {
    if (!Array.isArray(items)) throw new TypeError('Bill items must be an array.');
    const subtotal = money(items.reduce((sum, item) => {
      const qty = Number(item.qty);
      const price = Number(item.unitPrice);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) throw new Error('Item quantity must be a positive whole number.');
      if (!Number.isFinite(price) || price < 0) throw new Error('Item price cannot be negative.');
      return sum + qty * price;
    }, 0));
    const discount = money(discountValue || 0);
    const paid = money(paidValue || 0);
    if (discount < 0 || discount > subtotal) throw new Error('Discount must be between ₹0 and the subtotal.');
    const total = money(subtotal - discount);
    if (paid < 0 || paid > total) throw new Error('Amount received cannot be negative or greater than the total.');
    return { subtotal, discount, total, paid, due: money(total - paid) };
  }

  function aggregateCart(items) {
    const result = new Map();
    for (const item of items || []) {
      if (!item.inventoryId) continue;
      result.set(item.inventoryId, (result.get(item.inventoryId) || 0) + Number(item.qty || 0));
    }
    return result;
  }

  function csvCell(value) {
    let text = value == null ? '' : String(value);
    // Prevent spreadsheet formula execution for untrusted text columns.
    if (/^[\s]*[=+@]/.test(text) || /^[\s]*-/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function toCSV(rows, columns) {
    const head = columns.map(c => csvCell(c.label)).join(',');
    const body = rows.map(row => columns.map(c => csvCell(typeof c.value === 'function' ? c.value(row) : row[c.value])).join(','));
    return '\ufeff' + [head, ...body].join('\r\n');
  }

  function validateBackup(payload) {
    if (!payload || typeof payload !== 'object' || payload.app !== 'WorkshopPro') throw new Error('This is not a Workshop Pro backup file.');
    if (!Number.isInteger(payload.schemaVersion) || payload.schemaVersion !== 2) throw new Error('Unsupported backup version.');
    const required = ['customers', 'inventory', 'bills', 'payments', 'stockMovements', 'settings'];
    for (const name of required) {
      if (!Array.isArray(payload.data?.[name])) throw new Error(`Backup is missing ${name} records.`);
    }
    const keyFields = { customers: 'id', inventory: 'id', bills: 'id', payments: 'id', stockMovements: 'id', settings: 'key' };
    for (const name of required) {
      const key = keyFields[name];
      const seen = new Set();
      for (const row of payload.data[name]) {
        if (!row || typeof row !== 'object' || row[key] == null || row[key] === '') throw new Error(`Invalid ${name} record in backup.`);
        if (seen.has(String(row[key]))) throw new Error(`Duplicate ${name} record in backup.`);
        seen.add(String(row[key]));
      }
    }
    return true;
  }


  function migrateLegacyPouchDocs(documents) {
    const docs = (Array.isArray(documents) ? documents : []).filter(doc => doc && !doc._deleted && doc._id);
    const customersSource = docs.filter(doc => doc.type === 'customer');
    const inventorySource = docs.filter(doc => doc.type === 'inventory');
    const ledgerSource = docs.filter(doc => doc.type === 'ledger');
    const customers = customersSource.map(doc => ({
      id: `legacy-customer:${doc._id}`,
      name: String(doc.name || 'Legacy customer'),
      vehicleNo: String(doc.vehicleNo || '').toUpperCase(),
      phone: String(doc.phone || ''), email: String(doc.email || ''),
      address: String(doc.address || ''), gst: String(doc.gst || ''),
      createdAt: doc.createdAt || new Date(0).toISOString(),
      updatedAt: doc.updatedAt || doc.createdAt || new Date(0).toISOString(),
      legacyId: doc._id
    }));
    const inventory = inventorySource.map(doc => {
      const totalIn = Math.max(0, Number(doc.totalIn || 0));
      const totalSold = Math.max(0, Number(doc.totalSold || 0));
      return {
        id: `legacy-inventory:${doc._id}`, code: String(doc._id),
        name: String(doc.name || 'Unnamed item'), price: money(doc.price || 0),
        quantity: Math.max(0, totalIn - totalSold), minStock: Math.max(0, Number(doc.minStock ?? 5)),
        category: String(doc.category || 'General'), location: String(doc.location || ''),
        archived: Boolean(doc.archived), createdAt: doc.createdAt || new Date(0).toISOString(),
        updatedAt: doc.updatedAt || doc.createdAt || new Date(0).toISOString(),
        legacyId: doc._id, legacyTotalIn: totalIn, legacyTotalSold: totalSold
      };
    });
    const customerByIdentity = new Map();
    customers.forEach(customer => customerByIdentity.set(`${customer.name.toLowerCase()}|${customer.vehicleNo.toLowerCase()}`, customer));
    const inventoryByLegacyCode = new Map(inventorySource.map(doc => [String(doc._id), `legacy-inventory:${doc._id}`]));
    const bills = [];
    const payments = [];
    for (const doc of ledgerSource) {
      const customerName = String(doc.customer || 'Legacy customer');
      const vehicleNo = String(doc.vehicleNo || '').toUpperCase();
      const identity = `${customerName.toLowerCase()}|${vehicleNo.toLowerCase()}`;
      const nameMatches = customers.filter(row => row.name.toLowerCase() === customerName.toLowerCase());
      let customer = customerByIdentity.get(identity) || (nameMatches.length === 1 ? nameMatches[0] : null);
      if (!customer) {
        customer = { id: `legacy-customer-from-bill:${doc._id}`, name: customerName, vehicleNo, phone: '', email: '', address: '', gst: '', createdAt: doc.date || new Date(0).toISOString(), updatedAt: doc.updatedAt || doc.date || new Date(0).toISOString(), legacyId: '' };
        customers.push(customer);
        customerByIdentity.set(identity, customer);
      }
      const items = (Array.isArray(doc.items) ? doc.items : []).map((item, index) => {
        const qty = Math.max(1, Math.floor(Number(item.qty || 1)));
        const unitPrice = money(item.price || 0);
        const legacyCode = item.id == null ? '' : String(item.id);
        return {
          inventoryId: inventoryByLegacyCode.get(legacyCode) || null,
          code: legacyCode || 'SERVICE',
          name: String(item.desc || `Item ${index + 1}`),
          qty, unitPrice, lineTotal: money(Number(item.total ?? qty * unitPrice))
        };
      });
      const total = Math.max(0, money(doc.total || 0));
      const paidTotal = Math.min(total, Math.max(0, money(doc.paid || 0)));
      const due = Math.max(0, money(doc.balance ?? total - paidTotal));
      const billId = `legacy-bill:${doc._id}`;
      const date = doc.date || new Date(0).toISOString();
      const subtotal = money(items.reduce((sum, item) => sum + item.lineTotal, 0));
      const discount = Math.min(subtotal, Math.max(0, money(doc.discount ?? subtotal - total)));
      const invoiceNo = `LEG-${String(doc._id).replace(/[^a-zA-Z0-9]/g, '').slice(-10) || bills.length + 1}`;
      bills.push({
        id: billId, invoiceNo, customerId: customer.id, customerName,
        customerPhone: customer.phone || '', customerAddress: customer.address || '', customerGst: customer.gst || '',
        vehicleNo, date, savedAt: doc.updatedAt || date, items, subtotal, discount, total,
        paid: paidTotal, paidTotal, due, paymentMethod: String(doc.paymentMethod || 'Cash'),
        status: due <= 0 ? 'paid' : paidTotal > 0 ? 'partial' : 'due',
        updatedAt: doc.updatedAt || date, legacyId: doc._id
      });
      if (paidTotal > 0) payments.push({
        id: `legacy-payment:${doc._id}`, billId, customerId: customer.id, customerName,
        invoiceNo, amount: paidTotal, method: String(doc.paymentMethod || 'Cash'),
        notes: 'Imported original invoice payment', date
      });
    }
    const stockMovements = [];
    for (const item of inventory) {
      if (item.legacyTotalIn > 0) stockMovements.push({
        id: `legacy-received:${item.id}`, inventoryId: item.id, code: item.code,
        itemName: item.name, delta: item.legacyTotalIn, reason: 'Opening stock received (legacy import)',
        referenceId: '', date: item.createdAt
      });
      if (item.legacyTotalSold > 0) stockMovements.push({
        id: `legacy-issued:${item.id}`, inventoryId: item.id, code: item.code,
        itemName: item.name, delta: -item.legacyTotalSold, reason: 'Previously sold / issued (legacy import)',
        referenceId: '', date: item.updatedAt
      });
    }
    const invoiceCounter = bills.length;
    const settings = [
      { key: 'invoiceCounter', value: invoiceCounter },
      { key: 'legacyMigrationAt', value: new Date().toISOString() },
      { key: 'legacyMigrationSource', value: 'workshop_db' }
    ];
    return { customers, inventory, bills, payments, stockMovements, settings };
  }

  function normalizeBackupPayload(payload) {
    try {
      validateBackup(payload);
      return { payload, migratedLegacy: false };
    } catch (currentFormatError) {
      // The reference app's Google Drive backup used { version, data: [PouchDB docs] }.
      // Also accept a plain array of PouchDB documents exported from workshop_db.
      const legacyDocs = Array.isArray(payload)
        ? payload
        : (payload && Array.isArray(payload.data) ? payload.data : null);
      if (!legacyDocs) throw currentFormatError;
      const migrated = migrateLegacyPouchDocs(legacyDocs);
      const recognized = migrated.customers.length + migrated.inventory.length + migrated.bills.length;
      if (!recognized) throw new Error('This file is not a recognised Workshop Pro backup. No customer, inventory or invoice records were found.');
      migrated.settings = migrated.settings.filter(row => row.key !== 'legacyMigrationDone');
      migrated.settings.push({ key: 'legacyMigrationDone', value: true });
      const normalized = {
        app: 'WorkshopPro',
        schemaVersion: 2,
        exportedAt: payload?.timestamp || payload?.exportedAt || new Date().toISOString(),
        data: migrated
      };
      validateBackup(normalized);
      return { payload: normalized, migratedLegacy: true };
    }
  }

  function isFastBarcodeBurst(keyTimes, maxGapMs = 65, minKeys = 4) {
    if (!Array.isArray(keyTimes) || keyTimes.length < minKeys) return false;
    for (let i = 1; i < keyTimes.length; i++) {
      const gap = Number(keyTimes[i]) - Number(keyTimes[i - 1]);
      if (!Number.isFinite(gap) || gap < 0 || gap > maxGapMs) return false;
    }
    return true;
  }

  function deriveCustomerBalances(bills) {
    const map = new Map();
    for (const bill of bills || []) {
      if (!bill.customerId) continue;
      const current = map.get(bill.customerId) || { customerId: bill.customerId, name: bill.customerName || 'Customer', due: 0, invoices: 0 };
      current.due = money(current.due + Number(bill.due || 0));
      if (Number(bill.due || 0) > 0) current.invoices += 1;
      map.set(bill.customerId, current);
    }
    return [...map.values()].filter(item => item.due > 0).sort((a, b) => b.due - a.due);
  }

  const api = { money, calculateTotals, aggregateCart, csvCell, toCSV, validateBackup, normalizeBackupPayload, deriveCustomerBalances, isFastBarcodeBurst, migrateLegacyPouchDocs };
  root.WorkshopCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
