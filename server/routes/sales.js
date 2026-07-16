// server/routes/sales.js
//
// WHY THIS FILE EXISTS:
// This is the heart of the whole system — turning a customer + chosen
// items into an actual sale: it deducts stock automatically, applies
// and enforces discount rules, tracks how much has been paid vs. still
// owed, and can produce a PDF invoice to hand to the customer.
//
// PERMISSIONS (SRS Section 3): Admin and Sales Staff can create
// invoices. Optometrist has no access to sales at all.
//
// DISCOUNT RULE: each Sales Staff account has its own
// discount_limit_percent (default 10%, set by Admin in Staff Accounts).
// A line can have its own discount (FR-SI-04) AND the whole invoice can
// have an additional discount on top — but for a Sales Staff member,
// the COMBINED effective discount (as a % of the true pre-discount
// subtotal) can never exceed their cap. Checking the combined effect
// (not each discount separately) closes the loophole where two
// individually-small discounts could stack past the real limit.
//
// TAX: the rate is read from system_settings (Admin-configurable, see
// server/routes/settings.js) rather than hardcoded, applied AFTER all
// discounts.
//
// SERVICE LINES (FR-SI-03): a line can be a non-stock service charge
// (e.g. "Lens Fitting") with no inventory item behind it — it never
// touches stock.
//
// DRAFTS (FR-SI-08): an invoice can be saved as a 'draft' — no stock is
// deducted and no payment is taken until it's finalized. Drafts are
// excluded from all sales reports/dashboard totals.
//
// VOID/CANCEL (FR-SI-10): Admin-only. Reverses any stock that was
// deducted, requires a reason, and the invoice record is kept
// permanently (never deleted) for audit purposes.
//
// PAYMENT METHOD: Card is not accepted — only Cash, Bank Transfer, or
// Other, enforced here and at the database level.

const express = require('express');
const PDFDocument = require('pdfkit');
const db = require('../../db/connection');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_PAYMENT_METHODS = ['cash', 'bank_transfer', 'other'];

function getTaxPercent() {
    const row = db.prepare(`SELECT tax_percent FROM system_settings WHERE id = 1`).get();
    return (row && row.tax_percent) != null ? row.tax_percent : 15;
}

function getShopSettings() {
    return db.prepare(`SELECT * FROM system_settings WHERE id = 1`).get()
        || { shop_name: 'Optical Shop', invoice_footer_text: 'Thank you for your business.' };
}

function validatePaymentMethod(method) {
    return ALLOWED_PAYMENT_METHODS.includes(method || 'cash');
}

// FR-PY-06: for cash payments, record how much cash was physically handed
// over and how much change was given back.
function computeTenderedAndChange(method, amountCredited, tenderedAmountRaw) {
    if (method !== 'cash') {
        return { tendered: null, change: null };
    }
    const tendered = tenderedAmountRaw !== undefined && tenderedAmountRaw !== null && tenderedAmountRaw !== ''
        ? Number(tenderedAmountRaw)
        : amountCredited;

    if (tendered < amountCredited) {
        return { error: `Cash tendered (Rs. ${tendered}) is less than the amount due (Rs. ${amountCredited}).` };
    }
    return { tendered, change: Math.round((tendered - amountCredited) * 100) / 100 };
}

function logAction(req, action, details) {
    db.prepare(`
        INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)
    `).run(req.session.user.id, action, details || null);
}

function nextInvoiceNumber() {
    const year = new Date().getFullYear();
    const row = db.prepare(`
        SELECT COUNT(*) AS count FROM invoices WHERE invoice_number LIKE ?
    `).get(`INV-${year}-%`);
    const nextNumber = row.count + 1;
    return `INV-${year}-${String(nextNumber).padStart(4, '0')}`;
}

function computeStatus(totalAmount, amountPaid) {
    if (amountPaid <= 0) return 'unpaid';
    if (amountPaid >= totalAmount) return 'paid';
    return 'partial';
}

