// ==================== DATABASE INITIALIZATION ====================
const db = new PouchDB('workshop_super_db');
const CLOUD_BACKUP_FILE = 'workshop_super_backup.json';

// Google Drive Configuration
const CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID_HERE'; // Get from Google Cloud Console
let accessToken = localStorage.getItem('google_token');

// Global Variables
let html5QrCode = null;
let currentBillItems = [];
let currentBillCustomer = null;
let customers = [];
let inventoryItems = [];
let salesChart = null;
let lowStockThreshold = 5;

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', async () => {
    await initApp();
    setupEventListeners();
    updateDateTime();
    setInterval(updateDateTime, 1000);
    loadSettings();
});

async function initApp() {
    await loadCustomers();
    await loadInventory();
    updateDashboard();
    updateInventoryUI();
    updateLedgerUI();
    updateCustomersUI();
    generateBillNumber();
    updateDateFields();
    initChart();
}

function setupEventListeners() {
    // Handle OAuth redirect
    if (window.location.hash) {
        const params = new URLSearchParams(window.location.hash.substring(1));
        const token = params.get('access_token');
        if (token) {
            accessToken = token;
            localStorage.setItem('google_token', token);
            window.history.replaceState(null, null, window.location.pathname);
            showToast('Google Drive connected!', 'success');
        }
    }

    // Auto backup every hour if enabled
    setInterval(() => {
        if (localStorage.getItem('auto_backup') === 'true') {
            handleSync();
        }
    }, 3600000);
}

// ==================== NAVIGATION FUNCTIONS ====================
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
    document.getElementById(screenId).classList.add('active');

    // Refresh data based on screen
    switch (screenId) {
        case 'dashboard-screen':
            updateDashboard();
            break;
        case 'stock-list-screen':
            updateInventoryUI();
            break;
        case 'ledger-screen':
            updateLedgerUI();
            break;
        case 'customers-screen':
            updateCustomersUI();
            break;
        case 'quick-bill-screen':
            updateCustomerDropdown();
            break;
    }

    closeSideMenu();
}

function goHome() {
    showScreen('dashboard-screen');
    if (html5QrCode) {
        html5QrCode.stop().catch(() => { });
    }
}

function toggleSideMenu() {
    document.getElementById('side-menu').classList.toggle('active');
    document.getElementById('menu-overlay').classList.toggle('active');
}

function closeSideMenu() {
    document.getElementById('side-menu').classList.remove('active');
    document.getElementById('menu-overlay').classList.remove('active');
}

function showQuickActions() {
    document.getElementById('quick-actions-menu').classList.toggle('active');
}

// ==================== DASHBOARD FUNCTIONS ====================
async function updateDashboard() {
    // Update stats
    const allDocs = await db.allDocs({ include_docs: true });
    let totalItems = 0;
    let totalSales = 0;
    let totalCustomers = 0;
    let lowStock = 0;
    let recentTransactions = [];

    allDocs.rows.forEach(row => {
        const doc = row.doc;
        if (doc.type === 'inventory') {
            totalItems++;
            const available = (doc.totalIn || 0) - (doc.totalSold || 0);
            if (available < (doc.minStock || 5)) lowStock++;
        } else if (doc.type === 'ledger') {
            totalSales += doc.amount || doc.total || 0;
            recentTransactions.push(doc);
        } else if (doc.type === 'customer') {
            totalCustomers++;
        }
    });

    document.getElementById('stat-total-items').textContent = totalItems;
    document.getElementById('stat-total-sales').textContent = `₹${totalSales.toFixed(2)}`;
    document.getElementById('stat-total-customers').textContent = totalCustomers;
    document.getElementById('stat-low-stock').textContent = lowStock;

    // Update recent transactions
    const recentList = document.getElementById('recent-transactions');
    if (recentList) {
        recentList.innerHTML = '';

        recentTransactions.sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, 5).forEach(t => {
                recentList.innerHTML += `
                    <div class="activity-item" style="display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid var(--glass-border);">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <i class="fas fa-receipt" style="color: var(--primary);"></i>
                            <div>
                                <strong>${t.customer || 'Unknown'}</strong>
                                <div style="font-size: 12px; opacity: 0.7;">${new Date(t.date).toLocaleString()}</div>
                            </div>
                        </div>
                        <span style="font-weight: 600; color: var(--success);">₹${(t.amount || t.total || 0).toFixed(2)}</span>
                    </div>
                `;
            });
    }

    // Update chart
    updateSalesChart(recentTransactions);
}

