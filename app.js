// ==================== DATABASE INIT ====================
const db = new PouchDB('workshop_db');
let html5QrCode = null;
let currentBillItems = [];
let accessToken = localStorage.getItem('google_token');
let tokenExpiry = localStorage.getItem('token_expiry');
let torchEnabled = false;
let currentScannerType = null;
let lastBackPress = 0;

// ===== YOUR GOOGLE CLIENT ID =====
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const BACKUP_FILE_NAME = 'workshop_backup.json';

// ==================== DOUBLE TAP TO EXIT ====================
function handleBackPress() {
    const now = new Date().getTime();

    if (now - lastBackPress < 2000) {
        if (window.matchMedia('(display-mode: standalone)').matches) {
            showToast('Exiting app...', 'info');
            setTimeout(() => {
                window.close();
            }, 500);
        } else {
            showToast('Double tap again to exit', 'warning');
        }
    } else {
        lastBackPress = now;
        const indicator = document.createElement('div');
        indicator.className = 'exit-indicator';
        indicator.textContent = 'Tap again to exit';
        document.body.appendChild(indicator);
        setTimeout(() => {
            if (indicator.parentNode) {
                indicator.remove();
            }
        }, 2000);
    }
}

window.addEventListener('popstate', function (event) {
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen && activeScreen.id !== 'dashboard-screen') {
        goToDashboard();
        history.pushState(null, null, location.href);
    } else {
        handleBackPress();
    }
});

// ==================== NETWORK STATUS DETECTION ====================
function updateNetworkStatus() {
    const syncStatus = document.getElementById('sync-status');
    const syncText = document.getElementById('sync-status-text');
    const syncIcon = document.querySelector('#sync-status i');

    if (navigator.onLine) {
        syncStatus.classList.add('online');
        syncStatus.classList.remove('offline');
        if (syncIcon) syncIcon.style.color = '#10b981';
        if (syncText) syncText.textContent = accessToken ? 'Online - Ready to sync' : 'Online';

        if (accessToken && localStorage.getItem('wasOffline') === 'true') {
            autoSync();
            localStorage.removeItem('wasOffline');
        }
    } else {
        syncStatus.classList.add('offline');
        syncStatus.classList.remove('online');
        if (syncIcon) syncIcon.style.color = '#fbbf24';
        if (syncText) syncText.textContent = 'Offline Mode';
        localStorage.setItem('wasOffline', 'true');
    }
}

window.addEventListener('online', updateNetworkStatus);
window.addEventListener('offline', updateNetworkStatus);

// ==================== AUTO-SYNC ====================
async function autoSync() {
    if (navigator.onLine && accessToken) {
        console.log('Auto-syncing...');
        await uploadToDrive();
    } else {
        localStorage.setItem('pendingSync', 'true');
        showToast('Changes saved offline. Will sync when online.', 'info');
    }
}

// ==================== FAB VISIBILITY ====================
function updateFABVisibility(screenId) {
    const fabButton = document.getElementById('fab-button');
    if (!fabButton) return;

    if (screenId === 'dashboard-screen') {
        fabButton.style.display = 'flex';
    } else {
        fabButton.style.display = 'none';
    }
}

// ==================== UTILITY FUNCTIONS ====================
function changeQty(id, delta) {
    const input = document.getElementById(id);
    if (input) {
        let val = parseInt(input.value) || 1;
        val = Math.max(1, val + delta);
        input.value = val;
    }
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    let icon = 'info-circle';
    if (type === 'success') icon = 'check-circle';
    if (type === 'error') icon = 'exclamation-circle';
    if (type === 'warning') icon = 'exclamation-triangle';
    toast.innerHTML = `<i class="fas fa-${icon}"></i> ${message}`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function playBeepAndVibrate() {
    if (navigator.vibrate) navigator.vibrate(200);
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
        gainNode.gain.setValueAtTime(0.5, audioContext.currentTime);
        oscillator.start();
        oscillator.stop(audioContext.currentTime + 0.1);
        if (audioContext.state === 'suspended') audioContext.resume();
    } catch (e) { console.log('Audio feedback error'); }
}

// ==================== FLASHLIGHT ====================
async function toggleFlash(type) {
    if (!html5QrCode) return;

    torchEnabled = !torchEnabled;
    const flashIcon = document.getElementById(`flash-${type}`);

    try {
        await html5QrCode.setTorch(torchEnabled);

        if (flashIcon) {
            if (torchEnabled) {
                flashIcon.classList.add('active');
                flashIcon.innerHTML = '<i class="fas fa-bolt" style="color: black;"></i>';
            } else {
                flashIcon.classList.remove('active');
                flashIcon.innerHTML = '<i class="fas fa-bolt"></i>';
            }
        }

        showToast(torchEnabled ? 'Flashlight On' : 'Flashlight Off', 'success');
    } catch (error) {
        console.log('Flashlight error:', error);
        showToast('Flashlight not supported on this device', 'warning');
        torchEnabled = false;
        if (flashIcon) {
            flashIcon.classList.remove('active');
            flashIcon.innerHTML = '<i class="fas fa-bolt"></i>';
        }
    }
}

// ==================== NAVIGATION ====================
function goToDashboard() {
    if (html5QrCode) {
        html5QrCode.stop().catch(() => { });
        html5QrCode = null;
        document.getElementById('scanner-overlay-inventory').style.display = 'none';
        document.getElementById('scanner-overlay-bill').style.display = 'none';
        document.getElementById('flash-inventory').style.display = 'none';
        document.getElementById('flash-bill').style.display = 'none';
        torchEnabled = false;
    }
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const dashboard = document.getElementById('dashboard-screen');
    if (dashboard) dashboard.classList.add('active');

    updateFABVisibility('dashboard-screen');
    updateDashboard();
}