// ==================================================================
// SHARED: resolve + validate line items (stock items + service lines),
// and compute the full discount/tax/total breakdown. Used by both
// invoice creation and draft-editing.
// ==================================================================
function resolveAndPriceLines(items, serviceLines) {
    const resolvedItems = [];
    for (const line of (items || [])) {
        const qty = parseInt(line.quantity, 10);
        if (!qty || qty <= 0) {
            return { error: 'Every item needs a quantity greater than 0.' };
        }
        const lineDiscountPct = Number(line.line_discount_percent) || 0;
        if (lineDiscountPct < 0 || lineDiscountPct > 100) {
            return { error: 'Line discount must be between 0 and 100.' };
        }

        const stockItem = db.prepare(`SELECT * FROM inventory_items WHERE id = ? AND is_active = 1`).get(line.item_id);
        if (!stockItem) {
            return { error: `Item ID ${line.item_id} not found.` };
        }

        resolvedItems.push({ stockItem, qty, lineDiscountPct, isService: false });
    }

    const resolvedServiceLines = [];
    for (const line of (serviceLines || [])) {
        const qty = parseInt(line.quantity, 10) || 1;
        const unitPrice = Number(line.unit_price);
        if (!line.description || !line.description.trim()) {
            return { error: 'Every service line needs a description.' };
        }
        if (Number.isNaN(unitPrice) || unitPrice < 0) {
            return { error: 'Service line price must be a valid non-negative number.' };
        }
        const lineDiscountPct = Number(line.line_discount_percent) || 0;
        if (lineDiscountPct < 0 || lineDiscountPct > 100) {
            return { error: 'Line discount must be between 0 and 100.' };
        }

        resolvedServiceLines.push({
            description: line.description.trim(), unitPrice, qty, lineDiscountPct, isService: true
        });
    }

    if (resolvedItems.length === 0 && resolvedServiceLines.length === 0) {
        return { error: 'At least one item or service line is required.' };
    }

    return { resolvedItems, resolvedServiceLines };
}

function priceBreakdown(resolvedItems, resolvedServiceLines, invoiceDiscountPct) {
    const allLines = [
        ...resolvedItems.map(l => ({ unitPrice: l.stockItem.selling_price, qty: l.qty, lineDiscountPct: l.lineDiscountPct })),
        ...resolvedServiceLines.map(l => ({ unitPrice: l.unitPrice, qty: l.qty, lineDiscountPct: l.lineDiscountPct }))
    ];

    const preDiscountSubtotal = allLines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0);
    const postLineDiscountSubtotal = allLines.reduce((sum, l) => {
        const lineGross = l.unitPrice * l.qty;
        return sum + (lineGross - (lineGross * l.lineDiscountPct / 100));
    }, 0);

    const invoiceDiscountAmount = Math.round((postLineDiscountSubtotal * invoiceDiscountPct / 100) * 100) / 100;
    const taxableAmount = Math.round((postLineDiscountSubtotal - invoiceDiscountAmount) * 100) / 100;
    const taxPercent = getTaxPercent();
    const taxAmount = Math.round((taxableAmount * taxPercent / 100) * 100) / 100;
    const totalAmount = Math.round((taxableAmount + taxAmount) * 100) / 100;

    // The single "discount_amount" stored on the invoice combines BOTH
    // line-level and invoice-level discounts into one figure — simpler
    // for reporting/PDF than showing two separate discount numbers.
    const totalDiscountAmount = Math.round((preDiscountSubtotal - taxableAmount) * 100) / 100;
    const effectiveDiscountPercent = preDiscountSubtotal > 0
        ? (totalDiscountAmount / preDiscountSubtotal) * 100
        : 0;

    return {
        preDiscountSubtotal: Math.round(preDiscountSubtotal * 100) / 100,
        totalDiscountAmount, taxAmount, totalAmount, effectiveDiscountPercent, taxPercent
    };
}

