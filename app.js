const db = new PouchDB('workshop_db');
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let accessToken = localStorage.getItem('drive_token'), html5QrCode, currentBillItems = [];

// --- MANUAL REDIRECT (THE FIX) ---
function handleSync() {
    if (accessToken) {
        uploadToDrive();
    } else {
        // We use a raw URL. This is the only way to be 100% sure NO popup code runs.
        const redirectUri = window.location.origin + window.location.pathname;
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(SCOPES)}&include_granted_scopes=true&prompt=consent`;

        window.location.href = authUrl;
    }
}

// --- APP INITIALIZATION ---
window.onload = () => {
    // 1. Capture token from URL after redirect
    if (window.location.hash) {
        const params = new URLSearchParams(window.location.hash.substring(1));
        const token = params.get("access_token");
        if (token) {
            accessToken = token;
            localStorage.setItem('drive_token', token);
            // Remove token from URL for security/cleanliness
            window.history.replaceState(null, null, window.location.pathname);
        }
    }

    if (accessToken) {
        document.getElementById('sync-status').innerText = "Status: Authenticated";
        uploadToDrive();
    }
};

// --- SYNC LOGIC ---
async function uploadToDrive() {
    if (!navigator.onLine || !accessToken) return;
    document.getElementById('sync-status').innerText = "Status: Syncing...";

    try {
        const headers = { 'Authorization': `Bearer ${accessToken}` };

        // Find existing backup
        const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='workshop_db_backup.json'&fields=files(id)`, { headers });
        const { files } = await searchRes.json();
        const fileId = files?.[0]?.id;

        // Download & Merge
        if (fileId) {
            const download = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers });
            const cloudData = await download.json();
            for (let doc of cloudData) {
                try {
                    const local = await db.get(doc._id);
                    await db.put({ ...doc, _rev: local._rev });
                } catch (e) { if (e.status !== 409) await db.put(doc); }
            }
        }

        // Upload
        const localDocs = await db.allDocs({ include_docs: true });
        const blob = new Blob([JSON.stringify(localDocs.rows.map(r => r.doc))], { type: 'application/json' });

        const url = fileId
            ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`
            : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=media';

        const upRes = await fetch(url, {
            method: fileId ? 'PATCH' : 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: blob
        });

        if (upRes.ok) {
            document.getElementById('sync-status').innerText = "Status: Synced " + new Date().toLocaleTimeString();
        } else if (upRes.status === 401) {
            localStorage.removeItem('drive_token');
            accessToken = null;
            document.getElementById('sync-status').innerText = "Status: Session Expired. Login again.";
        }
    } catch (e) {
        document.getElementById('sync-status').innerText = "Status: Sync Failed";
    }
}

// --- REST OF THE APP LOGIC ---
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
    const id = document.getElementById('part-id').value;
    const name = document.getElementById('part-name').value;
    const price = parseFloat(document.getElementById('part-price').value) || 0;
    const qty = parseInt(document.getElementById('part-qty').value) || 0;

    const runSave = async () => {
        try {
            let doc;
            try { doc = await db.get(id); } catch (e) { doc = { _id: id, totalIn: 0, totalSold: 0, category: 'inventory' }; }
            doc.name = name; doc.price = price; doc.totalIn += qty;
            await db.put(doc);
            alert("Stock Updated");
            uploadToDrive();
        } catch (e) { if (e.status === 409) return runSave(); }
    };
    runSave();
}

function addItemToCurrentBill() {
    const d = document.getElementById('bill-desc').value;
    const p = parseFloat(document.getElementById('bill-price').value) || 0;
    const q = parseInt(document.getElementById('bill-qty').value) || 1;
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
    if (!cust) return alert("Customer name required");

    for (let item of currentBillItems) {
        const updateStock = async () => {
            try {
                const res = await db.allDocs({ include_docs: true });
                const row = res.rows.find(r => r.doc.name === item.desc);
                if (row) {
                    let doc = row.doc;
                    doc.totalSold += item.qty;
                    await db.put(doc);
                }
            } catch (e) { if (e.status === 409) return updateStock(); }
        };
        await updateStock();
    }

    await db.put({
        _id: 'bill_' + Date.now(),
        customer: cust,
        amount: parseFloat(document.getElementById('bill-total-display').innerText),
        date: new Date().toLocaleString(),
        category: 'ledger'
    });
    alert("Bill Saved");
    currentBillItems = [];
    document.getElementById('current-items-section').style.display = 'none';
    uploadToDrive();
}

async function toggleScanner(type) {
    const id = type === 'inventory' ? 'reader' : 'bill-reader';
    if (!html5QrCode) html5QrCode = new Html5Qrcode(id);
    html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, (text) => {
        document.getElementById(type === 'inventory' ? 'part-id' : 'bill-item-id').value = text;
        html5QrCode.stop();
    });
}

function changeQty(id, n) {
    let el = document.getElementById(id);
    let v = parseInt(el.value) || 1;
    if (v + n >= 1) el.value = v + n;
}

function updateInventoryUI() {
    db.allDocs({ include_docs: true }).then(res => {
        const table = document.getElementById('inventory-list-table');
        table.innerHTML = "";
        res.rows.forEach(r => {
            if (r.doc.category === 'inventory') {
                table.innerHTML += `<tr><td>${r.doc.name}</td><td>${r.doc.totalIn}</td><td>${r.doc.totalIn - r.doc.totalSold}</td><td><button onclick="delDoc('${r.doc._id}')">✕</button></td></tr>`;
            }
        });
    });
}

function updateLedgerUI() {
    db.allDocs({ include_docs: true }).then(res => {
        const list = document.getElementById('bill-history-list');
        list.innerHTML = "";
        res.rows.forEach(r => {
            if (r.doc.category === 'ledger') {
                list.innerHTML += `<div class="ledger-card"><b>${r.doc.customer}</b>: ₹${r.doc.amount}<br><small>${r.doc.date}</small></div>`;
            }
        });
    });
}

async function delDoc(id) {
    if (confirm("Delete item?")) {
        const doc = await db.get(id);
        await db.remove(doc);
        updateInventoryUI();
    }
}