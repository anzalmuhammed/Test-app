const db = new PouchDB('workshop_db');
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let tokenClient, accessToken = localStorage.getItem('drive_token'), html5QrCode, currentBillItems = [];

// NAVIGATION
window.addEventListener('load', () => window.history.pushState({ screen: 'main-menu' }, ''));
window.onpopstate = (e) => {
    if (e.state && e.state.screen) switchToScreenLogic(e.state.screen);
    else clearAndBack(true);
};

function showScreen(id) {
    switchToScreenLogic(id);
    window.history.pushState({ screen: id }, '');
}

function switchToScreenLogic(id) {
    document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
    document.getElementById(id).style.display = 'block';
    if (id === 'stock-list-screen') updateInventoryUI();
    if (id === 'ledger-screen') updateLedgerUI();
}

function clearAndBack(isPop = false) {
    if (html5QrCode) html5QrCode.stop().catch(() => { });
    resetFormFields();
    switchToScreenLogic('main-menu');
    if (!isPop) window.history.pushState({ screen: 'main-menu' }, '');
}

function resetFormFields() {
    document.querySelectorAll('input').forEach(i => {
        if (i.type !== 'file') i.value = (i.id.includes('qty')) ? "1" : "";
    });
    document.getElementById('current-items-section').style.display = 'none';
    document.getElementById('bill-stock-warning').style.display = 'none';
    currentBillItems = [];
}

// SYNC LOGIC
async function uploadToDrive() {
    if (!navigator.onLine || !accessToken) return;
    document.getElementById('sync-status').innerText = "Status: Syncing...";
    try {
        const search = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='workshop_db_backup.json'&fields=files(id)`, { headers: { 'Authorization': 'Bearer ' + accessToken } });
        const sRes = await search.json();
        const driveFile = sRes.files && sRes.files[0];

        // MERGE DRIVE -> LOCAL
        if (driveFile) {
            const download = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFile.id}?alt=media`, { headers: { 'Authorization': 'Bearer ' + accessToken } });
            const driveData = await download.json();
            for (let doc of driveData) {
                try {
                    const localDoc = await db.get(doc._id);
                    await db.put({ ...doc, _rev: localDoc._rev });
                } catch { await db.put(doc); }
            }
        }

        // UPLOAD LOCAL -> DRIVE
        const local = await db.allDocs({ include_docs: true });
        const content = JSON.stringify(local.rows.map(r => r.doc));
        let url = driveFile ? `https://www.googleapis.com/upload/drive/v3/files/${driveFile.id}?uploadType=media` : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=media';
        await fetch(url, { method: driveFile ? 'PATCH' : 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: new Blob([content]) });
        document.getElementById('sync-status').innerText = "Status: Fully Synced " + new Date().toLocaleTimeString();
    } catch (e) {
        document.getElementById('sync-status').innerText = "Status: Sync Pending";
        if (e.status === 401) handleSync(); // Token expired, re-login
    }
}

// DATA UPDATES
async function savePart() {
    const id = document.getElementById('part-id').value, name = document.getElementById('part-name').value;
    const price = parseFloat(document.getElementById('part-price').value) || 0, qty = parseInt(document.getElementById('part-qty').value) || 0;
    if (!id || !name) return alert("Fill Name and ID");
    try {
        const doc = await db.get(id);
        await db.put({ ...doc, name, price, totalIn: (doc.totalIn || 0) + qty });
    } catch {
        await db.put({ _id: id, name, price, totalIn: qty, totalSold: 0, category: 'inventory' });
    }
    alert("Stock Added!");
    resetFormFields();
    uploadToDrive();
}

async function finalizeBill() {
    const cust = document.getElementById('bill-cust-name').value;
    if (!cust || currentBillItems.length === 0) return alert("Details missing");
    const allDocs = await db.allDocs({ include_docs: true });
    let updated = [];
    for (let item of currentBillItems) {
        const row = allDocs.rows.find(r => r.doc.name === item.desc && r.doc.category === 'inventory');
        if (!row) continue;
        let d = row.doc;
        d.totalSold += item.qty; updated.push(d);
    }
    for (let d of updated) await db.put(d);
    await db.put({ _id: 'ledger_' + Date.now(), customer: cust, amount: parseFloat(document.getElementById('bill-total-display').innerText), items: [...currentBillItems], category: 'ledger', date: new Date().toLocaleString() });

    alert("Bill Saved!");
    resetFormFields();
    uploadToDrive();
}

