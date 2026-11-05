# WorkshopPro v5 — offline-first workshop app

A fresh, offline-first browser app inspired by the features in the supplied `index.html` and `app.js` reference files. The reference code was used to understand the workflows; its implementation was not copied.

## Included workflows

- Dashboard totals, recent invoices and low-stock alerts.
- Inventory item creation, stock receipts, edits, archive, barcode ID, category/location, min-stock levels, search, filtering, sorting, stock-in / sold / available totals, per-item movement history and CSV export.
- Barcode/QR scanning through the camera or an image file (requires a secure origin and the scanner library to load). USB/Bluetooth keyboard-wedge scanners are supported directly: the barcode field receives scanner characters, Enter resolves the code, and supported scanners without a suffix are resolved after the input pause. A fast-burst listener also routes scans when a scanner is used while another field or the page is focused. If another editable field is focused, the scanned value is inserted visibly into that exact field instead of opening an unrelated dialog.
- Quick billing with customer search by name / phone / vehicle, stock items, saved services and non-stock items, manual service/miscellaneous lines, editable quantities/rates, discount, payment method, amount received, due calculation and invoice numbering. New bill-only service / non-stock lines can be saved to the reusable catalogue when the invoice commits; catalogue quantity is always 0 and never reduces stock.
- Invoice save uses one IndexedDB transaction for stock reductions, stock movement rows, invoice record, invoice sequence and initial payment. If stock is insufficient, the invoice is not committed.
- Invoice preview and browser print / Save as PDF.
- Customer list, search, profiles, edit and customer-wise invoice history. New and edited customer records require a name and a valid 10-digit phone number.
- Ledger filters, invoice history, due balances and subsequent payment collection.
- Sales reports and inventory valuation/alerts.
- Local JSON backup/restore with schema validation and a safety-backup download before restore. Import also recognises the original PouchDB document-array backup format and converts old customers, stock, invoice history and payments to the current schema.
- The separate Admin app is intentionally not part of this WorkshopPro v5 build; it will be developed after the shop app and its synchronization are validated.
- Google Drive record-level synchronization using append-only operation files (`WP5_OP_*.json`), unique operation IDs, local outbox, idempotent apply tracking, per-record baselines, conflict records and retry-on-reconnect. The existing JSON backup / restore remains available separately.
- Responsive layout and PWA shell caching for supported browsers.

## Barcode scanner setup

- For a USB or Bluetooth handheld scanner, set its output mode to **USB HID keyboard** (or Bluetooth keyboard) and configure an **Enter suffix** where supported. Click the Barcode / item code field in Add stock, or the inventory search field in Billing, then scan. The scanned text appears in the field and is looked up automatically.
- Camera scanning is available from the Scan button beside the stock barcode field or the Inventory / Billing scan actions. Camera access requires `localhost` or HTTPS and browser camera permission.
- A scanner is not the same as a database connection. This app persists records in the browser's IndexedDB database. v5 shares changes between devices as separate append-only Google Drive operation files; Drive is still cloud file storage rather than a transactional database.

## Run locally

Use a local HTTP server instead of opening `index.html` as a `file://` URL:

```bash
python -m http.server 8000
```

Open <http://localhost:8000>.

Camera access and service-worker installation require `localhost` or HTTPS. IndexedDB records remain on the browser/device where they were created until synchronization uploads them. Offline edits are saved locally immediately and queued in IndexedDB. Automatic sync is attempted on app open, after edits, when the browser reports online, and every 30 seconds while the app is active. Google authorization may need reconnecting after reload.

## Admin app status

The future separate Admin app is deferred as requested. WorkshopPro v5 is the shop tablet application. Admin-specific remote editing and stock correction workflows are not enabled in this build.

## Google Drive setup and automatic sync

1. Open Google Cloud Console and create/select a project.
2. Enable the Google Drive API.
3. Configure the Google Auth Platform consent screen as required for your app.
4. Create an OAuth 2.0 Client ID with application type **Web application**.
5. Add `http://localhost:8000` under Authorized JavaScript origins for local testing, and add the production website origin when hosted.
6. Put the Client ID in `config.js` as `googleClientId`. Do not add a client secret to this frontend app.
7. In Settings & Backup, choose **Connect Google Drive & Start Sync** on the shop tablet first. The first device that creates the v5 manifest becomes the initial data seeder and publishes its existing records as append-only operations. Connect the second device only after the first device has completed its initial upload; the second device should start with an empty WorkshopPro database so it can receive the shared records. The **Download backup** and **Create snapshot backup** controls remain available. Snapshot restore is available only before multi-device sync is initialized; after sync setup it is blocked to protect the shared operation history.

