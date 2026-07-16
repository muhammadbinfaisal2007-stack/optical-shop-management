// server/routes/settings.js
//
// WHY THIS FILE EXISTS:
// A single admin-configurable settings row: the shop name and footer
// text shown on invoices, the tax rate (FR-SI-05 — configurable, not
// hardcoded), and the idle-logout timeout (NFR-SC). Only one row ever
// exists (id = 1) — there's nothing to list or create, just read/update.

const express = require('express');
const db = require('../../db/connection');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('admin'));

router.get('/', (req, res) => {
    const settings = db.prepare(`SELECT * FROM system_settings WHERE id = 1`).get();
    res.json({ settings });
});

router.put('/', (req, res) => {
    const { shop_name, invoice_footer_text, tax_percent, idle_timeout_minutes } = req.body;

    const taxPct = Number(tax_percent);
    if (Number.isNaN(taxPct) || taxPct < 0 || taxPct > 100) {
        return res.status(400).json({ error: 'Tax percent must be a number between 0 and 100.' });
    }

    const idleMinutes = parseInt(idle_timeout_minutes, 10);
    if (!idleMinutes || idleMinutes < 1 || idleMinutes > 480) {
        return res.status(400).json({ error: 'Idle timeout must be between 1 and 480 minutes.' });
    }

    if (!shop_name || !shop_name.trim()) {
        return res.status(400).json({ error: 'Shop name is required.' });
    }

    db.prepare(`
        UPDATE system_settings
        SET shop_name = ?, invoice_footer_text = ?, tax_percent = ?, idle_timeout_minutes = ?,
            updated_at = datetime('now')
        WHERE id = 1
    `).run(shop_name.trim(), invoice_footer_text || '', taxPct, idleMinutes);

    db.prepare(`
        INSERT INTO audit_log (user_id, action, details) VALUES (?, 'UPDATE_SETTINGS', ?)
    `).run(req.session.user.id, `Updated system settings (tax: ${taxPct}%, idle timeout: ${idleMinutes}min)`);

    const updated = db.prepare(`SELECT * FROM system_settings WHERE id = 1`).get();
    res.json({ settings: updated });
});

module.exports = router;
