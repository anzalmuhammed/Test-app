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

window.addEventListener('popstate', function(event) {
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
        if(syncStatus) syncStatus.classList.add('online');
        if(syncStatus) syncStatus.classList.remove('offline');
        if (syncIcon) syncIcon.style.color = '#10b981';
        if (syncText) syncText.textContent = accessToken ? 'Online - Ready to sync' : 'Online';
        
        if (accessToken && localStorage.getItem('wasOffline') === 'true') {
            autoSync();
            localStorage.removeItem('wasOffline');
        }
    } else {
        if(syncStatus) syncStatus.classList.add('offline');
        if(syncStatus) syncStatus.classList.remove('online');
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
    let icon = type === 'success' ? 'check-circle' : (type === 'error' ? 'exclamation-circle' : 'exclamation-triangle');
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

// ==================== NAVIGATION ====================
function goToDashboard() {
    showScreen('dashboard-screen');
}

async function showScreen(screenId) {
    if (html5QrCode) { 
        await html5QrCode.stop().catch(() => {}); 
        html5QrCode = null;
        ['inventory', 'bill'].forEach(t => {
            const overlay = document.getElementById(`scanner-overlay-${t}`);
            const flash = document.getElementById(`flash-${t}`);
            if (overlay) overlay.style.display = 'none';
            if (flash) flash.style.display = 'none';
        });
        torchEnabled = false;
    }
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(screenId);
    if(target) target.classList.add('active');
    
    updateFABVisibility(screenId);
    
    // Refresh data based on screen
    if (screenId === 'stock-list-screen') await updateInventoryUI();
    if (screenId === 'ledger-screen') await updateLedgerUI();
    if (screenId === 'customers-screen') await updateCustomersUI();
    if (screenId === 'dashboard-screen') await updateDashboard();
    if (screenId === 'quick-bill-screen') {
        document.getElementById('bill-cust-name').value = '';
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
        const allDocs = await db.allDocs({ include_docs: true });
        console.log('Total documents:', allDocs.rows.length);
        
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
                recentTransactions.sort((a,b) => new Date(b.date) - new Date(a.date))
                    .slice(0,5).forEach(t => {
                        recentDiv.innerHTML += `
                            <div style="padding: 8px; border-bottom: 1px solid var(--glass-border);">
                                <div style="display: flex; justify-content: space-between;">
                                    <span>${t.customer || 'Customer'}</span>
                                    <span>₹${(t.total || 0).toFixed(2)}</span>
                                </div>
                                <div style="font-size: 10px; opacity:0.6;">${new Date(t.date).toLocaleString()}</div>
                            </div>`;
                    });
            }
        }
    } catch (e) { console.error('Dashboard error', e); }
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
    } catch (error) { showToast('Save failed', 'error'); }
}

