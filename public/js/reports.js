// public/js/reports.js
//
// Handles the Reports page: tab switching between the five report
// types, loading each one's data, and wiring up the CSV export links
// (which just point at the same API endpoint with ?format=csv appended
// — the browser handles the actual download).

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function renderTable(rows, columns) {
    if (rows.length === 0) return '<p class="empty-state">No data for this period.</p>';
    const headerCells = columns.map(c => `<th>${c.label}</th>`).join('');
    const bodyRows = rows.map(row => {
        const cells = columns.map(c => `<td>${escapeHtml(c.format ? c.format(row[c.key]) : row[c.key])}</td>`).join('');
        return `<tr>${cells}</tr>`;
    }).join('');
    return `<table class="data-table"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

const money = (v) => `Rs. ${Number(v || 0).toFixed(2)}`;

// ---- Tab switching ----
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.report-panel').forEach(p => p.classList.add('hidden'));
        btn.classList.add('active');
        document.getElementById(`panel-${btn.dataset.tab}`).classList.remove('hidden');
    });
});

// ---- Daily Sales ----
const dailyDate = document.getElementById('dailyDate');
dailyDate.value = todayStr();

async function loadDaily() {
    const date = dailyDate.value || todayStr();
    document.getElementById('dailyCsvLink').href = `/api/reports/daily-sales?date=${date}&format=csv`;

    const res = await fetch(`/api/reports/daily-sales?date=${date}`);
    const data = await res.json();

    const summary = `
        <div class="totals-box">
            <p>Total Invoices: <strong>${data.totals.invoice_count}</strong></p>
            <p>Total Sales: <strong>${money(data.totals.total_sales)}</strong></p>
            ${data.payment_breakdown.map(p => `<p>${p.method}: ${money(p.total)}</p>`).join('')}
        </div>
    `;

    const table = renderTable(data.invoices, [
        { key: 'invoice_number', label: 'Invoice #' },
        { key: 'customer_name', label: 'Customer' },
        { key: 'total_amount', label: 'Total', format: money },
        { key: 'amount_paid', label: 'Paid', format: money },
        { key: 'balance_due', label: 'Balance', format: money },
        { key: 'status', label: 'Status' }
    ]);

    document.getElementById('dailyResults').innerHTML = summary + table;
}
document.getElementById('dailyLoadBtn').addEventListener('click', loadDaily);

// ---- Sales Range ----
const rangeStart = document.getElementById('rangeStart');
const rangeEnd = document.getElementById('rangeEnd');
rangeEnd.value = todayStr();

async function loadRange() {
    if (!rangeStart.value || !rangeEnd.value) return;
    document.getElementById('rangeCsvLink').href = `/api/reports/sales-range?start=${rangeStart.value}&end=${rangeEnd.value}&format=csv`;

    const res = await fetch(`/api/reports/sales-range?start=${rangeStart.value}&end=${rangeEnd.value}`);
    const data = await res.json();

    const summary = `
        <div class="totals-box">
            <p>Total Invoices: <strong>${data.totals.invoice_count}</strong></p>
            <p>Total Sales: <strong>${money(data.totals.total_sales)}</strong></p>
        </div>
    `;

    const table = renderTable(data.invoices, [
        { key: 'invoice_number', label: 'Invoice #' },
        { key: 'customer_name', label: 'Customer' },
        { key: 'total_amount', label: 'Total', format: money },
        { key: 'status', label: 'Status' },
        { key: 'created_at', label: 'Date' }
    ]);

    document.getElementById('rangeResults').innerHTML = summary + table;
}
document.getElementById('rangeLoadBtn').addEventListener('click', loadRange);

// ---- Stock Levels ----
async function loadStock() {
    const type = document.getElementById('stockTypeFilter').value;
    const csvUrl = `/api/reports/stock-levels${type ? '?type=' + type + '&format=csv' : '?format=csv'}`;
    document.getElementById('stockCsvLink').href = csvUrl;

    const res = await fetch(`/api/reports/stock-levels${type ? '?type=' + type : ''}`);
    const data = await res.json();

    const table = renderTable(data.items, [
        { key: 'item_code', label: 'Code' },
        { key: 'item_type', label: 'Type' },
        { key: 'name', label: 'Name' },
        { key: 'brand', label: 'Brand' },
        { key: 'quantity_in_stock', label: 'In Stock' },
        { key: 'reorder_level', label: 'Reorder Level' },
        { key: 'stock_status', label: 'Status' }
    ]);
    document.getElementById('stockResults').innerHTML = table;
}
document.getElementById('stockLoadBtn').addEventListener('click', loadStock);

// ---- Best Sellers ----
const bestStart = document.getElementById('bestStart');
const bestEnd = document.getElementById('bestEnd');
bestEnd.value = todayStr();

async function loadBestSellers() {
    const params = new URLSearchParams();
    if (bestStart.value) params.set('start', bestStart.value);
    if (bestEnd.value) params.set('end', bestEnd.value);

    document.getElementById('bestCsvLink').href = `/api/reports/best-sellers?${params.toString()}&format=csv`;

    const res = await fetch(`/api/reports/best-sellers?${params.toString()}`);
    const data = await res.json();

    const table = renderTable(data.items, [
        { key: 'item_code', label: 'Code' },
        { key: 'name', label: 'Name' },
        { key: 'item_type', label: 'Type' },
        { key: 'total_quantity_sold', label: 'Qty Sold' },
        { key: 'total_value_sold', label: 'Value Sold', format: money }
    ]);
    document.getElementById('bestResults').innerHTML = table;
}
document.getElementById('bestLoadBtn').addEventListener('click', loadBestSellers);

// ---- Outstanding Dues ----
async function loadDues() {
    document.getElementById('duesCsvLink').href = '/api/reports/dues?format=csv';

    const res = await fetch('/api/reports/dues');
    const data = await res.json();

    const table = renderTable(data.customers, [
        { key: 'customer_name', label: 'Customer' },
        { key: 'customer_phone', label: 'Phone' },
        { key: 'invoices_with_dues', label: '# Invoices' },
        { key: 'total_due', label: 'Total Due', format: money }
    ]);
    document.getElementById('duesResults').innerHTML = table;
}

// ---- Initial load ----
loadDaily();
loadDues();
