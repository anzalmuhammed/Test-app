// ==================== DATABASE INIT ====================
const db = new PouchDB('workshop_db');
let html5QrCode = null;
let currentBillItems = [];
let accessToken = localStorage.getItem('google_token');
let tokenExpiry = localStorage.getItem('token_expiry');

// ===== YOUR GOOGLE CLIENT ID =====
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const BACKUP_FILE_NAME = 'workshop_backup.json';

// ==================== AUTO-SYNC FUNCTION ====================
async function autoSync() {
    // Auto sync after any data change
    if (navigator.onLine && accessToken) {
        console.log('Auto-syncing...');
        await uploadToDrive();
    }
}

// ==================== FAB VISIBILITY CONTROL ====================
function updateFABVisibility(screenId) {
    const fabButton = document.getElementById('fab-button');
    if (!fabButton) return;

    // Show FAB only on dashboard screen or main menu, hide on all others
    if (screenId === 'dashboard-screen' || screenId === 'main-menu') {
        fabButton.style.display = 'flex';
        console.log('FAB shown on:', screenId); // For debugging
    } else {
        fabButton.style.display = 'none';
        console.log('FAB hidden on:', screenId); // For debugging
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

// ==================== NAVIGATION & MODALS ====================
function goToDashboard() {
    if (html5QrCode) { html5QrCode.stop().catch(() => { }); html5QrCode = null; }
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const mainMenu = document.getElementById('main-menu');
    if (mainMenu) mainMenu.classList.add('active');

    // Show FAB on main menu
    updateFABVisibility('main-menu');
}

function showScreen(screenId) {
    if (html5QrCode) { html5QrCode.stop().catch(() => { }); html5QrCode = null; }
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(screenId);
    if (target) target.classList.add('active');

    // Update FAB visibility based on screen
    updateFABVisibility(screenId);

    // Refresh data based on screen
    if (screenId === 'stock-list-screen') updateInventoryUI();
    if (screenId === 'ledger-screen') updateLedgerUI();
    if (screenId === 'customers-screen') updateCustomersUI();
    if (screenId === 'dashboard-screen') updateDashboard();
    if (screenId === 'quick-bill-screen') {
        document.getElementById('bill-cust-name').value = '';
        clearBill();
    }
}

// Prevent browser back button from leaving app
window.addEventListener('popstate', function (event) {
    goToDashboard();
    history.pushState(null, null, location.href);
});
history.pushState(null, null, location.href);

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

// ==================== DASHBOARD FUNCTIONS ====================
async function updateDashboard() {
    try {
        const allDocs = await db.allDocs({ include_docs: true });
        let totalItems = 0, totalSales = 0, totalCustomers = 0, lowStock = 0;
        let recentTransactions = [];

        allDocs.rows.forEach(row => {
            const doc = row.doc;
            if (doc && doc.type === 'inventory') {
                totalItems++;
                const available = (doc.totalIn || 0) - (doc.totalSold || 0);
                if (available < (doc.minStock || 5)) lowStock++;
            } else if (doc && doc.type === 'ledger') {
                totalSales += doc.total || 0;
                recentTransactions.push(doc);
            } else if (doc && doc.type === 'customer') {
                totalCustomers++;
            }
        });

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
    } catch (error) {
        console.log('Dashboard update error:', error);
    }
}

// ==================== INVENTORY FUNCTIONS ====================
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

        // Clear all input fields
        document.getElementById('part-id').value = '';
        document.getElementById('part-name').value = '';
        document.getElementById('part-price').value = '';
        document.getElementById('part-qty').value = '1';
        document.getElementById('part-category').value = 'general';
        document.getElementById('part-location').value = '';
        document.getElementById('part-min-stock').value = '5';

        showToast('Stock saved successfully!', 'success');
        updateInventoryUI();

        // Auto sync after save
        await autoSync();

    } catch (error) {
        showToast('Error saving stock', 'error');
        console.error(error);
    }
}

