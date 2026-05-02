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

            } else if (data.action === 'msg_deleted') {
                const msgEl = document.querySelector(`.message[data-msg-id="${data.message_id}"]`);
                if (!msgEl) return;
                
                if (data.delete_type === 'me') {
                    msgEl.remove();
                } else if (data.delete_type === 'everyone') {
                    // Remove existing bubbles
                    msgEl.querySelectorAll('.message-bubble, .media-bubble').forEach(b => b.remove());
                    // Insert deleted text bubble before meta
                    const meta = msgEl.querySelector('.message-meta');
                    const deletedBubble = document.createElement('div');
                    deletedBubble.className = 'message-bubble msg-deleted-text';
                    deletedBubble.textContent = '🚫 This message was deleted';
                    msgEl.insertBefore(deletedBubble, meta);
                    
                    // Remove 'Delete for everyone' option from dropdown if exists
                    const delEvBtn = msgEl.querySelector('.msg-dropdown-content button.del-everyone-btn');
                    if (delEvBtn) delEvBtn.remove();
                }
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

        const deleteForEveryoneHTML = isSelf 
            ? `<button class="del-everyone-btn" onclick="deleteMessage(${messageId}, 'everyone')">Delete for everyone</button>` 
            : '';
            
        const dropdown = `
            <div class="msg-dropdown">
                <button class="msg-dropdown-btn" onclick="toggleDropdown(this)">⋮</button>
                <div class="msg-dropdown-content">
                    <button onclick="deleteMessage(${messageId}, 'me')">Delete for me</button>
                    ${deleteForEveryoneHTML}
                </div>
            </div>`;

        const html = `
            <div class="message ${cls}" data-msg-id="${messageId}">
                <div class="message-bubble">${escapeHTML(text)}</div>
                <div class="message-meta">${time}${tick}${dropdown}</div>
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

    // ── Global Delete Message & Dropdown ──────────────────────────────────────
    window.toggleDropdown = function(btn) {
        // Close others
        document.querySelectorAll('.msg-dropdown-content.show').forEach(el => {
            if (el !== btn.nextElementSibling) el.classList.remove('show');
        });
        btn.nextElementSibling.classList.toggle('show');
    };

    // Close dropdowns when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.matches('.msg-dropdown-btn')) {
            document.querySelectorAll('.msg-dropdown-content.show').forEach(el => el.classList.remove('show'));
        }
    });

    window.deleteMessage = function(messageId, deleteType) {
        if (chatSocket && chatSocket.readyState === WebSocket.OPEN) {
            chatSocket.send(JSON.stringify({
                action: 'delete_message',
                message_id: messageId,
                delete_type: deleteType
            }));
            // Close dropdowns
            document.querySelectorAll('.msg-dropdown-content.show').forEach(el => el.classList.remove('show'));
        }
    };
});