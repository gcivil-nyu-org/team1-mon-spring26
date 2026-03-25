/**
 * Shared Authentication Module
 * Used by both map and chats pages
 */

function showAuthModal() {
    const modal = document.getElementById('auth-modal');
    if (!modal) return;
    
    modal.style.display = 'flex';

    document.getElementById('auth-modal-close')?.addEventListener('click', closeAuthModal);
    document.getElementById('auth-modal')?.addEventListener('click', e => {
        if (e.target.id === 'auth-modal') closeAuthModal();
    });

    document.querySelectorAll('.auth-tab-link').forEach(link => {
        link.removeEventListener('click', handleAuthTabClick);
        link.addEventListener('click', handleAuthTabClick);
    });

    setupAuthForms();
}

function handleAuthTabClick(e) {
    switchAuthTab(e.target.dataset.tab);
}

function closeAuthModal() {
    const modal = document.getElementById('auth-modal');
    if (modal) modal.style.display = 'none';
}

function switchAuthTab(tabName) {
    document.querySelectorAll('.auth-tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    document.querySelectorAll('.auth-tab-link').forEach(link => {
        link.classList.remove('active');
    });

    document.getElementById(tabName)?.classList.add('active');
    document.querySelector(`[data-tab="${tabName}"]`)?.classList.add('active');
}

function setupAuthForms() {
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');

    if (loginForm) {
        loginForm.removeEventListener('submit', handleLoginSubmit);
        loginForm.addEventListener('submit', handleLoginSubmit);
    }

    if (registerForm) {
        registerForm.removeEventListener('submit', handleRegisterSubmit);
        registerForm.addEventListener('submit', handleRegisterSubmit);
    }
}

async function handleLoginSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const email = form.querySelector('input[type="email"]').value.trim();
    const password = form.querySelector('input[type="password"]').value;
    const errorEl = document.getElementById('login-error');

    if (errorEl) errorEl.style.display = 'none';

    try {
        const response = await fetch('/api/auth/login/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ email, password }),
        });

        const data = await response.json();

        if (response.ok) {
            closeAuthModal();
            location.reload();
        } else {
            if (errorEl) {
                errorEl.textContent = data.error || 'Login failed';
                errorEl.style.display = 'block';
            }
        }
    } catch (error) {
        console.error('Login error:', error);
        if (errorEl) {
            errorEl.textContent = 'Error logging in';
            errorEl.style.display = 'block';
        }
    }
}

async function handleRegisterSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const email = form.querySelector('input[type="email"]').value.trim();
    const password = form.querySelector('input[type="password"]').value;
    const errorEl = document.getElementById('register-error');

    if (errorEl) errorEl.style.display = 'none';

    try {
        const response = await fetch('/api/auth/register/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });

        const data = await response.json();

        if (response.ok) {
            // Automatically log in
            const loginResponse = await fetch('/api/auth/login/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ email, password }),
            });

            if (loginResponse.ok) {
                closeAuthModal();
                location.reload();
            } else {
                if (errorEl) {
                    errorEl.textContent = 'Account created but login failed';
                    errorEl.style.display = 'block';
                }
            }
        } else {
            if (errorEl) {
                errorEl.textContent = data.error || 'Registration failed';
                errorEl.style.display = 'block';
            }
        }
    } catch (error) {
        console.error('Register error:', error);
        if (errorEl) {
            errorEl.textContent = 'Error registering';
            errorEl.style.display = 'block';
        }
    }
}

// Utility function to get CSRF token from cookies
function getCookie(name) {
    let cookieValue = null;
    if (document.cookie && document.cookie !== '') {
        const cookies = document.cookie.split(';');
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i].trim();
            if (cookie.substring(0, name.length + 1) === name + '=') {
                cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
                break;
            }
        }
    }
    return cookieValue;
}
