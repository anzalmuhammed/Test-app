const db = new PouchDB('workshop_db');
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let tokenClient, accessToken = sessionStorage.getItem('drive_token'), html5QrCode, billQrCode, currentBillItems = [];

// MOBILE BACK BUTTON & AUTO SYNC
window.addEventListener('popstate', () => { if (document.querySelector('.screen[style*="block"]').id !== 'main-menu') { history.pushState(null, null, window.location.pathname); clearAndBack(); } });
window.addEventListener('online', () => { if (accessToken) uploadToDrive(); });

function gapiLoaded() { gapi.load('client', async () => { await gapi.client.init({ discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"] }); }); }
function gsiLoaded() { tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPES, callback: (res) => { accessToken = res.access_token; sessionStorage.setItem('drive_token', accessToken); uploadToDrive(); } }); }
window.onload = () => { gapiLoaded(); gsiLoaded(); updateLedgerUI(); history.pushState(null, null, window.location.pathname); };

function clearAndBack() { clearAllInputs(); showScreen('main-menu'); }

function clearAllInputs() {
    document.querySelectorAll('input').forEach(input => {
        if (input.id === 'part-qty' || input.id === 'bill-qty') input.value = "1";
        else if (input.type !== 'file') input.value = "";
    });
    currentBillItems = [];
    document.getElementById('current-items-section').style.display = 'none';
    document.getElementById('restart-scan').style.display = 'none';
    document.getElementById('bill-restart-scan').style.display = 'none';
}

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
    document.getElementById(screenId).style.display = 'block';
    if (screenId === 'stock-list-screen') updateInventoryUI();
    if (screenId === 'ledger-screen') updateLedgerUI();
    if (html5QrCode) html5QrCode.stop().catch(() => { });
    if (billQrCode) billQrCode.stop().catch(() => { });
}

// --- SCANNER LOGIC ---
function startScanner() {
    document.getElementById('part-id').value = ""; document.getElementById('part-name').value = ""; document.getElementById('part-price').value = "";
    document.getElementById('start-scan-manual').style.display = 'none';
    if (!html5QrCode) html5QrCode = new Html5Qrcode("reader");
    html5QrCode.start({ facingMode: "environment" }, { fps: 20, qrbox: { width: 250, height: 150 } }, (text) => onScanSuccess(text, 'part-id', 'part-name', 'part-price', html5QrCode, 'restart-scan'));
}

function startBillScanner() {
    document.getElementById('bill-item-id').value = ""; document.getElementById('bill-desc').value = ""; document.getElementById('bill-price').value = "";
    document.getElementById('bill-start-scan').style.display = 'none';
    if (!billQrCode) billQrCode = new Html5Qrcode("bill-reader");
    billQrCode.start({ facingMode: "environment" }, { fps: 20, qrbox: { width: 250, height: 150 } }, (text) => onScanSuccess(text, 'bill-item-id', 'bill-desc', 'bill-price', billQrCode, 'bill-restart-scan'));
}

function onScanSuccess(text, idField, nameField, priceField, scannerObj, restartBtn) {
    playBeep(); document.getElementById(idField).value = text;
    db.get(text).then(doc => { document.getElementById(nameField).value = doc.name; document.getElementById(priceField).value = doc.price; }).catch(() => { });
    scannerObj.stop().then(() => document.getElementById(restartBtn).style.display = 'block');
}

function scanImageFile(e) { if (!html5QrCode) html5QrCode = new Html5Qrcode("reader"); html5QrCode.scanFile(e.target.files[0], true).then(t => onScanSuccess(t, 'part-id', 'part-name', 'part-price', html5QrCode, 'restart-scan')).catch(() => alert("No barcode")); }
function scanBillImageFile(e) { if (!billQrCode) billQrCode = new Html5Qrcode("bill-reader"); billQrCode.scanFile(e.target.files[0], true).then(t => onScanSuccess(t, 'bill-item-id', 'bill-desc', 'bill-price', billQrCode, 'bill-restart-scan')).catch(() => alert("No barcode")); }

// --- BILLING & PDF ---
function addItemToCurrentBill() {
    const desc = document.getElementById('bill-desc').value, price = parseFloat(document.getElementById('bill-price').value) || 0, qty = parseInt(document.getElementById('bill-qty').value) || 1;
    if (!desc || price <= 0) return alert("Enter item and price");
    currentBillItems.push({ id: document.getElementById('bill-item-id').value, desc, price, qty });
    document.getElementById('bill-item-id').value = ""; document.getElementById('bill-desc').value = ""; document.getElementById('bill-price').value = ""; document.getElementById('bill-qty').value = "1";
    renderBillTable();
}

function renderBillTable() {
    const body = document.getElementById('current-bill-body'), sect = document.getElementById('current-items-section');
    body.innerHTML = ""; let total = 0;
    if (currentBillItems.length > 0) {
        sect.style.display = 'block';
        currentBillItems.forEach((item, index) => { total += (item.price * item.qty); body.innerHTML += `<tr><td>${item.desc}</td><td>${item.qty}</td><td>₹${(item.price * item.qty).toFixed(2)}</td><td><button class="del-btn" onclick="removeItem(${index})">X</button></td></tr>`; });
        document.getElementById('bill-total-display').innerText = total.toFixed(2);
    } else sect.style.display = 'none';
}

function removeItem(index) { currentBillItems.splice(index, 1); renderBillTable(); }

async function finalizeBill() {
    const cust = document.getElementById('bill-cust-name').value;
    if (!cust || currentBillItems.length === 0) return alert("Missing Info");
    let total = 0; const date = new Date().toLocaleString();
    for (let item of currentBillItems) {
        total += (item.price * item.qty);
        if (item.id) { try { let p = await db.get(item.id); p.totalSold = (p.totalSold || 0) + item.qty; await db.put(p); } catch (e) { } }
    }
    await db.put({ _id: 'ledger_' + Date.now(), customer: cust, amount: total, items: [...currentBillItems], type: 'invoice', category: 'ledger', date });
    generatePDF(cust, date, currentBillItems, total);
    alert("Bill Saved & PDF Generated!"); clearAndBack(); uploadToDrive();
}

function generatePDF(cust, date, items, total) {
    const { jsPDF } = window.jspdf; const doc = new jsPDF();
    doc.setFontSize(22); doc.text("WORKSHOP INVOICE", 105, 20, { align: "center" });
    doc.setFontSize(12); doc.text(`Customer: ${cust}`, 20, 40); doc.text(`Date: ${date}`, 20, 50);
    doc.line(20, 55, 190, 55); let y = 65;
    doc.text("Item Description", 20, y); doc.text("Qty", 120, y); doc.text("Total (Rs)", 160, y);
    y += 10; items.forEach(i => { doc.text(i.desc, 20, y); doc.text(i.qty.toString(), 120, y); doc.text((i.price * i.qty).toFixed(2), 160, y); y += 10; });
    doc.line(20, y, 190, y); doc.setFontSize(14); doc.text(`Grand Total: Rs. ${total.toFixed(2)}`, 140, y + 15);
    doc.save(`Invoice_${cust}.pdf`);
}

// --- DATA HANDLERS ---
async function savePart() {
    const id = document.getElementById('part-id').value, name = document.getElementById('part-name').value;
    const price = parseFloat(document.getElementById('part-price').value) || 0, qty = parseInt(document.getElementById('part-qty').value) || 0;
    if (!id || !name) return alert("Details missing");
    let doc = { _id: id, name, price, totalIn: qty, totalSold: 0, category: 'inventory' };
    try { const ex = await db.get(id); doc._rev = ex._rev; doc.totalIn = (ex.totalIn || 0) + qty; doc.totalSold = ex.totalSold || 0; } catch (e) { }
    await db.put(doc); uploadToDrive(); alert("Stock Updated"); clearAndBack();
}

async function updateInventoryUI() {
    const res = await db.allDocs({ include_docs: true }), list = document.getElementById('inventory-list-table'), q = (document.getElementById('stock-search')?.value || "").toLowerCase();
    list.innerHTML = ""; res.rows.forEach(r => { const d = r.doc; if (d.category === 'inventory' && (d.name.toLowerCase().includes(q) || d._id.toLowerCase().includes(q))) list.innerHTML += `<tr><td>${d.name}</td><td>${d.totalIn}</td><td>${d.totalSold}</td><td><strong>${d.totalIn - d.totalSold}</strong></td></tr>`; });
}

async function updateLedgerUI() {
    const res = await db.allDocs({ include_docs: true }), bals = {}, hist = document.getElementById('bill-history-list'), q = (document.getElementById('history-search')?.value || "").toLowerCase();
    hist.innerHTML = "";
    res.rows.forEach(r => {
        const d = r.doc;
        if (d.category === 'ledger') {
            bals[d.customer] = (bals[d.customer] || 0) + (d.type === 'invoice' ? d.amount : -d.amount);
            if (d.type === 'invoice' && (d.customer.toLowerCase().includes(q) || d.items.some(i => i.desc.toLowerCase().includes(q)))) {
                hist.innerHTML += `<div class="ledger-card"><strong>${d.date}</strong><br>Cust: ${d.customer}<br>Items: ${d.items.map(i => i.desc).join(", ")}<br>Total: ₹${d.amount.toFixed(2)}</div>`;
            }
        }
    });
    const list = document.getElementById('customer-list'); list.innerHTML = "";
    for (let c in bals) { list.innerHTML += `<div class="ledger-card"><strong>${c}</strong>: ₹${Math.abs(bals[c]).toFixed(2)}</div>`; }
}

function handleSync() { if (!accessToken) tokenClient.requestAccessToken({ prompt: 'consent' }); else uploadToDrive(); }
async function uploadToDrive() {
    if (!navigator.onLine || !accessToken) return;
    document.getElementById('sync-status').innerText = "Syncing...";
    try {
        const res = await db.allDocs({ include_docs: true }), content = JSON.stringify(res.rows.map(r => r.doc));
        const search = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='workshop_db_backup.json'`, { headers: { 'Authorization': 'Bearer ' + accessToken } });
        const sRes = await search.json(), exist = sRes.files && sRes.files[0];
        let url = exist ? `https://www.googleapis.com/upload/drive/v3/files/${exist.id}?uploadType=media` : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=media';
        await fetch(url, { method: exist ? 'PATCH' : 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: new Blob([content], { type: 'application/json' }) });
        document.getElementById('sync-status').innerText = "Synced: " + new Date().toLocaleTimeString();
    } catch (e) { document.getElementById('sync-status').innerText = "Sync Failed"; }
}
function changeQty(id, n) { const q = document.getElementById(id); let v = parseInt(q.value) || 1; if (v + n >= 1) q.value = v + n; }
function playBeep() { const ctx = new AudioContext(), osc = ctx.createOscillator(); osc.connect(ctx.destination); osc.frequency.value = 1000; osc.start(); osc.stop(ctx.currentTime + 0.1); }