// ==================================================================
// CREATE INVOICE (or DRAFT)
// ==================================================================

// POST /api/invoices
// Body: {
//   customer_id, prescription_id (optional),
//   items: [{ item_id, quantity, line_discount_percent }],
//   service_lines: [{ description, unit_price, quantity, line_discount_percent }],
//   discount_percent (invoice-level, 0-100, optional),
//   draft: true|false (optional — saves as a held invoice, no stock/payment yet),
//   initial_payment: { amount, method, tendered_amount } (optional, ignored for drafts)
// }
router.post('/', requireRole('admin', 'sales'), (req, res) => {
    const { customer_id, prescription_id, items, service_lines, discount_percent, initial_payment, draft } = req.body;
    const isDraft = draft === true;

    if (!customer_id) {
        return res.status(400).json({ error: 'A customer is required.' });
    }
    const customer = db.prepare(`SELECT id FROM customers WHERE id = ? AND is_active = 1`).get(customer_id);
    if (!customer) {
        return res.status(404).json({ error: 'Customer not found or is inactive.' });
    }

    const invoiceDiscountPct = Number(discount_percent) || 0;
    if (invoiceDiscountPct < 0 || invoiceDiscountPct > 100) {
        return res.status(400).json({ error: 'Discount must be between 0 and 100.' });
    }

    const resolved = resolveAndPriceLines(items, service_lines);
    if (resolved.error) {
        return res.status(400).json({ error: resolved.error });
    }
    const { resolvedItems, resolvedServiceLines } = resolved;

    // Stock availability only matters for a REAL sale — a draft hasn't
    // committed to anything yet, so we skip this check for drafts (it's
    // re-checked for real when the draft is finalized, in case stock
    // changed in the meantime).
    if (!isDraft) {
        for (const { stockItem, qty } of resolvedItems) {
            if (stockItem.quantity_in_stock < qty) {
                return res.status(400).json({
                    error: `Not enough stock for "${stockItem.name}" — only ${stockItem.quantity_in_stock} left.`
                });
            }
        }
    }

    const pricing = priceBreakdown(resolvedItems, resolvedServiceLines, invoiceDiscountPct);

    // Enforce the Sales Staff discount cap on the COMBINED effective
    // discount, not each discount field separately — this is the real
    // security boundary, checked server-side regardless of what the UI sent.
    if (req.session.user.role === 'sales' && pricing.effectiveDiscountPercent > req.session.user.discount_limit_percent + 0.01) {
        return res.status(403).json({
            error: `Your combined discount (${pricing.effectiveDiscountPercent.toFixed(1)}%) exceeds your limit of ${req.session.user.discount_limit_percent}%. Ask an Admin to apply a larger discount.`
        });
    }

    let initialPaidAmount = 0, initialPaymentMethod = 'cash', initialTendered = null, initialChange = null;
    if (!isDraft) {
        initialPaidAmount = initial_payment && initial_payment.amount ? Number(initial_payment.amount) : 0;
        if (initialPaidAmount < 0 || initialPaidAmount > pricing.totalAmount) {
            return res.status(400).json({ error: 'Initial payment cannot be negative or exceed the total amount.' });
        }

        initialPaymentMethod = (initial_payment && initial_payment.method) || 'cash';
        if (initialPaidAmount > 0 && !validatePaymentMethod(initialPaymentMethod)) {
            return res.status(400).json({ error: 'Card payments are not accepted. Please use Cash, Bank Transfer, or Other.' });
        }

        if (initialPaidAmount > 0) {
            const result = computeTenderedAndChange(
                initialPaymentMethod, initialPaidAmount,
                initial_payment && initial_payment.tendered_amount
            );
            if (result.error) {
                return res.status(400).json({ error: result.error });
            }
            initialTendered = result.tendered;
            initialChange = result.change;
        }
    }

    const balanceDue = Math.round((pricing.totalAmount - initialPaidAmount) * 100) / 100;
    const status = isDraft ? 'draft' : computeStatus(pricing.totalAmount, initialPaidAmount);
    const invoiceNumber = nextInvoiceNumber();

    const invoiceResult = db.prepare(`
        INSERT INTO invoices (
            invoice_number, customer_id, prescription_id, created_by,
            subtotal, discount_amount, tax_amount, total_amount,
            amount_paid, balance_due, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        invoiceNumber, customer_id, prescription_id || null, req.session.user.id,
        pricing.preDiscountSubtotal, pricing.totalDiscountAmount, pricing.taxAmount, pricing.totalAmount,
        initialPaidAmount, balanceDue, status
    );

    const invoiceId = invoiceResult.lastInsertRowid;

    insertInvoiceLines(invoiceId, resolvedItems, resolvedServiceLines, !isDraft, req.session.user.id);

    if (!isDraft && initialPaidAmount > 0) {
        db.prepare(`
            INSERT INTO payments (invoice_id, amount, method, tendered_amount, change_given, received_by)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(invoiceId, initialPaidAmount, initialPaymentMethod, initialTendered, initialChange, req.session.user.id);
    }

    logAction(req, isDraft ? 'CREATE_DRAFT_INVOICE' : 'CREATE_INVOICE',
        `${isDraft ? 'Drafted' : 'Created'} ${invoiceNumber} for customer ID ${customer_id}, total Rs. ${pricing.totalAmount}`);

    res.status(201).json({ invoice: getInvoiceWithDetails(invoiceId) });
});

