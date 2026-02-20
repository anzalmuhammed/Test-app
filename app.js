// ==================== DATABASE INIT ====================
const db = new PouchDB('workshop_db');
let html5QrCode = null;
let currentBillItems = [];
let accessToken = localStorage.getItem('google_token');
let tokenExpiry = localStorage.getItem('token_expiry');
let torchEnabled = false;
let lastBackPress = 0;
let currentScanner = null; // Track active scanner

// ===== YOUR GOOGLE CLIENT ID =====
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const BACKUP_FILE_NAME = 'workshop_backup.json';

// ==================== DOUBLE TAP TO EXIT ====================
function handleBackPress() {
    const now = new Date().getTime();
    if (now - lastBackPress < 2000) {
        if (window.matchMedia('(display-mode: standalone)').matches) {
            showToast('Exiting app...', 'info');
            setTimeout(() => { window.close(); }, 500);
        } else {
            showToast('Double tap again to exit', 'warning');
        }
    } else {
        lastBackPress = now;
        const indicator = document.createElement('div');
        indicator.className = 'exit-indicator';
        indicator.textContent = 'Tap again to exit';
        document.body.appendChild(indicator);
        setTimeout(() => { if (indicator.parentNode) indicator.remove(); }, 2000);
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

// ==================== NETWORK STATUS ====================
function updateNetworkStatus() {
    const syncStatus = document.getElementById('sync-status');
    const syncText = document.getElementById('sync-status-text');
    const syncIcon = document.querySelector('#sync-status i');

    if (navigator.onLine) {
        if (syncStatus) syncStatus.classList.add('online');
        if (syncStatus) syncStatus.classList.remove('offline');
        if (syncIcon) syncIcon.style.color = '#10b981';
        if (syncText) syncText.textContent = accessToken ? 'Online - Ready to sync' : 'Online';

        if (accessToken && localStorage.getItem('wasOffline') === 'true') {
            autoSync();
            localStorage.removeItem('wasOffline');
        }
    } else {
        if (syncStatus) syncStatus.classList.add('offline');
        if (syncStatus) syncStatus.classList.remove('online');
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
        await uploadToDrive();
    } else {
        localStorage.setItem('pendingSync', 'true');
        showToast('Changes saved offline.', 'info');
    }
}

// ==================== FAB VISIBILITY ====================
function updateFABVisibility(screenId) {
    const fabButton = document.getElementById('fab-button');
    if (!fabButton) return;
    fabButton.style.display = (screenId === 'dashboard-screen') ? 'flex' : 'none';
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
    let icon = type === 'success' ? 'check-circle' : (type === 'error' ? 'exclamation-circle' : 'info-circle');
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
    } catch (e) { console.log('Audio error'); }
}

// ==================== FLASHLIGHT ====================
async function toggleFlash(type) {
    if (!html5QrCode) return;
    torchEnabled = !torchEnabled;
    const flashIcon = document.getElementById(`flash-${type}`);
    try {
        await html5QrCode.setTorch(torchEnabled);
        if (flashIcon) {
            flashIcon.classList.toggle('active', torchEnabled);
            flashIcon.innerHTML = torchEnabled ? '<i class="fas fa-bolt" style="color: black;"></i>' : '<i class="fas fa-bolt"></i>';
        }
    } catch (error) {
        showToast('Flashlight not supported', 'warning');
    }
}

// ==================== STOP SCANNER ====================
async function stopScanner() {
    if (html5QrCode) {
        try {
            await html5QrCode.stop();
        } catch (e) {
            console.log('Error stopping scanner:', e);
        }
        html5QrCode = null;
    }

    // Hide scanner overlays
    ['inventory', 'bill'].forEach(t => {
        const overlay = document.getElementById(`scanner-overlay-${t}`);
        const flash = document.getElementById(`flash-${t}`);
        if (overlay) overlay.style.display = 'none';
        if (flash) flash.style.display = 'none';
    });
    torchEnabled = false;
}

// ==================== NAVIGATION ====================
function goToDashboard() {
    showScreen('dashboard-screen');
}

async function showScreen(screenId) {
    // Stop any active scanner when changing screens
    await stopScanner();

    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(screenId);
    if (target) target.classList.add('active');

    updateFABVisibility(screenId);

    // Refresh data based on screen
    if (screenId === 'stock-list-screen') await updateInventoryUI(); // Will show default view
    if (screenId === 'ledger-screen') await updateLedgerUI();
    if (screenId === 'customers-screen') await updateCustomersUI();
    if (screenId === 'dashboard-screen') await updateDashboard();
    if (screenId === 'quick-bill-screen') {
        document.getElementById('bill-cust-name').value = '';
        document.getElementById('bill-vehicle-no').value = '';
        clearBill();
    }
}

function toggleQuickMenu() {
    const menu = document.getElementById('quick-actions-menu');
    if (menu) menu.classList.toggle('active');
}

function closeModal() {
    document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
}

// ==================== DASHBOARD ====================
async function updateDashboard() {
    try {
        console.log('Updating dashboard...');
        const result = await db.allDocs({ include_docs: true });
        let itemsCount = 0, customersCount = 0, lowStock = 0, dueAmount = 0;
        let recentTransactions = [];

        result.rows.forEach(r => {
            const d = r.doc;
            if (d.type === 'inventory') {
                itemsCount++;
                const available = (d.totalIn || 0) - (d.totalSold || 0);
                if (available < (d.minStock || 5)) lowStock++;
            } else if (d.type === 'ledger') {
                if (d.balance > 0) dueAmount += d.balance;
                recentTransactions.push(d);
            } else if (d.type === 'customer') {
                customersCount++;
            }
        });

        document.getElementById('dash-total-items').textContent = itemsCount;
        document.getElementById('dash-total-customers').textContent = customersCount;
        document.getElementById('dash-low-stock').textContent = lowStock;
        document.getElementById('dash-due-amount').textContent = '₹' + dueAmount.toFixed(2);

        // Show recent transactions
        const recentDiv = document.getElementById('dash-recent');
        if (recentDiv) {
            recentDiv.innerHTML = '';
            if (recentTransactions.length === 0) {
                recentDiv.innerHTML = '<p style="text-align: center; opacity: 0.7;">No recent transactions</p>';
            } else {
                recentTransactions.sort((a, b) => new Date(b.date) - new Date(a.date))
                    .slice(0, 5).forEach(t => {
                        recentDiv.innerHTML += `
                            <div class="recent-item">
                                <div>
                                    <span class="customer">${t.customer || 'Customer'}</span>
                                    ${t.vehicleNo ? `<div class="vehicle">${t.vehicleNo}</div>` : ''}
                                    <div class="date">${new Date(t.date).toLocaleString()}</div>
                                </div>
                                <span class="amount">₹${(t.total || 0).toFixed(2)}</span>
                            </div>`;
                    });
            }
        }
    } catch (e) {
        console.error('Dashboard error', e);
    }
}

// ==================== INVENTORY ====================
async function savePart() {
    const id = document.getElementById('part-id')?.value.trim();
    const name = document.getElementById('part-name')?.value.trim();
    const price = parseFloat(document.getElementById('part-price')?.value) || 0;
    const qty = parseInt(document.getElementById('part-qty')?.value) || 1;

    if (!id || !name) return showToast('Enter ID and Name', 'error');

    try {
        let doc;
        try {
            doc = await db.get(id);
            doc.totalIn = (doc.totalIn || 0) + qty;
            doc.price = price;
            doc.name = name;
        } catch (e) {
            doc = {
                _id: id,
                type: 'inventory',
                name,
                price,
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
        showToast('Stock saved!', 'success');

        // Clear form
        document.getElementById('part-id').value = '';
        document.getElementById('part-name').value = '';
        document.getElementById('part-price').value = '';
        document.getElementById('part-qty').value = '1';
        document.getElementById('part-category').value = 'general';
        document.getElementById('part-location').value = '';
        document.getElementById('part-min-stock').value = '5';

        await updateInventoryUI();
        await updateDashboard();
        await autoSync();
    } catch (error) {
        showToast('Save failed', 'error');
    }
}

// ==================== INVENTORY FILTERS WITH APPLY BUTTON ====================
let currentInventoryFilters = {
    search: '',
    filter: 'all',
    category: 'all',
    sort: 'name'
};

function applyInventoryFilters() {
    currentInventoryFilters.search = document.getElementById('stock-search')?.value || '';
    currentInventoryFilters.filter = document.getElementById('stock-filter')?.value || 'all';
    currentInventoryFilters.category = document.getElementById('stock-category')?.value || 'all';
    currentInventoryFilters.sort = document.getElementById('stock-sort')?.value || 'name';
    updateInventoryUI();
}

function resetInventoryFilters() {
    document.getElementById('stock-search').value = '';
    document.getElementById('stock-filter').value = 'all';
    document.getElementById('stock-category').value = 'all';
    document.getElementById('stock-sort').value = 'name';

    currentInventoryFilters = {
        search: '',
        filter: 'all',
        category: 'all',
        sort: 'name'
    };
    updateInventoryUI();
}

async function updateInventoryUI() {
    try {
        console.log('Updating inventory UI...');
        const result = await db.allDocs({ include_docs: true });
        let items = result.rows.map(r => r.doc).filter(d => d && d.type === 'inventory');

        // Apply search filter
        const search = currentInventoryFilters.search.toLowerCase();
        if (search) {
            items = items.filter(item =>
                item.name.toLowerCase().includes(search) ||
                (item._id && item._id.toLowerCase().includes(search))
            );
        }

        // Apply stock filter
        const filter = currentInventoryFilters.filter;
        if (filter === 'low') {
            items = items.filter(item =>
                (item.totalIn - item.totalSold) < (item.minStock || 5)
            );
        } else if (filter === 'out') {
            items = items.filter(item =>
                (item.totalIn - item.totalSold) <= 0
            );
        }

        // Apply category filter
        const category = currentInventoryFilters.category;
        if (category !== 'all') {
            items = items.filter(item => item.category === category);
        }

        // Apply sorting
        const sort = currentInventoryFilters.sort;
        switch (sort) {
            case 'name':
                items.sort((a, b) => a.name.localeCompare(b.name));
                break;
            case 'name-desc':
                items.sort((a, b) => b.name.localeCompare(a.name));
                break;
            case 'price-low':
                items.sort((a, b) => (a.price || 0) - (b.price || 0));
                break;
            case 'price-high':
                items.sort((a, b) => (b.price || 0) - (a.price || 0));
                break;
            case 'stock-low':
                items.sort((a, b) => ((a.totalIn - a.totalSold) - (b.totalIn - b.totalSold)));
                break;
            case 'stock-high':
                items.sort((a, b) => ((b.totalIn - b.totalSold) - (a.totalIn - a.totalSold)));
                break;
        }

        const tbody = document.getElementById('inventory-list-table');
        if (!tbody) return;

        tbody.innerHTML = '';
        if (items.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">No items match your filters</td></tr>';
        } else {
            items.forEach(item => {
                const available = (item.totalIn || 0) - (item.totalSold || 0);
                tbody.innerHTML += `
                    <tr>
                        <td>${item.name}</td>
                        <td>${item.totalIn || 0}</td>
                        <td>${item.totalSold || 0}</td>
                        <td style="font-weight:bold; color:${available <= 0 ? '#ef4444' : available < (item.minStock || 5) ? '#f59e0b' : 'inherit'}">${available}</td>
                        <td>₹${(item.price || 0).toFixed(2)}</td>
                        <td><button class="del-btn" onclick="deleteItem('${item._id}')"><i class="fas fa-trash"></i></button></td>
                    </tr>`;
            });
        }

        // Update total value
        const totalValue = items.reduce((sum, item) => {
            const available = (item.totalIn || 0) - (item.totalSold || 0);
            return sum + (available * (item.price || 0));
        }, 0);

        const totalValueEl = document.getElementById('total-value');
        const totalItemsEl = document.getElementById('total-items-count');
        if (totalValueEl) totalValueEl.textContent = '₹' + totalValue.toFixed(2);
        if (totalItemsEl) totalItemsEl.textContent = items.length;

    } catch (error) {
        console.error('Inventory update error:', error);
    }
}

async function deleteItem(id) {
    if (!confirm('Delete item?')) return;
    try {
        const doc = await db.get(id);
        await db.remove(doc);
        await updateInventoryUI();
        await updateDashboard();
        await autoSync();
        showToast('Item deleted', 'success');
    } catch (error) {
        showToast('Delete failed', 'error');
    }
}

// ==================== BILLING (STOCK PROTECTION) ====================
async function addItemToCurrentBill() {
    const desc = document.getElementById('bill-desc').value.trim();
    const price = parseFloat(document.getElementById('bill-price').value) || 0;
    const qtyRequested = parseInt(document.getElementById('bill-qty').value) || 1;
    const itemId = document.getElementById('bill-item-id').value.trim();

    if (!desc) return showToast('Enter item description', 'warning');

    // CHECK STOCK AVAILABILITY
    try {
        const allDocs = await db.allDocs({ include_docs: true });
        const stockItem = allDocs.rows.find(r =>
            (r.doc._id === itemId || r.doc.name === desc) && r.doc.type === 'inventory'
        );

        if (stockItem) {
            const available = (stockItem.doc.totalIn || 0) - (stockItem.doc.totalSold || 0);

            if (qtyRequested > available) {
                showToast(`Insufficient Stock! Only ${available} left.`, 'error');
                return;
            }
        } else {
            showToast('Item not found in inventory. Proceeding as service/misc.', 'info');
        }

        // ADD TO BILL LIST
        currentBillItems.push({
            id: itemId || null,
            desc,
            price,
            qty: qtyRequested,
            total: price * qtyRequested
        });

        renderBillList();
        showToast('Item added to bill', 'success');

        // Clear inputs
        document.getElementById('bill-desc').value = '';
        document.getElementById('bill-price').value = '';
        document.getElementById('bill-qty').value = '1';
        document.getElementById('bill-item-id').value = '';

    } catch (e) {
        console.error(e);
        showToast('Error checking stock', 'error');
    }
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
                <td><input type="number" value="${item.price}" step="0.01" min="0" style="width:70px; padding:3px;" onchange="updateBillItemPrice(${index}, this.value)"></td>
                <td>₹${item.total.toFixed(2)}</td>
                <td><button class="del-btn" onclick="removeBillItem(${index})">×</button></td>
            </tr>`;
    });
    document.getElementById('bill-subtotal').textContent = subtotal.toFixed(2);
    document.getElementById('bill-total').textContent = subtotal.toFixed(2);
    document.getElementById('current-items-section').style.display = 'block';
    calculateBalance();
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

function calculateBalance() {
    const total = parseFloat(document.getElementById('bill-total').textContent) || 0;
    const paid = parseFloat(document.getElementById('amount-paid').value) || 0;
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

async function finalizeBill() {
    const customer = document.getElementById('bill-cust-name').value.trim();
    const vehicleNo = document.getElementById('bill-vehicle-no').value.trim().toUpperCase();

    if (!customer || currentBillItems.length === 0) return showToast('Add customer and items', 'warning');

    try {
        const total = parseFloat(document.getElementById('bill-total').textContent);
        const paid = parseFloat(document.getElementById('amount-paid').value) || 0;
        const balance = total - paid;
        const billId = 'ledger_' + Date.now();

        // Save to Ledger with vehicle number
        await db.put({
            _id: billId,
            type: 'ledger',
            customer,
            vehicleNo: vehicleNo || '',
            total,
            paid,
            balance,
            paymentMethod: document.getElementById('payment-method')?.value || 'cash',
            date: new Date().toISOString(),
            items: currentBillItems,
            updatedAt: new Date().toISOString()
        });

        // DEDUCT FROM INVENTORY
        const result = await db.allDocs({ include_docs: true });
        for (const billItem of currentBillItems) {
            const match = result.rows.find(r =>
                (r.doc._id === billItem.id || r.doc.name === billItem.desc) && r.doc.type === 'inventory'
            );

            if (match) {
                match.doc.totalSold = (match.doc.totalSold || 0) + billItem.qty;
                match.doc.updatedAt = new Date().toISOString();
                await db.put(match.doc);
            }
        }

        showBillPreview(customer, vehicleNo, total, paid, balance);
        clearBill();
        await updateDashboard();
        await updateInventoryUI();
        await autoSync();
        showToast('Bill Saved & Stock Updated', 'success');
    } catch (e) {
        console.error(e);
        showToast('Error finalizing bill', 'error');
    }
}

function showBillPreview(customer, vehicleNo, total, paid, balance) {
    let itemsHtml = '';
    currentBillItems.forEach(item => {
        itemsHtml += `<tr><td>${item.desc}</td><td>${item.qty}</td><td>₹${item.price.toFixed(2)}</td><td>₹${item.total.toFixed(2)}</td></tr>`;
    });

    const content = `
        <div style="padding: 20px; background: white; color: black; border-radius: 10px;">
            <h2 style="text-align: center; color: #6366f1;">WORKSHOP PRO</h2>
            <h3 style="text-align: center;">INVOICE</h3>
            <p><strong>Bill No:</strong> ${'BILL' + Date.now().toString().slice(-8)}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
            <p><strong>Customer:</strong> ${customer}</p>
            ${vehicleNo ? `<p><strong>Vehicle No:</strong> ${vehicleNo}</p>` : ''}
            <table style="width:100%; margin:20px 0; border-collapse: collapse;">
                <thead>
                    <tr style="background: #6366f1; color: white;">
                        <th style="padding: 8px;">Item</th>
                        <th>Qty</th>
                        <th>Price</th>
                        <th>Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${itemsHtml}
                </tbody>
            </table>
            <p><strong>Subtotal:</strong> ₹${total.toFixed(2)}</p>
            <p><strong>Paid:</strong> ₹${paid.toFixed(2)}</p>
            <p><strong>Balance:</strong> ₹${balance.toFixed(2)}</p>
            <p style="text-align: center; margin-top: 30px; color: #666;">Thank you for your business!</p>
        </div>
    `;

    document.getElementById('bill-preview-content').innerHTML = content;
    document.getElementById('bill-preview-modal').classList.add('active');
}

// ==================== PDF DOWNLOAD FUNCTION WITH VEHICLE ====================
function downloadBillPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    const customer = document.getElementById('bill-cust-name').value || 'Customer';
    const vehicleNo = document.getElementById('bill-vehicle-no').value || '';
    const date = new Date().toLocaleString();
    const billNo = 'BILL' + Date.now().toString().slice(-8);
    const total = parseFloat(document.getElementById('bill-total').textContent) || 0;
    const paid = parseFloat(document.getElementById('amount-paid').value) || 0;
    const balance = total - paid;

    // Add header
    doc.setFontSize(20);
    doc.setTextColor(99, 102, 241);
    doc.text('WORKSHOP PRO', 105, 20, { align: 'center' });

    doc.setFontSize(16);
    doc.setTextColor(0, 0, 0);
    doc.text('INVOICE', 105, 30, { align: 'center' });

    // Add bill details
    doc.setFontSize(10);
    doc.text(`Bill No: ${billNo}`, 20, 40);
    doc.text(`Date: ${date}`, 20, 45);
    doc.text(`Customer: ${customer}`, 20, 50);
    if (vehicleNo) {
        doc.text(`Vehicle No: ${vehicleNo}`, 20, 55);
    }

    // Add table
    const startY = vehicleNo ? 65 : 60;
    const tableColumn = ["Item", "Qty", "Price", "Total"];
    const tableRows = [];

    currentBillItems.forEach(item => {
        const itemData = [
            item.desc,
            item.qty.toString(),
            '₹' + item.price.toFixed(2),
            '₹' + item.total.toFixed(2)
        ];
        tableRows.push(itemData);
    });

    doc.autoTable({
        head: [tableColumn],
        body: tableRows,
        startY: startY,
        theme: 'striped',
        headStyles: { fillColor: [99, 102, 241] }
    });

    // Add totals
    const finalY = doc.lastAutoTable.finalY + 10;
    doc.text(`Subtotal: ₹${total.toFixed(2)}`, 150, finalY);
    doc.text(`Paid: ₹${paid.toFixed(2)}`, 150, finalY + 5);
    doc.text(`Balance: ₹${balance.toFixed(2)}`, 150, finalY + 10);

    // Add footer
    doc.setFontSize(10);
    doc.setTextColor(128, 128, 128);
    doc.text('Thank you for your business!', 105, finalY + 20, { align: 'center' });

    // Save PDF
    doc.save(`invoice_${billNo}.pdf`);
    showToast('PDF downloaded', 'success');
}

function clearBill() {
    currentBillItems = [];
    document.getElementById('current-items-section').style.display = 'none';
    document.getElementById('bill-cust-name').value = '';
    document.getElementById('bill-vehicle-no').value = '';
    document.getElementById('bill-discount').value = '0';
    document.getElementById('amount-paid').value = '';
    document.getElementById('balance-due').textContent = '';
    document.getElementById('bill-total').textContent = '0';
    document.getElementById('bill-subtotal').textContent = '0';
}

// ==================== CUSTOMER FUNCTIONS WITH VEHICLE ====================
async function loadCustomers() {
    const result = await db.allDocs({ include_docs: true });
    return result.rows.map(r => r.doc).filter(d => d && d.type === 'customer');
}

function showAddCustomerModal() {
    document.getElementById('customer-modal').classList.add('active');
}

function closeCustomerModal() {
    document.getElementById('customer-modal').classList.remove('active');
}

async function saveCustomer() {
    const name = document.getElementById('cust-name')?.value.trim();
    const vehicle = document.getElementById('cust-vehicle')?.value.trim().toUpperCase();

    if (!name) return showToast('Name required', 'error');

    try {
        await db.put({
            _id: 'cust_' + Date.now(),
            type: 'customer',
            name: name,
            vehicleNo: vehicle || '',
            phone: document.getElementById('cust-phone')?.value || '',
            email: document.getElementById('cust-email')?.value || '',
            address: document.getElementById('cust-address')?.value || '',
            gst: document.getElementById('cust-gst')?.value || '',
            balance: 0,
            createdAt: new Date().toISOString()
        });

        closeCustomerModal();
        document.getElementById('cust-name').value = '';
        document.getElementById('cust-vehicle').value = '';
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
    const search = document.getElementById('customer-search')?.value.toLowerCase() || '';

    const filtered = customers.filter(c =>
        c.name.toLowerCase().includes(search) ||
        (c.vehicleNo && c.vehicleNo.toLowerCase().includes(search))
    );

    const container = document.getElementById('customers-list');
    if (!container) return;

    container.innerHTML = '';
    if (filtered.length === 0) {
        container.innerHTML = '<p style="text-align: center; opacity: 0.7;">No customers</p>';
    } else {
        filtered.forEach(c => {
            container.innerHTML += `
                <div class="customer-card">
                    <strong>${c.name}</strong>
                    ${c.vehicleNo ? `<div class="vehicle"><i class="fas fa-car"></i> ${c.vehicleNo}</div>` : ''}
                    <div style="font-size:12px;">${c.phone || 'No phone'}</div>
                    <div style="color:${c.balance > 0 ? '#ef4444' : '#10b981'};">
                        Balance: ₹${(c.balance || 0).toFixed(2)}
                    </div>
                </div>
            `;
        });
    }
}

// ==================== LEDGER FUNCTIONS WITH APPLY BUTTON ====================
let currentLedgerFilters = {
    customerSearch: '',
    vehicleSearch: '',
    filterType: 'all',
    fromDate: '',
    toDate: '',
    sort: 'newest'
};

function applyLedgerFilters() {
    currentLedgerFilters.customerSearch = document.getElementById('ledger-customer-search')?.value || '';
    currentLedgerFilters.vehicleSearch = document.getElementById('ledger-vehicle-search')?.value || '';
    currentLedgerFilters.filterType = document.getElementById('ledger-filter-type')?.value || 'all';
    currentLedgerFilters.fromDate = document.getElementById('ledger-date-from')?.value || '';
    currentLedgerFilters.toDate = document.getElementById('ledger-date-to')?.value || '';
    currentLedgerFilters.sort = document.getElementById('ledger-sort')?.value || 'newest';
    updateLedgerUI();
}

function resetLedgerFilters() {
    document.getElementById('ledger-customer-search').value = '';
    document.getElementById('ledger-vehicle-search').value = '';
    document.getElementById('ledger-date-from').value = '';
    document.getElementById('ledger-date-to').value = '';
    document.getElementById('ledger-filter-type').value = 'all';
    document.getElementById('ledger-sort').value = 'newest';

    currentLedgerFilters = {
        customerSearch: '',
        vehicleSearch: '',
        filterType: 'all',
        fromDate: '',
        toDate: '',
        sort: 'newest'
    };
    updateLedgerUI();
}

function filterTransactionsByDate(transactions, filterType, fromDate, toDate) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    return transactions.filter(t => {
        const tDate = new Date(t.date);

        switch (filterType) {
            case 'today': return tDate >= today;
            case 'week': {
                const weekAgo = new Date(today);
                weekAgo.setDate(weekAgo.getDate() - 7);
                return tDate >= weekAgo;
            }
            case 'month': {
                const monthAgo = new Date(today);
                monthAgo.setMonth(monthAgo.getMonth() - 1);
                return tDate >= monthAgo;
            }
            case 'custom':
                if (fromDate && toDate) {
                    const from = new Date(fromDate);
                    const to = new Date(toDate);
                    to.setHours(23, 59, 59, 999);
                    return tDate >= from && tDate <= to;
                }
                return true;
            default: return true;
        }
    });
}

async function updateLedgerUI() {
    try {
        console.log('Updating ledger UI...');
        const result = await db.allDocs({ include_docs: true });
        let transactions = result.rows
            .map(r => r.doc)
            .filter(d => d && d.type === 'ledger');

        // Apply filters
        if (currentLedgerFilters.customerSearch) {
            transactions = transactions.filter(t =>
                t.customer.toLowerCase().includes(currentLedgerFilters.customerSearch.toLowerCase())
            );
        }

        if (currentLedgerFilters.vehicleSearch) {
            transactions = transactions.filter(t =>
                t.vehicleNo && t.vehicleNo.toLowerCase().includes(currentLedgerFilters.vehicleSearch.toLowerCase())
            );
        }

        transactions = filterTransactionsByDate(transactions, currentLedgerFilters.filterType, currentLedgerFilters.fromDate, currentLedgerFilters.toDate);

        // Calculate totals
        let totalSales = 0, creditDue = 0;
        const balances = {};

        transactions.forEach(t => {
            totalSales += t.total || 0;
            if (t.balance > 0) {
                creditDue += t.balance;
                balances[t.customer] = (balances[t.customer] || 0) + t.balance;
            }
        });

        // Sort
        switch (currentLedgerFilters.sort) {
            case 'newest': transactions.sort((a, b) => new Date(b.date) - new Date(a.date)); break;
            case 'oldest': transactions.sort((a, b) => new Date(a.date) - new Date(b.date)); break;
            case 'highest': transactions.sort((a, b) => (b.total || 0) - (a.total || 0)); break;
            case 'lowest': transactions.sort((a, b) => (a.total || 0) - (b.total || 0)); break;
        }

        // Update UI
        document.getElementById('ledger-filtered-total').textContent = '₹' + totalSales.toFixed(2);
        document.getElementById('ledger-filtered-count').textContent = transactions.length;
        document.getElementById('credit-due').textContent = '₹' + creditDue.toFixed(2);

        // Show balances (who owes money)
        const balancesDiv = document.getElementById('customer-balances-list');
        if (balancesDiv) {
            balancesDiv.innerHTML = '';
            if (Object.keys(balances).length === 0) {
                balancesDiv.innerHTML = '<p style="text-align: center;">No pending balances</p>';
            } else {
                // Sort by amount due (highest first)
                const sortedBalances = Object.entries(balances).sort((a, b) => b[1] - a[1]);
                sortedBalances.forEach(([cust, amt]) => {
                    balancesDiv.innerHTML += `
                        <div class="balance-item">
                            <strong>${cust}</strong>
                            <span style="color:#ef4444;">₹${amt.toFixed(2)}</span>
                        </div>
                    `;
                });
            }
        }

        // Show transactions with items and vehicle
        const historyDiv = document.getElementById('bill-history-list');
        if (historyDiv) {
            historyDiv.innerHTML = '';
            if (transactions.length === 0) {
                historyDiv.innerHTML = '<p style="text-align: center;">No transactions</p>';
            } else {
                transactions.slice(0, 50).forEach(t => {
                    // Create items list
                    let itemsList = '';
                    if (t.items && t.items.length > 0) {
                        itemsList = '<div class="items-list">';
                        t.items.slice(0, 3).forEach(item => {
                            itemsList += `<span>${item.qty}x ${item.desc}</span> `;
                        });
                        if (t.items.length > 3) itemsList += `...`;
                        itemsList += '</div>';
                    }

                    historyDiv.innerHTML += `
                        <div class="ledger-card">
                            <div style="display:flex; justify-content:space-between;">
                                <strong>${t.customer}</strong> 
                                <span>₹${(t.total || 0).toFixed(2)}</span>
                            </div>
                            ${t.vehicleNo ? `<div class="vehicle"><i class="fas fa-car"></i> ${t.vehicleNo}</div>` : ''}
                            <div style="font-size:11px;">${new Date(t.date).toLocaleString()} | ${t.paymentMethod || 'Cash'}</div>
                            ${itemsList}
                            ${t.balance > 0 ? `<div style="color:#ef4444; font-size:12px; margin-top:5px;">Due: ₹${t.balance.toFixed(2)}</div>` : ''}
                        </div>
                    `;
                });
            }
        }
    } catch (error) {
        console.error('Ledger error:', error);
    }
}

// ==================== SCANNER ====================
async function toggleScanner(type) {
    const readerId = type === 'inventory' ? 'reader' : 'bill-reader';

    // Stop any existing scanner
    await stopScanner();

    document.getElementById(`scanner-overlay-${type}`).style.display = 'block';
    document.getElementById(`flash-${type}`).style.display = 'flex';

    html5QrCode = new Html5Qrcode(readerId);
    try {
        await html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 },
            (text) => {
                playBeepAndVibrate();
                handleScanResult(text, type);
            },
            (error) => console.log(error)
        );
    } catch (error) {
        showToast('Camera access denied', 'error');
        document.getElementById(`scanner-overlay-${type}`).style.display = 'none';
        document.getElementById(`flash-${type}`).style.display = 'none';
    }
}

async function scanFile(input, type) {
    if (!input?.files?.length) return;

    // Stop any existing scanner
    await stopScanner();

    const scanner = new Html5Qrcode('reader');
    try {
        showToast('Processing image...', 'info');
        const result = await scanner.scanFile(input.files[0], true);
        playBeepAndVibrate();
        handleScanResult(result, type);

        // Clear the file input to prevent reusing the same image
        input.value = '';
    } catch {
        showToast('Could not read barcode', 'error');
        // Clear the file input even on error
        input.value = '';
    }
}

async function handleScanResult(text, type) {
    const idField = type === 'inventory' ? 'part-id' : 'bill-item-id';
    document.getElementById(idField).value = text;

    try {
        const doc = await db.get(text);
        if (doc?.type === 'inventory') {
            if (type === 'inventory') {
                document.getElementById('part-name').value = doc.name || '';
                document.getElementById('part-price').value = doc.price || '';
                const cat = document.getElementById('part-category');
                if (cat) cat.value = doc.category || 'general';
            } else {
                document.getElementById('bill-desc').value = doc.name || '';
                document.getElementById('bill-price').value = doc.price || '';
            }
            showToast('Item Found', 'success');
        }
    } catch (e) {
        showToast('New Item', 'info');
    }

    // Stop scanner after successful scan
    await stopScanner();
}

// ==================== GOOGLE DRIVE SYNC ====================
function handleSync() {
    if (!navigator.onLine) return showToast('No internet', 'error');
    const now = new Date().getTime();
    if (!accessToken || (tokenExpiry && now > parseInt(tokenExpiry))) {
        const redirectUri = window.location.origin + window.location.pathname;
        const cleanUri = redirectUri.split('#')[0];
        window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(cleanUri)}&response_type=token&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.file')}&prompt=consent`;
    } else {
        uploadToDrive();
    }
}

async function uploadToDrive() {
    if (!accessToken) return;
    const syncStatusText = document.getElementById('sync-status-text');
    const syncIcon = document.querySelector('#sync-status i');

    if (syncIcon) syncIcon.className = 'fas fa-sync fa-spin';
    if (syncStatusText) syncStatusText.textContent = 'Syncing...';

    try {
        // GET LOCAL DATA
        const localResult = await db.allDocs({ include_docs: true });
        const localData = localResult.rows.map(r => r.doc);
        console.log('Local data count:', localData.length);

        // DOWNLOAD FROM DRIVE
        let cloudData = [];
        let fileId = null;

        const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='${BACKUP_FILE_NAME}' and trashed=false`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (searchRes.status === 401) {
            localStorage.removeItem('google_token');
            localStorage.removeItem('token_expiry');
            accessToken = null;
            showToast('Session expired', 'warning');
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
                const backup = await downloadRes.json();
                cloudData = backup.data || [];
                console.log('Cloud data count:', cloudData.length);
            }
        }

        // MERGE DATA (KEEP NEWEST)
        const mergedMap = new Map();

        cloudData.forEach(doc => mergedMap.set(doc._id, doc));

        let newCount = 0, updatedCount = 0;

        for (const localDoc of localData) {
            const cloudDoc = mergedMap.get(localDoc._id);

            if (!cloudDoc) {
                mergedMap.set(localDoc._id, localDoc);
                newCount++;
            } else {
                const localTime = new Date(localDoc.updatedAt || 0).getTime();
                const cloudTime = new Date(cloudDoc.updatedAt || 0).getTime();

                if (localTime >= cloudTime) {
                    mergedMap.set(localDoc._id, localDoc);
                    updatedCount++;
                }
            }
        }

        const mergedData = Array.from(mergedMap.values());

        // UPDATE LOCAL DATABASE
        let localImported = 0, localUpdated = 0;

        for (const doc of mergedData) {
            try {
                const existing = await db.get(doc._id).catch(() => null);
                if (existing) {
                    const existingTime = new Date(existing.updatedAt || 0).getTime();
                    const newTime = new Date(doc.updatedAt || 0).getTime();

                    if (newTime > existingTime) {
                        doc._rev = existing._rev;
                        await db.put(doc);
                        localUpdated++;
                    }
                } else {
                    if (doc._rev) delete doc._rev;
                    await db.put(doc);
                    localImported++;
                }
            } catch (e) {
                console.error('Merge error for doc', doc._id, e);
            }
        }

        // UPLOAD TO DRIVE
        const payload = {
            timestamp: new Date().toISOString(),
            version: '1.0',
            data: mergedData
        };

        const metadata = { name: BACKUP_FILE_NAME, mimeType: 'application/json' };
        const boundary = 'foo_bar_baz';
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n--${boundary}--`;

        const url = fileId ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart` : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
        const res = await fetch(url, {
            method: fileId ? 'PATCH' : 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
            body
        });

        if (res.ok) {
            const time = new Date().toLocaleTimeString();
            if (syncIcon) {
                syncIcon.className = 'fas fa-check-circle';
                syncIcon.style.color = '#10b981';
            }
            if (syncStatusText) syncStatusText.textContent = `Synced at ${time}`;

            showToast(`Sync complete: ${localImported} new, ${localUpdated} updated`, 'success');

            localStorage.removeItem('pendingSync');

            // Refresh UI
            await updateDashboard();
            await updateInventoryUI();
            await updateLedgerUI();
            await updateCustomersUI();
        }
    } catch (e) {
        console.error('Sync error:', e);
        showToast('Sync Failed: ' + e.message, 'error');
        if (syncStatusText) syncStatusText.textContent = 'Sync failed';
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
        const result = await db.allDocs({ include_docs: true });
        const items = result.rows.map(r => r.doc).filter(d => d?.type === 'inventory');
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
        const result = await db.allDocs({ include_docs: true });
        let transactions = result.rows.map(r => r.doc).filter(d => d?.type === 'ledger');

        let csv = 'Date,Customer,Vehicle No,Total,Paid,Balance,Payment Method\n';
        transactions.forEach(t => {
            csv += `"${new Date(t.date).toLocaleString()}","${t.customer}","${t.vehicleNo || ''}",${t.total || 0},${t.paid || 0},${t.balance || 0},"${t.paymentMethod || 'Cash'}"\n`;
        });

        downloadFile(csv, 'ledger_export.csv', 'text/csv');
        showToast('Ledger exported', 'success');
    } catch (error) {
        showToast('Export failed', 'error');
    }
}

// ==================== INITIALIZATION ====================
window.onload = async () => {
    console.log('App initializing...');

    if (window.location.hash) {
        const params = new URLSearchParams(window.location.hash.substring(1));
        const token = params.get('access_token');
        if (token) {
            accessToken = token;
            localStorage.setItem('google_token', token);
            localStorage.setItem('token_expiry', (new Date().getTime() + 3600000).toString());
            window.history.replaceState(null, null, window.location.pathname);
            showToast('Connected to Google Drive', 'success');

            setTimeout(async () => {
                await uploadToDrive();
            }, 1500);
        }
    }

    // Load all data
    console.log('Loading initial data...');
    await updateDashboard();
    await updateInventoryUI();
    await updateLedgerUI();
    await updateCustomersUI();

    updateNetworkStatus();

    // Periodic sync check
    setInterval(() => {
        if (navigator.onLine && accessToken && localStorage.getItem('pendingSync') === 'true') {
            autoSync();
        }
    }, 1800000);

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => { });
    }

    history.pushState(null, null, location.href);
};