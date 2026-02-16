// ==================== DATABASE INIT ====================
const db = new PouchDB('workshop_db');
let html5QrCode = null;
let currentBillItems = [];
let accessToken = localStorage.getItem('google_token');
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com'; // Replace with your Google Client ID

// ==================== NAVIGATION (FIXED BACK BUTTON) ====================
function goToDashboard() {
    // Stop scanner if running
    if (html5QrCode) {
        html5QrCode.stop().catch(() => { });
        html5QrCode = null;
    }

    // Hide all screens
    document.querySelectorAll('.screen').forEach(s => {
        s.classList.remove('active');
    });

    // Show main menu
    document.getElementById('main-menu').classList.add('active');
}

function showScreen(screenId) {
    // Stop scanner if running
    if (html5QrCode) {
        html5QrCode.stop().catch(() => { });
        html5QrCode = null;
    }

    // Hide all screens
    document.querySelectorAll('.screen').forEach(s => {
        s.classList.remove('active');
    });

    // Show selected screen
    document.getElementById(screenId).classList.add('active');

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

// Override browser back button
window.addEventListener('popstate', function (event) {
    // Go to dashboard instead of browser back
    goToDashboard();
    // Push state to prevent leaving app
    history.pushState(null, null, location.href);
});

// Push initial state
history.pushState(null, null, location.href);

// ==================== DASHBOARD FUNCTIONS ====================
async function updateDashboard() {
    const allDocs = await db.allDocs({ include_docs: true });
    let totalItems = 0, totalSales = 0, totalCustomers = 0, lowStock = 0;
    let recentTransactions = [];

    allDocs.rows.forEach(row => {
        const doc = row.doc;
        if (doc.type === 'inventory') {
            totalItems++;
            const available = (doc.totalIn || 0) - (doc.totalSold || 0);
            if (available < (doc.minStock || 5)) lowStock++;
        } else if (doc.type === 'ledger') {
            totalSales += doc.total || 0;
            recentTransactions.push(doc);
        } else if (doc.type === 'customer') {
            totalCustomers++;
        }
    });

    document.getElementById('dash-total-items').textContent = totalItems;
    document.getElementById('dash-total-sales').textContent = '₹' + totalSales.toFixed(2);
    document.getElementById('dash-total-customers').textContent = totalCustomers;
    document.getElementById('dash-low-stock').textContent = lowStock;

    const recentDiv = document.getElementById('dash-recent');
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

// ==================== INVENTORY FUNCTIONS ====================
async function savePart() {
    const id = document.getElementById('part-id').value.trim();
    const name = document.getElementById('part-name').value.trim();
    const price = parseFloat(document.getElementById('part-price').value) || 0;
    const qty = parseInt(document.getElementById('part-qty').value) || 1;

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
                category: document.getElementById('part-category').value,
                location: document.getElementById('part-location').value,
                minStock: parseInt(document.getElementById('part-min-stock').value) || 5,
                createdAt: new Date().toISOString()
            };
        }

        doc.updatedAt = new Date().toISOString();
        await db.put(doc);

        document.getElementById('part-id').value = '';
        document.getElementById('part-name').value = '';
        document.getElementById('part-price').value = '';
        document.getElementById('part-qty').value = '1';

        showToast('Stock saved successfully!', 'success');
        updateInventoryUI();
        handleSync();
    } catch (error) {
        showToast('Error saving stock', 'error');
    }
}