async function updateInventoryUI() {
    try {
        const result = await db.allDocs({ include_docs: true });
        const items = result.rows.map(r => r.doc).filter(d => d && d.type === 'inventory');
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
            totalValue += ((item.totalIn || 0) - (item.totalSold || 0)) * (item.price || 0);
        });

        const totalValueEl = document.getElementById('total-value');
        const totalItemsEl = document.getElementById('total-items-count');

        if (totalValueEl) totalValueEl.textContent = '₹' + totalValue.toFixed(2);
        if (totalItemsEl) totalItemsEl.textContent = filtered.length;

        const tbody = document.getElementById('inventory-list-table');
        if (tbody) {
            tbody.innerHTML = '';

            filtered.sort((a, b) => a.name.localeCompare(b.name)).forEach(item => {
                const available = (item.totalIn || 0) - (item.totalSold || 0);
                tbody.innerHTML += `
                    <tr>
                        <td>${item.name}</td>
                        <td>${item.totalIn || 0}</td>
                        <td><strong>${available}</strong></td>
                        <td>₹${(item.price || 0).toFixed(2)}</td>
                        <td><button class="del-btn" onclick="deleteItem('${item._id}')"><i class="fas fa-trash"></i></button></td>
                    </tr>
                `;
            });
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
            updateInventoryUI();
            showToast('Item deleted', 'success');
            await autoSync();
        } catch (error) {
            showToast('Error deleting item', 'error');
        }
    }
}

// ==================== BILLING FUNCTIONS ====================
function addItemToCurrentBill() {
    const desc = document.getElementById('bill-desc')?.value.trim();
    const price = parseFloat(document.getElementById('bill-price')?.value) || 0;
    const qty = parseInt(document.getElementById('bill-qty')?.value) || 1;

    if (!desc) {
        showToast('Please enter item description', 'error');
        return;
    }

    currentBillItems.push({
        desc: desc,
        price: price,
        qty: qty,
        total: price * qty
    });

    // Clear only the item input fields, keep customer name
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
                <td>₹${item.price.toFixed(2)}</td>
                <td>₹${item.total.toFixed(2)}</td>
                <td><button class="del-btn" onclick="removeBillItem(${index})"><i class="fas fa-times"></i></button></td>
            </tr>
        `;
    });

    document.getElementById('bill-subtotal').textContent = subtotal.toFixed(2);
    document.getElementById('current-items-section').style.display = 'block';
    updateBillTotal();
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

        // Auto sync after bill
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

        // Clear all customer form fields
        document.getElementById('cust-name').value = '';
        document.getElementById('cust-phone').value = '';
        document.getElementById('cust-email').value = '';
        document.getElementById('cust-address').value = '';
        document.getElementById('cust-gst').value = '';

        await updateCustomersUI();
        showToast('Customer saved', 'success');
        await autoSync();
    } catch (error) {
        showToast('Error saving customer', 'error');
    }
}

async function updateCustomersUI() {
    const customers = await loadCustomers();
    const search = document.getElementById('customer-search')?.value.toLowerCase() || '';
    const filtered = customers.filter(c => c.name.toLowerCase().includes(search));

    const container = document.getElementById('customers-list');
    if (container) {
        container.innerHTML = '';

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

// ==================== LEDGER FUNCTIONS ====================
async function updateLedgerUI() {
    try {
        const result = await db.allDocs({ include_docs: true });
        const transactions = result.rows
            .map(r => r.doc)
            .filter(d => d && d.type === 'ledger')
            .sort((a, b) => new Date(b.date) - new Date(a.date));

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

        const ledgerTotal = document.getElementById('ledger-total');
        const creditDueEl = document.getElementById('credit-due');

        if (ledgerTotal) ledgerTotal.textContent = '₹' + totalSales.toFixed(2);
        if (creditDueEl) creditDueEl.textContent = '₹' + creditDue.toFixed(2);

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
                historyDiv.innerHTML = '<p style="text-align: center; opacity: 0.7;">No transactions yet</p>';
            } else {
                transactions.slice(0, 20).forEach(t => {
                    historyDiv.innerHTML += `
                        <div class="ledger-card">
                            <div style="display:flex; justify-content:space-between;">
                                <strong>${t.customer}</strong>
                                <span>₹${(t.total || 0).toFixed(2)}</span>
                            </div>
                            <div style="font-size:12px;">${new Date(t.date).toLocaleString()}</div>
                            ${t.balance > 0 ? `<div style="color:#ef4444;">Due: ₹${t.balance.toFixed(2)}</div>` : ''}
                        </div>
                    `;
                });
            }
        }
    } catch (error) {
        console.log('Ledger update error:', error);
    }
}

// ==================== SCANNER FUNCTIONS ====================
async function toggleScanner(type) {
    const readerId = type === 'inventory' ? 'reader' : 'bill-reader';
    const element = document.getElementById(readerId);
    if (!element) return;

    if (html5QrCode) {
        await html5QrCode.stop();
        html5QrCode = null;
    }

    html5QrCode = new Html5Qrcode(readerId);

    try {
        await html5QrCode.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 250, height: 250 } },
            (text) => {
                playBeepAndVibrate();
                handleScanResult(text, type);
            },
            (error) => console.log(error)
        );
        showToast('Scanner started', 'success');
    } catch (error) {
        showToast('Camera access denied', 'error');
        console.error(error);
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
    }
}

// ==================== GOOGLE DRIVE SYNC ====================
function handleSync() {
    if (!navigator.onLine) {
        showToast('No internet', 'error');
        return;
    }

    const now = new Date().getTime();
    if (!accessToken || (tokenExpiry && now > parseInt(tokenExpiry))) {
        // Clean URL for GitHub Pages Redirect
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

    if (syncIcon) syncIcon.className = 'fas fa-sync fa-spin';
    if (syncText) syncText.textContent = 'Syncing...';

    try {
        showToast('Syncing to Cloud...', 'info');
        const allDocs = await db.allDocs({ include_docs: true });
        const jsonData = JSON.stringify(allDocs.rows.map(r => r.doc));

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
        const fileId = searchData.files?.[0]?.id;

        const metadata = { name: BACKUP_FILE_NAME, mimeType: 'application/json' };
        const boundary = 'foo_bar_baz';
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${jsonData}\r\n--${boundary}--`;

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
            showToast('Sync Successful', 'success');
        } else {
            throw new Error('Upload failed');
        }
    } catch (e) {
        const syncIcon = document.querySelector('#sync-status i');
        const syncText = document.getElementById('sync-status-text');
        if (syncIcon) {
            syncIcon.className = 'fas fa-exclamation-circle';
            syncIcon.style.color = '#ef4444';
        }
        if (syncText) syncText.textContent = 'Sync failed';
        showToast('Sync Failed', 'error');
    }
}

