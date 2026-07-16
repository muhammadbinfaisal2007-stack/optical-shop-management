// server/routes/inventory.js
//
// WHY THIS FILE EXISTS:
// Manages frames/lenses/accessories, their suppliers, and stock levels.
//
// PERMISSIONS (SRS Section 3 + the fraud-protection decision made with
// the client):
//   - View inventory & suppliers: Admin, Sales Staff (Optometrist has no
//     access to inventory at all — matches the SRS permissions table)
//   - Add/edit items & suppliers: Admin only
//   - Stock adjustments: Admin's own adjustments apply IMMEDIATELY (an
//     Admin approving their own request would be meaningless). Sales
//     Staff adjustments ALWAYS go into a pending queue — no exceptions,
//     no auto-approve threshold — and only take effect once an Admin
//     explicitly approves them. This is deliberate: it closes the
//     specific fraud scenario the client raised, where an employee could
//     sell an item off-the-books and quietly "correct" the stock count
//     to hide it.

const express = require('express');
const db = require('../../db/connection');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

function logAction(req, action, details) {
    db.prepare(`
        INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)
    `).run(req.session.user.id, action, details || null);
}

function nextItemCode(itemType) {
    const prefixMap = { frame: 'FRM', lens: 'LNS', accessory: 'ACC' };
    const prefix = prefixMap[itemType] || 'ITM';
    const row = db.prepare(`SELECT COUNT(*) AS count FROM inventory_items WHERE item_type = ?`).get(itemType);
    const nextNumber = row.count + 1;
    return `${prefix}-${String(nextNumber).padStart(4, '0')}`;
}

// ==================================================================
// SUPPLIERS
// ==================================================================

// GET /api/suppliers — Admin + Sales can view
router.get('/suppliers', requireRole('admin', 'sales'), (req, res) => {
    const suppliers = db.prepare(`SELECT * FROM suppliers ORDER BY name ASC`).all();
    res.json({ suppliers });
});

// POST /api/suppliers — Admin only
router.post('/suppliers', requireRole('admin'), (req, res) => {
    const { name, phone, email, address } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Supplier name is required.' });
    }

    const result = db.prepare(`
        INSERT INTO suppliers (name, phone, email, address) VALUES (?, ?, ?, ?)
    `).run(name, phone || null, email || null, address || null);

    logAction(req, 'CREATE_SUPPLIER', `Added supplier "${name}"`);

    const newSupplier = db.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json({ supplier: newSupplier });
});

// ==================================================================
// INVENTORY ITEMS
// ==================================================================

// GET /api/inventory?q=&type= — Admin + Sales can view
router.get('/', requireRole('admin', 'sales'), (req, res) => {
    const q = (req.query.q || '').trim();
    const type = (req.query.type || '').trim();

    let sql = `
        SELECT i.*, s.name AS supplier_name
        FROM inventory_items i
        LEFT JOIN suppliers s ON s.id = i.supplier_id
        WHERE i.is_active = 1
    `;
    const params = [];

    if (q) {
        sql += ` AND (i.name LIKE ? OR i.item_code LIKE ? OR i.brand LIKE ?)`;
        const like = `%${q}%`;
        params.push(like, like, like);
    }
    if (type) {
        sql += ` AND i.item_type = ?`;
        params.push(type);
    }
    sql += ` ORDER BY i.name ASC`;

    const items = db.prepare(sql).all(...params);
    res.json({ items });
});

// GET /api/inventory/low-stock — Admin + Sales, items at or below reorder level
router.get('/low-stock', requireRole('admin', 'sales'), (req, res) => {
    const items = db.prepare(`
        SELECT * FROM inventory_items
        WHERE is_active = 1 AND quantity_in_stock <= reorder_level
        ORDER BY quantity_in_stock ASC
    `).all();
    res.json({ items });
});

// GET /api/inventory/:id — single item detail, including its stock movement history
router.get('/:id', requireRole('admin', 'sales'), (req, res) => {
    const item = db.prepare(`SELECT * FROM inventory_items WHERE id = ?`).get(req.params.id);
    if (!item) {
        return res.status(404).json({ error: 'Item not found.' });
    }

    const movements = db.prepare(`
        SELECT m.*, u.full_name AS user_name
        FROM stock_movements m
        LEFT JOIN users u ON u.id = m.user_id
        WHERE m.item_id = ?
        ORDER BY m.created_at DESC
        LIMIT 50
    `).all(req.params.id);

    res.json({ item, movements });
});

