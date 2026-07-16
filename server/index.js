// server/index.js
//
// This is the single file you run to start the whole application:
//     npm start
//
// It does four things:
//   1. Sets up Express (the web server framework)
//   2. Sets up sessions (so the server remembers who's logged in between
//      page requests — otherwise every request would look "anonymous")
//   3. Serves the frontend files (the HTML/CSS/JS in /public)
//   4. Wires up the API routes (currently just auth; more modules will
//      plug in here the same way as we build them)

const express = require('express');
const session = require('express-session');
const path = require('path');

const authRoutes = require('./routes/auth');
const customersRoutes = require('./routes/customers');
const prescriptionsRoutes = require('./routes/prescriptions');
const usersRoutes = require('./routes/users');
const inventoryRoutes = require('./routes/inventory');
const salesRoutes = require('./routes/sales');
const dashboardRoutes = require('./routes/dashboard');
const reportsRoutes = require('./routes/reports');
const searchRoutes = require('./routes/search');
const backupRoutes = require('./routes/backup');
const settingsRoutes = require('./routes/settings');
const { startBackupScheduler } = require('../db/backup-scheduler');
const { requireLogin } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Parses incoming JSON request bodies (e.g. the login form data) into
// req.body, so routes can read req.body.username etc. The size limit is
// raised well above the default (100kb) because restoring a backup
// sends the entire database file as base64 JSON — a shop's database
// stays small for a long time, but 50mb gives generous headroom.
app.use(express.json({ limit: '50mb' }));

// Sessions: this is what lets the server "remember" a logged-in user
// across multiple page loads. It works by giving the browser a cookie
// containing a session ID; the actual user data stays server-side.
app.use(session({
    // In a real deployment this secret should be a long random string kept
    // out of source control (e.g. in an environment variable). For a
    // single-shop local app this is a reasonable starting point.
    secret: 'optical-shop-local-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 8 * 60 * 60 * 1000 // 8 hours — roughly one working shift
    }
}));

// Auth routes are mounted BEFORE the login check below, since you obviously
// need to be able to call /api/auth/login while not yet logged in.
app.use('/api/auth', authRoutes);

// Everything below this line requires being logged in. As we build more
// modules (inventory, invoicing...) their routes get added here the same
// way, and requireLogin automatically protects all of them.
app.use('/api/customers', requireLogin, customersRoutes);
app.use('/api/users', requireLogin, usersRoutes);
app.use('/api/inventory', requireLogin, inventoryRoutes);
app.use('/api/invoices', requireLogin, salesRoutes);
app.use('/api/dashboard', requireLogin, dashboardRoutes);
app.use('/api/reports', requireLogin, reportsRoutes);
app.use('/api/search', requireLogin, searchRoutes);
app.use('/api/backup', requireLogin, backupRoutes);
app.use('/api/settings', requireLogin, settingsRoutes);

// Prescriptions routes are nested under /api (not /api/customers) because
// the route paths inside prescriptions.js already include the full
// "/customers/:customerId/prescriptions" pattern.
app.use('/api', requireLogin, prescriptionsRoutes);

// Serves everything in /public directly — index.html, login.html, css, js.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
    console.log(`Optical Shop Management System running at http://localhost:${PORT}`);
    startBackupScheduler();
});
