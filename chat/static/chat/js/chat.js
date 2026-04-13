document.addEventListener('DOMContentLoaded', function () {
    const chatMessages = document.querySelector('#chat-messages');
    const messageInput = document.querySelector('#chat-message-input');
    const submitBtn = document.querySelector('#chat-message-submit');
    const typingStatus = document.querySelector('#typing-status');
    const onlineStatusText = document.querySelector('#online-status');
    const headerStatusDot = document.querySelector('#header-status-dot');

    // Always scroll to the bottom
    function scrollToBottom() {
        if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    scrollToBottom();

    // Exit early if we're not on the chat page
    if (!messageInput) return;

    // ── WebSocket setup with auto-reconnect ───────────────────────────────────
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socketUrl = `${protocol}//${window.location.host}/ws/chat/${otherUser}/`;

    let chatSocket = null;
    let reconnectDelay = 1000;   // start with 1 s, doubles on each failure
    let typingTimeout = null;

    function connect() {
        chatSocket = new WebSocket(socketUrl);

        chatSocket.onopen = function () {
            console.log('[WS] Connected');
            reconnectDelay = 1000; // reset on successful connect
        };

        chatSocket.onmessage = function (e) {
            const data = JSON.parse(e.data);

            if (data.action === 'message') {
                appendMessage(data.message, data.sender, data.timestamp);
                // Hide typing indicator when a message arrives
                typingStatus.style.display = 'none';
                onlineStatusText.style.display = 'inline';

            } else if (data.action === 'typing') {
                if (data.is_typing) {
                    onlineStatusText.style.display = 'none';
                    typingStatus.style.display = 'inline';
                } else {
                    typingStatus.style.display = 'none';
                    onlineStatusText.style.display = 'inline';
                }

            } else if (data.action === 'status') {
                setOnlineStatus(data.is_online);
            }
        };

        chatSocket.onclose = function (e) {
            console.warn(`[WS] Closed (code ${e.code}). Reconnecting in ${reconnectDelay}ms…`);
            // Mark other user offline in UI when we lose connection
            setOnlineStatus(false);
            setTimeout(() => {
                reconnectDelay = Math.min(reconnectDelay * 2, 30000); // cap at 30 s
                connect();
            }, reconnectDelay);
        };

        chatSocket.onerror = function (err) {
            console.error('[WS] Error:', err);
            chatSocket.close();
        };
    }

    connect(); // initial connection

    // ── Helpers ───────────────────────────────────────────────────────────────

    function setOnlineStatus(isOnline) {
        if (isOnline) {
            onlineStatusText.textContent = '🟢 Online';
            headerStatusDot.className = 'status-indicator online';
        } else {
            onlineStatusText.textContent = '⚫ Offline';
            headerStatusDot.className = 'status-indicator offline';
            // Hide typing if they went offline
            typingStatus.style.display = 'none';
            onlineStatusText.style.display = 'inline';
        }
    }

    function appendMessage(text, sender, timestamp) {
        const isMine = sender === currentUser;
        const cls = isMine ? 'sent' : 'received';

        const date = timestamp ? new Date(timestamp) : new Date();
        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const html = `
            <div class="message ${cls}">
                <div class="message-bubble">${escapeHTML(text)}</div>
                <div class="message-meta">${timeStr}</div>
            </div>`;
        chatMessages.insertAdjacentHTML('beforeend', html);
        scrollToBottom();
    }

    function sendMessage() {
        const text = messageInput.value.trim();
        if (!text || !chatSocket || chatSocket.readyState !== WebSocket.OPEN) return;

        chatSocket.send(JSON.stringify({ action: 'message', message: text }));
        messageInput.value = '';

        // Stop typing indicator
        if (typingTimeout) clearTimeout(typingTimeout);
        chatSocket.send(JSON.stringify({ action: 'typing', is_typing: false }));
    }

    function escapeHTML(str) {
        return str.replace(/[&<>'"]/g, tag =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])
        );
    }

    // ── Event listeners ───────────────────────────────────────────────────────

    submitBtn.addEventListener('click', sendMessage);

    messageInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    messageInput.addEventListener('input', function () {
        if (!chatSocket || chatSocket.readyState !== WebSocket.OPEN) return;

        chatSocket.send(JSON.stringify({ action: 'typing', is_typing: true }));

        if (typingTimeout) clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            if (chatSocket.readyState === WebSocket.OPEN) {
                chatSocket.send(JSON.stringify({ action: 'typing', is_typing: false }));
            }
        }, 1500);
    });
});
