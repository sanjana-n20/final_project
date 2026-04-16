import json
import os
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.contrib.auth.models import User
from django.utils import timezone
from .models import Message, UserProfile


class ChatConsumer(AsyncWebsocketConsumer):

    async def connect(self):
        self.user = self.scope["user"]
        self.other_username = self.scope['url_route']['kwargs']['username']

        # Close if not authenticated
        if not self.user.is_authenticated:
            await self.close()
            return

        # Create unique, deterministic room name
        users = sorted([self.user.username, self.other_username])
        self.room_name = f"chat_{users[0]}_{users[1]}"
        self.room_group_name = self.room_name

        # Join channel group
        await self.channel_layer.group_add(self.room_group_name, self.channel_name)
        await self.accept()

        print("CONNECTED:", self.user.username)

        # Mark online
        await self.set_online_status(True)

        # Notify peers of online status
        await self.channel_layer.group_send(self.room_group_name, {
            "type": "status_update",
            "user": self.user.username,
            "is_online": True,
        })

        # Send other user's current status to this connection
        other_status = await self.get_user_online_status(self.other_username)
        await self.send(text_data=json.dumps({
            "action": "status",
            "user": self.other_username,
            "is_online": other_status,
        }))

        # Mark pending messages as delivered
        await self.mark_messages_delivered()

    async def disconnect(self, close_code):
        print("DISCONNECTED:", self.user)

        if self.user.is_authenticated:
            await self.set_online_status(False)
            await self.set_last_seen()

            await self.channel_layer.group_send(self.room_group_name, {
                "type": "status_update",
                "user": self.user.username,
                "is_online": False,
            })

        await self.channel_layer.group_discard(self.room_group_name, self.channel_name)

    async def receive(self, text_data):
        data = json.loads(text_data)
        action = data.get("action")

        # ── Text Message ──────────────────────────────────────────────────────
        if action == "message":
            text = data.get("message", "").strip()
            if not text:
                return

            msg = await self.save_message(text)
            decrypted_text = await self.get_message_content(msg)

            await self.channel_layer.group_send(self.room_group_name, {
                "type": "chat_message",
                "message": decrypted_text,
                "sender": self.user.username,
                "timestamp": msg.timestamp.isoformat(),
                "message_id": msg.id,
                "status": msg.status,
            })

        # ── Typing Indicator ──────────────────────────────────────────────────
        elif action == "typing":
            await self.channel_layer.group_send(self.room_group_name, {
                "type": "typing_status",
                "user": self.user.username,
                "is_typing": data.get("is_typing", False),
            })

        # ── Media Notification (after HTTP upload) ─────────────────────────
        elif action == "media_notify":
            message_id = data.get("message_id")
            if not message_id:
                return

            media_data = await self.get_media_message_data(message_id)
            if not media_data:
                return

            await self.channel_layer.group_send(self.room_group_name, {
                "type": "chat_media",
                **media_data,
            })

        # ── Message Delivered ─────────────────────────────────────────────────
        elif action == "delivered":
            message_id = data.get("message_id")
            if message_id:
                await self.update_message_status(message_id, "delivered")
                await self.channel_layer.group_send(self.room_group_name, {
                    "type": "msg_status_update",
                    "message_id": message_id,
                    "status": "delivered",
                })

        # ── Message Seen ──────────────────────────────────────────────────────
        elif action == "seen":
            message_id = data.get("message_id")
            if message_id:
                await self.update_message_status(message_id, "seen")
                await self.channel_layer.group_send(self.room_group_name, {
                    "type": "msg_status_update",
                    "message_id": message_id,
                    "status": "seen",
                })

    # ── Group Event Handlers ──────────────────────────────────────────────────

    async def chat_message(self, event):
        await self.send(text_data=json.dumps({
            "action": "message",
            "message": event["message"],
            "sender": event["sender"],
            "timestamp": event["timestamp"],
            "message_id": event.get("message_id"),
            "status": event.get("status", "sent"),
        }))

    async def chat_media(self, event):
        """Broadcast media message metadata to both peers."""
        await self.send(text_data=json.dumps({
            "action": "media",
            "message_id": event["message_id"],
            "sender": event["sender"],
            "message_type": event["message_type"],
            "media_url": event["media_url"],
            "thumbnail_url": event.get("thumbnail_url"),
            "media_filename": event.get("media_filename"),
            "media_size": event.get("media_size"),
            "media_mime": event.get("media_mime"),
            "timestamp": event["timestamp"],
            "status": event.get("status", "sent"),
        }))

    async def typing_status(self, event):
        if event["user"] != self.user.username:
            await self.send(text_data=json.dumps({
                "action": "typing",
                "user": event["user"],
                "is_typing": event["is_typing"],
            }))

    async def status_update(self, event):
        if event["user"] != self.user.username:
            await self.send(text_data=json.dumps({
                "action": "status",
                "user": event["user"],
                "is_online": event["is_online"],
            }))

    async def msg_status_update(self, event):
        """Push message status tick change to all peers."""
        await self.send(text_data=json.dumps({
            "action": "msg_status",
            "message_id": event["message_id"],
            "status": event["status"],
        }))

    # ── Database Helpers ──────────────────────────────────────────────────────

    @database_sync_to_async
    def save_message(self, text):
        other_user = User.objects.get(username=self.other_username)
        msg = Message.objects.create(
            sender=self.user,
            receiver=other_user,
            room_name=self.room_name,
            message_type='text',
            status='sent',
        )
        msg.set_content(text)
        msg.save()
        return msg

    @database_sync_to_async
    def get_message_content(self, msg):
        return msg.get_content()

    @database_sync_to_async
    def set_online_status(self, status):
        profile, _ = UserProfile.objects.get_or_create(user=self.user)
        profile.is_online = status
        profile.save()

    @database_sync_to_async
    def set_last_seen(self):
        profile, _ = UserProfile.objects.get_or_create(user=self.user)
        profile.last_seen = timezone.now()
        profile.save()

    @database_sync_to_async
    def get_user_online_status(self, username):
        try:
            user = User.objects.get(username=username)
            profile, _ = UserProfile.objects.get_or_create(user=user)
            return profile.is_online
        except User.DoesNotExist:
            return False

    @database_sync_to_async
    def mark_messages_delivered(self):
        """Mark all sent (unread) messages from the other user as delivered."""
        try:
            other_user = User.objects.get(username=self.other_username)
            Message.objects.filter(
                sender=other_user,
                receiver=self.user,
                status='sent',
            ).update(status='delivered')
        except User.DoesNotExist:
            pass

    @database_sync_to_async
    def update_message_status(self, message_id, status):
        try:
            msg = Message.objects.get(id=message_id)
            # Only upgrade status (sent → delivered → seen)
            order = ['sent', 'delivered', 'seen']
            if order.index(status) > order.index(msg.status):
                msg.status = status
                msg.save(update_fields=['status'])
        except Message.DoesNotExist:
            pass

    @database_sync_to_async
    def get_media_message_data(self, message_id):
        try:
            msg = Message.objects.get(id=message_id)
            # Only allow sender or receiver to broadcast
            if msg.sender != self.user and msg.receiver != self.user:
                return None

            thumb_url = None
            if msg.thumbnail and msg.thumbnail.name:
                # Normalize Windows backslashes to forward slashes for URLs
                normalized_path = msg.thumbnail.name.replace('\\', '/')
                thumb_url = f"/media/{normalized_path}"

            return {
                "message_id": msg.id,
                "sender": msg.sender.username,
                "message_type": msg.message_type,
                "media_url": f"/chat/media/{msg.id}/download/",
                "thumbnail_url": thumb_url,
                "media_filename": msg.media_filename,
                "media_size": msg.media_size,
                "media_mime": msg.media_mime,
                "timestamp": msg.timestamp.isoformat(),
                "status": msg.status,
            }
        except Message.DoesNotExist:
            return None