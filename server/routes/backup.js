// server/routes/backup.js
//
// WHY THIS FILE EXISTS:
// Implements NFR-BK — backing up the shop's entire database to a file
// that can be copied to a USB drive or cloud folder, and restoring from
// one if something goes wrong. Since the ENTIRE shop's data (customers,
// prescriptions, inventory, invoices, payments — everything) lives in
// one SQLite file, "backup" is genuinely just "copy that one file" —
// no complex export/import format needed.
//
// PERMISSIONS: Admin only (SRS Section 3: "Run backup/restore: Y admin,
// --- sales, --- optometrist").
//
// RESTORE SAFETY: overwriting the live database file while the app has
// it open is risky, so restore: (1) validates the uploaded file is
// actually a SQLite database, (2) saves a safety copy of the CURRENT
// database first (in case the uploaded file turns out to be bad), (3)
// closes the live connection, (4) writes the new file, then (5) shuts
// the server down cleanly and asks the Admin to restart it — this
// guarantees every part of the app reopens against the restored data
// instead of some routes still holding a stale connection.

const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../../db/connection');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('admin'));

const DB_PATH = path.join(__dirname, '..', '..', 'db', 'shop.db');
const BACKUP_DIR = path.join(__dirname, '..', '..', 'db', 'backups');

if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function timestampForFilename() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ------------------------------------------------------------------
// POST /api/backup/create — on-demand backup
// ------------------------------------------------------------------
router.post('/create', (req, res) => {
    try {
        const filename = `shop-backup-${timestampForFilename()}.db`;
        const destPath = path.join(BACKUP_DIR, filename);
        fs.copyFileSync(DB_PATH, destPath);

        db.prepare(`
            INSERT INTO audit_log (user_id, action, details) VALUES (?, 'BACKUP_CREATED', ?)
        `).run(req.session.user.id, `Created backup file ${filename}`);

        const stats = fs.statSync(destPath);
        res.json({ success: true, filename, size_bytes: stats.size, created_at: stats.mtime });
    } catch (err) {
        res.status(500).json({ error: 'Backup failed: ' + err.message });
    }
});

// ------------------------------------------------------------------
// GET /api/backup/list — shows every backup file on disk (manual + automatic)
// ------------------------------------------------------------------
router.get('/list', (req, res) => {
    const files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith('.db'))
        .map(f => {
            const stats = fs.statSync(path.join(BACKUP_DIR, f));
            return { filename: f, size_bytes: stats.size, created_at: stats.mtime };
        })
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ backups: files });
});

// ------------------------------------------------------------------
// GET /api/backup/download/:filename — download a specific backup file
// ------------------------------------------------------------------
router.get('/download/:filename', (req, res) => {
    // Guard against path traversal (e.g. "../../../etc/passwd") — only
    // allow plain filenames that actually exist in the backups folder.
    const filename = path.basename(req.params.filename);
    const filePath = path.join(BACKUP_DIR, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Backup file not found.' });
    }

    res.download(filePath, filename);
});

// ------------------------------------------------------------------
// POST /api/backup/restore
// Body: { filename_hint, file_base64 } — the frontend reads the chosen
// file with the browser's FileReader API and sends its contents here
// as base64 (kept simple — no multipart upload library needed for a
// single-admin, occasional-use feature like this).
// ------------------------------------------------------------------
router.post('/restore', (req, res) => {
    const { file_base64 } = req.body;

    if (!file_base64) {
        return res.status(400).json({ error: 'No backup file provided.' });
    }

    let buffer;
    try {
        buffer = Buffer.from(file_base64, 'base64');
    } catch (err) {
        return res.status(400).json({ error: 'Could not read the uploaded file.' });
    }

    // Every valid SQLite database file starts with this exact 16-byte
    // header — checking it catches "you uploaded the wrong file"
    // mistakes before we touch anything important.
    const SQLITE_HEADER = 'SQLite format 3\0';
    if (buffer.length < 16 || buffer.toString('utf8', 0, 16) !== SQLITE_HEADER) {
        return res.status(400).json({ error: 'That file does not look like a valid database backup.' });
    }

    try {
        // Safety copy of the CURRENT (pre-restore) database, in case the
        // uploaded file turns out to be bad and we need to undo this.
        const safetyFilename = `pre-restore-safety-${timestampForFilename()}.db`;
        fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, safetyFilename));

        db.prepare(`
            INSERT INTO audit_log (user_id, action, details) VALUES (?, 'RESTORE_INITIATED', ?)
        `).run(req.session.user.id, `Restoring from uploaded backup. Safety copy: ${safetyFilename}`);

        // Close the live connection before overwriting the file it points
        // to — writing underneath an open database handle risks
        // corruption. The server intentionally exits right after, so
        // nothing else tries to use this closed connection.
        db.close();

        fs.writeFileSync(DB_PATH, buffer);

        res.json({
            success: true,
            message: 'Restore complete. The server will now stop — please run "npm start" again to load the restored data.',
            safety_backup: safetyFilename
        });

        // Give the response time to actually reach the browser before
        // the process exits.
        setTimeout(() => process.exit(0), 500);
    } catch (err) {
        res.status(500).json({ error: 'Restore failed: ' + err.message });
    }
});

module.exports = router;
