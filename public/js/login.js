// public/js/login.js
//
// Handles the login form: sends username/password to the server,
// and either redirects to the dashboard (success) or shows an error.

const form = document.getElementById('loginForm');
const errorMsg = document.getElementById('errorMsg');

form.addEventListener('submit', async (event) => {
    // Stops the browser's default behavior of reloading the page on
    // form submit — we want to handle it ourselves with fetch() instead,
    // so we can show errors without a full page reload.
    event.preventDefault();
    errorMsg.textContent = '';

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (!response.ok) {
            errorMsg.textContent = data.error || 'Login failed. Please try again.';
            return;
        }

        // Success — go to the dashboard.
        window.location.href = '/index.html';

    } catch (err) {
        errorMsg.textContent = 'Could not reach the server. Is it running?';
    }
});