function initChart() {
    const canvas = document.getElementById('salesChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    salesChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Sales (₹)',
                data: [],
                borderColor: '#6366f1',
                backgroundColor: 'rgba(99, 102, 241, 0.1)',
                tension: 0.4,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.1)' },
                    ticks: { color: 'white' }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: 'white' }
                }
            }
        }
    });
}

async function updateSalesChart(transactions) {
    if (!salesChart) return;

    const last7Days = [];
    const salesData = [];

    for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        last7Days.push(dateStr);

        const daySales = transactions.filter(t => {
            const tDate = new Date(t.date);
            return tDate.toDateString() === date.toDateString();
        }).reduce((sum, t) => sum + (t.amount || t.total || 0), 0);

        salesData.push(daySales);
    }

    salesChart.data.labels = last7Days;
    salesChart.data.datasets[0].data = salesData;
    salesChart.update();
}

// ==================== INVENTORY FUNCTIONS ====================
async function savePart() {
    const barcode = document.getElementById('part-id').value.trim();
    const name = document.getElementById('part-name').value.trim();
    const price = parseFloat(document.getElementById('part-price').value) || 0;
    const quantity = parseInt(document.getElementById('part-qty').value) || 1;
    const category = document.getElementById('part-category').value;
    const location = document.getElementById('part-location').value;
    const minStock = parseInt(document.getElementById('part-min-stock').value) || 5;

    if (!barcode || !name) {
        showToast('Please enter barcode and name', 'error');
        return;
    }

    try {
        let doc;
        try {
            doc = await db.get(barcode);
            doc.totalIn = (doc.totalIn || 0) + quantity;
        } catch (e) {
            doc = {
                _id: barcode,
                type: 'inventory',
                name: name,
                price: price,
                totalIn: quantity,
                totalSold: 0,
                category: category,
                location: location,
                minStock: minStock,
                createdAt: new Date().toISOString()
            };
        }

        doc.name = name;
        doc.price = price;
        doc.category = category;
        doc.location = location;
        doc.minStock = minStock;
        doc.updatedAt = new Date().toISOString();

        await db.put(doc);

        document.getElementById('inventory-form').reset();
        document.getElementById('part-qty').value = 1;

        showToast('Stock saved successfully!', 'success');
        await loadInventory();
        updateInventoryUI();
        handleSync();

    } catch (error) {
        console.error(error);
        showToast('Error saving stock', 'error');
    }
}

async function loadInventory() {
    const result = await db.allDocs({ include_docs: true });
    inventoryItems = result.rows
        .map(r => r.doc)
        .filter(d => d.type === 'inventory');
    return inventoryItems;
}

