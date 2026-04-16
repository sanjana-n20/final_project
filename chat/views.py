import os
import io
import mimetypes
from pathlib import Path

from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth.decorators import login_required
from django.contrib.auth import login, logout, authenticate
from django.contrib.auth.models import User
from django.contrib import messages
from django.http import JsonResponse, FileResponse, Http404
from django.views.decorators.http import require_POST, require_GET
from django.views.decorators.csrf import csrf_exempt
from django.conf import settings
from django.utils import timezone

from .forms import UserRegistrationForm, UserLoginForm
from .models import Message, UserProfile
from .encryption import encrypt_media_bytes, decrypt_media_bytes, wrap_aes_key, unwrap_aes_key

# ── Allowed types & extension map ─────────────────────────────────────────────
ALLOWED_MEDIA_TYPES = getattr(settings, 'ALLOWED_MEDIA_TYPES', {
    'image': ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    'audio': ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/x-m4a'],
    'video': ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'],
})
ALLOWED_EXTENSIONS = getattr(settings, 'ALLOWED_EXTENSIONS', {
    'image': ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
    'audio': ['.mp3', '.ogg', '.wav', '.webm', '.m4a'],
    'video': ['.mp4', '.webm', '.ogv', '.mov'],
})
MAX_UPLOAD_MB = getattr(settings, 'MAX_UPLOAD_MB', 25)

# Build reverse lookup: mime -> category
MIME_TO_CATEGORY = {}
for cat, mimes in ALLOWED_MEDIA_TYPES.items():
    for m in mimes:
        MIME_TO_CATEGORY[m] = cat

EXT_TO_CATEGORY = {}
for cat, exts in ALLOWED_EXTENSIONS.items():
    for e in exts:
        EXT_TO_CATEGORY[e] = cat


# ─────────────────────────────────────────────────────────────────────────────
# Auth Views
# ─────────────────────────────────────────────────────────────────────────────

def register_view(request):
    if request.user.is_authenticated:
        return redirect('user_list')

    if request.method == 'POST':
        form = UserRegistrationForm(request.POST)
        if form.is_valid():
            user = form.save()
            UserProfile.objects.get_or_create(user=user)
            login(request, user)
            messages.success(request, f"Welcome, {user.username}! Your account has been created.")
            return redirect('user_list')
    else:
        form = UserRegistrationForm()
    return render(request, 'chat/register.html', {'form': form})


def login_view(request):
    if request.user.is_authenticated:
        return redirect('user_list')

    if request.method == 'POST':
        form = UserLoginForm(request, data=request.POST)
        if form.is_valid():
            username = form.cleaned_data.get('username')
            password = form.cleaned_data.get('password')
            user = authenticate(username=username, password=password)
            if user is not None:
                profile, _ = UserProfile.objects.get_or_create(user=user)
                profile.is_online = True
                profile.save()
                login(request, user)
                return redirect('user_list')
    else:
        form = UserLoginForm()
    return render(request, 'chat/login.html', {'form': form})


def logout_view(request):
    if request.user.is_authenticated:
        profile, _ = UserProfile.objects.get_or_create(user=request.user)
        profile.is_online = False
        profile.last_seen = timezone.now()
        profile.save()
    logout(request)
    return redirect('login')


# ─────────────────────────────────────────────────────────────────────────────
# Chat Views
# ─────────────────────────────────────────────────────────────────────────────

@login_required
def user_list_view(request):
    profile, _ = UserProfile.objects.get_or_create(user=request.user)
    profile.is_online = True
    profile.save()

    all_users = User.objects.exclude(id=request.user.id)
    users_with_status = []
    for u in all_users:
        user_profile, _ = UserProfile.objects.get_or_create(user=u)
        users_with_status.append({
            'user': u,
            'is_online': user_profile.is_online,
            'last_seen': user_profile.last_seen,
        })

    return render(request, 'chat/user_list.html', {'users': users_with_status})