function showScreen(screenId) {
    if (html5QrCode) {
        html5QrCode.stop().catch(() => { });
        html5QrCode = null;
        document.getElementById('scanner-overlay-inventory').style.display = 'none';
        document.getElementById('scanner-overlay-bill').style.display = 'none';
        document.getElementById('flash-inventory').style.display = 'none';
        document.getElementById('flash-bill').style.display = 'none';
        torchEnabled = false;
    }
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(screenId);
    if (target) target.classList.add('active');

    updateFABVisibility(screenId);

    if (screenId === 'stock-list-screen') updateInventoryUI();
    if (screenId === 'ledger-screen') updateLedgerUI();
    if (screenId === 'customers-screen') updateCustomersUI();
    if (screenId === 'dashboard-screen') updateDashboard();
    if (screenId === 'quick-bill-screen') {
        document.getElementById('bill-cust-name').value = '';
        clearBill();
    }
}

function toggleQuickMenu() {
    const menu = document.getElementById('quick-actions-menu');
    if (menu) menu.classList.toggle('active');
}

function showAddCustomerModal() {
    const modal = document.getElementById('customer-modal');
    if (modal) modal.classList.add('active');
}

function closeCustomerModal() {
    const modal = document.getElementById('customer-modal');
    if (modal) modal.classList.remove('active');
}

function closeModal() {
    const billModal = document.getElementById('bill-preview-modal');
    const custModal = document.getElementById('customer-modal');
    if (billModal) billModal.classList.remove('active');
    if (custModal) custModal.classList.remove('active');
}

function printBill() { window.print(); }

// ==================== DASHBOARD ====================
async function updateDashboard() {
    try {
        console.log('Updating dashboard...');
        const allDocs = await db.allDocs({ include_docs: true });
        console.log('Total documents in DB:', allDocs.rows.length);

        let totalItems = 0, totalSales = 0, totalCustomers = 0, lowStock = 0;
        let recentTransactions = [];

        allDocs.rows.forEach(row => {
            const doc = row.doc;
            if (doc && doc.type === 'inventory') {
                totalItems++;
                const available = (doc.totalIn || 0) - (doc.totalSold || 0);
                if (available < (doc.minStock || 5)) lowStock++;
                console.log('Inventory item:', doc.name, 'available:', available);
            } else if (doc && doc.type === 'ledger') {
                totalSales += doc.total || 0;
                recentTransactions.push(doc);
                console.log('Ledger entry:', doc.customer, 'amount:', doc.total);
            } else if (doc && doc.type === 'customer') {
                totalCustomers++;
                console.log('Customer:', doc.name);
            }
        });

        console.log('Stats - Items:', totalItems, 'Sales:', totalSales, 'Customers:', totalCustomers, 'Low Stock:', lowStock);

        const dashTotalItems = document.getElementById('dash-total-items');
        const dashTotalSales = document.getElementById('dash-total-sales');
        const dashTotalCustomers = document.getElementById('dash-total-customers');
        const dashLowStock = document.getElementById('dash-low-stock');

        if (dashTotalItems) dashTotalItems.textContent = totalItems;
        if (dashTotalSales) dashTotalSales.textContent = '₹' + totalSales.toFixed(2);
        if (dashTotalCustomers) dashTotalCustomers.textContent = totalCustomers;
        if (dashLowStock) dashLowStock.textContent = lowStock;

        const recentDiv = document.getElementById('dash-recent');
        if (recentDiv) {
            recentDiv.innerHTML = '';
            if (recentTransactions.length === 0) {
                recentDiv.innerHTML = '<p style="text-align: center; opacity: 0.7;">No recent transactions</p>';
            } else {
                recentTransactions.sort((a, b) => new Date(b.date) - new Date(a.date))
                    .slice(0, 5).forEach(t => {
                        recentDiv.innerHTML += `
                            <div style="padding: 8px; border-bottom: 1px solid var(--glass-border);">
                                <div style="display: flex; justify-content: space-between;">
                                    <span>${t.customer || 'Customer'}</span>
                                    <span>₹${(t.total || 0).toFixed(2)}</span>
                                </div>
                                <div style="font-size: 12px; opacity:0.7;">${new Date(t.date).toLocaleString()}</div>
                            </div>
                        `;
                    });
            }
        }
    } catch (error) {
        console.log('Dashboard update error:', error);
    }
}

// ==================== INVENTORY ====================
async function savePart() {
    const id = document.getElementById('part-id')?.value.trim();
    const name = document.getElementById('part-name')?.value.trim();
    const price = parseFloat(document.getElementById('part-price')?.value) || 0;
    const qty = parseInt(document.getElementById('part-qty')?.value) || 1;

    if (!id || !name) {
        showToast('Please enter Barcode ID and Part Name', 'error');
        return;
    }

    try {
        let doc;
        try {
            doc = await db.get(id);
            doc.totalIn = (doc.totalIn || 0) + qty;
            doc.price = price;
        } catch (e) {
            doc = {
                _id: id,
                type: 'inventory',
                name: name,
                price: price,
                totalIn: qty,
                totalSold: 0,
                category: document.getElementById('part-category')?.value || 'general',
                location: document.getElementById('part-location')?.value || '',
                minStock: parseInt(document.getElementById('part-min-stock')?.value) || 5,
                createdAt: new Date().toISOString()
            };
        }

        doc.updatedAt = new Date().toISOString();
        await db.put(doc);
        console.log('Saved part:', doc);

        document.getElementById('part-id').value = '';
        document.getElementById('part-name').value = '';
        document.getElementById('part-price').value = '';
        document.getElementById('part-qty').value = '1';
        document.getElementById('part-category').value = 'general';
        document.getElementById('part-location').value = '';
        document.getElementById('part-min-stock').value = '5';

        showToast('Stock saved successfully!', 'success');
        await updateInventoryUI();
        await updateDashboard();

        await autoSync();

    } catch (error) {
        showToast('Error saving stock', 'error');
        console.error(error);
    }
}