async function updateInventoryUI() {
    await loadInventory();
    const searchTerm = document.getElementById('stock-search')?.value.toLowerCase() || '';
    const filterType = document.getElementById('stock-filter')?.value || 'all';

    let filteredItems = inventoryItems.filter(item =>
        item.name.toLowerCase().includes(searchTerm) ||
        (item._id && item._id.includes(searchTerm))
    );

    // Apply filters
    if (filterType === 'low') {
        filteredItems = filteredItems.filter(item =>
            (item.totalIn - item.totalSold) < (item.minStock || 5)
        );
    } else if (filterType === 'out') {
        filteredItems = filteredItems.filter(item =>
            (item.totalIn - item.totalSold) <= 0
        );
    }

    // Update stats
    let totalValue = 0;
    let lowStockCount = 0;

    filteredItems.forEach(item => {
        const available = (item.totalIn || 0) - (item.totalSold || 0);
        totalValue += available * (item.price || 0);
        if (available < (item.minStock || 5)) lowStockCount++;
    });

    const totalValueEl = document.getElementById('total-value');
    const totalItemsEl = document.getElementById('total-items-count');
    const lowStockEl = document.getElementById('low-stock-count');

    if (totalValueEl) totalValueEl.textContent = `₹${totalValue.toFixed(2)}`;
    if (totalItemsEl) totalItemsEl.textContent = filteredItems.length;
    if (lowStockEl) lowStockEl.textContent = lowStockCount;

    // Render table
    const tbody = document.getElementById('inventory-list-table');
    if (!tbody) return;

    tbody.innerHTML = '';

    filteredItems.sort((a, b) => a.name.localeCompare(b.name)).forEach(item => {
        const available = (item.totalIn || 0) - (item.totalSold || 0);
        const status = available <= 0 ? 'Out of Stock' :
            available < (item.minStock || 5) ? 'Low Stock' : 'In Stock';
        const statusColor = available <= 0 ? '#ef4444' :
            available < (item.minStock || 5) ? '#f59e0b' : '#10b981';

        tbody.innerHTML += `
            <tr>
                <td>${item.name}</td>
                <td>₹${(item.price || 0).toFixed(2)}</td>
                <td>${item.totalIn || 0}</td>
                <td>${item.totalSold || 0}</td>
                <td><strong>${available}</strong></td>
                <td><span style="color: ${statusColor}">${status}</span></td>
                <td>
                    <button class="del-btn" onclick="deleteItem('${item._id}')">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            </tr>
        `;
    });
}

async function deleteItem(id) {
    if (!confirm('Are you sure you want to delete this item?')) return;

    try {
        const doc = await db.get(id);
        await db.remove(doc);
        showToast('Item deleted', 'success');
        updateInventoryUI();
        handleSync();
    } catch (error) {
        showToast('Error deleting item', 'error');
    }
}

// ==================== CUSTOMER FUNCTIONS ====================
async function loadCustomers() {
    const result = await db.allDocs({ include_docs: true });
    customers = result.rows
        .map(r => r.doc)
        .filter(d => d.type === 'customer');
    return customers;
}

async function saveCustomer() {
    const name = document.getElementById('cust-name').value.trim();
    const phone = document.getElementById('cust-phone').value.trim();
    const email = document.getElementById('cust-email').value.trim();
    const address = document.getElementById('cust-address').value.trim();
    const gst = document.getElementById('cust-gst').value.trim();

    if (!name) {
        showToast('Customer name is required', 'error');
        return;
    }

    const customer = {
        _id: 'customer_' + Date.now(),
        type: 'customer',
        name: name,
        phone: phone,
        email: email,
        address: address,
        gst: gst,
        balance: 0,
        createdAt: new Date().toISOString()
    };

    try {
        await db.put(customer);
        closeCustomerModal();
        document.getElementById('customer-form').reset();
        showToast('Customer saved successfully!', 'success');
        await loadCustomers();
        updateCustomersUI();
        updateCustomerDropdown();
        handleSync();
    } catch (error) {
        showToast('Error saving customer', 'error');
    }
}

function showAddCustomerModal() {
    document.getElementById('customer-modal').classList.add('active');
}

function closeCustomerModal() {
    document.getElementById('customer-modal').classList.remove('active');
}

async function updateCustomersUI() {
    await loadCustomers();
    const searchTerm = document.getElementById('customer-search')?.value.toLowerCase() || '';

    const filtered = customers.filter(c =>
        c.name.toLowerCase().includes(searchTerm) ||
        (c.phone && c.phone.includes(searchTerm))
    );

    const container = document.getElementById('customers-list');
    if (!container) return;

    container.innerHTML = '';

    filtered.forEach(customer => {
        container.innerHTML += `
            <div class="customer-card" onclick="viewCustomer('${customer._id}')">
                <h4>${customer.name}</h4>
                <p><i class="fas fa-phone"></i> ${customer.phone || 'N/A'}</p>
                <p><i class="fas fa-rupee-sign"></i> Balance: ₹${(customer.balance || 0).toFixed(2)}</p>
            </div>
        `;
    });
}

