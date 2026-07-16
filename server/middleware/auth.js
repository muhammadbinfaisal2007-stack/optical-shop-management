// server/middleware/auth.js
//
// WHY THIS FILE EXISTS:
// The SRS requires three roles (Admin, Sales Staff, Optometrist) with
// different permissions. Rather than checking "is this user allowed to do
// this?" inside every single route by hand, we write that check ONCE here
// as reusable "middleware" — a function Express runs before the real route
// handler. If the check fails, we stop the request right there and the
// route handler never even runs.
//
// requireLogin  -> blocks anyone who isn't logged in at all, AND enforces
//                  the idle-logout timeout (NFR-SC)
// requireRole   -> same, plus blocks logged-in users whose role isn't in
//                  the allowed list

const db = require('../../db/connection');

// Reads the current idle timeout setting fresh each time rather than
// caching it, since an Admin can change it from the Settings page and
// that change should take effect immediately without restarting the
// server. This is a single indexed row lookup — negligible cost even on
// low-spec hardware.
function getIdleTimeoutMinutes() {
    const row = db.prepare(`SELECT idle_timeout_minutes FROM system_settings WHERE id = 1`).get();
    return (row && row.idle_timeout_minutes) || 30;
}

// Returns true if the session should be force-logged-out for inactivity.
// Also updates lastActivity on every call that returns false, so normal
// use keeps extending the session.
function isIdleTimedOut(req) {
    const now = Date.now();
    const lastActivity = req.session.lastActivity;

    if (lastActivity) {
        const idleMinutes = (now - lastActivity) / 60000;
        if (idleMinutes > getIdleTimeoutMinutes()) {
            return true;
        }
    }

    req.session.lastActivity = now;
    return false;
}

function requireLogin(req, res, next) {
    // express-session attaches a "session" object to every request. When
    // someone logs in successfully (see routes/auth.js), we store their
    // user info in req.session.user. If it's not there, they're not logged in.
    if (!req.session || !req.session.user) {
        // For API requests we return JSON; for page requests we redirect
        // to the login page. We detect which kind of request this is by
        // checking the URL prefix.
        if (req.originalUrl.startsWith('/api/')) {
            return res.status(401).json({ error: 'Not logged in.' });
        }
        return res.redirect('/login.html');
    }

    if (isIdleTimedOut(req)) {
        return req.session.destroy(() => {
            if (req.originalUrl.startsWith('/api/')) {
                return res.status(401).json({ error: 'Session expired due to inactivity. Please log in again.' });
            }
            res.redirect('/login.html');
        });
    }

    next(); // checks passed — let the request continue to the real route
}

// Usage: requireRole('admin') or requireRole('admin', 'sales')
function requireRole(...allowedRoles) {
    return function (req, res, next) {
        if (!req.session || !req.session.user) {
            if (req.originalUrl.startsWith('/api/')) {
                return res.status(401).json({ error: 'Not logged in.' });
            }
            return res.redirect('/login.html');
        }

        if (isIdleTimedOut(req)) {
            return req.session.destroy(() => {
                if (req.originalUrl.startsWith('/api/')) {
                    return res.status(401).json({ error: 'Session expired due to inactivity. Please log in again.' });
                }
                res.redirect('/login.html');
            });
        }

        if (!allowedRoles.includes(req.session.user.role)) {
            return res.status(403).json({
                error: `Access denied. This action requires one of these roles: ${allowedRoles.join(', ')}.`
            });
        }

        next();
    };
}

module.exports = { requireLogin, requireRole };
