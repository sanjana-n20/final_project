from django.db import models
from django.contrib.auth.models import User
from .encryption import encrypt_message, decrypt_message

class UserProfile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='profile')
    is_online = models.BooleanField(default=False)
    
    def __str__(self):
        return f"{self.user.username}'s Profile"

class Message(models.Model):
    sender = models.ForeignKey(User, on_delete=models.CASCADE, related_name='sent_messages')
    receiver = models.ForeignKey(User, on_delete=models.CASCADE, related_name='received_messages')
    room_name = models.CharField(max_length=255, db_index=True)
    encrypted_content = models.TextField()
    timestamp = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['timestamp']

    def set_content(self, text: str):
        """Encrypt and set the message content."""
        self.encrypted_content = encrypt_message(text)

    def get_content(self) -> str:
        """Decrypt and return the message content."""
        return decrypt_message(self.encrypted_content)

    def __str__(self):
        return f"{self.sender} -> {self.receiver} [{self.timestamp}]"

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