@login_required
def chat_room_view(request, username):
    other_user = get_object_or_404(User, username=username)
    UserProfile.objects.get_or_create(user=request.user)
    other_profile, _ = UserProfile.objects.get_or_create(user=other_user)

    sorted_usernames = sorted([request.user.username, other_user.username])
    room_name = f"chat_{sorted_usernames[0]}_{sorted_usernames[1]}"

    db_messages = Message.objects.filter(room_name=room_name).order_by('timestamp')
    chat_history = []
    for msg in db_messages:
        entry = {
            'sender': msg.sender.username,
            'timestamp': msg.timestamp,
            'message_type': msg.message_type,
            'message_id': msg.id,
            'status': msg.status,
        }
        if msg.message_type == 'text':
            entry['content'] = msg.get_content()
        else:
            entry['media_url'] = f"/chat/media/{msg.id}/download/"
            entry['media_filename'] = msg.media_filename
            entry['media_size'] = msg.media_size
            entry['media_mime'] = msg.media_mime
            if msg.thumbnail and msg.thumbnail.name:
                entry['thumbnail_url'] = f"/media/{msg.thumbnail.name}"
            else:
                entry['thumbnail_url'] = None
        chat_history.append(entry)

    return render(request, 'chat/chat.html', {
        'other_user': other_user,
        'other_is_online': other_profile.is_online,
        'other_last_seen': other_profile.last_seen,
        'chat_history': chat_history,
    })


# ─────────────────────────────────────────────────────────────────────────────
# Media Upload (POST /chat/upload/)
# ─────────────────────────────────────────────────────────────────────────────

@login_required
@require_POST
def media_upload_view(request):
    """
    Accepts multipart upload. Encrypts file with AES-256-GCM, stores on disk.
    Returns JSON metadata for the WebSocket media_notify flow.
    """
    uploaded_file = request.FILES.get('file')
    receiver_username = request.POST.get('receiver')

    if not uploaded_file or not receiver_username:
        return JsonResponse({'error': 'Missing file or receiver.'}, status=400)

    # ── Size validation ───────────────────────────────────────────────────────
    max_bytes = MAX_UPLOAD_MB * 1024 * 1024
    if uploaded_file.size > max_bytes:
        return JsonResponse({'error': f'File too large. Max {MAX_UPLOAD_MB} MB.'}, status=413)

    # ── Extension & MIME validation ───────────────────────────────────────────
    original_name = uploaded_file.name
    ext = Path(original_name).suffix.lower()
    content_type = uploaded_file.content_type or mimetypes.guess_type(original_name)[0] or ''
    content_type = content_type.lower().split(';')[0].strip()

    category_from_ext  = EXT_TO_CATEGORY.get(ext)
    category_from_mime = MIME_TO_CATEGORY.get(content_type)

    if not category_from_ext and not category_from_mime:
        return JsonResponse({'error': 'File type not allowed.'}, status=415)

    message_type = category_from_mime or category_from_ext

    # ── Retrieve receiver ─────────────────────────────────────────────────────
    try:
        receiver = User.objects.get(username=receiver_username)
    except User.DoesNotExist:
        return JsonResponse({'error': 'Receiver not found.'}, status=404)

    sorted_usernames = sorted([request.user.username, receiver_username])
    room_name = f"chat_{sorted_usernames[0]}_{sorted_usernames[1]}"

    # ── Encrypt file bytes ────────────────────────────────────────────────────
    raw_bytes = uploaded_file.read()
    encrypted_blob, aes_key_b64, nonce_b64 = encrypt_media_bytes(raw_bytes)
    wrapped_key = wrap_aes_key(aes_key_b64)

    # ── Save encrypted file to MEDIA_ROOT ────────────────────────────────────
    save_dir = os.path.join(settings.MEDIA_ROOT, 'chat', 'media')
    os.makedirs(save_dir, exist_ok=True)

    from django.utils.crypto import get_random_string
    safe_filename = f"{get_random_string(16)}{ext}"
    save_path = os.path.join(save_dir, safe_filename)

    with open(save_path, 'wb') as f:
        f.write(encrypted_blob)

    # Ensure forward slashes for database storage to keep media URL generation clean
    relative_path = f"chat/media/{safe_filename}"

    # ── Generate thumbnail for images ─────────────────────────────────────────
    thumbnail_url = None
    thumbnail_relative = None
    if message_type == 'image':
        try:
            from PIL import Image
            img = Image.open(io.BytesIO(raw_bytes))
            img.thumbnail((400, 400))
            thumb_dir = os.path.join(settings.MEDIA_ROOT, 'chat', 'thumbnails')
            os.makedirs(thumb_dir, exist_ok=True)
            thumb_name = f"thumb_{get_random_string(16)}.webp"
            thumb_path = os.path.join(thumb_dir, thumb_name)
            img.save(thumb_path, 'WEBP', quality=75)
            # Ensure URL paths use forward slashes even on Windows
            thumbnail_relative = f"chat/thumbnails/{thumb_name}"
            thumbnail_url = f"/media/{thumbnail_relative}"
        except Exception as e:
            print(f"Thumbnail error: {e}")
            pass  # Thumbnail is optional

    # ── Create Message record ─────────────────────────────────────────────────
    msg = Message(
        sender=request.user,
        receiver=receiver,
        room_name=room_name,
        message_type=message_type,
        media_filename=original_name,
        media_size=uploaded_file.size,
        media_mime=content_type,
        media_aes_key=wrapped_key,
        media_aes_nonce=nonce_b64,
        status='sent',
    )
    msg.media_file.name = relative_path
    if thumbnail_relative:
        msg.thumbnail.name = thumbnail_relative
    msg.save()

    return JsonResponse({
        'message_id': msg.id,
        'message_type': message_type,
        'media_url': f"/chat/media/{msg.id}/download/",
        'thumbnail_url': thumbnail_url,
        'media_filename': original_name,
        'media_size': uploaded_file.size,
        'media_mime': content_type,
        'sender': request.user.username,
        'timestamp': msg.timestamp.isoformat(),
        'status': msg.status,
    })


