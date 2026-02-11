const db = new PouchDB('workshop_db');
const CLIENT_ID = '265618310384-mvgcqs0j7tk1fvi6k1b902s8batrehmj.apps.googleusercontent.com';
let accessToken = sessionStorage.getItem('drive_token'), html5QrcodeScanner;

function gsiLoaded() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: 'https://www.googleapis.com/auth/drive.file',
        callback: (res) => { accessToken = res.access_token; sessionStorage.setItem('drive_token', accessToken); uploadToDrive(); }
    });
}
window.onload = () => { gsiLoaded(); updateLedgerUI(); };

function startScanner() {
    // UI Cleanup
    document.getElementById('start-scan-manual').style.display = 'none';
    document.getElementById('restart-scan').style.display = 'none';

    // Clear existing scanner instance
    if (html5QrcodeScanner) {
        html5QrcodeScanner.clear();
    }

    html5QrcodeScanner = new Html5QrcodeScanner("reader", {
        fps: 20,
        qrbox: { width: 250, height: 150 },
        supportedScanTypes: [Html5QrcodeScanType.SCAN_TYPE_CAMERA, Html5QrcodeScanType.SCAN_TYPE_FILE]
    });

    html5QrcodeScanner.render(onScanSuccess, onScanFailure);
}

function onScanSuccess(decodedText, decodedResult) {
    // Beep & Vibrate
    const beep = document.getElementById('beep-sound');
    if (beep) beep.play().catch(() => { });
    if (navigator.vibrate) navigator.vibrate(100);

    document.getElementById('part-id').value = decodedText;

    db.get(decodedText).then(doc => {
        document.getElementById('part-name').value = doc.name;
        document.getElementById('part-price').value = doc.price;
    }).catch(() => { });

    html5QrcodeScanner.clear().then(() => {
        document.getElementById('restart-scan').style.display = 'block';
    });
}

function onScanFailure(error) {
    // Silent failure is better for performance
}

function changeQty(amount) {
    const qty = document.getElementById('part-qty');
    let val = parseInt(qty.value) || 1;
    if (val + amount >= 1) qty.value = val + amount;
}

async function savePart() {
    const id = document.getElementById('part-id').value, name = document.getElementById('part-name').value;
    const qty = parseInt(document.getElementById('part-qty').value) || 1;
    if (!id || !name) return alert("Fill ID and Name");
    let doc = { _id: id, name, qty, category: 'inventory' };
    try { const exist = await db.get(id); doc._rev = exist._rev; doc.qty = exist.qty + qty; } catch (e) { }
    await db.put(doc);
    alert("Saved!");
}

async function addTransaction(type) {
    const name = document.getElementById('cust-name').value, amount = parseFloat(document.getElementById('trans-amount').value);
    if (!name || !amount) return alert("Enter details");
    await db.put({ _id: 'ledger_' + Date.now(), customer: name, amount, type, category: 'ledger' });
    updateLedgerUI();
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
    for (let c in balances) { list.innerHTML += `<div class="ledger-card"><strong>${c}</strong>: $${balances[c].toFixed(2)}</div>`; }
}