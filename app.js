const db = new PouchDB('workshop_db');
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let accessToken = localStorage.getItem('drive_token'), html5QrCode, currentBillItems = [];

function handleSync() {
    if (accessToken) {
        uploadToDrive();
    } else {
        const redirectUri = window.location.origin + window.location.pathname;
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(SCOPES)}&include_granted_scopes=true&prompt=consent`;
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

// FORCE MERGE HELPER
async function forcePut(doc) {
    try {
        const local = await db.get(doc._id);
        return await db.put({ ...doc, _rev: local._rev });
    } catch (e) {
        if (e.status === 404) return await db.put(doc);
        if (e.status === 409) {
            const latest = await db.get(doc._id);
            return await db.put({ ...doc, _rev: latest._rev });
        }
        throw e;
    }
}

async function uploadToDrive() {
    if (!navigator.onLine || !accessToken) return;
    document.getElementById('sync-status').innerText = "Status: Connecting...";

    try {
        const headers = { 'Authorization': `Bearer ${accessToken}` };
        const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='workshop_db_backup.json' and trashed=false&fields=files(id)`, { headers });
        const searchData = await searchRes.json();
        const fileId = searchData.files?.[0]?.id;

        if (fileId) {
            document.getElementById('sync-status').innerText = "Status: Downloading...";
            const download = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers });
            const cloudData = await download.json();

            // USE FORCE PUT TO HANDLE CONFLICTS LIKE 8901030814778
            for (let doc of cloudData) {
                await forcePut(doc);
            }
            updateInventoryUI();
            updateLedgerUI();
        }

        document.getElementById('sync-status').innerText = "Status: Uploading...";
        const localDocs = await db.allDocs({ include_docs: true });
        const jsonData = JSON.stringify(localDocs.rows.map(r => r.doc));
        const metadata = { name: 'workshop_db_backup.json', mimeType: 'application/json' };

        let url, method, body;
        if (fileId) {
            url = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
            method = 'PATCH';
            body = jsonData;
        } else {
            url = `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
            method = 'POST';
            const boundary = 'workshop_sep';
            headers['Content-Type'] = `multipart/related; boundary=${boundary}`;
            body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${jsonData}\r\n--${boundary}--`;
        }

        const upRes = await fetch(url, { method, headers, body });
        if (upRes.ok) {
            document.getElementById('sync-status').innerText = "Status: Synced " + new Date().toLocaleTimeString();
        } else {
            throw new Error("Upload Error");
        }
    } catch (e) {
        console.error("Sync error:", e);
        document.getElementById('sync-status').innerText = "Sync Error: retrying...";
        setTimeout(uploadToDrive, 3000);
    }
}

// --- SCANNER & FILE ---
function scanFile(input, type) {
    if (input.files.length === 0) return;
    const readerId = type === 'inventory' ? 'reader' : 'bill-reader';
    const scanner = new Html5Qrcode(readerId);
    scanner.scanFile(input.files[0], true)
        .then(text => handleScanResult(text, type))
        .catch(() => alert("No barcode found."));
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

// --- NAVIGATION & UI ---
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

async function savePart() {
    const id = document.getElementById('part-id').value, name = document.getElementById('part-name').value;
    const price = parseFloat(document.getElementById('part-price').value) || 0, qty = parseInt(document.getElementById('part-qty').value) || 0;
    if (!id || !name) return alert("Fill all fields");

    try {
        let doc;
        try { doc = await db.get(id); } catch (e) { doc = { _id: id, totalIn: 0, totalSold: 0, category: 'inventory' }; }
        doc.name = name; doc.price = price; doc.totalIn += qty;
        await forcePut(doc);
        alert("Saved");
        uploadToDrive();
    } catch (e) { alert("Save error"); }
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
        try {
            const res = await db.allDocs({ include_docs: true });
            const row = res.rows.find(r => r.doc.name === item.desc && r.doc.category === 'inventory');
            if (row) { let doc = row.doc; doc.totalSold += item.qty; await forcePut(doc); }
        } catch (e) { }
    }
    await db.put({ _id: 'ledger_' + Date.now(), customer: cust, amount: parseFloat(document.getElementById('bill-total-display').innerText), date: new Date().toLocaleString(), category: 'ledger' });
    alert("Bill Finalized");
    currentBillItems = [];
    document.getElementById('current-items-section').style.display = 'none';
    uploadToDrive();
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
        if (!list) return;
        list.innerHTML = "";
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