// Inserts invoice_items rows for both stock items and service lines.
// If deductStock is true, also deducts inventory and logs the stock movement.
function insertInvoiceLines(invoiceId, resolvedItems, resolvedServiceLines, deductStock, userId) {
    for (const { stockItem, qty, lineDiscountPct } of resolvedItems) {
        const gross = stockItem.selling_price * qty;
        const lineTotal = Math.round((gross - (gross * lineDiscountPct / 100)) * 100) / 100;

        db.prepare(`
            INSERT INTO invoice_items (invoice_id, item_id, is_service, description, unit_price, quantity, line_discount_percent, line_total)
            VALUES (?, ?, 0, ?, ?, ?, ?, ?)
        `).run(invoiceId, stockItem.id, stockItem.name, stockItem.selling_price, qty, lineDiscountPct, lineTotal);

        if (deductStock) {
            db.prepare(`
                UPDATE inventory_items SET quantity_in_stock = quantity_in_stock - ?, updated_at = datetime('now')
                WHERE id = ?
            `).run(qty, stockItem.id);

            db.prepare(`
                INSERT INTO stock_movements (item_id, change_qty, reason, reference_id, user_id)
                VALUES (?, ?, 'sale', ?, ?)
            `).run(stockItem.id, -qty, invoiceId, userId);
        }
    }

    for (const { description, unitPrice, qty, lineDiscountPct } of resolvedServiceLines) {
        const gross = unitPrice * qty;
        const lineTotal = Math.round((gross - (gross * lineDiscountPct / 100)) * 100) / 100;

        db.prepare(`
            INSERT INTO invoice_items (invoice_id, item_id, is_service, description, unit_price, quantity, line_discount_percent, line_total)
            VALUES (?, NULL, 1, ?, ?, ?, ?, ?)
        `).run(invoiceId, description, unitPrice, qty, lineDiscountPct, lineTotal);
        // Service lines never touch inventory — no stock movement.
    }
}

// ==================================================================
// FINALIZE A DRAFT (FR-SI-08)
// ==================================================================

