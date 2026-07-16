// server/routes/auth.js
//
// WHY THIS FILE EXISTS:
// Handles the actual login/logout process: checking username + password
// against the database, starting a session if correct, and clearing it on
// logout. This is the front door to the whole app.

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../../db/connection');

const router = express.Router();

function logAction(userId, action, details) {
    db.prepare(`
        INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)
    `).run(userId, action, details || null);
}

// POST /api/auth/login
// Body: { username, password }
router.post('/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
    }

    const user = db.prepare(`
        SELECT id, full_name, username, password_hash, role, is_active, discount_limit_percent
        FROM users WHERE username = ?
    `).get(username);

    // Deliberately vague error message ("invalid username or password"
    // rather than "no such user") — this avoids telling an attacker
    // whether the username exists at all, which is a basic security practice.
    if (!user || !user.is_active) {
        return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // bcrypt.compareSync re-hashes the submitted password with the same
    // salt that's embedded in the stored hash, and checks if the result
    // matches. This is how you verify a password without ever storing or
    // comparing the plain-text version.
    const passwordMatches = bcrypt.compareSync(password, user.password_hash);

    if (!passwordMatches) {
        return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // Store only what we need in the session — never the password hash.
    req.session.user = {
        id: user.id,
        full_name: user.full_name,
        username: user.username,
        role: user.role,
        discount_limit_percent: user.discount_limit_percent
    };

    logAction(user.id, 'LOGIN', `${user.username} logged in`);

    res.json({ success: true, user: req.session.user });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
    if (req.session.user) {
        logAction(req.session.user.id, 'LOGOUT', `${req.session.user.username} logged out`);
    }
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

// GET /api/auth/me
// Lets the frontend ask "who is currently logged in?" — used on page load
// to decide what to show/hide based on role.
router.get('/me', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Not logged in.' });
    }
    res.json({ user: req.session.user });
});

module.exports = router;
