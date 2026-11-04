# Workshop Pro v4 — implementation summary

- Increased mobile typography, spacing and tap targets; invoice totals are stronger and larger on screen and in the print window.
- Standardized invoice date display and saved-at time display to `Asia/Kolkata` (IST). Invoice business date is stored as a date at IST midnight; invoice creation time is shown separately.
- Kept IndexedDB local-first and offline-capable. Added automatic Google Drive backup scheduling after internet returns when auto-backup is enabled and a valid Drive session is connected. This remains snapshot backup, not live multi-device sync.
- Added database schema version 3 and a reusable `services` store. Existing v2 local databases upgrade in place; v2 JSON backups remain importable.
- Added a dedicated Services & Items page, plus saved-catalogue search in billing. New bill-only services/non-stock items can be saved when the invoice commits, with quantity 0 and no stock deduction.
- Added customer search in billing by name, phone or vehicle.
- Made customer name and a 10-digit phone number mandatory for new/edited customer records.
- Removed zero defaults from new stock/service price inputs so the fields start empty.
- Added separate `admin.html` database workspace with table views, search, JSON editing, add/delete, CSV/full JSON export, data-quality flags and change notifications to the main app tab.
- Kept the original PouchDB migration path and existing invoice/payment/stock records. No automatic customer merges or historical invoice rewrites are performed.

## Verification

- `node --test tests/core.test.cjs`: 9 passing tests.
- `python tests/static_check.py`: passing static checks.
- JavaScript syntax checks pass for `app.js`, `core.js`, `admin.js`, and `sw.js`.
- Real mobile device, camera scanner, browser print and Google OAuth flows still require hands-on verification in the deployment browser and Google Cloud project.
