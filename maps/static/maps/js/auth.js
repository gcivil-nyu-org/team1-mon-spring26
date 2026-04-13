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

function ensureChatsLinkVisible() {
    console.log('[Auth] ensureChatsLinkVisible called');
    
    const topnavLinks = document.querySelector('.topnav-links');
    if (!topnavLinks) {
        console.error('[Auth] topnav-links not found');
        return;
    }
    
    // Check if chats link already exists
    let chatsLink = topnavLinks.querySelector('a[href="/chats/"]');
    if (chatsLink) {
        console.log('[Auth] Chats link already exists');
    } else {
        // Create and add the chats link
        chatsLink = document.createElement('a');
        chatsLink.className = 'topnav-link';
        chatsLink.href = '/chats/';
        chatsLink.textContent = 'Chats';
        
        // Find the Map link and insert after it
        const mapLink = topnavLinks.querySelector('a[href="/"]');
        if (mapLink) {
            mapLink.parentNode.insertBefore(chatsLink, mapLink.nextSibling);
            console.log('[Auth] Chats link inserted after Map link');
        } else {
            topnavLinks.appendChild(chatsLink);
            console.log('[Auth] Chats link appended to topnav-links');
        }
    }
    
    // Update auth UI: hide auth button, show user menu
    const authBtn = document.getElementById('auth-button');
    const userMenu = document.getElementById('user-menu');
    
    if (authBtn) {
        authBtn.style.display = 'none';
        console.log('[Auth] Auth button hidden');
    }
    if (userMenu) {
        userMenu.style.display = 'inline-flex';
        console.log('[Auth] User menu shown');
    }
}

function hideChatsLink() {
    const chatsLink = document.querySelector('.topnav-links a[href="/chats/"]');
    if (chatsLink) {
        chatsLink.remove();
        console.log('[Auth] Chats link removed');
    }
    
    // Update auth UI: show auth button, hide user menu
    const authBtn = document.getElementById('auth-button');
    const userMenu = document.getElementById('user-menu');
    if (authBtn) {
        authBtn.style.display = '';
        console.log('[Auth] Auth button shown');
    }
    if (userMenu) {
        userMenu.style.display = 'none';
        console.log('[Auth] User menu hidden');
    }
}

async function updateUserProfileInNav() {
    try {
        const response = await fetch('/api/auth/me/', {
            method: 'GET',
            credentials: 'same-origin',
        });
        
        const data = await response.json();
        
        if (data.is_authenticated) {
            const avatarImage = document.getElementById('avatar-image');
            const userMenuEmail = document.getElementById('user-menu-email');
            
            if (avatarImage) {
                avatarImage.src = data.avatar_url || '/static/maps/default-avatar.svg';
                console.log('[Auth] Avatar updated');
            }
            
            if (userMenuEmail) {
                userMenuEmail.textContent = data.email || '';
                console.log('[Auth] Email updated');
            }
        }
    } catch (error) {
        console.error('[Auth] Failed to fetch user profile:', error);
    }
}

async function checkPendingMessages() {
    try {
        console.log('[Auth] Checking for pending messages...');
        const response = await fetch('/api/chats/', {
            method: 'GET',
            credentials: 'same-origin',
        });
        
        const data = await response.json();
        console.log('[Auth] Chats response:', data);
        
        if (!data.chats || !Array.isArray(data.chats)) {
            console.log('[Auth] No chats found in response');
            return;
        }
        
        console.log('[Auth] Total chats:', data.chats.length);
        
        // Get current user to check who sent the last message
        const userResponse = await fetch('/api/auth/me/', {
            method: 'GET',
            credentials: 'same-origin',
        });
        const userData = await userResponse.json();
        const currentUserEmail = userData.email;
        console.log('[Auth] Current user email:', currentUserEmail);
        
        // Find chats with unread messages (last message from someone else)
        const pendingChats = data.chats.filter(chat => {
            console.log(`[Auth] Checking chat "${chat.name}" - last_message_sender: ${chat.last_message_sender}, last_message: ${chat.last_message}`);
            return chat.last_message_sender && 
                   chat.last_message_sender !== currentUserEmail;
        });
        
        console.log('[Auth] Pending chats:', pendingChats.length, pendingChats);
        
        if (pendingChats.length > 0) {
            const chatNames = pendingChats.map(c => c.name).join(', ');
            const pendingChatIds = pendingChats.map(c => c.id);
            
            // Store pending chat IDs in sessionStorage for chats page to use
            sessionStorage.setItem('pendingChatIds', JSON.stringify(pendingChatIds));
            
            // Show custom modal with "Open" button
            showPendingMessagesModal(pendingChats.length, chatNames);
        } else {
            console.log('[Auth] No pending messages found');
        }
    } catch (error) {
        console.error('[Auth] Failed to check pending messages:', error);
    }
}

