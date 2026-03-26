document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('settings-root');
    if (!root) return;

    const dropdown = document.getElementById('user-menu-dropdown');
    const dropdownToggle = document.getElementById('avatar-button');
    const logoutButton = document.getElementById('logout-link');

    const tabButtons = Array.from(document.querySelectorAll('.settings-nav-button'));
    const tabPanels = Array.from(document.querySelectorAll('.settings-panel'));

    const profileForm = document.getElementById('settings-profile-form');
    const avatarButton = document.getElementById('settings-avatar-button');
    const avatarInput = document.getElementById('settings-avatar-input');
    const avatarPreview = document.getElementById('settings-avatar-preview');
    const usernameInput = document.getElementById('settings-username-input');
    const bioInput = document.getElementById('settings-bio-input');
    const bioCount = document.getElementById('settings-bio-count');
    const usernameMessage = document.getElementById('settings-username-message');
    const profileSaveButton = document.getElementById('settings-profile-save');

    const accountForm = document.getElementById('settings-account-form');
    const currentPasswordInput = document.getElementById('settings-current-password-input');
    const newPasswordInput = document.getElementById('settings-new-password-input');
    const confirmPasswordInput = document.getElementById('settings-confirm-password-input');
    const accountMessage = document.getElementById('settings-account-message');
    const accountSaveButton = document.getElementById('settings-account-save');

    const topnavAvatar = document.getElementById('avatar-image');
    const topnavUserEmail = document.getElementById('user-menu-email');

    const initialProfileState = {
        username: usernameInput ? usernameInput.value.trim() : '',
        bio: bioInput ? bioInput.value.trim() : '',
    };

    let avatarDirty = false;
    let avatarObjectUrl = null;

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

    function setActiveTab(tabName, updateHistory = true) {
        let hasMatch = false;

        tabButtons.forEach(button => {
            const isActive = button.dataset.tab === tabName;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-selected', String(isActive));
            if (isActive) hasMatch = true;
        });

        tabPanels.forEach(panel => {
            panel.classList.toggle('is-active', panel.dataset.panel === tabName);
        });

        if (!hasMatch) return;

        if (updateHistory) {
            const url = new URL(window.location.href);
            url.searchParams.set('tab', tabName);
            window.history.replaceState({}, '', url);
        }
    }

    function setupTabs() {
        if (!tabButtons.length) return;

        tabButtons.forEach(button => {
            button.addEventListener('click', () => {
                setActiveTab(button.dataset.tab);
            });
        });

        const requestedTab = new URLSearchParams(window.location.search).get('tab');
        const initialTab = tabButtons.some(button => button.dataset.tab === requestedTab)
            ? requestedTab
            : 'profile';

        setActiveTab(initialTab, false);
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
        setUsernameMessage('');
    }

    function showUsernameError(message) {
        if (!usernameInput) return;

        usernameInput.classList.add('is-invalid');
        usernameInput.setAttribute('aria-invalid', 'true');
        setUsernameMessage(message, true);
    }

    function validateUsername({ focus = false, quiet = false } = {}) {
        if (!usernameInput) return true;

        const value = usernameInput.value.trim();
        if (!value) {
            if (!quiet) {
                showUsernameError('Please enter a username.');
                if (focus) usernameInput.focus();
            }
            return false;
        }

        if (!quiet && usernameInput.value !== value) {
            usernameInput.value = value;
        }

        if (!quiet) {
            clearUsernameError();
        }

        return true;
    }

    function getProfileDraftState() {
        return {
            username: usernameInput ? usernameInput.value.trim() : '',
            bio: bioInput ? bioInput.value.trim() : '',
        };
    }

    function updateBioCount() {
        if (!bioInput || !bioCount) return;

        const currentLength = bioInput.value.length;
        const maxLength = bioInput.maxLength > 0 ? bioInput.maxLength : '';
        bioCount.textContent = `${currentLength} / ${maxLength}`;
    }

    function syncProfileSaveState() {
        if (!profileSaveButton) return;

        const draftState = getProfileDraftState();
        const isDirty = avatarDirty
            || draftState.username !== initialProfileState.username
            || draftState.bio !== initialProfileState.bio;
        const usernameValid = validateUsername({ quiet: true });

        profileSaveButton.disabled = !isDirty || !usernameValid;
    }

    function setupAvatarPreview() {
        if (!avatarButton || !avatarInput || !avatarPreview) return;

        avatarButton.addEventListener('click', () => {
            avatarInput.click();
        });

        avatarInput.addEventListener('change', () => {
            const file = avatarInput.files && avatarInput.files[0];
            if (!file) {
                avatarDirty = false;
                syncProfileSaveState();
                return;
            }

            avatarDirty = true;

            if (avatarObjectUrl) {
                URL.revokeObjectURL(avatarObjectUrl);
            }

            avatarObjectUrl = URL.createObjectURL(file);
            avatarPreview.src = avatarObjectUrl;
            syncProfileSaveState();
        });
    }

    function setupProfileForm() {
        if (!profileForm || !usernameInput || !bioInput) return;

        usernameInput.setAttribute('aria-invalid', 'false');

        usernameInput.addEventListener('input', () => {
            if (usernameInput.classList.contains('is-invalid') || usernameInput.value.trim()) {
                validateUsername();
            }
            syncProfileSaveState();
        });

        usernameInput.addEventListener('blur', () => {
            validateUsername();
            syncProfileSaveState();
        });

        bioInput.addEventListener('input', () => {
            updateBioCount();
            syncProfileSaveState();
        });

        profileForm.addEventListener('submit', async event => {
            event.preventDefault();

            if (!validateUsername({ focus: true })) {
                syncProfileSaveState();
                return;
            }

            const formData = new FormData(profileForm);

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
                        usernameInput.focus();
                    } else {
                        showToast(errorMessage, 'error');
                    }
                    syncProfileSaveState();
                    return;
                }

                usernameInput.value = body.username || '';
                bioInput.value = body.bio || '';
                avatarDirty = false;
                avatarInput.value = '';

                if (body.avatar_url) {
                    avatarPreview.src = body.avatar_url;
                    if (topnavAvatar) topnavAvatar.src = body.avatar_url;
                }
                if (topnavUserEmail) {
                    topnavUserEmail.textContent = body.email || '';
                }

                initialProfileState.username = (body.username || '').trim();
                initialProfileState.bio = (body.bio || '').trim();
                clearUsernameError();
                syncProfileSaveState();
                showToast(body.message || 'Profile updated successfully.', 'success');
            } catch (error) {
                showToast('Network error while saving your profile.', 'error');
            }
        });

        syncProfileSaveState();
        updateBioCount();
    }

    function setAccountMessage(message, isError = false) {
        if (!accountMessage) return;

        accountMessage.textContent = message;
        accountMessage.classList.toggle('is-error', isError);
    }

    function syncAccountSaveState() {
        if (!accountSaveButton || !currentPasswordInput || !newPasswordInput || !confirmPasswordInput) return;

        const currentPassword = currentPasswordInput.value;
        const newPassword = newPasswordInput.value;
        const confirmPassword = confirmPasswordInput.value;
        const hasAllFields = Boolean(currentPassword && newPassword && confirmPassword);
        const passwordsMatch = newPassword === confirmPassword;
        const changedPassword = currentPassword !== newPassword;

        if (!currentPassword && !newPassword && !confirmPassword) {
            setAccountMessage('');
        } else if (confirmPassword && !passwordsMatch) {
            setAccountMessage('New password and confirmation must match.', true);
        } else if (hasAllFields && !changedPassword) {
            setAccountMessage('New password must be different from your current password.', true);
        } else {
            setAccountMessage('');
        }

        accountSaveButton.disabled = !hasAllFields || !passwordsMatch || !changedPassword;
    }

    function setupAccountForm() {
        if (!accountForm || !currentPasswordInput || !newPasswordInput || !confirmPasswordInput) return;

        [currentPasswordInput, newPasswordInput, confirmPasswordInput].forEach(input => {
            input.addEventListener('input', syncAccountSaveState);
        });

        accountForm.addEventListener('submit', async event => {
            event.preventDefault();
            syncAccountSaveState();
            if (accountSaveButton && accountSaveButton.disabled) return;

            const formData = new FormData(accountForm);

            try {
                const response = await fetch(root.dataset.passwordUpdateUrl, {
                    method: 'POST',
                    credentials: 'same-origin',
                    body: formData,
                });

                const body = await response.json().catch(() => ({}));
                if (!response.ok) {
                    setAccountMessage(body.error || 'Unable to update your password.', true);
                    showToast(body.error || 'Unable to update your password.', 'error');
                    syncAccountSaveState();
                    return;
                }

                accountForm.reset();
                setAccountMessage('');
                syncAccountSaveState();
                showToast(body.message || 'Password updated successfully.', 'success');
            } catch (error) {
                showToast('Network error while updating your password.', 'error');
            }
        });

        syncAccountSaveState();
    }

    setupDropdown();
    setupLogout();
    setupTabs();
    setupAvatarPreview();
    setupProfileForm();
    setupAccountForm();
});
