// db/backup-scheduler.js
//
// WHY THIS FILE EXISTS:
// Implements NFR-BK's requirement for automatic scheduled backups "with
// minimal user effort" — the shop owner shouldn't have to remember to
// click "Backup Now" every day. This runs once when the server starts,
// then checks once every hour whether today's automatic backup has
// already been made; if not, it makes one. Checking hourly (rather than
// trying to precisely schedule "once a day at midnight") is simpler and
// robust to the laptop being turned off/on at irregular hours — it just
// guarantees "at most one automatic backup per day, made some time
// during the day the app is running."
//
// Old automatic backups are pruned after 30 days so backups don't
// silently fill up the low-spec laptop's disk over months of use.
// Manual backups (created via the "Backup Now" button) are NOT pruned —
// only ones this scheduler created itself.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'shop.db');
const BACKUP_DIR = path.join(__dirname, 'backups');
const AUTO_BACKUP_PREFIX = 'auto-backup-';
const KEEP_DAYS = 30;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // check once an hour

function todayDateString() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function runAutoBackupCheck() {
    if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const today = todayDateString();
    const todaysFilename = `${AUTO_BACKUP_PREFIX}${today}.db`;
    const todaysPath = path.join(BACKUP_DIR, todaysFilename);

    if (!fs.existsSync(todaysPath) && fs.existsSync(DB_PATH)) {
        try {
            fs.copyFileSync(DB_PATH, todaysPath);
            console.log(`[backup-scheduler] Created automatic backup: ${todaysFilename}`);
        } catch (err) {
            console.error('[backup-scheduler] Automatic backup failed:', err.message);
        }
    }

    pruneOldAutoBackups();
}

function pruneOldAutoBackups() {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;

    fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith(AUTO_BACKUP_PREFIX))
        .forEach(f => {
            const filePath = path.join(BACKUP_DIR, f);
            const stats = fs.statSync(filePath);
            if (stats.mtimeMs < cutoff) {
                fs.unlinkSync(filePath);
                console.log(`[backup-scheduler] Pruned old automatic backup: ${f}`);
            }
        });
}

function startBackupScheduler() {
    runAutoBackupCheck(); // run once immediately on startup
    setInterval(runAutoBackupCheck, CHECK_INTERVAL_MS);
}

module.exports = { startBackupScheduler };
