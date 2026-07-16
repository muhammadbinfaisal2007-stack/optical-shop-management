// server/routes/customers.js
//
// WHY THIS FILE EXISTS:
// Handles everything related to customer records: creating them, editing
// them, looking them up by name/phone, and viewing a single customer's
// full profile. Every customer gets an auto-generated customer_code
// (CUST-0001, CUST-0002...) so staff have a simple human-friendly ID to
// reference on paper or over the phone, separate from the internal
// database id.
//
// PERMISSIONS (matches the SRS Section 3 permissions table): Admin, Sales
// Staff, and Optometrist can all VIEW, CREATE, and EDIT customer profiles —
// the SRS grants all three roles "Y" for this capability. Only prescription
// data (a separate module) is restricted to Admin + Optometrist.

const express = require('express');
const db = require('../../db/connection');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

function logAction(req, action, details) {
    db.prepare(`
        INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)
    `).run(req.session.user.id, action, details || null);
}

// Generates the next customer code, e.g. if the last one was CUST-0007,
// this returns CUST-0008. Using a simple COUNT-based approach here since
// this app runs single-user-at-a-time in practice (a real high-concurrency
// system would need a more robust sequence, but that's overkill here).
function nextCustomerCode() {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM customers`).get();
    const nextNumber = row.count + 1;
    return `CUST-${String(nextNumber).padStart(4, '0')}`;
}

// ------------------------------------------------------------------
// GET /api/customers?q=searchTerm&include_inactive=true
// Lists all customers, optionally filtered by name/phone/customer_code.
// Inactive (deactivated) customers are hidden by default (FR-CM-06) —
// pass include_inactive=true to see them too (e.g. Admin managing archives).
// ------------------------------------------------------------------
router.get('/', (req, res) => {
    const q = (req.query.q || '').trim();
    const includeInactive = req.query.include_inactive === 'true';
    const activeClause = includeInactive ? '' : 'AND is_active = 1';

    let rows;
    if (q) {
        // %q% means "contains q anywhere" — a simple, effective search
        // for a shop of this size. LIKE in SQLite is case-insensitive
        // for standard ASCII text by default, which is what we want here.
        const like = `%${q}%`;
        rows = db.prepare(`
            SELECT id, customer_code, full_name, phone, email, is_active, created_at
            FROM customers
            WHERE (full_name LIKE ? OR phone LIKE ? OR customer_code LIKE ?) ${activeClause}
            ORDER BY full_name ASC
        `).all(like, like, like);
    } else {
        rows = db.prepare(`
            SELECT id, customer_code, full_name, phone, email, is_active, created_at
            FROM customers
            WHERE 1=1 ${activeClause}
            ORDER BY full_name ASC
        `).all();
    }

    res.json({ customers: rows });
});

// ------------------------------------------------------------------
// GET /api/customers/:id
// Full profile for one customer, including their prescription history.
// ------------------------------------------------------------------
router.get('/:id', (req, res) => {
    const customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id);

    if (!customer) {
        return res.status(404).json({ error: 'Customer not found.' });
    }

    const prescriptions = db.prepare(`
        SELECT p.*, u.full_name AS prescribed_by_name
        FROM prescriptions p
        LEFT JOIN users u ON u.id = p.prescribed_by
        WHERE p.customer_id = ?
        ORDER BY p.prescribed_date DESC
    `).all(req.params.id);

    res.json({ customer, prescriptions });
});

// ------------------------------------------------------------------
// POST /api/customers
// Creates a new customer. Admin + Sales only.
// ------------------------------------------------------------------
router.post('/', requireRole('admin', 'sales', 'optometrist'), (req, res) => {
    const { full_name, phone, email, address, date_of_birth, notes } = req.body;

    if (!full_name || !phone) {
        return res.status(400).json({ error: 'Full name and phone are required.' });
    }

    const customerCode = nextCustomerCode();

    const result = db.prepare(`
        INSERT INTO customers (customer_code, full_name, phone, email, address, date_of_birth, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(customerCode, full_name, phone, email || null, address || null, date_of_birth || null, notes || null);

    logAction(req, 'CREATE_CUSTOMER', `Created customer ${customerCode} (${full_name})`);

    const newCustomer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json({ customer: newCustomer });
});

