// ==================== DATABASE INITIALIZATION ====================
const db = new PouchDB('workshop_db');
let html5QrCode = null;
let currentBillItems = [];
let accessToken = localStorage.getItem('google_token');
let tokenExpiry = localStorage.getItem('token_expiry');
let currentScannerMode = null;

// Google Drive Configuration - REPLACE WITH YOUR OWN
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const BACKUP_FILE_NAME = 'workshop_backup.json';

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

    let icon = '📘';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '❌';
    if (type === 'warning') icon = '⚠️';

    toast.innerHTML = `${icon} ${message}`;
    container.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
}

function playBeepAndVibrate() {
    if (navigator.vibrate) navigator.vibrate(200);
}

// ==================== NAVIGATION ====================
function showScreen(screenId) {
    if (html5QrCode) {
        html5QrCode.stop().catch(() => { });
        html5QrCode = null;
    }

    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');

    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    if (screenId === 'dashboard-screen') document.getElementById('nav-dashboard').classList.add('active');
    if (screenId === 'stock-list-screen') document.getElementById('nav-stock').classList.add('active');
    if (screenId === 'billing-screen') document.getElementById('nav-billing').classList.add('active');
    if (screenId === 'ledger-screen') document.getElementById('nav-ledger').classList.add('active');
    if (screenId === 'customers-screen') document.getElementById('nav-customers').classList.add('active');

    if (screenId === 'stock-list-screen') updateInventoryUI();
    if (screenId === 'ledger-screen') updateLedgerUI();
    if (screenId === 'dashboard-screen') updateDashboard();
    if (screenId === 'customers-screen') loadCustomers();
}

function toggleQuickMenu() {
    document.getElementById('quick-actions-menu').classList.toggle('active');
}

function closeModal() {
    document.getElementById('bill-preview-modal').classList.remove('active');
    document.getElementById('customer-modal').classList.remove('active');
}

function printBill() {
    window.print();
}

// ==================== DATA EXPORT ====================
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
    } catch (error) {
        showToast('Export failed', 'error');
    }
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
    } catch (error) {
        showToast('Export failed', 'error');
    }
}

// ==================== GOOGLE DRIVE SYNC ====================
function handleSync() {
    if (!navigator.onLine) {
        return showToast('No internet connection', 'error');
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

    try {
        showToast('Syncing to Cloud...', 'info');

        const allDocs = await db.allDocs({ include_docs: true });
        const jsonData = JSON.stringify(allDocs.rows.map(r => r.doc));

        const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='${BACKUP_FILE_NAME}' and trashed=false`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        const searchData = await searchRes.json();
        const fileId = searchData.files?.[0]?.id;

        const metadata = { name: BACKUP_FILE_NAME, mimeType: 'application/json' };
        const boundary = 'foo_bar_baz';
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${jsonData}\r\n--${boundary}--`;

        const url = fileId
            ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
            : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

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
            showToast('Sync Successful', 'success');
        } else {
            showToast('Sync Failed', 'error');
        }
    } catch (e) {
        showToast('Sync Failed', 'error');
    }
}

// ==================== BARCODE SCANNER ====================
async function toggleScanner(type) {
    const readerId = type === 'inventory' ? 'reader' : 'bill-reader';
    const scannerDiv = document.getElementById(readerId);

    if (!scannerDiv) return;

    if (html5QrCode) {
        await html5QrCode.stop();
        html5QrCode = null;
        scannerDiv.style.display = 'none';
        return;
    }

    scannerDiv.style.display = 'block';
    currentScannerMode = type;

    html5QrCode = new Html5Qrcode(readerId);

    html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 250 },
        (text) => {
            playBeepAndVibrate();
            handleScanResult(text, type);

            if (html5QrCode) {
                html5QrCode.stop().catch(() => { });
                html5QrCode = null;
                scannerDiv.style.display = 'none';
            }
        },
        () => { }
    ).catch(() => {
        showToast('Camera access failed', 'error');
        scannerDiv.style.display = 'none';
    });
}

