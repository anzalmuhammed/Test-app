const db = new PouchDB('workshop_db');
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let tokenClient;
let accessToken = sessionStorage.getItem('drive_token');
let html5QrCode;

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
            sessionStorage.setItem('drive_token', accessToken);
            uploadToDrive();
        },
    });
}

window.onload = () => {
    gapiLoaded();
    gsiLoaded();
    updateLedgerUI();
};

function playBeep() {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.connect(gain);
    gain.connect(context.destination);
    osc.type = 'square';
    osc.frequency.setValueAtTime(1000, context.currentTime);
    gain.gain.setValueAtTime(0.1, context.currentTime);
    gain.gain.setValueAtTime(0.1, context.currentTime + 0.6);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.8);
    osc.start();
    osc.stop(context.currentTime + 0.8);
}

function handleSync() {
    if (accessToken === null) {
        tokenClient.requestAccessToken({ prompt: 'consent' });
    } else {
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
        const searchResponse = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='workshop_db_backup.json' and trashed=false`, {
            headers: { 'Authorization': 'Bearer ' + accessToken }
        });
        const searchResult = await searchResponse.json();
        const existingFile = searchResult.files && searchResult.files[0];
        let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=media';
        let method = 'POST';
        if (existingFile) {
            url = `https://www.googleapis.com/upload/drive/v3/files/${existingFile.id}?uploadType=media`;
            method = 'PATCH';
        }
        const response = await fetch(url, {
            method: method,
            headers: new Headers({
                'Authorization': 'Bearer ' + accessToken,
                'Content-Type': 'application/json'
            }),
            body: fileContent
        });
        if (response.ok) {
            document.getElementById('sync-status').innerText = "Last Synced: " + new Date().toLocaleTimeString();
        } else if (response.status === 401) {
            accessToken = null;
            handleSync();
        }
    } catch (err) {
        console.error(err);
    } finally {
        syncBtn.innerText = "Cloud Sync";
    }
}

function startScanner() {
    document.getElementById('start-scan-manual').style.display = 'none';
    document.getElementById('restart-scan').style.display = 'none';
    if (!html5QrCode) { html5QrCode = new Html5Qrcode("reader"); }
    const config = { fps: 20, qrbox: { width: 250, height: 150 } };
    html5QrCode.start({ facingMode: "environment" }, config, onScanSuccess)
        .catch(err => {
            alert("Camera Error");
            document.getElementById('start-scan-manual').style.display = 'block';
        });
}

function onScanSuccess(decodedText) {
    playBeep();
    if (navigator.vibrate) navigator.vibrate(200);
    document.getElementById('part-id').value = decodedText;
    db.get(decodedText).then(doc => {
        document.getElementById('part-name').value = doc.name;
        document.getElementById('part-price').value = doc.price;
    }).catch(() => { });
    html5QrCode.stop().then(() => {
        document.getElementById('restart-scan').style.display = 'block';
    });
}

function scanImageFile(e) {
    if (e.target.files.length === 0) return;
    if (!html5QrCode) html5QrCode = new Html5Qrcode("reader");
    html5QrCode.scanFile(e.target.files[0], true)
        .then(decodedText => onScanSuccess(decodedText))
        .catch(err => alert("No barcode found"));
}

function changeQty(amount) {
    const qty = document.getElementById('part-qty');
    let val = parseInt(qty.value) || 1;
    if (val + amount >= 1) qty.value = val + amount;
}

async function savePart() {
    const id = document.getElementById('part-id').value, name = document.getElementById('part-name').value;
    const price = parseFloat(document.getElementById('part-price').value) || 0;
    const qty = parseInt(document.getElementById('part-qty').value) || 0;
    if (!id || !name) return alert("Fill ID and Name");
    let doc = { _id: id, name, price, qty, category: 'inventory' };
    try {
        const exist = await db.get(id);
        doc._rev = exist._rev;
        doc.qty = exist.qty + qty;
    } catch (e) { }
    await db.put(doc);
    alert("Saved Locally!");
    if (accessToken) uploadToDrive();
    location.reload();
}

async function addTransaction(type) {
    const name = document.getElementById('cust-name').value, amount = parseFloat(document.getElementById('trans-amount').value);
    if (!name || !amount) return alert("Fill details");
    await db.put({ _id: 'ledger_' + Date.now(), customer: name, amount, type, category: 'ledger' });
    updateLedgerUI();
    if (accessToken) uploadToDrive();
}

async function updateLedgerUI() {
    const result = await db.allDocs({ include_docs: true });
    const balances = {};
    result.rows.forEach(r => {
        if (r.doc.category === 'ledger') {
            const d = r.doc; balances[d.customer] = (balances[d.customer] || 0) + (d.type === 'invoice' ? d.amount : -d.amount);
        }
    });
    const list = document.getElementById('customer-list');
    list.innerHTML = "<h3>Balances</h3>";
    for (let c in balances) { list.innerHTML += `<div class="ledger-card"><strong>${c}</strong>: $${Math.abs(balances[c]).toFixed(2)}</div>`; }
}