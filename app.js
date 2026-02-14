const db = new PouchDB('workshop_db');
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let tokenClient, accessToken = localStorage.getItem('drive_token'), html5QrCode, currentBillItems = [];
let lastBackPress = 0;

// --- NAVIGATION & DOUBLE TAP EXIT ---
window.addEventListener('load', () => {
    window.history.replaceState({ screen: 'main-menu' }, '');
});

window.onpopstate = (event) => {
    const activeScreen = document.querySelector('.screen[style*="display: block"]')?.id;
    if (!activeScreen || activeScreen === 'main-menu') {
        const now = Date.now();
        if (now - lastBackPress < 2000) {
            // Exit handled by OS
        } else {
            lastBackPress = now;
            alert("Press back again to exit");
            window.history.pushState({ screen: 'main-menu' }, '');
        }
    } else {
        clearAndBack();
    }
};

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
    document.getElementById(id).style.display = 'block';
    if (id === 'stock-list-screen') updateInventoryUI();
    if (id === 'ledger-screen') updateLedgerUI();
    window.history.pushState({ screen: id }, '');
}

function clearAndBack() {
    if (html5QrCode) html5QrCode.stop().catch(() => { });
    hardResetFields();
    document.querySelectorAll('.screen').forEach(s => s.style.display = 'none');
    document.getElementById('main-menu').style.display = 'block';
    window.history.replaceState({ screen: 'main-menu' }, '');
}

function hardResetFields() {
    document.querySelectorAll('input').forEach(i => {
        if (i.type !== 'file') i.value = i.id.includes('qty') ? "1" : "";
    });
    document.getElementById('current-items-section').style.display = 'none';
    document.getElementById('bill-stock-warning').style.display = 'none';
    currentBillItems = [];
}

// --- SCANNER LOGIC ---
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
    const scanner = new Html5Qrcode(type === 'inventory' ? "reader" : "bill-reader");
    scanner.scanFile(input.files[0], true).then(text => handleScanResult(text, type)).catch(() => alert("No barcode found"));
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

// --- DATA OPERATIONS (CONFLICT RESISTANT) ---
async function savePart() {
    const id = document.getElementById('part-id').value, name = document.getElementById('part-name').value;
    const price = parseFloat(document.getElementById('part-price').value) || 0, qty = parseInt(document.getElementById('part-qty').value) || 0;
    if (!id || !name) return alert("Missing fields");

    const runSave = async () => {
        try {
            let doc;
            try { doc = await db.get(id); } catch (e) { doc = { _id: id, totalIn: 0, totalSold: 0, category: 'inventory' }; }
            doc.name = name; doc.price = price; doc.totalIn += qty;
            await db.put(doc);
            alert("Saved"); hardResetFields(); uploadToDrive();
        } catch (err) {
            if (err.status === 409) return runSave();
            alert("Save Error: " + err.message);
        }
    };
    runSave();
}

function addItemToCurrentBill() {
    const d = document.getElementById('bill-desc').value, p = parseFloat(document.getElementById('bill-price').value) || 0, q = parseInt(document.getElementById('bill-qty').value) || 1;
    if (!d) return;
    currentBillItems.push({ desc: d, price: p, qty: q });
    let total = 0; const body = document.getElementById('current-bill-body'); body.innerHTML = "";
    currentBillItems.forEach(i => { total += (i.price * i.qty); body.innerHTML += `<tr><td>${i.desc}</td><td>${i.qty}</td><td>₹${i.price * i.qty}</td></tr>`; });
    document.getElementById('bill-total-display').innerText = total;
    document.getElementById('current-items-section').style.display = 'block';
    ['bill-item-id', 'bill-desc', 'bill-price'].forEach(id => document.getElementById(id).value = "");
}

async function finalizeBill() {
    const cust = document.getElementById('bill-cust-name').value;
    if (!cust || currentBillItems.length === 0) return alert("Details missing");

    for (let item of currentBillItems) {
        const updateStock = async () => {
            try {
                const res = await db.find({ selector: { name: item.desc, category: 'inventory' } });
                if (res.docs.length > 0) {
                    let doc = res.docs[0];
                    doc.totalSold += item.qty;
                    await db.put(doc);
                }
            } catch (e) { if (e.status === 409) return updateStock(); }
        };
        await updateStock();
    }
    await db.put({ _id: 'ledger_' + Date.now(), customer: cust, amount: parseFloat(document.getElementById('bill-total-display').innerText), items: [...currentBillItems], category: 'ledger', date: new Date().toLocaleString() });
    alert("Bill Finalized"); hardResetFields(); uploadToDrive();
}

function changeQty(id, n) { let el = document.getElementById(id), v = parseInt(el.value) || 1; if (v + n >= 1) el.value = v + n; }

// --- SYNC ENGINE (SMART MERGE) ---
async function uploadToDrive() {
    if (!navigator.onLine || !accessToken) {
        document.getElementById('sync-status').innerText = "Status: No Login";
        return;
    }
    document.getElementById('sync-status').innerText = "Status: Syncing...";
    try {
        const search = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='workshop_db_backup.json'&fields=files(id)`, {
            headers: { 'Authorization': 'Bearer ' + accessToken }
        });
        const sData = await search.json();
        const driveFileId = sData.files?.[0]?.id;

        if (driveFileId) {
            const download = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`, {
                headers: { 'Authorization': 'Bearer ' + accessToken }
            });
            const cloudDocs = await download.json();
            for (let cDoc of cloudDocs) {
                try {
                    const local = await db.get(cDoc._id);
                    await db.put({ ...cDoc, _rev: local._rev });
                } catch (e) { if (e.status !== 409) await db.put(cDoc); }
            }
        }

        const localData = await db.allDocs({ include_docs: true });
        const body = JSON.stringify(localData.rows.map(r => r.doc));

        const url = driveFileId
            ? `https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=media`
            : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=media';

        await fetch(url, {
            method: driveFileId ? 'PATCH' : 'POST',
            headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
            body: body
        });

        document.getElementById('sync-status').innerText = "Status: Synced " + new Date().toLocaleTimeString();
    } catch (e) {
        document.getElementById('sync-status').innerText = "Status: Sync Error";
    }
}

// --- UI UPDATES ---
function updateInventoryUI() {
    db.allDocs({ include_docs: true }).then(res => {
        const list = document.getElementById('inventory-list-table'); list.innerHTML = "";
        res.rows.forEach(r => {
            if (r.doc.category === 'inventory') {
                list.innerHTML += `<tr><td>${r.doc.name}</td><td>${r.doc.totalIn}</td><td>${r.doc.totalIn - r.doc.totalSold}</td><td><button onclick="delDoc('${r.doc._id}')" class="del-btn">✕</button></td></tr>`;
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

// --- BOOTSTRAP ---
function handleSync() {
    if (accessToken) uploadToDrive();
    else tokenClient.requestAccessToken({ prompt: 'consent' });
}

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