const db = new PouchDB('workshop_db');
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let tokenClient;
let accessToken = null;
let html5QrcodeScanner;

// --- INITIALIZATION ---
function gapiLoaded() {
    gapi.load('client', async () => {
        await gapi.client.init({
            discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"],
        });
    });
}

function gsiLoaded() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (response) => {
            if (response.error !== undefined) throw (response);
            accessToken = response.access_token;
            // Store token in session to avoid constant popups
            sessionStorage.setItem('drive_token', accessToken);
            uploadToDrive();
        },
    });
    // Check if we already have a token from this session
    accessToken = sessionStorage.getItem('drive_token');
}

window.onload = () => {
    gapiLoaded();
    gsiLoaded();
    updateLedgerUI();
    startScanner();
};

// --- SYNC LOGIC (SMART UPDATE) ---
function handleSync() {
    if (accessToken === null) {
        // Only show popup if we don't have a token
        tokenClient.requestAccessToken({ prompt: 'consent' });
    } else {
        // Silent update if token exists
        uploadToDrive();
    }
}

async function uploadToDrive() {
    const syncBtn = document.getElementById('sync-btn');
    syncBtn.innerText = "Syncing...";

    try {
        const res = await db.allDocs({ include_docs: true });
        const content = JSON.stringify(res.rows.map(r => r.doc));
        const fileContent = new Blob([content], { type: 'application/json' });

        // 1. Search for existing file
        const searchResponse = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='workshop_db_backup.json' and trashed=false`, {
            headers: { 'Authorization': 'Bearer ' + accessToken }
        });
        const searchResult = await searchResponse.json();
        const existingFile = searchResult.files && searchResult.files[0];

        let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=media';
        let method = 'POST';

        // 2. If file exists, change to UPDATE mode (PATCH)
        if (existingFile) {
            url = `https://www.googleapis.com/upload/drive/v3/files/${existingFile.id}?uploadType=media`;
            method = 'PATCH';
        }

        // 3. Perform the upload
        const response = await fetch(url, {
            method: method,
            headers: new Headers({
                'Authorization': 'Bearer ' + accessToken,
                'Content-Type': 'application/json'
            }),
            body: fileContent
        });

        if (response.ok) {
            console.log("Drive Updated Successfully");
            document.getElementById('sync-status').innerText = "Last Synced: " + new Date().toLocaleTimeString();
        } else if (response.status === 401) {
            // Token expired? Clear and ask again
            accessToken = null;
            handleSync();
        }
    } catch (err) {
        console.error("Sync error:", err);
    } finally {
        syncBtn.innerText = "Cloud Sync";
    }
}

// --- APP LOGIC (WITH AUTO-SYNC) ---
async function savePart() {
    const id = document.getElementById('part-id').value;
    const name = document.getElementById('part-name').value;
    const price = parseFloat(document.getElementById('part-price').value) || 0;
    const qty = parseInt(document.getElementById('part-qty').value) || 0;

    if (!id || !name) return alert("Missing ID or Name");

    let doc = { _id: id, name, price, qty, category: 'inventory' };
    try {
        const existing = await db.get(id);
        doc._rev = existing._rev;
        doc.qty = existing.qty + qty;
    } catch (e) { }

    await db.put(doc);
    alert("Saved Locally!");

    // AUTO SYNC
    if (accessToken) uploadToDrive();

    location.reload();
}

async function addTransaction(type) {
    const name = document.getElementById('cust-name').value;
    const amount = parseFloat(document.getElementById('trans-amount').value);
    if (!name || !amount) return alert("Fill Name and Amount");

    const entry = {
        _id: 'ledger_' + Date.now(),
        customer: name,
        amount: amount,
        type: type,
        category: 'ledger'
    };

    await db.put(entry);
    updateLedgerUI();

    // AUTO SYNC
    if (accessToken) uploadToDrive();
}

// (Keep your existing startScanner, onScanSuccess, and updateLedgerUI functions below)
function startScanner() {
    html5QrcodeScanner = new Html5QrcodeScanner("reader", { fps: 20, qrbox: { width: 280, height: 150 } });
    html5QrcodeScanner.render(onScanSuccess);
}

function onScanSuccess(decodedText) {
    document.getElementById('part-id').value = decodedText;
    db.get(decodedText).then(doc => {
        document.getElementById('part-name').value = doc.name;
        document.getElementById('part-price').value = doc.price;
    }).catch(() => console.log("New part"));
    html5QrcodeScanner.clear().then(() => {
        document.getElementById('restart-scan').style.display = 'block';
    });
}

async function updateLedgerUI() {
    const result = await db.allDocs({ include_docs: true });
    const balances = {};
    result.rows.forEach(r => {
        if (r.doc.category === 'ledger') {
            const d = r.doc;
            if (!balances[d.customer]) balances[d.customer] = 0;
            balances[d.customer] += (d.type === 'invoice' ? d.amount : -d.amount);
        }
    });
    const listDiv = document.getElementById('customer-list');
    listDiv.innerHTML = "<h3>Customer Balances</h3>";
    for (let c in balances) {
        listDiv.innerHTML += `<div><strong>${c}</strong>: $${Math.abs(balances[c]).toFixed(2)}</div>`;
    }
}