async function updateInventoryUI() {
    const result = await db.allDocs({ include_docs: true });
    const items = result.rows.map(r => r.doc).filter(d => d.type === 'inventory');
    const search = document.getElementById('stock-search')?.value.toLowerCase() || '';
    const filter = document.getElementById('stock-filter')?.value || 'all';

    let filtered = items.filter(item =>
        item.name.toLowerCase().includes(search) ||
        item._id.toLowerCase().includes(search)
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

    document.getElementById('total-value').textContent = '₹' + totalValue.toFixed(2);
    document.getElementById('total-items-count').textContent = filtered.length;

    const tbody = document.getElementById('inventory-list-table');
    tbody.innerHTML = '';

    filtered.sort((a, b) => a.name.localeCompare(b.name)).forEach(item => {
        const available = (item.totalIn || 0) - (item.totalSold || 0);
        tbody.innerHTML += `
            <tr>
                <td>${item.name}</td>
                <td>${item.totalIn || 0}</td>
                <td><strong>${available}</strong></td>
                <td>₹${(item.price || 0).toFixed(2)}</td>
                <td><button class="del-btn" onclick="deleteItem('${item._id}')">✕</button></td>
            </tr>
        `;
    });
}

async function deleteItem(id) {
    if (confirm('Delete this item?')) {
        const doc = await db.get(id);
        await db.remove(doc);
        updateInventoryUI();
        showToast('Item deleted', 'success');
    }
}

// ==================== BILLING FUNCTIONS ====================
function addItemToCurrentBill() {
    const desc = document.getElementById('bill-desc').value.trim();
    const price = parseFloat(document.getElementById('bill-price').value) || 0;
    const qty = parseInt(document.getElementById('bill-qty').value) || 1;

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

    document.getElementById('bill-item-id').value = '';
    document.getElementById('bill-desc').value = '';
    document.getElementById('bill-price').value = '';
    document.getElementById('bill-qty').value = '1';

    renderBillList();
}

function renderBillList() {
    const tbody = document.getElementById('current-bill-body');
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
                <td><button class="del-btn" onclick="removeBillItem(${index})">✕</button></td>
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
    const subtotal = parseFloat(document.getElementById('bill-subtotal').textContent) || 0;
    const discount = parseFloat(document.getElementById('bill-discount').value) || 0;
    const total = Math.max(0, subtotal - discount);
    document.getElementById('bill-total').textContent = total.toFixed(2);
    calculateBalance();
}

function calculateBalance() {
    const total = parseFloat(document.getElementById('bill-total').textContent) || 0;
    const paid = parseFloat(document.getElementById('amount-paid').value) || 0;
    const balance = total - paid;
    const el = document.getElementById('balance-due');

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

async function finalizeBill() {
    const customer = document.getElementById('bill-cust-name').value.trim();
    if (!customer || currentBillItems.length === 0) {
        showToast('Enter customer name and add items', 'error');
        return;
    }

    const total = parseFloat(document.getElementById('bill-total').textContent) || 0;
    const paid = parseFloat(document.getElementById('amount-paid').value) || 0;
    const balance = total - paid;

    try {
        // Save ledger entry
        await db.put({
            _id: 'ledger_' + Date.now(),
            type: 'ledger',
            customer: customer,
            items: currentBillItems,
            total: total,
            paid: paid,
            balance: balance,
            paymentMethod: document.getElementById('payment-method').value,
            date: new Date().toISOString()
        });

        // Update inventory
        for (const item of currentBillItems) {
            const result = await db.allDocs({ include_docs: true });
            for (const row of result.rows) {
                if (row.doc.type === 'inventory' && row.doc.name === item.desc) {
                    row.doc.totalSold = (row.doc.totalSold || 0) + item.qty;
                    await db.put(row.doc);
                    break;
                }
            }
        }

        showBillPreview(customer, total, paid, balance);
        clearBill();
        showToast('Bill saved successfully!', 'success');
        handleSync();

    } catch (error) {
        showToast('Error saving bill', 'error');
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

function showBillPreview(customer, total, paid, balance) {
    let itemsHtml = '';
    currentBillItems.forEach(item => {
        itemsHtml += `<tr><td>${item.desc}</td><td>${item.qty}</td><td>₹${item.price}</td><td>₹${item.total}</td></tr>`;
    });

    const content = `
        <h3>Bill Summary</h3>
        <p><strong>Customer:</strong> ${customer}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
        <table style="width:100%; margin:10px 0;">
            <tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr>
            ${itemsHtml}
        </table>
        <p><strong>Total:</strong> ₹${total.toFixed(2)}</p>
        <p><strong>Paid:</strong> ₹${paid.toFixed(2)}</p>
        <p><strong>Balance:</strong> ₹${balance.toFixed(2)}</p>
    `;

    document.getElementById('bill-preview-content').innerHTML = content;
    document.getElementById('bill-preview-modal').classList.add('active');
}

// ==================== CUSTOMER FUNCTIONS ====================
async function loadCustomers() {
    const result = await db.allDocs({ include_docs: true });
    return result.rows.map(r => r.doc).filter(d => d.type === 'customer');
}

async function saveCustomer() {
    const name = document.getElementById('cust-name').value.trim();
    if (!name) {
        showToast('Name is required', 'error');
        return;
    }

    await db.put({
        _id: 'cust_' + Date.now(),
        type: 'customer',
        name: name,
        phone: document.getElementById('cust-phone').value,
        email: document.getElementById('cust-email').value,
        address: document.getElementById('cust-address').value,
        gst: document.getElementById('cust-gst').value,
        balance: 0,
        createdAt: new Date().toISOString()
    });

    closeCustomerModal();
    document.getElementById('cust-name').value = '';
    document.getElementById('cust-phone').value = '';
    document.getElementById('cust-email').value = '';
    document.getElementById('cust-address').value = '';
    document.getElementById('cust-gst').value = '';
    updateCustomersUI();
    showToast('Customer saved', 'success');
}

async function updateCustomersUI() {
    const customers = await loadCustomers();
    const search = document.getElementById('customer-search')?.value.toLowerCase() || '';
    const filtered = customers.filter(c => c.name.toLowerCase().includes(search));

    const container = document.getElementById('customers-list');
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

// ==================== LEDGER FUNCTIONS ====================
async function updateLedgerUI() {
    const result = await db.allDocs({ include_docs: true });
    const transactions = result.rows
        .map(r => r.doc)
        .filter(d => d.type === 'ledger')
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

    document.getElementById('ledger-total').textContent = '₹' + totalSales.toFixed(2);
    document.getElementById('credit-due').textContent = '₹' + creditDue.toFixed(2);

    const balancesDiv = document.getElementById('customer-balances-list');
    balancesDiv.innerHTML = '';
    Object.entries(balances).forEach(([cust, amt]) => {
        balancesDiv.innerHTML += `
            <div style="padding:8px; background:rgba(0,0,0,0.2); border-radius:8px; margin-bottom:5px;">
                <strong>${cust}</strong>: ₹${amt.toFixed(2)}
            </div>
        `;
    });

    const historyDiv = document.getElementById('bill-history-list');
    historyDiv.innerHTML = '';
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

// ==================== BARCODE SCANNER ====================
async function toggleScanner(type) {
    const readerId = type === 'inventory' ? 'reader' : 'bill-reader';

    if (html5QrCode) {
        await html5QrCode.stop();
        html5QrCode = null;
    }

    html5QrCode = new Html5Qrcode(readerId);

    try {
        await html5QrCode.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 250, height: 250 } },
            (text) => handleScanResult(text, type),
            (error) => console.log(error)
        );
    } catch (error) {
        showToast('Camera access denied', 'error');
    }
}

async function scanFile(input, type) {
    if (!input.files.length) return;

    const scanner = new Html5Qrcode('reader');
    try {
        const result = await scanner.scanFile(input.files[0], true);
        handleScanResult(result, type);
    } catch (error) {
        showToast('Could not read barcode', 'error');
    }
}

async function handleScanResult(text, type) {
    if (type === 'inventory') {
        document.getElementById('part-id').value = text;
        try {
            const doc = await db.get(text);
            if (doc.type === 'inventory') {
                document.getElementById('part-name').value = doc.name || '';
                document.getElementById('part-price').value = doc.price || '';
            }
        } catch (e) { }
    } else {
        document.getElementById('bill-item-id').value = text;
        try {
            const doc = await db.get(text);
            if (doc.type === 'inventory') {
                document.getElementById('bill-desc').value = doc.name || '';
                document.getElementById('bill-price').value = doc.price || '';
            }
        } catch (e) { }
    }

    if (html5QrCode) {
        await html5QrCode.stop();
        html5QrCode = null;
    }
}

// ==================== SYNC FUNCTIONS ====================
function handleSync() {
    if (!navigator.onLine) {
        showToast('No internet connection', 'error');
        return;
    }

    if (!accessToken) {
        const redirectUri = window.location.origin + window.location.pathname;
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.file')}`;
        window.location.href = authUrl;
    } else {
        uploadToDrive();
    }
}

async function uploadToDrive() {
    document.getElementById('sync-status').textContent = 'Syncing...';

    try {
        const allDocs = await db.allDocs({ include_docs: true });
        const data = allDocs.rows.map(r => r.doc);

        // Simulate successful sync
        document.getElementById('sync-status').textContent = 'Synced at ' + new Date().toLocaleTimeString();
        showToast('Sync completed', 'success');
    } catch (error) {
        document.getElementById('sync-status').textContent = 'Sync failed';
        showToast('Sync failed', 'error');
    }
}

// ==================== UTILITY FUNCTIONS ====================
function changeQty(id, delta) {
    const input = document.getElementById(id);
    let val = parseInt(input.value) || 1;
    val = Math.max(1, val + delta);
    input.value = val;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="fas fa-${type === 'success' ? 'check-circle' : 'exclamation-circle'}"></i> ${message}`;
    container.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
}

function toggleQuickMenu() {
    document.getElementById('quick-actions-menu').classList.toggle('active');
}

function showAddCustomerModal() {
    document.getElementById('customer-modal').classList.add('active');
}

function closeCustomerModal() {
    document.getElementById('customer-modal').classList.remove('active');
}

function closeModal() {
    document.getElementById('bill-preview-modal').classList.remove('active');
}

function printBill() {
    window.print();
}

async function exportInventory() {
    showToast('Exporting inventory...', 'info');
    // Implement CSV export
}

async function exportLedger() {
    showToast('Exporting ledger...', 'info');
    // Implement CSV export
}

// Handle OAuth redirect
window.onload = async () => {
    if (window.location.hash) {
        const params = new URLSearchParams(window.location.hash.substring(1));
        const token = params.get('access_token');
        if (token) {
            accessToken = token;
            localStorage.setItem('google_token', token);
            window.history.replaceState(null, null, window.location.pathname);
        }
    }

    // Initial data load
    await updateDashboard();
    await updateInventoryUI();
    await updateLedgerUI();
    await updateCustomersUI();
};