async function updateInventoryUI() {
    try {
        console.log('Updating inventory UI...');
        const result = await db.allDocs({ include_docs: true });
        console.log('Total docs in inventory check:', result.rows.length);

        const items = result.rows.map(r => r.doc).filter(d => d && d.type === 'inventory');
        console.log('Inventory items found:', items.length);

        const search = document.getElementById('stock-search')?.value.toLowerCase() || '';
        const filter = document.getElementById('stock-filter')?.value || 'all';

        let filtered = items.filter(item =>
            item.name.toLowerCase().includes(search) ||
            (item._id && item._id.toLowerCase().includes(search))
        );

        if (filter === 'low') {
            filtered = filtered.filter(item =>
                (item.totalIn - item.totalSold) < (item.minStock || 5)
            );
        } else if (filter === 'out') {
            filtered = filtered.filter(item =>
                (item.totalIn - item.totalSold) <= 0
            );
        }

        let totalValue = 0;
        filtered.forEach(item => {
            const available = (item.totalIn || 0) - (item.totalSold || 0);
            totalValue += available * (item.price || 0);
        });

        const totalValueEl = document.getElementById('total-value');
        const totalItemsEl = document.getElementById('total-items-count');

        if (totalValueEl) totalValueEl.textContent = '₹' + totalValue.toFixed(2);
        if (totalItemsEl) totalItemsEl.textContent = filtered.length;

        const tbody = document.getElementById('inventory-list-table');
        if (tbody) {
            tbody.innerHTML = '';

            if (filtered.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">No items found</td></tr>';
            } else {
                filtered.sort((a, b) => a.name.localeCompare(b.name)).forEach(item => {
                    const available = (item.totalIn || 0) - (item.totalSold || 0);
                    tbody.innerHTML += `
                        <tr>
                            <td>${item.name}</td>
                            <td>${item.totalIn || 0}</td>
                            <td>${item.totalSold || 0}</td>
                            <td><strong>${available}</strong></td>
                            <td>₹${(item.price || 0).toFixed(2)}</td>
                            <td><button class="del-btn" onclick="deleteItem('${item._id}')"><i class="fas fa-trash"></i></button></td>
                        </tr>
                    `;
                });
            }
        }
    } catch (error) {
        console.log('Inventory update error:', error);
    }
}

async function deleteItem(id) {
    if (confirm('Delete this item?')) {
        try {
            const doc = await db.get(id);
            await db.remove(doc);
            await updateInventoryUI();
            await updateDashboard();
            showToast('Item deleted', 'success');
            await autoSync();
        } catch (error) {
            showToast('Error deleting item', 'error');
        }
    }
}

// ==================== BILLING ====================
async function addItemToCurrentBill() {
    const desc = document.getElementById('bill-desc')?.value.trim();
    let price = parseFloat(document.getElementById('bill-price')?.value) || 0;
    const qty = parseInt(document.getElementById('bill-qty')?.value) || 1;
    const itemId = document.getElementById('bill-item-id')?.value.trim();

    if (!desc) {
        showToast('Please enter item description', 'error');
        return;
    }

    try {
        if (itemId) {
            const doc = await db.get(itemId);
            if (doc && doc.type === 'inventory') {
                const available = (doc.totalIn || 0) - (doc.totalSold || 0);
                if (available < qty) {
                    showToast(`Only ${available} items in stock!`, 'error');
                    return;
                }
                if (price === 0) {
                    price = doc.price || 0;
                }
            }
        } else {
            const result = await db.allDocs({ include_docs: true });
            for (const row of result.rows) {
                if (row.doc && row.doc.type === 'inventory' && row.doc.name === desc) {
                    const available = (row.doc.totalIn || 0) - (row.doc.totalSold || 0);
                    if (available < qty) {
                        showToast(`Only ${available} items in stock!`, 'error');
                        return;
                    }
                    if (price === 0) {
                        price = row.doc.price || 0;
                    }
                    break;
                }
            }
        }
    } catch (e) {
        console.log('Stock check error:', e);
    }

    currentBillItems.push({
        itemId: itemId,
        desc: desc,
        price: price,
        qty: qty,
        total: price * qty
    });

    document.getElementById('bill-item-id').value = '';
    document.getElementById('bill-desc').value = '';
    document.getElementById('bill-price').value = '';
    document.getElementById('bill-qty').value = '1';

    renderBillList();
}

