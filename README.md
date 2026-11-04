# Workshop Pro — clean rebuild

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
- Separate `admin.html` database workspace with table views, search, JSON row editing, add/delete and CSV / full JSON export. It edits the same browser-local IndexedDB database, outside the main app interface. Configure `adminPin` in `config.js` before use; this client-side PIN is only a convenience lock, not real server authentication.
- Optional Google Drive backup/restore using Google Identity Services and the narrow `drive.file` scope. When automatic backup is enabled and Google Drive is connected in the current session, reconnecting to the internet schedules an upload of the latest local backup.
- Responsive layout and PWA shell caching for supported browsers.

## Barcode scanner setup

- For a USB or Bluetooth handheld scanner, set its output mode to **USB HID keyboard** (or Bluetooth keyboard) and configure an **Enter suffix** where supported. Click the Barcode / item code field in Add stock, or the inventory search field in Billing, then scan. The scanned text appears in the field and is looked up automatically.
- Camera scanning is available from the Scan button beside the stock barcode field or the Inventory / Billing scan actions. Camera access requires `localhost` or HTTPS and browser camera permission.
- A scanner is not the same as a database connection. This app persists records in the browser's IndexedDB database. To share live data among different devices/users, connect a real hosted database/backend with authentication and access rules; Google Drive backup is a snapshot/restore mechanism, not a live database.

## Run locally

Use a local HTTP server instead of opening `index.html` as a `file://` URL:

```bash
python -m http.server 8000
```

Open <http://localhost:8000>.

Camera access and service-worker installation require `localhost` or HTTPS. IndexedDB records remain on the browser/device where they were created. Offline edits are saved locally immediately. If Google Drive is connected, automatic backup is enabled, and the current-session access token is still valid, the app uploads a fresh backup after the connection returns. Reconnect Google Drive after a page reload. This is backup/restore, not live record-level multi-device synchronization or conflict-free merging. For shared live data across devices, a hosted backend with authentication and conflict handling is required.

## Separate admin database editor

Open `admin.html` from Settings & Backup. It reads the same IndexedDB database on the same browser origin and provides clean table rows, search, raw JSON editing, add/delete and exports. Set a private `adminPin` value in `config.js` before opening it. Because this is a browser-only static app, the PIN is visible to anyone who can inspect the downloaded JavaScript; it is not suitable as security for a public deployment. For a real remote admin role, use a server-side authenticated backend. Always download a backup before editing or deleting linked invoices, payments or stock movements.

## Google Drive setup

1. Open Google Cloud Console and create/select a project.
2. Enable the Google Drive API.
3. Configure the Google Auth Platform consent screen as required for your app.
4. Create an OAuth 2.0 Client ID with application type **Web application**.
5. Add `http://localhost:8000` under Authorized JavaScript origins for local testing, and add the production website origin when hosted.
6. Put the Client ID in `config.js` as `googleClientId`. Do not add a client secret to this frontend app.
7. In Settings & Backup, choose **Connect Google Drive**, then **Back up now**. The app creates or updates `WorkshopPro_Backup.json` in the connected account. Restore searches for both this current filename and the original `workshop_backup.json` filename, then converts the old PouchDB backup format where it is accessible to the app.

The Drive token is held in memory, not persisted in localStorage. Reconnect after a reload. Automatic uploads run after data changes and after internet reconnection only while an authorized token exists in the current session. After each page reload, reconnect and press Back up now or Restore once before automatic uploads are re-enabled. The app also checks the Drive backup modification time and pauses automatic upload if it detects that the cloud copy changed elsewhere. This is snapshot backup/restore, not live multi-device database synchronization. For long-lived unattended/background sync, use a backend with the OAuth authorization-code flow and secure token storage; a browser-only app cannot safely hold a client secret or refresh token.

## Backup format

JSON backup schema version 3 contains `customers`, `inventory`, `services`, `bills`, `payments`, `stockMovements`, and `settings`. Version-2 backups remain importable; the missing services table is initialized empty. Import only backup files you trust. Restore replaces all current local records after confirmation and downloads a safety copy first.

## Tests and checks

Run the pure business-logic tests (9 test cases):

```bash
node --test tests/core.test.cjs
```

The test suite covers invoice totals/discount/payment validation, stock aggregation, CSV escaping, customer balances, backup schema validation, keyboard-wedge burst detection and conversion of legacy PouchDB records. Browser/device-specific camera, print, IndexedDB and OAuth flows still need to be exercised in the target browser and Google Cloud project before production use.

## Important notes

- This is a new implementation based on the visible reference feature set, not a claim that hidden behavior from the old project has been reproduced exactly.
- The app stores operational records in the browser database named `WorkshopProDB_v2` (IndexedDB), schema version 3. Existing version-2 databases are upgraded in place with a new `services` store; existing customers, stock, invoices, payments and movement history are retained. A stock receipt and its movement record commit together; an invoice, invoice counter, payment and all stock deductions commit together. It refreshes other open app tabs on the same origin after changes. If the original PouchDB `workshop_db` exists in the same browser profile and same website origin (same protocol, host and port) and the new database is empty, first startup attempts a one-time migration of customers, inventory, stock in/sold balances, invoice history and recorded initial payments. The migration leaves the original PouchDB database untouched. Use regular backup exports, especially before changing devices or clearing browser data.
- Printing uses the browser print dialog; select **Save as PDF** in the print destination.
- Third-party scanner and Google Identity scripts are loaded from their respective CDNs. Local data entry and billing do not require Google Drive.
