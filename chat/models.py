from django.db import models
from django.contrib.auth.models import User
from .encryption import encrypt_message, decrypt_message


MESSAGE_TYPES = [
    ('text',  'Text'),
    ('image', 'Image'),
    ('audio', 'Audio'),
    ('video', 'Video'),
]

MESSAGE_STATUS = [
    ('sent',      'Sent'),
    ('delivered', 'Delivered'),
    ('seen',      'Seen'),
]


class UserProfile(models.Model):
    user      = models.OneToOneField(User, on_delete=models.CASCADE, related_name='profile')
    is_online = models.BooleanField(default=False)
    last_seen = models.DateTimeField(null=True, blank=True)
    avatar    = models.ImageField(upload_to='avatars/', null=True, blank=True)

    def __str__(self):
        return f"{self.user.username}'s Profile"


class Message(models.Model):
    sender    = models.ForeignKey(User, on_delete=models.CASCADE, related_name='sent_messages')
    receiver  = models.ForeignKey(User, on_delete=models.CASCADE, related_name='received_messages')
    room_name = models.CharField(max_length=255, db_index=True)

    # ── Text (encrypted with Fernet) ──────────────────────────────────────────
    encrypted_content = models.TextField(blank=True, default='')

    # ── Common ────────────────────────────────────────────────────────────────
    message_type = models.CharField(max_length=10, choices=MESSAGE_TYPES, default='text')
    timestamp    = models.DateTimeField(auto_now_add=True, db_index=True)
    status       = models.CharField(max_length=10, choices=MESSAGE_STATUS, default='sent')

    # ── Media (all nullable — existing rows unaffected) ───────────────────────
    media_file     = models.FileField(upload_to='chat/media/', null=True, blank=True)
    media_filename = models.CharField(max_length=255, null=True, blank=True)
    media_size     = models.PositiveIntegerField(null=True, blank=True)    # bytes
    media_mime     = models.CharField(max_length=100, null=True, blank=True)
    # AES key (Fernet-wrapped) + nonce stored as base64 strings
    media_aes_key   = models.TextField(null=True, blank=True)
    media_aes_nonce = models.TextField(null=True, blank=True)
    # Auto-generated thumbnail for images
    thumbnail = models.ImageField(upload_to='chat/thumbnails/', null=True, blank=True)

    class Meta:
        ordering = ['timestamp']

    # ── Text encryption helpers ───────────────────────────────────────────────
    def set_content(self, text: str):
        """Encrypt and set the message content."""
        self.encrypted_content = encrypt_message(text)

    def get_content(self) -> str:
        """Decrypt and return the message content."""
        if not self.encrypted_content:
            return ''
        return decrypt_message(self.encrypted_content)

    def __str__(self):
        return f"{self.sender} -> {self.receiver} [{self.timestamp}] ({self.message_type})"


# ── Auto-create UserProfile signals ───────────────────────────────────────────
from django.db.models.signals import post_save
from django.dispatch import receiver


@receiver(post_save, sender=User)
def create_user_profile(sender, instance, created, **kwargs):
    if created:
        UserProfile.objects.create(user=instance)


@receiver(post_save, sender=User)
def save_user_profile(sender, instance, **kwargs):
    try:
        instance.profile.save()
    except UserProfile.DoesNotExist:
        UserProfile.objects.create(user=instance)