The Drive token is held in memory, not persisted in localStorage. On reload the app attempts silent authorization; if Google requires a user gesture, reconnect using the Settings button. Sync uploads each queued operation as a separate file and downloads unseen operation IDs. Retrying an upload after a lost response can create another file with the same operation ID, but the receiving device applies that ID only once. The outbox is retained locally until the Drive upload returns successfully. Concurrent edits to the same mutable record are saved in a conflict list rather than silently overwritten. Inventory quantity changes are represented by stock movement events; initial seed inventory quantities are copied as a baseline and old movements are marked historical.

## v5 synchronization behaviour and limits

- WorkshopPro on the shop tablet is the only device intended to create bills, payments, stock receipts and stock deductions. Any second WorkshopPro device is automatically marked read-only after connecting to the shop tablet's manifest. It cannot create bills, collect payments, edit stock or change master data. The separate Admin app with controlled online editing will be built later.
- The local transaction is committed first. Sync is asynchronous and never blocks offline billing.
- Every operation has a unique ID and is applied at most once per device. A lost upload response can result in duplicate Drive files, but not duplicate local application of the same operation ID.
- Bills, payments and stock movements are separate records. Stock quantity changes are replayed from stock movement events; historical movements in the initial seed do not get replayed on top of the seeded balance.
- Same-record concurrent edits are flagged as conflicts. This v5 build displays the conflict count in sync status; a dedicated Admin conflict-review workflow is deferred to the Admin app.
- This is not a transactional database. Google Drive does not provide a reliable compare-and-swap lock for this design. Initial setup must be sequential (shop tablet first, second device after seed completes). Do not connect two independently initialized databases as first seeders.
- Continuous sync while the browser is closed or suspended cannot be guaranteed. Sync resumes on app open, reconnect, edits and periodic checks while the app is running. If a device is destroyed before its offline outbox uploads, its unsynchronized local changes can be lost.
- Do not use the legacy snapshot Restore on a live multi-device workspace as a routine sync method. It is a recovery operation and can create conflicts with the operation history.

## Backup format

JSON backup schema version 3 contains `customers`, `inventory`, `services`, `bills`, `payments`, `stockMovements`, and `settings`. Version-2 backups remain importable; the missing services table is initialized empty. Import only backup files you trust. Restore replaces all current local records after confirmation and downloads a safety copy first; v5 blocks snapshot restore once shared sync has been initialized.

## Tests and checks

Run the pure business-logic and sync-helper tests:

```bash
node --test tests/*.test.cjs
python tests/static_check.py
```

The test suite covers invoice totals/discount/payment validation, stock aggregation, CSV escaping, customer balances, backup schema validation, keyboard-wedge burst detection, legacy PouchDB conversion and v5 sync fingerprint rules. Browser/device-specific camera, print, IndexedDB, Google OAuth and two-device offline/reconnect flows still need to be exercised in the target browser and Google Cloud project before production use.

## Important notes

- This is a new implementation based on the visible reference feature set, not a claim that hidden behavior from the old project has been reproduced exactly.
- The app stores operational records in the browser database named `WorkshopProDB_v2` (IndexedDB), schema version 4. It adds local synchronization stores (`syncMeta`, `syncOutbox`, `syncApplied`, `syncConflicts`) without replacing existing business records. Existing version-2 databases are upgraded in place with a new `services` store; existing customers, stock, invoices, payments and movement history are retained. A stock receipt and its movement record commit together; an invoice, invoice counter, payment and all stock deductions commit together. It refreshes other open app tabs on the same origin after changes. If the original PouchDB `workshop_db` exists in the same browser profile and same website origin (same protocol, host and port) and the new database is empty, first startup attempts a one-time migration of customers, inventory, stock in/sold balances, invoice history and recorded initial payments. The migration leaves the original PouchDB database untouched. Use regular backup exports, especially before changing devices or clearing browser data.
- Printing uses the browser print dialog; select **Save as PDF** in the print destination.
- Third-party scanner and Google Identity scripts are loaded from their respective CDNs. Local data entry and billing do not require Google Drive.
