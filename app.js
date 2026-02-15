const db = new PouchDB('workshop_db');
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let accessToken = localStorage.getItem('drive_token'), html5QrCode, currentBillItems = [];

function handleSync() {
    const redirectUri = window.location.origin + window.location.pathname;
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(SCOPES)}&include_granted_scopes=true`;

    if (accessToken) {
        uploadToDrive();
    } else {
        window.location.href = authUrl;
    }
}

window.onload = () => {
    if (window.location.hash) {
        const params = new URLSearchParams(window.location.hash.substring(1));
        const token = params.get("access_token");
        if (token) {
            accessToken = token;
            localStorage.setItem('drive_token', token);
            window.history.replaceState(null, null, window.location.pathname);
        }
    }
    if (accessToken) {
        document.getElementById('sync-status').innerText = "Status: Authenticated";
        uploadToDrive();
    }
};

async function forceSave(doc) {
    try {
        await db.put(doc);
    } catch (err) {
        if (err.status === 409) {
            const existingDoc = await db.get(doc._id);
            doc._rev = existingDoc._rev;
            await db.put(doc);
        } else {
            throw err;
        }
    }
}

async function uploadToDrive() {
    if (!navigator.onLine || !accessToken) return;
    document.getElementById('sync-status').innerText = "Status: Connecting...";
    try {
        const headers = { 'Authorization': `Bearer ${accessToken}` };
        const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='workshop_db_backup.json' and trashed=false&fields=files(id)`, { headers });
        if (searchRes.status === 401) {
            accessToken = null; localStorage.removeItem('drive_token');
            handleSync(); return;
        }
        const searchData = await searchRes.json();
        const fileId = searchData.files?.[0]?.id;
        if (fileId) {
            const download = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers });
            const cloudData = await download.json();
            for (let doc of cloudData) { delete doc._rev; await forceSave(doc); }
            updateInventoryUI(); updateLedgerUI();
        }
        const localDocs = await db.allDocs({ include_docs: true });
        const jsonData = JSON.stringify(localDocs.rows.map(r => r.doc));
        const metadata = { name: 'workshop_db_backup.json', mimeType: 'application/json' };
        let url, method, body;
        if (fileId) {
            url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
            method = 'PATCH'; body = jsonData;
        } else {
            url = `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
            method = 'POST';
            const boundary = 'workshop_sep';
            headers['Content-Type'] = `multipart/related; boundary=${boundary}`;
            body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${jsonData}\r\n--${boundary}--`;
        }
        const upRes = await fetch(url, { method, headers, body });
        if (upRes.ok) document.getElementById('sync-status').innerText = "Synced " + new Date().toLocaleTimeString();
    } catch (e) { document.getElementById('sync-status').innerText = "Sync Error"; }
}

// --- SCANNER ---
function scanFile(input, type) {
    if (input.files.length === 0) return;
    const scanner = new Html5Qrcode(type === 'inventory' ? 'reader' : 'bill-reader');
    scanner.scanFile(input.files[0], true).then(text => handleScanResult(text, type)).catch(() => alert("No barcode found."));
}

function handleScanResult(text, type) {
    const idField = type === 'inventory' ? 'part-id' : 'bill-item-id';
    document.getElementById(idField).value = text;
    db.get(text).then(doc => {
        if (type === 'bill') {
            document.getElementById('bill-desc').value = doc.name;
            document.getElementById('bill-price').value = doc.price;
        } else {
            document.getElementById('part-name').value = doc.name;
            document.getElementById('part-price').value = doc.price;
        }
    }).catch(() => { });
}

async function toggleScanner(type) {
    const id = type === 'inventory' ? 'reader' : 'bill-reader';
    if (!html5QrCode) html5QrCode = new Html5Qrcode(id);
    html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, (text) => {
        handleScanResult(text, type);
        html5QrCode.stop();
    });
}

