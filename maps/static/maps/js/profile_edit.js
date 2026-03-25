document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('profile-edit-root');
    if (!root) return;

    const form = document.getElementById('profile-edit-form');
    const avatarButton = document.getElementById('profile-edit-avatar-button');
    const avatarInput = document.getElementById('profile-edit-avatar-input');
    const avatarPreview = document.getElementById('profile-edit-avatar-preview');
    const usernameInput = document.getElementById('profile-username-input');
    const usernameMessage = document.getElementById('profile-username-message');

    const dropdown = document.getElementById('user-menu-dropdown');
    const dropdownToggle = document.getElementById('avatar-button');
    const logoutButton = document.getElementById('logout-link');
    const defaultUsernameMessage = '';

    function showToast(msg, type = 'info', duration = 2800) {
        const existing = document.getElementById('app-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'app-toast';
        toast.className = `app-toast is-${type}`;
        toast.textContent = msg;
        document.body.appendChild(toast);

        requestAnimationFrame(() => {
            toast.classList.add('is-visible');
        });

        setTimeout(() => {
            toast.classList.remove('is-visible');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    function setupDropdown() {
        if (!dropdown || !dropdownToggle) return;

        dropdownToggle.addEventListener('click', event => {
            event.stopPropagation();
            dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
        });

        document.addEventListener('click', event => {
            if (!dropdown.contains(event.target) && !dropdownToggle.contains(event.target)) {
                dropdown.style.display = 'none';
            }
        });
    }

    function setupLogout() {
        if (!logoutButton) return;

        logoutButton.addEventListener('click', async () => {
            try {
                await fetch(root.dataset.logoutUrl, {
                    method: 'POST',
                    credentials: 'same-origin',
                });
                window.location.href = '/';
            } catch (error) {
                showToast('Unable to log out right now.', 'error');
            }
        });
    }

    function setupAvatarPreview() {
        if (!avatarButton || !avatarInput || !avatarPreview) return;

        avatarButton.addEventListener('click', () => {
            avatarInput.click();
        });

        avatarInput.addEventListener('change', () => {
            const file = avatarInput.files && avatarInput.files[0];
            if (!file) return;

            // Show a local preview before the user saves.
            const objectUrl = URL.createObjectURL(file);
            avatarPreview.src = objectUrl;
        });
    }

    function setUsernameMessage(message, isError = false) {
        if (!usernameMessage) return;

        usernameMessage.textContent = message;
        usernameMessage.classList.toggle('is-error', isError);
    }

    function clearUsernameError() {
        if (!usernameInput) return;

        usernameInput.classList.remove('is-invalid');
        usernameInput.setAttribute('aria-invalid', 'false');
        setUsernameMessage(defaultUsernameMessage);
    }

    function showUsernameError(message) {
        if (!usernameInput) return;

        usernameInput.classList.add('is-invalid');
        usernameInput.setAttribute('aria-invalid', 'true');
        setUsernameMessage(message, true);
    }

    function validateUsername({ focus = false } = {}) {
        if (!usernameInput) return true;

        const value = usernameInput.value.trim();
        if (!value) {
            showUsernameError('Please enter a username.');
            if (focus) usernameInput.focus();
            return false;
        }

        if (usernameInput.value !== value) {
            usernameInput.value = value;
        }

        clearUsernameError();
        return true;
    }

    function setupUsernameValidation() {
        if (!usernameInput) return;

        usernameInput.setAttribute('aria-invalid', 'false');

        usernameInput.addEventListener('input', () => {
            if (usernameInput.classList.contains('is-invalid') || usernameInput.value.trim()) {
                validateUsername();
            }
        });

        usernameInput.addEventListener('blur', () => {
            validateUsername();
        });
    }

    async function handleSubmit(event) {
        event.preventDefault();
        if (!validateUsername({ focus: true })) return;

        const formData = new FormData(form);

        try {
            const response = await fetch(root.dataset.profileUpdateUrl, {
                method: 'POST',
                credentials: 'same-origin',
                body: formData,
            });

            const body = await response.json().catch(() => ({}));
            if (!response.ok) {
                const errorMessage = body.error || 'Unable to save your profile.';
                if (errorMessage.toLowerCase().includes('username')) {
                    showUsernameError(errorMessage);
                    if (usernameInput) usernameInput.focus();
                    return;
                }

                showToast(errorMessage, 'error');
                return;
            }

            // Store a toast message for the profile page after redirect.
            sessionStorage.setItem(
                'profileToast',
                JSON.stringify({
                    kind: 'success',
                    message: body.message || 'Profile updated successfully.',
                }),
            );

            window.location.href = root.dataset.profileUrl;
        } catch (error) {
            showToast('Network error while saving your profile.', 'error');
        }
    }

    setupDropdown();
    setupLogout();
    setupAvatarPreview();
    setupUsernameValidation();

    if (form) {
        form.addEventListener('submit', handleSubmit);
    }
});
