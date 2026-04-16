import { uploadFile, renderMediaBubble, updateTickStatus, setupAttachmentFab, tickIcon } from './mediaHandler.js';

document.addEventListener('DOMContentLoaded', function () {
    const chatMessages    = document.querySelector('#chat-messages');
    const messageInput    = document.querySelector('#chat-message-input');
    const submitBtn       = document.querySelector('#chat-message-submit');
    const typingStatus    = document.querySelector('#typing-status');
    const onlineStatusText = document.querySelector('#online-status');
    const headerStatusDot  = document.querySelector('#header-status-dot');

    function scrollToBottom() {
        if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    scrollToBottom();

    if (!messageInput) return;

    const protocol  = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socketUrl = `${protocol}//${window.location.host}/ws/chat/${otherUser}/`;

    let chatSocket    = null;
    let typingTimeout = null;

    // ── WebSocket connection with auto-reconnect ──────────────────────────────
    function connect() {
        chatSocket = new WebSocket(socketUrl);

        chatSocket.onopen = () => {
            console.log('[WS] Connected ✅');
            // Set up FAB after socket is ready
            setupAttachmentFab(chatSocket, otherUser);
        };

        chatSocket.onmessage = (e) => {
            const data = JSON.parse(e.data);

            if (data.action === 'message') {
                appendTextMessage(data.message, data.sender, data.timestamp, data.message_id, data.status);
                typingStatus.style.display = 'none';
                onlineStatusText.style.display = 'inline';

                // Auto-send seen if we are the receiver and window is focused
                if (data.sender !== currentUser && document.hasFocus()) {
                    sendSeen(data.message_id);
                }

            } else if (data.action === 'media') {
                const isSelf = (data.sender === currentUser);
                renderMediaBubble(data, isSelf);

                if (data.sender !== currentUser && document.hasFocus()) {
                    sendSeen(data.message_id);
                }

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

            } else if (data.action === 'msg_status') {
                updateTickStatus(data.message_id, data.status);
            }
        };

        chatSocket.onclose = (e) => {
            console.warn('[WS] Disconnected ❌');
            if (e.code !== 1000) setTimeout(connect, 2500);
            setOnlineStatus(false);
        };

        chatSocket.onerror = (err) => console.error('[WS] Error:', err);
    }

    connect();

    // ── When window gains focus → mark visible messages as seen ──────────────
    window.addEventListener('focus', () => {
        document.querySelectorAll('.message.received[data-msg-id]').forEach(el => {
            const id = el.dataset.msgId;
            if (id) sendSeen(parseInt(id, 10));
        });
    });

    // ── Online Status ─────────────────────────────────────────────────────────
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

    // ── Append Text Message ───────────────────────────────────────────────────
    function appendTextMessage(text, sender, timestamp, messageId, status) {
        const isSelf = (sender === currentUser);
        const cls    = isSelf ? 'sent' : 'received';
        const date   = timestamp ? new Date(timestamp) : new Date();
        const time   = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const tick   = isSelf
            ? `<span class="tick ${status || 'sent'}" data-msg-id="${messageId}">${tickIcon(status || 'sent')}</span>`
            : '';

        const html = `
            <div class="message ${cls}" data-msg-id="${messageId}">
                <div class="message-bubble">${escapeHTML(text)}</div>
                <div class="message-meta">${time}${tick}</div>
            </div>`;

        chatMessages.insertAdjacentHTML('beforeend', html);
        scrollToBottom();
    }

    // ── Send Text Message ─────────────────────────────────────────────────────
    function sendMessage() {
        const text = messageInput.value.trim();
        if (!text || !chatSocket || chatSocket.readyState !== WebSocket.OPEN) return;
        chatSocket.send(JSON.stringify({ action: 'message', message: text }));
        messageInput.value = '';
    }

    // ── Send Seen ─────────────────────────────────────────────────────────────
    function sendSeen(messageId) {
        if (chatSocket && chatSocket.readyState === WebSocket.OPEN) {
            chatSocket.send(JSON.stringify({ action: 'seen', message_id: messageId }));
        }
    }

    // ── Escape HTML ───────────────────────────────────────────────────────────
    function escapeHTML(str) {
        return String(str).replace(/[&<>'"]/g, t =>
            ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[t])
        );
    }

    // ── Event Listeners ───────────────────────────────────────────────────────
    submitBtn.addEventListener('click', (e) => { e.preventDefault(); sendMessage(); });

    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    messageInput.addEventListener('input', () => {
        if (!chatSocket || chatSocket.readyState !== WebSocket.OPEN) return;
        chatSocket.send(JSON.stringify({ action: 'typing', is_typing: true }));
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            if (chatSocket.readyState === WebSocket.OPEN) {
                chatSocket.send(JSON.stringify({ action: 'typing', is_typing: false }));
            }
        }, 1500);
    });
});