// --- CORE LOGIC: PREVENT DUPLICATES ---
async function savePart() {
    const id = document.getElementById('part-id').value;
    const name = document.getElementById('part-name').value.trim();
    const price = parseFloat(document.getElementById('part-price').value) || 0;
    const qty = parseInt(document.getElementById('part-qty').value) || 0;

    if (!id || !name) return alert("Fill ID and Name");

    try {
        // Search if this name already exists under a DIFFERENT ID
        const all = await db.allDocs({ include_docs: true });
        const existing = all.rows.find(r => r.doc.category === 'inventory' && r.doc.name.toLowerCase() === name.toLowerCase());

        let doc;
        if (existing) {
            // Update existing record even if the ID is different from scanned ID
            doc = existing.doc;
            doc.price = price;
            doc.totalIn += qty;
        } else {
            // Create new record
            try {
                doc = await db.get(id);
                doc.totalIn += qty;
                doc.price = price;
            } catch (e) {
                doc = { _id: id, name: name, price: price, totalIn: qty, totalSold: 0, category: 'inventory' };
            }
        }

        await forceSave(doc);
        alert("Stock Updated");
        uploadToDrive();
    } catch (e) { alert("Save Error"); }
}

function addItemToCurrentBill() {
    const d = document.getElementById('bill-desc').value, p = parseFloat(document.getElementById('bill-price').value) || 0, q = parseInt(document.getElementById('bill-qty').value) || 1;
    if (!d) return;
    currentBillItems.push({ desc: d, price: p, qty: q });
    renderBillList();
}

function renderBillList() {
    const body = document.getElementById('current-bill-body');
    let total = 0; body.innerHTML = "";
    currentBillItems.forEach(i => {
        total += (i.price * i.qty);
        body.innerHTML += `<tr><td>${i.desc}</td><td>${i.qty}</td><td>₹${i.price * i.qty}</td></tr>`;
    });
    document.getElementById('bill-total-display').innerText = total;
    document.getElementById('current-items-section').style.display = 'block';
}

async function finalizeBill() {
    const cust = document.getElementById('bill-cust-name').value;
    if (!cust || currentBillItems.length === 0) return alert("Details missing");
    for (let item of currentBillItems) {
        const res = await db.allDocs({ include_docs: true });
        const row = res.rows.find(r => r.doc.name === item.desc && r.doc.category === 'inventory');
        if (row) { let doc = row.doc; doc.totalSold += item.qty; await forceSave(doc); }
    }
    await db.put({ _id: 'ledger_' + Date.now(), customer: cust, amount: parseFloat(document.getElementById('bill-total-display').innerText), date: new Date().toLocaleString(), category: 'ledger' });
    alert("Bill Finalized");
    currentBillItems = [];
    document.getElementById('current-items-section').style.display = 'none';
    uploadToDrive();
}

// --- UI HELPERS ---
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
    document.getElementById(id).style.display = 'block';
    if (id === 'stock-list-screen') updateInventoryUI();
    if (id === 'ledger-screen') updateLedgerUI();
}

function clearAndBack() {
    if (html5QrCode) html5QrCode.stop().catch(() => { });
    document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
    document.getElementById('main-menu').style.display = 'block';
}

function updateInventoryUI() {
    db.allDocs({ include_docs: true }).then(res => {
        const table = document.getElementById('inventory-list-table');
        if (!table) return;
        table.innerHTML = "";
        res.rows.forEach(r => {
            if (r.doc.category === 'inventory') {
                table.innerHTML += `<tr><td>${r.doc.name}</td><td>${r.doc.totalIn}</td><td>${r.doc.totalIn - r.doc.totalSold}</td><td><button onclick="delDoc('${r.doc._id}')" class="del-btn">✕</button></td></tr>`;
            }
        });
    });
}

function updateLedgerUI() {
    db.allDocs({ include_docs: true }).then(res => {
        const list = document.getElementById('bill-history-list');
        if (!list) return; list.innerHTML = "";
        res.rows.forEach(r => {
            if (r.doc.category === 'ledger') {
                list.innerHTML += `<div class="ledger-card"><b>${r.doc.customer}</b>: ₹${r.doc.amount}<br><small>${r.doc.date}</small></div>`;
            }
        });
    });
}

async function delDoc(id) {
    if (confirm("Delete?")) {
        const doc = await db.get(id);
        await db.remove(doc);
        updateInventoryUI();
        uploadToDrive();
    }
}

function changeQty(id, n) {
    let el = document.getElementById(id), v = parseInt(el.value) || 1;
    if (v + n >= 1) el.value = v + n;
}