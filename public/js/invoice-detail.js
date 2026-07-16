// public/js/invoice-detail.js
//
// Shows a single invoice's full details: line items, payment history,
// a link to download the PDF, and forms to record payments, finalize
// or discard a draft, and (Admin only) cancel/void a finalized invoice.

const params = new URLSearchParams(window.location.search);
const invoiceId = params.get('id');

const invoiceHeading = document.getElementById('invoiceHeading');
const invoiceSummary = document.getElementById('invoiceSummary');
const itemsBody = document.getElementById('itemsBody');
const paymentsBody = document.getElementById('paymentsBody');
const noPayments = document.getElementById('noPayments');
const pdfLink = document.getElementById('pdfLink');
const addPaymentSection = document.getElementById('addPaymentSection');
const addPaymentForm = document.getElementById('addPaymentForm');
const paymentError = document.getElementById('paymentError');

const draftControls = document.getElementById('draftControls');
const finalizeBtn = document.getElementById('finalizeBtn');
const discardDraftBtn = document.getElementById('discardDraftBtn');
const draftError = document.getElementById('draftError');
const finalizePaymentAmount = document.getElementById('finalizePaymentAmount');
const finalizePaymentMethod = document.getElementById('finalizePaymentMethod');

const cancelInvoiceBtn = document.getElementById('cancelInvoiceBtn');

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

const STATUS_LABELS = { draft: 'Draft', unpaid: 'Unpaid', partial: 'Partial', paid: 'Paid', cancelled: 'Cancelled' };

let currentUserRole = null;

async function loadInvoice() {
    const meRes = await fetch('/api/auth/me');
    if (meRes.ok) {
        const me = await meRes.json();
        currentUserRole = me.user.role;
    }

    const res = await fetch(`/api/invoices/${invoiceId}`);
    if (!res.ok) {
        invoiceHeading.textContent = 'Invoice not found';
        return;
    }
    const data = await res.json();
    render(data.invoice);
}

function render(inv) {
    invoiceHeading.textContent = `${inv.invoice_number} — ${STATUS_LABELS[inv.status] || inv.status}`;
    pdfLink.href = `/api/invoices/${inv.id}/pdf`;

    let summaryHtml = `
        <p><strong>Customer:</strong> ${escapeHtml(inv.customer_name)} (${escapeHtml(inv.customer_code)}) — ${escapeHtml(inv.customer_phone)}</p>
        <p><strong>Created By:</strong> ${escapeHtml(inv.created_by_name || '—')} on ${escapeHtml(inv.created_at)}</p>
        <p><strong>Subtotal:</strong> Rs. ${inv.subtotal.toFixed(2)} &nbsp; <strong>Discount:</strong> Rs. ${inv.discount_amount.toFixed(2)} &nbsp; <strong>Tax:</strong> Rs. ${inv.tax_amount.toFixed(2)}</p>
        <p style="font-size: 16px;"><strong>Total: Rs. ${inv.total_amount.toFixed(2)}</strong></p>
        <p><strong>Paid:</strong> Rs. ${inv.amount_paid.toFixed(2)} &nbsp;
           <strong class="${inv.balance_due > 0 ? 'low-stock' : ''}">Balance Due: Rs. ${inv.balance_due.toFixed(2)}</strong></p>
    `;
    if (inv.status === 'cancelled') {
        summaryHtml += `
            <p class="low-stock"><strong>Cancelled</strong> on ${escapeHtml(inv.cancelled_at)} by ${escapeHtml(inv.cancelled_by_name || '—')}</p>
            <p class="low-stock">Reason: ${escapeHtml(inv.cancellation_reason || '—')}</p>
        `;
    }
    invoiceSummary.innerHTML = summaryHtml;

    itemsBody.innerHTML = inv.items.map(item => `
        <tr>
            <td>${escapeHtml(item.description)}${item.is_service ? ' <em>(service)</em>' : ''}</td>
            <td>Rs. ${item.unit_price.toFixed(2)}</td>
            <td>${item.quantity}</td>
            <td>${item.line_discount_percent || 0}%</td>
            <td>Rs. ${item.line_total.toFixed(2)}</td>
        </tr>
    `).join('');

    if (inv.payments.length === 0) {
        noPayments.classList.remove('hidden');
    } else {
        noPayments.classList.add('hidden');
        paymentsBody.innerHTML = inv.payments.map(p => `
            <tr>
                <td>${escapeHtml(p.paid_at)}</td>
                <td>Rs. ${p.amount.toFixed(2)}</td>
                <td>${escapeHtml(p.method)}</td>
                <td>${p.change_given ? 'Rs. ' + Number(p.change_given).toFixed(2) : '—'}</td>
                <td>${escapeHtml(p.received_by_name || '—')}</td>
            </tr>
        `).join('');
    }

    // ---- Section visibility based on status ----
    const isDraft = inv.status === 'draft';
    const isCancelled = inv.status === 'cancelled';
    const isPaid = inv.status === 'paid';

    draftControls.classList.toggle('hidden', !isDraft);
    addPaymentSection.classList.toggle('hidden', isDraft || isCancelled || isPaid);

    // Cancel/Void: Admin only, and only for a finalized (non-draft,
    // non-already-cancelled) invoice.
    const canCancel = currentUserRole === 'admin' && !isDraft && !isCancelled;
    cancelInvoiceBtn.classList.toggle('hidden', !canCancel);
}

// ---- Add payment (existing behavior) ----
addPaymentForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    paymentError.textContent = '';

    const payload = Object.fromEntries(new FormData(addPaymentForm).entries());

    const res = await fetch(`/api/invoices/${invoiceId}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
        paymentError.textContent = data.error || 'Could not record payment.';
        return;
    }

    addPaymentForm.reset();
    render(data.invoice);

    const lastPayment = data.invoice.payments[data.invoice.payments.length - 1];
    if (lastPayment && lastPayment.change_given) {
        alert(`Payment recorded. Change to give customer: Rs. ${Number(lastPayment.change_given).toFixed(2)}`);
    }
});

// ---- Finalize draft ----
finalizeBtn.addEventListener('click', async () => {
    draftError.textContent = '';

    const payload = {};
    const amount = Number(finalizePaymentAmount.value) || 0;
    if (amount > 0) {
        payload.initial_payment = { amount, method: finalizePaymentMethod.value };
    }

    const res = await fetch(`/api/invoices/${invoiceId}/finalize`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
        draftError.textContent = data.error || 'Could not finalize invoice.';
        return;
    }

    render(data.invoice);
});

// ---- Discard draft ----
discardDraftBtn.addEventListener('click', async () => {
    const confirmed = confirm('Discard this draft invoice permanently? This cannot be undone.');
    if (!confirmed) return;

    const res = await fetch(`/api/invoices/${invoiceId}`, { method: 'DELETE' });
    const data = await res.json();

    if (!res.ok) {
        draftError.textContent = data.error || 'Could not discard draft.';
        return;
    }

    window.location.href = '/sales.html';
});

// ---- Cancel / void a finalized invoice (Admin only) ----
cancelInvoiceBtn.addEventListener('click', async () => {
    const reason = prompt('Please enter a reason for cancelling this invoice (required):');
    if (!reason || !reason.trim()) return;

    const confirmed = confirm(
        'This will void the invoice and restore any stock that was deducted. This cannot be undone. Continue?'
    );
    if (!confirmed) return;

    const res = await fetch(`/api/invoices/${invoiceId}/cancel`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() })
    });

    const data = await res.json();

    if (!res.ok) {
        alert(data.error || 'Could not cancel invoice.');
        return;
    }

    render(data.invoice);
});

loadInvoice();