function renderBillList() {
    const tbody = document.getElementById('current-bill-body');
    if (!tbody) return;

    let subtotal = 0;
    tbody.innerHTML = '';

    currentBillItems.forEach((item, index) => {
        subtotal += item.total;
        tbody.innerHTML += `
            <tr>
                <td>${item.desc}</td>
                <td>${item.qty}</td>
                <td><input type="number" value="${item.price}" step="0.01" min="0" style="width:80px; padding:5px;" onchange="updateBillItemPrice(${index}, this.value)"></td>
                <td>₹${item.total.toFixed(2)}</td>
                <td><button class="del-btn" onclick="removeBillItem(${index})"><i class="fas fa-times"></i></button></td>
            </tr>
        `;
    });

    document.getElementById('bill-subtotal').textContent = subtotal.toFixed(2);
    document.getElementById('current-items-section').style.display = 'block';
    updateBillTotal();
}

function updateBillItemPrice(index, newPrice) {
    newPrice = parseFloat(newPrice) || 0;
    currentBillItems[index].price = newPrice;
    currentBillItems[index].total = newPrice * currentBillItems[index].qty;
    renderBillList();
}

function removeBillItem(index) {
    currentBillItems.splice(index, 1);
    renderBillList();
}

function updateBillTotal() {
    const subtotal = parseFloat(document.getElementById('bill-subtotal')?.textContent) || 0;
    const discount = parseFloat(document.getElementById('bill-discount')?.value) || 0;
    const total = Math.max(0, subtotal - discount);

    const billTotal = document.getElementById('bill-total');
    if (billTotal) billTotal.textContent = total.toFixed(2);

    calculateBalance();
}

function calculateBalance() {
    const total = parseFloat(document.getElementById('bill-total')?.textContent) || 0;
    const paid = parseFloat(document.getElementById('amount-paid')?.value) || 0;
    const balance = total - paid;
    const el = document.getElementById('balance-due');

    if (el) {
        if (balance > 0) {
            el.textContent = `Balance Due: ₹${balance.toFixed(2)}`;
            el.style.color = '#ef4444';
        } else if (balance < 0) {
            el.textContent = `Change: ₹${Math.abs(balance).toFixed(2)}`;
            el.style.color = '#10b981';
        } else {
            el.textContent = 'Balance: ₹0.00';
            el.style.color = 'white';
        }
    }
}

function clearBill() {
    currentBillItems = [];
    document.getElementById('current-items-section').style.display = 'none';
    document.getElementById('bill-cust-name').value = '';
    document.getElementById('bill-discount').value = '0';
    document.getElementById('amount-paid').value = '';
    document.getElementById('balance-due').textContent = '';
}

async function finalizeBill() {
    const customer = document.getElementById('bill-cust-name')?.value.trim();
    if (!customer || currentBillItems.length === 0) {
        showToast('Enter customer name and add items', 'error');
        return;
    }

    const total = parseFloat(document.getElementById('bill-total')?.textContent) || 0;
    const paid = parseFloat(document.getElementById('amount-paid')?.value) || 0;
    const balance = total - paid;

    try {
        await db.put({
            _id: 'ledger_' + Date.now(),
            type: 'ledger',
            customer: customer,
            items: currentBillItems,
            total: total,
            paid: paid,
            balance: balance,
            paymentMethod: document.getElementById('payment-method')?.value || 'cash',
            date: new Date().toISOString()
        });

        for (const item of currentBillItems) {
            if (item.itemId) {
                try {
                    const doc = await db.get(item.itemId);
                    if (doc && doc.type === 'inventory') {
                        doc.totalSold = (doc.totalSold || 0) + item.qty;
                        await db.put(doc);
                        continue;
                    }
                } catch (e) { }
            }

            const result = await db.allDocs({ include_docs: true });
            for (const row of result.rows) {
                if (row.doc && row.doc.type === 'inventory' && row.doc.name === item.desc) {
                    row.doc.totalSold = (row.doc.totalSold || 0) + item.qty;
                    await db.put(row.doc);
                    break;
                }
            }
        }

        showBillPreview(customer, total, paid, balance);
        clearBill();
        showToast('Bill saved successfully!', 'success');
        await updateDashboard();
        await updateInventoryUI();

        await autoSync();

    } catch (error) {
        showToast('Error saving bill', 'error');
        console.error(error);
    }
}

function showBillPreview(customer, total, paid, balance) {
    let itemsHtml = '';
    currentBillItems.forEach(item => {
        itemsHtml += `<tr><td>${item.desc}</td><td>${item.qty}</td><td>₹${item.price.toFixed(2)}</td><td>₹${item.total.toFixed(2)}</td></tr>`;
    });

    const content = `
        <h3>Bill Summary</h3>
        <p><strong>Customer:</strong> ${customer}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
        <table style="width:100%; margin:10px 0; border-collapse: collapse;">
            <tr style="background: #6366f1; color: white;">
                <th style="padding: 8px;">Item</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Total</th>
            </tr>
            ${itemsHtml}
        </table>
        <p><strong>Total:</strong> ₹${total.toFixed(2)}</p>
        <p><strong>Paid:</strong> ₹${paid.toFixed(2)}</p>
        <p><strong>Balance:</strong> ₹${balance.toFixed(2)}</p>
    `;

    const previewContent = document.getElementById('bill-preview-content');
    const previewModal = document.getElementById('bill-preview-modal');

    if (previewContent) previewContent.innerHTML = content;
    if (previewModal) previewModal.classList.add('active');
}

// ==================== CUSTOMER FUNCTIONS ====================
async function loadCustomers() {
    try {
        const result = await db.allDocs({ include_docs: true });
        return result.rows.map(r => r.doc).filter(d => d && d.type === 'customer');
    } catch (error) {
        return [];
    }
}

