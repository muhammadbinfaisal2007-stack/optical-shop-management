// public/js/customers.js
//
// Handles the customer list page: loading/searching customers, showing
// the add-customer form, and submitting new customers to the API.
//
// Note: app.js (loaded before this file) already handles login-check,
// welcome message, sidebar, and logout — this file only handles what's
// specific to THIS page.

const tableBody = document.getElementById('customerTableBody');
const emptyState = document.getElementById('emptyState');
const searchBox = document.getElementById('searchBox');
const showInactiveToggle = document.getElementById('showInactiveToggle');
const showAddFormBtn = document.getElementById('showAddFormBtn');
const addFormWrapper = document.getElementById('addFormWrapper');
const addCustomerForm = document.getElementById('addCustomerForm');
const addFormError = document.getElementById('addFormError');
const cancelAddBtn = document.getElementById('cancelAddBtn');

// Loads (or re-loads) the customer list, optionally filtered by a search term.
async function loadCustomers(query = '') {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (showInactiveToggle.checked) params.set('include_inactive', 'true');

    const res = await fetch(`/api/customers?${params.toString()}`);

    if (!res.ok) {
        console.error('Failed to load customers');
        return;
    }

    const data = await res.json();
    renderTable(data.customers);
}

function renderTable(customers) {
    tableBody.innerHTML = '';

    if (customers.length === 0) {
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

    customers.forEach(c => {
        const row = document.createElement('tr');
        const statusLabel = c.is_active ? 'Active' : 'Deactivated';
        const toggleAction = c.is_active ? 'deactivate' : 'reactivate';
        const toggleLabel = c.is_active ? 'Deactivate' : 'Reactivate';

        row.innerHTML = `
            <td>${escapeHtml(c.customer_code)}</td>
            <td>${escapeHtml(c.full_name)}</td>
            <td>${escapeHtml(c.phone)}</td>
            <td>${escapeHtml(c.email || '—')}</td>
            <td>${statusLabel}</td>
            <td>
                <a href="/customer-detail.html?id=${c.id}">View</a> &nbsp;
                <button class="btn-secondary btn-small toggle-active-btn" data-id="${c.id}" data-action="${toggleAction}">${toggleLabel}</button>
            </td>
        `;
        tableBody.appendChild(row);
    });

    document.querySelectorAll('.toggle-active-btn').forEach(btn => {
        btn.addEventListener('click', () => toggleCustomerActive(btn.dataset.id, btn.dataset.action));
    });
}

async function toggleCustomerActive(id, action) {
    const res = await fetch(`/api/customers/${id}/${action}`, { method: 'PUT' });
    if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'Could not update customer status.');
        return;
    }
    loadCustomers(searchBox.value.trim());
}

// Basic HTML-escaping so a customer name/email containing special
// characters can never break the page layout or inject markup.
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Debounced search — waits until the user pauses typing for 300ms before
// firing the request, so we're not hitting the API on every keystroke.
let searchTimeout;
searchBox.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => loadCustomers(searchBox.value.trim()), 300);
});
showInactiveToggle.addEventListener('change', () => loadCustomers(searchBox.value.trim()));

showAddFormBtn.addEventListener('click', () => {
    addFormWrapper.classList.remove('hidden');
    addFormError.textContent = '';
});

cancelAddBtn.addEventListener('click', () => {
    addFormWrapper.classList.add('hidden');
    addCustomerForm.reset();
});

addCustomerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    addFormError.textContent = '';

    const formData = new FormData(addCustomerForm);
    const payload = Object.fromEntries(formData.entries());

    const res = await fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
        addFormError.textContent = data.error || 'Could not save customer.';
        return;
    }

    addCustomerForm.reset();
    addFormWrapper.classList.add('hidden');
    loadCustomers(searchBox.value.trim());
});

loadCustomers();
