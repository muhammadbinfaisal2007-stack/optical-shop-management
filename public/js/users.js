// public/js/users.js
//
// Handles the Staff Accounts page: listing employees, creating new
// accounts, disabling/enabling accounts, and resetting passwords.
// This entire page is only reachable by Admins — the backend enforces
// this too (see server/routes/users.js), so even if a non-admin somehow
// loaded this page, every API call here would be rejected.

const tableBody = document.getElementById('userTableBody');
const showAddFormBtn = document.getElementById('showAddFormBtn');
const addFormWrapper = document.getElementById('addFormWrapper');
const addUserForm = document.getElementById('addUserForm');
const addFormError = document.getElementById('addFormError');
const cancelAddBtn = document.getElementById('cancelAddBtn');

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

const ROLE_LABELS = { admin: 'Admin', sales: 'Sales Staff', optometrist: 'Optometrist' };

async function loadUsers() {
    const res = await fetch('/api/users');

    if (!res.ok) {
        // Most likely reason: a non-admin somehow reached this page.
        tableBody.innerHTML = `<tr><td colspan="5">You don't have permission to view this page.</td></tr>`;
        return;
    }

    const data = await res.json();
    renderTable(data.users);
}

function renderTable(users) {
    tableBody.innerHTML = '';

    users.forEach(u => {
        const row = document.createElement('tr');
        const statusLabel = u.is_active ? 'Active' : 'Disabled';
        const toggleLabel = u.is_active ? 'Disable' : 'Enable';

        row.innerHTML = `
            <td>${escapeHtml(u.full_name)}</td>
            <td>${escapeHtml(u.username)}</td>
            <td>${ROLE_LABELS[u.role] || u.role}</td>
            <td>${statusLabel}</td>
            <td>
                <button class="btn-secondary btn-small toggle-btn" data-id="${u.id}">${toggleLabel}</button>
                <button class="btn-secondary btn-small reset-btn" data-id="${u.id}" data-username="${escapeHtml(u.username)}">Reset Password</button>
            </td>
        `;
        tableBody.appendChild(row);
    });

    // Wire up the action buttons after rendering (they don't exist until now).
    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => toggleActive(btn.dataset.id));
    });
    document.querySelectorAll('.reset-btn').forEach(btn => {
        btn.addEventListener('click', () => resetPassword(btn.dataset.id, btn.dataset.username));
    });
}

async function toggleActive(userId) {
    const res = await fetch(`/api/users/${userId}/toggle-active`, { method: 'PUT' });
    const data = await res.json();

    if (!res.ok) {
        alert(data.error || 'Could not update account status.');
        return;
    }
    loadUsers();
}

async function resetPassword(userId, username) {
    const newPassword = prompt(`Enter a new temporary password for "${username}" (minimum 6 characters):`);
    if (!newPassword) return; // user cancelled

    const res = await fetch(`/api/users/${userId}/reset-password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_password: newPassword })
    });

    const data = await res.json();

    if (!res.ok) {
        alert(data.error || 'Could not reset password.');
        return;
    }

    alert(`Password reset. Share the new password "${newPassword}" with ${username} directly.`);
}

showAddFormBtn.addEventListener('click', () => {
    addFormWrapper.classList.remove('hidden');
    addFormError.textContent = '';
});

cancelAddBtn.addEventListener('click', () => {
    addFormWrapper.classList.add('hidden');
    addUserForm.reset();
});

addUserForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    addFormError.textContent = '';

    const payload = Object.fromEntries(new FormData(addUserForm).entries());

    const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
        addFormError.textContent = data.error || 'Could not create account.';
        return;
    }

    addUserForm.reset();
    addFormWrapper.classList.add('hidden');
    loadUsers();
});

loadUsers();
