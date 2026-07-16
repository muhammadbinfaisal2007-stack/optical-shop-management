-- ============================================================
-- Optical Shop Management System — Database Schema
-- Engine: SQLite (via Node's built-in node:sqlite module)
-- ============================================================

PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------
-- USERS & ROLES
-- Roles: 'admin', 'sales', 'optometrist'
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name     TEXT NOT NULL,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'sales', 'optometrist')),
    is_active     INTEGER NOT NULL DEFAULT 1,   -- 1 = active, 0 = disabled
    -- Only meaningful for role = 'sales'. Caps the discount % that
    -- employee can apply on an invoice without Admin approval (SRS
    -- Section 3, footnote **). Admin and Optometrist ignore this field.
    discount_limit_percent INTEGER NOT NULL DEFAULT 10,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Simple audit trail: who did what, when (SRS requires basic activity logging)
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id),
    action      TEXT NOT NULL,     -- e.g. 'LOGIN', 'CREATE_INVOICE', 'EDIT_CUSTOMER'
    details     TEXT,              -- free-text description
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ----------------------------------------------------------
-- CUSTOMERS
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_code TEXT NOT NULL UNIQUE,   -- human-friendly ID, e.g. CUST-0001
    full_name     TEXT NOT NULL,
    phone         TEXT NOT NULL,
    email         TEXT,
    address       TEXT,
    date_of_birth TEXT,
    notes         TEXT,
    -- Customers are never hard-deleted by default (FR-CM-06) — their
    -- historical invoices/prescriptions must stay intact. Deactivating
    -- just hides them from normal lists/search. Admin can hard-delete
    -- ONLY a customer with zero invoices (see server/routes/customers.js).
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_name  ON customers(full_name);

-- ----------------------------------------------------------
-- PRESCRIPTIONS
-- One customer can have many prescriptions over time (versioned history).
-- OD = right eye, OS = left eye (standard optometry convention).
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS prescriptions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id    INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    prescribed_by  INTEGER REFERENCES users(id),   -- optometrist who wrote it
    prescribed_date TEXT NOT NULL DEFAULT (date('now')),

    -- Right eye (OD)
    od_sphere      REAL,
    od_cylinder    REAL,
    od_axis        INTEGER,
    od_add         REAL,

    -- Left eye (OS)
    os_sphere      REAL,
    os_cylinder    REAL,
    os_axis        INTEGER,
    os_add         REAL,

    pupillary_distance REAL,   -- PD, in mm
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_prescriptions_customer ON prescriptions(customer_id);

-- ----------------------------------------------------------
-- SUPPLIERS
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    phone       TEXT,
    email       TEXT,
    address     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ----------------------------------------------------------
-- INVENTORY ITEMS
-- Covers both frames and lenses (and could extend to accessories).
-- item_type distinguishes them; category-specific fields are optional.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    item_code       TEXT NOT NULL UNIQUE,        -- e.g. FRM-0001, LNS-0001
    item_type       TEXT NOT NULL CHECK (item_type IN ('frame', 'lens', 'accessory')),
    name            TEXT NOT NULL,
    brand           TEXT,
    model           TEXT,
    color           TEXT,
    size            TEXT,
    supplier_id     INTEGER REFERENCES suppliers(id),
    cost_price      REAL NOT NULL DEFAULT 0,
    selling_price   REAL NOT NULL DEFAULT 0,
    quantity_in_stock INTEGER NOT NULL DEFAULT 0,
    reorder_level   INTEGER NOT NULL DEFAULT 5,   -- triggers low-stock alert
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_type ON inventory_items(item_type);
CREATE INDEX IF NOT EXISTS idx_inventory_name ON inventory_items(name);

-- ----------------------------------------------------------
-- NOTIFICATIONS
-- WHY THIS TABLE EXISTS: Sales Staff can adjust stock directly (no
-- approval blocking their work), but every such change creates a
-- notification here so the Admin sees a clear trail of "who changed
-- what, when, and why" without having to dig through the full audit
-- log. This is the fraud-visibility safeguard: it doesn't stop a change
-- from happening, but it guarantees the Admin is alerted to it.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,          -- e.g. 'stock_adjustment'
    message     TEXT NOT NULL,
    reference_id INTEGER,               -- e.g. the inventory_items.id this is about
    is_read     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read);

