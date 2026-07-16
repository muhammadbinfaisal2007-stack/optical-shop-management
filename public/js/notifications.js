// public/js/notifications.js
//
// Shows the Admin every stock-change notification, newest first, with
// unread ones visually highlighted. Clicking a notification marks it read.

const notificationList = document.getElementById('notificationList');
const emptyState = document.getElementById('emptyState');
const markAllReadBtn = document.getElementById('markAllReadBtn');

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

function timeAgo(dateStr) {
    // SQLite datetime('now') gives UTC-ish "YYYY-MM-DD HH:MM:SS" — treat
    // as UTC explicitly so the comparison to "now" is accurate regardless
    // of the shop laptop's local timezone.
    const then = new Date(dateStr.replace(' ', 'T') + 'Z');
    const diffMs = Date.now() - then.getTime();
    const diffMins = Math.round(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    const diffHours = Math.round(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hr ago`;
    return `${Math.round(diffHours / 24)} day(s) ago`;
}

async function loadNotifications() {
    const res = await fetch('/api/inventory/notifications/list');
    if (!res.ok) {
        notificationList.innerHTML = `<p class="error-msg">You don't have permission to view this page.</p>`;
        return;
    }
    const data = await res.json();
    render(data.notifications);
}

function render(notifications) {
    notificationList.innerHTML = '';

    if (notifications.length === 0) {
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

    notifications.forEach(n => {
        const card = document.createElement('div');
        card.className = `notification-card ${n.is_read ? '' : 'unread'}`;
        card.innerHTML = `
            <p>${escapeHtml(n.message)}</p>
            <span class="notification-time">${timeAgo(n.created_at)}</span>
        `;
        if (!n.is_read) {
            card.addEventListener('click', () => markRead(n.id, card));
        }
        notificationList.appendChild(card);
    });
}

async function markRead(id, cardEl) {
    await fetch(`/api/inventory/notifications/${id}/read`, { method: 'PUT' });
    cardEl.classList.remove('unread');
}

markAllReadBtn.addEventListener('click', async () => {
    await fetch('/api/inventory/notifications/mark-all-read', { method: 'PUT' });
    loadNotifications();
});

loadNotifications();
