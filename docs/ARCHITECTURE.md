# LEDGER X — Architecture

## Layers

```
pages/ (UI)  →  services/ (business rules, validation)  →  storage/ (SQLite, migrations, sync queue)
                                    ↓
                 storage/adapters: capacitor-sqlite | sql.js+IndexedDB | dev bridge | node:sqlite
```

* **UI**: framework-free ES modules. `h()` builds DOM nodes and always sets text through `textContent`. Pages are `async (params, ctx) => { title, el, actions }`. The router handles per-tab history, unsaved-change guards, and refreshes pages on data changes.
* **Services**: all rules live here (totals, statuses, archival, numbering, conflicts), so they are unit-testable without a browser. UI code never computes money.
* **Storage**: `SqlDatabase` serialises every call through a mutex and offers `tx()` (BEGIN IMMEDIATE / COMMIT / ROLLBACK) and `exclusive()`. Drivers only implement `run/all/exec/close`.

## Platform drivers

| Environment | Driver | Persistence |
|---|---|---|
| Android (Capacitor) | `@capacitor-community/sqlite`, reached through the Capacitor bridge | native SQLite files in app storage |
| Desktop browser via `npm run serve` | dev bridge → `node:sqlite` | `.data/*.sqlite` |
| Static web build | sql.js (WASM) | database image in IndexedDB after each committed write |
| Tests | `node:sqlite` | temp files (proves close/reopen persistence) |

Native plugins (SQLite, Filesystem, Share, Network, App, StatusBar, SplashScreen, SecureStorage) are resolved at runtime with `Capacitor.registerPlugin(name)`, so one bundle runs everywhere.

## Data model (business database `ledgerx_main`)

Synchronised tables (each has `id TEXT` UUID created on the device, `user_id`, `created_at`, `updated_at`, `deleted_at`, `version`, `sync_state`):

```
business_profiles   tax_rates
customers ─┬─< quotations ─< quotation_items >─ products
           └─< invoices ───< invoice_items  >─ products
                  │  └─(quotation_id)→ quotations   (quotations.converted_invoice_id → invoices)
                  └─< payments
expenses
```

Local-only tables: `app_settings`, `users`, `audit_logs`, `sync_queue`, `sync_shadow`, `sync_conflicts`, `database_projects`, `database_tables` (ER layout), `database_columns` (column notes), `saved_queries`, `query_history`, `backups`, `schema_migrations`.

Key constraints:
* `customers` → documents use `ON DELETE RESTRICT`. The app never hard-deletes business rows; removal is a soft delete (`deleted_at`) or, for customers with documents, archival (`archived_at`).
* Partial unique indexes: invoice and quotation numbers, product SKUs and customer codes are unique among non-deleted rows.
* Each document stores a `customer_snapshot` (JSON) so historical PDFs stay correct after the customer changes.
* Money is stored in minor units, quantity in thousandths and rates in basis points (all INTEGER). Header totals are always recomputed from items in `invoiceService.saveDocument`.

### Migrations
`storage/migrations.js` holds append-only, numbered migrations. Each runs in its own transaction and is recorded in `schema_migrations`, so the database is never rebuilt on launch. Tests cover a fresh install and an upgrade from v1 with existing data.

### Database Studio isolation
Each Studio project is its own SQLite file (`ledgerx_proj_<id>`). The schema is always introspected from SQLite itself, which is the single source of truth. `database_tables` only stores presentation data (ER positions).

## SQL safety

* Application code binds every value as a parameter. The only dynamic identifiers (Studio table and column names) are validated (`^[A-Za-z_][A-Za-z0-9_ ]*$`) and quoted with `quoteIdent`.
* User SQL goes through `services/sqlGuard.js`, a real tokenizer that handles strings, comments and CTEs:
  * allowed: SELECT, INSERT, UPDATE, DELETE, CREATE TABLE/INDEX/VIEW, ALTER TABLE, DROP TABLE/INDEX/VIEW, EXPLAIN, read-only PRAGMAs;
  * blocked: ATTACH/DETACH, cross-database names, PRAGMA writes, `load_extension`, VACUUM, transaction control, triggers, virtual and temporary tables, writes to `sqlite_*`;
  * flagged as destructive (confirmation required): DELETE, UPDATE, DROP, ALTER … DROP, INSERT OR REPLACE. Missing WHERE clauses also produce a warning.
* A script runs inside one transaction, so a failing statement rolls back the whole script.
* The business database is read-only in Studio. The guard rejects writes, and execution also runs under `PRAGMA query_only = ON` as a second, SQLite-enforced line of defence.

## Synchronisation protocol

