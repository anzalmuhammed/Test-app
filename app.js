// ==================== DATABASE INIT ====================
let db;
let currentProduct = null;
let currentAction = null;

// Initialize PouchDB
try {
    db = new PouchDB('workshop_db');
    console.log('Database initialized');
} catch (e) {
    console.log('PouchDB failed, using memory');
    db = new PouchDB('workshop_db', { adapter: 'memory' });
}

// ==================== UTILITY FUNCTIONS ====================
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

function updateOfflineStatus() {
    const badge = document.getElementById('offlineBadge');
    if (!navigator.onLine) {
        badge.classList.add('show');
    } else {
        badge.classList.remove('show');
    }
}

// ==================== NAVIGATION ====================
function showSection(sectionId) {
    // Hide all sections
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));

    // Show selected section
    document.getElementById(sectionId).classList.add('active');

    // Update nav buttons
    document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
    document.getElementById(`nav-${sectionId}`).classList.add('active');

    // Load section data
    if (sectionId === 'dashboard') loadDashboard();
    if (sectionId === 'stock') loadStock();
    if (sectionId === 'customers') loadCustomers();
    if (sectionId === 'ledger') loadLedger();
}

// ==================== DASHBOARD ====================
async function loadDashboard() {
    try {
        const result = await db.allDocs({ include_docs: true });
        const docs = result.rows.map(r => r.doc);

        // Filter by type
        const products = docs.filter(d => d && d.type === 'product');
        const transactions = docs.filter(d => d && d.type === 'transaction');

        // Calculate metrics
        const today = new Date().toDateString();
        const todaySales = transactions
            .filter(t => new Date(t.date).toDateString() === today)
            .reduce((sum, t) => sum + (t.total || 0), 0);

        const outstanding = transactions
            .filter(t => t.balance > 0)
            .reduce((sum, t) => sum + (t.balance || 0), 0);

        const lowStock = products.filter(p => (p.quantity || 0) <= (p.minStock || 5)).length;

        // Update UI
        document.getElementById('todaySales').textContent = `₹${todaySales}`;
        document.getElementById('totalOutstanding').textContent = `₹${outstanding}`;
        document.getElementById('lowStockCount').textContent = lowStock;
        document.getElementById('totalProducts').textContent = products.length;
        document.getElementById('headerBalance').textContent = `₹${outstanding}`;

        // Recent transactions
        const recent = transactions.slice(-5).reverse();
        let recentHtml = '';
        recent.forEach(t => {
            recentHtml += `<div class="item-card" onclick="viewTransaction('${t._id}')">
                <h3>${t.customerName || 'Walk-in'}</h3>
                <p>₹${t.total} | ${new Date(t.date).toLocaleDateString()}</p>
            </div>`;
        });
        document.getElementById('recentTransactions').innerHTML = recentHtml || '<p>No transactions yet</p>';

    } catch (error) {
        showToast('Error loading dashboard', 'error');
    }
}

// ==================== STOCK MANAGEMENT ====================
function showAddProductForm() {
    document.getElementById('addProductForm').style.display = 'block';
    document.getElementById('productName').focus();
}

function hideAddProductForm() {
    document.getElementById('addProductForm').style.display = 'none';
    clearProductForm();
}

function clearProductForm() {
    document.getElementById('productName').value = '';
    document.getElementById('productBarcode').value = '';
    document.getElementById('purchasePrice').value = '';
    document.getElementById('sellingPrice').value = '';
    document.getElementById('productQuantity').value = '0';
    document.getElementById('minStock').value = '5';
    document.getElementById('productLocation').value = '';
}

async function saveProduct() {
    const name = document.getElementById('productName').value.trim();
    const barcode = document.getElementById('productBarcode').value.trim();
    const purchasePrice = parseFloat(document.getElementById('purchasePrice').value) || 0;
    const sellingPrice = parseFloat(document.getElementById('sellingPrice').value) || 0;
    const quantity = parseInt(document.getElementById('productQuantity').value) || 0;
    const minStock = parseInt(document.getElementById('minStock').value) || 5;
    const location = document.getElementById('productLocation').value.trim();

    if (!name || !barcode) {
        return showToast('Name and Barcode are required', 'error');
    }

    try {
        const product = {
            _id: barcode,
            type: 'product',
            name: name,
            barcode: barcode,
            purchasePrice: purchasePrice,
            sellingPrice: sellingPrice,
            quantity: quantity,
            minStock: minStock,
            location: location,
            updatedAt: new Date().toISOString()
        };

        await db.put(product);
        showToast('Product saved successfully', 'success');
        hideAddProductForm();
        loadStock();
    } catch (error) {
        if (error.name === 'conflict') {
            // Update existing
            const existing = await db.get(barcode);
            const updated = { ...existing, ...product };
            await db.put(updated);
            showToast('Product updated', 'success');
            hideAddProductForm();
            loadStock();
        } else {
            showToast('Error saving product', 'error');
        }
    }
}

