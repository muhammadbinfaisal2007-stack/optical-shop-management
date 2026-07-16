// public/js/new-invoice.js
//
// Handles building a new invoice: search + select (or create) a
// customer, search + add inventory items with quantities and optional
// per-line discounts, add non-stock service charges, see live totals,
// and either finalize immediately or save as a draft/hold for later.
// The real discount cap is enforced server-side — the max attribute
// here is just a helpful hint for Sales Staff.

const customerSearch = document.getElementById('customerSearch');
const customerResults = document.getElementById('customerResults');
const selectedCustomer = document.getElementById('selectedCustomer');
const customerIdInput = document.getElementById('customerId');

const showNewCustomerBtn = document.getElementById('showNewCustomerBtn');
const newCustomerWrapper = document.getElementById('newCustomerWrapper');
const newCustomerName = document.getElementById('newCustomerName');
const newCustomerPhone = document.getElementById('newCustomerPhone');
const saveNewCustomerBtn = document.getElementById('saveNewCustomerBtn');
const cancelNewCustomerBtn = document.getElementById('cancelNewCustomerBtn');
const newCustomerError = document.getElementById('newCustomerError');

const itemSearch = document.getElementById('itemSearch');
const itemResults = document.getElementById('itemResults');
const invoiceItemsBody = document.getElementById('invoiceItemsBody');
const noItems = document.getElementById('noItems');

const serviceDescription = document.getElementById('serviceDescription');
const servicePrice = document.getElementById('servicePrice');
const addServiceBtn = document.getElementById('addServiceBtn');
const serviceLinesBody = document.getElementById('serviceLinesBody');

const discountPercentInput = document.getElementById('discountPercent');
const discountLimitHint = document.getElementById('discountLimitHint');
const initialPaymentInput = document.getElementById('initialPayment');
const tenderedAmountInput = document.getElementById('tenderedAmount');

const subtotalDisplay = document.getElementById('subtotalDisplay');
const discountDisplay = document.getElementById('discountDisplay');
const taxDisplay = document.getElementById('taxDisplay');
const totalDisplay = document.getElementById('totalDisplay');
const balanceDisplay = document.getElementById('balanceDisplay');

const submitBtn = document.getElementById('submitInvoiceBtn');
const saveDraftBtn = document.getElementById('saveDraftBtn');
const submitError = document.getElementById('submitError');

let cartItems = [];       // [{ item_id, name, unit_price, quantity, max_stock, line_discount_percent }]
let serviceLines = [];    // [{ description, unit_price }]
let taxPercent = 15;      // fetched from settings below, used only for the live preview

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

// ---- Show the Sales Staff their discount limit, and load the real tax rate ----
(async function loadContext() {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return;
    const data = await res.json();
    if (data.user.role === 'sales') {
        discountPercentInput.max = data.user.discount_limit_percent;
        discountLimitHint.textContent = `(your combined limit: ${data.user.discount_limit_percent}%)`;
    }

    // Settings is Admin-only, so a Sales Staff request here will 403 —
    // that's fine, we just fall back to the default 15% for the preview;
    // the server always computes the REAL total with the correct rate.
    const settingsRes = await fetch('/api/settings');
    if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        taxPercent = settingsData.settings.tax_percent;
        document.getElementById('taxDisplay').previousElementSibling;
    }
    recalculateTotals();
})();

