const db = new PouchDB('workshop_db');
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let tokenClient;
let accessToken = sessionStorage.getItem('drive_token');
let html5QrcodeScanner;

// INITIALIZATION
function gapiLoaded() {
    gapi.load('client', async () => {
        await gapi.client.init({ discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"] });
    });
}

function gsiLoaded() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (response) => {
            if (response.error !== undefined) throw (response);
            accessToken = response.access_token;
            sessionStorage.setItem('drive_token', accessToken);
            uploadToDrive();
        },
    });
}

window.addEventListener('online', () => { if (accessToken) uploadToDrive(); });

window.onload = () => {
    gapiLoaded();
    gsiLoaded();
    updateLedgerUI();
};

// STEPPER LOGIC
function changeQty(amount) {
    const qtyInput = document.getElementById('part-qty');
    let currentVal = parseInt(qtyInput.value) || 1;
    if (currentVal + amount >= 1) qtyInput.value = currentVal + amount;
}

// DRIVE SYNC
function handleSync() {
    if (!navigator.onLine) return alert("Offline: Will sync once connected.");
    if (!accessToken) tokenClient.requestAccessToken({ prompt: 'consent' });
    else uploadToDrive();
}

async function uploadToDrive() {
    if (!navigator.onLine || !accessToken) return;
    const syncBtn = document.getElementById('sync-btn');
    syncBtn.innerText = "Syncing...";

    try {
        const res = await db.allDocs({ include_docs: true });
        const content = JSON.stringify(res.rows.map(r => r.doc));
        const fileContent = new Blob([content], { type: 'application/json' });

        const search = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='workshop_db_backup.json' and trashed=false`, {
            headers: { 'Authorization': 'Bearer ' + accessToken }
        });
        const searchRes = await search.json();
        const file = searchRes.files && searchRes.files[0];

        let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=media';
        let method = 'POST';
        if (file) {
            url = `https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=media`;
            method = 'PATCH';
        }

        await fetch(url, {
            method: method,
            headers: new Headers({ 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }),
            body: fileContent
        });
        document.getElementById('sync-status').innerText = "Last Synced: " + new Date().toLocaleTimeString();
    } catch (err) { console.error(err); }
    finally { syncBtn.innerText = "Cloud Sync"; }
}

// SCANNER + VIBRATION
function startScanner() {
    document.getElementById('start-scan-manual').style.display = 'none';
    document.getElementById('restart-scan').style.display = 'none';

    html5QrcodeScanner = new Html5QrcodeScanner("reader", { fps: 20, qrbox: { width: 250, height: 150 } });
    html5QrcodeScanner.render((text) => {
        if (navigator.vibrate) navigator.vibrate(100);
        document.getElementById('part-id').value = text;
        db.get(text).then(doc => {
            document.getElementById('part-name').value = doc.name;
            document.getElementById('part-price').value = doc.price;
        }).catch(() => { });
        html5QrcodeScanner.clear().then(() => {
            document.getElementById('restart-scan').style.display = 'block';
        });
    });
}

async function savePart() {
    const id = document.getElementById('part-id').value;
    const name = document.getElementById('part-name').value;
    const price = parseFloat(document.getElementById('part-price').value) || 0;
    const qtyInput = document.getElementById('part-qty');
    const qty = parseInt(qtyInput.value) || 1;

    if (!id || !name) return alert("Fill ID and Name");

    let doc = { _id: id, name, price, qty, category: 'inventory' };
    try {
        const exist = await db.get(id);
        doc._rev = exist._rev;
        doc.qty = exist.qty + qty;
    } catch (e) { }

    await db.put(doc);
    alert("Saved Locally!");

    document.getElementById('part-id').value = "";
    document.getElementById('part-name').value = "";
    document.getElementById('part-price').value = "";
    qtyInput.value = "1";

    uploadToDrive();
}

async function addTransaction(type) {
    const name = document.getElementById('cust-name').value;
    const amount = parseFloat(document.getElementById('trans-amount').value);
    if (!name || !amount) return alert("Fill Name and Amount");
    await db.put({ _id: 'ledger_' + Date.now(), customer: name, amount, type, category: 'ledger' });
    document.getElementById('trans-amount').value = "";
    updateLedgerUI();
    uploadToDrive();
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
    listDiv.innerHTML = "<h3>Balances</h3>";
    for (let c in balances) {
        listDiv.innerHTML += `<div><strong>${c}</strong>: $${Math.abs(balances[c]).toFixed(2)}</div>`;
    }
}