async function saveCustomer() {
    const name = document.getElementById('cust-name')?.value.trim();
    if (!name) {
        showToast('Name is required', 'error');
        return;
    }

    try {
        await db.put({
            _id: 'cust_' + Date.now(),
            type: 'customer',
            name: name,
            phone: document.getElementById('cust-phone')?.value || '',
            email: document.getElementById('cust-email')?.value || '',
            address: document.getElementById('cust-address')?.value || '',
            gst: document.getElementById('cust-gst')?.value || '',
            balance: 0,
            createdAt: new Date().toISOString()
        });

        closeCustomerModal();

        document.getElementById('cust-name').value = '';
        document.getElementById('cust-phone').value = '';
        document.getElementById('cust-email').value = '';
        document.getElementById('cust-address').value = '';
        document.getElementById('cust-gst').value = '';

        await updateCustomersUI();
        await updateDashboard();
        showToast('Customer saved', 'success');
        await autoSync();
    } catch (error) {
        showToast('Error saving customer', 'error');
    }
}

async function updateCustomersUI() {
    console.log('Updating customers UI...');
    const customers = await loadCustomers();
    console.log('Customers found:', customers.length);

    const search = document.getElementById('customer-search')?.value.toLowerCase() || '';
    const filtered = customers.filter(c => c.name.toLowerCase().includes(search));

    const container = document.getElementById('customers-list');
    if (container) {
        container.innerHTML = '';

        if (filtered.length === 0) {
            container.innerHTML = '<p style="text-align: center; opacity: 0.7;">No customers found</p>';
        } else {
            filtered.forEach(c => {
                container.innerHTML += `
                    <div class="customer-card">
                        <strong>${c.name}</strong>
                        <div style="font-size:12px;">${c.phone || 'No phone'}</div>
                        <div style="color:${c.balance > 0 ? '#ef4444' : '#10b981'};">
                            Balance: ₹${(c.balance || 0).toFixed(2)}
                        </div>
                    </div>
                `;
            });
        }
    }
}

// ==================== ADVANCED LEDGER ====================
function resetLedgerFilters() {
    document.getElementById('ledger-customer-search').value = '';
    document.getElementById('ledger-date-from').value = '';
    document.getElementById('ledger-date-to').value = '';
    document.getElementById('ledger-filter-type').value = 'all';
    document.getElementById('ledger-sort').value = 'newest';
    updateLedgerUI();
}

function filterTransactionsByDate(transactions, filterType, fromDate, toDate) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const monthAgo = new Date(today);
    monthAgo.setMonth(monthAgo.getMonth() - 1);

    return transactions.filter(t => {
        const tDate = new Date(t.date);

        switch (filterType) {
            case 'today':
                return tDate >= today;
            case 'week':
                return tDate >= weekAgo;
            case 'month':
                return tDate >= monthAgo;
            case 'custom':
                if (fromDate && toDate) {
                    const from = new Date(fromDate);
                    const to = new Date(toDate);
                    to.setHours(23, 59, 59, 999);
                    return tDate >= from && tDate <= to;
                }
                return true;
            default:
                return true;
        }
    });
}

async function updateLedgerUI() {
    try {
        console.log('Updating ledger UI...');
        const result = await db.allDocs({ include_docs: true });
        console.log('Total docs in ledger check:', result.rows.length);

        let transactions = result.rows
            .map(r => r.doc)
            .filter(d => d && d.type === 'ledger');

        console.log('Ledger transactions found:', transactions.length);

        const customerSearch = document.getElementById('ledger-customer-search')?.value.toLowerCase() || '';
        if (customerSearch) {
            transactions = transactions.filter(t =>
                t.customer.toLowerCase().includes(customerSearch)
            );
        }

        const filterType = document.getElementById('ledger-filter-type')?.value || 'all';
        const fromDate = document.getElementById('ledger-date-from')?.value;
        const toDate = document.getElementById('ledger-date-to')?.value;

        transactions = filterTransactionsByDate(transactions, filterType, fromDate, toDate);

        let totalSales = 0;
        let creditDue = 0;
        const balances = {};

        transactions.forEach(t => {
            totalSales += t.total || 0;
            if (t.balance > 0) {
                creditDue += t.balance;
                balances[t.customer] = (balances[t.customer] || 0) + t.balance;
            }
        });

        const sortType = document.getElementById('ledger-sort')?.value || 'newest';
        switch (sortType) {
            case 'newest':
                transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
                break;
            case 'oldest':
                transactions.sort((a, b) => new Date(a.date) - new Date(b.date));
                break;
            case 'highest':
                transactions.sort((a, b) => (b.total || 0) - (a.total || 0));
                break;
            case 'lowest':
                transactions.sort((a, b) => (a.total || 0) - (b.total || 0));
                break;
        }

        const ledgerFilteredTotal = document.getElementById('ledger-filtered-total');
        const ledgerFilteredCount = document.getElementById('ledger-filtered-count');

        if (ledgerFilteredTotal) ledgerFilteredTotal.textContent = '₹' + totalSales.toFixed(2);
        if (ledgerFilteredCount) ledgerFilteredCount.textContent = transactions.length;

        const balancesDiv = document.getElementById('customer-balances-list');
        if (balancesDiv) {
            balancesDiv.innerHTML = '';

            if (Object.keys(balances).length === 0) {
                balancesDiv.innerHTML = '<p style="text-align: center; opacity: 0.7;">No pending balances</p>';
            } else {
                Object.entries(balances).forEach(([cust, amt]) => {
                    balancesDiv.innerHTML += `
                        <div style="padding:8px; background:rgba(0,0,0,0.2); border-radius:8px; margin-bottom:5px;">
                            <strong>${cust}</strong>: ₹${amt.toFixed(2)}
                        </div>
                    `;
                });
            }
        }

        const historyDiv = document.getElementById('bill-history-list');
        if (historyDiv) {
            historyDiv.innerHTML = '';

            if (transactions.length === 0) {
                historyDiv.innerHTML = '<p style="text-align: center; opacity: 0.7;">No transactions found</p>';
            } else {
                transactions.slice(0, 50).forEach(t => {
                    historyDiv.innerHTML += `
                        <div class="ledger-card">
                            <div style="display:flex; justify-content:space-between;">
                                <strong>${t.customer}</strong>
                                <span>₹${(t.total || 0).toFixed(2)}</span>
                            </div>
                            <div style="display:flex; justify-content:space-between; font-size:12px;">
                                <span>${new Date(t.date).toLocaleString()}</span>
                                <span>${t.paymentMethod || 'Cash'}</span>
                            </div>
                            ${t.balance > 0 ? `<div style="color:#ef4444; font-size:12px;">Due: ₹${t.balance.toFixed(2)}</div>` : ''}
                        </div>
                    `;
                });
            }
        }
    } catch (error) {
        console.log('Ledger update error:', error);
    }
}