// ---- Customer search ----
let customerSearchTimeout;
customerSearch.addEventListener('input', () => {
    clearTimeout(customerSearchTimeout);
    const q = customerSearch.value.trim();
    if (!q) { customerResults.classList.add('hidden'); return; }
    customerSearchTimeout = setTimeout(async () => {
        const res = await fetch(`/api/customers?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        renderCustomerResults(data.customers);
    }, 300);
});

function renderCustomerResults(customers) {
    if (customers.length === 0) {
        customerResults.innerHTML = '<div class="search-result-item">No matches.</div>';
        customerResults.classList.remove('hidden');
        return;
    }
    customerResults.innerHTML = customers.map(c => `
        <div class="search-result-item" data-id="${c.id}" data-name="${escapeHtml(c.full_name)}" data-phone="${escapeHtml(c.phone)}">
            ${escapeHtml(c.full_name)} — ${escapeHtml(c.phone)} (${escapeHtml(c.customer_code)})
        </div>
    `).join('');
    customerResults.classList.remove('hidden');

    customerResults.querySelectorAll('.search-result-item[data-id]').forEach(el => {
        el.addEventListener('click', () => selectCustomer(el.dataset.id, el.dataset.name, el.dataset.phone));
    });
}

function selectCustomer(id, name, phone) {
    customerIdInput.value = id;
    selectedCustomer.textContent = `Selected: ${name} (${phone})`;
    customerSearch.value = '';
    customerResults.classList.add('hidden');
}

// ---- Inline new customer creation ----
showNewCustomerBtn.addEventListener('click', () => {
    newCustomerWrapper.classList.remove('hidden');
    newCustomerError.textContent = '';
});

cancelNewCustomerBtn.addEventListener('click', () => {
    newCustomerWrapper.classList.add('hidden');
    newCustomerName.value = '';
    newCustomerPhone.value = '';
});

saveNewCustomerBtn.addEventListener('click', async () => {
    newCustomerError.textContent = '';

    if (!newCustomerName.value.trim() || !newCustomerPhone.value.trim()) {
        newCustomerError.textContent = 'Name and phone are both required.';
        return;
    }

    const res = await fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: newCustomerName.value.trim(), phone: newCustomerPhone.value.trim() })
    });
    const data = await res.json();

    if (!res.ok) {
        newCustomerError.textContent = data.error || 'Could not create customer.';
        return;
    }

    selectCustomer(data.customer.id, data.customer.full_name, data.customer.phone);
    newCustomerWrapper.classList.add('hidden');
    newCustomerName.value = '';
    newCustomerPhone.value = '';
});

// ---- Item search ----
let itemSearchTimeout;
itemSearch.addEventListener('input', () => {
    clearTimeout(itemSearchTimeout);
    const q = itemSearch.value.trim();
    if (!q) { itemResults.classList.add('hidden'); return; }
    itemSearchTimeout = setTimeout(async () => {
        const res = await fetch(`/api/inventory?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        renderItemResults(data.items);
    }, 300);
});

function renderItemResults(items) {
    if (items.length === 0) {
        itemResults.innerHTML = '<div class="search-result-item">No matches.</div>';
        itemResults.classList.remove('hidden');
        return;
    }
    itemResults.innerHTML = items.map(i => `
        <div class="search-result-item" data-id="${i.id}" data-name="${escapeHtml(i.name)}"
             data-price="${i.selling_price}" data-stock="${i.quantity_in_stock}">
            ${escapeHtml(i.item_code)} — ${escapeHtml(i.name)} (Rs. ${Number(i.selling_price).toFixed(2)}, ${i.quantity_in_stock} in stock)
        </div>
    `).join('');
    itemResults.classList.remove('hidden');

    itemResults.querySelectorAll('.search-result-item[data-id]').forEach(el => {
        el.addEventListener('click', () => {
            addItemToCart({
                item_id: el.dataset.id,
                name: el.dataset.name,
                unit_price: Number(el.dataset.price),
                max_stock: Number(el.dataset.stock)
            });
            itemSearch.value = '';
            itemResults.classList.add('hidden');
        });
    });
}

function addItemToCart(item) {
    const existing = cartItems.find(i => i.item_id === item.item_id);
    if (existing) {
        if (existing.quantity < item.max_stock) existing.quantity += 1;
    } else {
        cartItems.push({ ...item, quantity: 1, line_discount_percent: 0 });
    }
    renderCart();
}

function renderCart() {
    invoiceItemsBody.innerHTML = '';
    noItems.classList.toggle('hidden', cartItems.length > 0);

    cartItems.forEach((item, index) => {
        const gross = item.unit_price * item.quantity;
        const lineTotal = gross - (gross * item.line_discount_percent / 100);
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${escapeHtml(item.name)}</td>
            <td>Rs. ${item.unit_price.toFixed(2)}</td>
            <td><input type="number" min="1" max="${item.max_stock}" value="${item.quantity}" class="qty-input" data-index="${index}" style="width: 60px;"></td>
            <td><input type="number" min="0" max="100" value="${item.line_discount_percent}" class="line-disc-input" data-index="${index}" style="width: 60px;"></td>
            <td>Rs. ${lineTotal.toFixed(2)}</td>
            <td><button type="button" class="btn-secondary btn-small remove-btn" data-index="${index}">Remove</button></td>
        `;
        invoiceItemsBody.appendChild(row);
    });

    invoiceItemsBody.querySelectorAll('.qty-input').forEach(input => {
        input.addEventListener('change', () => {
            const idx = Number(input.dataset.index);
            let qty = parseInt(input.value, 10) || 1;
            qty = Math.min(Math.max(qty, 1), cartItems[idx].max_stock);
            cartItems[idx].quantity = qty;
            renderCart();
        });
    });

    invoiceItemsBody.querySelectorAll('.line-disc-input').forEach(input => {
        input.addEventListener('change', () => {
            const idx = Number(input.dataset.index);
            let pct = Number(input.value) || 0;
            pct = Math.min(Math.max(pct, 0), 100);
            cartItems[idx].line_discount_percent = pct;
            renderCart();
        });
    });

    invoiceItemsBody.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            cartItems.splice(Number(btn.dataset.index), 1);
            renderCart();
        });
    });

    recalculateTotals();
}

// ---- Service lines ----
addServiceBtn.addEventListener('click', () => {
    const desc = serviceDescription.value.trim();
    const price = Number(servicePrice.value);
    if (!desc || Number.isNaN(price) || price < 0) {
        alert('Please enter a description and a valid price for the service charge.');
        return;
    }
    serviceLines.push({ description: desc, unit_price: price });
    serviceDescription.value = '';
    servicePrice.value = '';
    renderServiceLines();
});

function renderServiceLines() {
    serviceLinesBody.innerHTML = serviceLines.map((line, index) => `
        <tr>
            <td>${escapeHtml(line.description)}</td>
            <td>Rs. ${line.unit_price.toFixed(2)}</td>
            <td><button type="button" class="btn-secondary btn-small remove-service-btn" data-index="${index}">Remove</button></td>
        </tr>
    `).join('');

    serviceLinesBody.querySelectorAll('.remove-service-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            serviceLines.splice(Number(btn.dataset.index), 1);
            renderServiceLines();
            recalculateTotals();
        });
    });

    recalculateTotals();
}

// ---- Live totals ----
function recalculateTotals() {
    const allLines = [
        ...cartItems.map(i => ({ unitPrice: i.unit_price, qty: i.quantity, discPct: i.line_discount_percent })),
        ...serviceLines.map(s => ({ unitPrice: s.unit_price, qty: 1, discPct: 0 }))
    ];

    const preDiscountSubtotal = allLines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0);
    const postLineDiscountSubtotal = allLines.reduce((sum, l) => {
        const gross = l.unitPrice * l.qty;
        return sum + (gross - gross * l.discPct / 100);
    }, 0);

    const invoiceDiscountPct = Number(discountPercentInput.value) || 0;
    const invoiceDiscountAmount = postLineDiscountSubtotal * invoiceDiscountPct / 100;
    const taxableAmount = postLineDiscountSubtotal - invoiceDiscountAmount;
    const taxAmount = taxableAmount * taxPercent / 100;
    const total = taxableAmount + taxAmount;
    const totalDiscount = preDiscountSubtotal - taxableAmount;

    const initialPayment = Number(initialPaymentInput.value) || 0;
    const balance = Math.max(total - initialPayment, 0);

    subtotalDisplay.textContent = `Rs. ${preDiscountSubtotal.toFixed(2)}`;
    discountDisplay.textContent = `Rs. ${totalDiscount.toFixed(2)}`;
    taxDisplay.textContent = `Rs. ${taxAmount.toFixed(2)} (${taxPercent}%)`;
    totalDisplay.textContent = `Rs. ${total.toFixed(2)}`;
    balanceDisplay.textContent = `Rs. ${balance.toFixed(2)}`;
}

discountPercentInput.addEventListener('input', recalculateTotals);
initialPaymentInput.addEventListener('input', recalculateTotals);

// ---- Build the shared payload ----
function buildPayload(isDraft) {
    return {
        customer_id: customerIdInput.value,
        items: cartItems.map(i => ({
            item_id: i.item_id, quantity: i.quantity, line_discount_percent: i.line_discount_percent
        })),
        service_lines: serviceLines.map(s => ({
            description: s.description, unit_price: s.unit_price, quantity: 1
        })),
        discount_percent: Number(discountPercentInput.value) || 0,
        draft: isDraft,
        initial_payment: isDraft ? undefined : {
            amount: Number(initialPaymentInput.value) || 0,
            method: document.getElementById('paymentMethod').value,
            tendered_amount: tenderedAmountInput.value || undefined
        }
    };
}

async function submitInvoice(isDraft) {
    submitError.textContent = '';

    if (!customerIdInput.value) {
        submitError.textContent = 'Please select or create a customer.';
        return;
    }
    if (cartItems.length === 0 && serviceLines.length === 0) {
        submitError.textContent = 'Please add at least one item or service charge.';
        return;
    }

    const btn = isDraft ? saveDraftBtn : submitBtn;
    const originalText = btn.textContent;
    submitBtn.disabled = true;
    saveDraftBtn.disabled = true;
    btn.textContent = isDraft ? 'Saving...' : 'Creating...';

    const res = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload(isDraft))
    });

    const data = await res.json();

    if (!res.ok) {
        submitError.textContent = data.error || 'Could not save invoice.';
        submitBtn.disabled = false;
        saveDraftBtn.disabled = false;
        btn.textContent = originalText;
        return;
    }

    const change = data.invoice.payments && data.invoice.payments[0] ? data.invoice.payments[0].change_given : null;
    if (change) {
        alert(`Invoice created. Change to give customer: Rs. ${Number(change).toFixed(2)}`);
    }

    window.location.href = `/invoice-detail.html?id=${data.invoice.id}`;
}

submitBtn.addEventListener('click', () => submitInvoice(false));
saveDraftBtn.addEventListener('click', () => submitInvoice(true));
