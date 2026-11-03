from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
html = (ROOT / 'index.html').read_text(encoding='utf-8')
app = (ROOT / 'app.js').read_text(encoding='utf-8')

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
assert inventory_header.count('<th>') == 10, 'Inventory table must have 10 aligned columns.'
assert 'data-action="open-scanner-stock"' in html, 'Inventory dialog needs a camera scan action.'
assert "byId('stock-code').addEventListener('input'" in app, 'Stock barcode needs automatic input handling.'
assert "byId('bill-item-search').addEventListener('input'" in app, 'Billing barcode needs automatic input handling.'
assert 'const editableOrigin = origin && origin.isConnected' in app, 'A scan made while another editable field is focused must remain visible in that field.'
assert app.index('if (editableOrigin)') < app.index("if (stockDialogOpen || activeView === 'inventory'"), 'Focused input must be handled before automatic screen routing.'
assert "element.style.display = 'none'" not in app[app.index('async function scanImageFile'):app.index('// ---------- Keyboard-wedge')], 'Image scan host must have measurable dimensions.'
assert "db.transaction(['inventory', 'stockMovements'], 'readwrite')" in app, 'Stock and movement writes must be atomic.'
assert "db.transaction(['inventory', 'settings', 'bills', 'payments', 'stockMovements'], 'readwrite')" in app, 'Invoice and stock writes must be atomic.'
assert 'Core.normalizeBackupPayload(sourcePayload)' in app, 'Current and legacy backups must be normalised before restore.'
assert 'workshop_backup.json' in app, 'Google Drive restore must look for the original backup filename.'
assert (ROOT / 'sw.js').exists() and (ROOT / 'manifest.webmanifest').exists(), 'PWA shell files are missing.'
print('Static app checks passed: IDs, local assets, inventory columns, visible barcode routing, scan host dimensions, atomic save flows and PWA files.')