// ==================== SCANNER ====================
async function toggleScanner(type) {
    const readerId = type === 'inventory' ? 'reader' : 'bill-reader';
    const element = document.getElementById(readerId);
    if (!element) return;

    if (html5QrCode) {
        await html5QrCode.stop();
        html5QrCode = null;
    }

    document.getElementById(`scanner-overlay-${type}`).style.display = 'block';
    document.getElementById(`flash-${type}`).style.display = 'flex';
    torchEnabled = false;
    currentScannerType = type;

    html5QrCode = new Html5Qrcode(readerId);

    try {
        await html5QrCode.start(
            { facingMode: "environment" },
            {
                fps: 10,
                qrbox: { width: 250, height: 250 },
                aspectRatio: 1.0
            },
            (text) => {
                playBeepAndVibrate();
                handleScanResult(text, type);
            },
            (error) => console.log(error)
        );
        showToast('Scanner started', 'success');
    } catch (error) {
        console.error('Camera error:', error);
        showToast('Camera access denied. Please allow camera permission.', 'error');
        document.getElementById(`scanner-overlay-${type}`).style.display = 'none';
        document.getElementById(`flash-${type}`).style.display = 'none';
    }
}

async function scanFile(input, type) {
    if (!input || !input.files || !input.files.length) return;

    const scanner = new Html5Qrcode('reader');
    try {
        showToast('Processing image...', 'info');
        const result = await scanner.scanFile(input.files[0], true);
        playBeepAndVibrate();
        handleScanResult(result, type);
    } catch (error) {
        showToast('Could not read barcode', 'error');
    }
}

async function handleScanResult(text, type) {
    const prefix = type === 'inventory' ? 'part-' : 'bill-';
    const idField = type === 'inventory' ? 'part-id' : 'bill-item-id';

    const idInput = document.getElementById(idField);
    if (idInput) idInput.value = text;

    try {
        const doc = await db.get(text);
        if (doc && doc.type === 'inventory') {
            const nameField = type === 'inventory' ? 'part-name' : 'bill-desc';
            const priceField = prefix + 'price';

            const nameInput = document.getElementById(nameField);
            const priceInput = document.getElementById(priceField);

            if (nameInput) nameInput.value = doc.name || '';
            if (priceInput) priceInput.value = doc.price || '';

            if (type === 'inventory') {
                const categoryField = document.getElementById('part-category');
                const locationField = document.getElementById('part-location');
                const minStockField = document.getElementById('part-min-stock');

                if (categoryField) categoryField.value = doc.category || 'general';
                if (locationField) locationField.value = doc.location || '';
                if (minStockField) minStockField.value = doc.minStock || 5;
            }

            showToast('Item Found!', 'success');
        } else {
            showToast('Item not in inventory', 'warning');
        }
    } catch (e) {
        showToast('New Item - Fill Details', 'info');
    }

    if (html5QrCode) {
        await html5QrCode.stop();
        html5QrCode = null;
        document.getElementById(`scanner-overlay-${type}`).style.display = 'none';
        document.getElementById(`flash-${type}`).style.display = 'none';
        torchEnabled = false;
    }
}

// ==================== GOOGLE DRIVE SYNC - FIXED TO SHOW DATA ====================
function handleSync() {
    if (!navigator.onLine) {
        showToast('No internet', 'error');
        return;
    }

    const now = new Date().getTime();
    if (!accessToken || (tokenExpiry && now > parseInt(tokenExpiry))) {
        const redirectUri = window.location.origin + window.location.pathname;
        const cleanUri = redirectUri.split('#')[0].split('?')[0];

        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(cleanUri)}&response_type=token&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.file')}&prompt=consent`;
        window.location.href = authUrl;
    } else {
        uploadToDrive();
    }
}

