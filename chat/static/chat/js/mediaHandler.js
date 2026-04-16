/**
 * mediaHandler.js
 * Handles all media upload, audio recording, and bubble rendering for SecureChat.
 */

// ── CSRF helper — reads meta tag first, falls back to cookie ──────────────────
function getCSRFToken() {
    // Most reliable: Django injects it as a <meta> tag in base.html
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && meta.content) return meta.content;
    // Fallback: read from cookie
    const value = `; ${document.cookie}`;
    const parts = value.split('; csrftoken=');
    if (parts.length === 2) return parts.pop().split(';').shift();
    console.warn('[Media] CSRF token not found! Upload will likely fail with 403.');
    return '';
}

// ── Allowed MIME types (mirrors server-side whitelist) ────────────────────────
const ALLOWED_IMAGE_TYPES = ['image/jpeg','image/png','image/gif','image/webp'];
const ALLOWED_AUDIO_TYPES = ['audio/mpeg','audio/ogg','audio/wav','audio/webm','audio/mp4','audio/x-m4a'];
const ALLOWED_VIDEO_TYPES = ['video/mp4','video/webm','video/ogg','video/quicktime'];
const MAX_MB = 25;

// ── Track already-rendered message IDs to prevent duplicates ──────────────────
const renderedMessageIds = new Set();

// ── Upload Progress Overlay ───────────────────────────────────────────────────
const progressOverlay  = document.getElementById('upload-progress-overlay');
const progressBarInner = document.getElementById('progress-bar-inner');
const progressPct      = document.getElementById('upload-pct');

function showProgress() {
    if (progressOverlay) progressOverlay.classList.add('active');
}
function hideProgress() {
    if (progressOverlay) progressOverlay.classList.remove('active');
    if (progressBarInner) progressBarInner.style.width = '0%';
    if (progressPct) progressPct.textContent = '0%';
}
function updateProgress(pct) {
    if (progressBarInner) progressBarInner.style.width = `${pct}%`;
    if (progressPct) progressPct.textContent = `${Math.round(pct)}%`;
}

// ── File Upload via XHR ───────────────────────────────────────────────────────
export function uploadFile(file, receiverUsername, chatSocket) {
    const mime = file.type.toLowerCase().split(';')[0].trim();
    const allAllowed = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_AUDIO_TYPES, ...ALLOWED_VIDEO_TYPES];

    console.log(`[Upload] file=${file.name} mime=${mime} size=${file.size} receiver=${receiverUsername}`);

    if (!allAllowed.includes(mime)) {
        console.error(`[Upload] MIME type "${mime}" not in allowed list:`, allAllowed);
        showToast(`File type "${mime}" not allowed.`, 'error');
        return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
        showToast(`File too large. Max ${MAX_MB} MB.`, 'error');
        return;
    }

    const csrfToken = getCSRFToken();
    console.log(`[Upload] CSRF token: ${csrfToken ? csrfToken.substring(0,8)+'...' : 'MISSING'}`);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('receiver', receiverUsername);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/chat/upload/', true);
    xhr.setRequestHeader('X-CSRFToken', csrfToken);

    xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) updateProgress((e.loaded / e.total) * 100);
    });

    showProgress();
    console.log('[Upload] Sending XHR to /chat/upload/ ...');

    xhr.onload = () => {
        hideProgress();
        console.log(`[Upload] Response HTTP ${xhr.status}:`, xhr.responseText.substring(0, 200));
        if (xhr.status === 200) {
            const data = JSON.parse(xhr.responseText);
            console.log('[Upload] Success! message_id=', data.message_id, 'type=', data.message_type);
            
            // Render immediately for sender
            renderMediaBubble(data, true);
            
            // Mark as rendered AFTER the local render so the upcoming WS echo is ignored
            renderedMessageIds.add(data.message_id);
            
            // Notify peer via WebSocket
            if (chatSocket && chatSocket.readyState === WebSocket.OPEN) {
                chatSocket.send(JSON.stringify({
                    action: 'media_notify',
                    message_id: data.message_id,
                }));
                console.log('[Upload] Sent media_notify via WebSocket.');
            } else {
                console.warn('[Upload] WebSocket not open! State:', chatSocket?.readyState);
            }
            showToast('Media sent ✓', 'success');
        } else {
            let msg = 'Upload failed.';
            try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
            console.error(`[Upload] Server error ${xhr.status}:`, msg);
            showToast(`${msg} (HTTP ${xhr.status})`, 'error');
        }
    };

    xhr.onerror = () => {
        hideProgress();
        console.error('[Upload] Network error - could not reach /chat/upload/');
        showToast('Upload failed. Check your connection.', 'error');
    };

    xhr.send(formData);
}

