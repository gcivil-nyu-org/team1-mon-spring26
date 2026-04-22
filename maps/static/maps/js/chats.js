/**
 * Chats Application
 * Handles messaging, chat list, and group chat creation
 */

const ChatsApp = (() => {
    let currentUser = null;
    let currentChat = null;
    let allChats = [];
    let selectedAmenityId = null;
    let participantEmails = [];      // used by the create-group-chat modal
    let addParticipantEmails = [];   // used by the add-people panel inside an existing chat
    let amenitySearchTimer = null;
    let userSearchTimer = null;
    let activeUserSearchInput = null;
    let chatsAbortController = null;
    let messagesAbortController = null;
    let pendingChatIds = [];

    // Set up event listener EARLY to avoid race conditions on Mac/Safari
    // This must happen before any SSE events are dispatched
    window.addEventListener('chat:new_message', () => {
        console.log('[ChatsApp] New message event received');
        // Let refreshActiveChat fetch the messages so the backend read receipt is updated
        refreshActiveChat();
    }, { passive: true });

    // Handle reconnection by syncing the chat state
    window.addEventListener('chat:reconnected', () => {
        console.log('[ChatsApp] Connection restored, refreshing state');
        refreshActiveChat();
    });

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

        // User search autocomplete for both direct and group chats
        document.getElementById('direct-recipient-email')?.addEventListener('input', onUserSearchInput);
        document.getElementById('direct-recipient-email')?.addEventListener('keydown', (e) => {
            if (handleUserDropdownKeyboard(e)) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                createDirectChat();
            }
        });
        document.getElementById('direct-recipient-email')?.addEventListener('blur', () => setTimeout(closeUserDropdown, 150));
        document.getElementById('participant-email-input')?.addEventListener('input', onUserSearchInput);
        document.getElementById('participant-email-input')?.addEventListener('blur', () => setTimeout(closeUserDropdown, 150));

        // Close participants panel when clicking outside it — registered once here
        // so it doesn't accumulate on every openChat call.
        document.addEventListener('click', (e) => {
            const wrap = document.getElementById('participants-wrap');
            if (!wrap) return;
            const userDropdown = document.getElementById('user-dropdown');
            // If the click was inside the panel or inside the user-search dropdown, keep the panel open
            if (wrap.contains(e.target) || userDropdown?.contains(e.target)) return;
            const panel = document.getElementById('participants-panel');
            if (panel) panel.style.display = 'none';
            addParticipantEmails = [];
        }, { capture: true });
    }

    async function loadChats() {
        // Abort previous in-flight requests to prevent older slow requests from overwriting newer ones
        if (chatsAbortController) chatsAbortController.abort();
        chatsAbortController = new AbortController();

        try {
            // Append cache-buster so browsers don't silently return stale history
            const response = await fetch(`/api/chats/?t=${Date.now()}`, { signal: chatsAbortController.signal });
            const data = await response.json();

            if (!response.ok) {
                console.error('Error loading chats:', data);
                return;
            }

            allChats = data.chats || [];
            displayChatsList(allChats);
        } catch (error) {
            if (error.name === 'AbortError') return;
            console.error('Error loading chats:', error);
        }
    }

    function displayChatsList(chats) {
        const chatsList = document.getElementById('chats-list');
        
        // Merge pending chat IDs from sessionStorage into memory
        try {
            const pending = sessionStorage.getItem('pendingChatIds');
            if (pending) {
                const parsed = JSON.parse(pending);
                parsed.forEach(id => {
                    if (!pendingChatIds.includes(id)) pendingChatIds.push(id);
                });
                sessionStorage.removeItem('pendingChatIds');
            }
        } catch (e) {
            console.error('[ChatsApp] Error reading pending chats:', e);
        }
        
        if (currentChat) {
            pendingChatIds = pendingChatIds.filter(id => id != currentChat.id);
        }
        
        // Filter out hidden chats
        let hiddenChats = {};
        try {
            hiddenChats = JSON.parse(localStorage.getItem('hiddenChats') || '{}');
        } catch (e) {}

        let hiddenChatsUpdated = false;
        const visibleChats = [];
        const hiddenChatsList = [];

        chats.forEach(chat => {
            if (hiddenChats[chat.id]) {
                if (hiddenChats[chat.id] === chat.last_message_at) {
                    hiddenChatsList.push(chat); // Still hidden
                } else {
                    // New message arrived, unhide it!
                    delete hiddenChats[chat.id];
                    hiddenChatsUpdated = true;
                    visibleChats.push(chat);
                }
            } else {
                visibleChats.push(chat);
            }
        });

        if (hiddenChatsUpdated) {
            localStorage.setItem('hiddenChats', JSON.stringify(hiddenChats));
        }
        
        if (visibleChats.length === 0 && hiddenChatsList.length === 0) {
            chatsList.innerHTML = `
                <div class="empty-chats">
                    <div class="empty-icon">💬</div>
                    <div class="empty-text">No chats yet</div>
                    <button class="btn-secondary" onclick="ChatsApp.openNewChatModal()">Start a conversation</button>
                </div>
            `;
            return;
        }

        let html = '';
        
        if (visibleChats.length === 0) {
            html += `
                <div class="empty-chats" style="padding-bottom: 16px;">
                    <div class="empty-icon">🙈</div>
                    <div class="empty-text">All active chats are hidden</div>
                </div>
            `;
        } else {
            html += visibleChats.map(chat => {
                const isPending = pendingChatIds.includes(chat.id) || chat.is_unread;
                const pendingBadge = isPending ? '<span class="chat-pending-badge">New</span>' : '';
                const pendingClass = isPending ? ' chat-item-pending' : '';
                
                return `
                    <div class="chat-item${pendingClass}" data-chat-id="${chat.id}" style="display: flex; gap: 12px; align-items: center;">
                        <div class="chat-item-avatar-wrapper" style="flex-shrink: 0;">
                            <img src="${chat.avatar_url || '/static/maps/default-avatar.svg'}" style="width: 44px; height: 44px; border-radius: 50%; object-fit: cover; background: var(--surface, #fff);" alt="Avatar" onerror="this.src='/static/maps/default-avatar.svg'">
                        </div>
                        <div class="chat-item-content" style="flex-grow: 1; min-width: 0;">
                            <div class="chat-item-header">
                                <div class="chat-item-name">${escapeHtml(chat.name)} ${pendingBadge}</div>
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    <div class="chat-item-time">${formatTime(new Date(chat.last_message_at))}</div>
                                    <button class="chat-item-hide-btn" data-chat-id="${chat.id}" data-last-msg="${chat.last_message_at}" title="Hide chat" style="background: none; border: none; color: var(--text-3, #999); cursor: pointer; padding: 0 4px; font-size: 16px; line-height: 1; border-radius: 4px;">&times;</button>
                                </div>
                            </div>
                            <div class="chat-item-preview">
                                ${chat.last_message ? `<strong>${escapeHtml(chat.last_message_sender)}:</strong> ${escapeHtml(chat.last_message)}` : 'No messages yet'}
                            </div>
                            ${chat.chat_type !== 'direct' && chat.participant_count > 1 ? `<div class="chat-item-meta">${chat.participant_count} participants</div>` : ''}
                        </div>
                    </div>
                `;
            }).join('');
        }

        if (hiddenChatsList.length > 0) {
            html += `
                <details class="hidden-chats-section" style="margin-top: 16px; border-top: 1px solid var(--border, #e8e8e5); padding-top: 12px;">
                    <summary style="cursor: pointer; font-size: 13px; color: var(--text-3, #999); user-select: none; padding: 4px 8px; border-radius: 4px; font-weight: 500;">
                        Hidden Chats (${hiddenChatsList.length})
                    </summary>
                    <div class="hidden-chats-list" style="margin-top: 8px;">
                        ${hiddenChatsList.map(chat => `
                            <div class="chat-item hidden-chat-item" data-chat-id="${chat.id}" style="display: flex; gap: 12px; align-items: center; opacity: 0.65; cursor: default;">
                                <div class="chat-item-avatar-wrapper" style="flex-shrink: 0;">
                                    <img src="${chat.avatar_url || '/static/maps/default-avatar.svg'}" style="width: 44px; height: 44px; border-radius: 50%; object-fit: cover; background: var(--surface, #fff);" alt="Avatar" onerror="this.src='/static/maps/default-avatar.svg'">
                                </div>
                                <div class="chat-item-content" style="flex-grow: 1; min-width: 0;">
                                    <div class="chat-item-header">
                                        <div class="chat-item-name" style="color: var(--text-1, #111);">${escapeHtml(chat.name)}</div>
                                        <div style="display: flex; align-items: center; gap: 12px;">
                                            <button class="chat-item-unhide-btn" data-chat-id="${chat.id}" title="Unhide chat" style="background: none; border: none; color: var(--accent, #1a6ef5); cursor: pointer; padding: 4px; font-size: 14px; display: flex; align-items: center; gap: 4px; border-radius: 4px;">
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                            </button>
                                            <button class="chat-item-delete-btn" data-chat-id="${chat.id}" title="Leave / Delete chat" style="background: none; border: none; color: var(--red, #dc2626); cursor: pointer; padding: 4px; font-size: 14px; display: flex; align-items: center; gap: 4px; border-radius: 4px;">
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                                            </button>
                                        </div>
                                    </div>
                                    <div class="chat-item-preview">
                                        ${chat.last_message ? `<strong>${escapeHtml(chat.last_message_sender)}:</strong> ${escapeHtml(chat.last_message)}` : 'No messages yet'}
                                    </div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </details>
            `;
        }

        chatsList.innerHTML = html;

        // Add click listeners (exclude hidden chats)
        document.querySelectorAll('.chat-item:not(.hidden-chat-item)').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.chat-item-hide-btn')) return;

                const chatId = item.dataset.chatId;
                
                // Remove the "New" badge and pending styling when clicking
                const badge = item.querySelector('.chat-pending-badge');
                if (badge) {
                    badge.remove();
                    console.log('[ChatsApp] Removed pending badge from chat:', chatId);
                }
                item.classList.remove('chat-item-pending');
                
                pendingChatIds = pendingChatIds.filter(id => id != chatId);
                
                openChat(chatId);
            });
        });

        // Add hide button listeners
        document.querySelectorAll('.chat-item-hide-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Don't trigger the chat open logic
                const chatId = btn.dataset.chatId;
                const lastMsg = btn.dataset.lastMsg;
                
                let hidden = {};
                try {
                    hidden = JSON.parse(localStorage.getItem('hiddenChats') || '{}');
                } catch (err) {}
                
                hidden[chatId] = lastMsg;
                localStorage.setItem('hiddenChats', JSON.stringify(hidden));
                
                displayChatsList(chats); // Re-render immediately
            });
            
            btn.addEventListener('mouseenter', () => btn.style.color = 'var(--text-1, #111)');
            btn.addEventListener('mouseleave', () => btn.style.color = 'var(--text-3, #999)');
        });

        // Add unhide button listeners
        document.querySelectorAll('.chat-item-unhide-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const chatId = btn.dataset.chatId;
                
                let hidden = {};
                try { hidden = JSON.parse(localStorage.getItem('hiddenChats') || '{}'); } catch(err) {}
                delete hidden[chatId];
                localStorage.setItem('hiddenChats', JSON.stringify(hidden));
                
                displayChatsList(chats); // Re-render immediately
            });
            btn.addEventListener('mouseenter', () => btn.style.background = 'var(--accent-lt, #e8f0fe)');
            btn.addEventListener('mouseleave', () => btn.style.background = 'none');
        });

        // Add delete button listeners
        document.querySelectorAll('.chat-item-delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm("Are you sure you want to permanently leave and delete this chat?")) return;
                
                const chatId = btn.dataset.chatId;
                try {
                    const res = await fetch('/api/chats/leave/', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRFToken': getCookie('csrftoken'),
                        },
                        body: JSON.stringify({ chat_id: chatId })
                    });
                    
                    if (res.ok) {
                        let hidden = {};
                        try { hidden = JSON.parse(localStorage.getItem('hiddenChats') || '{}'); } catch(err){}
                        delete hidden[chatId];
                        localStorage.setItem('hiddenChats', JSON.stringify(hidden));
                        
                        // If it was currently open, clear it
                        if (currentChat && currentChat.id == chatId) {
                            const chatMain = document.getElementById('chat-main');
                            if (chatMain) chatMain.innerHTML = '<div class="empty-messages">Select a chat to start messaging</div>';
                            currentChat = null;
                        }
                        
                        loadChats(); // reload the whole list from server
                    } else {
                        const data = await res.json();
                        alert('Failed to delete chat: ' + (data.error || 'Unknown error'));
                    }
                } catch(error) {
                    console.error('Error deleting chat:', error);
                    alert('Error deleting chat');
                }
            });
            btn.addEventListener('mouseenter', () => btn.style.background = 'var(--red-lt, #fee2e2)');
            btn.addEventListener('mouseleave', () => btn.style.background = 'none');
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
        
        // Remove from pending lists safely
        pendingChatIds = pendingChatIds.filter(id => id != chatId);
        const chatItem = document.querySelector(`.chat-item[data-chat-id="${chatId}"]`);
        if (chatItem) {
            const pendingBadge = chatItem.querySelector('.chat-pending-badge');
            if (pendingBadge) pendingBadge.remove();
            chatItem.classList.remove('chat-item-pending');
        }

        // Clear the global "New" notification badge now that we are viewing a chat
        const chatsLink = document.querySelector('a[href^="/chats/"]');
        if (chatsLink) {
            chatsLink.href = '/chats/';
            const badge = chatsLink.querySelector('.chat-notification-badge');
            if (badge) badge.remove();
        }

        const chatMain = document.getElementById('chat-main');

        const isDirect = currentChat.chat_type === 'direct';
        const profileIconHtml = isDirect && currentChat.other_user_email
            ? `<a href="/profile/?user=${encodeURIComponent(currentChat.other_user_email)}" class="chat-header-profile-link" title="View profile">
                   <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
               </a>`
            : '';

        const participantsBtnHtml = !isDirect
            ? `<div class="chat-header-actions">
                   <div class="chat-participants-wrap" id="participants-wrap">
                       <button class="chat-participants-btn" id="participants-btn">
                           <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                           ${currentChat.participant_count}
                       </button>
                       <div class="chat-participants-panel" id="participants-panel" style="display:none;">
                           <div class="chat-participants-panel-title">Participants</div>
                           <div class="chat-participants-list" id="participants-list">
                               <div style="padding:8px 14px;font-size:13px;color:var(--text-3)">Loading...</div>
                           </div>
                       </div>
                   </div>
                   <button class="chat-leave-btn" id="leave-chat-btn" title="Leave chat">Leave</button>
               </div>`
            : '';

        chatMain.innerHTML = `
            <div class="chat-header">
                <div class="chat-header-info">
                    <h2>${escapeHtml(currentChat.name)}${profileIconHtml}</h2>
                    <div class="chat-header-meta">
                        ${currentChat.chat_type === 'amenity_forum' && currentChat.amenity_name ? `📍 ${escapeHtml(currentChat.amenity_name)}` : ''}
                    </div>
                </div>
                ${participantsBtnHtml}
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

        // Participants dropdown for group/forum chats
        const participantsBtn = document.getElementById('participants-btn');
        if (participantsBtn) {
            participantsBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const panel = document.getElementById('participants-panel');
                const list = document.getElementById('participants-list');
                const isOpen = panel.style.display !== 'none';
                if (isOpen) {
                    panel.style.display = 'none';
                    addParticipantEmails = [];
                    return;
                }
                addParticipantEmails = [];
                panel.style.display = 'block';
                list.innerHTML = '<div style="padding:8px 14px;font-size:13px;color:var(--text-3)">Loading...</div>';
                try {
                    const res = await fetch(`/api/chats/participants/?chat_id=${currentChat.id}`, { credentials: 'same-origin' });
                    const data = await res.json();
                    if (data.participants && data.participants.length) {
                        list.innerHTML = data.participants.map(p => `
                            <a class="chat-participant-item" href="/profile/?user=${encodeURIComponent(p.email)}">
                                <img class="chat-participant-avatar" src="${escapeHtml(p.avatar_url || '/static/maps/default-avatar.svg')}" alt="" onerror="this.src='/static/maps/default-avatar.svg'">
                                <span>${escapeHtml(p.username)}</span>
                            </a>
                        `).join('');
                    } else {
                        list.innerHTML = '<div style="padding:8px 14px;font-size:13px;color:var(--text-3)">No participants found.</div>';
                    }

                    // Append add-participants form below the list (remove any stale copy first)
                    document.getElementById('add-participants-section')?.remove();
                    const addSection = document.createElement('div');
                    addSection.id = 'add-participants-section';
                    addSection.style.cssText = 'border-top:1px solid var(--border);padding:10px 14px 12px;';
                    addSection.innerHTML = `
                        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-3);margin-bottom:8px;">Add People</div>
                        <div class="participant-tags-input" id="add-participant-tags-input" style="cursor:text;min-height:36px;">
                            <div class="participant-tags" id="add-participant-tags"></div>
                            <input
                                type="text"
                                id="add-participant-input"
                                placeholder="Email or username…"
                                autocomplete="off"
                                style="border:none;outline:none;background:transparent;font-size:13px;flex:1;min-width:80px;padding:2px 4px;"
                            >
                        </div>
                        <p id="add-participant-error" style="display:none;font-size:12px;color:var(--danger,#e53e3e);margin:6px 0 0;"></p>
                        <button id="add-participant-submit" class="btn-primary" style="margin-top:10px;width:100%;padding:8px 16px;font-size:13px;" disabled>Add to chat</button>
                    `;
                    panel.appendChild(addSection);

                    // Focus the input and wire up events
                    const addInput = document.getElementById('add-participant-input');
                    const addTagsWrap = document.getElementById('add-participant-tags-input');
                    const submitBtn = document.getElementById('add-participant-submit');

                    addTagsWrap.addEventListener('click', () => addInput.focus());

                    addInput.addEventListener('input', (ev) => {
                        activeUserSearchInput = ev.target;
                        const panelErr = document.getElementById('add-participant-error');
                        if (panelErr) panelErr.style.display = 'none';
                        const q = ev.target.value.trim();
                        if (q.length >= 2) {
                            clearTimeout(userSearchTimer);
                            userSearchTimer = setTimeout(() => searchUsers(q), 250);
                        } else {
                            closeUserDropdown();
                        }
                    });

                    addInput.addEventListener('keydown', async (ev) => {
                        if (handleUserDropdownKeyboard(ev)) return;
                        if (ev.key === 'Enter' || ev.key === ',') {
                            ev.preventDefault();
                            const val = addInput.value.replace(/,/g, '').trim();
                            if (!val) return;
                            const panelErrorEl = document.getElementById('add-participant-error');
                            if (panelErrorEl) panelErrorEl.style.display = 'none';
                            const panelMatch = await validateUserExists(val);
                            if (panelMatch) {
                                addPanelParticipantTag(panelMatch.email);
                                addInput.value = '';
                            } else {
                                if (panelErrorEl) {
                                    panelErrorEl.textContent = `"${val}" does not exist`;
                                    panelErrorEl.style.display = 'block';
                                }
                            }
                        } else if (ev.key === 'Backspace' && addInput.value === '' && addParticipantEmails.length > 0) {
                            removePanelParticipantTag(addParticipantEmails[addParticipantEmails.length - 1]);
                        }
                    });

                    addInput.addEventListener('blur', () => setTimeout(closeUserDropdown, 150));

                    submitBtn.addEventListener('click', submitAddParticipants);

                } catch {
                    list.innerHTML = '<div style="padding:8px 14px;font-size:13px;color:var(--text-3)">Failed to load.</div>';
                }
            });
        }

        // Leave chat button for group/forum chats
        const leaveChatBtn = document.getElementById('leave-chat-btn');
        if (leaveChatBtn) {
            leaveChatBtn.addEventListener('click', async () => {
                if (!confirm(`Leave "${currentChat.name}"? You won't be able to see new messages unless re-added.`)) return;

                try {
                    const res = await fetch('/api/chats/leave/', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRFToken': getCookie('csrftoken'),
                        },
                        body: JSON.stringify({ chat_id: currentChat.id }),
                    });

                    if (res.ok) {
                        // Clear hidden-chats entry so it doesn't linger
                        try {
                            const hidden = JSON.parse(localStorage.getItem('hiddenChats') || '{}');
                            delete hidden[currentChat.id];
                            localStorage.setItem('hiddenChats', JSON.stringify(hidden));
                        } catch {}

                        currentChat = null;
                        document.getElementById('chat-main').innerHTML = `
                            <div class="chat-empty">
                                <div class="empty-icon">💬</div>
                                <div class="empty-title">Select a chat to start messaging</div>
                                <div class="empty-subtitle">or start a new conversation</div>
                            </div>
                        `;
                        await loadChats();
                    } else {
                        const data = await res.json();
                        alert('Failed to leave chat: ' + (data.error || 'Unknown error'));
                    }
                } catch {
                    alert('Error leaving chat. Please try again.');
                }
            });
        }
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
        // Abort previous in-flight requests so old messages don't wipe out the newest data
        if (messagesAbortController) messagesAbortController.abort();
        messagesAbortController = new AbortController();

        try {
            // Append cache-buster so browsers don't silently return stale history
            const response = await fetch(`/api/chats/messages/?chat_id=${chatId}&page=${page}&t=${Date.now()}`, { signal: messagesAbortController.signal });
            const data = await response.json();

            if (!response.ok) {
                console.error('Error loading messages:', data);
                return;
            }

            displayMessages(data.messages);
            scrollToBottom();
        } catch (error) {
            if (error.name === 'AbortError') return;
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

        // Clear input immediately to prevent double-sends and allow rapid typing
        input.value = '';
        input.focus();

        // Abort any in-flight message loads so they don't wipe out our local append!
        if (messagesAbortController) messagesAbortController.abort();

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
                // Append the message locally instead of reloading the entire thread
                // to avoid async race conditions that overwrite the screen!
                const messagesContainer = document.getElementById('chat-messages');
                const emptyState = messagesContainer?.querySelector('.empty-messages');
                if (emptyState) emptyState.remove();
                
                const msgHtml = `
                    <div class="message message-own">
                        <div class="message-header">
                            <strong>${escapeHtml(data.sender_email)}</strong>
                            <span class="message-time">${formatTime(new Date(data.created_at))}</span>
                        </div>
                        <div class="message-content">${escapeHtml(data.content)}</div>
                    </div>
                `;
                messagesContainer?.insertAdjacentHTML('beforeend', msgHtml);
                scrollToBottom();
                
                // Silently update the chat list
                loadChats();
            } else {
                input.value = content; // restore on failure
                alert('Error sending message: ' + (data.error || 'Unknown error'));
            }
        } catch (error) {
            console.error('Error sending message:', error);
            input.value = content; // restore on failure
            alert('Error sending message');
        }
    }

    function openNewChatModal() {
        document.getElementById('new-chat-modal').style.display = 'flex';
        
        setTimeout(() => {
            const activeTab = document.querySelector('.modal-tab-content.active');
            if (activeTab && activeTab.id === 'group-chat-tab') {
                document.getElementById('group-chat-name')?.focus();
            } else {
                document.getElementById('direct-recipient-email')?.focus();
            }
        }, 50);
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
        document.getElementById('participant-email-error').style.display = 'none';
        selectedAmenityId = null;
        participantEmails = [];
        renderParticipantTags();
        closeAmenityDropdown();
        closeUserDropdown();
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

        // Auto-focus appropriate input on tab change
        setTimeout(() => {
            if (tabName === 'group-chat-tab') {
                document.getElementById('group-chat-name')?.focus();
            } else {
                document.getElementById('direct-recipient-email')?.focus();
            }
        }, 50);
    }

    async function createDirectChat() {
        const email = document.getElementById('direct-recipient-email').value.trim();
        const errorEl = document.getElementById('direct-chat-error');

        if (!email) {
            showError(errorEl, 'Please enter a recipient email');
            return;
        }

        const match = await validateUserExists(email);
        if (!match) {
            showError(errorEl, `"${email}" does not exist`);
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
            const partialVal = emailInput.value.trim();
            const participantErrorEl = document.getElementById('participant-email-error');
            if (participantErrorEl) participantErrorEl.style.display = 'none';
            const partialMatch = await validateUserExists(partialVal);
            if (partialMatch) {
                addParticipantTag(partialMatch.email);
                emailInput.value = '';
            } else {
                if (participantErrorEl) {
                    participantErrorEl.textContent = `"${partialVal}" does not exist`;
                    participantErrorEl.style.display = 'block';
                }
                return;
            }
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

    function onUserSearchInput(e) {
        const q = e.target.value.trim();
        activeUserSearchInput = e.target;

        // Clear inline validation errors while the user is typing
        if (e.target.id === 'participant-email-input') {
            const errEl = document.getElementById('participant-email-error');
            if (errEl) errEl.style.display = 'none';
        } else if (e.target.id === 'direct-recipient-email') {
            const errEl = document.getElementById('direct-chat-error');
            if (errEl) errEl.style.display = 'none';
        }

        if (q.length < 2) {
            closeUserDropdown();
            return;
        }

        clearTimeout(userSearchTimer);
        userSearchTimer = setTimeout(() => searchUsers(q), 250);
    }

    async function searchUsers(q) {
        try {
            const res = await fetch(`/api/users/search/?q=${encodeURIComponent(q)}&limit=6`);
            const data = await res.json();
            renderUserDropdown(data.users || []);
        } catch {
            closeUserDropdown();
        }
    }

    function renderUserDropdown(users) {
        let dropdown = document.getElementById('user-dropdown');

        const isAddPanel = activeUserSearchInput?.id === 'add-participant-input';
        const desiredParent = isAddPanel
            ? (document.getElementById('participants-wrap') || document.body)
            : document.body;
        const desiredPosition = isAddPanel ? 'fixed' : 'absolute';

        if (!dropdown) {
            dropdown = document.createElement('div');
            dropdown.id = 'user-dropdown';
            dropdown.style.cssText = `
                position: ${desiredPosition}; background: var(--surface, #fff);
                border: 1px solid var(--border, #e8e8e5); border-radius: 8px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.12); z-index: 9999;
                max-height: 220px; overflow-y: auto; display: none;
            `;
            desiredParent.appendChild(dropdown);
        } else if (dropdown.parentElement !== desiredParent) {
            // Re-parent if the active context changed (e.g. panel vs modal)
            desiredParent.appendChild(dropdown);
            dropdown.style.position = desiredPosition;
        }

        if (!activeUserSearchInput) return;

        if (users.length === 0) {
            dropdown.innerHTML = '<div style="padding: 12px 16px; color: var(--text-3, #999); font-size: 13px;">No users found</div>';
        } else {
            dropdown.innerHTML = users.map(u => `
                <div class="user-dropdown-item" data-email="${escapeHtml(u.email)}" style="padding: 10px 16px; cursor: pointer; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--border, #e8e8e5); transition: background 0.15s;">
                    <img src="${u.avatar_url}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; background: #eee;">
                    <div style="display: flex; flex-direction: column;">
                        <span style="font-weight: 600; font-size: 14px; color: var(--text-1, #111);">${escapeHtml(u.username || u.email)}</span>
                        ${u.username && u.username !== u.email ? `<span style="font-size: 12px; color: var(--text-3, #999);">${escapeHtml(u.email)}</span>` : ''}
                    </div>
                </div>
            `).join('');

            dropdown.querySelectorAll('.user-dropdown-item').forEach(item => {
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault(); // Prevent blur from firing before selecting
                    selectUserItem(item.dataset.email);
                });
                item.addEventListener('mouseenter', () => {
                    dropdown.querySelectorAll('.user-dropdown-item').forEach(i => {
                        i.style.backgroundColor = 'transparent';
                        i.classList.remove('highlighted');
                    });
                    item.style.backgroundColor = 'var(--accent-lt, #f0f4f8)';
                    item.classList.add('highlighted');
                });
                item.addEventListener('mouseleave', () => {
                    item.style.backgroundColor = 'transparent';
                    item.classList.remove('highlighted');
                });
            });
        }

        const rect = activeUserSearchInput.getBoundingClientRect();
        if (isAddPanel) {
            dropdown.style.top = (rect.bottom + 4) + 'px';
            dropdown.style.left = rect.left + 'px';
        } else {
            dropdown.style.top = (rect.bottom + window.scrollY + 4) + 'px';
            dropdown.style.left = (rect.left + window.scrollX) + 'px';
        }
        dropdown.style.width = rect.width + 'px';
        dropdown.style.display = 'block';
    }

    function selectUserItem(email) {
        if (activeUserSearchInput) {
            if (activeUserSearchInput.id === 'participant-email-input') {
                addParticipantTag(email);
                activeUserSearchInput.value = '';
                closeUserDropdown();
            } else if (activeUserSearchInput.id === 'add-participant-input') {
                addPanelParticipantTag(email);
                activeUserSearchInput.value = '';
                closeUserDropdown();
            } else {
                activeUserSearchInput.value = email;
                closeUserDropdown();
            }
        }
    }

    function handleUserDropdownKeyboard(e) {
        const dropdown = document.getElementById('user-dropdown');
        if (!dropdown || dropdown.style.display === 'none') return false;

        const items = Array.from(dropdown.querySelectorAll('.user-dropdown-item'));
        if (items.length === 0) return false;

        let currentIndex = items.findIndex(item => item.classList.contains('highlighted'));

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (currentIndex >= 0) items[currentIndex].classList.remove('highlighted');
            currentIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
            items[currentIndex].classList.add('highlighted');
            updateDropdownHighlight(items, currentIndex);
            return true;
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (currentIndex >= 0) items[currentIndex].classList.remove('highlighted');
            currentIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
            items[currentIndex].classList.add('highlighted');
            updateDropdownHighlight(items, currentIndex);
            return true;
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const selectedItem = currentIndex >= 0 ? items[currentIndex] : items[0];
            selectUserItem(selectedItem.dataset.email);
            return true;
        }

        return false;
    }

    function updateDropdownHighlight(items, index) {
        items.forEach((item, idx) => {
            if (idx === index) {
                item.style.backgroundColor = 'var(--accent-lt, #f0f4f8)';
                item.scrollIntoView({ block: 'nearest' });
            } else {
                item.style.backgroundColor = 'transparent';
            }
        });
    }

    function closeUserDropdown() {
        const dropdown = document.getElementById('user-dropdown');
        if (dropdown) dropdown.style.display = 'none';
    }

    async function validateUserExists(value) {
        try {
            const res = await fetch(`/api/users/search/?q=${encodeURIComponent(value)}&limit=10`);
            const data = await res.json();
            const users = data.users || [];
            return users.find(u =>
                u.email.toLowerCase() === value.toLowerCase() ||
                (u.username && u.username.toLowerCase() === value.toLowerCase())
            ) || null;
        } catch {
            return null;
        }
    }

    async function onParticipantKeydown(e) {
        if (handleUserDropdownKeyboard(e)) return;

        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const input = e.target;
            const value = input.value.replace(/,/g, '').trim();
            if (!value) return;
            const errorEl = document.getElementById('participant-email-error');
            if (errorEl) errorEl.style.display = 'none';
            const match = await validateUserExists(value);
            if (match) {
                addParticipantTag(match.email);
                input.value = '';
            } else {
                if (errorEl) {
                    errorEl.textContent = `"${value}" does not exist`;
                    errorEl.style.display = 'block';
                }
            }
        } else if (e.key === 'Backspace' && e.target.value === '' && participantEmails.length > 0) {
            removeParticipantTag(participantEmails[participantEmails.length - 1]);
        }
    }

    // --- Create-modal participant tag helpers (use participantEmails) ---

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

    // --- Add-people panel tag helpers (use addParticipantEmails) ---

    function addPanelParticipantTag(email) {
        if (addParticipantEmails.includes(email)) return;
        addParticipantEmails.push(email);
        renderPanelParticipantTags();
    }

    function removePanelParticipantTag(email) {
        addParticipantEmails = addParticipantEmails.filter(e => e !== email);
        renderPanelParticipantTags();
    }

    function renderPanelParticipantTags() {
        const container = document.getElementById('add-participant-tags');
        if (!container) return;
        container.innerHTML = addParticipantEmails.map(email => `
            <span class="participant-tag">
                ${escapeHtml(email)}
                <button class="participant-tag-remove" data-email="${escapeHtml(email)}" title="Remove">×</button>
            </span>
        `).join('');
        container.querySelectorAll('.participant-tag-remove').forEach(btn => {
            btn.addEventListener('click', () => removePanelParticipantTag(btn.dataset.email));
        });
        const submitBtn = document.getElementById('add-participant-submit');
        if (submitBtn) submitBtn.disabled = addParticipantEmails.length === 0;
    }

    async function submitAddParticipants() {
        const errorEl = document.getElementById('add-participant-error');
        const submitBtn = document.getElementById('add-participant-submit');
        const addInput = document.getElementById('add-participant-input');

        // Flush any partially typed value
        if (addInput && addInput.value.trim()) {
            const flushVal = addInput.value.trim();
            const flushErrorEl = document.getElementById('add-participant-error');
            if (flushErrorEl) flushErrorEl.style.display = 'none';
            const flushMatch = await validateUserExists(flushVal);
            if (flushMatch) {
                addPanelParticipantTag(flushMatch.email);
                addInput.value = '';
            } else {
                if (flushErrorEl) {
                    flushErrorEl.textContent = `"${flushVal}" does not exist`;
                    flushErrorEl.style.display = 'block';
                }
                if (submitBtn) submitBtn.disabled = addParticipantEmails.length === 0;
                return;
            }
        }

        if (!addParticipantEmails.length) return;

        if (errorEl) errorEl.style.display = 'none';
        if (submitBtn) submitBtn.disabled = true;

        try {
            const res = await fetch('/api/chats/participants/add/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': getCookie('csrftoken'),
                },
                credentials: 'same-origin',
                body: JSON.stringify({
                    chat_id: currentChat.id,
                    participant_emails: addParticipantEmails,
                }),
            });

            const data = await res.json();

            if (!res.ok) {
                if (errorEl) {
                    errorEl.textContent = data.error || 'Failed to add participants.';
                    errorEl.style.display = 'block';
                }
                if (submitBtn) submitBtn.disabled = addParticipantEmails.length === 0;
                return;
            }

            // Update participant count on the header button and in currentChat
            if (currentChat) currentChat.participant_count = data.participant_count;
            const participantsBtn = document.getElementById('participants-btn');
            if (participantsBtn) {
                participantsBtn.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    ${data.participant_count}
                `;
            }

            // Refresh the participant list in place
            const list = document.getElementById('participants-list');
            if (list && data.participants) {
                list.innerHTML = data.participants.map(p => `
                    <a class="chat-participant-item" href="/profile/?user=${encodeURIComponent(p.email)}">
                        <img class="chat-participant-avatar" src="${escapeHtml(p.avatar_url || '/static/maps/default-avatar.svg')}" alt="" onerror="this.src='/static/maps/default-avatar.svg'">
                        <span>${escapeHtml(p.username)}</span>
                    </a>
                `).join('');
            }

            // Reset the add form
            addParticipantEmails = [];
            renderPanelParticipantTags();
            if (addInput) addInput.value = '';

        } catch {
            if (errorEl) {
                errorEl.textContent = 'Network error. Please try again.';
                errorEl.style.display = 'block';
            }
            if (submitBtn) submitBtn.disabled = addParticipantEmails.length === 0;
        }
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