async function uploadToDrive() {
    if (!accessToken) return;

    const syncText = document.getElementById('sync-status-text');
    const syncIcon = document.querySelector('#sync-status i');

    if (syncIcon) {
        syncIcon.className = 'fas fa-sync fa-spin';
        syncIcon.style.color = '#fbbf24';
    }
    if (syncText) syncText.textContent = 'Syncing...';

    try {
        showToast('Syncing to Cloud...', 'info');

        // Get all local data
        const allDocs = await db.allDocs({ include_docs: true });
        const localData = allDocs.rows.map(r => r.doc);
        console.log('Local data count:', localData.length);

        // Try to download existing data from Drive
        let cloudData = [];
        let fileId = null;

        try {
            const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='${BACKUP_FILE_NAME}' and trashed=false`, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });

            if (searchRes.status === 401) {
                localStorage.removeItem('google_token');
                localStorage.removeItem('token_expiry');
                accessToken = null;
                showToast('Session expired. Please login again.', 'warning');
                handleSync();
                return;
            }

            const searchData = await searchRes.json();
            fileId = searchData.files?.[0]?.id;

            if (fileId) {
                const downloadRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });

                if (downloadRes.ok) {
                    const cloudBackup = await downloadRes.json();
                    cloudData = cloudBackup.data || [];
                    console.log(`Found ${cloudData.length} records in cloud`);
                }
            }
        } catch (e) {
            console.log('No existing backup found or error downloading');
        }

        // MERGE DATA - Keep newest versions
        const mergedMap = new Map();

        // Add cloud data first
        cloudData.forEach(doc => {
            mergedMap.set(doc._id, doc);
        });

        // Add/overwrite with local data if newer
        localData.forEach(localDoc => {
            const cloudDoc = mergedMap.get(localDoc._id);
            if (!cloudDoc) {
                mergedMap.set(localDoc._id, localDoc);
            } else {
                const localTime = new Date(localDoc.updatedAt || 0).getTime();
                const cloudTime = new Date(cloudDoc.updatedAt || 0).getTime();
                if (localTime >= cloudTime) {
                    mergedMap.set(localDoc._id, localDoc);
                }
            }
        });

        const mergedData = Array.from(mergedMap.values());
        console.log('Merged data count:', mergedData.length);

        // Save merged data to local database FIRST
        let imported = 0;
        let updated = 0;

        for (const doc of mergedData) {
            try {
                const existing = await db.get(doc._id).catch(() => null);
                if (existing) {
                    // Update existing document
                    doc._rev = existing._rev;
                    await db.put(doc);
                    updated++;
                } else {
                    // Insert new document
                    await db.put(doc);
                    imported++;
                }
            } catch (e) {
                console.log('Error saving doc to local DB:', e);
            }
        }

        console.log(`Local DB updated: ${imported} new, ${updated} updated`);

        // Prepare backup data for Drive
        const backupData = {
            timestamp: new Date().toISOString(),
            version: '1.0',
            data: mergedData
        };

        // Upload merged data to Drive
        const metadata = { name: BACKUP_FILE_NAME, mimeType: 'application/json' };
        const boundary = 'foo_bar_baz';
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(backupData)}\r\n--${boundary}--`;

        const url = fileId ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart` : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
        const method = fileId ? 'PATCH' : 'POST';

        const res = await fetch(url, {
            method,
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': `multipart/related; boundary=${boundary}`
            },
            body
        });

        if (res.ok) {
            const time = new Date().toLocaleTimeString();
            if (syncIcon) {
                syncIcon.className = 'fas fa-check-circle';
                syncIcon.style.color = '#10b981';
            }
            if (syncText) syncText.textContent = `Synced at ${time}`;
            showToast(`Sync Successful! ${imported} new, ${updated} updated`, 'success');

            localStorage.removeItem('pendingSync');

            // FORCE REFRESH ALL UI COMPONENTS
            console.log('Refreshing all UI components...');
            await updateDashboard();
            await updateInventoryUI();
            await updateLedgerUI();
            await updateCustomersUI();

            // Double-check by logging current DB state
            const checkDocs = await db.allDocs({ include_docs: true });
            console.log('Final DB state - total docs:', checkDocs.rows.length);

        } else {
            throw new Error('Upload failed');
        }
    } catch (e) {
        console.error('Sync error:', e);
        const syncIcon = document.querySelector('#sync-status i');
        const syncText = document.getElementById('sync-status-text');
        if (syncIcon) {
            syncIcon.className = 'fas fa-exclamation-circle';
            syncIcon.style.color = '#ef4444';
        }
        if (syncText) syncText.textContent = 'Sync failed';
        showToast('Sync Failed: ' + e.message, 'error');
    }
}

async function downloadFromDrive() {
    if (!accessToken || !navigator.onLine) return;

    try {
        console.log('Downloading from Drive...');
        const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='${BACKUP_FILE_NAME}' and trashed=false`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        const searchData = await searchRes.json();
        const fileId = searchData.files?.[0]?.id;

        if (fileId) {
            const downloadRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });

            if (downloadRes.ok) {
                const cloudData = await downloadRes.json();
                const cloudDocs = cloudData.data || [];
                console.log('Cloud docs count:', cloudDocs.length);

                let imported = 0;
                let updated = 0;

                for (const cloudDoc of cloudDocs) {
                    try {
                        const existing = await db.get(cloudDoc._id).catch(() => null);

                        if (existing) {
                            const cloudTime = new Date(cloudDoc.updatedAt || 0).getTime();
                            const localTime = new Date(existing.updatedAt || 0).getTime();

                            if (cloudTime > localTime) {
                                cloudDoc._rev = existing._rev;
                                await db.put(cloudDoc);
                                updated++;
                            }
                        } else {
                            await db.put(cloudDoc);
                            imported++;
                        }
                    } catch (e) {
                        console.log('Error merging doc:', e);
                    }
                }

                if (imported > 0 || updated > 0) {
                    showToast(`Downloaded: ${imported} new, ${updated} updated from cloud`, 'success');
                    // Force refresh all UIs
                    await updateDashboard();
                    await updateInventoryUI();
                    await updateLedgerUI();
                    await updateCustomersUI();
                }
            }
        }
    } catch (error) {
        console.log('Download from Drive error:', error);
    }
}