async function loadStock() {
    try {
        const result = await db.allDocs({ include_docs: true });
        const products = result.rows
            .map(r => r.doc)
            .filter(d => d && d.type === 'product')
            .sort((a, b) => a.name.localeCompare(b.name));

        let html = '';
        products.forEach(p => {
            const lowStock = p.quantity <= p.minStock ? '⚠️ Low Stock' : '';
            html += `<div class="item-card" onclick="editProduct('${p._id}')">
                <h3>${p.name}</h3>
                <p>Barcode: ${p.barcode}</p>
                <div class="grid-2">
                    <span class="price">₹${p.sellingPrice}</span>
                    <span class="stock">Stock: ${p.quantity} ${lowStock}</span>
                </div>
                <p>📍 ${p.location || 'Main'}</p>
            </div>`;
        });

        document.getElementById('stockList').innerHTML = html || '<p>No products found</p>';
    } catch (error) {
        showToast('Error loading stock', 'error');
    }
}

async function editProduct(id) {
    try {
        const product = await db.get(id);

        document.getElementById('productName').value = product.name || '';
        document.getElementById('productBarcode').value = product.barcode || '';
        document.getElementById('purchasePrice').value = product.purchasePrice || '';
        document.getElementById('sellingPrice').value = product.sellingPrice || '';
        document.getElementById('productQuantity').value = product.quantity || 0;
        document.getElementById('minStock').value = product.minStock || 5;
        document.getElementById('productLocation').value = product.location || '';

        showAddProductForm();
    } catch (error) {
        showToast('Error loading product', 'error');
    }
}

function searchProducts() {
    const searchTerm = document.getElementById('searchStock').value.toLowerCase();
    const cards = document.querySelectorAll('#stockList .item-card');

    cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        card.style.display = text.includes(searchTerm) ? 'block' : 'none';
    });
}

// ==================== CUSTOMER MANAGEMENT ====================
function showAddCustomerForm() {
    document.getElementById('addCustomerForm').style.display = 'block';
    document.getElementById('customerName').focus();
}

function hideAddCustomerForm() {
    document.getElementById('addCustomerForm').style.display = 'none';
    clearCustomerForm();
}

function clearCustomerForm() {
    document.getElementById('customerName').value = '';
    document.getElementById('customerPhone').value = '';
    document.getElementById('customerEmail').value = '';
    document.getElementById('customerAddress').value = '';
}

async function saveCustomer() {
    const name = document.getElementById('customerName').value.trim();
    const phone = document.getElementById('customerPhone').value.trim();
    const email = document.getElementById('customerEmail').value.trim();
    const address = document.getElementById('customerAddress').value.trim();

    if (!name) {
        return showToast('Customer name is required', 'error');
    }

    try {
        const id = 'CUST-' + Date.now();
        const customer = {
            _id: id,
            type: 'customer',
            name: name,
            phone: phone,
            email: email,
            address: address,
            balance: 0,
            createdAt: new Date().toISOString()
        };

        await db.put(customer);
        showToast('Customer saved', 'success');
        hideAddCustomerForm();
        loadCustomers();
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

        // Update filter dropdown
        let options = '<option value="">All Customers</option>';
        let html = '';

        customers.forEach(c => {
            options += `<option value="${c._id}">${c.name} (₹${c.balance})</option>`;

            html += `<div class="item-card" onclick="viewCustomer('${c._id}')">
                <h3>${c.name}</h3>
                <p>📞 ${c.phone || 'No phone'}</p>
                <p class="${c.balance > 0 ? 'price' : ''}">Balance: ₹${c.balance}</p>
            </div>`;
        });

        document.getElementById('ledgerCustomerFilter').innerHTML = options;
        document.getElementById('customerList').innerHTML = html || '<p>No customers yet</p>';
    } catch (error) {
        showToast('Error loading customers', 'error');
    }
}

function searchCustomers() {
    const searchTerm = document.getElementById('searchCustomer').value.toLowerCase();
    const cards = document.querySelectorAll('#customerList .item-card');

    cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        card.style.display = text.includes(searchTerm) ? 'block' : 'none';
    });
}

async function viewCustomer(id) {
    try {
        const customer = await db.get(id);
        alert(`Customer: ${customer.name}\nPhone: ${customer.phone}\nBalance: ₹${customer.balance}`);
    } catch (error) {
        showToast('Error loading customer', 'error');
    }
}