// ── Render Media Bubble (deduplication guard) ─────────────────────────────────
export function renderMediaBubble(data, isSelf) {
    // Prevent rendering the same message twice (e.g. sender upload + WebSocket echo)
    if (renderedMessageIds.has(data.message_id)) {
        console.log(`[Render] Skipping duplicate message_id: ${data.message_id}`);
        return;
    }
    // Track this ID
    renderedMessageIds.add(data.message_id);

    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    const cls  = isSelf ? 'sent' : 'received';
    const date = data.timestamp ? new Date(data.timestamp) : new Date();
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const tickHtml = isSelf
        ? `<span class="tick ${data.status || 'sent'}" data-msg-id="${data.message_id}">${tickIcon(data.status || 'sent')}</span>`
        : '';

    let mediaContent = '';

    if (data.message_type === 'image') {
        const src = data.thumbnail_url || data.media_url;
        mediaContent = `
            <div class="media-bubble img-bubble" 
                 data-full-url="${data.media_url}" 
                 data-filename="${escapeHTML(data.media_filename || 'image')}"
                 onclick="openLightbox(this)"
                 title="Click to view full size">
                <img src="${src}" alt="${escapeHTML(data.media_filename || 'image')}" loading="lazy">
                <div class="media-filename">📷 ${escapeHTML(data.media_filename || 'Image')}</div>
            </div>`;

    } else if (data.message_type === 'audio') {
        const label = escapeHTML(data.media_filename || 'Voice message');
        const mime  = data.media_mime || 'audio/webm';
        mediaContent = `
            <div class="media-bubble">
                <div class="audio-bubble">
                    <div class="audio-bubble-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                            <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/>
                        </svg>
                    </div>
                    <div class="audio-player-wrap">
                        <div class="audio-label">${label}</div>
                        <audio controls preload="none" style="width:180px">
                            <source src="${data.media_url}" type="${mime}">
                            Your browser does not support audio playback.
                        </audio>
                    </div>
                </div>
            </div>`;

    } else if (data.message_type === 'video') {
        const mime = data.media_mime || 'video/mp4';
        const canPlay = canBrowserPlay(mime);
        if (canPlay) {
            mediaContent = `
                <div class="media-bubble">
                    <div class="video-bubble">
                        <video controls preload="metadata" style="max-width:280px;border-radius:10px">
                            <source src="${data.media_url}" type="${mime}">
                            Your browser does not support video playback.
                        </video>
                    </div>
                    <div class="media-filename">🎥 ${escapeHTML(data.media_filename || 'Video')}</div>
                </div>`;
        } else {
            // .mov / quicktime — browser can't play; show download link
            mediaContent = `
                <div class="media-bubble" style="padding:14px 16px">
                    <div style="display:flex;align-items:center;gap:10px">
                        <span style="font-size:28px">🎞️</span>
                        <div>
                            <div style="font-size:13px;font-weight:500">${escapeHTML(data.media_filename || 'Video')}</div>
                            <a href="${data.media_url}" download="${escapeHTML(data.media_filename || 'video')}" 
                               style="font-size:12px;color:var(--primary);text-decoration:none" target="_blank">
                               ⬇ Download to play
                            </a>
                        </div>
                    </div>
                </div>`;
        }
    }

    const html = `
        <div class="message ${cls}" data-msg-id="${data.message_id}">
            ${mediaContent}
            <div class="message-meta">${time}${tickHtml}</div>
        </div>`;

    chatMessages.insertAdjacentHTML('beforeend', html);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Helper: can the browser play this MIME type? ─────────────────────────────
function canBrowserPlay(mime) {
    const v = document.createElement('video');
    return v.canPlayType(mime) !== '';
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
window.openLightbox = function(el) {
    const url      = el.dataset.fullUrl;
    const filename = el.dataset.filename || 'image';
    const overlay  = document.getElementById('lightbox-overlay');
    const img      = document.getElementById('lightbox-img');
    const dlBtn    = document.getElementById('lightbox-download');
    if (!overlay || !img) return;
    img.src = url;
    img.alt = filename;
    if (dlBtn) { dlBtn.href = url; dlBtn.download = filename; }
    overlay.classList.add('active');
};

window.closeLightbox = function() {
    const overlay = document.getElementById('lightbox-overlay');
    const img     = document.getElementById('lightbox-img');
    if (overlay) overlay.classList.remove('active');
    if (img) img.src = '';
};

// Close lightbox on overlay click (but not on image click)
document.addEventListener('DOMContentLoaded', () => {
    const overlay = document.getElementById('lightbox-overlay');
    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeLightbox();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeLightbox();
        });
    }
});

