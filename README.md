# WorkshopPro — Admin + Shop (corrected working build)

## Apps

- `index.html` — Admin: dashboard, inventory, services, billing, customers, ledger/payments, reports, settings, database tables and individual-field editor.
- `shop.html` — Shop: customer creation, Quick Billing, read-only inventory and read-only ledger.

Both use the same IndexedDB schema in each browser profile. They are responsive layouts for desktop, tablet and mobile. The two entry points are UI-level role separation only; they are not server-enforced security boundaries.

## Automatic sync behavior

After connecting Google Drive in a browser session, the app now:

- Checks the shared snapshot on connection, after local changes, when the browser returns online, on tab focus/visibility return, and approximately every 25 seconds while open.
- Uploads local changes automatically when the shared file still matches the last confirmed remote version.
- Downloads a newer remote snapshot automatically only when this device has no pending local changes.
- Saves a local safety snapshot in a separate IndexedDB `syncSafety` store before an automatic remote pull. The five most recent pre-pull safety snapshots are retained on that device.
- If the cloud copy changed while this device has pending local changes, pauses and displays **Conflict needs review**. It does not silently replace the local copy or automatically merge two different snapshots.
- Keeps business writes local-first. Bills, their initial payments, invoice counter, stock deductions and stock movements are committed together in IndexedDB transactions.

### Important limits

- Google Drive is file storage, not a transactional database. Updating one shared JSON file has no atomic compare-and-swap operation. Two devices can still race between checking the remote version and uploading. Use one designated Shop device for routine transactions. Pause Shop activity before Admin maintenance and wait for sync to finish before switching devices.
- This release detects a changed remote snapshot, but it does **not** merge two independently modified offline databases. If both sides changed, preserve both local and remote copies and reconcile them before continuing. Never choose Restore casually when there are pending local transactions.
- Google access tokens are held in memory, not saved in local storage. On reload the app attempts a silent token renewal for a previously authorized account; if Google requires user interaction, the Connect Google Drive action is shown. While the browser is closed or suspended, periodic sync cannot run; it catches up after reopening and renewing the session if needed.
- The Admin/Shop distinction is enforced in the client UI, not by a server. It is not suitable as a hostile multi-user security boundary.
- ₹0/month means no additional hosted database/backend subscription. Google Cloud OAuth/API configuration and Google account/API limits still apply.
- Absolute zero data loss cannot be guaranteed by a browser-only app. Device loss, cleared browser storage, revoked access, API failures or unsynced offline work can still cause loss. Download regular backups and retain copies outside the browser.

## Setup

Serve over HTTP/HTTPS (not `file://`). For local testing:

```bash
python -m http.server 8000
```

- Admin: `http://localhost:8000/index.html`
- Shop: `http://localhost:8000/shop.html`

Set the Google OAuth Web Client ID in `config.js`, enable Google Drive API, and authorize the website origin in Google Cloud Console. Deploy the whole folder to one HTTPS origin; both devices should use that origin and the same Google account.

## Verification status

The included Node business-logic tests and static HTML/asset checks can verify code paths and required UI elements. They do not simulate real Google OAuth, simultaneous Drive writes, browser storage eviction, or two physical devices going offline and reconnecting. Complete those acceptance tests with sample data before relying on the app for live transactions.