// ==================== EXPORT ====================
function downloadFile(content, fileName, contentType) {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
}

async function exportInventory() {
    try {
        showToast('Exporting inventory...', 'info');
        const result = await db.allDocs({ include_docs: true });
        const items = result.rows.map(r => r.doc).filter(d => d && d.type === 'inventory');
        let csv = 'Item Name,Price,Total In,Total Sold,Available,Category,Location\n';
        items.forEach(item => {
            const available = (item.totalIn || 0) - (item.totalSold || 0);
            csv += `"${item.name}",${item.price || 0},${item.totalIn || 0},${item.totalSold || 0},${available},"${item.category || ''}","${item.location || ''}"\n`;
        });
        downloadFile(csv, 'inventory_export.csv', 'text/csv');
        showToast('Inventory exported', 'success');
    } catch (error) { showToast('Export failed', 'error'); }
}

async function exportLedger() {
    try {
        showToast('Exporting ledger...', 'info');

        const result = await db.allDocs({ include_docs: true });
        let transactions = result.rows.map(r => r.doc).filter(d => d && d.type === 'ledger');

        const customerSearch = document.getElementById('ledger-customer-search')?.value.toLowerCase() || '';
        if (customerSearch) {
            transactions = transactions.filter(t => t.customer.toLowerCase().includes(customerSearch));
        }

        const filterType = document.getElementById('ledger-filter-type')?.value || 'all';
        const fromDate = document.getElementById('ledger-date-from')?.value;
        const toDate = document.getElementById('ledger-date-to')?.value;

        transactions = filterTransactionsByDate(transactions, filterType, fromDate, toDate);

        let csv = 'Date,Customer,Total,Paid,Balance,Payment Method\n';
        transactions.forEach(t => {
            csv += `"${new Date(t.date).toLocaleString()}","${t.customer}",${t.total || 0},${t.paid || 0},${t.balance || 0},"${t.paymentMethod || 'Cash'}"\n`;
        });

        downloadFile(csv, 'ledger_export.csv', 'text/csv');
        showToast('Ledger exported', 'success');
    } catch (error) { showToast('Export failed', 'error'); }
}

// ==================== PWA INSTALL PROMPT ====================
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;

    setTimeout(() => {
        if (deferredPrompt) {
            showInstallPrompt();
        }
    }, 30000);
});

function showInstallPrompt() {
    if (!deferredPrompt) return;

    const installToast = document.createElement('div');
    installToast.className = 'toast info';
    installToast.innerHTML = `
        <i class="fas fa-download"></i>
        <span>Install app on home screen?</span>
        <button onclick="installPWA()" style="background: var(--primary); color: white; border: none; padding: 5px 10px; border-radius: 5px; margin-left: 10px;">Install</button>
        <button onclick="this.parentElement.remove()" style="background: none; border: none; color: white; margin-left: 5px;">✕</button>
    `;
    document.getElementById('toast-container').appendChild(installToast);
}

function installPWA() {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();
    deferredPrompt.userChoice.then((choiceResult) => {
        if (choiceResult.outcome === 'accepted') {
            showToast('App installed!', 'success');
        }
        deferredPrompt = null;
    });
}

// ==================== INITIALIZATION ====================
window.onload = async () => {
    console.log('App initializing...');

    // Handle OAuth redirect
    if (window.location.hash) {
        const params = new URLSearchParams(window.location.hash.substring(1));
        const token = params.get('access_token');
        if (token) {
            accessToken = token;
            localStorage.setItem('google_token', token);
            const expiryTime = new Date().getTime() + 3600000;
            localStorage.setItem('token_expiry', expiryTime.toString());
            window.history.replaceState(null, null, window.location.pathname);
            showToast('Google Drive connected!', 'success');

            // Download from Drive first
            setTimeout(async () => {
                await downloadFromDrive();
                // Then upload merged data
                setTimeout(() => uploadToDrive(), 1000);
            }, 1000);
        }
    }

    // Load all data initially
    console.log('Loading initial data...');
    await updateDashboard();
    await updateInventoryUI();
    await updateLedgerUI();
    await updateCustomersUI();

    updateNetworkStatus();

    if (accessToken && accessToken !== 'null') {
        const syncIcon = document.querySelector('#sync-status i');
        const syncText = document.getElementById('sync-status-text');
        if (syncIcon) {
            syncIcon.className = 'fas fa-check-circle';
            syncIcon.style.color = '#10b981';
        }
        if (syncText) syncText.textContent = 'Ready to sync';

        if (localStorage.getItem('pendingSync') === 'true' && navigator.onLine) {
            autoSync();
        }

        // Download latest data from drive
        setTimeout(() => downloadFromDrive(), 2000);
    }

    const fabButton = document.getElementById('fab-button');
    if (fabButton) {
        fabButton.style.display = 'none';
    }

    updateFABVisibility('dashboard-screen');

    // Register service worker
    if ('serviceWorker' in navigator) {
        try {
            const registration = await navigator.serviceWorker.register('sw.js');
            console.log('Service Worker registered');
        } catch (error) {
            console.log('Service Worker registration failed');
        }
    }

    history.pushState(null, null, location.href);
};