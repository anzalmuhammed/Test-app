# Workshop Pro — clean rebuild

A fresh, offline-first browser app inspired by the features in the supplied `index.html` and `app.js` reference files. The reference code was used to understand the workflows; its implementation was not copied.

## Included workflows

- Dashboard totals, recent invoices and low-stock alerts.
- Inventory item creation, stock receipts, edits, archive, barcode ID, category/location, min-stock levels, search, filtering, sorting and CSV export.
- Barcode/QR scanning through the camera or an image file (requires a secure origin and the scanner library to load).
- Quick billing with customer and vehicle details, stock items, manual service/miscellaneous lines, editable quantities/rates, discount, payment method, amount received, due calculation and invoice numbering.
- Invoice save uses one IndexedDB transaction for stock reductions, stock movement rows, invoice record, invoice sequence and initial payment. If stock is insufficient, the invoice is not committed.
- Invoice preview and browser print / Save as PDF.
- Customer list, search, profiles, edit and customer-wise invoice history.
- Ledger filters, invoice history, due balances and subsequent payment collection.
- Sales reports and inventory valuation/alerts.
- Local JSON backup/restore with schema validation and a safety-backup download before restore.
- Optional Google Drive backup/restore using Google Identity Services and the narrow `drive.file` scope.
- Responsive layout and PWA shell caching for supported browsers.

## Run locally

Use a local HTTP server instead of opening `index.html` as a `file://` URL:

```bash
python -m http.server 8000
```

Open <http://localhost:8000>.

Camera access and service-worker installation require `localhost` or HTTPS. IndexedDB records remain on the browser/device where they were created until you transfer them with a backup/restore workflow.

## Google Drive setup

1. Open Google Cloud Console and create/select a project.
2. Enable the Google Drive API.
3. Configure the Google Auth Platform consent screen as required for your app.
4. Create an OAuth 2.0 Client ID with application type **Web application**.
5. Add `http://localhost:8000` under Authorized JavaScript origins for local testing, and add the production website origin when hosted.
6. Put the Client ID in `config.js` as `googleClientId`. Do not add a client secret to this frontend app.
7. In Settings & Backup, choose **Connect Google Drive**, then **Back up now**. The app creates or updates `WorkshopPro_Backup.json` in the connected account.

The Drive token is held in memory, not persisted in localStorage. Reconnect after a reload. Automatic uploads run after data changes only while an authorized token exists in the current session. After each page reload, reconnect and press Back up now or Restore once before automatic uploads are re-enabled. The app also checks the Drive backup modification time and pauses automatic upload if it detects that the cloud copy changed elsewhere. This is snapshot backup/restore, not live multi-device database synchronization. For long-lived unattended/background sync, use a backend with the OAuth authorization-code flow and secure token storage; a browser-only app cannot safely hold a client secret or refresh token.

## Backup format

JSON backup schema version 2 contains `customers`, `inventory`, `bills`, `payments`, `stockMovements`, and `settings`. Import only backup files you trust. Restore replaces all current local records after confirmation and downloads a safety copy first.

## Tests and checks

Run the pure business-logic tests:

```bash
node --test tests/core.test.cjs
```

The test suite covers invoice totals/discount/payment validation, quantity validation, stock aggregation, CSV escaping, customer balances and backup schema validation. Browser/device-specific camera, print, IndexedDB and OAuth flows still need to be exercised in the target browser and Google Cloud project before production use.

## Important notes

- This is a new implementation based on the visible reference feature set, not a claim that hidden behavior from the old project has been reproduced exactly.
- The app stores operational records locally in IndexedDB. Use regular backup exports, especially before changing devices or clearing browser data.
- Printing uses the browser print dialog; select **Save as PDF** in the print destination.
- Third-party scanner and Google Identity scripts are loaded from their respective CDNs. Local data entry and billing do not require Google Drive.
