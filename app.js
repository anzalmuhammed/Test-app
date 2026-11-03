(() => {
  'use strict';

  const Core = window.WorkshopCore;
  const CONFIG = window.WORKSHOP_CONFIG || {};
  const DB_NAME = 'WorkshopProDB_v2';
  const DB_VERSION = 1;
  const STORES = ['customers', 'inventory', 'bills', 'payments', 'stockMovements', 'settings'];
  const money = value => Core.money(value);
  const currency = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(money(value));
  const dateTime = value => value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const dateOnly = value => value ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const byId = id => document.getElementById(id);
  const uuid = () => (crypto?.randomUUID ? crypto.randomUUID() : `wp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  let db = null;
  let activeView = 'dashboard';
  let customers = [];
  let inventory = [];
  let bills = [];
  let payments = [];
  let stockMovements = [];
  let settings = {};
  let currentCart = [];
  let selectedBillSuggestion = null;
  let currentInvoice = null;
  let scanner = null;
  let scanTarget = 'billing';
  let scannerResultHandled = false;
  let torchEnabled = false;
  let driveToken = null;
  let driveTokenClient = null;
  let driveFileId = null;
  let driveKnownModifiedTime = null;
  let driveBaselineLoaded = false;
  let driveSessionReadyForAutoBackup = false;
  let autoBackupTimer = null;
  let lastSavedAt = null;

  // ---------- IndexedDB data layer ----------
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const store of STORES) {
          if (!database.objectStoreNames.contains(store)) {
            database.createObjectStore(store, { keyPath: store === 'settings' ? 'key' : 'id' });
          }
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Unable to open local database.'));
      request.onblocked = () => reject(new Error('Database is blocked by another open Workshop Pro tab. Close other tabs and retry.'));
    });
  }

  function readAll(storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error(`Could not read ${storeName}.`));
      tx.onabort = () => reject(tx.error || new Error(`Read of ${storeName} was cancelled.`));
    });
  }

  function readOne(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error(`Could not read ${storeName}.`));
      tx.onabort = () => reject(tx.error || new Error(`Read of ${storeName} was cancelled.`));
    });
  }

  function writeOne(storeName, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const request = tx.objectStore(storeName).put(value);
      request.onerror = () => reject(request.error || new Error(`Could not save ${storeName}.`));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error || new Error(`Could not save ${storeName}.`));
      tx.onabort = () => reject(tx.error || new Error(`Save to ${storeName} was cancelled.`));
    });
  }

  function replaceAllData(data) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES, 'readwrite');
      try {
        for (const name of STORES) {
          const store = tx.objectStore(name);
          store.clear();
          for (const record of data[name]) store.put(record);
        }
      } catch (error) {
        tx.abort();
        reject(error);
        return;
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('Could not restore backup.'));
      tx.onabort = () => reject(tx.error || new Error('Backup restore was cancelled.'));
    });
  }

  async function refreshData() {
    const [customerRows, inventoryRows, billRows, paymentRows, movementRows, settingRows] = await Promise.all(STORES.map(readAll));
    customers = customerRows;
    inventory = inventoryRows.filter(item => !item.archived);
    bills = billRows;
    payments = paymentRows;
    stockMovements = movementRows;
    settings = Object.fromEntries(settingRows.map(row => [row.key, row.value]));
  }

  async function putSetting(key, value) {
    await writeOne('settings', { key, value });
    settings[key] = value;
  }

  async function afterLocalChange(message = 'Changes saved on this device.') {
    lastSavedAt = new Date();
    byId('last-saved-label').textContent = `Saved ${lastSavedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
    byId('backup-status').textContent = message;
    scheduleAutomaticDriveBackup();
  }

  // ---------- Shared UI utilities ----------
  function toast(message, type = 'info') {
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.textContent = message;
    byId('toast-stack').appendChild(item);
    window.setTimeout(() => item.remove(), 3800);
  }

  function showDialog(id) {
    const dialog = byId(id);
    if (dialog && !dialog.open) dialog.showModal();
  }

  function closeAllDialogs() {
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  }

  function openSidebar() {
    byId('sidebar').classList.add('open');
    byId('mobile-scrim').classList.add('show');
  }

  function closeSidebar() {
    byId('sidebar').classList.remove('open');
    byId('mobile-scrim').classList.remove('show');
  }

  const viewMeta = {
    dashboard: ['OVERVIEW', 'Dashboard'], billing: ['SALES', 'Quick Billing'], inventory: ['STOCK CONTROL', 'Inventory'],
    customers: ['CUSTOMER DIRECTORY', 'Customers'], ledger: ['ACCOUNTS', 'Ledger & Payments'], reports: ['ANALYTICS', 'Reports'], settings: ['PREFERENCES', 'Settings & Backup']
  };

  async function showView(view) {
    if (!viewMeta[view]) return;
    activeView = view;
    document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === `view-${view}`));
    document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === view && el.classList.contains('nav-link')));
    byId('page-eyebrow').textContent = viewMeta[view][0];
    byId('page-title').textContent = viewMeta[view][1];
    closeSidebar();
    if (view === 'dashboard') renderDashboard();
    if (view === 'inventory') renderInventory();
    if (view === 'billing') populateBillCustomers();
    if (view === 'customers') renderCustomers();
    if (view === 'ledger') renderLedger();
    if (view === 'reports') renderReports();
    if (view === 'settings') renderSettings();
  }

  function updateNetworkState() {
    const online = navigator.onLine;
    byId('network-dot').classList.toggle('online', online);
    byId('network-label').textContent = online ? 'Online' : 'Offline mode';
    if (!online) byId('backup-status').textContent = 'Your records remain available on this device.';
  }

  function showMoneyStatus(due) {
    if (due <= 0) return '<span class="status-badge paid">Paid</span>';
    return '<span class="status-badge due">Due</span>';
  }

  // ---------- Dashboard ----------
  function renderDashboard() {
    const openInventory = inventory;
    const lowItems = openInventory.filter(item => Number(item.quantity || 0) <= Number(item.minStock || 0));
    const outstanding = bills.reduce((sum, bill) => sum + Number(bill.due || 0), 0);
    byId('stat-items').textContent = openInventory.length;
    byId('stat-customers').textContent = customers.length;
    byId('stat-low').textContent = lowItems.length;
    byId('stat-due').textContent = currency(outstanding);
    byId('stat-items-foot').textContent = `${openInventory.reduce((sum, item) => sum + Number(item.quantity || 0), 0)} total units in stock`;
    byId('today-label').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

    const recent = [...bills].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
    byId('recent-bills').innerHTML = recent.length ? recent.map(bill => `
      <div class="recent-item"><div class="recent-person"><div class="mini-avatar">${esc((bill.customerName || 'C').slice(0, 1).toUpperCase())}</div><div><strong>${esc(bill.customerName)}</strong><small>${esc(bill.invoiceNo)} · ${dateOnly(bill.date)}</small></div></div><div class="recent-amount"><strong>${currency(bill.total)}</strong><small>${bill.due > 0 ? `Due ${currency(bill.due)}` : 'Fully paid'}</small></div></div>`).join('') : '<div class="empty-state">No bills have been created yet.</div>';

    byId('dashboard-low-stock').innerHTML = lowItems.length ? lowItems.slice(0, 6).map(item => `
      <div class="low-stock-item"><div class="low-stock-symbol">!</div><div><strong>${esc(item.name)}</strong><small>${Number(item.quantity || 0)} left · Minimum ${Number(item.minStock || 0)}</small></div></div>`).join('') : '<div class="empty-state">No low-stock items. Nice work.</div>';
  }

  // ---------- Inventory ----------
  function inventoryStatus(item) {
    const qty = Number(item.quantity || 0);
    if (qty <= 0) return 'out';
    if (qty <= Number(item.minStock || 0)) return 'low';
    return 'ok';
  }

  function renderInventory() {
    const query = byId('inventory-search').value.trim().toLowerCase();
    const stockFilter = byId('inventory-filter').value;
    const categoryFilter = byId('inventory-category-filter').value;
    const sort = byId('inventory-sort').value;
    let rows = inventory.filter(item => !query || `${item.name} ${item.code}`.toLowerCase().includes(query));
    if (stockFilter !== 'all') rows = rows.filter(item => stockFilter === 'healthy' ? inventoryStatus(item) === 'ok' : inventoryStatus(item) === stockFilter);
    if (categoryFilter !== 'all') rows = rows.filter(item => item.category === categoryFilter);
    const sorters = {
      name: (a, b) => a.name.localeCompare(b.name), 'name-desc': (a, b) => b.name.localeCompare(a.name),
      'price-low': (a, b) => a.price - b.price, 'price-high': (a, b) => b.price - a.price,
      'qty-low': (a, b) => a.quantity - b.quantity, 'qty-high': (a, b) => b.quantity - a.quantity
    };
    rows.sort(sorters[sort] || sorters.name);
    const stockValue = rows.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.price || 0), 0);
    byId('inventory-count').textContent = `${rows.length} ${rows.length === 1 ? 'item' : 'items'}`;
    byId('inventory-value').textContent = currency(stockValue);
    byId('inventory-table').innerHTML = rows.length ? rows.map(item => {
      const status = inventoryStatus(item);
      const label = status === 'out' ? 'Out of stock' : status === 'low' ? 'Low stock' : 'In stock';
      return `<tr><td><div class="table-main">${esc(item.name)}</div><div class="table-sub">${esc(item.code)}</div></td><td>${esc(item.category || 'General')}</td><td><strong>${Number(item.quantity || 0)}</strong></td><td>${Number(item.minStock || 0)}</td><td>${currency(item.price)}</td><td>${esc(item.location || '—')}</td><td><span class="stock-tag ${status}">${label}</span></td><td><div class="row-actions"><button class="tiny-btn" data-action="edit-stock" data-id="${esc(item.id)}">Edit</button><button class="tiny-btn danger" data-action="archive-stock" data-id="${esc(item.id)}">Archive</button></div></td></tr>`;
    }).join('') : '<tr><td colspan="8" class="empty-cell">No items match these filters.</td></tr>';
  }

  function openStockDialog(item = null) {
    byId('stock-form').reset();
    byId('stock-id').value = item?.id || '';
    byId('stock-dialog-title').textContent = item ? 'Update stock item' : 'Add stock';
    byId('stock-code').value = item?.code || '';
    byId('stock-code').disabled = Boolean(item);
    byId('stock-name').value = item?.name || '';
    byId('stock-price').value = item?.price ?? 0;
    byId('stock-quantity').value = item ? 0 : 1;
    byId('stock-quantity').min = item ? 0 : 1;
    byId('stock-category').value = item?.category || 'General';
    byId('stock-min').value = item?.minStock ?? 5;
    byId('stock-location').value = item?.location || '';
    showDialog('stock-dialog');
  }

  async function saveStock(event) {
    event.preventDefault();
    let id = byId('stock-id').value;
    const code = byId('stock-code').value.trim();
    const name = byId('stock-name').value.trim();
    const price = Number(byId('stock-price').value);
    const qty = Number(byId('stock-quantity').value);
    const minStock = Number(byId('stock-min').value);
    if (!code || !name || !Number.isFinite(price) || price < 0 || !Number.isInteger(qty) || qty < (id ? 0 : 1) || !Number.isInteger(minStock) || minStock < 0) {
      toast('Check the item details and enter valid non-negative values.', 'error'); return;
    }
    const allInventoryRecords = await readAll('inventory');
    const duplicate = allInventoryRecords.find(item => item.code.toLowerCase() === code.toLowerCase() && item.id !== id);
    if (duplicate && !duplicate.archived) { toast('That barcode / item code is already in use.', 'error'); return; }
    const now = new Date().toISOString();
    if (!id && duplicate?.archived) id = duplicate.id;
    let record = id ? await readOne('inventory', id) : null;
    if (id && !record) { toast('This stock item no longer exists. Refresh and try again.', 'error'); return; }
    if (!record) record = { id: uuid(), code, quantity: 0, createdAt: now, archived: false };
    record.name = name; record.price = money(price); record.quantity = Number(record.quantity || 0) + qty;
    record.minStock = minStock; record.category = byId('stock-category').value; record.location = byId('stock-location').value.trim();
    record.updatedAt = now; record.archived = false;
    await writeOne('inventory', record);
    if (qty > 0) await writeOne('stockMovements', { id: uuid(), inventoryId: record.id, code: record.code, itemName: record.name, delta: qty, reason: 'Stock received', referenceId: '', date: now });
    closeAllDialogs(); await refreshData(); await renderInventory(); renderDashboard(); await afterLocalChange('Inventory saved on this device.');
    toast('Inventory item saved.', 'success');
  }

  async function archiveStock(id) {
    const item = inventory.find(row => row.id === id);
    if (!item) return;
    if (!confirm(`Archive “${item.name}”? It will be hidden from stock lists and billing, but old invoices will be kept.`)) return;
    const record = await readOne('inventory', id);
    record.archived = true; record.updatedAt = new Date().toISOString();
    await writeOne('inventory', record);
    await refreshData(); renderInventory(); renderDashboard(); await afterLocalChange('Inventory updated on this device.');
    toast('Item archived. Historical invoices are unchanged.', 'success');
  }

  // ---------- Customer management ----------
  function renderCustomers() {
    const query = byId('customer-search').value.trim().toLowerCase();
    const rows = customers.filter(customer => `${customer.name} ${customer.vehicleNo || ''} ${customer.phone || ''}`.toLowerCase().includes(query)).sort((a, b) => a.name.localeCompare(b.name));
    byId('customer-count').textContent = `${rows.length} ${rows.length === 1 ? 'customer' : 'customers'}`;
    const balances = Core.deriveCustomerBalances(bills);
    const dueMap = new Map(balances.map(row => [row.customerId, row.due]));
    byId('customers-grid').innerHTML = rows.length ? rows.map(customer => `
      <article class="customer-card" data-action="customer-details" data-id="${esc(customer.id)}"><div class="customer-card-top"><div class="mini-avatar">${esc(customer.name.slice(0, 1).toUpperCase())}</div><div><h3>${esc(customer.name)}</h3><p>${esc(customer.vehicleNo || 'No vehicle linked')}</p></div></div><div class="customer-card-meta"><span>☎ ${esc(customer.phone || 'Phone not added')}</span><span>✉ ${esc(customer.email || 'Email not added')}</span></div><div class="customer-card-bottom"><span>${bills.filter(bill => bill.customerId === customer.id).length} invoices</span><strong>${currency(dueMap.get(customer.id) || 0)} due</strong></div></article>`).join('') : '<div class="panel empty-state">No customers match your search.</div>';
  }

  function openCustomerDialog(customer = null) {
    byId('customer-form').reset();
    byId('customer-id').value = customer?.id || '';
    byId('customer-dialog-title').textContent = customer ? 'Edit customer' : 'Add customer';
    byId('customer-name-input').value = customer?.name || '';
    byId('customer-vehicle-input').value = customer?.vehicleNo || '';
    byId('customer-phone-input').value = customer?.phone || '';
    byId('customer-email-input').value = customer?.email || '';
    byId('customer-gst-input').value = customer?.gst || '';
    byId('customer-address-input').value = customer?.address || '';
    showDialog('customer-dialog');
  }

  async function saveCustomer(event) {
    event.preventDefault();
    const id = byId('customer-id').value;
    const name = byId('customer-name-input').value.trim();
    const vehicleNo = byId('customer-vehicle-input').value.trim().toUpperCase();
    const phone = byId('customer-phone-input').value.trim();
    const email = byId('customer-email-input').value.trim();
    if (!name) { toast('Customer name is required.', 'error'); return; }
    if (phone && !/^\d{10}$/.test(phone)) { toast('Enter a 10-digit phone number, or leave it blank.', 'error'); return; }
    const now = new Date().toISOString();
    const record = id ? await readOne('customers', id) : { id: uuid(), createdAt: now };
    if (!record) { toast('Customer record not found.', 'error'); return; }
    Object.assign(record, { name, vehicleNo, phone, email, gst: byId('customer-gst-input').value.trim(), address: byId('customer-address-input').value.trim(), updatedAt: now });
    await writeOne('customers', record);
    closeAllDialogs(); await refreshData(); renderCustomers(); populateBillCustomers(); renderLedger(); renderDashboard(); await afterLocalChange('Customer details saved on this device.');
    toast('Customer saved.', 'success');
  }

  function populateBillCustomers() {
    const select = byId('bill-customer');
    const current = select.value;
    select.innerHTML = '<option value="">Select customer</option>' + [...customers].sort((a, b) => a.name.localeCompare(b.name)).map(customer => `<option value="${esc(customer.id)}">${esc(customer.name)}${customer.vehicleNo ? ` · ${esc(customer.vehicleNo)}` : ''}</option>`).join('');
    if (customers.some(customer => customer.id === current)) select.value = current;
    byId('bill-date').value ||= new Date().toISOString().slice(0, 10);
  }

  function showCustomerDetails(customerId) {
    const customer = customers.find(row => row.id === customerId);
    if (!customer) return;
    const customerBills = bills.filter(bill => bill.customerId === customerId).sort((a, b) => new Date(b.date) - new Date(a.date));
    const totalSpent = customerBills.reduce((sum, bill) => sum + Number(bill.total || 0), 0);
    const totalPaid = customerBills.reduce((sum, bill) => sum + Number(bill.paidTotal || 0), 0);
    const totalDue = customerBills.reduce((sum, bill) => sum + Number(bill.due || 0), 0);
    byId('details-title').textContent = customer.name;
    byId('details-print').hidden = true;
    byId('details-content').innerHTML = `
      <div class="detail-list"><div class="detail-row"><span>Vehicle</span><strong>${esc(customer.vehicleNo || '—')}</strong></div><div class="detail-row"><span>Phone</span><strong>${esc(customer.phone || '—')}</strong></div><div class="detail-row"><span>Email</span><strong>${esc(customer.email || '—')}</strong></div><div class="detail-row"><span>GST</span><strong>${esc(customer.gst || '—')}</strong></div><div class="detail-row"><span>Address</span><strong>${esc(customer.address || '—')}</strong></div></div>
      <div class="details-kpis"><div class="details-kpi"><span>Total billed</span><strong>${currency(totalSpent)}</strong></div><div class="details-kpi"><span>Paid</span><strong>${currency(totalPaid)}</strong></div><div class="details-kpi"><span>Due</span><strong>${currency(totalDue)}</strong></div></div>
      <div class="panel-heading"><div><h3>Invoice history</h3><p>${customerBills.length} invoices</p></div><button class="text-button" data-action="edit-customer" data-id="${esc(customer.id)}">Edit customer</button></div>
      ${customerBills.length ? customerBills.slice(0, 20).map(bill => `<div class="detail-row"><span>${esc(bill.invoiceNo)} · ${dateOnly(bill.date)}</span><strong>${currency(bill.total)} ${bill.due > 0 ? `· ${currency(bill.due)} due` : '· Paid'}</strong></div>`).join('') : '<div class="empty-state">No invoices for this customer yet.</div>'}`;
    showDialog('details-dialog');
  }

  // ---------- Billing and inventory reduction ----------
  function findInventory(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return inventory.filter(item => `${item.name} ${item.code}`.toLowerCase().includes(q)).slice(0, 8);
  }

  function renderBillSuggestions() {
    const matches = findInventory(byId('bill-item-search').value);
    const box = byId('bill-suggestions');
    if (!matches.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.innerHTML = matches.map(item => `<div class="suggestion-item" data-action="choose-bill-item" data-id="${esc(item.id)}"><strong>${esc(item.name)}</strong><small>${esc(item.code)} · ${Number(item.quantity)} available · ${currency(item.price)}</small></div>`).join('');
    box.style.display = 'block';
  }

  function chooseBillItem(id) {
    const item = inventory.find(row => row.id === id);
    if (!item) return;
    selectedBillSuggestion = item;
    byId('bill-item-search').value = `${item.name} · ${item.code}`;
    byId('bill-suggestions').style.display = 'none';
  }

  function addSelectedBillItem() {
    const item = selectedBillSuggestion;
    const qty = Number(byId('bill-add-qty').value);
    if (!item) { toast('Choose an item from the search results first.', 'warning'); return; }
    if (!Number.isInteger(qty) || qty < 1) { toast('Quantity must be a positive whole number.', 'error'); return; }
    const already = currentCart.filter(row => row.inventoryId === item.id).reduce((sum, row) => sum + row.qty, 0);
    if (already + qty > Number(item.quantity || 0)) { toast(`Only ${Number(item.quantity || 0) - already} more unit(s) are available.`, 'error'); return; }
    const existing = currentCart.find(row => row.inventoryId === item.id);
    if (existing) existing.qty += qty;
    else currentCart.push({ id: uuid(), inventoryId: item.id, code: item.code, name: item.name, qty, unitPrice: Number(item.price || 0) });
    selectedBillSuggestion = null; byId('bill-item-search').value = ''; byId('bill-add-qty').value = '1';
    renderCart();
  }

  function renderCart() {
    byId('bill-cart').innerHTML = currentCart.length ? currentCart.map(item => `
      <tr><td><div class="table-main">${esc(item.name)}</div><div class="table-sub">${esc(item.code)}</div></td><td><input class="cart-qty" type="number" min="1" step="1" value="${item.qty}" data-cart-qty="${esc(item.id)}" aria-label="Quantity"></td><td><input class="cart-price" type="number" min="0" step="0.01" value="${item.unitPrice}" data-cart-price="${esc(item.id)}" aria-label="Unit price"></td><td><strong>${currency(item.qty * item.unitPrice)}</strong></td><td><button class="remove-line" data-action="remove-cart-item" data-id="${esc(item.id)}" aria-label="Remove item">×</button></td></tr>`).join('') : '<tr><td colspan="5" class="empty-cell">Your bill is empty. Add an item above.</td></tr>';
    updateBillTotals();
  }

  function updateBillTotals() {
    const subtotal = money(currentCart.reduce((sum, item) => sum + item.qty * item.unitPrice, 0));
    const discount = Number(byId('bill-discount').value || 0);
    const total = Math.max(0, money(subtotal - (Number.isFinite(discount) ? discount : 0)));
    const paid = Number(byId('bill-paid').value || 0);
    const due = total - (Number.isFinite(paid) ? paid : 0);
    byId('bill-subtotal').textContent = currency(subtotal);
    byId('bill-total').textContent = currency(total);
    byId('bill-due').textContent = currency(Math.max(0, due));
    byId('bill-payment-label').textContent = due < 0 ? 'Change to return' : 'Remaining due';
    byId('bill-due').style.color = due < 0 ? '#168c66' : '#c14b58';
    byId('save-bill-button').disabled = currentCart.length === 0 || discount < 0 || discount > subtotal || paid < 0 || paid > total;
  }

  function clearBillDraft() {
    currentCart = []; selectedBillSuggestion = null;
    byId('bill-customer').value = ''; byId('bill-vehicle').value = '';
    byId('bill-item-search').value = ''; byId('bill-add-qty').value = '1';
    byId('bill-discount').value = '0'; byId('bill-paid').value = '0';
    byId('bill-payment-method').value = 'Cash'; byId('bill-date').value = new Date().toISOString().slice(0, 10);
    byId('bill-suggestions').style.display = 'none'; renderCart();
  }

  async function finalizeBill() {
    const customerId = byId('bill-customer').value;
    const customer = customers.find(row => row.id === customerId);
    if (!customer) { toast('Choose a customer before saving the invoice.', 'error'); return; }
    if (!currentCart.length) { toast('Add at least one item to the invoice.', 'error'); return; }
    let totals;
    try { totals = Core.calculateTotals(currentCart, byId('bill-discount').value, byId('bill-paid').value); }
    catch (error) { toast(error.message, 'error'); return; }
    const chosenDate = byId('bill-date').value || new Date().toISOString().slice(0, 10);
    const billDate = new Date(`${chosenDate}T12:00:00`).toISOString();
    const vehicleNo = (byId('bill-vehicle').value || customer.vehicleNo || '').trim().toUpperCase();
    const now = new Date().toISOString();
    const billId = uuid();
    const itemSnapshot = currentCart.map(item => ({ inventoryId: item.inventoryId, code: item.code, name: item.name, qty: item.qty, unitPrice: money(item.unitPrice), lineTotal: money(item.qty * item.unitPrice) }));

    // Stock updates, sequence number, bill and initial payment are committed in one IndexedDB transaction.
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['inventory', 'settings', 'bills', 'payments', 'stockMovements'], 'readwrite');
      const inventoryStore = tx.objectStore('inventory');
      const settingsStore = tx.objectStore('settings');
      const billStore = tx.objectStore('bills');
      const paymentStore = tx.objectStore('payments');
      const movementStore = tx.objectStore('stockMovements');
      const aggregated = Core.aggregateCart(currentCart);
      const records = new Map();
      let pending = aggregated.size;
      let commitStarted = false;
      let settled = false;
      let createdBill = null;

      const fail = message => {
        if (!settled) { settled = true; reject(new Error(message)); }
        try { tx.abort(); } catch (_) {}
      };
      const commit = () => {
        if (commitStarted || settled) return;
        for (const [inventoryId, amount] of aggregated.entries()) {
          const stockItem = records.get(inventoryId);
          if (!stockItem || stockItem.archived) { fail('An item in this draft is no longer available. Reload inventory and retry.'); return; }
          if (Number(stockItem.quantity || 0) < amount) { fail(`${stockItem.name}: only ${Number(stockItem.quantity || 0)} unit(s) remain. The invoice was not saved.`); return; }
        }
        commitStarted = true;
        const counterRequest = settingsStore.get('invoiceCounter');
        counterRequest.onsuccess = () => {
          const next = Number(counterRequest.result?.value || 0) + 1;
          const prefix = String(settings.invoicePrefix || 'INV').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 12) || 'INV';
          const invoiceNo = `${prefix}-${String(next).padStart(6, '0')}`;
          const bill = { id: billId, invoiceNo, customerId, customerName: customer.name, customerPhone: customer.phone || '', customerAddress: customer.address || '', customerGst: customer.gst || '', vehicleNo, date: billDate, savedAt: now, items: itemSnapshot, ...totals, paidTotal: totals.paid, paymentMethod: byId('bill-payment-method').value, status: totals.due <= 0 ? 'paid' : totals.paid > 0 ? 'partial' : 'due', updatedAt: now };
          settingsStore.put({ key: 'invoiceCounter', value: next });
          billStore.add(bill);
          if (totals.paid > 0) paymentStore.add({ id: uuid(), billId, customerId, customerName: customer.name, invoiceNo, amount: totals.paid, method: byId('bill-payment-method').value, notes: 'Initial invoice payment', date: now });
          for (const [inventoryId, amount] of aggregated.entries()) {
            const stockItem = records.get(inventoryId);
            stockItem.quantity = Number(stockItem.quantity || 0) - amount;
            stockItem.updatedAt = now;
            inventoryStore.put(stockItem);
            movementStore.add({ id: uuid(), inventoryId, code: stockItem.code, itemName: stockItem.name, delta: -amount, reason: 'Invoice sale', referenceId: billId, date: now });
          }
          createdBill = bill;
        };
        counterRequest.onerror = () => fail('Could not generate the invoice number.');
      };

      if (pending === 0) commit();
      for (const inventoryId of aggregated.keys()) {
        const request = inventoryStore.get(inventoryId);
        request.onsuccess = () => { records.set(inventoryId, request.result || null); pending -= 1; if (pending === 0) commit(); };
        request.onerror = () => fail('Could not verify stock before saving.');
      }
      tx.oncomplete = () => { if (!settled) { settled = true; resolve(createdBill); } };
      tx.onerror = () => { if (!settled) { settled = true; reject(tx.error || new Error('Invoice could not be saved.')); } };
      tx.onabort = () => { if (!settled) { settled = true; reject(tx.error || new Error('Invoice was cancelled.')); } };
    }).then(async bill => {
      if (!bill) throw new Error('Invoice was not created.');
      currentInvoice = bill;
      await refreshData();
      renderDashboard(); renderInventory(); renderLedger(); renderCustomers();
      populateBillCustomers();
      clearBillDraft();
      showInvoiceDetails(bill, true);
      await afterLocalChange('Invoice and stock changes saved locally.');
      toast(`Invoice ${bill.invoiceNo} saved. Stock has been updated.`, 'success');
    }).catch(error => toast(error.message || 'Could not save this invoice.', 'error'));
  }

  async function savePayment(event) {
    event.preventDefault();
    const billId = byId('payment-bill-id').value;
    const amount = money(byId('payment-amount').value);
    const method = byId('payment-method').value;
    const bill = bills.find(row => row.id === billId);
    if (!bill) { toast('Invoice not found.', 'error'); return; }
    if (!(amount > 0) || amount > Number(bill.due || 0)) { toast(`Enter an amount greater than ₹0 and no more than ${currency(bill.due)}.`, 'error'); return; }
    const now = new Date().toISOString();
    const tx = db.transaction(['bills', 'payments'], 'readwrite');
    const billStore = tx.objectStore('bills');
    const request = billStore.get(billId);
    request.onsuccess = () => {
      const current = request.result;
      if (!current || amount > Number(current.due || 0)) { tx.abort(); return; }
      current.paidTotal = money(Number(current.paidTotal || 0) + amount);
      current.due = money(Number(current.total || 0) - current.paidTotal);
      current.status = current.due <= 0 ? 'paid' : 'partial';
      current.updatedAt = now;
      billStore.put(current);
      tx.objectStore('payments').add({ id: uuid(), billId, customerId: current.customerId, customerName: current.customerName, invoiceNo: current.invoiceNo, amount, method, notes: byId('payment-notes').value.trim(), date: now });
    };
    tx.oncomplete = async () => {
      closeAllDialogs(); await refreshData(); renderLedger(); renderDashboard(); renderCustomers();
      await afterLocalChange('Payment saved locally.'); toast('Payment recorded successfully.', 'success');
    };
    tx.onerror = () => toast(tx.error?.message || 'Payment could not be saved.', 'error');
    tx.onabort = () => toast('Payment was not saved. The due amount may have changed.', 'warning');
  }

  function openPaymentDialog(billId) {
    const bill = bills.find(row => row.id === billId);
    if (!bill || bill.due <= 0) return;
    byId('payment-bill-id').value = bill.id;
    byId('payment-context').textContent = `${bill.invoiceNo} · ${bill.customerName} · Outstanding ${currency(bill.due)}`;
    byId('payment-amount').value = money(bill.due).toFixed(2);
    byId('payment-amount').max = bill.due;
    byId('payment-method').value = 'Cash'; byId('payment-notes').value = '';
    showDialog('payment-dialog');
  }

  function showInvoiceDetails(bill, showPrint = false) {
    currentInvoice = bill;
    byId('details-title').textContent = `Invoice ${bill.invoiceNo}`;
    byId('details-print').hidden = !showPrint;
    const lines = bill.items.map(item => `<tr><td>${esc(item.name)}</td><td>${item.qty}</td><td>${currency(item.unitPrice)}</td><td>${currency(item.lineTotal)}</td></tr>`).join('');
    const workshopName = settings.workshopName || 'WORKSHOP PRO';
    byId('details-content').innerHTML = `<div class="invoice-preview" id="invoice-print-area"><div class="invoice-brand">${esc(workshopName)}</div><div class="invoice-subtitle">TAX INVOICE / RECEIPT</div><div class="invoice-meta"><div><strong>Invoice:</strong> ${esc(bill.invoiceNo)}<br><strong>Date:</strong> ${dateTime(bill.date)}</div><div><strong>Customer:</strong> ${esc(bill.customerName)}<br><strong>Vehicle:</strong> ${esc(bill.vehicleNo || '—')}</div><div><strong>Phone:</strong> ${esc(bill.customerPhone || '—')}<br><strong>GST:</strong> ${esc(bill.customerGst || '—')}</div><div><strong>Workshop:</strong> ${esc(settings.workshopPhone || '')}<br>${esc(settings.workshopAddress || '')}</div></div><div class="table-scroll"><table class="invoice-table"><thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>${lines}</tbody></table></div><div class="invoice-totals"><div><span>Subtotal</span><strong>${currency(bill.subtotal)}</strong></div><div><span>Discount</span><strong>${currency(bill.discount)}</strong></div><div class="total"><span>Total</span><strong>${currency(bill.total)}</strong></div><div><span>Paid</span><strong>${currency(bill.paidTotal)}</strong></div><div><span>Balance due</span><strong>${currency(bill.due)}</strong></div></div><div class="invoice-thanks">Thank you for your business.</div></div><div class="details-kpis"><div class="details-kpi"><span>Invoice total</span><strong>${currency(bill.total)}</strong></div><div class="details-kpi"><span>Received</span><strong>${currency(bill.paidTotal)}</strong></div><div class="details-kpi"><span>Balance due</span><strong>${currency(bill.due)}</strong></div></div>`;
    showDialog('details-dialog');
  }

  function printCurrentInvoice() {
    if (!currentInvoice) { toast('No invoice is selected.', 'warning'); return; }
    const content = byId('invoice-print-area')?.outerHTML;
    if (!content) return;
    const printWindow = window.open('', '_blank', 'width=900,height=700');
    if (!printWindow) { toast('Allow pop-ups to print or save the invoice as PDF.', 'warning'); return; }
    printWindow.document.write(`<!doctype html><html><head><title>${esc(currentInvoice.invoiceNo)}</title><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;color:#172b43;padding:28px}.invoice-preview{max-width:760px;margin:auto}.invoice-brand{text-align:center;font-size:22px;font-weight:bold;color:#5367e8}.invoice-subtitle{text-align:center;font-size:10px;letter-spacing:2px;color:#788;margin:5px 0 20px}.invoice-meta{display:grid;grid-template-columns:1fr 1fr;gap:9px;font-size:11px;margin-bottom:18px;line-height:1.7}table{width:100%;border-collapse:collapse;font-size:11px}th,td{text-align:left;padding:9px;border-bottom:1px solid #e8edf2}th{background:#f2f4ff}.invoice-totals{width:260px;margin:16px 0 0 auto;display:grid;gap:8px;font-size:11px}.invoice-totals div{display:flex;justify-content:space-between}.invoice-totals .total{border-top:1px solid #ddd;padding-top:9px;font-size:14px;font-weight:bold}.invoice-thanks{text-align:center;color:#888;font-size:10px;margin-top:30px}@media print{body{padding:0}}</style></head><body>${content}<script>window.onload=()=>{window.print();};<\/script></body></html>`);
    printWindow.document.close();
  }

  // ---------- Ledger and reports ----------
  function filteredBills() {
    const q = byId('ledger-search').value.trim().toLowerCase();
    const period = byId('ledger-period').value;
    const from = byId('ledger-from').value;
    const to = byId('ledger-to').value;
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let rows = bills.filter(bill => !q || `${bill.customerName} ${bill.vehicleNo} ${bill.invoiceNo}`.toLowerCase().includes(q));
    if (period === 'today') rows = rows.filter(bill => new Date(bill.date) >= startToday);
    if (period === 'week') { const cutoff = new Date(startToday); cutoff.setDate(cutoff.getDate() - 6); rows = rows.filter(bill => new Date(bill.date) >= cutoff); }
    if (period === 'month') rows = rows.filter(bill => { const d = new Date(bill.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
    if (period === 'custom' || from || to) {
      if (from) rows = rows.filter(bill => new Date(bill.date) >= new Date(`${from}T00:00:00`));
      if (to) rows = rows.filter(bill => new Date(bill.date) <= new Date(`${to}T23:59:59.999`));
    }
    const sort = byId('ledger-sort').value;
    rows.sort(sort === 'oldest' ? (a, b) => new Date(a.date) - new Date(b.date) : sort === 'high' ? (a, b) => b.total - a.total : sort === 'low' ? (a, b) => a.total - b.total : (a, b) => new Date(b.date) - new Date(a.date));
    return rows;
  }

  function renderLedger() {
    const rows = filteredBills();
    byId('ledger-sales').textContent = currency(rows.reduce((sum, bill) => sum + Number(bill.total || 0), 0));
    byId('ledger-paid').textContent = currency(rows.reduce((sum, bill) => sum + Number(bill.paidTotal || 0), 0));
    byId('ledger-due').textContent = currency(rows.reduce((sum, bill) => sum + Number(bill.due || 0), 0));
    byId('ledger-count').textContent = rows.length;
    byId('ledger-list').innerHTML = rows.length ? rows.map(bill => `
      <div class="ledger-entry"><div class="ledger-entry-main"><strong>${esc(bill.customerName)} <span class="muted">· ${esc(bill.invoiceNo)}</span></strong><small>${dateTime(bill.date)} · ${esc(bill.vehicleNo || 'No vehicle')}</small></div><div class="ledger-entry-amount"><strong>${currency(bill.total)}</strong><small>${bill.due > 0 ? `${currency(bill.due)} due` : 'Paid'}</small></div><div class="ledger-entry-actions"><button class="tiny-btn" data-action="view-invoice" data-id="${esc(bill.id)}">View invoice</button>${bill.due > 0 ? `<button class="tiny-btn" data-action="collect-payment" data-id="${esc(bill.id)}">Collect payment</button>` : ''}</div></div>`).join('') : '<div class="empty-state">No invoices found for these filters.</div>';
    const balances = Core.deriveCustomerBalances(bills);
    byId('customer-balances').innerHTML = balances.length ? balances.map(row => `<div class="balance-row"><div><strong>${esc(row.name)}</strong><small>${row.invoices} invoice(s) outstanding</small></div><b>${currency(row.due)}</b></div>`).join('') : '<div class="empty-state">No pending dues.</div>';
  }

  function resetLedgerFilters() {
    byId('ledger-search').value = ''; byId('ledger-from').value = ''; byId('ledger-to').value = '';
    byId('ledger-period').value = 'all'; byId('ledger-sort').value = 'newest'; renderLedger();
  }

  function renderReports() {
    const from = byId('report-from').value;
    const to = byId('report-to').value;
    const rows = bills.filter(bill => (!from || new Date(bill.date) >= new Date(`${from}T00:00:00`)) && (!to || new Date(bill.date) <= new Date(`${to}T23:59:59.999`)));
    const sales = rows.reduce((sum, bill) => sum + Number(bill.total || 0), 0);
    const paymentRows = payments.filter(payment => (!from || new Date(payment.date) >= new Date(`${from}T00:00:00`)) && (!to || new Date(payment.date) <= new Date(`${to}T23:59:59.999`)));
    const collected = paymentRows.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
    byId('report-sales').textContent = currency(sales);
    byId('report-collected').textContent = currency(collected);
    byId('report-due').textContent = currency(rows.reduce((sum, bill) => sum + Number(bill.due || 0), 0));
    byId('report-invoices').textContent = rows.length;
    const stockValue = inventory.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.price || 0), 0);
    byId('report-stock-value').textContent = currency(stockValue);
    byId('report-low-items').textContent = inventory.filter(item => inventoryStatus(item) === 'low').length;
    byId('report-out-items').textContent = inventory.filter(item => inventoryStatus(item) === 'out').length;
    const dayGroups = new Map();
    for (const bill of rows) {
      const day = new Date(bill.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
      dayGroups.set(day, (dayGroups.get(day) || 0) + Number(bill.total || 0));
    }
    const chartRows = [...dayGroups.entries()].slice(-10);
    const max = Math.max(1, ...chartRows.map(([, value]) => value));
    byId('sales-chart').innerHTML = chartRows.length ? chartRows.map(([day, value]) => `<div class="bar-group"><span class="bar-value">${currency(value)}</span><div class="bar" style="height:${Math.max(4, (value / max) * 150)}px"></div><span class="bar-label">${esc(day)}</span></div>`).join('') : '<div class="empty-state">No sales data for this period.</div>';
  }

  // ---------- CSV and local backups ----------
  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.style.display = 'none';
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function downloadCSV(rows, columns, filename) {
    const csv = Core.toCSV(rows, columns);
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename);
  }

  function exportInventory() {
    downloadCSV(inventory, [
      { label: 'Item code', value: 'code' }, { label: 'Item name', value: 'name' }, { label: 'Category', value: 'category' },
      { label: 'Quantity', value: 'quantity' }, { label: 'Minimum stock', value: 'minStock' }, { label: 'Unit price', value: 'price' }, { label: 'Location', value: 'location' }
    ], 'workshop_inventory.csv');
    toast('Inventory CSV exported.', 'success');
  }

  function exportLedger() {
    downloadCSV(bills, [
      { label: 'Invoice', value: 'invoiceNo' }, { label: 'Date', value: row => dateTime(row.date) }, { label: 'Customer', value: 'customerName' },
      { label: 'Vehicle', value: 'vehicleNo' }, { label: 'Subtotal', value: 'subtotal' }, { label: 'Discount', value: 'discount' },
      { label: 'Total', value: 'total' }, { label: 'Paid', value: 'paidTotal' }, { label: 'Due', value: 'due' }, { label: 'Payment method', value: 'paymentMethod' }
    ], 'workshop_ledger.csv');
    toast('Ledger CSV exported.', 'success');
  }

  async function createBackupPayload() {
    const data = {};
    for (const store of STORES) data[store] = await readAll(store);
    return { app: 'WorkshopPro', schemaVersion: 2, exportedAt: new Date().toISOString(), data };
  }

  async function downloadLocalBackup() {
    const payload = await createBackupPayload();
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `WorkshopPro_Backup_${new Date().toISOString().slice(0, 10)}.json`);
    toast('Backup file downloaded.', 'success');
  }

  async function importBackupFile(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      Core.validateBackup(payload);
      if (!confirm('Restore this backup? All current local Workshop Pro records will be replaced. A safety backup download will be created first.')) return;
      const safetyCopy = await createBackupPayload();
      downloadBlob(new Blob([JSON.stringify(safetyCopy, null, 2)], { type: 'application/json' }), `WorkshopPro_Before_Restore_${new Date().toISOString().slice(0, 10)}.json`);
      await replaceAllData(payload.data);
      currentCart = []; await refreshData();
      renderDashboard(); renderInventory(); renderCustomers(); renderLedger(); renderReports(); renderSettings(); populateBillCustomers(); clearBillDraft();
      await afterLocalChange('Backup restored to this device.');
      toast('Backup restored successfully.', 'success');
    } catch (error) { toast(error.message || 'Could not restore this backup file.', 'error'); }
    finally { byId('backup-file').value = ''; }
  }

  // ---------- Google Drive backup / restore ----------
  function driveConfigured() { return Boolean(String(CONFIG.googleClientId || '').trim()); }

  function updateDriveUI() {
    const connected = Boolean(driveToken);
    byId('drive-state').textContent = connected ? 'Connected for this session' : 'Not connected';
    byId('drive-state').classList.toggle('connected', connected);
    byId('drive-config-note').textContent = driveConfigured() ? (connected ? 'Google Drive is connected for this browser session.' : 'Google Drive is ready. Connect to authorize this browser session.') : 'Add your Google OAuth Client ID in config.js, enable the Google Drive API, and allow your website origin in Google Cloud Console.';
    byId('drive-auto-backup').checked = Boolean(settings.autoDriveBackup);
    byId('drive-upload').disabled = !connected;
    byId('drive-restore').disabled = !connected;
  }

  function initGoogleDrive() {
    updateDriveUI();
    const start = () => {
      if (driveTokenClient || !driveConfigured()) return;
      if (!window.google?.accounts?.oauth2) return;
      driveTokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.googleClientId,
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: async response => {
          if (response.error || !response.access_token) { toast(`Google authorization failed: ${response.error || 'No access token received.'}`, 'error'); return; }
          driveToken = response.access_token;
          driveBaselineLoaded = false;
          driveSessionReadyForAutoBackup = false;
          updateDriveUI();
          try {
            const existing = await findDriveBackup();
            driveFileId = existing?.id || null;
            driveKnownModifiedTime = existing?.modifiedTime || null;
            driveBaselineLoaded = true;
            toast(existing ? 'Google Drive connected. A backup exists; choose Restore or Back up now before automatic uploads resume.' : 'Google Drive connected. Create the first backup with Back up now.', 'success');
          } catch (error) { toast(`Connected, but could not inspect the existing Drive backup: ${error.message}`, 'warning'); }
          updateDriveUI();
        },
        error_callback: error => toast(error?.message || 'Google sign-in window was closed or blocked.', 'error')
      });
    };
    if (window.google?.accounts?.oauth2) start();
    else {
      window.addEventListener('load', start, { once: true });
      let attempts = 0;
      const checkGoogle = window.setInterval(() => {
        attempts += 1;
        if (window.google?.accounts?.oauth2) { window.clearInterval(checkGoogle); start(); }
        if (attempts >= 30) window.clearInterval(checkGoogle);
      }, 500);
    }
  }

  function connectDrive() {
    if (!driveConfigured()) { toast('Add your Google OAuth Client ID in config.js first.', 'warning'); return; }
    if (!window.google?.accounts?.oauth2) { toast('Google Identity Services did not load. Check your internet connection.', 'error'); return; }
    if (!driveTokenClient) initGoogleDrive();
    if (!driveTokenClient) { toast('Google Drive authorization is not ready.', 'error'); return; }
    driveTokenClient.requestAccessToken({ prompt: driveToken ? '' : 'consent' });
  }

  async function driveFetch(url, options = {}) {
    if (!driveToken) throw new Error('Connect Google Drive first.');
    const response = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${driveToken}` } });
    if (response.status === 401) { driveToken = null; updateDriveUI(); throw new Error('Google authorization expired. Reconnect Google Drive and try again.'); }
    if (!response.ok) {
      let detail = '';
      try { const body = await response.json(); detail = body.error?.message || ''; } catch (_) {}
      throw new Error(detail || `Google Drive request failed (${response.status}).`);
    }
    return response;
  }

  async function findDriveBackup() {
    const name = String(CONFIG.driveBackupFileName || 'WorkshopPro_Backup.json').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const query = encodeURIComponent(`name = '${name}' and trashed = false`);
    const response = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${query}&pageSize=20&orderBy=modifiedTime%20desc&fields=files(id,name,mimeType,modifiedTime,size)`);
    const result = await response.json();
    return result.files?.[0] || null;
  }

  function makeMultipart(metadata, payload) {
    const boundary = `workshop_pro_${uuid().replace(/-/g, '')}`;
    const first = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
    const second = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n`;
    const ending = `--${boundary}--`;
    return { boundary, body: new Blob([first, second, ending], { type: `multipart/related; boundary=${boundary}` }) };
  }

  async function backupToDrive(options = {}) {
    const automatic = Boolean(options.automatic);
    try {
      if (!driveToken) { if (!automatic) toast('Connect Google Drive first.', 'warning'); return; }
      if (automatic && !driveSessionReadyForAutoBackup) return;
      byId('backup-status').textContent = 'Uploading backup to Google Drive…';
      const existing = await findDriveBackup();
      if (!driveBaselineLoaded) {
        if (automatic) return;
        driveKnownModifiedTime = existing?.modifiedTime || null;
        driveBaselineLoaded = true;
      }
      const remoteChanged = existing
        ? existing.modifiedTime !== driveKnownModifiedTime
        : driveKnownModifiedTime !== null;
      if (remoteChanged) {
        if (automatic) {
          driveSessionReadyForAutoBackup = false;
          byId('backup-status').textContent = 'Drive backup changed elsewhere. Automatic upload paused to protect the newer backup.';
          toast('A different device changed the Drive backup. Automatic upload paused; restore or manually confirm an overwrite.', 'warning');
          return;
        }
        const accepted = confirm("The Google Drive backup has changed since this browser last checked it. Overwrite that newer backup with this device's data? Choose Cancel, then Restore, to keep the newer Drive data.");
        if (!accepted) return;
      }
      const payload = await createBackupPayload();
      const metadata = { name: CONFIG.driveBackupFileName || 'WorkshopPro_Backup.json', mimeType: 'application/json' };
      const multipart = makeMultipart(metadata, payload);
      const url = existing
        ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existing.id)}?uploadType=multipart&fields=id,modifiedTime`
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime';
      const response = await driveFetch(url, { method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${multipart.boundary}` }, body: multipart.body });
      const result = await response.json();
      driveFileId = result.id || existing?.id || null;
      driveKnownModifiedTime = result.modifiedTime || (await findDriveBackup())?.modifiedTime || null;
      driveBaselineLoaded = true;
      driveSessionReadyForAutoBackup = true;
      byId('backup-status').textContent = `Last Drive backup ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
      toast('Backup uploaded to Google Drive.', 'success');
    } catch (error) { byId('backup-status').textContent = 'Local records are safe; Drive backup did not complete.'; toast(error.message || 'Google Drive backup failed.', 'error'); }
  }

  async function restoreFromDrive() {
    try {
      if (!driveToken) { toast('Connect Google Drive first.', 'warning'); return; }
      const file = await findDriveBackup();
      if (!file) { toast('No Workshop Pro backup was found in this Google Drive account.', 'warning'); return; }
      if (!confirm(`Restore “${file.name}”${file.modifiedTime ? ` last modified ${dateTime(file.modifiedTime)}` : ''}? This replaces all current local Workshop Pro records. A safety backup will be downloaded first.`)) return;
      const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);
      const payload = await response.json();
      Core.validateBackup(payload);
      const safetyCopy = await createBackupPayload();
      downloadBlob(new Blob([JSON.stringify(safetyCopy, null, 2)], { type: 'application/json' }), `WorkshopPro_Before_Drive_Restore_${new Date().toISOString().slice(0, 10)}.json`);
      await replaceAllData(payload.data);
      driveFileId = file.id; driveKnownModifiedTime = file.modifiedTime || null; driveBaselineLoaded = true; driveSessionReadyForAutoBackup = true;
      currentCart = []; await refreshData();
      renderDashboard(); renderInventory(); renderCustomers(); renderLedger(); renderReports(); renderSettings(); populateBillCustomers(); clearBillDraft();
      await afterLocalChange('Restored from Google Drive.');
      toast('Google Drive backup restored.', 'success');
    } catch (error) { toast(error.message || 'Google Drive restore failed.', 'error'); }
  }

  function scheduleAutomaticDriveBackup() {
    if (!settings.autoDriveBackup || !driveToken || !driveSessionReadyForAutoBackup) return;
    clearTimeout(autoBackupTimer);
    autoBackupTimer = setTimeout(() => backupToDrive({ automatic: true }), 1800);
  }

  async function updateAutoBackupSetting(checked) {
    await putSetting('autoDriveBackup', Boolean(checked));
    if (checked && !driveToken) toast('Automatic Drive backup is enabled, but connect Google Drive in this session to upload changes.', 'warning');
    if (checked && driveToken && !driveSessionReadyForAutoBackup) toast('Use Back up now or Restore backup once after connecting; automatic upload stays paused until then.', 'warning');
    if (checked && driveToken) scheduleAutomaticDriveBackup();
    if (!checked) clearTimeout(autoBackupTimer);
  }

  // ---------- Settings ----------
  function renderSettings() {
    byId('setting-name').value = settings.workshopName || '';
    byId('setting-phone').value = settings.workshopPhone || '';
    byId('setting-gst').value = settings.workshopGst || '';
    byId('setting-address').value = settings.workshopAddress || '';
    byId('setting-prefix').value = settings.invoicePrefix || 'INV';
    byId('setting-currency').value = 'INR';
    updateDriveUI();
  }

  async function saveSettings(event) {
    event.preventDefault();
    const values = {
      workshopName: byId('setting-name').value.trim(), workshopPhone: byId('setting-phone').value.trim(),
      workshopGst: byId('setting-gst').value.trim(), workshopAddress: byId('setting-address').value.trim(),
      invoicePrefix: byId('setting-prefix').value.trim().replace(/[^a-zA-Z0-9-]/g, '').slice(0, 12) || 'INV'
    };
    for (const [key, value] of Object.entries(values)) await putSetting(key, value);
    await afterLocalChange('Workshop settings saved on this device.');
    renderSettings(); toast('Workshop settings saved.', 'success');
  }

  // ---------- Barcode / QR scanning ----------
  async function openScanner(target) {
    scanTarget = target;
    scannerResultHandled = false;
    torchEnabled = false;
    byId('torch-toggle').textContent = '⚡ Flashlight';
    showDialog('scanner-dialog');
    if (typeof window.Html5Qrcode === 'undefined') { toast('Barcode scanner library is unavailable. Check internet and reload.', 'error'); return; }
    try {
      scanner = new Html5Qrcode('scanner-reader');
      await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 250, height: 170 }, aspectRatio: 1.4 }, text => { if (!scannerResultHandled) { scannerResultHandled = true; handleScannedCode(text); } }, () => {});
    } catch (error) { try { await stopScanner(); } catch (_) {} toast(error.message || 'Could not start the camera. Check browser permission and HTTPS.', 'error'); }
  }

  async function stopScanner() {
    if (!scanner) return;
    try { if (scanner.isScanning) await scanner.stop(); } catch (_) {}
    try { await scanner.clear(); } catch (_) {}
    scanner = null;
  }

  function signalScan() {
    try {
      if (navigator.vibrate) navigator.vibrate(100);
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        const context = new AudioContextClass();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.frequency.value = 880; gain.gain.value = 0.08;
        oscillator.start(); oscillator.stop(context.currentTime + 0.08);
        oscillator.onended = () => context.close();
      }
    } catch (_) { /* Haptics and sound are optional device capabilities. */ }
  }

  async function toggleTorch() {
    if (!scanner || !scanner.isScanning || typeof scanner.applyVideoConstraints !== 'function') { toast('Flashlight is not supported by this camera/browser.', 'warning'); return; }
    try {
      const next = !torchEnabled;
      await scanner.applyVideoConstraints({ advanced: [{ torch: next }] });
      torchEnabled = next;
      byId('torch-toggle').textContent = torchEnabled ? '⚡ Flashlight on' : '⚡ Flashlight';
    } catch (_) { toast('This device does not allow the camera flashlight to be controlled.', 'warning'); }
  }

  async function handleScannedCode(code) {
    signalScan();
    const value = String(code || '').trim();
    if (!value) return;
    await stopScanner(); closeAllDialogs();
    if (scanTarget === 'stock') {
      const match = inventory.find(item => item.code.toLowerCase() === value.toLowerCase());
      openStockDialog(match || null);
      if (!match) byId('stock-code').value = value;
      toast(match ? 'Existing item found. Add stock or update its details.' : 'New barcode captured. Complete the item details.', 'success');
    } else {
      const match = inventory.find(item => item.code.toLowerCase() === value.toLowerCase());
      if (!match) { toast(`No inventory item found for barcode ${value}. Add it in Inventory first.`, 'warning'); return; }
      chooseBillItem(match.id); addSelectedBillItem();
    }
  }

  async function scanImageFile(file) {
    if (!file) return;
    await stopScanner();
    if (typeof window.Html5Qrcode === 'undefined') { toast('Barcode scanner library is unavailable.', 'error'); return; }
    const temporaryId = 'scanner-image-reader-temp';
    let element = byId(temporaryId);
    if (!element) { element = document.createElement('div'); element.id = temporaryId; element.style.display = 'none'; document.body.appendChild(element); }
    const imageScanner = new Html5Qrcode(temporaryId);
    try {
      const code = await imageScanner.scanFile(file, true);
      await imageScanner.clear(); element.remove();
      await handleScannedCode(code);
    } catch (error) { try { await imageScanner.clear(); } catch (_) {} element.remove(); toast('No readable barcode was found in that image.', 'error'); }
    byId('scanner-image').value = '';
  }

  // ---------- Event wiring ----------
  document.addEventListener('click', event => {
    const actionElement = event.target.closest('[data-action]');
    const viewElement = event.target.closest('[data-view]');
    if (viewElement) { showView(viewElement.dataset.view); return; }
    if (!actionElement) {
      if (!event.target.closest('.item-search-field')) byId('bill-suggestions').style.display = 'none';
      return;
    }
    const { action, id } = actionElement.dataset;
    if (action === 'open-stock') openStockDialog();
    if (action === 'open-customer') openCustomerDialog();
    if (action === 'go-billing') showView('billing');
    if (action === 'edit-stock') openStockDialog(inventory.find(row => row.id === id));
    if (action === 'archive-stock') archiveStock(id);
    if (action === 'customer-details') showCustomerDetails(id);
    if (action === 'edit-customer') { closeAllDialogs(); openCustomerDialog(customers.find(row => row.id === id)); }
    if (action === 'choose-bill-item') chooseBillItem(id);
    if (action === 'add-bill-item') addSelectedBillItem();
    if (action === 'open-service-line') { byId('service-form').reset(); byId('service-qty').value = '1'; byId('service-price').value = '0'; showDialog('service-dialog'); }
    if (action === 'remove-cart-item') { currentCart = currentCart.filter(row => row.id !== id); renderCart(); }
    if (action === 'save-bill') finalizeBill();
    if (action === 'clear-bill') { if (!currentCart.length || confirm('Clear this unsaved invoice draft?')) clearBillDraft(); }
    if (action === 'collect-payment') openPaymentDialog(id);
    if (action === 'view-invoice') { const bill = bills.find(row => row.id === id); if (bill) showInvoiceDetails(bill, true); }
    if (action === 'print-current-invoice') printCurrentInvoice();
    if (action === 'close-dialog') closeAllDialogs();
    if (action === 'open-scanner-bill') openScanner('billing');
    if (action === 'open-scanner-stock') openScanner('stock');
    if (action === 'stop-scanner-close') { stopScanner(); closeAllDialogs(); }
    if (action === 'toggle-flash') toggleTorch();
    if (action === 'export-inventory') exportInventory();
    if (action === 'export-ledger') exportLedger();
    if (action === 'reset-ledger') resetLedgerFilters();
    if (action === 'apply-reports') renderReports();
    if (action === 'backup-download') downloadLocalBackup();
    if (action === 'backup-import') byId('backup-file').click();
    if (action === 'drive-connect') connectDrive();
    if (action === 'drive-upload') backupToDrive();
    if (action === 'drive-restore') restoreFromDrive();
  });

  document.addEventListener('input', event => {
    if (event.target.matches('#inventory-search,#inventory-filter,#inventory-category-filter,#inventory-sort')) renderInventory();
    if (event.target.matches('#customer-search')) renderCustomers();
    if (event.target.matches('#bill-item-search')) { selectedBillSuggestion = null; renderBillSuggestions(); }
    if (event.target.matches('#bill-discount,#bill-paid')) updateBillTotals();
    if (event.target.matches('[data-cart-qty]')) {
      const item = currentCart.find(row => row.id === event.target.dataset.cartQty);
      const value = Number(event.target.value);
      if (item && Number.isInteger(value) && value > 0) item.qty = value;
      updateCartLine(event.target);
    }
    if (event.target.matches('[data-cart-price]')) {
      const item = currentCart.find(row => row.id === event.target.dataset.cartPrice);
      const value = Number(event.target.value);
      if (item && Number.isFinite(value) && value >= 0) item.unitPrice = money(value);
      updateCartLine(event.target);
    }
    if (event.target.matches('#ledger-search,#ledger-from,#ledger-to,#ledger-period,#ledger-sort')) renderLedger();
  });

  function updateCartLine(input) {
    const row = input.closest('tr');
    const item = currentCart.find(entry => entry.id === (input.dataset.cartQty || input.dataset.cartPrice));
    if (row && item) row.cells[3].innerHTML = `<strong>${currency(item.qty * item.unitPrice)}</strong>`;
    updateBillTotals();
  }

  document.addEventListener('change', event => {
    if (event.target.matches('#inventory-filter,#inventory-category-filter,#inventory-sort')) renderInventory();
    if (event.target.matches('#ledger-period,#ledger-sort')) renderLedger();
    if (event.target.id === 'bill-customer') {
      const customer = customers.find(row => row.id === event.target.value);
      if (customer) byId('bill-vehicle').value = customer.vehicleNo || '';
    }
    if (event.target.id === 'backup-file') importBackupFile(event.target.files?.[0]);
    if (event.target.id === 'scanner-image') scanImageFile(event.target.files?.[0]);
    if (event.target.id === 'drive-auto-backup') updateAutoBackupSetting(event.target.checked);
  });

  byId('stock-form').addEventListener('submit', event => saveStock(event).catch(error => toast(error.message, 'error')));
  byId('customer-form').addEventListener('submit', event => saveCustomer(event).catch(error => toast(error.message, 'error')));
  byId('payment-form').addEventListener('submit', event => savePayment(event));
  byId('service-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = byId('service-name').value.trim();
    const qty = Number(byId('service-qty').value);
    const unitPrice = Number(byId('service-price').value);
    if (!name || !Number.isInteger(qty) || qty < 1 || !Number.isFinite(unitPrice) || unitPrice < 0) { toast('Enter a description, valid quantity and non-negative price.', 'error'); return; }
    currentCart.push({ id: uuid(), inventoryId: null, code: 'SERVICE', name, qty, unitPrice: money(unitPrice) });
    closeAllDialogs(); renderCart(); toast('Service / miscellaneous line added.', 'success');
  });
  byId('settings-form').addEventListener('submit', event => saveSettings(event).catch(error => toast(error.message, 'error')));
  byId('menu-toggle').addEventListener('click', openSidebar);
  byId('sidebar-close').addEventListener('click', closeSidebar);
  byId('mobile-scrim').addEventListener('click', closeSidebar);
  byId('bill-item-search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); const first = findInventory(byId('bill-item-search').value)[0]; if (first) { chooseBillItem(first.id); addSelectedBillItem(); } } });
  byId('bill-add-qty').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addSelectedBillItem(); } });
  window.addEventListener('online', updateNetworkState);
  window.addEventListener('offline', updateNetworkState);
  window.addEventListener('beforeunload', () => { if (scanner?.isScanning) scanner.stop().catch(() => {}); });

  // ---------- Startup ----------
  async function initialize() {
    try {
      if (!('indexedDB' in window)) throw new Error('This browser does not support local database storage. Use a current version of Chrome, Edge, Safari or Firefox.');
      db = await openDatabase();
      await refreshData();
      renderDashboard(); renderInventory(); renderCustomers(); renderLedger(); renderReports(); renderSettings(); populateBillCustomers(); clearBillDraft();
      updateNetworkState();
      byId('page-title').textContent = 'Dashboard';
      if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Offline app shell could not be installed:', error));
      }
      initGoogleDrive();
      if (!settings.workshopName) byId('backup-status').textContent = 'Add your workshop details in Settings. Your records save on this device.';
    } catch (error) {
      console.error(error);
      toast(error.message || 'Workshop Pro could not start.', 'error');
      byId('backup-status').textContent = 'Database could not be opened.';
    }
  }

  initialize();
})();