async function updateInventoryUI() {
    try {
        console.log('Updating inventory UI...');
        const result = await db.allDocs({ include_docs: true });
        const items = result.rows.map(r => r.doc).filter(d => d && d.type === 'inventory');
        console.log('Inventory items found:', items.length);
        
        const tbody = document.getElementById('inventory-list-table');
        if (!tbody) return;
        
        tbody.innerHTML = '';
        if (items.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center;">No items</td></tr>';
        } else {
            items.sort((a,b) => a.name.localeCompare(b.name)).forEach(item => {
                const available = (item.totalIn || 0) - (item.totalSold || 0);
                tbody.innerHTML += `
                    <tr>
                        <td>${item.name}</td>
                        <td>${item.totalIn || 0}</td>
                        <td>${item.totalSold || 0}</td>
                        <td style="color:${available < (item.minStock || 5) ? '#ef4444' : 'inherit'}">${available}</td>
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

// ==================== BILLING ====================
function addItemToCurrentBill() {
    const desc = document.getElementById('bill-desc')?.value.trim();
    const price = parseFloat(document.getElementById('bill-price')?.value) || 0;
    const qty = parseInt(document.getElementById('bill-qty')?.value) || 1;
    const itemId = document.getElementById('bill-item-id')?.value.trim();
    
    if (!desc) return showToast('Enter item description', 'error');
    
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
                <td><input type="number" value="${item.price}" step="0.01" min="0" style="width:70px; padding:3px;" onchange="updateBillItemPrice(${index}, this.value)"></td>
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
        return showToast('Enter customer name and items', 'error');
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
        
        // Update inventory stock
        for (const item of currentBillItems) {
            if (item.itemId) {
                try {
                    const doc = await db.get(item.itemId);
                    if (doc && doc.type === 'inventory') {
                        doc.totalSold = (doc.totalSold || 0) + item.qty;
                        await db.put(doc);
                        continue;
                    }
                } catch (e) {}
            }
            
            // Search by name
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
        showToast('Bill saved!', 'success');
        await updateDashboard();
        await updateInventoryUI();
        await autoSync();
    } catch (error) {
        showToast('Error saving bill', 'error');
    }
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
    if (!name) return showToast('Name required', 'error');
    
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
    if (!container) return;
    
    container.innerHTML = '';
    if (filtered.length === 0) {
        container.innerHTML = '<p style="text-align: center; opacity: 0.7;">No customers</p>';
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

// ==================== LEDGER FUNCTIONS ====================
function filterTransactionsByDate(transactions, filterType, fromDate, toDate) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    return transactions.filter(t => {
        const tDate = new Date(t.date);
        
        switch(filterType) {
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
        
        console.log('Ledger transactions found:', transactions.length);
        
        // Apply filters
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
        const sortType = document.getElementById('ledger-sort')?.value || 'newest';
        switch(sortType) {
            case 'newest': transactions.sort((a,b) => new Date(b.date) - new Date(a.date)); break;
            case 'oldest': transactions.sort((a,b) => new Date(a.date) - new Date(b.date)); break;
            case 'highest': transactions.sort((a,b) => (b.total || 0) - (a.total || 0)); break;
            case 'lowest': transactions.sort((a,b) => (a.total || 0) - (b.total || 0)); break;
        }
        
        // Update UI
        document.getElementById('ledger-filtered-total').textContent = '₹' + totalSales.toFixed(2);
        document.getElementById('ledger-filtered-count').textContent = transactions.length;
        document.getElementById('credit-due').textContent = '₹' + creditDue.toFixed(2);
        
        // Show balances
        const balancesDiv = document.getElementById('customer-balances-list');
        if (balancesDiv) {
            balancesDiv.innerHTML = '';
            if (Object.keys(balances).length === 0) {
                balancesDiv.innerHTML = '<p style="text-align: center;">No pending balances</p>';
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
        
        // Show transactions
        const historyDiv = document.getElementById('bill-history-list');
        if (historyDiv) {
            historyDiv.innerHTML = '';
            if (transactions.length === 0) {
                historyDiv.innerHTML = '<p style="text-align: center;">No transactions</p>';
            } else {
                transactions.slice(0, 50).forEach(t => {
                    historyDiv.innerHTML += `
                        <div class="ledger-card">
                            <div style="display:flex; justify-content:space-between;">
                                <strong>${t.customer}</strong> <span>₹${(t.total || 0).toFixed(2)}</span>
                            </div>
                            <div style="font-size:11px;">${new Date(t.date).toLocaleString()} | ${t.paymentMethod || 'Cash'}</div>
                            ${t.balance > 0 ? `<div style="color:#ef4444;">Due: ₹${t.balance.toFixed(2)}</div>` : ''}
                        </div>
                    `;
                });
            }
        }
    } catch (error) {
        console.error('Ledger error:', error);
    }
}

function resetLedgerFilters() {
    document.getElementById('ledger-customer-search').value = '';
    document.getElementById('ledger-date-from').value = '';
    document.getElementById('ledger-date-to').value = '';
    document.getElementById('ledger-filter-type').value = 'all';
    document.getElementById('ledger-sort').value = 'newest';
    updateLedgerUI();
}

// ==================== SCANNER ====================
async function toggleScanner(type) {
    const readerId = type === 'inventory' ? 'reader' : 'bill-reader';
    if (html5QrCode) { await html5QrCode.stop(); html5QrCode = null; }
    
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
    const scanner = new Html5Qrcode('reader');
    try {
        const result = await scanner.scanFile(input.files[0], true);
        playBeepAndVibrate();
        handleScanResult(result, type);
    } catch {
        showToast('Could not read barcode', 'error');
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
    } catch(e) { 
        showToast('New Item', 'info'); 
    }
    
    if (html5QrCode) {
        await html5QrCode.stop();
        html5QrCode = null;
        document.getElementById(`scanner-overlay-${type}`).style.display = 'none';
        document.getElementById(`flash-${type}`).style.display = 'none';
    }
}

// ==================== FIXED GOOGLE DRIVE SYNC (WITH UI REFRESH) ====================
function handleSync() {
    if (!navigator.onLine) return showToast('No internet', 'error');
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
    const syncStatusText = document.getElementById('sync-status-text');
    const syncIcon = document.querySelector('#sync-status i');
    
    if (syncIcon) syncIcon.className = 'fas fa-sync fa-spin';
    if (syncStatusText) syncStatusText.textContent = 'Syncing...';
    
    try {
        // 1. Download Existing Cloud Data
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

        // 2. Get Local Data
        const localResult = await db.allDocs({ include_docs: true });
        const localData = localResult.rows.map(r => r.doc);
        console.log('Local data count:', localData.length);

        // 3. Merge Logic (Newest Timestamp wins)
        const mergedMap = new Map();
        
        // Add cloud data first
        cloudData.forEach(d => mergedMap.set(d._id, d));
        
        // Add/update with local data (local wins if newer)
        localData.forEach(ld => {
            const cd = mergedMap.get(ld._id);
            if (!cd) {
                mergedMap.set(ld._id, ld);
            } else {
                const localTime = new Date(ld.updatedAt || 0).getTime();
                const cloudTime = new Date(cd.updatedAt || 0).getTime();
                if (localTime >= cloudTime) {
                    mergedMap.set(ld._id, ld);
                }
            }
        });

        const finalData = Array.from(mergedMap.values());
        console.log('Merged data count:', finalData.length);

        // 4. Update Local Database with merged data
        let imported = 0, updated = 0;
        for (const doc of finalData) {
            try {
                const existing = await db.get(doc._id).catch(() => null);
                if (existing) {
                    // Compare timestamps to decide if we need to update
                    const existingTime = new Date(existing.updatedAt || 0).getTime();
                    const newTime = new Date(doc.updatedAt || 0).getTime();
                    
                    if (newTime > existingTime) {
                        doc._rev = existing._rev;
                        await db.put(doc);
                        updated++;
                    }
                } else {
                    // Remove revision for new docs
                    if (doc._rev) delete doc._rev;
                    await db.put(doc);
                    imported++;
                }
            } catch (e) { 
                console.error('Merge error for doc', doc._id, e); 
            }
        }

        // 5. Upload Merged Data back to Drive
        const backupPayload = { 
            timestamp: new Date().toISOString(), 
            version: '1.0',
            data: finalData 
        };
        
        const metadata = { name: BACKUP_FILE_NAME, mimeType: 'application/json' };
        const boundary = 'foo_bar_baz';
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(backupPayload)}\r\n--${boundary}--`;

        const url = fileId 
            ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart` 
            : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
            
        const res = await fetch(url, {
            method: fileId ? 'PATCH' : 'POST',
            headers: { 
                'Authorization': `Bearer ${accessToken}`, 
                'Content-Type': `multipart/related; boundary=${boundary}` 
            },
            body: body
        });

        if (res.ok) {
            const time = new Date().toLocaleTimeString();
            if (syncIcon) {
                syncIcon.className = 'fas fa-check-circle';
                syncIcon.style.color = '#10b981';
            }
            if (syncStatusText) syncStatusText.textContent = `Synced at ${time}`;
            
            showToast(`Sync complete: ${imported} new, ${updated} updated`, 'success');
            
            // CRITICAL: Refresh ALL UI components after sync
            console.log('Refreshing all UI components after sync...');
            
            // Force a small delay to ensure database writes are complete
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Refresh all UI components
            await updateDashboard();
            await updateInventoryUI();
            await updateLedgerUI();
            await updateCustomersUI();
            
            // Also update the current screen if it's not dashboard
            const activeScreen = document.querySelector('.screen.active')?.id;
            if (activeScreen === 'stock-list-screen') {
                await updateInventoryUI();
            } else if (activeScreen === 'ledger-screen') {
                await updateLedgerUI();
            } else if (activeScreen === 'customers-screen') {
                await updateCustomersUI();
            } else if (activeScreen === 'dashboard-screen') {
                await updateDashboard();
            }
            
            console.log('UI refresh complete');
            
            localStorage.removeItem('pendingSync');
        } else {
            throw new Error('Upload failed');
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
            
            // Download from Drive and update UI
            setTimeout(async () => {
                await uploadToDrive();
            }, 1500);
        }
    }
    
    // Load all data initially
    console.log('Loading initial data...');
    await updateDashboard();
    await updateInventoryUI();
    await updateLedgerUI();
    await updateCustomersUI();
    
    updateNetworkStatus();
    
    // Set up periodic sync check (every 30 minutes)
    setInterval(() => {
        if (navigator.onLine && accessToken && localStorage.getItem('pendingSync') === 'true') {
            autoSync();
        }
    }, 1800000);
    
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    
    // Push initial state for back button
    history.pushState(null, null, location.href);
};