async function handleScanResult(text, type) {
    const idField = type === 'inventory' ? 'part-id' : 'bill-item-id';
    document.getElementById(idField).value = text;

    if (type === 'inventory') {
        try {
            const doc = await db.get(text).catch(() => null);
            if (doc && doc.type === 'inventory') {
                document.getElementById('part-name').value = doc.name || '';
                document.getElementById('part-price').value = doc.price || '';
                document.getElementById('part-category').value = doc.category || 'General';
                document.getElementById('part-location').value = doc.location || '';
                showToast('Item found!', 'success');
            } else {
                showToast('New item - fill details', 'info');
            }
        } catch (e) {
            showToast('New item - fill details', 'info');
        }
    } else {
        try {
            const doc = await db.get(text).catch(() => null);
            if (doc && doc.type === 'inventory') {
                document.getElementById('bill-desc').value = doc.name || '';
                document.getElementById('bill-price').value = doc.price || '';
                showToast('Item found!', 'success');
            } else {
                document.getElementById('bill-desc').value = '';
                document.getElementById('bill-price').value = '';
                showToast('Item not in inventory', 'warning');
            }
        } catch (e) {
            showToast('Item not in inventory', 'warning');
        }
    }
}

function startFullScanner(mode) {
    const scannerDiv = document.getElementById('full-scanner');
    if (!scannerDiv) return;

    if (html5QrCode) {
        html5QrCode.stop().catch(() => { });
    }

    html5QrCode = new Html5Qrcode('full-scanner');

    html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 300 },
        (text) => {
            playBeepAndVibrate();
            handleScanResult(text, mode);

            if (html5QrCode) {
                html5QrCode.stop().catch(() => { });
                html5QrCode = null;
            }

            if (mode === 'inventory') {
                showScreen('add-inventory-screen');
            } else {
                showScreen('billing-screen');
            }
        },
        () => { }
    ).catch(() => {
        showToast('Camera access failed', 'error');
    });
}

function lookupBarcode(barcode) {
    if (!barcode) return;
    handleScanResult(barcode, 'inventory');
    showScreen('add-inventory-screen');
}

// ==================== INVENTORY MANAGEMENT ====================
async function addInventoryItem() {
    const id = document.getElementById('part-id')?.value?.trim();
    const name = document.getElementById('part-name')?.value?.trim();
    const price = parseFloat(document.getElementById('part-price')?.value) || 0;
    const quantity = parseInt(document.getElementById('part-quantity')?.value) || 0;
    const category = document.getElementById('part-category')?.value || 'General';
    const location = document.getElementById('part-location')?.value || 'Main';

    if (!id || !name) {
        return showToast('Barcode and Name are required', 'error');
    }

    try {
        const existing = await db.get(id).catch(() => null);

        const doc = existing || {
            _id: id,
            type: 'inventory',
            name: name,
            price: price,
            category: category,
            location: location,
            totalIn: 0,
            totalSold: 0,
            createdAt: new Date().toISOString()
        };

        doc.name = name;
        doc.price = price;
        doc.category = category;
        doc.location = location;

        if (!existing) {
            doc.totalIn = quantity;
        } else {
            doc.totalIn = (doc.totalIn || 0) + quantity;
        }

        doc.updatedAt = new Date().toISOString();

        await db.put(doc);

        document.getElementById('part-id').value = '';
        document.getElementById('part-name').value = '';
        document.getElementById('part-price').value = '';
        document.getElementById('part-quantity').value = '0';

        showToast('Item saved successfully', 'success');
        updateInventoryUI();
        showScreen('stock-list-screen');
    } catch (error) {
        showToast('Error saving item', 'error');
    }
}