function showPendingMessagesModal(count, names) {
    // Create modal
    const modal = document.createElement('div');
    modal.id = 'pending-messages-modal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999;
    `;
    
    const card = document.createElement('div');
    card.style.cssText = `
        background: white;
        border-radius: 12px;
        padding: 24px;
        max-width: 400px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
        text-align: center;
    `;
    
    const title = document.createElement('h3');
    title.textContent = '📬 New Chat Messages!';
    title.style.cssText = 'margin: 0 0 12px 0; font-size: 18px; color: #333;';
    
    const message = document.createElement('p');
    message.textContent = `You have ${count} chat${count !== 1 ? 's' : ''} with new messages: ${names}`;
    message.style.cssText = 'margin: 0 0 20px 0; color: #666; font-size: 14px;';
    
    const buttonContainer = document.createElement('div');
    buttonContainer.style.cssText = 'display: flex; gap: 10px;';
    
    const openBtn = document.createElement('button');
    openBtn.textContent = 'Open';
    openBtn.style.cssText = `
        flex: 1;
        padding: 10px 16px;
        background: #2563eb;
        color: white;
        border: none;
        border-radius: 6px;
        font-weight: 600;
        cursor: pointer;
        font-size: 14px;
    `;
    openBtn.onclick = () => {
        modal.remove();
        window.location.href = '/chats/';
    };
    
    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Later';
    dismissBtn.style.cssText = `
        flex: 1;
        padding: 10px 16px;
        background: #e5e7eb;
        color: #333;
        border: none;
        border-radius: 6px;
        font-weight: 600;
        cursor: pointer;
        font-size: 14px;
    `;
    dismissBtn.onclick = () => {
        modal.remove();
    };
    
    buttonContainer.appendChild(openBtn);
    buttonContainer.appendChild(dismissBtn);
    
    card.appendChild(title);
    card.appendChild(message);
    card.appendChild(buttonContainer);
    modal.appendChild(card);
    
    document.body.appendChild(modal);
    console.log('[Auth] Pending messages modal shown');
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

    console.log('[Auth] Login attempt for:', email);

    try {
        const response = await fetch('/api/auth/login/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ email, password }),
        });

        const data = await response.json();
        console.log('[Auth] Login response:', response.status, data);

        if (response.ok) {
            console.log('[Auth] Login successful, updating UI');
            closeAuthModal();
            ensureChatsLinkVisible();
            await updateUserProfileInNav();
            
            // Check for pending messages and alert user
            console.log('[Auth] About to call checkPendingMessages');
            try {
                await checkPendingMessages();
                console.log('[Auth] checkPendingMessages completed');
            } catch (err) {
                console.error('[Auth] checkPendingMessages error:', err);
            }
            
            // Update user state on map page if available
            if (typeof fetchCurrentUser === 'function') {
                console.log('[Auth] Calling fetchCurrentUser');
                fetchCurrentUser();
            } else {
                console.log('[Auth] fetchCurrentUser not available (not on map page)');
            }
            
            // Start SSE stream for new session
            if (window.initNotificationsSSE) {
                window.initNotificationsSSE();
            }
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
                ensureChatsLinkVisible();
                await updateUserProfileInNav();
                
                // Check for pending messages and alert user
                await checkPendingMessages();
                
                // Fetch and update user state on map page
                if (typeof fetchCurrentUser === 'function') {
                    fetchCurrentUser();
                }
                
                // Start SSE stream for new session
                if (window.initNotificationsSSE) {
                    window.initNotificationsSSE();
                }
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

// Listen for SSE reconnections to ensure no messages were missed while offline
window.addEventListener('chat:reconnected', () => {
    console.log('[Auth] Connection restored, checking pending messages');
    if (typeof checkPendingMessages === 'function') {
        checkPendingMessages();
    }
});