// ── Status Tick Icons ─────────────────────────────────────────────────────────
export function tickIcon(status) {
    if (status === 'seen')      return '✓✓';
    if (status === 'delivered') return '✓✓';
    return '✓';
}

export function updateTickStatus(messageId, status) {
    const ticks = document.querySelectorAll(`.tick[data-msg-id="${messageId}"]`);
    ticks.forEach(el => {
        el.className = `tick ${status}`;
        el.textContent = tickIcon(status);
    });
}

// ── FAB Attachment Menu ───────────────────────────────────────────────────────
export function setupAttachmentFab(chatSocket, receiverUsername) {
    const fabBtn     = document.getElementById('fab-btn');
    const fabSubBtns = document.getElementById('fab-sub-btns');
    const imageInput = document.getElementById('image-file-input');
    const videoInput = document.getElementById('video-file-input');
    const audioInput = document.getElementById('audio-file-input');

    console.log('[FAB] setupAttachmentFab called. receiver=', receiverUsername,
        '| imageInput:', !!imageInput, '| videoInput:', !!videoInput, '| audioInput:', !!audioInput);

    if (!fabBtn || !fabSubBtns) {
        console.error('[FAB] fab-btn or fab-sub-btns NOT FOUND in DOM!');
        return;
    }

    fabBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fabSubBtns.classList.toggle('open');
    });

    document.addEventListener('click', () => fabSubBtns.classList.remove('open'));

    document.getElementById('fab-image-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        fabSubBtns.classList.remove('open');
        imageInput?.click();
    });
    document.getElementById('fab-video-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        fabSubBtns.classList.remove('open');
        videoInput?.click();
    });
    document.getElementById('fab-audio-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        fabSubBtns.classList.remove('open');
        // Show submenu: record or pick file
        showAudioChoice(chatSocket, receiverUsername);
    });

    imageInput?.addEventListener('change', () => {
        const file = imageInput.files[0];
        if (file) { uploadFile(file, receiverUsername, chatSocket); imageInput.value = ''; }
    });
    videoInput?.addEventListener('change', () => {
        const file = videoInput.files[0];
        if (file) { uploadFile(file, receiverUsername, chatSocket); videoInput.value = ''; }
    });
    audioInput?.addEventListener('change', () => {
        const file = audioInput.files[0];
        if (file) { uploadFile(file, receiverUsername, chatSocket); audioInput.value = ''; }
    });
}