// SCANNER
async function toggleScanner(type) {
    const readerId = type === 'inventory' ? 'reader' : 'bill-reader';
    const btnId = type === 'inventory' ? 'inv-cam-btn' : 'bill-cam-btn';
    if (!html5QrCode) html5QrCode = new Html5Qrcode(readerId);
    if (document.getElementById(btnId).innerText.includes("Start")) {
        html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, (text) => {
            handleScanResult(text, type); html5QrCode.stop(); document.getElementById(btnId).innerText = "Start Camera";
        });
        document.getElementById(btnId).innerText = "Stop Camera";
    } else {
        await html5QrCode.stop(); document.getElementById(btnId).innerText = "Start Camera";
    }
}

function scanFile(input, type) {
    if (input.files.length === 0) return;
    const readerId = type === 'inventory' ? "reader" : "bill-reader";
    const tempScanner = new Html5Qrcode(readerId);
    tempScanner.scanFile(input.files[0], true).then(text => handleScanResult(text, type)).catch(() => alert("No barcode found"));
}

function handleScanResult(text, type) {
    const idField = type === 'inventory' ? 'part-id' : 'bill-item-id';
    document.getElementById(idField).value = text;
    db.get(text).then(doc => {
        if (type === 'bill') {
            document.getElementById('bill-desc').value = doc.name;
            document.getElementById('bill-price').value = doc.price;
            document.getElementById('bill-stock-warning').innerText = `Stock: ${doc.totalIn - doc.totalSold}`;
            document.getElementById('bill-stock-warning').style.display = 'block';
        } else {
            document.getElementById('part-name').value = doc.name;
            document.getElementById('part-price').value = doc.price;
        }
    }).catch(() => { });
}

function addItemToCurrentBill() {
    const d = document.getElementById('bill-desc').value, p = parseFloat(document.getElementById('bill-price').value) || 0, q = parseInt(document.getElementById('bill-qty').value) || 1;
    if (!d) return;
    currentBillItems.push({ desc: d, price: p, qty: q });
    let total = 0; const body = document.getElementById('current-bill-body'); body.innerHTML = "";
    currentBillItems.forEach(i => { total += (i.price * i.qty); body.innerHTML += `<tr><td>${i.desc}</td><td>${i.qty}</td><td>₹${i.price * i.qty}</td></tr>`; });
    document.getElementById('bill-total-display').innerText = total.toFixed(2);
    document.getElementById('current-items-section').style.display = 'block';
}

function changeQty(id, n) { let el = document.getElementById(id), v = parseInt(el.value) || 1; if (v + n >= 1) el.value = v + n; }

function updateInventoryUI() {
    db.allDocs({ include_docs: true }).then(res => {
        const list = document.getElementById('inventory-list-table'); list.innerHTML = "";
        res.rows.forEach(r => {
            if (r.doc.category === 'inventory') {
                const stock = r.doc.totalIn - r.doc.totalSold;
                list.innerHTML += `<tr><td>${r.doc.name}</td><td>${r.doc.totalIn}</td><td>${stock}</td><td><button onclick="delDoc('${r.doc._id}')" class="del-btn">✕</button></td></tr>`;
            }
        });
    });
}
async function delDoc(id) { if (confirm("Delete?")) { const d = await db.get(id); await db.remove(d); updateInventoryUI(); uploadToDrive(); } }

function updateLedgerUI() {
    db.allDocs({ include_docs: true }).then(res => {
        const list = document.getElementById('bill-history-list'); list.innerHTML = "";
        res.rows.forEach(r => { if (r.doc.category === 'ledger') list.innerHTML += `<div class="ledger-card"><b>${r.doc.customer}</b>: ₹${r.doc.amount} <br><small>${r.doc.date}</small></div>`; });
    });
}

// AUTH & BOOTSTRAP
function handleSync() { tokenClient.requestAccessToken({ prompt: 'consent' }); }

window.onload = () => {
    gapi.load('client', () => gapi.client.init({ discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"] }));
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPES,
        callback: (res) => {
            accessToken = res.access_token;
            localStorage.setItem('drive_token', accessToken);
            uploadToDrive();
        }
    });
    if (accessToken) uploadToDrive();
};