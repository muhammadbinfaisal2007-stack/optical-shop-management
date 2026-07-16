// public/js/settings.js
//
// Loads and saves the shop-wide settings: name/footer shown on
// invoices, the tax rate, and the idle-logout timeout.

const settingsForm = document.getElementById('settingsForm');
const settingsError = document.getElementById('settingsError');
const settingsSuccess = document.getElementById('settingsSuccess');

async function loadSettings() {
    const res = await fetch('/api/settings');
    if (!res.ok) {
        settingsError.textContent = "You don't have permission to view this page.";
        return;
    }
    const data = await res.json();
    settingsForm.shop_name.value = data.settings.shop_name;
    settingsForm.invoice_footer_text.value = data.settings.invoice_footer_text;
    settingsForm.tax_percent.value = data.settings.tax_percent;
    settingsForm.idle_timeout_minutes.value = data.settings.idle_timeout_minutes;
}

settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    settingsError.textContent = '';
    settingsSuccess.textContent = '';

    const payload = Object.fromEntries(new FormData(settingsForm).entries());

    const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
        settingsError.textContent = data.error || 'Could not save settings.';
        return;
    }

    settingsSuccess.textContent = 'Settings saved.';
});

loadSettings();
