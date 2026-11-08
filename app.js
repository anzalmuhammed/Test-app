(() => {
  'use strict';

  const Core = window.WorkshopCore;
  const CONFIG = window.WORKSHOP_CONFIG || {};
  const DB_NAME = 'WorkshopProDB_v2';
  const DB_VERSION = 6;
  const STORES = ['customers', 'inventory', 'services', 'bills', 'payments', 'stockMovements', 'settings', 'auditLog'];
  const APP_MODE = window.WORKSHOP_MODE === 'shop' ? 'shop' : 'admin';
  const IS_SHOP = APP_MODE === 'shop';
  const money = value => Core.money(value);
  const currency = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(money(value));
  const IST = 'Asia/Kolkata';
  const dateTime = value => value ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: IST }).format(new Date(value)) + ' IST' : '—';
  const dateOnly = value => value ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: IST }).format(new Date(value)) : '—';
  const todayIST = () => { const parts = new Intl.DateTimeFormat('en-GB', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); const part = key => parts.find(item => item.type === key)?.value || ''; return `${part('year')}-${part('month')}-${part('day')}`; };
  const byId = id => document.getElementById(id);
  const uuid = () => (crypto?.randomUUID ? crypto.randomUUID() : `wp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const titleCase = value => Core.titleCase(value);
  const titleCaseWhileTyping = value => Core.titleCaseWhileTyping(value);

  function normalizeInputValue(input) {
    if (!input || typeof input.matches !== 'function') return;
    if (input.matches('[data-format="title"]')) {
      const start = input.selectionStart, end = input.selectionEnd;
      input.value = titleCaseWhileTyping(input.value);
      try { input.setSelectionRange(start, end); } catch (_) {}
    } else if (input.matches('[data-format="vehicle"]')) {
      const start = input.selectionStart, end = input.selectionEnd;
      input.value = input.value.toLocaleUpperCase('en-IN');
      try { input.setSelectionRange(start, end); } catch (_) {}
    }
  }

  function applyAppMode() {
    document.body.classList.toggle('mode-shop', IS_SHOP);
    document.body.classList.toggle('mode-admin', !IS_SHOP);
    document.querySelectorAll('[data-admin-only]').forEach(el => { el.hidden = IS_SHOP; });
    if (IS_SHOP) { const inventoryActionHeader = document.querySelector('#view-inventory thead th:last-child'); if (inventoryActionHeader) inventoryActionHeader.hidden = true; }
    document.querySelectorAll('[data-shop-hide]').forEach(el => { el.hidden = IS_SHOP; });
    document.querySelectorAll('[data-shop-only]').forEach(el => { el.hidden = !IS_SHOP; });
    if (IS_SHOP) {
      document.querySelectorAll('[data-view="dashboard"],[data-view="services"],[data-view="reports"],[data-view="settings"],[data-view="database"]').forEach(el => { el.hidden = true; });
      document.querySelectorAll('#view-dashboard,#view-services,#view-reports,#view-settings,#view-database').forEach(el => { el.hidden = true; el.classList.remove('active'); });
      document.querySelectorAll('.second-label').forEach(el => { el.hidden = true; });
      document.querySelectorAll('[data-action="open-stock"],[data-action="open-scanner-stock"]').forEach(el => { el.hidden = true; });
      document.querySelectorAll('[data-view="billing"]').forEach(el => el.classList.add('active'));
      if (byId('view-billing')) { byId('view-billing').hidden = false; byId('view-billing').classList.add('active'); }
      byId('page-title').textContent = 'Quick Billing';
      byId('page-eyebrow').textContent = 'SHOP WORKSPACE';
    }
  }

  async function addAudit(table, recordId, field, beforeValue, afterValue, action = 'update') {
    const entry = {
      id: uuid(), table, recordId: String(recordId ?? ''), field: String(field || '*'), action,
      before: structuredClone(beforeValue ?? null), after: structuredClone(afterValue ?? null),
      mode: APP_MODE, at: new Date().toISOString()
    };
    try {
      await writeOne('auditLog', entry);
      auditLog.push(entry);
    } catch (error) {
      console.error('Audit log entry could not be saved:', error);
      toast('The business record was saved, but its audit entry could not be written. Download a local backup.', 'warning');
    }
  }

  async function ensureAdminWriteReady() {
    if (remotePullInProgress) throw new Error('Shared data is being downloaded. Wait a moment before saving another change.');
    if (IS_SHOP) return true;
    if (!navigator.onLine) throw new Error('Admin changes are online-only. Reconnect to the internet before editing.');
    if (!driveToken) throw new Error('Connect Google Drive and load the latest shared backup before making Admin changes.');
    if (!driveBaselineLoaded || !driveSessionReadyForAutoBackup) throw new Error('Load the latest shared Google Drive data first. Use Restore backup before editing.');
    if (!adminWriteArmed) {
      const accepted = confirm('ADMIN EDIT MODE\n\nConfirm that the Shop app/device is paused, has completed its latest backup, and no staff member is creating bills or changing stock. Continue with Admin changes?');
      if (!accepted) throw new Error('Admin edit cancelled. The Shop device must be paused first.');
      adminWriteArmed = true;
    }
    const remote = await findDriveBackup();
    const remoteModified = remote?.modifiedTime || null;
    if (remoteModified !== driveKnownModifiedTime || (!remote && driveKnownModifiedTime)) {
      driveSessionReadyForAutoBackup = false;
      adminWriteArmed = false;
      byId('backup-status').textContent = 'Shared data changed on another device. Admin edits are paused until you restore/check the latest data.';
      throw new Error('The shared Drive file changed since the last check. No Admin edit was made. Restore the newest shared file, then retry.');
    }
    return true;
  }

  function shopReadOnlyAction(action) {
    return IS_SHOP && new Set(['edit-stock','archive-stock','open-stock','open-scanner-stock','open-service-catalog','edit-service-catalog','archive-service-catalog','collect-payment','edit-customer','backup-import']).has(action);
  }


  let db = null;
  let activeView = 'dashboard';
  let customers = [];
  let inventory = [];
  let services = [];
  let bills = [];
  let payments = [];
  let stockMovements = [];
  let settings = {};
  let auditLog = [];
  let adminWriteArmed = false;
  let databaseRows = [];
  let databaseEditState = null;
  let currentCart = [];
  let selectedBillSuggestion = null;
  let currentInvoice = null;
  let scanner = null;
  let scanTarget = 'billing';
  let scannerResultHandled = false;
  let torchEnabled = false;
  let driveToken = null;
  let driveTokenClient = null;
  let driveSilentAttempt = false;
  let driveInteractivePending = false;
  let driveFileId = null;
  let driveKnownModifiedTime = null;
  let driveBaselineLoaded = false;
  let driveSessionReadyForAutoBackup = false;
  let driveUploadInProgress = false;
  let localChangeGeneration = 0;
  let autoBackupTimer = null;
  let syncPollTimer = null;
  let driveSyncInProgress = false;
  let remotePullInProgress = false;
  let lastSavedAt = null;
  let stockBarcodeLookupTimer = null;
  let billBarcodeLookupTimer = null;
  const tabId = uuid();
  const updateChannel = ('BroadcastChannel' in window) ? new BroadcastChannel('WorkshopProDB_updates') : null;
  const barcodeWedge = { buffer: '', lastAt: 0, startedAt: 0, times: [], origin: null, originValue: '', confirmed: false, timer: null };
  const BARCODE_MIN_LENGTH = 4;
  const BARCODE_MAX_GAP_MS = 65;

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
        // Kept outside the business stores so a remote snapshot can never erase the
        // last local safety copy when it replaces the working records.
        if (!database.objectStoreNames.contains('syncSafety')) database.createObjectStore('syncSafety', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => { database.close(); toast('Workshop Pro was updated in another tab. Reload this page.', 'warning'); };
        resolve(database);
      };
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
    if (!remotePullInProgress) recordLocalChange();
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
    if (!remotePullInProgress) recordLocalChange();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES, 'readwrite');
      try {
        for (const name of STORES) {
          const store = tx.objectStore(name);
          store.clear();
          for (const record of (data[name] || [])) store.put(record);
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
    const [customerRows, inventoryRows, serviceRows, billRows, paymentRows, movementRows, settingRows, auditRows] = await Promise.all(STORES.map(readAll));
    customers = customerRows;
    inventory = inventoryRows.filter(item => !item.archived);
    services = serviceRows.filter(item => !item.archived);
    bills = billRows;
    payments = paymentRows;
    stockMovements = movementRows;
    settings = Object.fromEntries(settingRows.map(row => [row.key, row.value]));
    auditLog = auditRows;
  }

  async function putSetting(key, value) {
    await writeOne('settings', { key, value });
    settings[key] = value;
  }

  function refreshDatabaseHealth() {
    const target = byId('database-health');
    if (!target) return;
    const usage = customers.length + inventory.length + services.length + bills.length + payments.length + stockMovements.length + auditLog.length;
    target.textContent = `Local database · ${customers.length} customers · ${inventory.length} stock items · ${services.length} services · ${bills.length} invoices · ${payments.length} payments · ${stockMovements.length} stock movements · ${auditLog.length} audit entries (${usage} records).`;
  }

  function readLocalChangeGeneration() {
    try {
      const saved = Number(localStorage.getItem('workshoppro-v6-local-generation') || 0);
      if (Number.isFinite(saved)) localChangeGeneration = Math.max(localChangeGeneration, saved);
    } catch (_) {}
    return localChangeGeneration;
  }

  function recordLocalChange(clean = false) {
    const next = readLocalChangeGeneration() + 1;
    localChangeGeneration = next;
    try {
      localStorage.setItem('workshoppro-v6-local-generation', String(next));
      localStorage.setItem('workshoppro-v6-local-dirty', clean ? '0' : '1');
    } catch (_) {}
  }

  async function afterLocalChange(message = 'Changes saved on this device.', options = {}) {
    lastSavedAt = new Date();
    recordLocalChange(Boolean(options.clean));
    byId('last-saved-label').textContent = `Saved ${new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: IST }).format(lastSavedAt)} IST`;
    const isDirty = (() => { try { return localStorage.getItem('workshoppro-v6-local-dirty') === '1'; } catch (_) { return true; } })();
    byId('backup-status').textContent = isDirty && !driveSessionReadyForAutoBackup ? `${message} Pending shared backup.` : message;
    refreshDatabaseHealth();
    if (!options.clean) {
      scheduleAutomaticDriveBackup();
      if (driveToken && navigator.onLine) window.setTimeout(() => automaticDriveSync('local-change'), 2200);
    }
    if (updateChannel) updateChannel.postMessage({ type: 'database-changed', source: tabId, at: Date.now() });
    else {
      try { localStorage.setItem('workshoppro-db-ping', `${tabId}:${Date.now()}`); } catch (_) {}
    }
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
    dashboard: ['OVERVIEW', 'Dashboard'], billing: ['SALES', 'Quick Billing'], inventory: ['STOCK CONTROL', 'Inventory'], services: ['SERVICE CATALOGUE', 'Services & items'],
    customers: ['CUSTOMER DIRECTORY', 'Customers'], ledger: ['ACCOUNTS', 'Ledger & Payments'], reports: ['ANALYTICS', 'Reports'], settings: ['PREFERENCES', 'Settings & Backup'], database: ['ADMINISTRATION', 'Database editor']
  };

  async function showView(view) {
    if (!viewMeta[view]) return;
    if (IS_SHOP && !['billing','customers','inventory','ledger'].includes(view)) return;
    activeView = view;
    document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === `view-${view}`));
    document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === view && el.classList.contains('nav-link')));
    byId('page-eyebrow').textContent = viewMeta[view][0];
    byId('page-title').textContent = viewMeta[view][1];
    closeSidebar();
    if (view === 'dashboard') renderDashboard();
    if (view === 'inventory') renderInventory();
    if (view === 'services') renderServices();
    if (view === 'billing') populateBillCustomers();
    if (view === 'customers') renderCustomers();
    if (view === 'ledger') renderLedger();
    if (view === 'reports') renderReports();
    if (view === 'settings') renderSettings();
    if (view === 'database') renderDatabaseEditor();
  }

  function updateNetworkState() {
    const online = navigator.onLine;
    byId('network-dot').classList.toggle('online', online);
    byId('network-label').textContent = online ? 'Online' : 'Offline mode';
    if (!online) byId('backup-status').textContent = 'Offline: changes are saved locally. They are pending until the shared Drive file is updated.';
    else if (driveToken && driveSessionReadyForAutoBackup) byId('backup-status').textContent = 'Online: automatic two-way Google Drive sync is ready.';
    else byId('backup-status').textContent = 'Online: local database active. Cloud backup is separate and optional.';
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
    byId('today-label').textContent = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: IST }).format(new Date());

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

  function getStockMovementSummary(inventoryId) {
    let stockIn = 0;
    let sold = 0;
    for (const movement of stockMovements) {
      if (movement.inventoryId !== inventoryId) continue;
      const delta = Number(movement.delta || 0);
      if (delta > 0) stockIn += delta;
      else if (delta < 0) sold += Math.abs(delta);
    }
    return { stockIn, sold };
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
      const movementTotals = getStockMovementSummary(item.id);
      return `<tr><td><div class="table-main">${esc(item.name)}</div><div class="table-sub">${esc(item.code)}</div></td><td>${esc(item.category || 'General')}</td><td>${movementTotals.stockIn}</td><td>${movementTotals.sold}</td><td><strong>${Number(item.quantity || 0)}</strong></td><td>${Number(item.minStock || 0)}</td><td>${currency(item.price)}</td><td>${esc(item.location || '—')}</td><td><span class="stock-tag ${status}">${label}</span></td>${IS_SHOP ? '' : `<td><div class="row-actions"><button class="tiny-btn" data-action="edit-stock" data-id="${esc(item.id)}">Edit</button><button class="tiny-btn" data-action="stock-history" data-id="${esc(item.id)}">History</button><button class="tiny-btn danger" data-action="archive-stock" data-id="${esc(item.id)}">Archive</button></div></td>`}</tr>`;
    }).join('') : `<tr><td colspan="${IS_SHOP ? 9 : 10}" class="empty-cell">No items match these filters.</td></tr>`;
  }

  function openStockDialog(item = null, scannedCode = '') {
    byId('stock-form').reset();
    byId('stock-id').value = item?.id || '';
    byId('stock-dialog-title').textContent = item ? 'Receive stock / edit item' : 'Add stock';
    byId('stock-code').value = scannedCode || item?.code || '';
    byId('stock-code').disabled = Boolean(item);
    byId('stock-name').value = item?.name || '';
    byId('stock-price').value = item?.price ?? ''; 
    byId('stock-quantity').value = item ? 0 : 1;
    byId('stock-quantity').min = item ? 0 : 1;
    byId('stock-category').value = item?.category || 'General';
    byId('stock-min').value = item?.minStock ?? 5;
    byId('stock-location').value = item?.location || '';
    showDialog('stock-dialog');
    window.setTimeout(() => {
      const target = item ? byId('stock-quantity') : byId('stock-code');
      target?.focus();
    }, 80);
  }

  function stockBarcodeLookup() {
    const code = byId('stock-code').value.trim();
    if (!code) return;
    const item = inventory.find(row => row.code.toLowerCase() === code.toLowerCase());
    if (item) {
      byId('stock-id').value = item.id;
      byId('stock-name').value = item.name;
      byId('stock-price').value = item.price ?? ''; 
      byId('stock-category').value = item.category || 'General';
      byId('stock-min').value = item.minStock ?? 5;
      byId('stock-location').value = item.location || '';
      byId('stock-code').disabled = true;
      byId('stock-dialog-title').textContent = 'Receive stock / edit item';
      byId('stock-quantity').min = '0';
      byId('stock-quantity').value = '0';
      byId('stock-quantity').focus();
      toast(`Found ${item.name}. Enter quantity received, or leave 0 to only update details.`, 'success');
    } else {
      byId('stock-id').value = '';
      byId('stock-code').disabled = false;
      byId('stock-dialog-title').textContent = 'Add stock';
      byId('stock-name').focus();
      toast('New barcode captured. Enter the item details.', 'success');
    }
  }

  async function saveStock(event) {
    event.preventDefault();
    await ensureAdminWriteReady();
    let id = byId('stock-id').value;
    const code = byId('stock-code').value.trim();
    const name = titleCase(byId('stock-name').value);
    const price = Number(byId('stock-price').value);
    const qty = Number(byId('stock-quantity').value);
    const minStock = Number(byId('stock-min').value);
    if (!code || !name || !Number.isFinite(price) || price < 0 || !Number.isInteger(qty) || qty < (id ? 0 : 1) || !Number.isInteger(minStock) || minStock < 0) {
      toast('Check the item details. New items need at least 1 unit; existing items may be updated with 0 received.', 'error'); return;
    }
    const now = new Date().toISOString();
    recordLocalChange();
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(['inventory', 'stockMovements'], 'readwrite');
      const inventoryStore = tx.objectStore('inventory');
      const movementStore = tx.objectStore('stockMovements');
      const allRequest = inventoryStore.getAll();
      let savedRecord = null;
      let failure = null;
      allRequest.onsuccess = () => {
        try {
          const rows = allRequest.result || [];
          const duplicate = rows.find(row => String(row.code || '').toLowerCase() === code.toLowerCase() && row.id !== id);
          if (duplicate && !duplicate.archived) throw new Error('That barcode / item code is already assigned to another item.');
          if (!id && duplicate?.archived) id = duplicate.id;
          let record = id ? rows.find(row => row.id === id) : null;
          if (id && !record) throw new Error('This stock item no longer exists. Refresh and try again.');
          if (!record) record = { id: uuid(), code, quantity: 0, createdAt: now, archived: false };
          record.name = name;
          record.price = money(price);
          record.quantity = Number(record.quantity || 0) + qty;
          record.minStock = minStock;
          record.category = byId('stock-category').value;
          record.location = byId('stock-location').value.trim();
          record.updatedAt = now;
          record.archived = false;
          inventoryStore.put(record);
          if (qty > 0) movementStore.add({ id: uuid(), inventoryId: record.id, code: record.code, itemName: record.name, delta: qty, reason: 'Stock received', referenceId: '', date: now });
          savedRecord = record;
        } catch (error) { failure = error; try { tx.abort(); } catch (_) {} }
      };
      allRequest.onerror = () => { failure = allRequest.error || new Error('Could not read inventory.'); try { tx.abort(); } catch (_) {} };
      tx.oncomplete = () => resolve(savedRecord);
      tx.onerror = () => reject(failure || tx.error || new Error('Inventory update failed.'));
      tx.onabort = () => reject(failure || tx.error || new Error('Inventory update was cancelled.'));
    });
    if (!result) throw new Error('Inventory record was not saved.');
    await addAudit('inventory', result.id, '*', null, { code: result.code, name: result.name, price: result.price, quantity: result.quantity, minStock: result.minStock }, id ? 'update' : 'create');
    closeAllDialogs();
    await refreshData();
    renderInventory(); renderDashboard(); renderReports();
    await afterLocalChange('Inventory and stock movement saved to this device database.');
    toast('Inventory saved. Database updated successfully.', 'success');
  }

  async function archiveStock(id) {
    await ensureAdminWriteReady();
    const item = inventory.find(row => row.id === id);
    if (!item) return;
    if (!confirm(`Archive “${item.name}”? It will be hidden from stock lists and billing, but old invoices will be kept.`)) return;
    const record = await readOne('inventory', id);
    record.archived = true; record.updatedAt = new Date().toISOString();
    await writeOne('inventory', record);
    await addAudit('inventory', id, 'archived', false, true, 'archive');
    await refreshData(); renderInventory(); renderDashboard(); renderReports(); await afterLocalChange('Inventory updated on this device.');
    toast('Item archived. Historical invoices are unchanged.', 'success');
  }

  function showStockHistory(inventoryId) {
    const item = inventory.find(row => row.id === inventoryId);
    if (!item) return;
    const history = stockMovements.filter(row => row.inventoryId === inventoryId).sort((a, b) => new Date(b.date) - new Date(a.date));
    byId('details-title').textContent = `${item.name} · Stock history`;
    byId('details-print').hidden = true;
    byId('details-content').innerHTML = `<div class="detail-list"><div class="detail-row"><span>Barcode / code</span><strong>${esc(item.code)}</strong></div><div class="detail-row"><span>Available now</span><strong>${Number(item.quantity || 0)}</strong></div><div class="detail-row"><span>Unit price</span><strong>${currency(item.price)}</strong></div></div><div class="panel-heading"><div><h3>Stock movements</h3><p>${history.length} movements recorded</p></div></div>${history.length ? `<div class="table-scroll"><table><thead><tr><th>Date</th><th>Movement</th><th>Qty</th><th>Reference</th></tr></thead><tbody>${history.map(row => `<tr><td>${dateTime(row.date)}</td><td>${esc(row.reason || 'Adjustment')}</td><td>${Number(row.delta) > 0 ? '+' : ''}${Number(row.delta || 0)}</td><td>${esc(row.referenceId || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">No stock movement records yet.</div>'}`;
    showDialog('details-dialog');
  }

  // ---------- Customer management ----------
  function filterBillCustomers() {
    const query = (byId('bill-customer-search')?.value || '').trim().toLowerCase();
    const select = byId('bill-customer');
    const current = select.value;
    const matches = [...customers].filter(customer => !query || `${customer.name} ${customer.phone || ''} ${customer.vehicleNo || ''}`.toLowerCase().includes(query)).sort((a,b) => a.name.localeCompare(b.name));
    select.innerHTML = '<option value="">Select customer</option>' + matches.map(customer => `<option value="${esc(customer.id)}">${esc(customer.name)} · ${esc(customer.phone || 'No phone')}${customer.vehicleNo ? ` · ${esc(customer.vehicleNo)}` : ''}</option>`).join('');
    if (matches.some(row => row.id === current)) select.value = current;
  }

  function renderSavedServiceSuggestions() {
    const query = (byId('bill-service-search')?.value || '').trim().toLowerCase();
    const box = byId('bill-service-suggestions'); if (!box) return;
    const matches = query ? services.filter(row => `${row.name} ${row.kind}`.toLowerCase().includes(query)).slice(0, 8) : [];
    box.innerHTML = matches.map(row => `<div class="suggestion-item" data-action="choose-bill-service" data-id="${esc(row.id)}"><strong>${esc(row.name)}</strong><small>${row.kind === 'service' ? 'Service' : 'Non-stock item'} · Qty 0 · ${currency(row.price)}</small></div>`).join('');
    box.style.display = matches.length ? 'block' : 'none';
  }

  function renderServices() {
    if (!byId('services-table')) return;
    const query = (byId('service-search')?.value || '').trim().toLowerCase();
    const kind = byId('service-kind-filter')?.value || 'all';
    const rows = services.filter(row => (!query || `${row.name} ${row.notes || ''}`.toLowerCase().includes(query)) && (kind === 'all' || row.kind === kind)).sort((a,b) => a.name.localeCompare(b.name));
    byId('services-table').innerHTML = rows.length ? rows.map(row => `<tr><td><strong>${esc(row.name)}</strong><div class="table-sub">${esc(row.notes || '')}</div></td><td>${row.kind === 'service' ? 'Service' : 'Non-stock item'}</td><td>${currency(row.price)}</td><td>0</td><td>${dateOnly(row.updatedAt || row.createdAt)}</td><td><div class="row-actions"><button class="tiny-btn" data-action="use-service-catalog" data-id="${esc(row.id)}">Add to bill</button>${IS_SHOP ? '' : `<button class="tiny-btn" data-action="edit-service-catalog" data-id="${esc(row.id)}">Edit</button><button class="tiny-btn danger" data-action="archive-service-catalog" data-id="${esc(row.id)}">Archive</button>`}</div></td></tr>`).join('') : '<tr><td colspan="6" class="empty-cell">No services or non-stock items found.</td></tr>';
  }

  function openServiceCatalogDialog(row = null) {
    byId('service-catalog-form').reset(); byId('service-catalog-id').value = row?.id || '';
    byId('service-catalog-title').textContent = row ? 'Edit service / item' : 'Add service / item';
    byId('service-catalog-name').value = row?.name || ''; byId('service-catalog-kind').value = row?.kind || 'service';
    byId('service-catalog-price').value = row?.price ?? ''; byId('service-catalog-notes').value = row?.notes || ''; showDialog('service-catalog-dialog');
  }

  async function saveServiceCatalog(event) {
    event.preventDefault();
    await ensureAdminWriteReady(); const id = byId('service-catalog-id').value; const name = titleCase(byId('service-catalog-name').value);
    const price = Number(byId('service-catalog-price').value); const kind = byId('service-catalog-kind').value;
    if (!name || byId('service-catalog-price').value === '' || !Number.isFinite(price) || price < 0) { toast('Enter a name and valid price.', 'error'); return; }
    const duplicate = services.find(row => row.id !== id && row.name.trim().toLowerCase() === name.toLowerCase() && row.kind === kind);
    if (duplicate && !confirm(`“${name}” already exists. Save another entry anyway?`)) return;
    const now = new Date().toISOString(); const record = id ? await readOne('services', id) : { id: uuid(), quantity: 0, archived: false, createdAt: now };
    if (!record) throw new Error('Service record was not found.');
    Object.assign(record, { name, kind, price: money(price), quantity: 0, notes: byId('service-catalog-notes').value.trim(), archived: false, updatedAt: now });
    await writeOne('services', record); await addAudit('services', record.id, '*', id ? 'existing record' : null, { name: record.name, kind: record.kind, price: record.price }, id ? 'update' : 'create'); closeAllDialogs(); await refreshData(); renderServices(); await afterLocalChange('Service catalogue updated on this device.'); toast('Service / item saved.', 'success');
  }

  async function archiveServiceCatalog(id) {
    await ensureAdminWriteReady();
    const row = services.find(item => item.id === id); if (!row || !confirm(`Archive “${row.name}”? Existing invoices will be preserved.`)) return;
    row.archived = true; row.updatedAt = new Date().toISOString(); await writeOne('services', row); await addAudit('services', id, 'archived', false, true, 'archive'); await refreshData(); renderServices(); await afterLocalChange('Service archived.');
  }

  function addCatalogServiceToCart(id) {
    const row = services.find(item => item.id === id); if (!row) return;
    currentCart.push({ id: uuid(), inventoryId: null, serviceId: row.id, code: row.kind === 'service' ? 'SERVICE' : 'NON-STOCK', name: row.name, qty: 1, unitPrice: money(row.price), catalogKind: row.kind, saveToCatalog: false });
    renderCart(); toast(`${row.name} added to invoice.`, 'success');
  }

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
    if (IS_SHOP && customer) { toast('Shop mode can add new customers but cannot edit existing records.', 'warning'); return; }
    byId('customer-form').reset();
    byId('customer-id').value = customer?.id || '';
    byId('customer-dialog-title').textContent = customer ? 'Edit customer' : 'Add customer';
    byId('customer-name-input').value = customer?.name || '';
    byId('customer-vehicle-input').value = String(customer?.vehicleNo || '').toLocaleUpperCase('en-IN');
    byId('customer-phone-input').value = customer?.phone || '';
    byId('customer-email-input').value = customer?.email || '';
    byId('customer-gst-input').value = customer?.gst || '';
    byId('customer-address-input').value = customer?.address || '';
    showDialog('customer-dialog');
  }

  async function saveCustomer(event) {
    event.preventDefault();
    await ensureAdminWriteReady();
    const id = byId('customer-id').value;
    const name = titleCase(byId('customer-name-input').value);
    const vehicleNo = byId('customer-vehicle-input').value.trim().toLocaleUpperCase('en-IN');
    const phone = byId('customer-phone-input').value.trim();
    const email = byId('customer-email-input').value.trim();
    if (!name) { toast('Customer name is required.', 'error'); byId('customer-name-input').focus(); return; }
    if (!/^\d{10}$/.test(phone)) { toast('A valid 10-digit phone number is required.', 'error'); byId('customer-phone-input').focus(); return; }
    const now = new Date().toISOString();
    const record = id ? await readOne('customers', id) : { id: uuid(), createdAt: now };
    if (!record) { toast('Customer record not found.', 'error'); return; }
    Object.assign(record, { name, vehicleNo, phone, email, gst: byId('customer-gst-input').value.trim(), address: byId('customer-address-input').value.trim(), updatedAt: now });
    await writeOne('customers', record);
    await addAudit('customers', record.id, '*', id ? 'existing record' : null, { name: record.name, vehicleNo: record.vehicleNo, phone: record.phone }, id ? 'update' : 'create');
    closeAllDialogs(); await refreshData(); renderCustomers(); populateBillCustomers(); renderLedger(); renderDashboard(); await afterLocalChange('Customer details saved on this device.');
    toast('Customer saved.', 'success');
  }

  function populateBillCustomers() {
    const select = byId('bill-customer');
    filterBillCustomers();
    byId('bill-date').value ||= todayIST();
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
      <div class="panel-heading"><div><h3>Invoice history</h3><p>${customerBills.length} invoices</p></div>${IS_SHOP ? '' : `<button class="text-button" data-action="edit-customer" data-id="${esc(customer.id)}">Edit customer</button>`}</div>
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
    selectedBillSuggestion = null; byId('bill-item-search').value = ''; if (byId('bill-service-search')) byId('bill-service-search').value = ''; if (byId('bill-service-suggestions')) byId('bill-service-suggestions').style.display = 'none'; byId('bill-add-qty').value = '1';
    renderCart();
  }

  function renderCart() {
    byId('bill-cart').innerHTML = currentCart.length ? currentCart.map(item => `
      <tr><td><div class="table-main">${esc(item.name)}</div><div class="table-sub">${esc(item.code)}</div></td><td><div class="cart-quantity-control"><button type="button" data-action="cart-minus" data-id="${esc(item.id)}" aria-label="Decrease quantity">−</button><input class="cart-qty" type="number" min="1" step="1" value="${item.qty}" data-cart-qty="${esc(item.id)}" aria-label="Quantity"><button type="button" data-action="cart-plus" data-id="${esc(item.id)}" aria-label="Increase quantity">＋</button></div></td><td><input class="cart-price" type="number" min="0" step="0.01" value="${item.unitPrice}" data-cart-price="${esc(item.id)}" aria-label="Unit price"></td><td><strong>${currency(item.qty * item.unitPrice)}</strong></td><td><button class="remove-line" data-action="remove-cart-item" data-id="${esc(item.id)}" aria-label="Remove item">×</button></td></tr>`).join('') : '<tr><td colspan="5" class="empty-cell">Your bill is empty. Add an item above.</td></tr>';
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
    byId('bill-customer').value = ''; if (byId('bill-customer-search')) byId('bill-customer-search').value = ''; filterBillCustomers(); byId('bill-vehicle').value = '';
    byId('bill-item-search').value = ''; if (byId('bill-service-search')) byId('bill-service-search').value = ''; if (byId('bill-service-suggestions')) byId('bill-service-suggestions').style.display = 'none'; byId('bill-add-qty').value = '1';
    byId('bill-discount').value = '0'; byId('bill-paid').value = '0';
    byId('bill-payment-method').value = 'Cash'; byId('bill-date').value = todayIST();
    byId('bill-suggestions').style.display = 'none'; renderCart();
  }

  async function finalizeBill() {
    await ensureAdminWriteReady();
    const customerId = byId('bill-customer').value;
    const customer = customers.find(row => row.id === customerId);
    if (!customer) { toast('Choose a customer before saving the invoice.', 'error'); return; }
    if (!currentCart.length) { toast('Add at least one item to the invoice.', 'error'); return; }
    let totals;
    try { totals = Core.calculateTotals(currentCart, byId('bill-discount').value, byId('bill-paid').value); }
    catch (error) { toast(error.message, 'error'); return; }
    const chosenDate = byId('bill-date').value || todayIST();
    const billDate = `${chosenDate}T00:00:00+05:30`;
    const vehicleNo = String(byId('bill-vehicle').value || customer.vehicleNo || '').trim().toLocaleUpperCase('en-IN');
    const now = new Date().toISOString();
    const billId = uuid();
    const itemSnapshot = currentCart.map(item => { if (!item.inventoryId && item.saveToCatalog && item.createCatalogRecord) item.serviceId = uuid(); return { inventoryId: item.inventoryId, serviceId: item.serviceId || null, kind: item.catalogKind || (item.inventoryId ? 'stock' : 'service'), code: item.code, name: item.name, qty: item.qty, unitPrice: money(item.unitPrice), lineTotal: money(item.qty * item.unitPrice) }; });

    // Stock updates, sequence number, bill and initial payment are committed in one IndexedDB transaction.
    recordLocalChange();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['inventory', 'services', 'settings', 'bills', 'payments', 'stockMovements'], 'readwrite');
      const inventoryStore = tx.objectStore('inventory');
      const serviceStore = tx.objectStore('services');
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
          for (const line of currentCart) {
            if (!line.inventoryId && line.saveToCatalog && line.createCatalogRecord && line.serviceId) {
              const serviceRecord = { id: line.serviceId, name: line.name, kind: line.catalogKind || 'item', price: money(line.unitPrice), quantity: 0, notes: '', archived: false, createdAt: now, updatedAt: now };
              serviceStore.add(serviceRecord);
            }
          }
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
      await addAudit('bills', bill.id, '*', null, { invoiceNo: bill.invoiceNo, total: bill.total, paid: bill.paidTotal, due: bill.due }, 'create');
      await afterLocalChange('Invoice and stock changes saved locally.');
      toast(`Invoice ${bill.invoiceNo} saved. Stock has been updated.`, 'success');
    }).catch(error => toast(error.message || 'Could not save this invoice.', 'error'));
  }

  async function savePayment(event) {
    event.preventDefault();
    await ensureAdminWriteReady();
    const billId = byId('payment-bill-id').value;
    const amount = money(byId('payment-amount').value);
    const method = byId('payment-method').value;
    const bill = bills.find(row => row.id === billId);
    if (!bill) { toast('Invoice not found.', 'error'); return; }
    if (!(amount > 0) || amount > Number(bill.due || 0)) { toast(`Enter an amount greater than ₹0 and no more than ${currency(bill.due)}.`, 'error'); return; }
    const now = new Date().toISOString();
    recordLocalChange();
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
      await addAudit('payments', billId, 'payment', null, { amount, method }, 'create');
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
    byId('details-content').innerHTML = `<div class="invoice-preview" id="invoice-print-area"><div class="invoice-brand">${esc(workshopName)}</div><div class="invoice-subtitle">TAX INVOICE / RECEIPT</div><div class="invoice-meta"><div><strong>Invoice:</strong> ${esc(bill.invoiceNo)}<br><strong>Date:</strong> ${dateOnly(bill.date)}<br><strong>Time:</strong> ${dateTime(bill.savedAt || bill.date)}</div><div><strong>Customer:</strong> ${esc(bill.customerName)}<br><strong>Vehicle:</strong> ${esc(bill.vehicleNo || '—')}</div><div><strong>Phone:</strong> ${esc(bill.customerPhone || '—')}<br><strong>GST:</strong> ${esc(bill.customerGst || '—')}</div><div><strong>Workshop:</strong> ${esc(settings.workshopPhone || '')}<br>${esc(settings.workshopAddress || '')}</div></div><div class="table-scroll"><table class="invoice-table"><thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>${lines}</tbody></table></div><div class="invoice-totals"><div><span>Subtotal</span><strong>${currency(bill.subtotal)}</strong></div><div><span>Discount</span><strong>${currency(bill.discount)}</strong></div><div class="total"><span>Total</span><strong>${currency(bill.total)}</strong></div><div><span>Paid</span><strong>${currency(bill.paidTotal)}</strong></div><div><span>Balance due</span><strong>${currency(bill.due)}</strong></div></div><div class="invoice-thanks">Thank you for your business.</div></div><div class="details-kpis"><div class="details-kpi"><span>Invoice total</span><strong>${currency(bill.total)}</strong></div><div class="details-kpi"><span>Received</span><strong>${currency(bill.paidTotal)}</strong></div><div class="details-kpi"><span>Balance due</span><strong>${currency(bill.due)}</strong></div></div>`;
    showDialog('details-dialog');
  }

  function printCurrentInvoice() {
    if (!currentInvoice) { toast('No invoice is selected.', 'warning'); return; }
    const content = byId('invoice-print-area')?.outerHTML;
    if (!content) return;
    const printWindow = window.open('', '_blank', 'width=900,height=700');
    if (!printWindow) { toast('Allow pop-ups to print or save the invoice as PDF.', 'warning'); return; }
    printWindow.document.write(`<!doctype html><html><head><title>${esc(currentInvoice.invoiceNo)}</title><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;color:#172b43;padding:28px}.invoice-preview{max-width:760px;margin:auto}.invoice-brand{text-align:center;font-size:22px;font-weight:bold;color:#5367e8}.invoice-subtitle{text-align:center;font-size:10px;letter-spacing:2px;color:#788;margin:5px 0 20px}.invoice-meta{display:grid;grid-template-columns:1fr 1fr;gap:9px;font-size:11px;margin-bottom:18px;line-height:1.7}table{width:100%;border-collapse:collapse;font-size:11px}th,td{text-align:left;padding:9px;border-bottom:1px solid #e8edf2}th{background:#f2f4ff}.invoice-totals{width:260px;margin:16px 0 0 auto;display:grid;gap:8px;font-size:11px}.invoice-totals div{display:flex;justify-content:space-between}.invoice-totals .total{border-top:2px solid #111;padding-top:10px;font-size:22px;font-weight:900;color:#000}.invoice-totals .total strong{font-size:28px;font-weight:900;color:#000}.invoice-thanks{text-align:center;color:#888;font-size:10px;margin-top:30px}@media print{body{padding:0}}</style></head><body>${content}<script>window.onload=()=>{window.print();};<\/script></body></html>`);
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
      <div class="ledger-entry"><div class="ledger-entry-main"><strong>${esc(bill.customerName)} <span class="muted">· ${esc(bill.invoiceNo)}</span></strong><small>${dateTime(bill.savedAt || bill.date)} · ${esc(bill.vehicleNo || 'No vehicle')}</small></div><div class="ledger-entry-amount"><strong>${currency(bill.total)}</strong><small>${bill.due > 0 ? `${currency(bill.due)} due` : 'Paid'}</small></div><div class="ledger-entry-actions"><button class="tiny-btn" data-action="view-invoice" data-id="${esc(bill.id)}">View invoice</button>${!IS_SHOP && bill.due > 0 ? `<button class="tiny-btn" data-action="collect-payment" data-id="${esc(bill.id)}">Collect payment</button>` : ''}</div></div>`).join('') : '<div class="empty-state">No invoices found for these filters.</div>';
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
      const day = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', timeZone: IST }).format(new Date(bill.date));
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
      { label: 'Stock in', value: row => getStockMovementSummary(row.id).stockIn }, { label: 'Sold / issued', value: row => getStockMovementSummary(row.id).sold }, { label: 'Available', value: 'quantity' }, { label: 'Minimum stock', value: 'minStock' }, { label: 'Unit price', value: 'price' }, { label: 'Location', value: 'location' }
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
    return { app: 'WorkshopPro', schemaVersion: 4, exportedAt: new Date().toISOString(), data };
  }

  async function downloadLatestSyncSafetyCopy() {
    const copies = await readAll('syncSafety');
    if (!copies.length) { toast('No automatic-sync safety copy has been created on this device yet.', 'info'); return; }
    copies.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    const latest = copies[0];
    downloadBlob(new Blob([JSON.stringify(latest.payload, null, 2)], { type: 'application/json' }), `WorkshopPro_PreSync_Safety_${String(latest.savedAt || new Date().toISOString()).slice(0, 10)}.json`);
    toast('Latest pre-sync safety copy downloaded.', 'success');
  }

  async function downloadLocalBackup() {
    const payload = await createBackupPayload();
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `WorkshopPro_Backup_${new Date().toISOString().slice(0, 10)}.json`);
    toast('Backup file downloaded.', 'success');
  }

  async function importBackupFile(file) {
    if (!file) return;
    try {
      if (IS_SHOP) throw new Error('Backup import is available only in the Admin app.');
      await ensureAdminWriteReady();
      const sourcePayload = JSON.parse(await file.text());
      const normalized = Core.normalizeBackupPayload(sourcePayload);
      const payload = normalized.payload;
      const migrationNote = normalized.migratedLegacy ? '\n\nThis is an older Workshop Pro backup. Customers, stock, invoices and recorded payments will be converted to the new database format.' : '';
      if (!confirm(`Restore this backup? All current local Workshop Pro records will be replaced. A safety backup download will be created first.${migrationNote}`)) return;
      const safetyCopy = await createBackupPayload();
      downloadBlob(new Blob([JSON.stringify(safetyCopy, null, 2)], { type: 'application/json' }), `WorkshopPro_Before_Restore_${new Date().toISOString().slice(0, 10)}.json`);
      await replaceAllData(payload.data);
      currentCart = []; await refreshData();
      applyAppMode();
      applyTheme();
      renderDashboard(); renderInventory(); renderServices(); renderCustomers(); renderLedger(); renderReports(); renderSettings(); populateBillCustomers(); clearBillDraft();
      await afterLocalChange(normalized.migratedLegacy ? 'Original Workshop Pro backup converted and restored to this device.' : 'Backup restored to this device.');
      toast(normalized.migratedLegacy ? 'Old Workshop Pro records imported successfully.' : 'Backup restored successfully.', 'success');
    } catch (error) { toast(error.message || 'Could not restore this backup file.', 'error'); }
    finally { byId('backup-file').value = ''; }
  }

  // ---------- Google Drive backup / restore ----------
  function driveConfigured() { return Boolean(String(CONFIG.googleClientId || '').trim()); }

  function showDriveAuthPrompt(message) {
    const gate = byId('drive-auth-gate');
    if (!gate) return;
    let continuedOffline = false;
    try { continuedOffline = sessionStorage.getItem('workshoppro-offline-continue') === '1'; } catch (_) {}
    if (continuedOffline && !navigator.onLine) return;
    if (message && byId('drive-auth-message')) byId('drive-auth-message').textContent = message;
    gate.hidden = false;
    document.body.classList.add('auth-prompt-open');
  }

  function hideDriveAuthPrompt() {
    const gate = byId('drive-auth-gate');
    if (gate) gate.hidden = true;
    document.body.classList.remove('auth-prompt-open');
    try { sessionStorage.removeItem('workshoppro-offline-continue'); } catch (_) {}
  }

  function continueOfflineForSession() {
    try { sessionStorage.setItem('workshoppro-offline-continue', '1'); } catch (_) {}
    hideDriveAuthPrompt();
    byId('backup-status').textContent = 'Offline/local mode: changes save on this device. Sign in when ready to sync.';
  }

  function updateDriveUI() {
    const connected = Boolean(driveToken);
    byId('drive-state').textContent = connected ? 'Connected for this session' : 'Not connected';
    byId('drive-state').classList.toggle('connected', connected);
    byId('drive-config-note').textContent = driveConfigured() ? (connected ? 'Google Drive is connected for this browser session.' : 'Google Drive is ready. Connect to authorize this browser session.') : 'Add your Google OAuth Client ID in config.js, enable the Google Drive API, and allow your website origin in Google Cloud Console.';
    byId('drive-auto-backup').checked = true;
    byId('drive-auto-backup').disabled = true;
    byId('drive-upload').disabled = !connected;
    byId('drive-restore').disabled = !connected;
    const shopState = byId('shop-drive-state');
    if (shopState) { shopState.textContent = connected ? 'Connected' : (navigator.onLine ? 'Sign-in needed' : 'Offline'); shopState.classList.toggle('connected', connected); }
  }

  function initGoogleDrive(options = {}) {
    updateDriveUI();
    if (!driveConfigured() && options.silent) {
      showDriveAuthPrompt('Google sign-in is not configured yet. Add your OAuth Client ID to config.js, then redeploy both apps.');
      return;
    }
    const start = () => {
      if (driveTokenClient || !driveConfigured()) return;
      if (!window.google?.accounts?.oauth2) return;
      driveTokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.googleClientId,
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: async response => {
          if (response.error || !response.access_token) {
            const message = `Google authorization ${response.error || 'failed'}; select Connect Google Drive if you want to retry.`;
            if (driveSilentAttempt) { byId('backup-status').textContent = message; showDriveAuthPrompt('Your Google session needs your approval. Sign in to resume automatic restore and backup.'); }
            else toast(message, 'error');
            driveSilentAttempt = false;
            return;
          }
          driveSilentAttempt = false;
          driveToken = response.access_token;
          hideDriveAuthPrompt();
          try { localStorage.setItem('workshoppro-drive-authorized', '1'); } catch (_) {}
          driveBaselineLoaded = false;
          driveSessionReadyForAutoBackup = false;
          updateDriveUI();
          try {
            const existing = await findDriveBackup();
            driveFileId = existing?.id || null;
            const previousBaseline = (() => { try { return localStorage.getItem('workshoppro-v6-drive-modified') || null; } catch (_) { return null; } })();
            driveKnownModifiedTime = previousBaseline || null;
            driveBaselineLoaded = true;
            const sameBaseline = Boolean(existing && previousBaseline && existing.modifiedTime === previousBaseline);
            driveSessionReadyForAutoBackup = sameBaseline || !existing;
            if (existing) {
              // If this device is clean, the sync cycle safely pulls a newer
              // remote snapshot. If local work is pending, it raises a conflict
              // and leaves both versions untouched.
              driveKnownModifiedTime = previousBaseline;
              toast('Google Drive connected. Automatic two-way sync is checking the shared version.', 'success');
              automaticDriveSync('connect');
              startAutomaticDriveSync();
            } else {
              driveKnownModifiedTime = null;
              toast('Google Drive connected. No shared file exists yet; pending local data can create the first snapshot.', 'success');
              startAutomaticDriveSync();
            }
          } catch (error) { toast(`Connected, but could not inspect the existing Drive backup: ${error.message}`, 'warning'); }
          updateDriveUI();
        },
        error_callback: error => {
          if (driveSilentAttempt) { byId('backup-status').textContent = 'Google Drive session needs reconnecting.'; showDriveAuthPrompt('Google needs you to sign in again. Approve access to resume automatic sync.'); }
          else toast(error?.message || 'Google sign-in window was closed or blocked.', 'error');
          driveSilentAttempt = false;
        }
      });
      if (options.silent) {
        let previouslyAuthorized = false;
        try { previouslyAuthorized = localStorage.getItem('workshoppro-drive-authorized') === '1'; } catch (_) {}
        if (previouslyAuthorized) {
          driveSilentAttempt = true;
          try { driveTokenClient.requestAccessToken({ prompt: 'none' }); }
          catch (_) { driveSilentAttempt = false; byId('backup-status').textContent = 'Google Drive session needs reconnecting.'; showDriveAuthPrompt('Please sign in to reconnect Google Drive and resume automatic sync.'); }
        } else {
          showDriveAuthPrompt(driveConfigured() ? 'Sign in to Google to automatically restore the latest shared data first, then back up new changes.' : 'Google sign-in is not configured yet. Add your OAuth Client ID to config.js, then deploy the app again.');
        }
      }
      if (options.interactive && driveInteractivePending) {
        driveInteractivePending = false;
        driveTokenClient.requestAccessToken({ prompt: '' });
      }
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
    if (!driveTokenClient) {
      driveInteractivePending = true;
      initGoogleDrive({ interactive: true });
      return;
    }
    driveTokenClient.requestAccessToken({ prompt: '' });
  }

  async function driveFetch(url, options = {}) {
    if (!driveToken) throw new Error('Connect Google Drive first.');
    const response = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${driveToken}` } });
    if (response.status === 401) { driveToken = null; driveSessionReadyForAutoBackup = false; updateDriveUI(); showDriveAuthPrompt('Your Google authorization expired. Sign in again to resume automatic restore and backup.'); throw new Error('Google authorization expired. Sign in again to resume automatic sync.'); }
    if (!response.ok) {
      let detail = '';
      try { const body = await response.json(); detail = body.error?.message || ''; } catch (_) {}
      throw new Error(detail || `Google Drive request failed (${response.status}).`);
    }
    return response;
  }

  async function findDriveBackup() {
    const escapeDriveName = value => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const names = [...new Set([CONFIG.driveBackupFileName || 'WorkshopPro_Backup.json', 'workshop_backup.json'])];
    const nameQuery = names.map(name => `name = '${escapeDriveName(name)}'`).join(' or ');
    const query = encodeURIComponent(`(${nameQuery}) and trashed = false`);
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
    if (remotePullInProgress) return;
    if (driveUploadInProgress) {
      if (!automatic) toast('A Google Drive upload is already running. Please wait for its result before starting another.', 'warning');
      return;
    }
    driveUploadInProgress = true;
    try {
      if (!driveToken) { if (!automatic) toast('Connect Google Drive first.', 'warning'); return; }
      if (automatic && !navigator.onLine) { byId('backup-status').textContent = 'Offline: local changes are safe on this device. Drive upload will retry after reconnection.'; return; }
      if (automatic && (!driveSessionReadyForAutoBackup || !hasPendingLocalChanges())) return;
      byId('backup-status').textContent = 'Uploading backup to Google Drive…';
      const existing = await findDriveBackup();
      if (existing && !driveSessionReadyForAutoBackup) {
        byId('backup-status').textContent = 'Shared Drive data has not been verified in this session. Restore/check it before uploading.';
        if (!automatic) toast('Upload is blocked because this device has not confirmed that the shared file is still the same version. Download your local backup, then restore or reconcile the shared file.', 'warning');
        return;
      }
      if (!driveBaselineLoaded) {
        if (automatic) return;
        driveKnownModifiedTime = existing?.modifiedTime || null;
        driveBaselineLoaded = true;
      }
      const remoteChanged = existing
        ? existing.modifiedTime !== driveKnownModifiedTime
        : driveKnownModifiedTime !== null;
      if (remoteChanged) {
        driveSessionReadyForAutoBackup = false;
        adminWriteArmed = false;
        byId('backup-status').textContent = 'Drive file changed elsewhere. Upload paused; this device copy is preserved locally.';
        toast('A different device changed the shared Drive file. Upload is paused. Download this device backup before restoring the newer shared file.', 'warning');
        return;
      }
      const snapshotGeneration = readLocalChangeGeneration();
      const payload = await createBackupPayload();
      // Recheck immediately before PATCH/POST to narrow the race window. Drive
      // still has no atomic compare-and-swap, so this is detection, not a lock.
      const latestBeforeUpload = await findDriveBackup();
      if ((latestBeforeUpload?.id || null) !== (existing?.id || null) ||
          (latestBeforeUpload?.modifiedTime || null) !== (existing?.modifiedTime || null)) {
        driveSessionReadyForAutoBackup = false;
        adminWriteArmed = false;
        byId('backup-status').textContent = 'Conflict needs review: the shared file changed just before upload. Local data remains on this device.';
        if (!automatic) toast('The shared Drive file changed just before upload. Nothing was uploaded; download both copies and reconcile.', 'warning');
        return;
      }
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
      const snapshotStillCurrent = readLocalChangeGeneration() === snapshotGeneration;
      try {
        localStorage.setItem('workshoppro-v6-drive-modified', driveKnownModifiedTime || '');
        localStorage.setItem('workshoppro-v6-local-dirty', snapshotStillCurrent ? '0' : '1');
      } catch (_) {}
      byId('backup-status').textContent = snapshotStillCurrent
        ? `Shared file updated ${dateTime(new Date())}`
        : 'A snapshot was uploaded, but newer local changes are still pending another upload.';
      toast(snapshotStillCurrent ? 'Backup uploaded to Google Drive.' : 'Backup uploaded. Newer local changes are still pending sync.', snapshotStillCurrent ? 'success' : 'warning');
    } catch (error) {
      byId('backup-status').textContent = 'Local records are safe; Drive backup did not complete.';
      toast(error.message || 'Google Drive backup failed.', 'error');
    } finally {
      driveUploadInProgress = false;
      if (hasPendingLocalChanges() && driveToken && driveSessionReadyForAutoBackup && navigator.onLine) scheduleAutomaticDriveBackup();
    }
  }

  async function restoreFromDrive() {
    try {
      if (!driveToken) { toast('Connect Google Drive first.', 'warning'); return; }
      const file = await findDriveBackup();
      if (!file) { toast('No Workshop Pro backup was found in this Google Drive account.', 'warning'); return; }
      if (!confirm(`Restore “${file.name}”${file.modifiedTime ? ` last modified ${dateTime(file.modifiedTime)}` : ''}? This replaces all current local Workshop Pro records. A safety backup will be downloaded first.`)) return;
      const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);
      const sourcePayload = await response.json();
      const normalized = Core.normalizeBackupPayload(sourcePayload);
      const payload = normalized.payload;
      const safetyCopy = await createBackupPayload();
      downloadBlob(new Blob([JSON.stringify(safetyCopy, null, 2)], { type: 'application/json' }), `WorkshopPro_Before_Drive_Restore_${new Date().toISOString().slice(0, 10)}.json`);
      await replaceAllData(payload.data);
      driveFileId = file.id; driveKnownModifiedTime = file.modifiedTime || null; driveBaselineLoaded = true; driveSessionReadyForAutoBackup = true; adminWriteArmed = false;
      try { localStorage.setItem('workshoppro-v6-drive-modified', driveKnownModifiedTime || ''); localStorage.setItem('workshoppro-v6-state-initialized', '1'); } catch (_) {}
      currentCart = []; await refreshData();
      renderDashboard(); renderInventory(); renderServices(); renderCustomers(); renderLedger(); renderReports(); renderSettings(); populateBillCustomers(); clearBillDraft();
      await afterLocalChange('Restored from Google Drive.', { clean: true });
      toast(normalized.migratedLegacy ? 'Old Workshop Pro Google Drive backup imported successfully.' : 'Google Drive backup restored.', 'success');
    } catch (error) { toast(error.message || 'Google Drive restore failed.', 'error'); }
  }

  function saveSyncSafetyCopy(payload) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('syncSafety', 'readwrite');
      const store = tx.objectStore('syncSafety');
      const request = store.getAll();
      request.onsuccess = () => {
        const previous = (request.result || []).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
        previous.slice(4).forEach(row => store.delete(row.id));
        store.put({ id: `before-pull-${Date.now()}`, savedAt: new Date().toISOString(), payload });
      };
      request.onerror = () => { try { tx.abort(); } catch (_) {} };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('Could not preserve the local safety copy before sync.'));
      tx.onabort = () => reject(tx.error || new Error('Local safety-copy transaction was cancelled.'));
    });
  }

  async function renderAllAfterSync() {
    const billCustomer = byId('bill-customer')?.value || '';
    await refreshData();
    renderDashboard(); renderInventory(); renderServices(); renderCustomers(); renderLedger(); renderReports();
    if (!IS_SHOP) renderSettings();
    populateBillCustomers();
    if (customers.some(row => row.id === billCustomer)) byId('bill-customer').value = billCustomer;
    refreshDatabaseHealth();
  }

  async function pullRemoteSnapshot(file) {
    if (remotePullInProgress) return false;
    if (hasPendingLocalChanges()) {
      driveSessionReadyForAutoBackup = false;
      byId('backup-status').textContent = 'Conflict needs review: cloud data changed while this device has pending local changes. Both copies are preserved.';
      return false;
    }
    const generationAtStart = readLocalChangeGeneration();
    remotePullInProgress = true;
    try {
      const response = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);
      const sourcePayload = await response.json();
      const normalized = Core.normalizeBackupPayload(sourcePayload);
      const payload = normalized.payload;
      // Preserve the complete current local state in a separate IndexedDB store
      // before replacing business records. The safety record is not part of the
      // remote snapshot and is not cleared by replaceAllData().
      const safetyCopy = await createBackupPayload();
      await saveSyncSafetyCopy(safetyCopy);
      // Recheck after network I/O and before opening the replacement transaction.
      // All app write handlers are gated while remotePullInProgress is true.
      if (hasPendingLocalChanges() || readLocalChangeGeneration() !== generationAtStart) {
        driveSessionReadyForAutoBackup = false;
        byId('backup-status').textContent = 'Conflict needs review: a local edit appeared during sync. The remote copy was not applied.';
        return false;
      }
      await replaceAllData(payload.data);
      driveFileId = file.id;
      driveKnownModifiedTime = file.modifiedTime || null;
      driveBaselineLoaded = true;
      driveSessionReadyForAutoBackup = true;
      adminWriteArmed = false;
      try {
        localStorage.setItem('workshoppro-v6-drive-modified', driveKnownModifiedTime || '');
        localStorage.setItem('workshoppro-v6-local-dirty', '0');
        localStorage.setItem('workshoppro-v6-state-initialized', '1');
      } catch (_) {}
      await renderAllAfterSync();
      byId('backup-status').textContent = `Synced: downloaded shared changes ${dateTime(file.modifiedTime || new Date())}. Local safety copy retained on this device.`;
      return true;
    } finally {
      remotePullInProgress = false;
    }
  }

  async function automaticDriveSync(reason = 'poll') {
    if (driveSyncInProgress || !driveToken || !navigator.onLine) return;
    driveSyncInProgress = true;
    try {
      byId('backup-status').textContent = 'Syncing: checking shared Google Drive changes…';
      const remote = await findDriveBackup();
      if (!remote) {
        driveKnownModifiedTime = null;
        driveBaselineLoaded = true;
        driveSessionReadyForAutoBackup = true;
        if (hasPendingLocalChanges()) await backupToDrive({ automatic: true });
        else byId('backup-status').textContent = 'Connected: waiting for the first shared backup.';
        return;
      }
      driveFileId = remote.id;
      const remoteChanged = !driveBaselineLoaded || remote.modifiedTime !== driveKnownModifiedTime;
      if (remoteChanged) {
        if (hasPendingLocalChanges()) {
          driveSessionReadyForAutoBackup = false;
          adminWriteArmed = false;
          byId('backup-status').textContent = 'Conflict needs review: the shared file changed while local changes are pending. Local data has not been overwritten.';
          return;
        }
        await pullRemoteSnapshot(remote);
        return;
      }
      driveBaselineLoaded = true;
      driveSessionReadyForAutoBackup = true;
      if (hasPendingLocalChanges()) {
        await backupToDrive({ automatic: true });
      } else {
        byId('backup-status').textContent = `Synced: shared data checked ${dateTime(new Date())}.`;
      }
    } catch (error) {
      byId('backup-status').textContent = `Sync paused: ${error.message || 'Google Drive could not be reached.'}`;
    } finally {
      driveSyncInProgress = false;
    }
  }

  function startAutomaticDriveSync() {
    if (syncPollTimer) window.clearInterval(syncPollTimer);
    if (!driveToken) return;
    automaticDriveSync('start');
    // Poll while the page is open. Closed/suspended browsers cannot guarantee
    // background execution; visibility/focus/online events trigger catch-up.
    syncPollTimer = window.setInterval(() => automaticDriveSync('poll'), 25000);
  }

  function hasPendingLocalChanges() {
    try { return localStorage.getItem('workshoppro-v6-local-dirty') === '1'; } catch (_) { return true; }
  }

  function scheduleAutomaticDriveBackup() {
    if (!settings.autoDriveBackup || !driveToken || !driveSessionReadyForAutoBackup || !navigator.onLine || !hasPendingLocalChanges()) return;
    clearTimeout(autoBackupTimer);
    autoBackupTimer = setTimeout(() => backupToDrive({ automatic: true }), 1800);
  }

  async function updateAutoBackupSetting(checked) {
    await ensureAdminWriteReady();
    await putSetting('autoDriveBackup', Boolean(checked));
    await afterLocalChange('Automatic Google Drive backup preference saved.');
    if (!driveToken) toast('Connect Google Drive in this browser session to enable automatic two-way sync.', 'warning');
    if (driveToken) { startAutomaticDriveSync(); scheduleAutomaticDriveBackup(); }
  }


  // ---------- Admin database table editor ----------
  const databaseKeyField = table => table === 'settings' ? 'key' : 'id';
  const databaseReadOnly = table => table === 'auditLog' || table === 'stockMovements';
  const databaseFieldReadOnly = (table, field) => databaseReadOnly(table) ||
    (table === 'bills' && ['customerId','invoiceNo','items','subtotal','total','paidTotal','due','status'].includes(field)) ||
    (table === 'payments' && ['billId','customerId','invoiceNo'].includes(field));
  const displayDatabaseValue = value => {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  function renderDatabaseAudit() {
    const target = byId('database-audit-results');
    if (!target || IS_SHOP) return;
    const missingPhones = customers.filter(c => !/^\d{10}$/.test(String(c.phone || '').trim())).length;
    const spacedPhones = customers.filter(c => String(c.phone || '') !== String(c.phone || '').trim()).length;
    const nameCounts = new Map();
    for (const customer of customers) {
      const key = String(customer.name || '').trim().toLocaleLowerCase('en-IN');
      if (key) nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
    }
    const duplicateNames = [...nameCounts.values()].filter(count => count > 1).length;
    const uniqueNames = [...nameCounts.keys()].filter(name => name.length >= 4).sort();
    const editDistanceAtMostOne = (a, b) => {
      if (Math.abs(a.length - b.length) > 1) return false;
      let i = 0, j = 0, edits = 0;
      while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { i++; j++; continue; }
        if (++edits > 1) return false;
        if (a.length > b.length) i++;
        else if (b.length > a.length) j++;
        else { i++; j++; }
      }
      if (i < a.length || j < b.length) edits++;
      return edits <= 1;
    };
    let nearMatches = 0;
    // Names are sorted; compare a bounded neighbourhood to avoid quadratic work on huge imports.
    for (let i = 0; i < uniqueNames.length; i++) {
      for (let j = i + 1; j < Math.min(uniqueNames.length, i + 80); j++) {
        if (editDistanceAtMostOne(uniqueNames[i], uniqueNames[j])) nearMatches++;
      }
    }
    const legacyStock = inventory.filter(item => Number(item.legacyTotalSold || 0) > Number(item.legacyTotalIn || 0)).length;
    const duplicateLineBills = bills.filter(bill => {
      const seen = new Set();
      return (bill.items || []).some(item => {
        const key = String(item.inventoryId || item.serviceId || `${item.code || ''}|${item.name || ''}`).toLowerCase();
        if (seen.has(key)) return true;
        seen.add(key); return false;
      });
    }).length;
    const customerIds = new Set(customers.map(customer => customer.id));
    const orphanBills = bills.filter(bill => bill.customerId && !customerIds.has(bill.customerId)).length;
    const billIds = new Set(bills.map(bill => bill.id));
    const orphanPayments = payments.filter(payment => payment.billId && !billIds.has(payment.billId)).length;
    const metrics = [
      ['Customers missing / invalid 10-digit phone', missingPhones],
      ['Phone values with extra spaces', spacedPhones],
      ['Exact duplicate customer-name groups', duplicateNames],
      ['Possible near-match customer-name pairs', nearMatches],
      ['Legacy stock sold exceeds received', legacyStock],
      ['Invoices with repeated item lines', duplicateLineBills],
      ['Invoices with missing customer links', orphanBills],
      ['Payments with missing invoice links', orphanPayments]
    ];
    target.innerHTML = metrics.map(([label, count]) => `<article class="database-audit-item ${count ? 'warn' : 'good'}"><strong>${count}</strong><span>${esc(label)}</span></article>`).join('');
  }

  async function renderDatabaseEditor() {
    if (IS_SHOP || !byId('database-table-select')) return;
    renderDatabaseAudit();
    const table = byId('database-table-select').value;
    const query = byId('database-search').value.trim().toLowerCase();
    databaseRows = await readAll(table);
    const filtered = databaseRows.filter(row => !query || JSON.stringify(row).toLowerCase().includes(query));
    const fields = [...new Set(filtered.flatMap(row => Object.keys(row)))];
    const readOnly = databaseReadOnly(table);
    byId('database-count').textContent = `${filtered.length} matching / ${databaseRows.length} total ${table} records`;
    byId('database-mode-note').textContent = readOnly ? 'Historical records are read-only to protect transaction history.' : 'Admin edits require internet, the latest shared Drive snapshot and a paused Shop device.';
    byId('database-thead').innerHTML = fields.length ? `<tr>${fields.map(field => `<th>${esc(field)}</th>`).join('')}</tr>` : '<tr><th>No fields</th></tr>';
    const keyField = databaseKeyField(table);
    byId('database-tbody').innerHTML = filtered.length ? filtered.map(row => `<tr>${fields.map(field => {
      const value = displayDatabaseValue(row[field]);
      const canEdit = !readOnly && field !== keyField && !databaseFieldReadOnly(table, field);
      return `<td><div class="database-cell"><span title="${esc(value)}">${esc(value)}</span>${canEdit ? `<button type="button" class="cell-edit-btn" data-action="edit-db-cell" data-table="${esc(table)}" data-record-key="${esc(row[keyField])}" data-field="${esc(field)}" aria-label="Edit ${esc(field)}">✎</button>` : ''}</div></td>`;
    }).join('')}</tr>`).join('') : `<tr><td colspan="${Math.max(1, fields.length)}" class="empty-cell">No records in this table.</td></tr>`;
  }

  async function openDatabaseCellEditor(table, recordKey, field) {
    if (IS_SHOP || databaseFieldReadOnly(table, field) || field === databaseKeyField(table)) return;
    await ensureAdminWriteReady();
    const row = await readOne(table, recordKey);
    if (!row || !Object.prototype.hasOwnProperty.call(row, field)) throw new Error('That field is no longer available. Refresh the table.');
    databaseEditState = { table, recordKey, field, original: structuredClone(row[field]) };
    byId('database-cell-table').value = table;
    byId('database-cell-key').value = recordKey;
    byId('database-cell-field').value = field;
    const original = row[field];
    const type = Array.isArray(original) ? 'array' : original === null ? 'null' : typeof original;
    byId('database-cell-type').value = type;
    byId('database-cell-title').textContent = `${table} · ${field}`;
    byId('database-cell-before').value = original === undefined ? '' : (typeof original === 'object' ? JSON.stringify(original, null, 2) : String(original));
    byId('database-cell-value').value = original === undefined ? '' : (typeof original === 'object' ? JSON.stringify(original, null, 2) : String(original));
    byId('database-cell-help').textContent = (table === 'inventory' && field === 'quantity')
      ? 'Quantity is changed through a stock adjustment movement. The adjustment is added to stock history and the audit log.'
      : 'The change is audited. Primary keys, linked invoice totals/lines, payment links and historical stock movement records are protected to keep the ledger consistent.';
    showDialog('database-cell-dialog');
  }

  function parseDatabaseCellValue(raw, type) {
    if (type === 'number') {
      if (raw.trim() === '') throw new Error('Enter a number.');
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error('Enter a valid finite number.');
      return value;
    }
    if (type === 'boolean') {
      if (!['true','false'].includes(raw.trim())) throw new Error('Boolean value must be true or false.');
      return raw.trim() === 'true';
    }
    if (type === 'object' || type === 'array' || type === 'null') {
      const value = JSON.parse(raw);
      if (type === 'array' && !Array.isArray(value)) throw new Error('This field must remain an array.');
      if (type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('This field must remain an object.');
      return value;
    }
    return raw;
  }

  async function saveDatabaseCell(event) {
    event.preventDefault();
    await ensureAdminWriteReady();
    const state = databaseEditState;
    if (!state) throw new Error('No database field is selected.');
    const { table, recordKey, field, original } = state;
    if (databaseFieldReadOnly(table, field) || field === databaseKeyField(table)) throw new Error('This field is protected to preserve linked records and transaction history.');
    let nextValue = parseDatabaseCellValue(byId('database-cell-value').value, byId('database-cell-type').value);
    if (field === 'name' && ['customers','inventory','services'].includes(table)) nextValue = titleCase(nextValue);
    if (field === 'customerName' && table === 'bills') nextValue = titleCase(nextValue);
    if (field === 'vehicleNo' && ['customers','bills'].includes(table)) nextValue = String(nextValue).toLocaleUpperCase('en-IN');
    if (table === 'bills' && field === 'discount' && (nextValue < 0 || nextValue > Number((await readOne('bills', recordKey))?.subtotal || 0))) throw new Error('Discount must be between ₹0 and the invoice subtotal.');
    if (table === 'payments' && field === 'amount' && (!(nextValue > 0) || !Number.isFinite(nextValue))) throw new Error('Payment amount must be greater than ₹0.');
    if (table === 'inventory' && field === 'quantity') {
      if (!Number.isInteger(nextValue) || nextValue < 0) throw new Error('Available quantity must be a non-negative whole number.');
      recordLocalChange();
    const tx = db.transaction(['inventory','stockMovements','auditLog'], 'readwrite');
      const store = tx.objectStore('inventory');
      const request = store.get(recordKey);
      request.onsuccess = () => {
        const row = request.result;
        if (!row || Number(row.quantity || 0) !== Number(original || 0)) { tx.abort(); return; }
        const before = Number(row.quantity || 0);
        const delta = nextValue - before;
        row.quantity = nextValue;
        row.updatedAt = new Date().toISOString();
        store.put(row);
        if (delta !== 0) tx.objectStore('stockMovements').add({ id: uuid(), inventoryId: row.id, code: row.code, itemName: row.name, delta, reason: 'Admin quantity correction', referenceId: '', date: new Date().toISOString() });
        tx.objectStore('auditLog').add({ id: uuid(), table, recordId: String(recordKey), field, before, after: nextValue, action: 'admin-correction', mode: APP_MODE, at: new Date().toISOString() });
      };
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error || new Error('Quantity correction failed.')); tx.onabort = () => reject(tx.error || new Error('Quantity correction was cancelled.')); });
    } else {
      const stores = table === 'payments' ? [table,'bills','auditLog'] : [table,'auditLog'];
      await new Promise((resolve, reject) => {
        recordLocalChange();
        const tx = db.transaction(stores, 'readwrite');
        const store = tx.objectStore(table);
        const request = store.get(recordKey);
        request.onsuccess = () => {
          const row = request.result;
          if (!row || JSON.stringify(row[field] ?? null) !== JSON.stringify(original ?? null)) { tx.abort(); return; }
          row[field] = nextValue;
          if (table === 'bills') {
            if (Number(row.discount || 0) < 0 || Number(row.discount || 0) > Number(row.subtotal || 0)) { tx.abort(); return; }
            if (['subtotal','discount'].includes(field)) row.total = money(Number(row.subtotal || 0) - Number(row.discount || 0));
            if (['subtotal','discount','total','paidTotal','due'].includes(field)) {
              if (field === 'due') row.paidTotal = money(Number(row.total || 0) - Number(row.due || 0));
              row.due = money(Number(row.total || 0) - Number(row.paidTotal || 0));
              if (row.due < 0) { tx.abort(); return; }
              row.status = row.due <= 0 ? 'paid' : Number(row.paidTotal || 0) > 0 ? 'partial' : 'due';
            }
            row.updatedAt = new Date().toISOString();
          }
          store.put(row);
          tx.objectStore('auditLog').add({ id: uuid(), table, recordId: String(recordKey), field, before: original ?? null, after: nextValue ?? null, action: 'admin-cell-edit', mode: APP_MODE, at: new Date().toISOString() });
          if (table === 'payments' && field === 'amount') {
            const bill = tx.objectStore('bills').get(row.billId);
            bill.onsuccess = () => {
              if (bill.result) {
                // Preserve the bill's existing aggregate (which may include legacy payments
                // that were not represented as separate payment rows) by applying only delta.
                const beforeBill = { paidTotal: Number(bill.result.paidTotal || 0), due: Number(bill.result.due || 0), status: bill.result.status };
                const delta = Number(nextValue) - Number(original || 0);
                const totalPaid = money(beforeBill.paidTotal + delta);
                if (totalPaid < 0 || totalPaid > Number(bill.result.total || 0)) { tx.abort(); return; }
                bill.result.paidTotal = totalPaid;
                bill.result.due = money(Number(bill.result.total || 0) - totalPaid);
                bill.result.status = bill.result.due <= 0 ? 'paid' : totalPaid > 0 ? 'partial' : 'due';
                bill.result.updatedAt = new Date().toISOString();
                tx.objectStore('bills').put(bill.result);
                tx.objectStore('auditLog').add({ id: uuid(), table: 'bills', recordId: String(bill.result.id), field: 'paidTotal/due/status', before: beforeBill, after: { paidTotal: bill.result.paidTotal, due: bill.result.due, status: bill.result.status }, action: 'payment-correction', mode: APP_MODE, at: new Date().toISOString() });
              }
            };
          }
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('Field edit failed.'));
        tx.onabort = () => reject(tx.error || new Error('Field edit was cancelled. No change was saved.'));
      });
    }
    closeAllDialogs(); databaseEditState = null;
    await refreshData();
    renderDashboard(); renderInventory(); renderServices(); renderCustomers(); renderLedger(); renderReports();
    await afterLocalChange(`Admin edited ${table}.${field}.`);
    await renderDatabaseEditor();
    toast('Field updated and audit entry recorded.', 'success');
  }

  async function exportDatabaseTable() {
    const table = byId('database-table-select').value;
    const rows = await readAll(table);
    const fields = [...new Set(rows.flatMap(row => Object.keys(row)))];
    const csv = Core.toCSV(rows, fields.map(field => ({ label: field, value: row => typeof row[field] === 'object' ? JSON.stringify(row[field]) : row[field] })));
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `WorkshopPro_${table}_${todayIST()}.csv`);
    toast(`${table} table exported.`, 'success');
  }

  // ---------- Theme ----------
  function applyTheme() {
    let theme = 'light';
    try { theme = localStorage.getItem('workshoppro-theme') || 'light'; } catch (_) {}
    document.body.classList.toggle('theme-dark', theme === 'dark');
    const button = byId('theme-toggle');
    if (button) { button.textContent = theme === 'dark' ? '☀' : '◐'; button.title = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`; }
  }

  function toggleTheme() {
    const next = document.body.classList.contains('theme-dark') ? 'light' : 'dark';
    document.body.classList.toggle('theme-dark', next === 'dark');
    try { localStorage.setItem('workshoppro-theme', next); } catch (_) {}
    applyTheme();
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
    await ensureAdminWriteReady();
    const values = {
      workshopName: titleCase(byId('setting-name').value), workshopPhone: byId('setting-phone').value.trim(),
      workshopGst: byId('setting-gst').value.trim(), workshopAddress: byId('setting-address').value.trim(),
      invoicePrefix: byId('setting-prefix').value.trim().replace(/[^a-zA-Z0-9-]/g, '').slice(0, 12) || 'INV'
    };
    for (const [key, value] of Object.entries(values)) await putSetting(key, value);
    await addAudit('settings', 'workshop-settings', '*', null, values, 'update');
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
    if (!element) {
      element = document.createElement('div');
      element.id = temporaryId;
      // html5-qrcode may need a measurable element while decoding an image.
      // Keep it off-screen rather than display:none (zero layout dimensions).
      Object.assign(element.style, {
        position: 'fixed', left: '-10000px', top: '0', width: '320px', height: '240px',
        opacity: '0', pointerEvents: 'none', overflow: 'hidden'
      });
      document.body.appendChild(element);
    }
    const imageScanner = new Html5Qrcode(temporaryId);
    try {
      const code = await imageScanner.scanFile(file, true);
      await imageScanner.clear(); element.remove();
      await handleScannedCode(code);
    } catch (error) { try { await imageScanner.clear(); } catch (_) {} element.remove(); toast('No readable barcode was found in that image.', 'error'); }
    byId('scanner-image').value = '';
  }

  // ---------- Keyboard-wedge barcode scanners (USB / Bluetooth) ----------
  // Most handheld scanners behave like a keyboard and send a rapid burst of
  // characters followed by Enter or Tab. This layer detects that burst even
  // when the scan was not intentionally focused into a particular barcode box.
  function resetBarcodeWedge() {
    if (barcodeWedge.timer) window.clearTimeout(barcodeWedge.timer);
    Object.assign(barcodeWedge, { buffer: '', lastAt: 0, startedAt: 0, times: [], origin: null, originValue: '', confirmed: false, timer: null });
  }

  function dispatchInput(element) {
    if (!element) return;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function finishHardwareScan() {
    const code = barcodeWedge.buffer.trim();
    const origin = barcodeWedge.origin;
    const originalValue = barcodeWedge.originValue;
    const confirmed = barcodeWedge.confirmed;
    resetBarcodeWedge();
    if (!confirmed || code.length < BARCODE_MIN_LENGTH) return;
    // Remove the characters already delivered by the browser before the
    // scanner burst was identified, preserving whatever was in the field.
    if (origin && origin.isConnected && 'value' in origin) {
      origin.value = originalValue;
      dispatchInput(origin);
    }
    handleHardwareBarcode(code, origin).catch(error => toast(error.message || 'Could not process scanned barcode.', 'error'));
  }

  async function handleHardwareBarcode(rawCode, origin) {
    const code = String(rawCode || '').trim();
    if (!code) return;
    signalScan();
    const stockDialogOpen = byId('stock-dialog').open;
    const scannerDialogOpen = byId('scanner-dialog').open;
    const focusedId = origin?.id || document.activeElement?.id || '';

    if (scannerDialogOpen) {
      await handleScannedCode(code);
      return;
    }
    // Preserve the user's chosen destination: a keyboard-wedge scanner is a
    // keyboard, so scanning while an ordinary editable field is focused must
    // visibly populate that exact field instead of unexpectedly opening a modal.
    const editableOrigin = origin && origin.isConnected && 'value' in origin &&
      !origin.disabled && !origin.readOnly &&
      !['BUTTON', 'SELECT'].includes(origin.tagName);
    if (editableOrigin) {
      origin.value = code;
      dispatchInput(origin);
      return;
    }
    if (stockDialogOpen || activeView === 'inventory' || ((!origin || origin === document.body) && activeView !== 'billing')) {
      const match = inventory.find(item => item.code.toLowerCase() === code.toLowerCase());
      if (!stockDialogOpen) openStockDialog(match || null, match ? '' : code);
      else if (match) openStockDialog(match);
      else {
        byId('stock-code').disabled = false;
        byId('stock-code').value = code;
        byId('stock-id').value = '';
        byId('stock-dialog-title').textContent = 'Add stock';
        byId('stock-name').focus();
      }
      if (match) toast(`Barcode matched: ${match.name}. Enter received quantity to update stock.`, 'success');
      else toast(`Barcode ${code} captured. Complete the new item details.`, 'success');
      return;
    }
    if (activeView === 'billing') {
      const match = inventory.find(item => item.code.toLowerCase() === code.toLowerCase());
      byId('bill-item-search').value = code;
      if (match) { chooseBillItem(match.id); addSelectedBillItem(); }
      else { renderBillSuggestions(); byId('bill-item-search').focus(); toast(`Barcode ${code} is not in inventory. Add the item before billing.`, 'warning'); }
      return;
    }
    toast(`Barcode captured: ${code}. Open Inventory or Billing to use it.`, 'info');
  }

  document.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    // Barcode-designated inputs are intentionally left untouched: keyboard-wedge
    // scanners type directly into them and their Enter handlers perform the lookup.
    if (document.activeElement?.id === 'stock-code' || document.activeElement?.id === 'bill-item-search') return;
    const now = performance.now();
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (barcodeWedge.confirmed) {
        event.preventDefault();
        finishHardwareScan();
      } else resetBarcodeWedge();
      return;
    }
    if (event.key.length !== 1) return;
    const gap = barcodeWedge.lastAt ? now - barcodeWedge.lastAt : 0;
    if (!barcodeWedge.lastAt || gap > BARCODE_MAX_GAP_MS) {
      resetBarcodeWedge();
      barcodeWedge.startedAt = now;
      barcodeWedge.origin = document.activeElement;
      barcodeWedge.originValue = barcodeWedge.origin && 'value' in barcodeWedge.origin ? barcodeWedge.origin.value : '';
      barcodeWedge.buffer = event.key;
    } else {
      barcodeWedge.buffer += event.key;
    }
    barcodeWedge.lastAt = now;
    barcodeWedge.times.push(now);
    if (Core.isFastBarcodeBurst(barcodeWedge.times, BARCODE_MAX_GAP_MS, BARCODE_MIN_LENGTH)) {
      barcodeWedge.confirmed = true;
      // The first few key strokes may already have reached the focused input.
      if (barcodeWedge.origin && 'value' in barcodeWedge.origin) {
        barcodeWedge.origin.value = barcodeWedge.originValue;
        dispatchInput(barcodeWedge.origin);
      }
      event.preventDefault();
      if (barcodeWedge.timer) window.clearTimeout(barcodeWedge.timer);
      barcodeWedge.timer = window.setTimeout(finishHardwareScan, 100);
    } else if (barcodeWedge.confirmed) {
      event.preventDefault();
    }
  }, true);

  if (updateChannel) {
    updateChannel.addEventListener('message', async event => {
      if (event.data?.type !== 'database-changed' || event.data.source === tabId) return;
      try {
        const billCustomer = byId('bill-customer').value;
        await refreshData();
        renderDashboard(); renderInventory(); renderServices(); renderCustomers(); renderLedger(); renderReports();
        refreshDatabaseHealth();
        populateBillCustomers();
        if (customers.some(row => row.id === billCustomer)) byId('bill-customer').value = billCustomer;
        byId('backup-status').textContent = 'Database refreshed from another open Workshop Pro tab.';
        byId('last-saved-label').textContent = 'Updated from another tab';
      } catch (error) { console.error('Cross-tab database refresh failed:', error); }
    });
  }
  window.addEventListener('storage', event => {
    if (event.key !== 'workshoppro-db-ping' || updateChannel) return;
    refreshData().then(() => { renderDashboard(); renderInventory(); renderServices(); renderCustomers(); renderLedger(); renderReports(); populateBillCustomers(); }).catch(console.error);
  });

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
    if (shopReadOnlyAction(action)) { toast('This function is restricted to the Admin app.', 'warning'); return; }
    if (action === 'open-stock') openStockDialog();
    if (action === 'open-customer') openCustomerDialog();
    if (action === 'go-billing') showView('billing');
    if (action === 'edit-stock') openStockDialog(inventory.find(row => row.id === id));
    if (action === 'archive-stock') archiveStock(id);
    if (action === 'stock-history') showStockHistory(id);
    if (action === 'customer-details') showCustomerDetails(id);
    if (action === 'edit-customer') { closeAllDialogs(); openCustomerDialog(customers.find(row => row.id === id)); }
    if (action === 'choose-bill-item') chooseBillItem(id);
    if (action === 'add-bill-item') addSelectedBillItem();
    if (action === 'open-service-line') { byId('service-form').reset(); byId('service-qty').value = '1'; byId('service-price').value = ''; byId('service-kind').value = 'service'; byId('service-save-catalog').checked = true; showDialog('service-dialog'); }
    if (action === 'open-service-catalog') openServiceCatalogDialog();
    if (action === 'edit-service-catalog') openServiceCatalogDialog(services.find(row => row.id === id));
    if (action === 'archive-service-catalog') archiveServiceCatalog(id);
    if (action === 'use-service-catalog' || action === 'choose-bill-service') { addCatalogServiceToCart(id); if (byId('bill-service-search')) byId('bill-service-search').value = ''; if (byId('bill-service-suggestions')) byId('bill-service-suggestions').style.display = 'none'; }
    if (action === 'remove-cart-item') { currentCart = currentCart.filter(row => row.id !== id); renderCart(); }
    if (action === 'cart-minus' || action === 'cart-plus') { const line = currentCart.find(row => row.id === id); if (line) { line.qty = Math.max(1, line.qty + (action === 'cart-plus' ? 1 : -1)); renderCart(); } }
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
    if (action === 'sync-safety-download') downloadLatestSyncSafetyCopy();
    if (action === 'backup-import') byId('backup-file').click();
    if (action === 'drive-connect') connectDrive();
    if (action === 'auth-offline') continueOfflineForSession();
    if (action === 'drive-upload') backupToDrive();
    if (action === 'drive-restore') restoreFromDrive();
    if (action === 'toggle-theme') toggleTheme();
    if (action === 'database-refresh' || action === 'database-audit-refresh') { renderDatabaseAudit(); renderDatabaseEditor(); }
    if (action === 'database-export') exportDatabaseTable();
    if (action === 'edit-db-cell') openDatabaseCellEditor(actionElement.dataset.table, actionElement.dataset.recordKey, actionElement.dataset.field);
  });

  document.addEventListener('input', event => {
    normalizeInputValue(event.target);
    if (event.target.matches('#inventory-search,#inventory-filter,#inventory-category-filter,#inventory-sort')) renderInventory();
    if (event.target.matches('#customer-search')) renderCustomers();
    if (event.target.matches('#bill-customer-search')) filterBillCustomers();
    if (event.target.matches('#service-search')) renderServices();
    if (event.target.matches('#bill-item-search')) { selectedBillSuggestion = null; renderBillSuggestions(); }
    if (event.target.matches('#bill-service-search')) renderSavedServiceSuggestions();
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
    if (event.target.matches('#database-search')) renderDatabaseEditor();
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
      if (customer) byId('bill-vehicle').value = String(customer.vehicleNo || '').toLocaleUpperCase('en-IN');
    }
    if (event.target.id === 'backup-file') importBackupFile(event.target.files?.[0]);
    if (event.target.id === 'service-kind-filter') renderServices();
    if (event.target.id === 'scanner-image') scanImageFile(event.target.files?.[0]);
    if (event.target.id === 'drive-auto-backup') updateAutoBackupSetting(event.target.checked);
    if (event.target.id === 'database-table-select') renderDatabaseEditor();
  });

  byId('stock-code').addEventListener('input', () => {
    if (stockBarcodeLookupTimer) window.clearTimeout(stockBarcodeLookupTimer);
    const scannedValue = byId('stock-code').value.trim();
    if (scannedValue.length < BARCODE_MIN_LENGTH || !byId('stock-dialog').open || byId('stock-code').disabled) return;
    stockBarcodeLookupTimer = window.setTimeout(() => {
      if (byId('stock-code').value.trim() === scannedValue) stockBarcodeLookup();
    }, 300);
  });
  byId('stock-code').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); if (stockBarcodeLookupTimer) window.clearTimeout(stockBarcodeLookupTimer); stockBarcodeLookup(); }
  });
  byId('stock-form').addEventListener('submit', event => saveStock(event).catch(error => toast(error.message, 'error')));
  byId('customer-form').addEventListener('submit', event => saveCustomer(event).catch(error => toast(error.message, 'error')));
  byId('payment-form').addEventListener('submit', event => savePayment(event));
  byId('service-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = titleCase(byId('service-name').value);
    const qty = Number(byId('service-qty').value);
    const unitPrice = Number(byId('service-price').value);
    if (!name || !Number.isInteger(qty) || qty < 1 || !Number.isFinite(unitPrice) || unitPrice < 0) { toast('Enter a description, valid quantity and non-negative price.', 'error'); return; }
    const saveToCatalog = !IS_SHOP && byId('service-save-catalog').checked;
    const catalogKind = byId('service-kind').value;
    const existing = services.find(row => row.name.trim().toLowerCase() === name.toLowerCase() && row.kind === catalogKind);
    currentCart.push({ id: uuid(), inventoryId: null, serviceId: existing?.id || null, createCatalogRecord: saveToCatalog && !existing, code: catalogKind === 'service' ? 'SERVICE' : 'NON-STOCK', name, qty, unitPrice: money(unitPrice), catalogKind, saveToCatalog });
    closeAllDialogs(); renderCart(); toast(saveToCatalog ? 'Service added. It will be saved for future bills when this invoice is saved.' : 'Service added to this invoice.', 'success');
  });
  byId('service-catalog-form').addEventListener('submit', event => saveServiceCatalog(event).catch(error => toast(error.message, 'error')));
  byId('settings-form').addEventListener('submit', event => saveSettings(event).catch(error => toast(error.message, 'error')));
  byId('database-cell-form').addEventListener('submit', event => saveDatabaseCell(event).catch(error => toast(error.message, 'error')));
  byId('menu-toggle').addEventListener('click', openSidebar);
  byId('sidebar-close').addEventListener('click', closeSidebar);
  byId('mobile-scrim').addEventListener('click', closeSidebar);
  function resolveBillingBarcode(allowNameSearch = false) {
    const value = byId('bill-item-search').value.trim();
    if (!value) return;
    const exact = inventory.find(item => item.code.toLowerCase() === value.toLowerCase());
    const match = exact || (allowNameSearch ? findInventory(value)[0] : null);
    if (match) { chooseBillItem(match.id); addSelectedBillItem(); }
    else if (allowNameSearch) toast(`No matching inventory item for “${value}”. Add it in Inventory first.`, 'warning');
  }
  byId('bill-item-search').addEventListener('input', () => {
    if (billBarcodeLookupTimer) window.clearTimeout(billBarcodeLookupTimer);
    const value = byId('bill-item-search').value.trim();
    if (value.length < BARCODE_MIN_LENGTH) return;
    billBarcodeLookupTimer = window.setTimeout(() => {
      if (byId('bill-item-search').value.trim() === value) resolveBillingBarcode(false);
    }, 300);
  });
  byId('bill-item-search').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (billBarcodeLookupTimer) window.clearTimeout(billBarcodeLookupTimer);
    resolveBillingBarcode(true);
  });
  byId('bill-add-qty').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addSelectedBillItem(); } });
  window.addEventListener('online', () => { updateNetworkState(); if (driveToken) automaticDriveSync('online'); else showDriveAuthPrompt('Internet is back. Sign in to resume automatic restore and backup.'); });
  window.addEventListener('offline', () => { updateNetworkState(); byId('backup-status').textContent = 'Offline: local changes are saved on this device and will sync when connection returns.'; });
  window.addEventListener('focus', () => { if (driveToken) automaticDriveSync('focus'); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && driveToken) automaticDriveSync('visible'); });
  // Chrome Android PWA pull-to-refresh is disabled by root overscroll-behavior in style.css.
  window.addEventListener('beforeunload', () => { if (scanner?.isScanning) scanner.stop().catch(() => {}); });

  // ---------- One-time migration from the original PouchDB database ----------
  async function migrateLegacyPouchDB() {
    const completed = await readOne('settings', 'legacyMigrationDone');
    if (completed?.value) return false;
    if (typeof window.PouchDB !== 'function') return false;
    let legacy;
    try {
      legacy = new window.PouchDB('workshop_db');
      const info = await legacy.info();
      if (!info.doc_count) return false;
      const [existingCustomers, existingInventory, existingBills] = await Promise.all([readAll('customers'), readAll('inventory'), readAll('bills')]);
      if (existingCustomers.length || existingInventory.length || existingBills.length) {
        console.info('Legacy database found, but the new database already contains records; automatic migration was skipped to avoid mixing data sets.');
        return false;
      }
      const result = await legacy.allDocs({ include_docs: true });
      const docs = (result.rows || []).map(row => row.doc).filter(Boolean);
      const migrated = Core.migrateLegacyPouchDocs(docs);
      const total = STORES.reduce((sum, store) => sum + (migrated[store]?.length || 0), 0);
      if (!total) return false;
      await new Promise((resolve, reject) => {
        if (!remotePullInProgress) recordLocalChange();
        const tx = db.transaction(STORES, 'readwrite');
        for (const storeName of STORES) {
          const store = tx.objectStore(storeName);
          for (const record of migrated[storeName] || []) store.put(record);
        }
        tx.objectStore('settings').put({ key: 'legacyMigrationDone', value: true });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('Legacy records could not be migrated.'));
        tx.onabort = () => reject(tx.error || new Error('Legacy database migration was cancelled.'));
      });
      toast(`Imported ${migrated.customers.length} customers, ${migrated.inventory.length} stock items and ${migrated.bills.length} old invoices.`, 'success');
      return true;
    } catch (error) {
      console.warn('Legacy PouchDB migration was not completed:', error);
      toast(`Could not import the old workshop_db automatically: ${error.message || 'unknown error'}. Your original database has not been changed.`, 'warning');
      return false;
    } finally {
      try { await legacy?.close(); } catch (_) {}
    }
  }

  // ---------- Startup ----------
  async function initialize() {
    try {
      if (!('indexedDB' in window)) throw new Error('This browser does not support local database storage. Use a current version of Chrome, Edge, Safari or Firefox.');
      db = await openDatabase();
      if (navigator.storage?.persist) { try { await navigator.storage.persist(); } catch (_) {} }
      const didMigrateLegacy = await migrateLegacyPouchDB();
      await refreshData();
      try {
        if (localStorage.getItem('workshoppro-v6-state-initialized') !== '1') {
          const hasExistingRecords = customers.length + inventory.length + services.length + bills.length + payments.length + stockMovements.length > 0;
          localStorage.setItem('workshoppro-v6-local-dirty', hasExistingRecords ? '1' : '0');
          localStorage.setItem('workshoppro-v6-state-initialized', '1');
        }
      } catch (_) {}
      if (settings.autoDriveBackup !== true) { await putSetting('autoDriveBackup', true); }
      if (didMigrateLegacy) await afterLocalChange('Original Workshop Pro records imported into the new local database.');
      applyAppMode();
      applyTheme();
      renderDashboard(); renderInventory(); renderServices(); renderCustomers(); renderLedger(); renderReports(); renderSettings(); populateBillCustomers(); clearBillDraft();
      refreshDatabaseHealth();
      updateNetworkState();
      if (IS_SHOP) { byId('page-title').textContent = 'Quick Billing'; byId('page-eyebrow').textContent = 'SALES'; await showView('billing'); }
      else byId('page-title').textContent = 'Dashboard';
      if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Offline app shell could not be installed:', error));
      }
      initGoogleDrive({ silent: true });
      if (!settings.workshopName && !IS_SHOP) byId('backup-status').textContent = 'Add your workshop details in Settings. Your records save on this device.';
      if (IS_SHOP && !driveToken) byId('backup-status').textContent = 'Shop mode · bills save locally first. Sign in to enable automatic two-way sync.';
    } catch (error) {
      console.error(error);
      toast(error.message || 'Workshop Pro could not start.', 'error');
      byId('backup-status').textContent = 'Database could not be opened.';
    }
  }

  initialize();
})();
