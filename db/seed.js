// db/seed.js
//
// WHY THIS FILE EXISTS:
// The very first time the app runs, there are no users in the database yet —
// which is a chicken-and-egg problem, since you need to log in to do
// anything, but there's no account to log in with. This script creates one
// admin account so you have a way in. Run it once with:
//
//     npm run seed
//
// You can change the username/password below before running it, or just
// change the password immediately after your first login (a "change
// password" feature is part of the auth module).

const bcrypt = require('bcryptjs');
const db = require('./connection');

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin123';  // CHANGE THIS after first login
const ADMIN_FULL_NAME = 'Shop Administrator';

function seed() {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN_USERNAME);

    if (existing) {
        console.log(`User "${ADMIN_USERNAME}" already exists — skipping seed.`);
        return;
    }

    // bcrypt.hashSync does two things: it salts the password (adds random
    // data so two identical passwords don't produce the same hash) and
    // hashes it (turns it into a scrambled string that can't be reversed
    // back into the original password). We NEVER store the plain password.
    const passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);

    db.prepare(`
        INSERT INTO users (full_name, username, password_hash, role, is_active)
        VALUES (?, ?, ?, 'admin', 1)
    `).run(ADMIN_FULL_NAME, ADMIN_USERNAME, passwordHash);

    console.log('Admin user created successfully.');
    console.log(`  Username: ${ADMIN_USERNAME}`);
    console.log(`  Password: ${ADMIN_PASSWORD}`);
    console.log('  Please log in and change this password immediately.');
}

seed();
