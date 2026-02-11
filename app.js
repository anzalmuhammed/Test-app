// 1. INITIALIZE LOCAL DATABASE
const db = new PouchDB('workshop_db');

// 2. GOOGLE DRIVE CONFIGURATION
// Replace 'YOUR_CLIENT_ID_HERE' with the ID you got from Google Cloud Console
const CLIENT_ID = 'YOUR_CLIENT_ID_HERE.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

// 3. BARCODE SCANNER SETUP
function onScanSuccess(decodedText) {
    console.log("Code scanned: " + decodedText);
    document.getElementById('part-id').value = decodedText;

    // Optional: Auto-fill if part exists
    findPartInDb(decodedText);
}

// Configured for Workshop Barcodes (EAN, Code128, QR)
let html5QrcodeScanner = new Html5QrcodeScanner(
    "reader",
    {
        fps: 20,
        qrbox: { width: 280, height: 150 },
        experimentalFeatures: { useBarCodeDetectorIfSupported: true }
    }
);
html5QrcodeScanner.render(onScanSuccess);

// 4. INVENTORY FUNCTIONS
async function savePart() {
    const id = document.getElementById('part-id').value;
    const name = document.getElementById('part-name').value;
    const price = document.getElementById('part-price').value;
    const qty = document.getElementById('part-qty').value;

    if (!id || !name) return alert("Please enter Barcode and Name");

    const part = {
        _id: id,
        name: name,
        price: parseFloat(price),
        qty: parseInt(qty),
        category: 'inventory',
        updatedAt: new Date().toISOString()
    };

    try {
        // 'put' updates if ID exists, or creates if new
        try {
            const existing = await db.get(id);
            part._rev = existing._rev; // Required for PouchDB updates
        } catch (e) { /* New item */ }

        await db.put(part);
        alert("Stock Updated Successfully!");
        clearForm();
    } catch (err) {
        console.error(err);
        alert("Error saving: " + err.message);
    }
}

async function findPartInDb(id) {
    try {
        const doc = await db.get(id);
        document.getElementById('part-name').value = doc.name;
        document.getElementById('part-price').value = doc.price;
        document.getElementById('part-qty').value = doc.qty;
    } catch (err) {
        console.log("New part detected");
    }
}

function clearForm() {
    document.getElementById('part-id').value = '';
    document.getElementById('part-name').value = '';
    document.getElementById('part-price').value = '';
    document.getElementById('part-qty').value = '';
}

// 5. LEDGER & CUSTOMER FUNCTIONS
async function addTransaction(customerName, amount, type) {
    if (!customerName || !amount) return alert("Enter name and amount");

    const entry = {
        _id: 'ledger_' + new Date().getTime(),
        customer: customerName,
        amount: parseFloat(amount),
        type: type, // 'invoice' or 'payment'
        category: 'ledger',
        date: new Date().toISOString()
    };

    try {
        await db.put(entry);
        updateLedgerUI();
        document.getElementById('trans-amount').value = '';
    } catch (err) {
        console.error(err);
    }
}

async function updateLedgerUI() {
    const result = await db.allDocs({ include_docs: true });
    const docs = result.rows.map(row => row.doc);

    const balances = {};
    docs.filter(d => d.category === 'ledger').forEach(t => {
        if (!balances[t.customer]) balances[t.customer] = 0;
        balances[t.customer] += (t.type === 'invoice' ? t.amount : -t.amount);
    });

    const listDiv = document.getElementById('customer-list');
    listDiv.innerHTML = "<h3>Current Balances</h3>";
    for (let name in balances) {
        const style = balances[name] > 0 ? "color: red" : "color: green";
        listDiv.innerHTML += `
            <div class="ledger-card">
                <strong>${name}</strong>: 
                <span style="${style}">$${Math.abs(balances[name]).toFixed(2)}</span>
                ${balances[name] > 0 ? ' (Owes You)' : ' (Credit)'}
            </div>`;
    }
}

// 6. CLOUD SYNC LOGIC (GOOGLE DRIVE)
function handleSync() {
    gapi.load('client:auth2', async () => {
        try {
            await gapi.client.init({ clientId: CLIENT_ID, scope: SCOPES });
            if (!gapi.auth2.getAuthInstance().isSignedIn.get()) {
                await gapi.auth2.getAuthInstance().signIn();
            }
            uploadToDrive();
        } catch (err) {
            alert("Auth failed: " + JSON.stringify(err));
        }
    });
}

async function uploadToDrive() {
    document.getElementById('sync-status').innerText = "Syncing...";
    const allData = await db.allDocs({ include_docs: true });
    const content = JSON.stringify(allData.rows.map(r => r.doc));

    const fileContent = new Blob([content], { type: 'application/json' });
    const metadata = {
        'name': 'workshop_backup.json',
        'mimeType': 'application/json'
    };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', fileContent);

    fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: new Headers({ 'Authorization': 'Bearer ' + gapi.auth2.getAuthInstance().currentUser.get().getAuthResponse().access_token }),
        body: form
    }).then(res => {
        if (res.ok) {
            alert("Backup Saved to Google Drive!");
            document.getElementById('sync-status').innerText = "Last Synced: " + new Date().toLocaleTimeString();
        }
    });
}

// Load UI on start
updateLedgerUI();