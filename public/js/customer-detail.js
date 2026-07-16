// public/js/customer-detail.js
//
// Handles the single-customer profile page: shows customer info,
// prescription history, and lets you edit the profile or add a new
// prescription. Reads which customer to show from the URL, e.g.
// /customer-detail.html?id=5

const params = new URLSearchParams(window.location.search);
const customerId = params.get('id');

const profileView = document.getElementById('profileView');
const editForm = document.getElementById('editForm');
const editBtn = document.getElementById('editBtn');
const cancelEditBtn = document.getElementById('cancelEditBtn');
const editFormError = document.getElementById('editFormError');
const customerNameHeading = document.getElementById('customerName');

const prescriptionTableBody = document.getElementById('prescriptionTableBody');
const noPrescriptions = document.getElementById('noPrescriptions');

const showAddPrescriptionBtn = document.getElementById('showAddPrescriptionBtn');
const addPrescriptionWrapper = document.getElementById('addPrescriptionWrapper');
const addPrescriptionForm = document.getElementById('addPrescriptionForm');
const cancelAddPrescriptionBtn = document.getElementById('cancelAddPrescriptionBtn');
const addPrescriptionError = document.getElementById('addPrescriptionError');

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

// Formats OD/OS values like "-2.50 / -0.75 / 90", or "—" if nothing recorded.
function formatEye(sphere, cylinder, axis) {
    if (sphere == null && cylinder == null && axis == null) return '—';
    return `${sphere ?? '—'} / ${cylinder ?? '—'} / ${axis ?? '—'}`;
}

async function loadCustomer() {
    if (!customerId) {
        profileView.innerHTML = '<p class="error-msg">No customer specified.</p>';
        return;
    }

    const res = await fetch(`/api/customers/${customerId}`);
    if (!res.ok) {
        profileView.innerHTML = '<p class="error-msg">Customer not found.</p>';
        return;
    }

    const data = await res.json();
    renderProfile(data.customer);
    renderPrescriptions(data.prescriptions);
    prefillEditForm(data.customer);
}

function renderProfile(c) {
    customerNameHeading.textContent = `${c.full_name} (${c.customer_code})`;
    profileView.innerHTML = `
        <p><strong>Phone:</strong> ${escapeHtml(c.phone)}</p>
        <p><strong>Email:</strong> ${escapeHtml(c.email || '—')}</p>
        <p><strong>Date of Birth:</strong> ${escapeHtml(c.date_of_birth || '—')}</p>
        <p><strong>Address:</strong> ${escapeHtml(c.address || '—')}</p>
        <p><strong>Notes:</strong> ${escapeHtml(c.notes || '—')}</p>
    `;
}

function prefillEditForm(c) {
    editForm.full_name.value = c.full_name || '';
    editForm.phone.value = c.phone || '';
    editForm.email.value = c.email || '';
    editForm.date_of_birth.value = c.date_of_birth || '';
    editForm.address.value = c.address || '';
    editForm.notes.value = c.notes || '';
}

function renderPrescriptions(prescriptions) {
    prescriptionTableBody.innerHTML = '';

    if (prescriptions.length === 0) {
        noPrescriptions.classList.remove('hidden');
        return;
    }
    noPrescriptions.classList.add('hidden');

    prescriptions.forEach(p => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${escapeHtml(p.prescribed_date)}</td>
            <td>${formatEye(p.od_sphere, p.od_cylinder, p.od_axis)}</td>
            <td>${formatEye(p.os_sphere, p.os_cylinder, p.os_axis)}</td>
            <td>${p.pupillary_distance ?? '—'}</td>
            <td>${escapeHtml(p.prescribed_by_name || '—')}</td>
        `;
        prescriptionTableBody.appendChild(row);
    });
}

// ---- Edit profile ----
editBtn.addEventListener('click', () => {
    profileView.classList.add('hidden');
    editForm.classList.remove('hidden');
    editBtn.classList.add('hidden');
});

cancelEditBtn.addEventListener('click', () => {
    profileView.classList.remove('hidden');
    editForm.classList.add('hidden');
    editBtn.classList.remove('hidden');
    editFormError.textContent = '';
});

editForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    editFormError.textContent = '';

    const payload = Object.fromEntries(new FormData(editForm).entries());

    const res = await fetch(`/api/customers/${customerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
        editFormError.textContent = data.error || 'Could not save changes.';
        return;
    }

    renderProfile(data.customer);
    profileView.classList.remove('hidden');
    editForm.classList.add('hidden');
    editBtn.classList.remove('hidden');
});

// ---- Add prescription ----
showAddPrescriptionBtn.addEventListener('click', () => {
    addPrescriptionWrapper.classList.remove('hidden');
    addPrescriptionError.textContent = '';
});

cancelAddPrescriptionBtn.addEventListener('click', () => {
    addPrescriptionWrapper.classList.add('hidden');
    addPrescriptionForm.reset();
});

addPrescriptionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    addPrescriptionError.textContent = '';

    const payload = Object.fromEntries(new FormData(addPrescriptionForm).entries());

    const res = await fetch(`/api/customers/${customerId}/prescriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
        addPrescriptionError.textContent = data.error || 'Could not save prescription.';
        return;
    }

    addPrescriptionForm.reset();
    addPrescriptionWrapper.classList.add('hidden');
    loadCustomer(); // reload to show the new prescription in the history table
});

loadCustomer();
