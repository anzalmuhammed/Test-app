const db = new PouchDB('workshop_db');
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let tokenClient, accessToken = sessionStorage.getItem('drive_token'), html5QrCode, billQrCode, currentBillItems = [];

// NAVIGATION GUARD
window.addEventListener('popstate', function () {
    const activeScreen = document.querySelector('.screen[style*="block"]');
    if (activeScreen && activeScreen.id !== 'main-menu') {
        history.pushState(null, null, window.location.pathname);
        clearAndBack();
    }
});

// AUTO SYNC WHEN ONLINE
window.addEventListener('online', () => { if (accessToken) uploadToDrive(); });

function gapiLoaded() { gapi.load('client', async () => { await gapi.client.init({ discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"] }); }); }
function gsiLoaded() { tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPES, callback: (res) => { accessToken = res.access_token; sessionStorage.setItem('drive_token', accessToken); uploadToDrive(); } }); }

window.onload = () => {
    gapiLoaded(); gsiLoaded(); updateLedgerUI();
    history.pushState(null, null, window.location.pathname);
};

// CLEAR INPUTS ON BACK
function clearAndBack() {
    clearAllInputs();
    showScreen('main-menu');
}

function clearAllInputs() {
    const inputs = document.querySelectorAll('input');
    inputs.forEach(input => {
        if (input.type === 'number' && (input.id === 'part-qty' || input.id === 'bill-qty')) {
            input.value = "1";
        } else if (input.type !== 'file') {
            input.value = "";
        }
    });
    currentBillItems = [];
    document.getElementById('current-items-section').style.display = 'none';
}

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
    document.getElementById(screenId).style.display = 'block';
    if (screenId === 'stock-list-screen') updateInventoryUI();
    if (screenId === 'ledger-screen') updateLedgerUI();
}

// --- SCANNER LOGIC ---
function startScanner() {
    if (!html5QrCode) html5QrCode = new Html5Qrcode("reader");
    html5QrCode.start({ facingMode: "environment" }, { fps: 20, qrbox: { width: 250, height: 150 } }, (text) => {
        onScanSuccess(text, 'part-id', 'part-name', 'part-price', html5QrCode, 'restart-scan');
    });
}

function startBillScanner() {
    if (!billQrCode) billQrCode = new Html5Qrcode("bill-reader");
    billQrCode.start({ facingMode: "environment" }, { fps: 20, qrbox: { width: 250, height: 150 } }, (text) => {
        onScanSuccess(text, 'bill-item-id', 'bill-desc', 'bill-price', billQrCode, 'bill-restart-scan');
    });
}

function onScanSuccess(text, idField, nameField, priceField, scannerObj, restartBtn) {
    playBeep();
    document.getElementById(idField).value = text;
    db.get(text).then(doc => {
        document.getElementById(nameField).value = doc.name;
        document.getElementById(priceField).value = doc.price;
    }).catch(() => { });
    scannerObj.stop().then(() => document.getElementById(restartBtn).style.display = 'block');
}

// --- BILLING & PDF ---
function addItemToCurrentBill() {
    const id = document.getElementById('bill-item-id').value, desc = document.getElementById('bill-desc').value;
    const price = parseFloat(document.getElementById('bill-price').value) || 0, qty = parseInt(document.getElementById('bill-qty').value) || 1;
    if (!desc || price <= 0) return alert("Enter item and price");
    currentBillItems.push({ id, desc, price, qty });
    renderBillTable();
}

function renderBillTable() {
    const body = document.getElementById('current-bill-body'), sect = document.getElementById('current-items-section');
    body.innerHTML = ""; let total = 0;
    if (currentBillItems.length > 0) {
        sect.style.display = 'block';
        currentBillItems.forEach((item, index) => {
            total += (item.price * item.qty);
            body.innerHTML += `<tr><td>${item.desc}</td><td>${item.qty}</td><td>₹${(item.price * item.qty).toFixed(2)}</td><td><button class="del-btn" onclick="removeItem(${index})">X</button></td></tr>`;
        });
        document.getElementById('bill-total-display').innerText = total.toFixed(2);
    } else { sect.style.display = 'none'; }
}

async function finalizeBill() {
    const cust = document.getElementById('bill-cust-name').value;
    if (!cust || currentBillItems.length === 0) return alert("Missing Info");

    let total = 0;
    const date = new Date().toLocaleString();

    for (let item of currentBillItems) {
        total += (item.price * item.qty);
        if (item.id) { try { let p = await db.get(item.id); p.totalSold = (p.totalSold || 0) + item.qty; await db.put(p); } catch (e) { } }
    }

    const billData = {
        _id: 'ledger_' + Date.now(),
        customer: cust,
        amount: total,
        items: [...currentBillItems],
        type: 'invoice',
        category: 'ledger',
        date: date
    };

    await db.put(billData);
    generatePDF(cust, date, currentBillItems, total);

    alert("Bill Saved & PDF Generated!");
    clearAndBack();
    uploadToDrive();
}

function generatePDF(cust, date, items, total) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(20); doc.text("INVOICE", 105, 20, { align: "center" });
    doc.setFontSize(12); doc.text(`Customer: ${cust}`, 20, 40); doc.text(`Date: ${date}`, 20, 50);
    doc.line(20, 55, 190, 55);
    let y = 65;
    doc.text("Item", 20, y); doc.text("Qty", 120, y); doc.text("Total", 160, y);
    y += 10;
    items.forEach(i => {
        doc.text(i.desc, 20, y); doc.text(i.qty.toString(), 120, y); doc.text(`Rs.${(i.price * i.qty).toFixed(2)}`, 160, y);
        y += 10;
    });
    doc.line(20, y, 190, y);
    doc.setFontSize(14); doc.text(`Grand Total: Rs. ${total.toFixed(2)}`, 140, y + 15);
    doc.save(`Bill_${cust}_${Date.now()}.pdf`);
}

// --- LEDGER HISTORY ---
async function updateLedgerUI() {
    const res = await db.allDocs({ include_docs: true }), bals = {}, historyList = document.getElementById('bill-history-list');
    const q = (document.getElementById('history-search')?.value || "").toLowerCase();

    historyList.innerHTML = "";
    res.rows.forEach(r => {
        const d = r.doc;
        if (d.category === 'ledger') {
            // Balance logic
            bals[d.customer] = (bals[d.customer] || 0) + (d.type === 'invoice' ? d.amount : -d.amount);

            // History logic (only invoices show item details)
            if (d.type === 'invoice' && (d.customer.toLowerCase().includes(q) || d.items.some(i => i.desc.toLowerCase().includes(q)))) {
                let itemsHtml = d.items.map(i => `${i.desc} (x${i.qty})`).join(", ");
                historyList.innerHTML += `<div class="ledger-card" style="font-size:12px;">
                    <strong>${d.date}</strong><br>
                    Customer: ${d.customer}<br>
                    Items: ${itemsHtml}<br>
                    Total: ₹${d.amount.toFixed(2)}
                </div>`;
            }
        }
    });

    const list = document.getElementById('customer-list');
    list.innerHTML = "";
    for (let c in bals) {
        list.innerHTML += `<div class="ledger-card"><strong>${c}</strong>: ₹${Math.abs(bals[c]).toFixed(2)}</div>`;
    }
}

// Helper functions (savePart, uploadToDrive, changeQty, playBeep) remain identical to previous full code.