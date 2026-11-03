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

  const api = { money, calculateTotals, aggregateCart, csvCell, toCSV, validateBackup, deriveCustomerBalances };
  root.WorkshopCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
