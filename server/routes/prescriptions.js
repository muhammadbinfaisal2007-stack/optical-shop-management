// server/routes/prescriptions.js
//
// WHY THIS FILE EXISTS:
// Handles prescription records. A customer can have MANY prescriptions
// over time (eyes change, they come back a year later) — we never
// overwrite an old prescription, we just add a new one and keep the full
// history. This matters for an optical shop: if there's ever a dispute
// about what lenses were ordered against, the old record is still there.
//
// PERMISSIONS: Only Admin and Optometrist can create/edit prescriptions —
// this is clinical data, not something Sales Staff should be entering or
// changing. Everyone can still VIEW them via the customer profile route
// (GET /api/customers/:id already includes prescriptions).

const express = require('express');
const db = require('../../db/connection');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

function logAction(req, action, details) {
    db.prepare(`
        INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)
    `).run(req.session.user.id, action, details || null);
}

// Sanity-check ranges for prescription values. These aren't arbitrary —
// they reflect realistic optometry ranges, and catch obvious data-entry
// mistakes (e.g. typing 250 instead of 2.50 for sphere).
function validatePrescriptionValues(body) {
    const errors = [];

    const checkRange = (label, value, min, max) => {
        if (value === undefined || value === null || value === '') return; // optional field
        const num = Number(value);
        if (Number.isNaN(num)) {
            errors.push(`${label} must be a number.`);
        } else if (num < min || num > max) {
            errors.push(`${label} must be between ${min} and ${max}.`);
        }
    };

    checkRange('OD Sphere', body.od_sphere, -20, 20);
    checkRange('OD Cylinder', body.od_cylinder, -10, 10);
    checkRange('OD Axis', body.od_axis, 0, 180);
    checkRange('OS Sphere', body.os_sphere, -20, 20);
    checkRange('OS Cylinder', body.os_cylinder, -10, 10);
    checkRange('OS Axis', body.os_axis, 0, 180);
    checkRange('Pupillary Distance', body.pupillary_distance, 40, 80);

    return errors;
}

// ------------------------------------------------------------------
// POST /api/customers/:customerId/prescriptions
// Adds a new prescription record for a customer.
// ------------------------------------------------------------------
router.post('/customers/:customerId/prescriptions', requireRole('admin', 'optometrist'), (req, res) => {
    const customer = db.prepare(`SELECT id FROM customers WHERE id = ?`).get(req.params.customerId);
    if (!customer) {
        return res.status(404).json({ error: 'Customer not found.' });
    }

    const errors = validatePrescriptionValues(req.body);
    if (errors.length > 0) {
        return res.status(400).json({ error: errors.join(' ') });
    }

    const {
        od_sphere, od_cylinder, od_axis, od_add,
        os_sphere, os_cylinder, os_axis, os_add,
        pupillary_distance, notes, prescribed_date
    } = req.body;

    const result = db.prepare(`
        INSERT INTO prescriptions (
            customer_id, prescribed_by, prescribed_date,
            od_sphere, od_cylinder, od_axis, od_add,
            os_sphere, os_cylinder, os_axis, os_add,
            pupillary_distance, notes
        ) VALUES (?, ?, COALESCE(?, date('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        req.params.customerId, req.session.user.id, prescribed_date || null,
        od_sphere || null, od_cylinder || null, od_axis || null, od_add || null,
        os_sphere || null, os_cylinder || null, os_axis || null, os_add || null,
        pupillary_distance || null, notes || null
    );

    logAction(req, 'CREATE_PRESCRIPTION', `Added prescription for customer ID ${req.params.customerId}`);

    const newPrescription = db.prepare(`SELECT * FROM prescriptions WHERE id = ?`).get(result.lastInsertRowid);
    res.status(201).json({ prescription: newPrescription });
});

module.exports = router;