// ==================== DATA EXPORT FUNCTIONS ====================
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
        const transactions = result.rows.map(r => r.doc).filter(d => d && d.type === 'ledger');
        let csv = 'Date,Customer,Total,Paid,Balance,Payment Method\n';
        transactions.forEach(t => {
            csv += `"${new Date(t.date).toLocaleString()}","${t.customer}",${t.total || 0},${t.paid || 0},${t.balance || 0},"${t.paymentMethod || 'Cash'}"\n`;
        });
        downloadFile(csv, 'ledger_export.csv', 'text/csv');
        showToast('Ledger exported', 'success');
    } catch (error) { showToast('Export failed', 'error'); }
}

// ==================== INITIALIZATION ====================
window.onload = async () => {
    // Handle OAuth redirect
    if (window.location.hash) {
        const params = new URLSearchParams(window.location.hash.substring(1));
        const token = params.get('access_token');
        if (token) {
            accessToken = token;
            localStorage.setItem('google_token', token);
            const expiryTime = new Date().getTime() + 3600000; // 1 hour
            localStorage.setItem('token_expiry', expiryTime.toString());
            window.history.replaceState(null, null, window.location.pathname);
            showToast('Google Drive connected!', 'success');
            setTimeout(() => uploadToDrive(), 1000);
        }
    }

    // Load all data
    await updateDashboard();
    await updateInventoryUI();
    await updateLedgerUI();
    await updateCustomersUI();

    // Update sync status
    if (accessToken && accessToken !== 'null') {
        const syncIcon = document.querySelector('#sync-status i');
        const syncText = document.getElementById('sync-status-text');
        if (syncIcon) {
            syncIcon.className = 'fas fa-check-circle';
            syncIcon.style.color = '#10b981';
        }
        if (syncText) syncText.textContent = 'Ready to sync';
    }

    // Initially hide FAB
    const fabButton = document.getElementById('fab-button');
    if (fabButton) {
        fabButton.style.display = 'none';
    }

    // Show FAB only on main menu initially
    updateFABVisibility('main-menu');
};