-- Every stock change (received from supplier, sold, adjusted, damaged) is logged here.
-- This is the single source of truth for "why does the stock number say what it says".
CREATE TABLE IF NOT EXISTS stock_movements (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id       INTEGER NOT NULL REFERENCES inventory_items(id),
    change_qty    INTEGER NOT NULL,       -- positive = stock in, negative = stock out
    reason        TEXT NOT NULL,          -- 'purchase', 'sale', 'adjustment', 'damaged', 'return'
    reference_id  INTEGER,                -- e.g. invoice id, if reason = 'sale'
    user_id       INTEGER REFERENCES users(id),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ----------------------------------------------------------
-- INVOICES (SALES)
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT NOT NULL UNIQUE,     -- e.g. INV-2026-0001
    customer_id    INTEGER NOT NULL REFERENCES customers(id),
    prescription_id INTEGER REFERENCES prescriptions(id),
    created_by     INTEGER REFERENCES users(id),

    subtotal       REAL NOT NULL DEFAULT 0,
    discount_amount REAL NOT NULL DEFAULT 0,
    tax_amount     REAL NOT NULL DEFAULT 0,
    total_amount   REAL NOT NULL DEFAULT 0,

    amount_paid    REAL NOT NULL DEFAULT 0,
    balance_due    REAL NOT NULL DEFAULT 0,
    -- 'draft' = held/parked, not yet finalized: no stock has been
    -- deducted and it does NOT count in sales reports or the dashboard
    -- (FR-SI-08). 'cancelled' = voided after being finalized, stock has
    -- been reversed (FR-SI-10). Both are permanent history — neither is
    -- ever deleted from the table.
    status         TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('draft', 'unpaid', 'partial', 'paid', 'cancelled')),

    -- Populated only when an Admin voids/cancels a finalized invoice.
    cancelled_by   INTEGER REFERENCES users(id),
    cancelled_at   TEXT,
    cancellation_reason TEXT,

    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status   ON invoices(status);

CREATE TABLE IF NOT EXISTS invoice_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id    INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    -- NULL for a non-stock service line (e.g. "Lens Fitting Charge") —
    -- those don't touch inventory at all (FR-SI-03).
    item_id       INTEGER REFERENCES inventory_items(id),
    is_service    INTEGER NOT NULL DEFAULT 0,
    description   TEXT NOT NULL,        -- snapshot of item name at time of sale
    unit_price    REAL NOT NULL,
    quantity      INTEGER NOT NULL DEFAULT 1,
    -- Optional per-line discount (FR-SI-04), separate from the
    -- invoice-level discount — a sale can use either, both, or neither.
    line_discount_percent REAL NOT NULL DEFAULT 0,
    line_total    REAL NOT NULL          -- AFTER line_discount_percent is applied
);

-- ----------------------------------------------------------
-- PAYMENTS
-- An invoice can receive multiple payments over time (partial payments).
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id    INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    amount        REAL NOT NULL,
    method        TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'bank_transfer', 'other')),
    -- Only meaningful when method = 'cash': how much cash the customer
    -- physically handed over, and the change given back. amount stays
    -- the true amount CREDITED to the invoice; tendered/change are just
    -- the till-drawer record (SRS FR-PY-06).
    tendered_amount REAL,
    change_given    REAL,
    received_by   INTEGER REFERENCES users(id),
    paid_at       TEXT NOT NULL DEFAULT (datetime('now')),
    notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);

-- ----------------------------------------------------------
-- SYSTEM SETTINGS
-- A single fixed row (id = 1) holding shop-wide configurable values —
-- tax rate, shop name/footer shown on invoices, and the idle-logout
-- timeout (NFR-SC). Admin-only to change (see server/routes/settings.js).
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_settings (
    id                     INTEGER PRIMARY KEY CHECK (id = 1),
    shop_name              TEXT NOT NULL DEFAULT 'Optical Shop',
    invoice_footer_text    TEXT NOT NULL DEFAULT 'Thank you for your business.',
    tax_percent            REAL NOT NULL DEFAULT 15,
    idle_timeout_minutes   INTEGER NOT NULL DEFAULT 30,
    updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO system_settings (id) VALUES (1);
