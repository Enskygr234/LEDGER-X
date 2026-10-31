/**
 * Versioned schema migrations for the LEDGER X business database.
 *
 * Rules:
 *  - Migrations are append-only. Never edit a released migration; add a new one.
 *  - Each migration runs in its own transaction and is recorded in
 *    `schema_migrations`, so the database is never rebuilt on launch.
 *  - User-created Database Studio projects live in *separate* SQLite files and
 *    are never touched by these migrations.
 */

// Columns shared by every record that synchronises with Supabase.
const SYNC_COLS = `
  user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  sync_state TEXT NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending','synced','conflict'))`;

export const MIGRATIONS = [
  {
    version: 1,
    name: 'core_business_schema',
    up: `
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE business_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  legal_name TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  address TEXT,
  tax_id TEXT,
  logo_data_url TEXT,
  default_currency TEXT NOT NULL DEFAULT 'USD',
  default_tax_rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (default_tax_rate_bp BETWEEN 0 AND 100000),
  payment_details TEXT,
  invoice_prefix TEXT NOT NULL DEFAULT 'INV-',
  quote_prefix TEXT NOT NULL DEFAULT 'QUO-',
  next_invoice_seq INTEGER NOT NULL DEFAULT 1,
  next_quote_seq INTEGER NOT NULL DEFAULT 1,
  ${SYNC_COLS}
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  code TEXT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  email TEXT,
  phone TEXT,
  address TEXT,
  tax_id TEXT,
  notes TEXT,
  archived_at TEXT,
  ${SYNC_COLS}
);
CREATE INDEX ix_customers_name ON customers(name COLLATE NOCASE);
CREATE UNIQUE INDEX ux_customers_code ON customers(code) WHERE code IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  sku TEXT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT,
  category TEXT,
  kind TEXT NOT NULL DEFAULT 'product' CHECK (kind IN ('product','service')),
  unit TEXT NOT NULL DEFAULT 'pcs',
  unit_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  tax_rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 100000),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  ${SYNC_COLS}
);
CREATE UNIQUE INDEX ux_products_sku ON products(sku) WHERE sku IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_products_category ON products(category);

CREATE TABLE quotations (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT,
  customer_snapshot TEXT,
  issue_date TEXT NOT NULL,
  expiry_date TEXT,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','rejected','expired')),
  subtotal_minor INTEGER NOT NULL DEFAULT 0,
  discount_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  terms TEXT,
  converted_invoice_id TEXT,
  ${SYNC_COLS}
);
CREATE UNIQUE INDEX ux_quotations_number ON quotations(number) WHERE deleted_at IS NULL;
CREATE INDEX ix_quotations_customer ON quotations(customer_id);

CREATE TABLE quotation_items (
  id TEXT PRIMARY KEY,
  quotation_id TEXT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  unit TEXT,
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  discount_type TEXT NOT NULL DEFAULT 'none' CHECK (discount_type IN ('none','percent','amount')),
  discount_value INTEGER NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  tax_rate_bp INTEGER NOT NULL DEFAULT 0,
  line_subtotal_minor INTEGER NOT NULL,
  line_discount_minor INTEGER NOT NULL,
  line_tax_minor INTEGER NOT NULL,
  line_total_minor INTEGER NOT NULL,
  ${SYNC_COLS}
);
CREATE INDEX ix_quotation_items_quotation ON quotation_items(quotation_id);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT,
  customer_snapshot TEXT,
  issue_date TEXT NOT NULL,
  due_date TEXT,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','partially_paid','paid','overdue','cancelled')),
  subtotal_minor INTEGER NOT NULL DEFAULT 0,
  discount_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL DEFAULT 0,
  paid_minor INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  terms TEXT,
  quotation_id TEXT REFERENCES quotations(id) ON DELETE SET NULL,
  ${SYNC_COLS}
);
CREATE UNIQUE INDEX ux_invoices_number ON invoices(number) WHERE deleted_at IS NULL;
CREATE INDEX ix_invoices_customer ON invoices(customer_id);
CREATE INDEX ix_invoices_issue_date ON invoices(issue_date);
CREATE INDEX ix_invoices_status ON invoices(status);

CREATE TABLE invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  unit TEXT,
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  discount_type TEXT NOT NULL DEFAULT 'none' CHECK (discount_type IN ('none','percent','amount')),
  discount_value INTEGER NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  tax_rate_bp INTEGER NOT NULL DEFAULT 0,
  line_subtotal_minor INTEGER NOT NULL,
  line_discount_minor INTEGER NOT NULL,
  line_tax_minor INTEGER NOT NULL,
  line_total_minor INTEGER NOT NULL,
  ${SYNC_COLS}
);
CREATE INDEX ix_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX ix_invoice_items_product ON invoice_items(product_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  paid_at TEXT NOT NULL,
  method TEXT,
  reference TEXT,
  note TEXT,
  ${SYNC_COLS}
);
CREATE INDEX ix_payments_invoice ON payments(invoice_id);
CREATE INDEX ix_payments_paid_at ON payments(paid_at);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_audit_created ON audit_logs(created_at);
`,
  },
  {
    version: 2,
    name: 'sync_infrastructure',
    up: `
CREATE TABLE sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','failed','done')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_sync_queue_status ON sync_queue(status, id);
CREATE UNIQUE INDEX ux_sync_queue_open ON sync_queue(table_name, row_id) WHERE status <> 'done';

-- Last copy of each record as confirmed by the server (3-way merge base).
CREATE TABLE sync_shadow (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (table_name, row_id)
);

CREATE TABLE sync_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  local_data TEXT NOT NULL,
  remote_data TEXT NOT NULL,
  base_data TEXT,
  fields TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);
CREATE INDEX ix_sync_conflicts_open ON sync_conflicts(resolved_at);
`,
  },
  {
    version: 3,
    name: 'database_studio_and_tooling',
    up: `
CREATE TABLE database_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  db_name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_modified_at TEXT
);

-- Presentation metadata for tables in a project (ER layout, notes).
-- The schema itself is always introspected from SQLite (single source of truth).
CREATE TABLE database_tables (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES database_projects(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  pos_x REAL,
  pos_y REAL,
  note TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, table_name)
);

-- Per-column presentation metadata (descriptions) for Studio tables.
CREATE TABLE database_columns (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES database_tables(id) ON DELETE CASCADE,
  column_name TEXT NOT NULL,
  description TEXT,
  UNIQUE (table_id, column_name)
);

CREATE TABLE saved_queries (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  sql TEXT NOT NULL,
  is_favorite INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE query_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  sql TEXT NOT NULL,
  duration_ms REAL,
  row_count INTEGER,
  error TEXT,
  executed_at TEXT NOT NULL
);
CREATE INDEX ix_query_history_project ON query_history(project_id, id);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  category TEXT,
  description TEXT NOT NULL,
  vendor TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  spent_at TEXT NOT NULL,
  ${SYNC_COLS}
);
CREATE INDEX ix_expenses_spent_at ON expenses(spent_at);

CREATE TABLE tax_rates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rate_bp INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 100000),
  is_default INTEGER NOT NULL DEFAULT 0,
  ${SYNC_COLS}
);

CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  file_name TEXT NOT NULL,
  location TEXT,
  size_bytes INTEGER,
  record_count INTEGER,
  checksum TEXT,
  schema_version INTEGER,
  kind TEXT NOT NULL DEFAULT 'manual'
);
`,
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export async function currentVersion(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const row = await db.get('SELECT MAX(version) AS v FROM schema_migrations');
  return Number(row?.v || 0);
}

/**
 * Apply all pending migrations in order. Returns the list of versions applied.
 * `upTo` is used by tests to simulate an older installation.
 */
export async function migrate(db, { upTo = LATEST_VERSION, now = () => new Date().toISOString() } = {}) {
  const from = await currentVersion(db);
  const applied = [];
  for (const m of MIGRATIONS) {
    if (m.version <= from || m.version > upTo) continue;
    await db.tx(async (t) => {
      await t.exec(m.up);
      await t.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [m.version, m.name, now()]);
    });
    applied.push(m.version);
  }
  return applied;
}
