from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
html = (ROOT / 'index.html').read_text(encoding='utf-8')
app = (ROOT / 'app.js').read_text(encoding='utf-8')
core = (ROOT / 'core.js').read_text(encoding='utf-8')

class MarkupAudit(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.errors = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get('id'):
            self.ids.append(attrs['id'])

audit = MarkupAudit()
audit.feed(html)
duplicates = [key for key, count in Counter(audit.ids).items() if count > 1]
assert not duplicates, f'Duplicate HTML IDs: {duplicates}'

ids = set(audit.ids)
required = set(re.findall(r"byId\('([^']+)'\)", app)) - {'invoice-print-area'}
missing = sorted(required - ids)
assert not missing, f'Missing app element IDs: {missing}'

local_refs = re.findall(r'(?:src|href)="([^"#]+)"', html)
missing_files = [ref for ref in local_refs if not ref.startswith(('http://', 'https://', 'mailto:', 'tel:', 'data:')) and not (ROOT / ref).exists()]
assert not missing_files, f'Missing local resources: {missing_files}'

inventory_header = html.split('id="inventory-table"', 1)[0].split('<thead>', 1)[-1]
assert len(re.findall(r'<th(?:\s|>)', inventory_header)) == 10, 'Inventory table must have 10 aligned columns.'
assert 'data-action="open-scanner-stock"' in html, 'Inventory dialog needs a camera scan action.'
assert "byId('stock-code').addEventListener('input'" in app, 'Stock barcode needs automatic input handling.'
assert "byId('bill-item-search').addEventListener('input'" in app, 'Billing barcode needs automatic input handling.'
assert 'const editableOrigin = origin && origin.isConnected' in app, 'A scan made while another editable field is focused must remain visible in that field.'
assert app.index('if (editableOrigin)') < app.index("if (stockDialogOpen || activeView === 'inventory'"), 'Focused input must be handled before automatic screen routing.'
assert "element.style.display = 'none'" not in app[app.index('async function scanImageFile'):app.index('// ---------- Keyboard-wedge')], 'Image scan host must have measurable dimensions.'
assert "db.transaction(['inventory', 'stockMovements'], 'readwrite')" in app, 'Stock and movement writes must be atomic.'
assert "db.transaction(['inventory', 'services', 'settings', 'bills', 'payments', 'stockMovements'], 'readwrite')" in app, 'Invoice and stock writes must be atomic.'
assert 'Core.normalizeBackupPayload(sourcePayload)' in app, 'Current and legacy backups must be normalised before restore.'
assert 'workshop_backup.json' in app, 'Google Drive restore must look for the original backup filename.'
assert (ROOT / 'sw.js').exists() and (ROOT / 'manifest.webmanifest').exists(), 'PWA shell files are missing.'
print('Static app checks passed: IDs, local assets, inventory columns, visible barcode routing, scan host dimensions, atomic save flows and PWA files.')
assert 'id="view-services"' in html and "services: ['SERVICE CATALOGUE'" in app, 'Reusable services / non-stock catalogue is missing.'
assert 'id="bill-customer-search"' in html and 'function filterBillCustomers()' in app, 'Billing customer search is missing.'
assert 'required placeholder="10-digit mobile number"' in html, 'Customer phone must be mandatory.'
assert "timeZone: IST" in app and "T00:00:00+05:30" in app, 'Invoice dates must use explicit India timezone handling.'
assert "id=\"service-save-catalog\"" in html and "quantity: 0" in app, 'Bill-only catalogue save / zero quantity behavior is missing.'
shop_html = (ROOT / 'shop.html').read_text(encoding='utf-8')
assert 'window.WORKSHOP_MODE = \'shop\'' in shop_html, 'Shop entry point must use restricted mode.'
assert 'id="view-database"' in html and 'data-admin-only' in html, 'Integrated Admin database editor is missing.'
assert 'id="database-cell-form"' in html and 'function saveDatabaseCell' in app, 'Per-cell database editor is missing.'
assert 'id="view-inventory"' in shop_html and 'id="view-ledger"' in shop_html, 'Shop needs read-only inventory and ledger pages.'
assert 'function shopReadOnlyAction' in app and 'if (IS_SHOP)' in app, 'Shop role action guards are missing.'
assert 'auditLog' in app and 'stockMovements' in app, 'Admin audit / stock history support is missing.'
assert "requestAccessToken({ prompt: '' })" in app, 'Drive connect must not force consent on every reload.'
assert 'WorkshopPro_Backup.json' in app and 'WP5_OP_' not in app, 'New app should use one Drive snapshot file, not v5 operation files.'
assert (ROOT / 'shop.webmanifest').exists(), 'Shop PWA manifest is missing.'
assert 'data-shop-only' in shop_html and 'Sync now' in shop_html and 'shop-sync-panel' in shop_html, 'Shop Drive controls are missing.'


assert "data-format=\"vehicle\"" in html and "toLocaleUpperCase('en-IN')" in app, 'Vehicle numbers must be uppercase.'
assert "Core.titleCase(value)" in app and "function titleCase(value)" in core and "data-format=\"title\"" in html, 'Title Case input formatting is missing.'
assert 'database-audit-results' in html and 'function renderDatabaseAudit' in app, 'Admin data-quality diagnostics are missing.'
assert "'collect-payment'" in app and "'edit-customer'" in app and "'edit-stock'" in app, 'Shop write restrictions are incomplete.'
assert "'auditLog'" in app and 'schemaVersion: 4' in app, 'Audit storage / backup schema version 4 is missing.'

assert 'const DB_VERSION = 6' in app, 'IndexedDB v6 migration must add the local sync safety store.'
assert "createObjectStore('syncSafety'" in app, 'Automatic remote pulls need a separate local safety store.'
assert 'function automaticDriveSync' in app and 'function pullRemoteSnapshot' in app, 'Automatic two-way Drive sync is missing.'
assert '25000' in app, 'Open-app sync polling should be enabled.'
assert 'Conflict needs review' in app, 'Pending local changes must not be silently overwritten by remote data.'

assert 'remotePullInProgress' in app and 'generationAtStart' in app, 'Remote pulls must block local writes and recheck for changes before replacement.'
assert 'sync-safety-download' in html, 'Admin should expose local pre-sync safety-copy recovery.'

assert "if (!remotePullInProgress) recordLocalChange();" in app, 'Local writes must be marked pending before database replacement/write transactions.'

assert "requestAccessToken({ prompt: 'none' })" in app, 'Previously authorized sessions should attempt silent token renewal on reload.'

assert 'latestBeforeUpload' in app, 'Drive upload should recheck the remote version immediately before writing.'
