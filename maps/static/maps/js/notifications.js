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

    function playNotificationSound() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            const ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const gainNode = ctx.createGain();
            
            osc.connect(gainNode);
            gainNode.connect(ctx.destination);
            
            osc.type = 'sine';
            osc.frequency.setValueAtTime(600, ctx.currentTime);
            
            gainNode.gain.setValueAtTime(0, ctx.currentTime);
            gainNode.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.02);
            gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
            
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.3);
        } catch (e) {
            // Browser might block audio if user hasn't interacted with the page yet
        }
    }

    async function checkAuthAndInit() {
        try {
            const res = await fetch('/api/auth/me/');
            const data = await res.json();
            if (data.is_authenticated) {
                sseSource = new EventSource('/api/chats/events/');
                sseSource.onmessage = (event) => {
                    const msgData = JSON.parse(event.data);
                    if (msgData.type === 'new_message') {
                        const chatsLink = document.querySelector('a[href^="/chats/"]');
                        if (chatsLink) {
                            if (msgData.chat_id) {
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
                        window.dispatchEvent(new CustomEvent('chat:new_message'));
                    } else if (msgData.error === 'unauthorized') {
                        sseSource.close();
                    }
                };
            }
        } catch (e) {
            console.error('SSE initialization failed', e);
        }
    }
    
    checkAuthAndInit();

    // Explicitly close the SSE connection when leaving the page
    // to prevent the browser's 6-connection limit from stalling navigation.
    window.addEventListener('beforeunload', () => {
        if (sseSource) sseSource.close();
    });
    
    window.addEventListener('pagehide', () => {
        if (sseSource) sseSource.close();
    });
});