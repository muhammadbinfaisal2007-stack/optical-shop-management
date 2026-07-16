// server/routes/search.js
//
// WHY THIS FILE EXISTS:
// Implements FR-SR — a single global search box that looks across
// customers, invoices, and inventory at once, tolerant of partial input
// (SQL LIKE '%term%'), so staff can find a record without knowing which
// page it lives on. Each category is only searched if the logged-in
// role already has view access to that data — e.g. an Optometrist's
// search only returns customers, never invoices or inventory, matching
// their existing permissions elsewhere in the app.

const express = require('express');
const db = require('../../db/connection');

const router = express.Router();

// GET /api/search?q=term
router.get('/', (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) {
        return res.json({ customers: [], invoices: [], inventory: [] });
    }

    const like = `%${q}%`;
    const role = req.session.user.role;
    const results = { customers: [], invoices: [], inventory: [] };

    // Customers: visible to all three roles, matching their existing
    // permission to view customer profiles.
    results.customers = db.prepare(`
        SELECT id, customer_code, full_name, phone
        FROM customers
        WHERE full_name LIKE ? OR phone LIKE ? OR customer_code LIKE ?
        LIMIT 10
    `).all(like, like, like);

    // Invoices and inventory: Admin + Sales only, matching the
    // permissions already enforced on those modules directly.
    if (role === 'admin' || role === 'sales') {
        results.invoices = db.prepare(`
            SELECT i.id, i.invoice_number, i.total_amount, i.status, c.full_name AS customer_name
            FROM invoices i JOIN customers c ON c.id = i.customer_id
            WHERE i.invoice_number LIKE ? OR c.full_name LIKE ? OR c.phone LIKE ?
            LIMIT 10
        `).all(like, like, like);

        results.inventory = db.prepare(`
            SELECT id, item_code, name, brand, quantity_in_stock
            FROM inventory_items
            WHERE is_active = 1 AND (name LIKE ? OR item_code LIKE ? OR brand LIKE ?)
            LIMIT 10
        `).all(like, like, like);
    }

    res.json(results);
});

module.exports = router;
