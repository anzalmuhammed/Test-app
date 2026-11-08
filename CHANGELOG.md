# WorkshopPro corrected v7

- Retained the Admin and restricted Shop entry points from v6.
- Added automatic Drive polling and remote download when the local database has no pending changes.
- Added conflict stop when remote and local data have both changed; pending local work is not silently overwritten.
- Added separate IndexedDB `syncSafety` storage and a button to download the latest pre-pull safety copy.
- Marked local writes pending before the corresponding IndexedDB transaction, reducing the crash window where new local records could otherwise appear clean.
- Added IndexedDB v6 upgrade for the safety store, silent OAuth token-renewal attempt on reload, and bumped the service-worker cache to v7.
- Kept one named Google Drive snapshot; no per-transaction Drive files are created.
- Existing business features, invoice/payment/stock atomic transactions, formatting, barcode handling, database editor, reports, theme and responsive layouts retained.

## Verification

`node --check app.js`, `node --check core.js`, 11 Node tests and `tests/static_check.py` pass. No real Google OAuth or two-physical-device offline/reconnect test has been completed.
