// server/routes/dashboard.js
//
// WHY THIS FILE EXISTS:
// Implements FR-RD-01 — a single summary endpoint that powers the home
// screen: today's sales total/count, cash vs. other payment split, a
// low-stock alert count, and total outstanding dues. Every number here
// is a fast, indexed query since this loads every time anyone logs in
// (SRS requires reports/dashboard to load quickly on low-spec hardware).
//
// Available to Admin and Sales Staff only — the SRS permissions table
// (Section 3) gives Optometrist no access to reports/dashboard at all
// ("---"). Optometrist gets a simpler generic landing page instead.

const express = require('express');
const db = require('../../db/connection');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/summary', requireRole('admin', 'sales'), (req, res) => {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Today's sales: count + total, excluding cancelled invoices.
    const todaySales = db.prepare(`
        SELECT COUNT(*) AS invoice_count, COALESCE(SUM(total_amount), 0) AS total_sales
        FROM invoices
        WHERE date(created_at) = date(?) AND status NOT IN ('cancelled', 'draft')
    `).get(today);

    // Payment method split for TODAY's payments (not invoice date — a
    // payment made today against an older invoice still counts as
    // today's cash movement, which is what a till reconciliation cares about).
    const paymentSplit = db.prepare(`
        SELECT method, COALESCE(SUM(amount), 0) AS total
        FROM payments
        WHERE date(paid_at) = date(?)
        GROUP BY method
    `).all(today);

    const lowStock = db.prepare(`
        SELECT COUNT(*) AS count FROM inventory_items
        WHERE is_active = 1 AND quantity_in_stock <= reorder_level
    `).get();

    const outstandingDues = db.prepare(`
        SELECT COALESCE(SUM(balance_due), 0) AS total, COUNT(*) AS invoice_count
        FROM invoices WHERE balance_due > 0 AND status NOT IN ('cancelled', 'draft')
    `).get();

    res.json({
        today_sales: {
            count: todaySales.invoice_count,
            total: todaySales.total_sales
        },
        payment_split_today: paymentSplit,
        low_stock_count: lowStock.count,
        outstanding_dues: {
            total: outstandingDues.total,
            invoice_count: outstandingDues.invoice_count
        }
    });
});

module.exports = router;
