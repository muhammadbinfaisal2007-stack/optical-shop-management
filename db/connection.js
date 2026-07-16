// db/connection.js
//
// WHY THIS FILE EXISTS:
// Every other file in the app needs access to the same database connection.
// Instead of each file opening its own connection to the .db file, we open
// ONE connection here and export it, so everyone shares it. This is important
// for SQLite specifically — having multiple separate connections writing to
// the same file at once can cause "database is locked" errors.
//
// On first run, this also creates the .db file and runs schema.sql to set
// up every table if they don't already exist (safe to run every time the
// app starts, thanks to "CREATE TABLE IF NOT EXISTS").

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

// The actual database file lives in db/shop.db — this is the ONE file you
// back up to protect all shop data (see db/backup.js).
const DB_PATH = path.join(__dirname, 'shop.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const db = new DatabaseSync(DB_PATH);

// Foreign key enforcement is off by default in SQLite — we turn it on so
// that, e.g., you can't create an invoice_item pointing at a customer_id
// that doesn't exist.
db.exec('PRAGMA foreign_keys = ON;');

// Run the schema file. This sets up all tables the first time, and does
// nothing harmful on subsequent runs since every statement uses
// "IF NOT EXISTS".
const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schemaSql);

// ------------------------------------------------------------------
// LIGHTWEIGHT MIGRATIONS
// "CREATE TABLE IF NOT EXISTS" only helps on a brand-new database — it
// does NOT add new columns to a table that already exists from a
// previous version of the app. Since the shop's database file persists
// across updates (that's the whole point of local storage), we check
// for columns we've added after the initial release and add them here
// if missing. This runs every startup but is a no-op once applied.
// ------------------------------------------------------------------
function columnExists(table, column) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    return columns.some(col => col.name === column);
}

if (!columnExists('users', 'discount_limit_percent')) {
    db.exec(`ALTER TABLE users ADD COLUMN discount_limit_percent INTEGER NOT NULL DEFAULT 10;`);
}

if (!columnExists('payments', 'tendered_amount')) {
    db.exec(`ALTER TABLE payments ADD COLUMN tendered_amount REAL;`);
}
if (!columnExists('payments', 'change_given')) {
    db.exec(`ALTER TABLE payments ADD COLUMN change_given REAL;`);
}

// Card payments are no longer accepted (shop policy: cash only, plus
// bank transfer / other). SQLite can't alter a CHECK constraint directly,
// so if an existing database still has the old constraint (allowing
// 'card'), we rebuild the table with the new constraint and carry over
// every existing payment row — converting any historical 'card' entries
// to 'other' so old records remain valid instead of being lost.
const paymentsTableDef = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payments'
`).get();

if (paymentsTableDef && paymentsTableDef.sql.includes("'card'")) {
    db.exec(`
        CREATE TABLE payments_new (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_id    INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
            amount        REAL NOT NULL,
            method        TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'bank_transfer', 'other')),
            tendered_amount REAL,
            change_given    REAL,
            received_by   INTEGER REFERENCES users(id),
            paid_at       TEXT NOT NULL DEFAULT (datetime('now')),
            notes         TEXT
        );

        INSERT INTO payments_new (id, invoice_id, amount, method, tendered_amount, change_given, received_by, paid_at, notes)
        SELECT id, invoice_id, amount,
               CASE WHEN method = 'card' THEN 'other' ELSE method END,
               tendered_amount, change_given, received_by, paid_at, notes
        FROM payments;

        DROP TABLE payments;
        ALTER TABLE payments_new RENAME TO payments;

        CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
    `);
}

// ------------------------------------------------------------------
// DAY 4 MIGRATIONS
// ------------------------------------------------------------------

if (!columnExists('customers', 'is_active')) {
    db.exec(`ALTER TABLE customers ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;`);
}

if (!columnExists('invoice_items', 'is_service')) {
    db.exec(`ALTER TABLE invoice_items ADD COLUMN is_service INTEGER NOT NULL DEFAULT 0;`);
}
if (!columnExists('invoice_items', 'line_discount_percent')) {
    db.exec(`ALTER TABLE invoice_items ADD COLUMN line_discount_percent REAL NOT NULL DEFAULT 0;`);
}

if (!columnExists('invoices', 'cancelled_by')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN cancelled_by INTEGER REFERENCES users(id);`);
}
if (!columnExists('invoices', 'cancelled_at')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN cancelled_at TEXT;`);
}
if (!columnExists('invoices', 'cancellation_reason')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN cancellation_reason TEXT;`);
}

// The invoices.status CHECK constraint needs 'draft' added (FR-SI-08).
// Same rebuild-and-copy approach as the payments/card migration above —
// SQLite can't alter a CHECK constraint in place.
const invoicesTableDef = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'invoices'
`).get();

if (invoicesTableDef && !invoicesTableDef.sql.includes("'draft'")) {
    db.exec(`
        CREATE TABLE invoices_new (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_number TEXT NOT NULL UNIQUE,
            customer_id    INTEGER NOT NULL REFERENCES customers(id),
            prescription_id INTEGER REFERENCES prescriptions(id),
            created_by     INTEGER REFERENCES users(id),
            subtotal       REAL NOT NULL DEFAULT 0,
            discount_amount REAL NOT NULL DEFAULT 0,
            tax_amount     REAL NOT NULL DEFAULT 0,
            total_amount   REAL NOT NULL DEFAULT 0,
            amount_paid    REAL NOT NULL DEFAULT 0,
            balance_due    REAL NOT NULL DEFAULT 0,
            status         TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('draft', 'unpaid', 'partial', 'paid', 'cancelled')),
            cancelled_by   INTEGER REFERENCES users(id),
            cancelled_at   TEXT,
            cancellation_reason TEXT,
            created_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO invoices_new SELECT
            id, invoice_number, customer_id, prescription_id, created_by,
            subtotal, discount_amount, tax_amount, total_amount,
            amount_paid, balance_due, status,
            cancelled_by, cancelled_at, cancellation_reason, created_at
        FROM invoices;

        DROP TABLE invoices;
        ALTER TABLE invoices_new RENAME TO invoices;

        CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
        CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    `);
}

// Make sure the single settings row always exists, even on a database
// that predates the system_settings table being introduced.
db.exec(`INSERT OR IGNORE INTO system_settings (id) VALUES (1);`);

module.exports = db;
