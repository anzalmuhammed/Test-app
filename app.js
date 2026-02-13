const db = new PouchDB('workshop_db');
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let tokenClient, accessToken = sessionStorage.getItem('drive_token'), html5QrCode, currentBillItems = [];

// NAVIGATION
window.addEventListener('load', () => window.history.replaceState({ screen: 'main-menu' }, ''));
window.onpopstate = () => clearAndBack(true);

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
    document.getElementById(id).style.display = 'block';
    window.history.pushState({ screen: id }, '');
    if (id === 'stock-list-screen') updateInventoryUI();
    if (id === 'ledger-screen') updateLedgerUI();
}

function clearAndBack(isHardwareBack = false) {
    if (html5QrCode) html5QrCode.stop().catch(() => { });
    document.querySelectorAll('input').forEach(i => {
        if (i.type !== 'file') i.value = i.id.includes('qty') ? "1" : "";
    });
    document.getElementById('bill-stock-warning').style.display = 'none';
    currentBillItems = [];
    const billSection = document.getElementById('current-items-section');
    if (billSection) billSection.style.display = 'none';
    document.getElementById('inv-cam-btn').innerText = "Start Camera";
    document.getElementById('bill-cam-btn').innerText = "Start Camera";
    document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
    document.getElementById('main-menu').style.display = 'block';
    if (!isHardwareBack) window.history.pushState({ screen: 'main-menu' }, '');
}

// SCANNER LOGIC
async function toggleScanner(type) {
    const btnId = type === 'inventory' ? 'inv-cam-btn' : 'bill-cam-btn';
    const readerId = type === 'inventory' ? 'reader' : 'bill-reader';
    const btn = document.getElementById(btnId);
    if (btn.innerText.includes("Start") || btn.innerText.includes("Another")) {
        if (!html5QrCode) html5QrCode = new Html5Qrcode(readerId);
        html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, (text) => {
            playBeep(); handleScanResult(text, type);
            html5QrCode.stop().then(() => { btn.innerText = "Scan Another"; });
        }).catch(() => { btn.innerText = "Start Camera"; });
        btn.innerText = "Stop Camera";
    } else {
        if (html5QrCode) await html5QrCode.stop();
        btn.innerText = "Start Camera";
    }
}

function scanFile(input, type) {
    if (input.files.length === 0) return;
    if (!html5QrCode) html5QrCode = new Html5Qrcode(type === 'inventory' ? "reader" : "bill-reader");
    html5QrCode.scanFile(input.files[0], true).then(text => {
        playBeep(); handleScanResult(text, type);
    }).catch(() => alert("No barcode found."));
}

function handleScanResult(text, type) {
    const idF = type === 'inventory' ? 'part-id' : 'bill-item-id';
    const nameF = type === 'inventory' ? 'part-name' : 'bill-desc';
    const priceF = type === 'inventory' ? 'part-price' : 'bill-price';
    document.getElementById(idF).value = text;

    db.get(text).then(doc => {
        document.getElementById(nameF).value = doc.name;
        document.getElementById(priceF).value = doc.price;
        if (type === 'bill') {
            const left = doc.totalIn - (doc.totalSold || 0);
            const warn = document.getElementById('bill-stock-warning');
            warn.innerText = `Current Stock Left: ${left}`;
            warn.style.display = 'block';
            warn.style.color = left <= 5 ? '#ef4444' : '#fbbf24';
        }
    }).catch(() => {
        if (type === 'bill') document.getElementById('bill-stock-warning').style.display = 'none';
    });
}

function changeQty(id, n) {
    const el = document.getElementById(id);
    let val = parseInt(el.value) || 1;
    if (val + n >= 1) el.value = val + n;
}

// INVENTORY LOGIC
async function savePart() {
    const id = document.getElementById('part-id').value, name = document.getElementById('part-name').value;
    const price = parseFloat(document.getElementById('part-price').value) || 0, qty = parseInt(document.getElementById('part-qty').value) || 0;
    if (!id || !name) return alert("Fill ID and Name");
    try {
        const doc = await db.get(id);
        await db.put({ ...doc, name, price, totalIn: (doc.totalIn || 0) + qty });
    } catch {
        await db.put({ _id: id, name, price, totalIn: qty, totalSold: 0, category: 'inventory' });
    }
    alert("Saved!"); clearAndBack(); uploadToDrive();
}

// BILLING LOGIC
function addItemToCurrentBill() {
    const desc = document.getElementById('bill-desc').value, price = parseFloat(document.getElementById('bill-price').value) || 0, qty = parseInt(document.getElementById('bill-qty').value) || 1;
    if (!desc) return;
    currentBillItems.push({ desc, price, qty });
    renderBillTable();
    ['bill-desc', 'bill-price', 'bill-item-id'].forEach(k => document.getElementById(k).value = "");
    document.getElementById('bill-qty').value = "1";
    document.getElementById('bill-stock-warning').style.display = 'none';
}

function renderBillTable() {
    const body = document.getElementById('current-bill-body'); body.innerHTML = ""; let t = 0;
    currentBillItems.forEach(i => { t += (i.price * i.qty); body.innerHTML += `<tr><td>${i.desc}</td><td>${i.qty}</td><td>₹${i.price * i.qty}</td></tr>`; });
    document.getElementById('bill-total-display').innerText = t.toFixed(2);
    document.getElementById('current-items-section').style.display = 'block';
}

