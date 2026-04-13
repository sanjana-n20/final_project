document.addEventListener('DOMContentLoaded', function () {
    const chatMessages = document.querySelector('#chat-messages');
    const messageInput = document.querySelector('#chat-message-input');
    const submitBtn = document.querySelector('#chat-message-submit');
    const typingStatus = document.querySelector('#typing-status');
    const onlineStatusText = document.querySelector('#online-status');
    const headerStatusDot = document.querySelector('#header-status-dot');

    function scrollToBottom() {
        if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    scrollToBottom();

    if (!messageInput) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socketUrl = `${protocol}//${window.location.host}/ws/chat/${otherUser}/`;

    let chatSocket = null;
    let typingTimeout = null;

    function connect() {
        chatSocket = new WebSocket(socketUrl);

        chatSocket.onopen = function () {
            console.log('[WS] Connected ✅');
        };

        chatSocket.onmessage = function (e) {
            const data = JSON.parse(e.data);

            if (data.action === 'message') {
                appendMessage(data.message, data.sender, data.timestamp);
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
            console.warn('[WS] Disconnected ❌');

            // Only reconnect if abnormal close
            if (e.code !== 1000) {
                setTimeout(connect, 2000);
            }

            setOnlineStatus(false);
        };

        chatSocket.onerror = function (err) {
            console.error('[WS] Error:', err);
        };
    }

    connect();

    function setOnlineStatus(isOnline) {
        if (isOnline) {
            onlineStatusText.textContent = '🟢 Online';
            headerStatusDot.className = 'status-indicator online';
        } else {
            onlineStatusText.textContent = '⚫ Offline';
            headerStatusDot.className = 'status-indicator offline';
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
        if (!text || chatSocket.readyState !== WebSocket.OPEN) return;

        chatSocket.send(JSON.stringify({
            action: 'message',
            message: text
        }));

        messageInput.value = '';
    }

    function escapeHTML(str) {
        return str.replace(/[&<>'"]/g, tag =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag])
        );
    }

    submitBtn.addEventListener('click', function (e) {
        e.preventDefault(); // 🔥 VERY IMPORTANT
        sendMessage();
    });

    messageInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    messageInput.addEventListener('input', function () {
        if (chatSocket.readyState !== WebSocket.OPEN) return;

        chatSocket.send(JSON.stringify({
            action: 'typing',
            is_typing: true
        }));

        if (typingTimeout) clearTimeout(typingTimeout);

        typingTimeout = setTimeout(() => {
            if (chatSocket.readyState === WebSocket.OPEN) {
                chatSocket.send(JSON.stringify({
                    action: 'typing',
                    is_typing: false
                }));
            }
        }, 1500);
    });
});