// PUT /api/invoices/:id/finalize
// Body: { initial_payment: { amount, method, tendered_amount } } (optional)
router.put('/:id/finalize', requireRole('admin', 'sales'), (req, res) => {
    const invoice = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(req.params.id);
    if (!invoice) {
        return res.status(404).json({ error: 'Invoice not found.' });
    }
    if (invoice.status !== 'draft') {
        return res.status(400).json({ error: 'Only draft invoices can be finalized.' });
    }

    const lineItems = db.prepare(`SELECT * FROM invoice_items WHERE invoice_id = ?`).all(req.params.id);
    const stockLines = lineItems.filter(l => !l.is_service);

    // Re-check stock NOW — time may have passed since the draft was
    // created, and someone else may have sold the last unit.
    for (const line of stockLines) {
        const stockItem = db.prepare(`SELECT * FROM inventory_items WHERE id = ?`).get(line.item_id);
        if (!stockItem || stockItem.quantity_in_stock < line.quantity) {
            return res.status(400).json({
                error: `Not enough stock for "${line.description}" to finalize this invoice — only ${stockItem ? stockItem.quantity_in_stock : 0} left now.`
            });
        }
    }

    // Deduct stock now, at finalize time.
    for (const line of stockLines) {
        db.prepare(`
            UPDATE inventory_items SET quantity_in_stock = quantity_in_stock - ?, updated_at = datetime('now')
            WHERE id = ?
        `).run(line.quantity, line.item_id);

        db.prepare(`
            INSERT INTO stock_movements (item_id, change_qty, reason, reference_id, user_id)
            VALUES (?, ?, 'sale', ?, ?)
        `).run(line.item_id, -line.quantity, invoice.id, req.session.user.id);
    }

    const { initial_payment } = req.body;
    let paidAmount = 0, method = 'cash', tendered = null, change = null;

    if (initial_payment && initial_payment.amount) {
        paidAmount = Number(initial_payment.amount);
        if (paidAmount < 0 || paidAmount > invoice.total_amount) {
            return res.status(400).json({ error: 'Payment cannot be negative or exceed the total amount.' });
        }
        method = initial_payment.method || 'cash';
        if (!validatePaymentMethod(method)) {
            return res.status(400).json({ error: 'Card payments are not accepted. Please use Cash, Bank Transfer, or Other.' });
        }
        const result = computeTenderedAndChange(method, paidAmount, initial_payment.tendered_amount);
        if (result.error) {
            return res.status(400).json({ error: result.error });
        }
        tendered = result.tendered;
        change = result.change;
    }

    const balanceDue = Math.round((invoice.total_amount - paidAmount) * 100) / 100;
    const status = computeStatus(invoice.total_amount, paidAmount);

    db.prepare(`
        UPDATE invoices SET amount_paid = ?, balance_due = ?, status = ? WHERE id = ?
    `).run(paidAmount, balanceDue, status, invoice.id);

    if (paidAmount > 0) {
        db.prepare(`
            INSERT INTO payments (invoice_id, amount, method, tendered_amount, change_given, received_by)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(invoice.id, paidAmount, method, tendered, change, req.session.user.id);
    }

    logAction(req, 'FINALIZE_INVOICE', `Finalized draft ${invoice.invoice_number}`);

    res.json({ invoice: getInvoiceWithDetails(invoice.id) });
});

// DELETE /api/invoices/:id — discard a draft entirely (only drafts; a
// finalized invoice can never be deleted, only cancelled/voided, so the
// financial history always stays intact).
router.delete('/:id', requireRole('admin', 'sales'), (req, res) => {
    const invoice = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(req.params.id);
    if (!invoice) {
        return res.status(404).json({ error: 'Invoice not found.' });
    }
    if (invoice.status !== 'draft') {
        return res.status(400).json({ error: 'Only draft invoices can be discarded. Use cancel/void for a finalized invoice.' });
    }

    db.prepare(`DELETE FROM invoice_items WHERE invoice_id = ?`).run(req.params.id);
    db.prepare(`DELETE FROM invoices WHERE id = ?`).run(req.params.id);

    logAction(req, 'DELETE_DRAFT_INVOICE', `Discarded draft ${invoice.invoice_number}`);

    res.json({ success: true });
});

// ==================================================================
// VOID / CANCEL (FR-SI-10) — Admin only
// ==================================================================

// PUT /api/invoices/:id/cancel
// Body: { reason }
router.put('/:id/cancel', requireRole('admin'), (req, res) => {
    const invoice = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(req.params.id);
    if (!invoice) {
        return res.status(404).json({ error: 'Invoice not found.' });
    }
    if (invoice.status === 'cancelled') {
        return res.status(400).json({ error: 'This invoice is already cancelled.' });
    }

    const { reason } = req.body;
    if (!reason || !reason.trim()) {
        return res.status(400).json({ error: 'A reason is required to cancel an invoice.' });
    }

    // Reverse stock for any real (non-service) line — a draft never had
    // stock deducted in the first place, so there's nothing to reverse
    // for one of those.
    if (invoice.status !== 'draft') {
        const lineItems = db.prepare(`SELECT * FROM invoice_items WHERE invoice_id = ? AND is_service = 0`).all(req.params.id);
        for (const line of lineItems) {
            if (!line.item_id) continue;
            db.prepare(`
                UPDATE inventory_items SET quantity_in_stock = quantity_in_stock + ?, updated_at = datetime('now')
                WHERE id = ?
            `).run(line.quantity, line.item_id);

            db.prepare(`
                INSERT INTO stock_movements (item_id, change_qty, reason, reference_id, user_id)
                VALUES (?, ?, 'invoice_cancelled', ?, ?)
            `).run(line.item_id, line.quantity, invoice.id, req.session.user.id);
        }
    }

    db.prepare(`
        UPDATE invoices
        SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now'),
            cancellation_reason = ?, balance_due = 0
        WHERE id = ?
    `).run(req.session.user.id, reason.trim(), req.params.id);

    logAction(req, 'CANCEL_INVOICE', `Cancelled ${invoice.invoice_number} — reason: ${reason.trim()}`);

    res.json({ invoice: getInvoiceWithDetails(req.params.id) });
});

// ==================================================================
// LIST / VIEW INVOICES
// ==================================================================

function getInvoiceWithDetails(invoiceId) {
    const invoice = db.prepare(`
        SELECT i.*, c.full_name AS customer_name, c.phone AS customer_phone, c.customer_code,
               u.full_name AS created_by_name, cancelledUser.full_name AS cancelled_by_name
        FROM invoices i
        JOIN customers c ON c.id = i.customer_id
        LEFT JOIN users u ON u.id = i.created_by
        LEFT JOIN users cancelledUser ON cancelledUser.id = i.cancelled_by
        WHERE i.id = ?
    `).get(invoiceId);

    if (!invoice) return null;

    const lineItems = db.prepare(`SELECT * FROM invoice_items WHERE invoice_id = ?`).all(invoiceId);
    const payments = db.prepare(`
        SELECT p.*, u.full_name AS received_by_name
        FROM payments p LEFT JOIN users u ON u.id = p.received_by
        WHERE p.invoice_id = ? ORDER BY p.paid_at ASC
    `).all(invoiceId);

    return { ...invoice, items: lineItems, payments };
}

// GET /api/invoices?status=&q=
router.get('/', requireRole('admin', 'sales'), (req, res) => {
    const { status, q } = req.query;
    let sql = `
        SELECT i.id, i.invoice_number, i.total_amount, i.amount_paid, i.balance_due, i.status, i.created_at,
               c.full_name AS customer_name, c.phone AS customer_phone
        FROM invoices i JOIN customers c ON c.id = i.customer_id
        WHERE 1=1
    `;
    const params = [];

    if (status) {
        sql += ` AND i.status = ?`;
        params.push(status);
    }
    if (q) {
        sql += ` AND (i.invoice_number LIKE ? OR c.full_name LIKE ? OR c.phone LIKE ?)`;
        const like = `%${q}%`;
        params.push(like, like, like);
    }
    sql += ` ORDER BY i.created_at DESC`;

    const invoices = db.prepare(sql).all(...params);
    res.json({ invoices });
});

// GET /api/invoices/dues — quick view of everyone who still owes money.
// Drafts are excluded — they aren't real sales yet, so they can't be "due".
router.get('/dues', requireRole('admin', 'sales'), (req, res) => {
    const invoices = db.prepare(`
        SELECT i.id, i.invoice_number, i.balance_due, i.status, i.created_at,
               c.full_name AS customer_name, c.phone AS customer_phone
        FROM invoices i JOIN customers c ON c.id = i.customer_id
        WHERE i.balance_due > 0 AND i.status NOT IN ('cancelled', 'draft')
        ORDER BY i.created_at ASC
    `).all();
    res.json({ invoices });
});

// GET /api/invoices/:id
router.get('/:id', requireRole('admin', 'sales'), (req, res) => {
    const invoice = getInvoiceWithDetails(req.params.id);
    if (!invoice) {
        return res.status(404).json({ error: 'Invoice not found.' });
    }
    res.json({ invoice });
});

// ==================================================================
// PAYMENTS
// ==================================================================

// POST /api/invoices/:id/payments — record an additional payment
router.post('/:id/payments', requireRole('admin', 'sales'), (req, res) => {
    const invoice = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(req.params.id);
    if (!invoice) {
        return res.status(404).json({ error: 'Invoice not found.' });
    }
    if (invoice.status === 'cancelled') {
        return res.status(400).json({ error: 'Cannot add a payment to a cancelled invoice.' });
    }
    if (invoice.status === 'draft') {
        return res.status(400).json({ error: 'This invoice is still a draft. Finalize it first before recording a payment.' });
    }

    const { amount, method, notes, tendered_amount } = req.body;
    const paymentAmount = Number(amount);

    if (!paymentAmount || paymentAmount <= 0) {
        return res.status(400).json({ error: 'Payment amount must be greater than 0.' });
    }
    if (paymentAmount > invoice.balance_due) {
        return res.status(400).json({
            error: `That's more than what's owed. Remaining balance is Rs. ${invoice.balance_due}.`
        });
    }
    if (!validatePaymentMethod(method)) {
        return res.status(400).json({ error: 'Card payments are not accepted. Please use Cash, Bank Transfer, or Other.' });
    }

    const tenderResult = computeTenderedAndChange(method || 'cash', paymentAmount, tendered_amount);
    if (tenderResult.error) {
        return res.status(400).json({ error: tenderResult.error });
    }

    db.prepare(`
        INSERT INTO payments (invoice_id, amount, method, tendered_amount, change_given, received_by, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.id, paymentAmount, method || 'cash', tenderResult.tendered, tenderResult.change, req.session.user.id, notes || null);

    const newAmountPaid = Math.round((invoice.amount_paid + paymentAmount) * 100) / 100;
    const newBalanceDue = Math.round((invoice.total_amount - newAmountPaid) * 100) / 100;
    const newStatus = computeStatus(invoice.total_amount, newAmountPaid);

    db.prepare(`
        UPDATE invoices SET amount_paid = ?, balance_due = ?, status = ? WHERE id = ?
    `).run(newAmountPaid, newBalanceDue, newStatus, req.params.id);

    logAction(req, 'RECORD_PAYMENT', `Recorded Rs. ${paymentAmount} payment on ${invoice.invoice_number}`);

    res.status(201).json({ invoice: getInvoiceWithDetails(req.params.id) });
});

// ==================================================================
// PDF INVOICE
// ==================================================================

// GET /api/invoices/:id/pdf
router.get('/:id/pdf', requireRole('admin', 'sales'), (req, res) => {
    const invoice = getInvoiceWithDetails(req.params.id);
    if (!invoice) {
        return res.status(404).json({ error: 'Invoice not found.' });
    }

    const settings = getShopSettings();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${invoice.invoice_number}.pdf"`);

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    doc.fontSize(20).text(settings.shop_name, { align: 'left' });
    doc.fontSize(10).fillColor('#555').text('Invoice', { align: 'left' });
    if (invoice.status === 'cancelled') {
        doc.fillColor('#dc2626').fontSize(14).text('CANCELLED', { align: 'left' });
    }
    doc.moveDown();

    doc.fillColor('#000').fontSize(12);
    doc.text(`Invoice #: ${invoice.invoice_number}`);
    doc.text(`Date: ${invoice.created_at}`);
    doc.text(`Customer: ${invoice.customer_name} (${invoice.customer_code})`);
    doc.text(`Phone: ${invoice.customer_phone}`);
    doc.moveDown();

    const tableTop = doc.y;
    doc.fontSize(10).fillColor('#333');
    doc.text('Item', 50, tableTop, { width: 200 });
    doc.text('Qty', 260, tableTop, { width: 40, align: 'right' });
    doc.text('Unit Price', 310, tableTop, { width: 70, align: 'right' });
    doc.text('Disc %', 385, tableTop, { width: 45, align: 'right' });
    doc.text('Line Total', 435, tableTop, { width: 75, align: 'right' });
    doc.moveTo(50, tableTop + 15).lineTo(510, tableTop + 15).stroke();

    let y = tableTop + 22;
    invoice.items.forEach(item => {
        doc.fillColor('#000').text(item.description + (item.is_service ? ' (service)' : ''), 50, y, { width: 200 });
        doc.text(String(item.quantity), 260, y, { width: 40, align: 'right' });
        doc.text(`Rs. ${item.unit_price.toFixed(2)}`, 310, y, { width: 70, align: 'right' });
        doc.text(`${item.line_discount_percent || 0}%`, 385, y, { width: 45, align: 'right' });
        doc.text(`Rs. ${item.line_total.toFixed(2)}`, 435, y, { width: 75, align: 'right' });
        y += 20;
    });

    doc.moveTo(50, y + 5).lineTo(510, y + 5).stroke();
    y += 15;

    doc.text(`Subtotal: Rs. ${invoice.subtotal.toFixed(2)}`, 340, y, { width: 170, align: 'right' });
    y += 16;
    doc.text(`Total Discount: Rs. ${invoice.discount_amount.toFixed(2)}`, 340, y, { width: 170, align: 'right' });
    y += 16;
    doc.text(`Tax (${getTaxPercent()}%): Rs. ${invoice.tax_amount.toFixed(2)}`, 340, y, { width: 170, align: 'right' });
    y += 16;
    doc.fontSize(12).text(`Total: Rs. ${invoice.total_amount.toFixed(2)}`, 340, y, { width: 170, align: 'right' });
    y += 18;
    doc.fontSize(10).text(`Paid: Rs. ${invoice.amount_paid.toFixed(2)}`, 340, y, { width: 170, align: 'right' });
    y += 16;
    doc.fillColor(invoice.balance_due > 0 ? '#dc2626' : '#16a34a');
    doc.text(`Balance Due: Rs. ${invoice.balance_due.toFixed(2)}`, 340, y, { width: 170, align: 'right' });

    if (invoice.status === 'cancelled') {
        y += 24;
        doc.fillColor('#dc2626').fontSize(10);
        doc.text(`Cancelled on ${invoice.cancelled_at} by ${invoice.cancelled_by_name || '—'}`, 50, y);
        doc.text(`Reason: ${invoice.cancellation_reason || '—'}`, 50, y + 14);
    }

    doc.fillColor('#555').fontSize(9);
    doc.text(settings.invoice_footer_text, 50, y + 40);

    doc.end();
});

module.exports = router;
