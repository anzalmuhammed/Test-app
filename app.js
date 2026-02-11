// 1. DATABASE & CONFIG
const db = new PouchDB('workshop_db');

// PASTE YOUR ACTUAL CLIENT ID BELOW
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const DISCOVERY_DOCS = ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"];

let html5QrcodeScanner;

// 2. BARCODE SCANNER LOGIC
function startScanner() {
    const restartBtn = document.getElementById('restart-scan');
    if (restartBtn) restartBtn.style.display = 'none';

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

    // Stop scanner and show "Scan Another" button
    html5QrcodeScanner.clear().then(() => {
        document.getElementById('restart-scan').style.display = 'block';
    }).catch(err => console.error("Scanner clear failed", err));
}

// 3. INVENTORY LOGIC
async function savePart() {
    const id = document.getElementById('part-id').value;
    const name = document.getElementById('part-name').value;
    const price = parseFloat(document.getElementById('part-price').value) || 0;
    const qty = parseInt(document.getElementById('part-qty').value) || 0;

    if (!id || !name) return alert("Please enter Barcode and Name");

    try {
        let doc = { _id: id, name, price, qty, category: 'inventory', updatedAt: new Date().toISOString() };
        try {
            const existing = await db.get(id);
            doc._rev = existing._rev;
            doc.qty = existing.qty + qty;
        } catch (e) { /* New part */ }

        await db.put(doc);
        alert("Stock updated successfully!");
        location.reload();
    } catch (err) {
        console.error(err);
        alert("Error saving to database.");
    }
}

async function findPartInDb(id) {
    try {
        const doc = await db.get(id);
        document.getElementById('part-name').value = doc.name;
        document.getElementById('part-price').value = doc.price;
        console.log("Existing part found:", doc.name);
    } catch (e) {
        console.log("New part detected");
    }
}

// 4. LEDGER LOGIC
async function addTransaction(type) {
    const name = document.getElementById('cust-name').value;
    const amount = parseFloat(document.getElementById('trans-amount').value);

    if (!name || !amount) return alert("Fill Name and Amount");

    const entry = {
        _id: 'ledger_' + Date.now(),
        customer: name,
        amount: amount,
        type: type, // 'invoice' or 'payment'
        category: 'ledger',
        date: new Date().toISOString()
    };

    try {
        await db.put(entry);
        updateLedgerUI();
        document.getElementById('trans-amount').value = '';
    } catch (err) { console.error(err); }
}

async function updateLedgerUI() {
    try {
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
            const status = balances[c] > 0 ? "Owes You" : "Credit";
            const color = balances[c] > 0 ? "red" : "green";
            listDiv.innerHTML += `
                <div class="ledger-card">
                    <strong>${c}</strong>: <span style="color:${color}">$${Math.abs(balances[c]).toFixed(2)}</span> (${status})
                </div>`;
        }
    } catch (err) { console.error(err); }
}

// 5. MODERN CLOUD SYNC (Fixed for Origin Errors)
async function handleSync() {
    const syncBtn = document.getElementById('sync-btn');
    syncBtn.innerText = "Connecting...";

    try {
        // Initialize GAPI
        await new Promise((resolve, reject) => {
            gapi.load('client:auth2', { callback: resolve, onerror: reject });
        });

        await gapi.client.init({
            clientId: CLIENT_ID,
            scope: SCOPES,
            discoveryDocs: DISCOVERY_DOCS
        });

        // Sign In
        const authInstance = gapi.auth2.getAuthInstance();
        if (!authInstance.isSignedIn.get()) {
            await authInstance.signIn();
        }

        uploadToDrive();
    } catch (err) {
        console.error("Sync Initialization Error:", err);
        alert("Sync Failed: Check if your Client ID and Authorized Origins are correct in Google Console.");
        syncBtn.innerText = "Cloud Sync";
    }
}

async function uploadToDrive() {
    try {
        const res = await db.allDocs({ include_docs: true });
        const content = JSON.stringify(res.rows.map(r => r.doc));
        const fileContent = new Blob([content], { type: 'application/json' });

        const metadata = {
            'name': 'workshop_db_backup.json',
            'mimeType': 'application/json'
        };

        const accessToken = gapi.auth2.getAuthInstance().currentUser.get().getAuthResponse().access_token;
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', fileContent);

        const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
            method: 'POST',
            headers: new Headers({ 'Authorization': 'Bearer ' + accessToken }),
            body: form
        });

        if (response.ok) {
            alert("Success! Backup saved to Google Drive.");
            document.getElementById('sync-status').innerText = "Last Synced: " + new Date().toLocaleTimeString();
        } else {
            const error = await response.json();
            throw new Error(error.error.message);
        }
    } catch (err) {
        console.error("Upload failed:", err);
        alert("Upload failed: " + err.message);
    } finally {
        document.getElementById('sync-btn').innerText = "Cloud Sync";
    }
}

// 6. STARTUP
updateLedgerUI();
startScanner();