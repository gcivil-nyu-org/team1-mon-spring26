document.addEventListener('DOMContentLoaded', () => {
    // Add animation styles dynamically
    const style = document.createElement('style');
    style.textContent = `
        @keyframes chatNavHighlight {
            0% { transform: scale(1); background-color: transparent; }
            50% { transform: scale(1.1); background-color: var(--accent-lt, #e8f0fe); border-radius: 8px; }
            100% { transform: scale(1); background-color: transparent; }
        }
        .nav-highlight-anim {
            animation: chatNavHighlight 1s ease-in-out 3;
        }
        .chat-notification-badge {
            background-color: var(--red, #dc2626);
            color: white;
            border-radius: 10px;
            padding: 2px 6px;
            font-size: 10px;
            margin-left: 6px;
            vertical-align: super;
            font-weight: bold;
            display: inline-block;
        }
    `;
    document.head.appendChild(style);

    let sseSource = null;
    let audioContext = null;
    let reconnectDelay = 1000;
    const MAX_RECONNECT_DELAY = 60000;
    let reconnectTimeout = null;
    let isReconnect = false;

    // Initialize AudioContext on first user interaction (required for Safari/Mac)
    function initAudioContext() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext || audioContext) return;
            
            audioContext = new AudioContext();
            console.log('[Notifications] AudioContext initialized');
            
            // Try to resume if it was suspended
            if (audioContext.state === 'suspended') {
                audioContext.resume().then(() => {
                    console.log('[Notifications] AudioContext resumed on init');
                });
            }
        } catch (e) {
            console.warn('[Notifications] Failed to initialize AudioContext:', e);
        }
    }

    // Set up listeners to initialize AudioContext on any user interaction
    ['click', 'keydown', 'touchstart', 'mousedown'].forEach(event => {
        document.addEventListener(event, initAudioContext, { once: true });
    });

    function playNotificationSound() {
        try {
            let ctx = audioContext;
            
            if (!ctx) {
                // Fallback: create a new context if not pre-initialized
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (!AudioContext) {
                    console.log('[Notifications] AudioContext not available');
                    return;
                }
                ctx = new AudioContext();
                console.log('[Notifications] Created new AudioContext for sound');
            }
            
            // Resume audio context if suspended (common on Safari/Mac)
            if (ctx.state === 'suspended') {
                console.log('[Notifications] AudioContext suspended, resuming...');
                ctx.resume().then(() => {
                    playSound(ctx);
                }).catch(err => {
                    console.error('[Notifications] Failed to resume AudioContext:', err);
                });
            } else {
                playSound(ctx);
            }
            
            function playSound(audioCtx) {
                const osc = audioCtx.createOscillator();
                const gainNode = audioCtx.createGain();
                
                osc.connect(gainNode);
                gainNode.connect(audioCtx.destination);
                
                osc.type = 'sine';
                osc.frequency.setValueAtTime(600, audioCtx.currentTime);
                
                gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
                gainNode.gain.linearRampToValueAtTime(0.15, audioCtx.currentTime + 0.02);
                gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
                
                osc.start(audioCtx.currentTime);
                osc.stop(audioCtx.currentTime + 0.3);
                
                console.log('[Notifications] Notification sound played');
            }
        } catch (e) {
            console.warn('[Notifications] Failed to play notification sound:', e);
        }
    }

    async function checkAuthAndInit() {
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }
        
        try {
            const res = await fetch('/api/auth/me/');
            const data = await res.json();
            if (data.is_authenticated) {
                // SSE enabled for chat notifications
                console.log('[Notifications] User authenticated, connecting to SSE stream...');
                
                if (sseSource) {
                    sseSource.close();
                }
                
                let sseUrl = '/api/chats/events/';
                if (window.location.port === '8000') {
                    sseUrl = `${window.location.protocol}//${window.location.hostname}:8001/api/chats/events/`;
                }
                
                sseSource = new EventSource(sseUrl, { withCredentials: true });
                
                sseSource.onopen = () => {
                    console.log('[Notifications] SSE connection opened');
                    reconnectDelay = 1000; // Reset backoff on successful connection
                    if (isReconnect) {
                        console.log('[Notifications] SSE reconnected, dispatching sync event');
                        window.dispatchEvent(new CustomEvent('chat:reconnected'));
                    }
                    isReconnect = false;
                };
                
                sseSource.onerror = (err) => {
                    console.error('[Notifications] SSE connection error:', err);
                    isReconnect = true;
                    
                    // Force close the broken native socket to prevent memory leaks
                    if (sseSource) {
                        sseSource.close();
                        sseSource = null;
                    }
                    
                    // Trigger exponential backoff reconnection
                    if (!reconnectTimeout) {
                        console.log(`[Notifications] Scheduling reconnect in ${reconnectDelay}ms...`);
                        reconnectTimeout = setTimeout(checkAuthAndInit, reconnectDelay);
                        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
                    }
                };
                
                sseSource.onmessage = (event) => {
                    const msgData = JSON.parse(event.data);
                    console.log('[Notifications] SSE message received:', msgData.type);
                    if (msgData.type === 'new_message') {
                        const chatsLink = document.querySelector('a[href^="/chats/"]');
                        if (chatsLink) {
                            if (msgData.chat_id) {
                                // Add to pending chats list for the UI badge
                                try {
                                    const pending = JSON.parse(sessionStorage.getItem('pendingChatIds') || '[]');
                                    if (!pending.includes(msgData.chat_id)) {
                                        pending.push(msgData.chat_id);
                                        sessionStorage.setItem('pendingChatIds', JSON.stringify(pending));
                                    }
                                } catch (e) {}
                                
                                chatsLink.href = `/chats/?chat_id=${msgData.chat_id}`;
                            }
                            chatsLink.classList.remove('nav-highlight-anim');
                            void chatsLink.offsetWidth; // trigger reflow to reset animation
                            chatsLink.classList.add('nav-highlight-anim');
                            
                            if (!chatsLink.querySelector('.chat-notification-badge')) {
                                const badge = document.createElement('span');
                                badge.className = 'chat-notification-badge';
                                badge.textContent = 'New';
                                chatsLink.appendChild(badge);
                            }
                        }
                        
                        playNotificationSound();
                        
                        // Dispatch global event so the Chats app can hook into it safely
                        try {
                            const event = new CustomEvent('chat:new_message', { 
                                detail: msgData,
                                bubbles: true,
                                cancelable: false 
                            });
                            window.dispatchEvent(event);
                            console.log('[Notifications] Dispatched chat:new_message event', msgData);
                        } catch (e) {
                            console.error('[Notifications] Failed to dispatch chat:new_message event:', e);
                        }
                    } else if (msgData.error === 'unauthorized') {
                        if (sseSource) {
                            sseSource.close();
                            sseSource = null;
                        }
                        if (reconnectTimeout) {
                            clearTimeout(reconnectTimeout);
                            reconnectTimeout = null;
                        }
                    }
                };
            }
        } catch (e) {
            console.error('SSE initialization failed', e);
            isReconnect = true;
            
            if (!reconnectTimeout) {
                console.log(`[Notifications] Network error, retrying in ${reconnectDelay}ms...`);
                reconnectTimeout = setTimeout(checkAuthAndInit, reconnectDelay);
                reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
            }
        }
    }
    
    checkAuthAndInit();

    // Expose globally so auth.js can trigger it after login/register
    window.initNotificationsSSE = checkAuthAndInit;
    
    window.closeNotificationsSSE = () => {
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }
        if (sseSource) {
            sseSource.close();
            sseSource = null;
            console.log('[Notifications] SSE connection closed explicitly');
        }
    };

    // SSE - close connection on unload
    // Explicitly close the SSE connection when leaving the page
    // to prevent the browser's 6-connection limit from stalling navigation.
    window.addEventListener('beforeunload', () => {
        if (sseSource) sseSource.close();
    });
    
    window.addEventListener('pagehide', () => {
        if (sseSource) sseSource.close();
    });
});