async function updateInventoryUI() {
    try {
        const result = await db.allDocs({ include_docs: true });
        const items = result.rows
            .map(r => r.doc)
            .filter(d => d && d.type === 'inventory')
            .sort((a, b) => a.name.localeCompare(b.name));

        const container = document.getElementById('inventory-list');
        if (!container) return;

        if (items.length === 0) {
            container.innerHTML = '<p class="empty-state">No items in inventory. Click + to add.</p>';
            return;
        }

        let html = '';
        items.forEach(item => {
            const available = (item.totalIn || 0) - (item.totalSold || 0);
            const lowStock = available < 5 ? 'low-stock' : '';

            html += `
                <div class="item-card ${lowStock}" onclick="editItem('${item._id}')">
                    <div class="item-header">
                        <h3>${item.name}</h3>
                        <span class="item-price">₹${item.price}</span>
                    </div>
                    <div class="item-details">
                        <span>📦 In: ${item.totalIn || 0}</span>
                        <span>📤 Sold: ${item.totalSold || 0}</span>
                        <span class="available">✅ Available: ${available}</span>
                    </div>
                    <div class="item-meta">
                        <span>📍 ${item.location || 'Main'}</span>
                        <span>🏷️ ${item.category || 'General'}</span>
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
    } catch (error) {
        showToast('Error loading inventory', 'error');
    }
}

async function editItem(id) {
    try {
        const doc = await db.get(id);

        document.getElementById('part-id').value = doc._id;
        document.getElementById('part-name').value = doc.name || '';
        document.getElementById('part-price').value = doc.price || '';
        document.getElementById('part-category').value = doc.category || 'General';
        document.getElementById('part-location').value = doc.location || 'Main';
        document.getElementById('part-quantity').value = '0';

        showScreen('add-inventory-screen');
    } catch (error) {
        showToast('Error loading item', 'error');
    }
}

function searchInventory() {
    const searchTerm = document.getElementById('search-inventory')?.value?.toLowerCase() || '';
    const items = document.querySelectorAll('#inventory-list .item-card');

    items.forEach(item => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(searchTerm) ? 'block' : 'none';
    });
}

// ==================== BILLING SYSTEM ====================
async function addToBill() {
    const itemId = document.getElementById('bill-item-id')?.value?.trim();
    const desc = document.getElementById('bill-desc')?.value?.trim();
    const price = parseFloat(document.getElementById('bill-price')?.value) || 0;
    const qty = parseInt(document.getElementById('bill-qty')?.value) || 1;

    if (!desc || price <= 0) {
        return showToast('Please fill description and price', 'error');
    }

    if (itemId) {
        try {
            const inventoryItem = await db.get(itemId).catch(() => null);
            if (inventoryItem && inventoryItem.type === 'inventory') {
                const available = (inventoryItem.totalIn || 0) - (inventoryItem.totalSold || 0);
                if (available < qty) {
                    if (!confirm(`Only ${available} in stock. Add anyway?`)) {
                        return;
                    }
                }
            }
        } catch (e) { }
    }

    const item = {
        id: itemId || 'manual-' + Date.now(),
        description: desc,
        price: price,
        quantity: qty,
        total: price * qty
    };

    currentBillItems.push(item);
    updateBillPreview();

    document.getElementById('bill-item-id').value = '';
    document.getElementById('bill-desc').value = '';
    document.getElementById('bill-price').value = '';
    document.getElementById('bill-qty').value = '1';

    showToast('Item added to bill', 'success');
}

function updateBillPreview() {
    const container = document.getElementById('bill-items-list');
    const subtotalEl = document.getElementById('bill-subtotal');
    const taxEl = document.getElementById('bill-tax');
    const totalEl = document.getElementById('bill-total');

    if (!container) return;

    if (currentBillItems.length === 0) {
        container.innerHTML = '<tr><td colspan="5" class="empty-state">No items added</td></tr>';
        if (subtotalEl) subtotalEl.textContent = '₹0.00';
        if (taxEl) taxEl.textContent = '₹0.00';
        if (totalEl) totalEl.textContent = '₹0.00';
        return;
    }

    let html = '';
    let subtotal = 0;

    currentBillItems.forEach((item, index) => {
        subtotal += item.total;
        html += `
            <tr>
                <td>${item.description}</td>
                <td>${item.quantity}</td>
                <td>₹${item.price.toFixed(2)}</td>
                <td>₹${item.total.toFixed(2)}</td>
                <td><button class="btn-icon" onclick="removeBillItem(${index})"><i class="fas fa-trash"></i></button></td>
            </tr>
        `;
    });

    container.innerHTML = html;

    const tax = subtotal * 0.18;
    const total = subtotal + tax;

    if (subtotalEl) subtotalEl.textContent = `₹${subtotal.toFixed(2)}`;
    if (taxEl) taxEl.textContent = `₹${tax.toFixed(2)}`;
    if (totalEl) totalEl.textContent = `₹${total.toFixed(2)}`;
}

function removeBillItem(index) {
    currentBillItems.splice(index, 1);
    updateBillPreview();
    showToast('Item removed', 'info');
}

function clearBill() {
    if (currentBillItems.length > 0 && confirm('Clear current bill?')) {
        currentBillItems = [];
        updateBillPreview();
        document.getElementById('bill-customer-name').value = '';
        document.getElementById('bill-customer-phone').value = '';
        showToast('Bill cleared', 'info');
    }
}

async function completeBill() {
    if (currentBillItems.length === 0) {
        return showToast('Add items to bill first', 'error');
    }

    const customerName = document.getElementById('bill-customer-name')?.value?.trim() || 'Walk-in Customer';
    const customerPhone = document.getElementById('bill-customer-phone')?.value?.trim() || '';
    const paymentMethod = document.getElementById('payment-method')?.value || 'Cash';

    const subtotal = currentBillItems.reduce((sum, item) => sum + item.total, 0);
    const tax = subtotal * 0.18;
    const total = subtotal + tax;

    const billData = {
        _id: 'BILL-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
        type: 'ledger',
        customer: customerName,
        customerPhone: customerPhone,
        items: currentBillItems,
        subtotal: subtotal,
        tax: tax,
        total: total,
        paid: total,
        balance: 0,
        paymentMethod: paymentMethod,
        date: new Date().toISOString(),
        status: 'completed'
    };

    try {
        await db.put(billData);

        for (const item of currentBillItems) {
            if (item.id && !item.id.startsWith('manual-')) {
                try {
                    const inventoryItem = await db.get(item.id).catch(() => null);
                    if (inventoryItem && inventoryItem.type === 'inventory') {
                        inventoryItem.totalSold = (inventoryItem.totalSold || 0) + item.quantity;
                        inventoryItem.updatedAt = new Date().toISOString();
                        await db.put(inventoryItem);
                    }
                } catch (e) { }
            }
        }

        showBillPreview(billData);

        currentBillItems = [];
        updateBillPreview();
        document.getElementById('bill-customer-name').value = '';
        document.getElementById('bill-customer-phone').value = '';

        showToast('Bill completed successfully', 'success');
        updateDashboard();
        updateLedgerUI();
    } catch (error) {
        showToast('Error saving bill', 'error');
    }
}

function showBillPreview(bill) {
    const modal = document.getElementById('bill-preview-modal');
    const content = document.getElementById('bill-preview-content');

    if (!modal || !content) return;

    let itemsHtml = '';
    bill.items.forEach(item => {
        itemsHtml += `
            <tr>
                <td>${item.description}</td>
                <td>${item.quantity}</td>
                <td>₹${item.price.toFixed(2)}</td>
                <td>₹${item.total.toFixed(2)}</td>
            </tr>
        `;
    });

    content.innerHTML = `
        <div class="bill-header">
            <h2>WORKSHOP BILL</h2>
            <p>Bill #: ${bill._id}</p>
            <p>Date: ${new Date(bill.date).toLocaleString()}</p>
        </div>
        <div class="customer-info">
            <p><strong>Customer:</strong> ${bill.customer}</p>
            <p><strong>Phone:</strong> ${bill.customerPhone || 'N/A'}</p>
        </div>
        <table class="bill-items">
            <thead>
                <tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr>
            </thead>
            <tbody>
                ${itemsHtml}
            </tbody>
        </table>
        <div class="bill-summary">
            <p>Subtotal: ₹${bill.subtotal.toFixed(2)}</p>
            <p>Tax (18%): ₹${bill.tax.toFixed(2)}</p>
            <p><strong>Total: ₹${bill.total.toFixed(2)}</strong></p>
            <p>Payment: ${bill.paymentMethod}</p>
        </div>
        <div class="bill-footer">
            <p>Thank you for your business!</p>
        </div>
    `;

    modal.classList.add('active');
}

// ==================== LEDGER MANAGEMENT ====================
async function updateLedgerUI() {
    try {
        const result = await db.allDocs({ include_docs: true });
        const transactions = result.rows
            .map(r => r.doc)
            .filter(d => d && d.type === 'ledger')
            .sort((a, b) => new Date(b.date) - new Date(a.date));

        const container = document.getElementById('ledger-entries');
        if (!container) return;

        let totalSales = 0;
        let totalOutstanding = 0;

        transactions.forEach(t => {
            totalSales += t.total || 0;
            totalOutstanding += t.balance || 0;
        });

        document.getElementById('total-sales').textContent = `₹${totalSales.toFixed(2)}`;
        document.getElementById('total-outstanding').textContent = `₹${totalOutstanding.toFixed(2)}`;

        if (transactions.length === 0) {
            container.innerHTML = '<p class="empty-state">No transactions yet</p>';
            return;
        }

        let html = '';
        transactions.slice(0, 50).forEach(t => {
            const statusClass = t.balance > 0 ? 'due' : 'paid';
            html += `
                <div class="ledger-item" onclick="viewTransaction('${t._id}')">
                    <div class="ledger-header">
                        <span class="customer-name">${t.customer}</span>
                        <span class="amount ${statusClass}">₹${t.total.toFixed(2)}</span>
                    </div>
                    <div class="ledger-details">
                        <span>📅 ${new Date(t.date).toLocaleDateString()}</span>
                        <span>💳 ${t.paymentMethod || 'Cash'}</span>
                        <span class="balance">Balance: ₹${(t.balance || 0).toFixed(2)}</span>
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
    } catch (error) {
        showToast('Error loading ledger', 'error');
    }
}

async function viewTransaction(id) {
    try {
        const transaction = await db.get(id);
        showBillPreview(transaction);
    } catch (error) {
        showToast('Error loading transaction', 'error');
    }
}

function filterLedger() {
    const filter = document.getElementById('ledger-filter')?.value || 'all';
    const items = document.querySelectorAll('#ledger-entries .ledger-item');

    items.forEach(item => {
        if (filter === 'all') {
            item.style.display = 'block';
        } else if (filter === 'due') {
            const hasDue = item.querySelector('.balance')?.textContent.includes('₹0.00') === false;
            item.style.display = hasDue ? 'block' : 'none';
        } else if (filter === 'paid') {
            const isPaid = item.querySelector('.balance')?.textContent.includes('₹0.00') === true;
            item.style.display = isPaid ? 'block' : 'none';
        }
    });
}

// ==================== CUSTOMER MANAGEMENT ====================
function showAddCustomerForm() {
    document.getElementById('modal-customer-name').value = '';
    document.getElementById('modal-customer-phone').value = '';
    document.getElementById('modal-customer-email').value = '';
    document.getElementById('modal-customer-address').value = '';
    document.getElementById('customer-modal').classList.add('active');
}

async function saveCustomerFromModal() {
    const name = document.getElementById('modal-customer-name')?.value?.trim();
    const phone = document.getElementById('modal-customer-phone')?.value?.trim();
    const email = document.getElementById('modal-customer-email')?.value?.trim();
    const address = document.getElementById('modal-customer-address')?.value?.trim();

    if (!name) {
        return showToast('Customer name is required', 'error');
    }

    const customerId = 'CUST-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);

    try {
        const customer = {
            _id: customerId,
            type: 'customer',
            name: name,
            phone: phone,
            email: email,
            address: address,
            balance: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await db.put(customer);

        closeModal();
        loadCustomers();
        showToast('Customer saved', 'success');
    } catch (error) {
        showToast('Error saving customer', 'error');
    }
}

async function loadCustomers() {
    try {
        const result = await db.allDocs({ include_docs: true });
        const customers = result.rows
            .map(r => r.doc)
            .filter(d => d && d.type === 'customer')
            .sort((a, b) => a.name.localeCompare(b.name));

        const container = document.getElementById('customers-list');
        if (!container) return;

        if (customers.length === 0) {
            container.innerHTML = '<p class="empty-state">No customers yet. Click + to add.</p>';
            return;
        }

        let html = '';
        customers.forEach(c => {
            const balanceClass = c.balance > 0 ? 'due' : (c.balance < 0 ? 'credit' : 'paid');

            html += `
                <div class="customer-card" onclick="viewCustomer('${c._id}')">
                    <div class="customer-header">
                        <span class="customer-name">${c.name}</span>
                        <span class="customer-balance ${balanceClass}">₹${c.balance}</span>
                    </div>
                    <div class="customer-details">
                        <span>📞 ${c.phone || 'No phone'}</span>
                        <span>📧 ${c.email || 'No email'}</span>
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
    } catch (error) {
        showToast('Error loading customers', 'error');
    }
}

function searchCustomers() {
    const searchTerm = document.getElementById('search-customer')?.value?.toLowerCase() || '';
    const cards = document.querySelectorAll('#customers-list .customer-card');

    cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        card.style.display = text.includes(searchTerm) ? 'block' : 'none';
    });
}

async function viewCustomer(id) {
    try {
        const customer = await db.get(id);
        alert(`Customer: ${customer.name}\nPhone: ${customer.phone || 'N/A'}\nBalance: ₹${customer.balance}`);
    } catch (error) {
        showToast('Error loading customer', 'error');
    }
}

// ==================== DASHBOARD ====================
async function updateDashboard() {
    try {
        const result = await db.allDocs({ include_docs: true });
        const docs = result.rows.map(r => r.doc);

        const inventory = docs.filter(d => d && d.type === 'inventory');
        const transactions = docs.filter(d => d && d.type === 'ledger');

        const totalItems = inventory.length;
        const totalStock = inventory.reduce((sum, item) => sum + (item.totalIn || 0) - (item.totalSold || 0), 0);
        const lowStock = inventory.filter(item => (item.totalIn || 0) - (item.totalSold || 0) < 5).length;

        const today = new Date().toDateString();
        const todaySales = transactions
            .filter(t => new Date(t.date).toDateString() === today)
            .reduce((sum, t) => sum + (t.total || 0), 0);

        const totalOutstanding = transactions.reduce((sum, t) => sum + (t.balance || 0), 0);

        document.getElementById('total-items').textContent = totalItems;
        document.getElementById('total-stock').textContent = totalStock;
        document.getElementById('low-stock').textContent = lowStock;
        document.getElementById('today-sales').textContent = `₹${todaySales.toFixed(2)}`;
        document.getElementById('outstanding').textContent = `₹${totalOutstanding.toFixed(2)}`;

        const recentContainer = document.getElementById('recent-transactions');
        if (recentContainer) {
            const recent = transactions
                .sort((a, b) => new Date(b.date) - new Date(a.date))
                .slice(0, 5);

            if (recent.length === 0) {
                recentContainer.innerHTML = '<p class="empty-state">No recent transactions</p>';
            } else {
                let html = '';
                recent.forEach(t => {
                    html += `
                        <div class="recent-item" onclick="viewTransaction('${t._id}')">
                            <span>${t.customer}</span>
                            <span>₹${t.total.toFixed(2)}</span>
                            <span>${new Date(t.date).toLocaleDateString()}</span>
                        </div>
                    `;
                });
                recentContainer.innerHTML = html;
            }
        }

        const alertsContainer = document.getElementById('stock-alerts');
        if (alertsContainer) {
            const lowStockItems = inventory
                .filter(item => (item.totalIn || 0) - (item.totalSold || 0) < 5)
                .slice(0, 5);

            if (lowStockItems.length === 0) {
                alertsContainer.innerHTML = '<p class="empty-state">No low stock alerts</p>';
            } else {
                let html = '';
                lowStockItems.forEach(item => {
                    const available = (item.totalIn || 0) - (item.totalSold || 0);
                    html += `
                        <div class="alert-item" onclick="editItem('${item._id}')">
                            <span>⚠️ ${item.name}</span>
                            <span>Stock: ${available}</span>
                        </div>
                    `;
                });
                alertsContainer.innerHTML = html;
            }
        }
    } catch (error) {
        showToast('Error updating dashboard', 'error');
    }
}

// ==================== BACKUP & RESTORE ====================
async function backupToDrive() {
    if (!navigator.onLine) {
        return showToast('No internet connection', 'error');
    }

    try {
        showToast('Creating backup...', 'info');

        const allDocs = await db.allDocs({ include_docs: true });
        const backup = {
            timestamp: new Date().toISOString(),
            version: '1.0',
            data: allDocs.rows.map(r => r.doc)
        };

        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `workshop_backup_${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);

        showToast('Backup created', 'success');
    } catch (error) {
        showToast('Backup failed', 'error');
    }
}

async function restoreFromBackup() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            showToast('Restoring backup...', 'info');

            const text = await file.text();
            const backup = JSON.parse(text);

            if (!backup.data || !Array.isArray(backup.data)) {
                throw new Error('Invalid backup file');
            }

            if (!confirm('This will replace all current data. Continue?')) {
                return;
            }

            const allDocs = await db.allDocs();
            for (const row of allDocs.rows) {
                await db.remove(row.id, row.value.rev).catch(() => { });
            }

            for (const doc of backup.data) {
                await db.put(doc).catch(() => { });
            }

            showToast('Restore complete', 'success');

            updateDashboard();
            updateInventoryUI();
            updateLedgerUI();
            loadCustomers();
        } catch (error) {
            showToast('Restore failed: ' + error.message, 'error');
        }
    };

    input.click();
}

// ==================== ONLINE/OFFLINE DETECTION ====================
window.addEventListener('online', () => {
    document.getElementById('online-indicator').innerHTML = '<i class="fas fa-wifi" style="color:#2ecc71"></i>';
    showToast('Back online', 'success');

    if (accessToken) {
        uploadToDrive();
    }
});

window.addEventListener('offline', () => {
    document.getElementById('online-indicator').innerHTML = '<i class="fas fa-wifi-slash" style="color:#e74c3c"></i>';
    showToast('Working offline', 'warning');
});

// ==================== INITIALIZATION ====================
window.onload = async function () {
    if (navigator.onLine) {
        document.getElementById('online-indicator').innerHTML = '<i class="fas fa-wifi" style="color:#2ecc71"></i>';
    } else {
        document.getElementById('online-indicator').innerHTML = '<i class="fas fa-wifi-slash" style="color:#e74c3c"></i>';
    }

    if (window.location.hash) {
        const params = new URLSearchParams(window.location.hash.substring(1));
        const token = params.get('access_token');

        if (token) {
            accessToken = token;
            localStorage.setItem('google_token', token);
            localStorage.setItem('token_expiry', (new Date().getTime() + 3600000).toString());

            window.history.replaceState(null, null, window.location.pathname);

            setTimeout(uploadToDrive, 1000);
        }
    }

    updateDashboard();

    setInterval(() => {
        if (document.getElementById('dashboard-screen')?.classList.contains('active')) {
            updateDashboard();
        } else if (document.getElementById('stock-list-screen')?.classList.contains('active')) {
            updateInventoryUI();
        } else if (document.getElementById('ledger-screen')?.classList.contains('active')) {
            updateLedgerUI();
        } else if (document.getElementById('customers-screen')?.classList.contains('active')) {
            loadCustomers();
        }
    }, 30000);
};

// ==================== EXPORT FUNCTIONS ====================
window.addInventoryItem = addInventoryItem;
window.addToBill = addToBill;
window.completeBill = completeBill;
window.clearBill = clearBill;
window.removeBillItem = removeBillItem;
window.toggleScanner = toggleScanner;
window.startFullScanner = startFullScanner;
window.lookupBarcode = lookupBarcode;
window.showScreen = showScreen;
window.toggleQuickMenu = toggleQuickMenu;
window.closeModal = closeModal;
window.printBill = printBill;
window.exportInventory = exportInventory;
window.exportLedger = exportLedger;
window.handleSync = handleSync;
window.backupToDrive = backupToDrive;
window.restoreFromBackup = restoreFromBackup;
window.searchInventory = searchInventory;
window.filterLedger = filterLedger;
window.changeQty = changeQty;
window.editItem = editItem;
window.showAddCustomerForm = showAddCustomerForm;
window.saveCustomerFromModal = saveCustomerFromModal;
window.searchCustomers = searchCustomers;
window.viewCustomer = viewCustomer;
window.viewTransaction = viewTransaction;