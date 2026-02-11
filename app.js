const db = new PouchDB('workshop_db');
const CLIENT_ID = 'YOUR_CLIENT_ID_HERE.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let html5QrcodeScanner;

// --- SCANNER LOGIC ---
function startScanner() {
    document.getElementById('restart-scan').style.display = 'none';
    html5QrcodeScanner = new Html5QrcodeScanner("reader", {
        fps: 20,
        qrbox: { width: 280, height: 150 },
        experimentalFeatures: { useBarCodeDetectorIfSupported: true }
    });
    html5QrcodeScanner.render(onScanSuccess);
}

function onScanSuccess(decodedText) {
    document.getElementById('part-id').value = decodedText;
    findPartInDb(decodedText);

    // Stop scanner after success
    html5QrcodeScanner.clear().then(() => {
        document.getElementById('restart-scan').style.display = 'block';
    });
}

// --- INVENTORY LOGIC ---
async function savePart() {
    const id = document.getElementById('part-id').value;
    const name = document.getElementById('part-name').value;
    const price = parseFloat(document.getElementById('part-price').value) || 0;
    const qty = parseInt(document.getElementById('part-qty').value) || 0;

    if (!id || !name) return alert("Enter Barcode and Name");

    try {
        let doc = { _id: id, name, price, qty, category: 'inventory' };
        try {
            const existing = await db.get(id);
            doc._rev = existing._rev;
            doc.qty = existing.qty + qty; // Adds new stock to old stock
        } catch (e) { }

        await db.put(doc);
        alert("Stock updated!");
        location.reload(); // Refresh to clear and show updates
    } catch (err) { console.error(err); }
}

async function findPartInDb(id) {
    try {
        const doc = await db.get(id);
        document.getElementById('part-name').value = doc.name;
        document.getElementById('part-price').value = doc.price;
        alert("Part Found: " + doc.name + " (Current Stock: " + doc.qty + ")");
    } catch (e) { console.log("New Part"); }
}

// --- LEDGER LOGIC ---
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
    listDiv.innerHTML = "<h3>Ledger / Balances</h3>";
    for (let c in balances) {
        listDiv.innerHTML += `
            <div class="ledger-card">
                <strong>${c}</strong>: ${balances[c] > 0 ? 'Owes' : 'Credit'} $${Math.abs(balances[c]).toFixed(2)}
            </div>`;
    }
}

// --- SYNC LOGIC ---
function handleSync() {
    gapi.load('client:auth2', async () => {
        await gapi.client.init({ clientId: CLIENT_ID, scope: SCOPES });
        if (!gapi.auth2.getAuthInstance().isSignedIn.get()) {
            await gapi.auth2.getAuthInstance().signIn();
        }
        uploadToDrive();
    });
}

async function uploadToDrive() {
    const res = await db.allDocs({ include_docs: true });
    const content = JSON.stringify(res.rows.map(r => r.doc));
    const metadata = { 'name': 'workshop_db_backup.json', 'mimeType': 'application/json' };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([content], { type: 'application/json' }));

    fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: new Headers({ 'Authorization': 'Bearer ' + gapi.auth2.getAuthInstance().currentUser.get().getAuthResponse().access_token }),
        body: form
    }).then(() => {
        alert("Synced to Drive!");
        document.getElementById('sync-status').innerText = "Synced: " + new Date().toLocaleTimeString();
    });
}

// Initialize
startScanner();
updateLedgerUI();