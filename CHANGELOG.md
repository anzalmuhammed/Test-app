# Changelog

## v5 — automatic record-level sync foundation

- Added append-only Google Drive operation files for record-level multi-device synchronization.
- Added local outbox, applied-operation deduplication, per-record baseline fingerprints and conflict records.
- Added automatic sync attempts on app startup, local edits, reconnect and periodic checks while the app is open.
- Preserved local-first IndexedDB writes and atomic bill / stock transaction flows.
- Added inventory stock movement replay so quantity is synchronized as deltas rather than last-write-wins snapshots.
- Added dark/light theme switch, clickable dashboard cards, customer autocomplete suggestions, title-case input normalization and cart quantity stepper controls.
- Deferred the separate Admin app as requested.

## v4 baseline

- Preserved existing billing, inventory, services, customer, ledger, reports, barcode scanning, printing and local backup workflows.