// ── Audio Choice Popup (record vs pick file) ──────────────────────────────────
function showAudioChoice(chatSocket, receiverUsername) {
    const existing = document.getElementById('audio-choice-popup');
    if (existing) { existing.remove(); return; }

    const popup = document.createElement('div');
    popup.id = 'audio-choice-popup';
    popup.className = 'audio-choice-popup';
    popup.innerHTML = `
        <button id="ac-record"><span>🎙️</span> Record audio</button>
        <button id="ac-file"><span>📁</span> Choose audio file</button>
    `;
    document.querySelector('.chat-input-area')?.appendChild(popup);

    setTimeout(() => {
        document.getElementById('ac-record')?.addEventListener('click', () => {
            popup.remove();
            startAudioRecorder(chatSocket, receiverUsername);
        });
        document.getElementById('ac-file')?.addEventListener('click', () => {
            popup.remove();
            document.getElementById('audio-file-input')?.click();
        });
        document.addEventListener('click', () => popup.remove(), { once: true });
    }, 0);
}

// ── Audio Recorder ────────────────────────────────────────────────────────────
let mediaRecorder    = null;
let audioChunks      = [];
let recTimerInterval = null;
let recSeconds       = 0;

export function startAudioRecorder(chatSocket, receiverUsername) {
    const recBar    = document.getElementById('recorder-bar');
    const recTimer  = document.getElementById('rec-timer');
    const recCancel = document.getElementById('rec-cancel');
    const recSend   = document.getElementById('rec-send');
    const inputRow  = document.getElementById('input-row');

    if (!recBar) return;

    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        audioChunks = [];
        recSeconds  = 0;

        // Pick the best supported MIME type
        const preferredTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
        let chosenMime = 'audio/webm';
        for (const t of preferredTypes) {
            if (MediaRecorder.isTypeSupported(t)) { chosenMime = t; break; }
        }

        mediaRecorder = new MediaRecorder(stream, { mimeType: chosenMime });
        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.start();

        // Show recorder bar, hide input row
        recBar.classList.add('active');
        if (inputRow) inputRow.style.display = 'none';

        recTimerInterval = setInterval(() => {
            recSeconds++;
            const m = String(Math.floor(recSeconds / 60)).padStart(2, '0');
            const s = String(recSeconds % 60).padStart(2, '0');
            if (recTimer) recTimer.textContent = `${m}:${s}`;
        }, 1000);

        const cancelHandler = () => stopRecorder(stream, false, null, null);
        const sendHandler   = () => stopRecorder(stream, true, chatSocket, receiverUsername);

        recCancel?.addEventListener('click', cancelHandler, { once: true });
        recSend?.addEventListener('click',   sendHandler,   { once: true });

    }).catch(err => {
        console.error('Microphone error:', err);
        showToast('Microphone access denied or unavailable.', 'error');
    });
}

function stopRecorder(stream, send, chatSocket, receiverUsername) {
    clearInterval(recTimerInterval);

    const recBar   = document.getElementById('recorder-bar');
    const inputRow = document.getElementById('input-row');
    const recTimer = document.getElementById('rec-timer');

    recBar?.classList.remove('active');
    if (inputRow) inputRow.style.display = 'flex';
    if (recTimer) recTimer.textContent = '00:00';

    if (!mediaRecorder) return;

    const mr = mediaRecorder; // capture for closure
    mediaRecorder = null;

    mr.stop();
    stream.getTracks().forEach(t => t.stop());

    if (send) {
        mr.onstop = () => {
            const mime = mr.mimeType || 'audio/webm';
            const ext  = mime.includes('ogg') ? '.ogg' : mime.includes('mp4') ? '.m4a' : '.webm';
            const blob = new Blob(audioChunks, { type: mime });
            const file = new File([blob], `voice-${Date.now()}${ext}`, { type: mime });
            uploadFile(file, receiverUsername, chatSocket);
        };
    }
}

// ── Toast helper ──────────────────────────────────────────────────────────────
function showToast(msg, type = 'error') {
    const container = document.getElementById('notification-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `alert alert-${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

// ── HTML escape ───────────────────────────────────────────────────────────────
function escapeHTML(str) {
    if (!str) return '';
    return String(str).replace(/[&<>'"]/g, t =>
        ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[t])
    );
}