1. **Local first.** `insertRecord` / `updateRecord` / `softDelete` write the row, set `sync_state='pending'`, and upsert a `sync_queue` entry in the **same transaction**.
2. **Pull profile.** `business_profiles` comes down first, so a new device adopts the account's profile and keeps the higher document counters.
3. **Push.** Queue entries are sent in parent-to-child order.
   * New rows: `POST` with `version = 1`.
   * Edited rows: `PATCH …?id=eq.X&version=eq.<v>` with `version = v + 1` (optimistic concurrency). The server trigger independently rejects any version that isn't old + 1.
   * Zero rows updated means someone else changed the row: fetch it and reconcile.
4. **Pull.** For each table, fetch rows where `server_updated_at >= cursor` (stamped by the server's clock, so device clocks don't matter).
   * Unknown row → insert. Local copy synced and remote newer → overwrite. Local copy pending and remote newer → reconcile.
5. **Reconcile (3-way merge).** `sync_shadow` holds the last server copy (the base). Fields changed on only one side merge automatically. Fields changed differently on both sides become a **conflict** (`sync_conflicts`), the row is marked `conflict` and is not pushed until the user picks a value per field in *Settings → Synchronisation*.
   * Derived fields (`*_minor` totals, `paid_minor`, payment-driven invoice status) never conflict. After every sync they are **recomputed from the merged items and payments**, so two devices recording payments offline both keep their payments and the invoice balance stays correct.
   * Draft and cancelled statuses are user decisions, so they can conflict.
6. **Document numbers.** If two devices both issued `INV-0007` offline, the server's unique index rejects the second one. On the next pull the local document is renumbered to the next free number, with an entry in the audit log, and then uploaded.
7. **Failures.** A network error stops the cycle and leaves the queue untouched. A server rejection marks that entry `failed` with `attempts` and `last_error` (shown in the UI); *Retry failed* re-queues it. Completed entries are pruned after 7 days.

Triggers: app start, network regained, 4 s after local changes, app resume, every 3 minutes, and manual *Sync now*.

## Security

* Only the Supabase **anon** key ships. Both the build and the app reject service-role keys. RLS (`user_id = auth.uid()`) applies on select, insert and update; there is no delete grant. The trigger forces ownership on insert and update, and child rows can't reference another account's parents.
* Access and refresh tokens are stored with the Android Keystore-backed secure storage plugin, never in SQLite. Nothing logs passwords, tokens or financial data.
* HTTPS is enforced by the client and by the Content-Security-Policy (`connect-src` limited to `*.supabase.co`).
* CSV exports neutralise spreadsheet formulas (`=`, `+`, `-`, `@`).

## PDF
`pdf-lib` generates the PDF fully offline, and PDF.js renders the preview to canvases (Android WebView can't show PDFs inline). The standard Helvetica font covers Latin-1; other characters are transliterated (for example `ş→s`, `₺→TRY`). **Full Unicode in PDFs** requires `@pdf-lib/fontkit` and embedding the bundled Inter font, which is a small change in `pdfService.js`. This is a known limitation of v1.0.

## Deviations from the original brief (and why)
| Brief | Implemented | Reason |
|---|---|---|
| jsPDF | pdf-lib | similar API surface; better font/image embedding; available offline in the build environment |
| Chart.js | in-house SVG charts (`components/Charts.js`) | ~6 KB instead of ~200 KB; colour-blind-validated palette; tooltips; table view for accessibility |
| graph library for ER | in-house SVG renderer | needed table-shaped nodes with per-column anchors; pan, zoom, drag and PNG export without a dependency |
| supabase-js | fetch client (`services/supabaseClient.js`) on the same REST/Auth endpoints | no bundle cost; tokens stay under the app's control (secure storage) |
| Vite / Vitest | esbuild / `node:test` | smaller toolchain; the tests use the same SQLite engine family as the device |
| Database Studio sync | Studio projects are local and included in backups | syncing arbitrary user schemas needs a different protocol; planned for a later version |
| Language | UI text in English; number, date and currency formatting localised | full translations need a string catalogue; formatting locale is user-selectable |

## Release verification checklist
These steps need a device or emulator and a real Supabase project, so they were not run in the automated suite:
1. `npx cap run android`: create an invoice in airplane mode, force-stop the app, reopen, and confirm the invoice is there.
2. Turn the network back on and log in. Check the Supabase dashboard: rows exist with your `user_id`, and an anon request returns nothing.
3. Log in on a second device or emulator and confirm the records arrive.
4. Edit the same invoice note on both devices offline, sync both, and confirm a conflict appears and resolves.
5. Share a PDF to Gmail or Drive, export a backup to Files, restore it on a clean install, and check the relationships.
6. Test the back button, keyboard resize on the invoice editor, and the status bar colour in both themes.
