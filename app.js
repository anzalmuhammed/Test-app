// 1. Initialize Local Database
const db = new PouchDB('workshop_db');

// 2. Setup Barcode Scanner
function onScanSuccess(decodedText) {
    document.getElementById('part-id').value = decodedText;
    // You could also auto-search the database here
}

let html5QrcodeScanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: 250 });
html5QrcodeScanner.render(onScanSuccess);

// 3. Save Part Function
async function savePart() {
    const part = {
        _id: document.getElementById('part-id').value, // Use barcode as ID
        name: document.getElementById('part-name').value,
        price: document.getElementById('part-price').value,
        qty: document.getElementById('part-qty').value,
        type: 'inventory'
    };

    try {
        await db.put(part);
        alert("Saved successfully!");
    } catch (err) {
        console.error(err);
    }
}

async function addTransaction(customerName, amount, type) {
    const transaction = {
        _id: new Date().toISOString(), // Unique ID based on time
        customer: customerName,
        amount: parseFloat(amount),
        type: type, // 'invoice' or 'payment'
        category: 'ledger'
    };

    try {
        await db.put(transaction);
        updateLedgerUI();
        alert("Transaction Recorded!");
    } catch (err) {
        console.error(err);
    }
}

// Calculate Balances and Show in App
async function updateLedgerUI() {
    const result = await db.allDocs({ include_docs: true });
    const transactions = result.rows.map(row => row.doc).filter(doc => doc.category === 'ledger');

    const balances = {};

    transactions.forEach(t => {
        if (!balances[t.customer]) balances[t.customer] = 0;
        if (t.type === 'invoice') balances[t.customer] += t.amount;
        if (t.type === 'payment') balances[t.customer] -= t.amount;
    });

    const listDiv = document.getElementById('customer-list');
    listDiv.innerHTML = ""; // Clear old list

    for (let name in balances) {
        listDiv.innerHTML += `
            <div class="ledger-card">
                <strong>${name}</strong><br>
                Balance: ${balances[name] > 0 ? 'Owes ' : 'Credit '} $${Math.abs(balances[name])}
            </div>
        `;
    }
}

// Run ledger update when app starts
updateLedgerUI();



const CLIENT_ID = 'YOUR_CLIENT_ID_HERE.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

// 1. Initialize Google Auth
function handleSync() {
    gapi.load('client:auth2', async () => {
        await gapi.client.init({
            clientId: CLIENT_ID,
            scope: SCOPES,
        });

        if (!gapi.auth2.getAuthInstance().isSignedIn.get()) {
            await gapi.auth2.getAuthInstance().signIn();
        }
        uploadToDrive();
    });
}

// 2. Upload Database to Drive
async function uploadToDrive() {
    const allData = await db.allDocs({ include_docs: true });
    const blob = new Blob([JSON.stringify(allData)], { type: 'application/json' });

    const metadata = {
        'name': 'workshop_backup.json',
        'mimeType': 'application/json'
    };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);

    fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: new Headers({ 'Authorization': 'Bearer ' + gapi.auth2.getAuthInstance().currentUser.get().getAuthResponse().access_token }),
        body: form
    }).then(res => {
        alert("Sync Complete! Data safe on Drive.");
        document.getElementById('sync-status').innerText = "Synced Today";
    });
}