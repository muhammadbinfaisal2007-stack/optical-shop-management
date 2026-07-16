// public/js/backup.js
//
// Handles the Backup & Restore page: creating an on-demand backup,
// listing/downloading existing backups, and restoring from an uploaded
// file (with an explicit typed confirmation since restoring overwrites
// all current data).

const backupNowBtn = document.getElementById('backupNowBtn');
const backupNowMsg = document.getElementById('backupNowMsg');
const backupListBody = document.getElementById('backupListBody');
const restoreFileInput = document.getElementById('restoreFileInput');
const restoreBtn = document.getElementById('restoreBtn');
const restoreError = document.getElementById('restoreError');
const restoreSuccess = document.getElementById('restoreSuccess');

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadBackups() {
    const res = await fetch('/api/backup/list');
    if (!res.ok) {
        backupListBody.innerHTML = `<tr><td colspan="4">Could not load backups.</td></tr>`;
        return;
    }
    const data = await res.json();

    if (data.backups.length === 0) {
        backupListBody.innerHTML = `<tr><td colspan="4">No backups yet — click "Backup Now" to create the first one.</td></tr>`;
        return;
    }

    backupListBody.innerHTML = data.backups.map(b => `
        <tr>
            <td>${escapeHtml(b.filename)}</td>
            <td>${formatBytes(b.size_bytes)}</td>
            <td>${new Date(b.created_at).toLocaleString()}</td>
            <td><a href="/api/backup/download/${encodeURIComponent(b.filename)}"><button class="btn-secondary btn-small">Download</button></a></td>
        </tr>
    `).join('');
}

backupNowBtn.addEventListener('click', async () => {
    backupNowMsg.textContent = '';
    backupNowBtn.disabled = true;
    backupNowBtn.textContent = 'Backing up...';

    const res = await fetch('/api/backup/create', { method: 'POST' });
    const data = await res.json();

    backupNowBtn.disabled = false;
    backupNowBtn.textContent = 'Backup Now';

    if (!res.ok) {
        backupNowMsg.textContent = data.error || 'Backup failed.';
        return;
    }

    backupNowMsg.textContent = `Backup created: ${data.filename}`;
    loadBackups();
});

restoreBtn.addEventListener('click', async () => {
    restoreError.textContent = '';
    restoreSuccess.textContent = '';

    const file = restoreFileInput.files[0];
    if (!file) {
        restoreError.textContent = 'Please choose a backup file first.';
        return;
    }

    const confirmed = confirm(
        `This will REPLACE all current shop data with the contents of "${file.name}". ` +
        `Anything entered since that backup was made will be permanently lost. Continue?`
    );
    if (!confirmed) return;

    restoreBtn.disabled = true;
    restoreBtn.textContent = 'Restoring...';

    try {
        const base64 = await fileToBase64(file);

        const res = await fetch('/api/backup/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_base64: base64 })
        });

        const data = await res.json();

        if (!res.ok) {
            restoreError.textContent = data.error || 'Restore failed.';
            restoreBtn.disabled = false;
            restoreBtn.textContent = 'Restore From This File';
            return;
        }

        restoreSuccess.textContent = data.message;
        restoreBtn.textContent = 'Server has stopped';
    } catch (err) {
        restoreError.textContent = 'Could not read or upload the file.';
        restoreBtn.disabled = false;
        restoreBtn.textContent = 'Restore From This File';
    }
});

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            // reader.result looks like "data:application/octet-stream;base64,XXXX"
            // — we only want the part after the comma.
            const base64 = reader.result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

loadBackups();