function viewCustomer(id) {
    // Implement customer detail view
    showToast('Customer details - Coming soon', 'info');
}

async function updateCustomerDropdown() {
    await loadCustomers();
    const select = document.getElementById('bill-customer');
    if (!select) return;

    select.innerHTML = '<option value="">Select customer</option>';

    customers.forEach(customer => {
        select.innerHTML += `<option value="${customer._id}">${customer.name}</option>`;
    });
}

function handleCustomerSelect() {
    const select = document.getElementById('bill-customer');
    const customerId = select.value;
    if (customerId) {
        const customer = customers.find(c => c._id === customerId);
        currentBillCustomer = customer;
    }
}

// ==================== BILLING FUNCTIONS ====================
function generateBillNumber() {
    const date = new Date();
    const billNo = `BILL-${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}-${Math.floor(Math.random() * 1000)}`;
    const billNumEl = document.getElementById('bill-number');
    if (billNumEl) billNumEl.value = billNo;
}

function updateDateFields() {
    const now = new Date();
    const dateEl = document.getElementById('bill-date');
    if (dateEl) dateEl.value = now.toLocaleString();
}

function addItemToCurrentBill() {
    const desc = document.getElementById('bill-desc').value.trim();
    const price = parseFloat(document.getElementById('bill-price').value) || 0;
    const qty = parseInt(document.getElementById('bill-qty').value) || 1;
    const itemId = document.getElementById('bill-item-id').value.trim();

    if (!desc) {
        showToast('Please enter item description', 'error');
        return;
    }

    currentBillItems.push({
        itemId: itemId,
        desc: desc,
        price: price,
        qty: qty,
        total: price * qty
    });

    // Clear inputs for next item
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
                <td>
                    <button class="del-btn" onclick="removeBillItem(${index})">
                        <i class="fas fa-times"></i>
                    </button>
                </td>
            </tr>
        `;
    });

    document.getElementById('bill-subtotal').textContent = subtotal.toFixed(2);
    document.getElementById('item-count').textContent = currentBillItems.length + ' items';
    document.getElementById('current-bill-section').style.display = 'block';

    updateBillTotal();
}

function removeBillItem(index) {
    currentBillItems.splice(index, 1);
    renderBillList();
}

function clearBill() {
    if (currentBillItems.length > 0 && confirm('Clear current bill?')) {
        currentBillItems = [];
        document.getElementById('current-bill-section').style.display = 'none';
        document.getElementById('bill-customer').value = '';
        document.getElementById('bill-discount').value = '0';
        document.getElementById('amount-paid').value = '';
        currentBillCustomer = null;
        generateBillNumber();
    }
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

    const balanceElement = document.getElementById('balance-due');
    if (balanceElement) {
        if (balance > 0) {
            balanceElement.textContent = `Balance Due: ₹${balance.toFixed(2)}`;
            balanceElement.style.color = '#ef4444';
        } else if (balance < 0) {
            balanceElement.textContent = `Change: ₹${Math.abs(balance).toFixed(2)}`;
            balanceElement.style.color = '#10b981';
        } else {
            balanceElement.textContent = 'Balance: ₹0.00';
            balanceElement.style.color = 'white';
        }
    }
}

async function finalizeBill() {
    const customerId = document.getElementById('bill-customer').value;
    const customerSelect = document.getElementById('bill-customer').selectedOptions[0];
    const customerName = customerSelect ? customerSelect.text : 'Unknown';
    const paymentMethod = document.getElementById('payment-method').value;
    const amountPaid = parseFloat(document.getElementById('amount-paid').value) || 0;
    const discount = parseFloat(document.getElementById('bill-discount').value) || 0;
    const subtotal = parseFloat(document.getElementById('bill-subtotal').textContent) || 0;
    const total = parseFloat(document.getElementById('bill-total').textContent) || 0;
    const balance = total - amountPaid;

    if (!customerId) {
        showToast('Please select a customer', 'error');
        return;
    }

    if (currentBillItems.length === 0) {
        showToast('No items in bill', 'error');
        return;
    }

    try {
        // Create ledger entry
        const ledgerEntry = {
            _id: 'ledger_' + Date.now(),
            type: 'ledger',
            customer: customerName,
            customerId: customerId,
            items: currentBillItems,
            subtotal: subtotal,
            discount: discount,
            total: total,
            amount: total,
            paid: amountPaid,
            balance: balance,
            paymentMethod: paymentMethod,
            billNumber: document.getElementById('bill-number').value,
            date: new Date().toISOString()
        };

        await db.put(ledgerEntry);

        // Update inventory
        for (const item of currentBillItems) {
            try {
                // Try to find by barcode first
                if (item.itemId) {
                    try {
                        const doc = await db.get(item.itemId);
                        if (doc.type === 'inventory') {
                            doc.totalSold = (doc.totalSold || 0) + item.qty;
                            await db.put(doc);
                            continue;
                        }
                    } catch (e) {
                        // Not found by barcode, try by name
                    }
                }

                // Search by name
                const result = await db.allDocs({ include_docs: true });
                for (const row of result.rows) {
                    if (row.doc.type === 'inventory' && row.doc.name === item.desc) {
                        row.doc.totalSold = (row.doc.totalSold || 0) + item.qty;
                        await db.put(row.doc);
                        break;
                    }
                }
            } catch (e) {
                console.log('Error updating inventory for item:', item.desc);
            }
        }

        // Update customer balance if credit
        if (paymentMethod === 'credit' || balance > 0) {
            try {
                const customer = await db.get(customerId);
                customer.balance = (customer.balance || 0) + balance;
                await db.put(customer);
            } catch (e) {
                console.log('Error updating customer balance');
            }
        }

        // Clear bill
        currentBillItems = [];
        document.getElementById('current-bill-section').style.display = 'none';
        document.getElementById('bill-customer').value = '';
        document.getElementById('bill-discount').value = '0';
        document.getElementById('amount-paid').value = '';
        generateBillNumber();

        showToast('Bill finalized successfully!', 'success');

        // Show preview
        previewBill();

        // Sync
        handleSync();

    } catch (error) {
        console.error(error);
        showToast('Error finalizing bill', 'error');
    }
}

function previewBill() {
    const customerName = document.getElementById('bill-customer').selectedOptions[0]?.text || 'Customer';
    const billNumber = document.getElementById('bill-number').value;
    const date = new Date().toLocaleString();

    let itemsHtml = '';
    currentBillItems.forEach(item => {
        itemsHtml += `
            <tr>
                <td>${item.desc}</td>
                <td>${item.qty}</td>
                <td>₹${item.price.toFixed(2)}</td>
                <td>₹${item.total.toFixed(2)}</td>
            </tr>
        `;
    });

    const subtotal = parseFloat(document.getElementById('bill-subtotal').textContent) || 0;
    const discount = parseFloat(document.getElementById('bill-discount').value) || 0;
    const total = parseFloat(document.getElementById('bill-total').textContent) || 0;
    const paid = parseFloat(document.getElementById('amount-paid').value) || 0;
    const balance = total - paid;

    const content = `
        <div style="padding: 20px; background: white; color: black; border-radius: 10px;">
            <h2 style="text-align: center; color: #6366f1;">INVOICE</h2>
            <p><strong>Bill No:</strong> ${billNumber}</p>
            <p><strong>Date:</strong> ${date}</p>
            <p><strong>Customer:</strong> ${customerName}</p>
            
            <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
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
            
            <div style="margin-top: 20px; text-align: right;">
                <p>Subtotal: ₹${subtotal.toFixed(2)}</p>
                <p>Discount: ₹${discount.toFixed(2)}</p>
                <p><strong>Total: ₹${total.toFixed(2)}</strong></p>
                <p>Paid: ₹${paid.toFixed(2)}</p>
                <p style="color: ${balance > 0 ? '#ef4444' : '#10b981'};"><strong>Balance: ₹${balance.toFixed(2)}</strong></p>
            </div>
            
            <p style="text-align: center; margin-top: 30px; color: #666;">Thank you for your business!</p>
        </div>
    `;

    document.getElementById('bill-preview-content').innerHTML = content;
    document.getElementById('bill-preview-modal').classList.add('active');
}

function printBill() {
    window.print();
}

function downloadBillPDF() {
    showToast('PDF download - Coming soon', 'info');
}

function closeModal() {
    document.getElementById('bill-preview-modal').classList.remove('active');
}

// ==================== LEDGER FUNCTIONS ====================
async function updateLedgerUI() {
    const result = await db.allDocs({ include_docs: true });
    const transactions = result.rows
        .map(r => r.doc)
        .filter(d => d.type === 'ledger')
        .sort((a, b) => new Date(b.date) - new Date(a.date));

    // Calculate totals
    let totalSales = 0;
    let creditDue = 0;
    const customerBalances = {};

    transactions.forEach(t => {
        totalSales += t.total || t.amount || 0;
        if (t.balance > 0) {
            creditDue += t.balance;
            customerBalances[t.customer] = (customerBalances[t.customer] || 0) + t.balance;
        }
    });

    const ledgerTotal = document.getElementById('ledger-total');
    const ledgerCount = document.getElementById('ledger-count');
    const creditDueEl = document.getElementById('credit-due');

    if (ledgerTotal) ledgerTotal.textContent = `₹${totalSales.toFixed(2)}`;
    if (ledgerCount) ledgerCount.textContent = transactions.length;
    if (creditDueEl) creditDueEl.textContent = `₹${creditDue.toFixed(2)}`;

    // Show customer balances
    const balancesList = document.getElementById('customer-balances-list');
    if (balancesList) {
        balancesList.innerHTML = '';

        Object.entries(customerBalances).forEach(([customer, amount]) => {
            if (amount > 0) {
                balancesList.innerHTML += `
                    <div class="balance-card">
                        <div class="name">${customer}</div>
                        <div class="amount">₹${amount.toFixed(2)}</div>
                    </div>
                `;
            }
        });

        if (Object.keys(customerBalances).length === 0) {
            balancesList.innerHTML = '<p style="text-align: center; opacity: 0.7;">No pending balances</p>';
        }
    }

    // Show transactions
    const list = document.getElementById('bill-history-list');
    if (!list) return;

    list.innerHTML = '';

    transactions.forEach(t => {
        list.innerHTML += `
            <div class="ledger-card" onclick="viewTransaction('${t._id}')">
                <div style="display: flex; justify-content: space-between">
                    <strong>${t.customer}</strong>
                    <span>₹${(t.total || t.amount || 0).toFixed(2)}</span>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 12px; opacity: 0.8">
                    <span>${new Date(t.date).toLocaleString()}</span>
                    <span>${t.paymentMethod || 'Cash'}</span>
                </div>
                ${t.balance > 0 ?
                `<div style="color: #ef4444; font-size: 12px; margin-top: 5px">
                        Due: ₹${t.balance.toFixed(2)}
                    </div>` : ''
            }
            </div>
        `;
    });
}

function viewTransaction(id) {
    showToast('Transaction details - Coming soon', 'info');
}

// ==================== BARCODE SCANNER FUNCTIONS ====================
async function toggleScanner(type) {
    const readerId = type === 'inventory' ? 'inventory-reader' : 'bill-reader';
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
            {
                fps: 10,
                qrbox: { width: 250, height: 250 },
                aspectRatio: 1.0
            },
            (decodedText) => handleScanResult(decodedText, type),
            (error) => console.log(error)
        );
        showToast('Scanner started', 'success');
    } catch (error) {
        showToast('Camera access denied or not available', 'error');
        console.error(error);
    }
}

async function scanFile(input, type) {
    if (input.files.length === 0) return;

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

        // Try to fetch existing item
        try {
            const doc = await db.get(text);
            if (doc.type === 'inventory') {
                document.getElementById('part-name').value = doc.name || '';
                document.getElementById('part-price').value = doc.price || '';
                document.getElementById('part-category').value = doc.category || 'general';
                document.getElementById('part-location').value = doc.location || '';
                document.getElementById('part-min-stock').value = doc.minStock || 5;
            }
        } catch (e) {
            // New item, leave fields empty
        }
    } else {
        document.getElementById('bill-item-id').value = text;

        // Try to fetch from inventory
        try {
            const doc = await db.get(text);
            if (doc.type === 'inventory') {
                document.getElementById('bill-desc').value = doc.name || '';
                document.getElementById('bill-price').value = doc.price || '';
            }
        } catch (e) {
            // Item not found, let user enter manually
        }
    }

    if (html5QrCode) {
        await html5QrCode.stop();
        html5QrCode = null;
    }

    showToast('Barcode scanned: ' + text, 'success');
}

// ==================== GOOGLE DRIVE SYNC ====================
function handleSync() {
    if (!navigator.onLine) {
        showToast('No internet connection', 'error');
        return;
    }

    if (!accessToken || accessToken === 'null') {
        const redirectUri = window.location.origin + window.location.pathname;
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.file')}&include_granted_scopes=true`;
        window.location.href = authUrl;
    } else {
        uploadToDrive();
    }
}

