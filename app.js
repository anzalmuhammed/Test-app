const db = new PouchDB('workshop_db');
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let tokenClient, accessToken = sessionStorage.getItem('drive_token'), html5QrCode, billQrCode, currentBillItems = [];

// MOBILE BACK BUTTON GUARD
window.addEventListener('popstate', function (event) {
    const activeScreen = document.querySelector('.screen[style*="block"]');
    if (activeScreen && activeScreen.id !== 'main-menu') {
        history.pushState(null, null, window.location.pathname);
        showScreen('main-menu');
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

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
    document.getElementById(screenId).style.display = 'block';
    if (screenId === 'stock-list-screen') updateInventoryUI();
    if (screenId === 'ledger-screen') updateLedgerUI();
    if (html5QrCode) html5QrCode.stop().catch(() => { });
    if (billQrCode) billQrCode.stop().catch(() => { });
}

// --- SCANNER LOGIC (Clear inputs on rescan) ---
function startScanner() {
    document.getElementById('part-id').value = ""; document.getElementById('part-name').value = ""; document.getElementById('part-price').value = "";
    document.getElementById('start-scan-manual').style.display = 'none';
    if (!html5QrCode) html5QrCode = new Html5Qrcode("reader");
    html5QrCode.start({ facingMode: "environment" }, { fps: 20, qrbox: { width: 250, height: 150 } }, (text) => {
        onScanSuccess(text, 'part-id', 'part-name', 'part-price', html5QrCode, 'restart-scan');
    }).catch(() => document.getElementById('start-scan-manual').style.display = 'block');
}

function startBillScanner() {
    document.getElementById('bill-item-id').value = ""; document.getElementById('bill-desc').value = ""; document.getElementById('bill-price').value = "";
    document.getElementById('bill-start-scan').style.display = 'none';
    if (!billQrCode) billQrCode = new Html5Qrcode("bill-reader");
    billQrCode.start({ facingMode: "environment" }, { fps: 20, qrbox: { width: 250, height: 150 } }, (text) => {
        onScanSuccess(text, 'bill-item-id', 'bill-desc', 'bill-price', billQrCode, 'bill-restart-scan');
    }).catch(() => document.getElementById('bill-start-scan').style.display = 'block');
}

function onScanSuccess(text, idField, nameField, priceField, scannerObj, restartBtn) {
    playBeep(); if (navigator.vibrate) navigator.vibrate(200);
    document.getElementById(idField).value = text;
    db.get(text).then(doc => {
        document.getElementById(nameField).value = doc.name;
        document.getElementById(priceField).value = doc.price;
    }).catch(() => { });
    scannerObj.stop().then(() => document.getElementById(restartBtn).style.display = 'block');
}

function scanImageFile(e) {
    if (!html5QrCode) html5QrCode = new Html5Qrcode("reader");
    html5QrCode.scanFile(e.target.files[0], true).then(t => onScanSuccess(t, 'part-id', 'part-name', 'part-price', html5QrCode, 'restart-scan')).catch(() => alert("No barcode"));
}

function scanBillImageFile(e) {
    if (!billQrCode) billQrCode = new Html5Qrcode("bill-reader");
    billQrCode.scanFile(e.target.files[0], true).then(t => onScanSuccess(t, 'bill-item-id', 'bill-desc', 'bill-price', billQrCode, 'bill-restart-scan')).catch(() => alert("No barcode"));
}

// --- BILLING CART ---
function addItemToCurrentBill() {
    const id = document.getElementById('bill-item-id').value, desc = document.getElementById('bill-desc').value;
    const price = parseFloat(document.getElementById('bill-price').value) || 0, qty = parseInt(document.getElementById('bill-qty').value) || 1;
    if (!desc || price <= 0) return alert("Enter item and price");
    currentBillItems.push({ id, desc, price, qty });
    document.getElementById('bill-item-id').value = ""; document.getElementById('bill-desc').value = "";
    document.getElementById('bill-price').value = ""; document.getElementById('bill-qty').value = "1";
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

function removeItem(index) { currentBillItems.splice(index, 1); renderBillTable(); }

async function finalizeBill() {
    const cust = document.getElementById('bill-cust-name').value;
    if (!cust || currentBillItems.length === 0) return alert("Missing Info");
    let total = 0;
    for (let item of currentBillItems) {
        total += (item.price * item.qty);
        if (item.id) { try { let p = await db.get(item.id); p.totalSold = (p.totalSold || 0) + item.qty; await db.put(p); } catch (e) { } }
    }
    await db.put({ _id: 'ledger_' + Date.now(), customer: cust, amount: total, type: 'invoice', category: 'ledger', date: new Date().toISOString() });
    alert("Bill Finalized!"); currentBillItems = []; document.getElementById('bill-cust-name').value = ""; renderBillTable();
    uploadToDrive(); showScreen('main-menu');
}

// --- DATA HANDLERS ---
async function savePart() {
    const id = document.getElementById('part-id').value, name = document.getElementById('part-name').value;
    const price = parseFloat(document.getElementById('part-price').value) || 0, qty = parseInt(document.getElementById('part-qty').value) || 0;
    if (!id || !name) return alert("ID/Name missing");
    let doc = { _id: id, name, price, totalIn: qty, totalSold: 0, category: 'inventory' };
    try { const ex = await db.get(id); doc._rev = ex._rev; doc.totalIn = (ex.totalIn || 0) + qty; doc.totalSold = ex.totalSold || 0; } catch (e) { }
    await db.put(doc); uploadToDrive(); alert("Stock Updated"); showScreen('main-menu');
}

async function addTransaction(type) {
    const name = document.getElementById('cust-name-pay').value, amount = parseFloat(document.getElementById('trans-amount').value);
    if (!name || !amount) return alert("Fill details");
    await db.put({ _id: 'ledger_' + Date.now(), customer: name, amount, type, category: 'ledger' });
    document.getElementById('cust-name-pay').value = ""; document.getElementById('trans-amount').value = "";
    updateLedgerUI(); uploadToDrive(); alert("Payment Recorded");
}

async function updateInventoryUI() {
    const res = await db.allDocs({ include_docs: true }), list = document.getElementById('inventory-list-table');
    const q = (document.getElementById('stock-search')?.value || "").toLowerCase();
    list.innerHTML = "";
    res.rows.forEach(r => {
        const d = r.doc;
        if (d.category === 'inventory' && (d.name.toLowerCase().includes(q) || d._id.toLowerCase().includes(q))) {
            list.innerHTML += `<tr><td>${d.name}</td><td>${d.totalIn}</td><td>${d.totalSold}</td><td><strong>${d.totalIn - d.totalSold}</strong></td></tr>`;
        }
    });
}

async function updateLedgerUI() {
    const res = await db.allDocs({ include_docs: true }), bals = {}, list = document.getElementById('customer-list');
    const q = (document.getElementById('ledger-search')?.value || "").toLowerCase();
    res.rows.forEach(r => { if (r.doc.category === 'ledger') { const d = r.doc; bals[d.customer] = (bals[d.customer] || 0) + (d.type === 'invoice' ? d.amount : -d.amount); } });
    list.innerHTML = "";
    for (let c in bals) {
        if (c.toLowerCase().includes(q)) {
            list.innerHTML += `<div class="ledger-card"><strong>${c}</strong>: ₹${Math.abs(bals[c]).toFixed(2)} ${bals[c] > 0 ? '(Due)' : '(Credit)'}</div>`;
        }
    }
}

// --- CLOUD SYNC ---
function handleSync() { if (!accessToken) tokenClient.requestAccessToken({ prompt: 'consent' }); else uploadToDrive(); }

async function uploadToDrive() {
    if (!navigator.onLine || !accessToken) return;
    document.getElementById('sync-status').innerText = "Syncing...";
    try {
        const res = await db.allDocs({ include_docs: true });
        const content = JSON.stringify(res.rows.map(r => r.doc));
        const search = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='workshop_db_backup.json'`, { headers: { 'Authorization': 'Bearer ' + accessToken } });
        const sRes = await search.json(); const exist = sRes.files && sRes.files[0];
        let url = exist ? `https://www.googleapis.com/upload/drive/v3/files/${exist.id}?uploadType=media` : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=media';
        await fetch(url, { method: exist ? 'PATCH' : 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: new Blob([content], { type: 'application/json' }) });
        document.getElementById('sync-status').innerText = "Last Synced: " + new Date().toLocaleTimeString();
    } catch (e) { document.getElementById('sync-status').innerText = "Sync Failed"; }
}

function changeQty(id, n) { const q = document.getElementById(id); let v = parseInt(q.value) || 1; if (v + n >= 1) q.value = v + n; }
function playBeep() { const ctx = new AudioContext(), osc = ctx.createOscillator(); osc.connect(ctx.destination); osc.frequency.value = 1000; osc.start(); osc.stop(ctx.currentTime + 0.1); }