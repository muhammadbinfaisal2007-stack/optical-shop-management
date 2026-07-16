// server/routes/users.js
//
// WHY THIS FILE EXISTS:
// Lets the Admin create accounts for employees (Sales Staff, Optometrist),
// disable accounts when someone leaves, and reset a forgotten password.
// Everything here is Admin-only — regular staff should never be able to
// create their own accounts or change their own role, since that would
// let anyone grant themselves Admin access.

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// Every route in this file requires the admin role — applied once here
// rather than repeating requireRole('admin') on every single route below.
router.use(requireRole('admin'));

function logAction(req, action, details) {
    db.prepare(`
        INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)
    `).run(req.session.user.id, action, details || null);
}

// ------------------------------------------------------------------
// GET /api/users
// Lists all staff accounts (never returns password_hash to the frontend).
// ------------------------------------------------------------------
router.get('/', (req, res) => {
    const users = db.prepare(`
        SELECT id, full_name, username, role, is_active, created_at
        FROM users
        ORDER BY full_name ASC
    `).all();
    res.json({ users });
});

// ------------------------------------------------------------------
// POST /api/users
// Creates a new staff account.
// ------------------------------------------------------------------
router.post('/', (req, res) => {
    const { full_name, username, password, role } = req.body;

    if (!full_name || !username || !password || !role) {
        return res.status(400).json({ error: 'Full name, username, password, and role are all required.' });
    }

    if (!['admin', 'sales', 'optometrist'].includes(role)) {
        return res.status(400).json({ error: 'Role must be admin, sales, or optometrist.' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const existing = db.prepare(`SELECT id FROM users WHERE username = ?`).get(username);
    if (existing) {
        return res.status(400).json({ error: 'That username is already taken.' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);

    const result = db.prepare(`
        INSERT INTO users (full_name, username, password_hash, role, is_active)
        VALUES (?, ?, ?, ?, 1)
    `).run(full_name, username, passwordHash, role);

    logAction(req, 'CREATE_USER', `Created staff account "${username}" with role ${role}`);

    const newUser = db.prepare(`
        SELECT id, full_name, username, role, is_active, created_at FROM users WHERE id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ user: newUser });
});

// ------------------------------------------------------------------
// PUT /api/users/:id/toggle-active
// Enables or disables an account (soft delete — we never actually
// delete a user, since their name needs to stay attached to old audit
// log entries, invoices, and prescriptions they created).
// ------------------------------------------------------------------
router.put('/:id/toggle-active', (req, res) => {
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);
    if (!user) {
        return res.status(404).json({ error: 'User not found.' });
    }

    // Safety check: prevent an admin from disabling their own account and
    // locking themselves out with no way back in.
    if (user.id === req.session.user.id) {
        return res.status(400).json({ error: 'You cannot disable your own account while logged in as it.' });
    }

    const newStatus = user.is_active ? 0 : 1;
    db.prepare(`UPDATE users SET is_active = ? WHERE id = ?`).run(newStatus, req.params.id);

    logAction(req, 'TOGGLE_USER_STATUS', `${newStatus ? 'Enabled' : 'Disabled'} account "${user.username}"`);

    res.json({ success: true, is_active: newStatus });
});

// ------------------------------------------------------------------
// PUT /api/users/:id/reset-password
// ------------------------------------------------------------------
router.put('/:id/reset-password', (req, res) => {
    const { new_password } = req.body;

    if (!new_password || new_password.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);
    if (!user) {
        return res.status(404).json({ error: 'User not found.' });
    }

    const passwordHash = bcrypt.hashSync(new_password, 10);
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(passwordHash, req.params.id);

    logAction(req, 'RESET_PASSWORD', `Reset password for account "${user.username}"`);

    res.json({ success: true });
});

module.exports = router;