async function uploadToDrive() {
    if (!navigator.onLine || !accessToken) return;

    const syncStatus = document.getElementById('sync-status');
    if (syncStatus) syncStatus.innerHTML = '<i class="fas fa-sync fa-spin"></i> Syncing...';

    try {
        // Get all data
        const allDocs = await db.allDocs({ include_docs: true });
        const data = allDocs.rows.map(r => r.doc);

        // Search for existing file
        const searchResponse = await fetch('https://www.googleapis.com/drive/v3/files?q=name=\'workshop_backup.json\'', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (searchResponse.status === 401) {
            // Token expired
            localStorage.removeItem('google_token');
            accessToken = null;
            handleSync();
            return;
        }

        const files = await searchResponse.json();
        const fileId = files.files?.[0]?.id;

        // Prepare file data
        const metadata = {
            name: 'workshop_backup.json',
            mimeType: 'application/json'
        };

        const formData = new FormData();
        formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        formData.append('file', new Blob([JSON.stringify(data)], { type: 'application/json' }));

        let uploadResponse;
        if (fileId) {
            // Update existing file
            uploadResponse = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${accessToken}` },
                body: formData
            });
        } else {
            // Create new file
            uploadResponse = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${accessToken}` },
                body: formData
            });
        }

        if (uploadResponse.ok) {
            const time = new Date().toLocaleTimeString();
            if (syncStatus) syncStatus.innerHTML = `<i class="fas fa-check-circle"></i> Synced at ${time}`;
            document.getElementById('last-sync-time').textContent = time;
            showToast('Backup successful!', 'success');
        } else {
            throw new Error('Upload failed');
        }
    } catch (error) {
        console.error(error);
        if (syncStatus) syncStatus.innerHTML = '<i class="fas fa-exclamation-circle"></i> Sync failed';
        showToast('Sync failed', 'error');
    }
}