// ==================== LEDGER MANAGEMENT ====================
async function loadLedger() {
    try {
        const result = await db.allDocs({ include_docs: true });
        const transactions = result.rows
            .map(r => r.doc)
            .filter(d => d && d.type === 'transaction')
            .sort((a, b) => new Date(b.date) - new Date(a.date));

        let html = '';
        transactions.forEach(t => {
            html += `<div class="item-card" onclick="viewTransaction('${t._id}')">
                <h3>${t.customerName || 'Walk-in'}</h3>
                <p>${new Date(t.date).toLocaleString()}</p>
                <div class="grid-2">
                    <span class="price">₹${t.total}</span>
                    <span>Balance: ₹${t.balance}</span>
                </div>
            </div>`;
        });

        document.getElementById('transactionList').innerHTML = html || '<p>No transactions yet</p>';
    } catch (error) {
        showToast('Error loading ledger', 'error');
    }
}

function recordPayment() {
    alert('Payment recording - To be implemented');
}

function recordExpense() {
    alert('Expense recording - To be implemented');
}

function viewTransaction(id) {
    alert('Transaction details - To be implemented');
}

// ==================== BARCODE SCANNER ====================
function handleBarcodeKeypress(event) {
    if (event.key === 'Enter') {
        const barcode = event.target.value.trim();
        if (barcode) {
            lookupBarcode(barcode);
            event.target.value = '';
        }
    }
}

async function lookupBarcode(barcode) {
    try {
        const product = await db.get(barcode).catch(() => null);

        if (product && product.type === 'product') {
            currentProduct = product;
            document.getElementById('scannedProduct').style.display = 'block';
            document.getElementById('productDetail').innerHTML = `
                <h3>${product.name}</h3>
                <p>Price: ₹${product.sellingPrice} | Stock: ${product.quantity}</p>
                <p>Location: ${product.location || 'Main'}</p>
            `;
            showToast('Product found', 'success');
        } else {
            showToast('Product not found. Add it first.', 'warning');
            document.getElementById('scannedProduct').style.display = 'none';
            // Switch to stock section
            showSection('stock');
            document.getElementById('productBarcode').value = barcode;
            showAddProductForm();
        }
    } catch (error) {
        showToast('Error looking up barcode', 'error');
    }
}

function stockIn() {
    if (!currentProduct) return;
    currentAction = 'IN';
    document.getElementById('stockActionTitle').textContent = 'Stock IN - Add Quantity';
    document.getElementById('stockActionForm').style.display = 'block';
}

function stockOut() {
    if (!currentProduct) return;
    currentAction = 'OUT';
    document.getElementById('stockActionTitle').textContent = 'Stock OUT - Remove Quantity';
    document.getElementById('stockActionForm').style.display = 'block';
}

async function confirmStockAction() {
    if (!currentProduct || !currentAction) return;

    const quantity = parseInt(document.getElementById('actionQuantity').value) || 1;
    const reference = document.getElementById('actionReference').value;

    try {
        const product = await db.get(currentProduct._id);

        if (currentAction === 'IN') {
            product.quantity = (product.quantity || 0) + quantity;
        } else {
            if ((product.quantity || 0) < quantity) {
                return showToast('Insufficient stock', 'error');
            }
            product.quantity = (product.quantity || 0) - quantity;
        }

        product.updatedAt = new Date().toISOString();
        await db.put(product);

        showToast(`Stock ${currentAction} completed`, 'success');
        cancelStockAction();

        // Refresh display
        if (currentProduct) {
            document.getElementById('productDetail').innerHTML = `
                <h3>${product.name}</h3>
                <p>Price: ₹${product.sellingPrice} | Stock: ${product.quantity}</p>
                <p>Location: ${product.location || 'Main'}</p>
            `;
        }
    } catch (error) {
        showToast('Error updating stock', 'error');
    }
}

function cancelStockAction() {
    currentAction = null;
    document.getElementById('stockActionForm').style.display = 'none';
    document.getElementById('actionQuantity').value = '1';
    document.getElementById('actionReference').value = '';
}

function addToSale() {
    alert('Add to sale - To be implemented');
}

function viewHistory() {
    alert('View history - To be implemented');
}

// ==================== INITIALIZATION ====================
window.onload = function () {
    updateOfflineStatus();
    loadDashboard();

    // Online/Offline listeners
    window.addEventListener('online', updateOfflineStatus);
    window.addEventListener('offline', updateOfflineStatus);
};

// ==================== EXPORT FUNCTIONS ====================
window.showSection = showSection;
window.showAddProductForm = showAddProductForm;
window.hideAddProductForm = hideAddProductForm;
window.saveProduct = saveProduct;
window.showAddCustomerForm = showAddCustomerForm;
window.hideAddCustomerForm = hideAddCustomerForm;
window.saveCustomer = saveCustomer;
window.recordPayment = recordPayment;
window.recordExpense = recordExpense;
window.loadLedger = loadLedger;
window.stockIn = stockIn;
window.stockOut = stockOut;
window.confirmStockAction = confirmStockAction;
window.cancelStockAction = cancelStockAction;
window.addToSale = addToSale;
window.viewHistory = viewHistory;
window.handleBarcodeKeypress = handleBarcodeKeypress;
window.searchProducts = searchProducts;
window.searchCustomers = searchCustomers;