// ------------------------------------------------------------------
// PUT /api/customers/:id
// Edits an existing customer. Admin + Sales only.
// ------------------------------------------------------------------
router.put('/:id', requireRole('admin', 'sales', 'optometrist'), (req, res) => {
    const existing = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id);
    if (!existing) {
        return res.status(404).json({ error: 'Customer not found.' });
    }

    const { full_name, phone, email, address, date_of_birth, notes } = req.body;

    if (!full_name || !phone) {
        return res.status(400).json({ error: 'Full name and phone are required.' });
    }

    db.prepare(`
        UPDATE customers
        SET full_name = ?, phone = ?, email = ?, address = ?, date_of_birth = ?, notes = ?,
            updated_at = datetime('now')
        WHERE id = ?
    `).run(full_name, phone, email || null, address || null, date_of_birth || null, notes || null, req.params.id);

    logAction(req, 'EDIT_CUSTOMER', `Edited customer ${existing.customer_code}`);

    const updated = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id);
    res.json({ customer: updated });
});

// ------------------------------------------------------------------
// PUT /api/customers/:id/deactivate — archives a customer (FR-CM-06).
// Their invoices and prescriptions stay intact and fully accessible by
// ID; they just disappear from normal lists/search by default.
// ------------------------------------------------------------------
router.put('/:id/deactivate', requireRole('admin', 'sales', 'optometrist'), (req, res) => {
    const existing = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id);
    if (!existing) {
        return res.status(404).json({ error: 'Customer not found.' });
    }

    db.prepare(`UPDATE customers SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
    logAction(req, 'DEACTIVATE_CUSTOMER', `Deactivated customer ${existing.customer_code}`);

    res.json({ success: true });
});

// PUT /api/customers/:id/reactivate
router.put('/:id/reactivate', requireRole('admin', 'sales', 'optometrist'), (req, res) => {
    const existing = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id);
    if (!existing) {
        return res.status(404).json({ error: 'Customer not found.' });
    }

    db.prepare(`UPDATE customers SET is_active = 1, updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
    logAction(req, 'REACTIVATE_CUSTOMER', `Reactivated customer ${existing.customer_code}`);

    res.json({ success: true });
});

// ------------------------------------------------------------------
// DELETE /api/customers/:id — Admin only, TRUE hard delete. Only allowed
// when the customer has ZERO invoices, so historical sales records can
// never be silently orphaned or lost. This is meant for cleaning up a
// genuine data-entry mistake (duplicate/test customer), not for normal
// "this customer doesn't come here anymore" — that's what deactivate is for.
// ------------------------------------------------------------------
router.delete('/:id', requireRole('admin'), (req, res) => {
    const existing = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(req.params.id);
    if (!existing) {
        return res.status(404).json({ error: 'Customer not found.' });
    }

    const invoiceCount = db.prepare(`SELECT COUNT(*) AS count FROM invoices WHERE customer_id = ?`).get(req.params.id).count;
    if (invoiceCount > 0) {
        return res.status(400).json({
            error: `This customer has ${invoiceCount} invoice(s) on record and cannot be permanently deleted. Use "Deactivate" instead to hide them without losing sales history.`
        });
    }

    db.prepare(`DELETE FROM prescriptions WHERE customer_id = ?`).run(req.params.id);
    db.prepare(`DELETE FROM customers WHERE id = ?`).run(req.params.id);

    logAction(req, 'DELETE_CUSTOMER', `Permanently deleted customer ${existing.customer_code} (no invoices existed)`);

    res.json({ success: true });
});

module.exports = router;