// ==================== UTILITY FUNCTIONS ====================
function changeQty(id, delta) {
    const input = document.getElementById(id);
    if (!input) return;

    let val = parseInt(input.value) || 1;
    val = Math.max(1, val + delta);
    input.value = val;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    let icon = 'info-circle';
    if (type === 'success') icon = 'check-circle';
    if (type === 'error') icon = 'exclamation-circle';
    if (type === 'warning') icon = 'warning';

    toast.innerHTML = `<i class="fas fa-${icon}"></i> ${message}`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, 3000);
}

function updateDateTime() {
    const now = new Date();
    const dateEl = document.getElementById('current-date');
    if (dateEl) {
        dateEl.textContent = now.toLocaleDateString('en-IN', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    }
}

function loadSettings() {
    const saved = localStorage.getItem('workshop_settings');
    if (saved) {
        try {
            const settings = JSON.parse(saved);
            lowStockThreshold = settings.lowStockThreshold || 5;

            const alertInput = document.getElementById('alert-threshold');
            if (alertInput) alertInput.value = lowStockThreshold;

            const autoBackup = document.getElementById('auto-backup');
            if (autoBackup) autoBackup.checked = settings.autoBackup !== false;

            const darkMode = document.getElementById('dark-mode');
            if (darkMode) darkMode.checked = settings.darkMode !== false;

            const currency = document.getElementById('currency-setting');
            if (currency) currency.value = settings.currency || '₹';
        } catch (e) {
            console.log('Error loading settings');
        }
    }
}

// ==================== EXPORT/IMPORT FUNCTIONS ====================
async function exportInventory() {
    await loadInventory();

    let csv = 'Item Name,Price,Total In,Total Sold,Available,Category,Location\n';

    inventoryItems.forEach(item => {
        const available = (item.totalIn || 0) - (item.totalSold || 0);
        csv += `"${item.name}",${item.price || 0},${item.totalIn || 0},${item.totalSold || 0},${available},"${item.category || ''}","${item.location || ''}"\n`;
    });

    downloadFile(csv, 'inventory_export.csv', 'text/csv');
    showToast('Inventory exported', 'success');
}

async function exportLedger() {
    const result = await db.allDocs({ include_docs: true });
    const transactions = result.rows
        .map(r => r.doc)
        .filter(d => d.type === 'ledger');

    let csv = 'Bill No,Date,Customer,Total,Paid,Balance,Payment Method\n';

    transactions.forEach(t => {
        csv += `"${t.billNumber || ''}","${new Date(t.date).toLocaleString()}","${t.customer}",${t.total || t.amount || 0},${t.paid || 0},${t.balance || 0},"${t.paymentMethod || 'Cash'}"\n`;
    });

    downloadFile(csv, 'ledger_export.csv', 'text/csv');
    showToast('Ledger exported', 'success');
}

async function exportAllData() {
    const result = await db.allDocs({ include_docs: true });
    const data = result.rows.map(r => r.doc);

    downloadFile(JSON.stringify(data, null, 2), 'workshop_backup.json', 'application/json');
    showToast('All data exported', 'success');
}

function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.onchange = async (e) => {
        const file = e.target.files[0];
        const reader = new FileReader();

        reader.onload = async (e) => {
            try {
                const data = JSON.parse(e.target.result);

                if (confirm(`Import ${data.length} records? This will merge with existing data.`)) {
                    for (const doc of data) {
                        try {
                            await db.put(doc);
                        } catch (error) {
                            // Handle conflicts
                            if (error.status === 409) {
                                const existing = await db.get(doc._id);
                                doc._rev = existing._rev;
                                await db.put(doc);
                            }
                        }
                    }

                    showToast('Data imported successfully', 'success');
                    await initApp();
                }
            } catch (error) {
                showToast('Invalid backup file', 'error');
            }
        };

        reader.readAsText(file);
    };

    input.click();
}

function downloadFile(content, fileName, contentType) {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
}

function printInventory() {
    window.print();
}

function printReport() {
    showToast('Print report - Coming soon', 'info');
}

function sortInventory(column) {
    // Implement sorting
    showToast('Sort by ' + column, 'info');
}

function clearAllData() {
    if (confirm('⚠️ WARNING: This will delete ALL data! Are you absolutely sure?')) {
        if (confirm('Type "DELETE" to confirm')) {
            db.destroy().then(() => {
                localStorage.clear();
                location.reload();
            });
        }
    }
}

// ==================== PRINT STYLES ====================
const style = document.createElement('style');
style.textContent = `
    @media print {
        body * {
            visibility: hidden;
        }
        #bill-preview-modal .modal-content,
        #bill-preview-modal .modal-content * {
            visibility: visible;
        }
        #bill-preview-modal {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            background: white;
        }
    }
`;
document.head.appendChild(style);