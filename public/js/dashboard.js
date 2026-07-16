// public/js/dashboard.js
//
// Implements FR-RD-01: the home-screen dashboard. Admin and Sales Staff
// see today's sales, payment split, low-stock count, and outstanding
// dues. Optometrist doesn't have dashboard access per the SRS
// permissions table, so they get a simple generic landing message instead.

const dashboardContent = document.getElementById('dashboardContent');

const METHOD_LABELS = { cash: 'Cash', bank_transfer: 'Bank Transfer', other: 'Other' };

async function loadDashboard() {
    const meRes = await fetch('/api/auth/me');
    if (!meRes.ok) return; // app.js already redirects to login in this case
    const me = await meRes.json();

    if (me.user.role === 'optometrist') {
        dashboardContent.innerHTML = `
            <p>Welcome, ${escapeHtml(me.user.full_name)}. Use the sidebar to look up a customer
               or record a prescription.</p>
        `;
        return;
    }

    const res = await fetch('/api/dashboard/summary');
    if (!res.ok) {
        dashboardContent.innerHTML = '<p class="error-msg">Could not load dashboard.</p>';
        return;
    }

    const data = await res.json();
    render(data);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

function render(data) {
    const paymentRows = data.payment_split_today.length > 0
        ? data.payment_split_today.map(p => `<p>${METHOD_LABELS[p.method] || p.method}: Rs. ${Number(p.total).toFixed(2)}</p>`).join('')
        : '<p>No payments recorded yet today.</p>';

    dashboardContent.innerHTML = `
        <div class="dashboard-grid">
            <div class="dashboard-card">
                <h3>Today's Sales</h3>
                <p class="dashboard-number">Rs. ${Number(data.today_sales.total).toFixed(2)}</p>
                <p>${data.today_sales.count} invoice(s)</p>
            </div>
            <div class="dashboard-card">
                <h3>Today's Payment Split</h3>
                ${paymentRows}
            </div>
            <div class="dashboard-card ${data.low_stock_count > 0 ? 'dashboard-card-alert' : ''}">
                <h3>Low Stock Alerts</h3>
                <p class="dashboard-number">${data.low_stock_count}</p>
                <p><a href="/inventory.html">View inventory &rarr;</a></p>
            </div>
            <div class="dashboard-card ${data.outstanding_dues.total > 0 ? 'dashboard-card-alert' : ''}">
                <h3>Outstanding Dues</h3>
                <p class="dashboard-number">Rs. ${Number(data.outstanding_dues.total).toFixed(2)}</p>
                <p>${data.outstanding_dues.invoice_count} invoice(s) &mdash; <a href="/sales.html">View &rarr;</a></p>
            </div>
        </div>
    `;
}

loadDashboard();
