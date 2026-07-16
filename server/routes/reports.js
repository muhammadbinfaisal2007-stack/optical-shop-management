// server/routes/reports.js
//
// WHY THIS FILE EXISTS:
// Implements the Reports & Dashboard requirements (FR-RD-02 through
// FR-RD-07) — daily sales, date-range sales, stock levels, best-sellers,
// and outstanding dues. Every report supports ?format=csv for a plain
// CSV download (FR-RD-07 — PDF export is intentionally skipped here
// since the invoice PDF already covers per-sale printing; report-level
// exports are far more useful as CSV for reopening in Excel).
//
// PERMISSIONS: Admin only (confirmed with the client — Sales Staff do
// NOT get access to these, only the Dashboard summary).

const express = require('express');
const db = require('../../db/connection');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('admin'));

// Turns an array of row objects into a CSV string. Kept dependency-free
// since these reports are simple flat tables — no need for a CSV library.
function toCsv(rows) {
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const escapeCell = (val) => {
        const str = String(val ?? '');
        // Quote any cell containing a comma, quote, or newline, and
        // double up any internal quotes — standard CSV escaping.
        return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const lines = [headers.join(',')];
    rows.forEach(row => lines.push(headers.map(h => escapeCell(row[h])).join(',')));
    return lines.join('\n');
}

function sendReport(res, rows, filename, format) {
    if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
        return res.send(toCsv(rows));
    }
    res.json({ rows });
}

// ------------------------------------------------------------------
// FR-RD-02: Daily sales report — invoices for one specific day, with
// a payment-method breakdown.
// GET /api/reports/daily-sales?date=YYYY-MM-DD&format=csv
// ------------------------------------------------------------------
router.get('/daily-sales', (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    const invoices = db.prepare(`
        SELECT i.invoice_number, c.full_name AS customer_name, i.subtotal, i.discount_amount,
               i.tax_amount, i.total_amount, i.amount_paid, i.balance_due, i.status, i.created_at
        FROM invoices i JOIN customers c ON c.id = i.customer_id
        WHERE date(i.created_at) = date(?) AND i.status NOT IN ('cancelled', 'draft')
        ORDER BY i.created_at ASC
    `).all(date);

    const totals = db.prepare(`
        SELECT COUNT(*) AS invoice_count, COALESCE(SUM(total_amount), 0) AS total_sales
        FROM invoices WHERE date(created_at) = date(?) AND status NOT IN ('cancelled', 'draft')
    `).get(date);

    const paymentBreakdown = db.prepare(`
        SELECT method, COALESCE(SUM(amount), 0) AS total
        FROM payments WHERE date(paid_at) = date(?)
        GROUP BY method
    `).all(date);

    if (req.query.format === 'csv') {
        return sendReport(res, invoices, `daily-sales-${date}`, 'csv');
    }
    res.json({ date, invoices, totals, payment_breakdown: paymentBreakdown });
});

// ------------------------------------------------------------------
// FR-RD-03: Sales over a date range.
// GET /api/reports/sales-range?start=YYYY-MM-DD&end=YYYY-MM-DD&format=csv
// ------------------------------------------------------------------
router.get('/sales-range', (req, res) => {
    const { start, end, format } = req.query;
    if (!start || !end) {
        return res.status(400).json({ error: 'start and end dates are required.' });
    }

    const invoices = db.prepare(`
        SELECT i.invoice_number, c.full_name AS customer_name, i.total_amount, i.status, i.created_at
        FROM invoices i JOIN customers c ON c.id = i.customer_id
        WHERE date(i.created_at) BETWEEN date(?) AND date(?) AND i.status NOT IN ('cancelled', 'draft')
        ORDER BY i.created_at ASC
    `).all(start, end);

    const totals = db.prepare(`
        SELECT COUNT(*) AS invoice_count, COALESCE(SUM(total_amount), 0) AS total_sales
        FROM invoices WHERE date(created_at) BETWEEN date(?) AND date(?) AND status NOT IN ('cancelled', 'draft')
    `).get(start, end);

    if (format === 'csv') {
        return sendReport(res, invoices, `sales-${start}-to-${end}`, 'csv');
    }
    res.json({ start, end, invoices, totals });
});

// ------------------------------------------------------------------
// FR-RD-04: Current stock-level report, filterable by type, with
// low-stock items flagged.
// GET /api/reports/stock-levels?type=frame&format=csv
// ------------------------------------------------------------------
router.get('/stock-levels', (req, res) => {
    const { type, format } = req.query;
    let sql = `
        SELECT item_code, item_type, name, brand, quantity_in_stock, reorder_level,
               CASE WHEN quantity_in_stock <= reorder_level THEN 'LOW' ELSE 'OK' END AS stock_status
        FROM inventory_items WHERE is_active = 1
    `;
    const params = [];
    if (type) {
        sql += ` AND item_type = ?`;
        params.push(type);
    }
    sql += ` ORDER BY item_type, name`;

    const items = db.prepare(sql).all(...params);

    if (format === 'csv') {
        return sendReport(res, items, 'stock-levels', 'csv');
    }
    res.json({ items });
});

// ------------------------------------------------------------------
// FR-RD-05: Best-selling items over a period, by quantity and value.
// GET /api/reports/best-sellers?start=&end=&format=csv
// ------------------------------------------------------------------
router.get('/best-sellers', (req, res) => {
    const { start, end, format } = req.query;
    const rangeStart = start || '2000-01-01';
    const rangeEnd = end || '2100-01-01';

    const items = db.prepare(`
        SELECT ii.item_code, ii.name, ii.item_type,
               SUM(inv_items.quantity) AS total_quantity_sold,
               SUM(inv_items.line_total) AS total_value_sold
        FROM invoice_items inv_items
        JOIN invoices i ON i.id = inv_items.invoice_id
        JOIN inventory_items ii ON ii.id = inv_items.item_id
        WHERE date(i.created_at) BETWEEN date(?) AND date(?) AND i.status NOT IN ('cancelled', 'draft')
        GROUP BY ii.id
        ORDER BY total_quantity_sold DESC
        LIMIT 50
    `).all(rangeStart, rangeEnd);

    if (format === 'csv') {
        return sendReport(res, items, 'best-sellers', 'csv');
    }
    res.json({ start: rangeStart, end: rangeEnd, items });
});

// ------------------------------------------------------------------
// FR-RD-06: Outstanding dues, grouped by customer, with phone for
// follow-up.
// GET /api/reports/dues?format=csv
// ------------------------------------------------------------------
router.get('/dues', (req, res) => {
    const rows = db.prepare(`
        SELECT c.full_name AS customer_name, c.phone AS customer_phone,
               COUNT(i.id) AS invoices_with_dues, SUM(i.balance_due) AS total_due
        FROM invoices i JOIN customers c ON c.id = i.customer_id
        WHERE i.balance_due > 0 AND i.status NOT IN ('cancelled', 'draft')
        GROUP BY c.id
        ORDER BY total_due DESC
    `).all();

    if (req.query.format === 'csv') {
        return sendReport(res, rows, 'outstanding-dues', 'csv');
    }
    res.json({ customers: rows });
});

module.exports = router;