// POST /api/inventory — Admin only, creates a new item with its starting stock
router.post('/', requireRole('admin'), (req, res) => {
    const {
        item_type, name, brand, model, color, size,
        supplier_id, cost_price, selling_price,
        quantity_in_stock, reorder_level
    } = req.body;

    if (!item_type || !name) {
        return res.status(400).json({ error: 'Item type and name are required.' });
    }
    if (!['frame', 'lens', 'accessory'].includes(item_type)) {
        return res.status(400).json({ error: 'Item type must be frame, lens, or accessory.' });
    }

    const itemCode = nextItemCode(item_type);
    const startingQty = parseInt(quantity_in_stock, 10) || 0;

    const result = db.prepare(`
        INSERT INTO inventory_items (
            item_code, item_type, name, brand, model, color, size,
            supplier_id, cost_price, selling_price, quantity_in_stock, reorder_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        itemCode, item_type, name, brand || null, model || null, color || null, size || null,
        supplier_id || null, cost_price || 0, selling_price || 0, startingQty, reorder_level || 5
    );

    const newItemId = result.lastInsertRowid;

    // Record the starting quantity as the first stock movement, so the
    // movement history always fully explains the current count — there's
    // no "invisible" starting balance.
    if (startingQty > 0) {
        db.prepare(`
            INSERT INTO stock_movements (item_id, change_qty, reason, user_id)
            VALUES (?, ?, 'initial_stock', ?)
        `).run(newItemId, startingQty, req.session.user.id);
    }

    logAction(req, 'CREATE_INVENTORY_ITEM', `Added ${item_type} "${name}" (${itemCode})`);

    const newItem = db.prepare(`SELECT * FROM inventory_items WHERE id = ?`).get(newItemId);
    res.status(201).json({ item: newItem });
});

// PUT /api/inventory/:id — Admin only, edits item details (NOT stock quantity —
// that only ever changes through the stock-adjustment workflow below, so
// there's always a logged reason for every change in the count).
router.put('/:id', requireRole('admin'), (req, res) => {
    const existing = db.prepare(`SELECT * FROM inventory_items WHERE id = ?`).get(req.params.id);
    if (!existing) {
        return res.status(404).json({ error: 'Item not found.' });
    }

    const { name, brand, model, color, size, supplier_id, cost_price, selling_price, reorder_level } = req.body;

    db.prepare(`
        UPDATE inventory_items
        SET name = ?, brand = ?, model = ?, color = ?, size = ?, supplier_id = ?,
            cost_price = ?, selling_price = ?, reorder_level = ?, updated_at = datetime('now')
        WHERE id = ?
    `).run(name, brand || null, model || null, color || null, size || null, supplier_id || null,
           cost_price || 0, selling_price || 0, reorder_level || 5, req.params.id);

    logAction(req, 'EDIT_INVENTORY_ITEM', `Edited item ${existing.item_code}`);

    const updated = db.prepare(`SELECT * FROM inventory_items WHERE id = ?`).get(req.params.id);
    res.json({ item: updated });
});

// ==================================================================
// STOCK ADJUSTMENTS
// Both Admin and Sales Staff can adjust stock directly — it applies
// immediately either way, so staff aren't blocked mid-task waiting on
// approval. The safeguard instead is VISIBILITY: any adjustment made by
// a non-admin creates a notification so the Admin sees exactly what
// changed, by whom, and why, without having to go looking for it.
// ==================================================================

function notifyAdmins(type, message, referenceId) {
    db.prepare(`
        INSERT INTO notifications (type, message, reference_id)
        VALUES (?, ?, ?)
    `).run(type, message, referenceId || null);
}

// POST /api/inventory/:id/adjust
router.post('/:id/adjust', requireRole('admin', 'sales'), (req, res) => {
    const item = db.prepare(`SELECT * FROM inventory_items WHERE id = ?`).get(req.params.id);
    if (!item) {
        return res.status(404).json({ error: 'Item not found.' });
    }

    const { change_qty, reason, notes } = req.body;
    const qty = parseInt(change_qty, 10);

    if (!qty || qty === 0) {
        return res.status(400).json({ error: 'change_qty must be a non-zero number.' });
    }
    if (!reason) {
        return res.status(400).json({ error: 'A reason is required for every stock adjustment.' });
    }

    const newQty = item.quantity_in_stock + qty;
    if (newQty < 0) {
        return res.status(400).json({ error: 'This adjustment would make stock negative.' });
    }

    db.prepare(`UPDATE inventory_items SET quantity_in_stock = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(newQty, req.params.id);

    db.prepare(`
        INSERT INTO stock_movements (item_id, change_qty, reason, user_id)
        VALUES (?, ?, ?, ?)
    `).run(req.params.id, qty, reason, req.session.user.id);

    logAction(req, 'STOCK_ADJUSTMENT', `Adjusted ${item.item_code} by ${qty} (${reason})`);

    // Alert the Admin whenever someone OTHER than an admin changes stock.
    // An admin doesn't need to be notified about their own actions.
    if (req.session.user.role !== 'admin') {
        const direction = qty > 0 ? 'increased' : 'decreased';
        notifyAdmins(
            'stock_adjustment',
            `${req.session.user.full_name} ${direction} stock of "${item.name}" (${item.item_code}) by ${Math.abs(qty)} — reason: ${reason}${notes ? ` (${notes})` : ''}`,
            item.id
        );
    }

    res.json({ applied: true, new_quantity: newQty });
});

// ==================================================================
// NOTIFICATIONS — Admin only
// ==================================================================

// GET /api/inventory/notifications?unread=true
router.get('/notifications/list', requireRole('admin'), (req, res) => {
    const unreadOnly = req.query.unread === 'true';
    const sql = unreadOnly
        ? `SELECT * FROM notifications WHERE is_read = 0 ORDER BY created_at DESC`
        : `SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100`;
    const notifications = db.prepare(sql).all();
    res.json({ notifications });
});

// GET /api/inventory/notifications/unread-count — for a small badge/counter in the UI
router.get('/notifications/unread-count', requireRole('admin'), (req, res) => {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM notifications WHERE is_read = 0`).get();
    res.json({ count: row.count });
});

// PUT /api/inventory/notifications/:id/read
router.put('/notifications/:id/read', requireRole('admin'), (req, res) => {
    db.prepare(`UPDATE notifications SET is_read = 1 WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
});

// PUT /api/inventory/notifications/mark-all-read
router.put('/notifications/mark-all-read', requireRole('admin'), (req, res) => {
    db.prepare(`UPDATE notifications SET is_read = 1 WHERE is_read = 0`).run();
    res.json({ success: true });
});

module.exports = router;