# ─────────────────────────────────────────────────────────────────────────────
# Media Download (GET /chat/media/<id>/download/)
# ─────────────────────────────────────────────────────────────────────────────

@login_required
@require_GET
def media_download_view(request, msg_id):
    """Decrypts and streams the requested media file to the authenticated user."""
    msg = get_object_or_404(Message, id=msg_id)

    # Authorization: only sender or receiver may download
    if request.user != msg.sender and request.user != msg.receiver:
        raise Http404

    if msg.message_type == 'text' or not msg.media_file:
        raise Http404

    # ── Decrypt ───────────────────────────────────────────────────────────────
    file_path = os.path.join(settings.MEDIA_ROOT, msg.media_file.name)
    if not os.path.exists(file_path):
        raise Http404

    with open(file_path, 'rb') as f:
        encrypted_blob = f.read()

    try:
        aes_key_b64 = unwrap_aes_key(msg.media_aes_key)
        plain_bytes = decrypt_media_bytes(encrypted_blob, aes_key_b64, msg.media_aes_nonce)
    except Exception:
        raise Http404

    # ── Stream response ───────────────────────────────────────────────────────
    response = FileResponse(
        io.BytesIO(plain_bytes),
        content_type=msg.media_mime or 'application/octet-stream',
    )
    safe_name = msg.media_filename or 'download'
    response['Content-Disposition'] = f'inline; filename="{safe_name}"'
    response['Content-Length'] = len(plain_bytes)
    return response


# ─────────────────────────────────────────────────────────────────────────────
# Mark Seen (POST /chat/messages/<id>/seen/)
# ─────────────────────────────────────────────────────────────────────────────

@login_required
@require_POST
def mark_message_seen_view(request, msg_id):
    msg = get_object_or_404(Message, id=msg_id, receiver=request.user)
    if msg.status != 'seen':
        msg.status = 'seen'
        msg.save(update_fields=['status'])
    return JsonResponse({'ok': True, 'message_id': msg.id, 'status': 'seen'})