async function finalizeBill() {
    const cust = document.getElementById('bill-cust-name').value;
    if (!cust || currentBillItems.length === 0) return alert("Missing Customer or Items");

    const allDocs = await db.allDocs({ include_docs: true });
    let updatedDocs = [];

    for (let item of currentBillItems) {
        const row = allDocs.rows.find(r => r.doc.name === item.desc && r.doc.category === 'inventory');
        if (!row) return alert(`Item "${item.desc}" not found in stock!`);
        let d = row.doc;
        let avail = d.totalIn - (d.totalSold || 0);
        if (avail < item.qty) return alert(`Insufficient Stock for ${item.desc}! Only ${avail} left.`);
        d.totalSold = (d.totalSold || 0) + item.qty;
        updatedDocs.push(d);
    }

    for (let doc of updatedDocs) await db.put(doc);
    await db.put({ _id: 'ledger_' + Date.now(), customer: cust, amount: parseFloat(document.getElementById('bill-total-display').innerText), items: [...currentBillItems], category: 'ledger', date: new Date().toLocaleString() });

    const { jsPDF } = window.jspdf; const doc = new jsPDF();
    doc.text(`Invoice: ${cust}`, 20, 20);
    let y = 40; currentBillItems.forEach(i => { doc.text(`${i.desc} x${i.qty} = Rs. ${i.price * i.qty}`, 20, y); y += 10; });
    doc.text(`Total: Rs. ${document.getElementById('bill-total-display').innerText}`, 20, y + 10);
    doc.save(`Bill_${cust}.pdf`);
    alert("Bill Finalized!"); clearAndBack(); uploadToDrive();
}

// UI UPDATES & EXPORT
function updateInventoryUI() {
    const query = document.getElementById('stock-search').value.toLowerCase();
    db.allDocs({ include_docs: true }).then(res => {
        const list = document.getElementById('inventory-list-table'); list.innerHTML = "";
        res.rows.forEach(r => {
            const d = r.doc;
            if (d.category === 'inventory' && d.name.toLowerCase().includes(query)) {
                const stockLeft = Math.max(0, d.totalIn - d.totalSold);
                const rowStyle = stockLeft <= 5 ? 'style="color: #ef4444; font-weight: bold;"' : '';
                list.innerHTML += `<tr ${rowStyle}><td>${d.name}</td><td>${d.totalIn}</td><td>${stockLeft}</td><td><button onclick="deleteStock('${d._id}')" class="del-btn">✕</button></td></tr>`;
            }
        });
    });
}

function updateLedgerUI() {
    const query = document.getElementById('ledger-search').value.toLowerCase();
    db.allDocs({ include_docs: true }).then(res => {
        const hist = document.getElementById('bill-history-list'); hist.innerHTML = "";
        res.rows.forEach(r => {
            if (r.doc.category === 'ledger' && r.doc.customer.toLowerCase().includes(query)) {
                hist.innerHTML += `<div class="ledger-card"><strong>${r.doc.date}</strong><br>${r.doc.customer}: ₹${r.doc.amount}</div>`;
            }
        });
    });
}

async function exportStockCSV() {
    const res = await db.allDocs({ include_docs: true });
    let csv = "Item Name,Total In,Total Sold,Remaining\n";
    res.rows.forEach(r => {
        if (r.doc.category === 'inventory') {
            csv += `"${r.doc.name}",${r.doc.totalIn},${r.doc.totalSold},${Math.max(0, r.doc.totalIn - r.doc.totalSold)}\n`;
        }
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `Stock_Report.csv`; a.click();
}

// SAFE CLOUD SYNC
async function uploadToDrive() {
    if (!navigator.onLine || !accessToken) return;
    document.getElementById('sync-status').innerText = "Status: Checking Cloud...";
    try {
        const search = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='workshop_db_backup.json'&fields=files(id)`, { headers: { 'Authorization': 'Bearer ' + accessToken } });
        const sRes = await search.json();
        const driveFile = sRes.files && sRes.files[0];

        if (driveFile) {
            const download = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFile.id}?alt=media`, { headers: { 'Authorization': 'Bearer ' + accessToken } });
            const driveData = await download.json();
            for (let doc of driveData) {
                try { await db.put(doc); } catch (e) { } // PouchDB handles conflict
            }
        }

        const local = await db.allDocs({ include_docs: true });
        const content = JSON.stringify(local.rows.map(r => r.doc));
        let url = driveFile ? `https://www.googleapis.com/upload/drive/v3/files/${driveFile.id}?uploadType=media` : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=media';

        await fetch(url, { method: driveFile ? 'PATCH' : 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: new Blob([content], { type: 'application/json' }) });
        document.getElementById('sync-status').innerText = "Status: Cloud Synced " + new Date().toLocaleTimeString();
    } catch (e) { document.getElementById('sync-status').innerText = "Status: Sync Error"; }
}

async function deleteStock(id) {
    if (confirm("Delete item?")) { const doc = await db.get(id); await db.remove(doc); updateInventoryUI(); uploadToDrive(); }
}

window.addEventListener('online', uploadToDrive);
function handleSync() { if (!accessToken) tokenClient.requestAccessToken({ prompt: 'consent' }); else uploadToDrive(); }
function playBeep() { const ctx = new AudioContext(), osc = ctx.createOscillator(); osc.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.1); }

window.onload = () => {
    gapi.load('client', () => gapi.client.init({ discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"] }));
    tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPES, callback: (res) => { accessToken = res.access_token; sessionStorage.setItem('drive_token', accessToken); uploadToDrive(); } });
};