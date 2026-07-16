// public/js/app.js
//
// Runs on every dashboard page load. Does four things:
//   1. Checks whether the user is actually logged in (if not, bounce to login)
//   2. Shows their name and builds a navigation menu based on their ROLE
//      (this is the frontend half of role-based access — the backend
//      middleware in server/middleware/auth.js is what actually enforces
//      it; this part just avoids showing links to things a user can't use)
//   3. Wires up the logout button
//   4. Globally catches "session expired due to inactivity" responses
//      from ANY page's API calls and bounces to login — without this,
//      only the dashboard's own fetches would notice an idle-timeout;
//      wrapping window.fetch once here means every page benefits.

const _originalFetch = window.fetch;
window.fetch = async function (...args) {
    const response = await _originalFetch(...args);
    if (response.status === 401) {
        // Clone so the caller can still read the body themselves — we're
        // just peeking, not consuming their response.
        const clone = response.clone();
        try {
            const data = await clone.json();
            if (data.error && data.error.includes('inactivity')) {
                alert('You were logged out due to inactivity. Please log in again.');
                window.location.href = '/login.html';
            }
        } catch (err) {
            // Not JSON, or some other 401 shape — ignore, let the caller handle it normally.
        }
    }
    return response;
};

// Each nav item: which roles can see it, and where it links.
// As we build each module, we add its route here and it will automatically
// show up for the right roles.
const NAV_ITEMS = [
    { label: 'Dashboard',     href: '/index.html',        roles: ['admin', 'sales', 'optometrist'] },
    { label: 'Customers',     href: '/customers.html',    roles: ['admin', 'sales', 'optometrist'] },
    { label: 'Inventory',     href: '/inventory.html',    roles: ['admin', 'sales'] },
    { label: 'Notifications', href: '/notifications.html', roles: ['admin'], id: 'navNotifications' },
    { label: 'Sales/Invoice', href: '/sales.html',        roles: ['admin', 'sales'] },
    { label: 'Reports',       href: '/reports.html',      roles: ['admin'] },
    { label: 'Staff Accounts', href: '/users.html',       roles: ['admin'] },
    { label: 'Backup & Restore', href: '/backup.html',    roles: ['admin'] },
    { label: 'Settings', href: '/settings.html', roles: ['admin'] },
];

async function init() {
    let currentUser;

    try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) {
            window.location.href = '/login.html';
            return;
        }
        const data = await res.json();
        currentUser = data.user;
    } catch (err) {
        window.location.href = '/login.html';
        return;
    }

    document.getElementById('welcomeMsg').textContent =
        `${currentUser.full_name} (${currentUser.role})`;

    setupGlobalSearch();

    const sidebar = document.getElementById('sidebar');
    NAV_ITEMS
        .filter(item => item.roles.includes(currentUser.role))
        .forEach(item => {
            const link = document.createElement('a');
            link.href = item.href;
            link.textContent = item.label;
            if (item.id) link.id = item.id;
            sidebar.appendChild(link);
        });

    // For Admins, show a small unread-count badge next to "Notifications"
    // so a stock change made by staff is hard to miss, without needing
    // to click into the page first.
    if (currentUser.role === 'admin') {
        try {
            const res = await fetch('/api/inventory/notifications/unread-count');
            if (res.ok) {
                const data = await res.json();
                if (data.count > 0) {
                    const navLink = document.getElementById('navNotifications');
                    if (navLink) navLink.textContent = `Notifications (${data.count})`;
                }
            }
        } catch (err) {
            // Non-critical — if this fails, the nav link just shows without a count.
        }
    }

    document.getElementById('logoutBtn').addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        window.location.href = '/login.html';
    });
}

// ------------------------------------------------------------------
// GLOBAL SEARCH (FR-SR)
// Injects a search box into the topbar of EVERY page (not just specific
// list pages), since the whole point of a global search is being able
// to find something from wherever you currently are. Results are
// tolerant of partial input, appear as you type, and open the full
// record in one click.
// ------------------------------------------------------------------
function setupGlobalSearch() {
    const topbar = document.querySelector('.topbar');
    const userInfo = document.querySelector('.user-info');
    if (!topbar || !userInfo) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'global-search-wrapper';
    wrapper.innerHTML = `
        <input type="text" id="globalSearchInput" placeholder="Search customers, invoices, inventory...">
        <div id="globalSearchResults" class="search-results hidden"></div>
    `;
    topbar.insertBefore(wrapper, userInfo);

    const input = document.getElementById('globalSearchInput');
    const resultsBox = document.getElementById('globalSearchResults');

    let searchTimeout;
    input.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        const q = input.value.trim();
        if (q.length < 2) {
            resultsBox.classList.add('hidden');
            return;
        }
        searchTimeout = setTimeout(() => runGlobalSearch(q, resultsBox), 300);
    });

    // Close the dropdown if the user clicks anywhere else on the page.
    document.addEventListener('click', (event) => {
        if (!wrapper.contains(event.target)) {
            resultsBox.classList.add('hidden');
        }
    });
}

async function runGlobalSearch(q, resultsBox) {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return;
    const data = await res.json();

    const sections = [];

    if (data.customers.length > 0) {
        sections.push(`<div class="search-section-label">Customers</div>` + data.customers.map(c => `
            <div class="search-result-item" onclick="window.location.href='/customer-detail.html?id=${c.id}'">
                ${escapeAppHtml(c.full_name)} — ${escapeAppHtml(c.phone)} (${escapeAppHtml(c.customer_code)})
            </div>
        `).join(''));
    }

    if (data.invoices.length > 0) {
        sections.push(`<div class="search-section-label">Invoices</div>` + data.invoices.map(i => `
            <div class="search-result-item" onclick="window.location.href='/invoice-detail.html?id=${i.id}'">
                ${escapeAppHtml(i.invoice_number)} — ${escapeAppHtml(i.customer_name)} (Rs. ${Number(i.total_amount).toFixed(2)}, ${escapeAppHtml(i.status)})
            </div>
        `).join(''));
    }

    if (data.inventory.length > 0) {
        sections.push(`<div class="search-section-label">Inventory</div>` + data.inventory.map(item => `
            <div class="search-result-item" onclick="window.location.href='/inventory.html'">
                ${escapeAppHtml(item.item_code)} — ${escapeAppHtml(item.name)} (${item.quantity_in_stock} in stock)
            </div>
        `).join(''));
    }

    if (sections.length === 0) {
        resultsBox.innerHTML = '<div class="search-result-item">No matches.</div>';
    } else {
        resultsBox.innerHTML = sections.join('');
    }
    resultsBox.classList.remove('hidden');
}

function escapeAppHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

init();
