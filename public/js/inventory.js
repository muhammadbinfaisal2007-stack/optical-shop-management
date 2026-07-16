// public/js/inventory.js
//
// Handles the Inventory page: listing/searching/filtering items, adding
// new items, and adjusting stock (which applies immediately and, if the
// current user isn't an admin, triggers a notification the Admin will
// see on their Notifications page).

const tableBody = document.getElementById('itemTableBody');
const emptyState = document.getElementById('emptyState');
const searchBox = document.getElementById('searchBox');
const typeFilter = document.getElementById('typeFilter');
const lowStockOnly = document.getElementById('lowStockOnly');

const showAddFormBtn = document.getElementById('showAddFormBtn');
const addFormWrapper = document.getElementById('addFormWrapper');
const addItemForm = document.getElementById('addItemForm');
const addFormError = document.getElementById('addFormError');
const cancelAddBtn = document.getElementById('cancelAddBtn');
const supplierSelect = document.getElementById('supplierSelect');

const adjustWrapper = document.getElementById('adjustWrapper');
const adjustForm = document.getElementById('adjustForm');
const adjustItemName = document.getElementById('adjustItemName');
const adjustError = document.getElementById('adjustError');
const adjustSuccess = document.getElementById('adjustSuccess');
const cancelAdjustBtn = document.getElementById('cancelAdjustBtn');

let currentAdjustItemId = null;

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

async function loadSuppliers() {
    const res = await fetch('/api/inventory/suppliers');
    if (!res.ok) return;
    const data = await res.json();
    data.suppliers.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        supplierSelect.appendChild(opt);
    });
}

async function loadItems() {
    const params = new URLSearchParams();
    if (searchBox.value.trim()) params.set('q', searchBox.value.trim());
    if (typeFilter.value) params.set('type', typeFilter.value);

    const url = lowStockOnly.checked
        ? '/api/inventory/low-stock'
        : `/api/inventory?${params.toString()}`;

    const res = await fetch(url);
    if (!res.ok) return;

    const data = await res.json();
    renderTable(data.items);
}

function renderTable(items) {
    tableBody.innerHTML = '';

    if (items.length === 0) {
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

    items.forEach(item => {
        const row = document.createElement('tr');
        const isLow = item.quantity_in_stock <= item.reorder_level;

        row.innerHTML = `
            <td>${escapeHtml(item.item_code)}</td>
            <td>${escapeHtml(item.item_type)}</td>
            <td>${escapeHtml(item.name)}</td>
            <td>${escapeHtml(item.brand || '')} ${escapeHtml(item.model || '')}</td>
            <td>Rs. ${Number(item.selling_price).toFixed(2)}</td>
            <td class="${isLow ? 'low-stock' : ''}">${item.quantity_in_stock}${isLow ? ' ⚠' : ''}</td>
            <td><button class="btn-secondary btn-small adjust-btn" data-id="${item.id}" data-name="${escapeHtml(item.name)}">Adjust Stock</button></td>
        `;
        tableBody.appendChild(row);
    });

    document.querySelectorAll('.adjust-btn').forEach(btn => {
        btn.addEventListener('click', () => openAdjustForm(btn.dataset.id, btn.dataset.name));
    });
}

function openAdjustForm(itemId, itemName) {
    currentAdjustItemId = itemId;
    adjustItemName.textContent = `Adjust Stock — ${itemName}`;
    adjustWrapper.classList.remove('hidden');
    adjustError.textContent = '';
    adjustSuccess.textContent = '';
    adjustForm.reset();
    adjustWrapper.scrollIntoView({ behavior: 'smooth' });
}

cancelAdjustBtn.addEventListener('click', () => {
    adjustWrapper.classList.add('hidden');
});

adjustForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    adjustError.textContent = '';
    adjustSuccess.textContent = '';

    const payload = Object.fromEntries(new FormData(adjustForm).entries());

    const res = await fetch(`/api/inventory/${currentAdjustItemId}/adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
        adjustError.textContent = data.error || 'Could not save adjustment.';
        return;
    }

    adjustSuccess.textContent = `Saved. New stock count: ${data.new_quantity}.`;
    loadItems();
});

searchBox.addEventListener('input', () => {
    clearTimeout(window._invSearchTimeout);
    window._invSearchTimeout = setTimeout(loadItems, 300);
});
typeFilter.addEventListener('change', loadItems);
lowStockOnly.addEventListener('change', loadItems);

showAddFormBtn.addEventListener('click', () => {
    addFormWrapper.classList.remove('hidden');
    addFormError.textContent = '';
});

cancelAddBtn.addEventListener('click', () => {
    addFormWrapper.classList.add('hidden');
    addItemForm.reset();
});

addItemForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    addFormError.textContent = '';

    const payload = Object.fromEntries(new FormData(addItemForm).entries());

    const res = await fetch('/api/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
        addFormError.textContent = data.error || 'Could not save item.';
        return;
    }

    addItemForm.reset();
    addFormWrapper.classList.add('hidden');
    loadItems();
});

loadSuppliers();
loadItems();
