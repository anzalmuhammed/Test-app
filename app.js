const db = new PouchDB('workshop_db');

// REPLACE WITH YOUR ACTUAL CLIENT ID FROM GOOGLE CLOUD
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let tokenClient;
let accessToken = null;
let html5QrcodeScanner;

// INITIALIZE GOOGLE SERVICES
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
            uploadToDrive();
        },
    });
}

window.onload = () => {
    gapiLoaded();
    gsiLoaded();
    updateLedgerUI();
    startScanner();
};

// GOOGLE DRIVE SYNC
function handleSync() {
    if (accessToken === null) {
        tokenClient.requestAccessToken({ prompt: 'consent' });
    } else {
        tokenClient.requestAccessToken({ prompt: '' });
    }
}

async function uploadToDrive() {
    const syncBtn = document.getElementById('sync-btn');
    syncBtn.innerText = "Syncing...";
    try {
        const res = await db.allDocs({ include_docs: true });
        const content = JSON.stringify(res.rows.map(r => r.doc));
        const fileContent = new Blob([content], { type: 'application/json' });
        const metadata = { 'name': 'workshop_db_backup.json', 'mimeType': 'application/json' };
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', fileContent);

        const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
            method: 'POST',
            headers: new Headers({ 'Authorization': 'Bearer ' + accessToken }),
            body: form
        });

        if (response.ok) {
            alert("Success! Data synced to Drive.");
            document.getElementById('sync-status').innerText = "Last Synced: " + new Date().toLocaleTimeString();
        }
    } catch (err) {
        alert("Sync Error: " + err);
    } finally {
        syncBtn.innerText = "Cloud Sync";
    }
}

// BARCODE SCANNER
function startScanner() {
    html5QrcodeScanner = new Html5QrcodeScanner("reader", {
        fps: 20,
        qrbox: { width: 280, height: 150 }
    });
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

// INVENTORY LOGIC
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
    alert("Saved!");
    location.reload();
}

// LEDGER LOGIC
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