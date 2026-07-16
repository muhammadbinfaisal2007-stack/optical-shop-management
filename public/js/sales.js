// public/js/sales.js
//
// Handles the invoice list page: search, status filter, and the
// "dues only" view for quickly seeing who still owes money.

const tableBody = document.getElementById('invoiceTableBody');
const emptyState = document.getElementById('emptyState');
const searchBox = document.getElementById('searchBox');
const statusFilter = document.getElementById('statusFilter');
const duesOnly = document.getElementById('duesOnly');

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

const STATUS_LABELS = {
    draft: 'Draft / Hold', unpaid: 'Unpaid', partial: 'Partial', paid: 'Paid', cancelled: 'Cancelled'
};

async function loadInvoices() {
    let url;
    if (duesOnly.checked) {
        url = '/api/invoices/dues';
    } else {
        const params = new URLSearchParams();
        if (searchBox.value.trim()) params.set('q', searchBox.value.trim());
        if (statusFilter.value) params.set('status', statusFilter.value);
        url = `/api/invoices?${params.toString()}`;
    }

    const res = await fetch(url);
    if (!res.ok) return;

    const data = await res.json();
    renderTable(data.invoices);
}

function renderTable(invoices) {
    tableBody.innerHTML = '';

    if (invoices.length === 0) {
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

    invoices.forEach(inv => {
        const row = document.createElement('tr');
        const totalCell = inv.total_amount !== undefined ? `Rs. ${Number(inv.total_amount).toFixed(2)}` : '—';
        const paidCell = inv.amount_paid !== undefined ? `Rs. ${Number(inv.amount_paid).toFixed(2)}` : '—';

        row.innerHTML = `
            <td>${escapeHtml(inv.invoice_number)}</td>
            <td>${escapeHtml(inv.customer_name)} (${escapeHtml(inv.customer_phone)})</td>
            <td>${totalCell}</td>
            <td>${paidCell}</td>
            <td class="${inv.balance_due > 0 ? 'low-stock' : ''}">Rs. ${Number(inv.balance_due).toFixed(2)}</td>
            <td>${STATUS_LABELS[inv.status] || inv.status}</td>
            <td>${escapeHtml(inv.created_at)}</td>
            <td><a href="/invoice-detail.html?id=${inv.id}">View</a></td>
        `;
        tableBody.appendChild(row);
    });
}

searchBox.addEventListener('input', () => {
    clearTimeout(window._invSearchTimeout);
    window._invSearchTimeout = setTimeout(loadInvoices, 300);
});
statusFilter.addEventListener('change', loadInvoices);
duesOnly.addEventListener('change', loadInvoices);

loadInvoices();
