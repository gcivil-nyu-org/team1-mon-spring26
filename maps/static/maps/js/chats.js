/**
 * Chats Application
 * Handles messaging, chat list, and group chat creation
 */

const ChatsApp = (() => {
    let currentUser = null;
    let currentChat = null;
    let allChats = [];
    let selectedAmenityId = null;
    let participantEmails = [];
    let amenitySearchTimer = null;

    // Initialize the app
    async function init() {
        // Check if user is authenticated
        const authResponse = await fetch('/api/auth/me/');
        const authData = await authResponse.json();

        if (!authData.is_authenticated) {
            showAuthModal();
            return;
        }

        currentUser = authData;

        // Update nav to show logged-in state
        const authBtn = document.getElementById('auth-button');
        const userMenu = document.getElementById('user-menu');
        const avatarImage = document.getElementById('avatar-image');
        const userMenuEmail = document.getElementById('user-menu-email');
        if (authBtn) authBtn.style.display = 'none';
        if (userMenu) userMenu.style.display = 'inline-flex';
        if (avatarImage) avatarImage.src = currentUser.avatar_url || '/static/maps/default-avatar.svg';
        if (userMenuEmail) userMenuEmail.textContent = currentUser.email || '';

        // Load initial chat list
        await loadChats();

        // Set up event listeners
        setupEventListeners();

        // If redirected here with a specific chat to open, open it
        const params = new URLSearchParams(window.location.search);
        const chatId = params.get('chat_id');
        if (chatId) {
            openChat(chatId);
        }

        // If redirected from map page to start a new group chat
        const newGroup = params.get('new_group');
        if (newGroup) {
            const amenityId = params.get('amenity_id');
            const amenityName = params.get('amenity_name');
            const participant = params.get('participant');
            openNewChatModal();
            switchModalTab('group-chat-tab');
            if (amenityName) {
                document.getElementById('group-chat-name').value = amenityName;
                document.getElementById('group-chat-amenity').value = amenityName;
                selectedAmenityId = amenityId;
                const info = document.getElementById('selected-amenity-info');
                if (info) {
                    info.textContent = `Linked: ${amenityName}`;
                    info.style.display = 'block';
                }
            }
            if (participant) {
                addParticipantTag(participant);
            }
        }
    }

    function setupEventListeners() {
        // New chat button
        document.getElementById('new-chat-btn')?.addEventListener('click', openNewChatModal);
        document.getElementById('new-chat-modal-close')?.addEventListener('click', closeNewChatModal);

        // Auth — avatar dropdown + logout
        const avatarButton = document.getElementById('avatar-button');
        const dropdown = document.getElementById('user-menu-dropdown');
        const logoutLink = document.getElementById('logout-link');
        avatarButton?.addEventListener('click', () => {
            if (dropdown) dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
        });
        logoutLink?.addEventListener('click', () => {
            if (dropdown) dropdown.style.display = 'none';
            handleLogout();
        });
        document.addEventListener('click', (e) => {
            if (dropdown && avatarButton && !dropdown.contains(e.target) && !avatarButton.contains(e.target)) {
                dropdown.style.display = 'none';
            }
        });

        // Modal tabs
        document.querySelectorAll('.modal-tab-link').forEach(tab => {
            tab.addEventListener('click', (e) => switchModalTab(e.target.dataset.tab));
        });

        // Create chat buttons
        document.getElementById('create-direct-chat-btn')?.addEventListener('click', createDirectChat);
        document.getElementById('create-group-chat-btn')?.addEventListener('click', createGroupChat);

        // Group chat amenity search
        document.getElementById('group-chat-amenity')?.addEventListener('input', onAmenityInput);
        document.getElementById('group-chat-amenity')?.addEventListener('blur', () => {
            // Delay so dropdown item clicks register first
            setTimeout(() => closeAmenityDropdown(), 150);
        });

        // Participant tag input
        document.getElementById('participant-email-input')?.addEventListener('keydown', onParticipantKeydown);
        document.getElementById('participant-tags-input')?.addEventListener('click', () => {
            document.getElementById('participant-email-input')?.focus();
        });

        // Listen for new messages from the SSE stream
        window.addEventListener('chat:new_message', () => {
            refreshActiveChat();
        });
    }

    async function loadChats() {
        try {
            const response = await fetch('/api/chats/');
            const data = await response.json();

            if (!response.ok) {
                console.error('Error loading chats:', data);
                return;
            }

            allChats = data.chats || [];
            displayChatsList(allChats);
        } catch (error) {
            console.error('Error loading chats:', error);
        }
    }

    function displayChatsList(chats) {
        const chatsList = document.getElementById('chats-list');
        
        if (chats.length === 0) {
            chatsList.innerHTML = `
                <div class="empty-chats">
                    <div class="empty-icon">💬</div>
                    <div class="empty-text">No chats yet</div>
                    <button class="btn-secondary" onclick="ChatsApp.openNewChatModal()">Start a conversation</button>
                </div>
            `;
            return;
        }

        chatsList.innerHTML = chats.map(chat => `
            <div class="chat-item" data-chat-id="${chat.id}">
                <div class="chat-item-header">
                    <div class="chat-item-name">${escapeHtml(chat.name)}</div>
                    <div class="chat-item-time">${formatTime(new Date(chat.last_message_at))}</div>
                </div>
                <div class="chat-item-preview">
                    ${chat.last_message ? `<strong>${escapeHtml(chat.last_message_sender)}:</strong> ${escapeHtml(chat.last_message)}` : 'No messages yet'}
                </div>
                ${chat.participant_count > 1 ? `<div class="chat-item-meta">${chat.participant_count} participants</div>` : ''}
            </div>
        `).join('');

        // Add click listeners
        document.querySelectorAll('.chat-item').forEach(item => {
            item.addEventListener('click', () => {
                const chatId = item.dataset.chatId;
                openChat(chatId);
            });
        });
    }

    async function openChat(chatId) {
        currentChat = allChats.find(c => c.id == chatId) || null;

        // If not in the cached list, fetch chat info from the messages API
        if (!currentChat) {
            const res = await fetch(`/api/chats/messages/?chat_id=${chatId}&page_size=1`);
            if (!res.ok) return;
            const info = await res.json();
            currentChat = {
                id: info.chat_id,
                name: info.chat_name,
                chat_type: info.chat_type,
                amenity_id: info.amenity_id,
                amenity_name: null,
                participant_count: null,
            };
        }

        // Clear the global "New" notification badge now that we are viewing a chat
        const chatsLink = document.querySelector('a[href^="/chats/"]');
        if (chatsLink) {
            chatsLink.href = '/chats/';
            const badge = chatsLink.querySelector('.chat-notification-badge');
            if (badge) badge.remove();
        }

        const chatMain = document.getElementById('chat-main');
        chatMain.innerHTML = `
            <div class="chat-header">
                <div class="chat-header-info">
                    <h2>${escapeHtml(currentChat.name)}</h2>
                    <div class="chat-header-meta">
                        ${currentChat.chat_type === 'amenity_forum' && currentChat.amenity_name ? `📍 ${escapeHtml(currentChat.amenity_name)}` : ''}
                        ${currentChat.participant_count ? `<span>${currentChat.participant_count} participants</span>` : ''}
                    </div>
                </div>
            </div>
            <div class="chat-messages" id="chat-messages">
                <div class="loading-spinner">Loading messages...</div>
            </div>
            <div class="chat-input-area">
                <textarea id="message-input" placeholder="Type a message..." rows="3"></textarea>
                <button id="send-btn" class="btn-primary">Send</button>
            </div>
        `;

        // Load messages
        await loadChatMessages(chatId);

        // Set up sending
        document.getElementById('send-btn').addEventListener('click', sendMessage);
        const msgInput = document.getElementById('message-input');
        msgInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
        msgInput.addEventListener('focus', clearNotificationIfCurrentChat);
        msgInput.addEventListener('input', clearNotificationIfCurrentChat);

        // Auto-focus the input area so the user can start typing immediately
        msgInput.focus();
    }

    function clearNotificationIfCurrentChat() {
        if (!currentChat) return;
        const chatsLink = document.querySelector('a[href^="/chats/"]');
        if (chatsLink) {
            const url = new URL(chatsLink.href, window.location.origin);
            const notifChatId = url.searchParams.get('chat_id');
            if (notifChatId == currentChat.id) {
                chatsLink.href = '/chats/';
                const badge = chatsLink.querySelector('.chat-notification-badge');
                if (badge) badge.remove();
            }
        }
    }

    async function loadChatMessages(chatId, page = 1) {
        try {
            const response = await fetch(`/api/chats/messages/?chat_id=${chatId}&page=${page}`);
            const data = await response.json();

            if (!response.ok) {
                console.error('Error loading messages:', data);
                return;
            }

            displayMessages(data.messages);
            scrollToBottom();
        } catch (error) {
            console.error('Error loading messages:', error);
        }
    }

    function displayMessages(messages) {
        const messagesContainer = document.getElementById('chat-messages');
        
        if (messages.length === 0) {
            messagesContainer.innerHTML = '<div class="empty-messages">No messages yet. Start the conversation!</div>';
            return;
        }

        messagesContainer.innerHTML = messages.map(msg => `
            <div class="message ${msg.sender_email === currentUser.email ? 'message-own' : 'message-other'}">
                <div class="message-header">
                    <strong>${escapeHtml(msg.sender_email)}</strong>
                    <span class="message-time">${formatTime(new Date(msg.created_at))}</span>
                </div>
                <div class="message-content">${escapeHtml(msg.content)}</div>
            </div>
        `).join('');
    }

    async function sendMessage() {
        const input = document.getElementById('message-input');
        const content = input.value.trim();

        if (!content || !currentChat) return;

        try {
            const response = await fetch('/api/chats/send/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': getCookie('csrftoken'),
                },
                body: JSON.stringify({
                    chat_id: currentChat.id,
                    content: content,
                }),
            });

            const data = await response.json();

            if (response.ok) {
                input.value = '';
                await loadChatMessages(currentChat.id);
                await loadChats();
            } else {
                alert('Error sending message: ' + (data.error || 'Unknown error'));
            }
        } catch (error) {
            console.error('Error sending message:', error);
            alert('Error sending message');
        }
    }

    function openNewChatModal() {
        document.getElementById('new-chat-modal').style.display = 'flex';
    }

    function closeNewChatModal() {
        document.getElementById('new-chat-modal').style.display = 'none';
        resetNewChatForm();
    }

    function resetNewChatForm() {
        document.getElementById('direct-recipient-email').value = '';
        document.getElementById('group-chat-name').value = '';
        document.getElementById('group-chat-amenity').value = '';
        document.getElementById('participant-email-input').value = '';
        document.getElementById('selected-amenity-info').style.display = 'none';
        document.getElementById('recent-reviewers').style.display = 'none';
        document.getElementById('direct-chat-error').style.display = 'none';
        document.getElementById('group-chat-error').style.display = 'none';
        selectedAmenityId = null;
        participantEmails = [];
        renderParticipantTags();
        closeAmenityDropdown();
    }

    function switchModalTab(tabName) {
        // Hide all tabs
        document.querySelectorAll('.modal-tab-content').forEach(tab => {
            tab.classList.remove('active');
        });
        document.querySelectorAll('.modal-tab-link').forEach(link => {
            link.classList.remove('active');
        });

        // Show selected tab
        document.getElementById(tabName)?.classList.add('active');
        document.querySelector(`[data-tab="${tabName}"]`)?.classList.add('active');
    }

    async function createDirectChat() {
        const email = document.getElementById('direct-recipient-email').value.trim();
        const errorEl = document.getElementById('direct-chat-error');

        if (!email) {
            showError(errorEl, 'Please enter a recipient email');
            return;
        }

        try {
            const response = await fetch('/api/chats/direct/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': getCookie('csrftoken'),
                },
                body: JSON.stringify({ recipient_email: email }),
            });

            const data = await response.json();

            if (response.ok) {
                closeNewChatModal();
                await loadChats();
                openChat(data.id);
            } else {
                showError(errorEl, data.error || 'Error creating chat');
            }
        } catch (error) {
            console.error('Error creating chat:', error);
            showError(errorEl, 'Error creating chat');
        }
    }

    async function createGroupChat() {
        const name = document.getElementById('group-chat-name').value.trim();
        const errorEl = document.getElementById('group-chat-error');

        // Flush any partially typed email in the input field
        const emailInput = document.getElementById('participant-email-input');
        if (emailInput && emailInput.value.trim()) {
            addParticipantTag(emailInput.value.trim());
            emailInput.value = '';
        }

        if (!name) {
            showError(errorEl, 'Please enter a chat name');
            return;
        }

        if (participantEmails.length < 2) {
            showError(errorEl, 'A group chat requires at least 2 participants. Please add more people.');
            return;
        }

        try {
            const response = await fetch('/api/chats/group/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': getCookie('csrftoken'),
                },
                body: JSON.stringify({
                    chat_name: name,
                    participant_emails: participantEmails,
                    amenity_id: selectedAmenityId || null,
                }),
            });

            const data = await response.json();

            if (response.ok) {
                closeNewChatModal();
                await loadChats();
                openChat(data.id);
            } else {
                showError(errorEl, data.error || 'Error creating chat');
            }
        } catch (error) {
            console.error('Error creating chat:', error);
            showError(errorEl, 'Error creating chat');
        }
    }

    function onAmenityInput(e) {
        const q = e.target.value.trim();
        // If user cleared the field, also clear the selection
        if (!q) {
            selectedAmenityId = null;
            closeAmenityDropdown();
            return;
        }
        // If they type after a selection, clear the stored id
        selectedAmenityId = null;
        clearTimeout(amenitySearchTimer);
        amenitySearchTimer = setTimeout(() => searchAmenities(q), 250);
    }

    async function searchAmenities(q) {
        if (q.length < 2) { closeAmenityDropdown(); return; }
        try {
            const res = await fetch(`/api/amenities/search/?q=${encodeURIComponent(q)}&limit=8`);
            const data = await res.json();
            renderAmenityDropdown(data.amenities || []);
        } catch {
            closeAmenityDropdown();
        }
    }

    function renderAmenityDropdown(amenities) {
        const dropdown = document.getElementById('amenity-dropdown');
        if (!dropdown) return;

        if (amenities.length === 0) {
            dropdown.innerHTML = '<div class="amenity-dropdown-empty">No amenities found</div>';
        } else {
            dropdown.innerHTML = amenities.map(a => `
                <div class="amenity-dropdown-item" data-id="${a.id}" data-name="${escapeHtml(a.name)}">
                    <div class="amenity-dd-name">${escapeHtml(a.name)}</div>
                    <div class="amenity-dd-meta">${escapeHtml(a.type)}${a.address ? ' · ' + escapeHtml(a.address) : ''}</div>
                </div>
            `).join('');

            dropdown.querySelectorAll('.amenity-dropdown-item').forEach(item => {
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault(); // prevent blur from firing before click
                    selectAmenityItem(item.dataset.id, item.dataset.name);
                });
            });
        }

        dropdown.classList.add('open');
    }

    function selectAmenityItem(id, name) {
        selectedAmenityId = id;
        const input = document.getElementById('group-chat-amenity');
        if (input) input.value = name;
        closeAmenityDropdown();
        const info = document.getElementById('selected-amenity-info');
        if (info) {
            info.textContent = `Linked: ${name}`;
            info.style.display = 'block';
        }
    }

    function closeAmenityDropdown() {
        const dropdown = document.getElementById('amenity-dropdown');
        if (dropdown) dropdown.classList.remove('open');
    }

    function onParticipantKeydown(e) {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const input = e.target;
            const email = input.value.replace(/,/g, '').trim();
            if (email) addParticipantTag(email);
            input.value = '';
        } else if (e.key === 'Backspace' && e.target.value === '' && participantEmails.length > 0) {
            removeParticipantTag(participantEmails[participantEmails.length - 1]);
        }
    }

    function addParticipantTag(email) {
        if (participantEmails.includes(email)) return;
        participantEmails.push(email);
        renderParticipantTags();
    }

    function removeParticipantTag(email) {
        participantEmails = participantEmails.filter(e => e !== email);
        renderParticipantTags();
    }

    function renderParticipantTags() {
        const container = document.getElementById('participant-tags');
        if (!container) return;
        container.innerHTML = participantEmails.map(email => `
            <span class="participant-tag">
                ${escapeHtml(email)}
                <button class="participant-tag-remove" data-email="${escapeHtml(email)}" title="Remove">×</button>
            </span>
        `).join('');
        container.querySelectorAll('.participant-tag-remove').forEach(btn => {
            btn.addEventListener('click', () => removeParticipantTag(btn.dataset.email));
        });
    }

    function showError(element, message) {
        element.textContent = message;
        element.style.display = 'block';
    }

    async function handleLogout() {
        try {
            await fetch('/api/auth/logout/', { method: 'POST' });
            window.location.href = '/';
        } catch (error) {
            console.error('Logout error:', error);
        }
    }

    function showAuthModal() {
        const modal = document.getElementById('auth-modal');
        modal.style.display = 'flex';

        document.getElementById('auth-modal-close')?.addEventListener('click', closeAuthModal);
        document.querySelectorAll('.auth-tab-link').forEach(link => {
            link.addEventListener('click', (e) => switchAuthTab(e.target.dataset.tab));
        });

        document.getElementById('login-form')?.addEventListener('submit', handleLogin);
        document.getElementById('register-form')?.addEventListener('submit', handleRegister);
    }

    function closeAuthModal() {
        document.getElementById('auth-modal').style.display = 'none';
    }

    function switchAuthTab(tabName) {
        document.querySelectorAll('.auth-tab-content').forEach(tab => tab.classList.remove('active'));
        document.querySelectorAll('.auth-tab-link').forEach(link => link.classList.remove('active'));
        document.getElementById(tabName)?.classList.add('active');
        document.querySelector(`[data-tab="${tabName}"]`)?.classList.add('active');
    }

    async function handleLogin(e) {
        e.preventDefault();
        const form = e.target;
        const email = form.querySelector('input[type="email"]').value;
        const password = form.querySelector('input[type="password"]').value;
        const errorEl = document.getElementById('login-error');

        try {
            const response = await fetch('/api/auth/login/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });

            const data = await response.json();

            if (response.ok) {
                location.reload();
            } else {
                showError(errorEl, data.error || 'Login failed');
            }
        } catch (error) {
            console.error('Login error:', error);
            showError(errorEl, 'Error logging in');
        }
    }

    async function handleRegister(e) {
        e.preventDefault();
        const form = e.target;
        const email = form.querySelector('input[type="email"]').value;
        const password = form.querySelector('input[type="password"]').value;
        const errorEl = document.getElementById('register-error');

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
                    body: JSON.stringify({ email, password }),
                });

                if (loginResponse.ok) {
                    location.reload();
                }
            } else {
                showError(errorEl, data.error || 'Registration failed');
            }
        } catch (error) {
            console.error('Register error:', error);
            showError(errorEl, 'Error registering');
        }
    }

    async function refreshActiveChat() {
        await loadChats();
        if (currentChat) {
            // Refresh current chat view to get latest messages
            await loadChatMessages(currentChat.id, 1);
            
            // If the user is already focused on the input for this chat, clear notification immediately
            const msgInput = document.getElementById('message-input');
            if (msgInput && document.activeElement === msgInput) {
                clearNotificationIfCurrentChat();
            }
        }
    }

    // Export public methods
    return {
        init,
        openNewChatModal,
        closeNewChatModal,
        openChat,
        loadChats,
        refreshActiveChat,
    };
})();

window.ChatsApp = ChatsApp;

// Utility functions
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

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

function formatTime(date) {
    const now = new Date();
    const diff = now - date;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    
    return date.toLocaleDateString();
}

function scrollToBottom() {
    const container = document.getElementById('chat-messages');
    if (container) {
        container.scrollTop = container.scrollHeight;
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    ChatsApp.init();
});
