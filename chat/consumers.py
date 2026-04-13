import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.contrib.auth.models import User
from .models import Message, UserProfile


class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user = self.scope["user"]
        self.other_username = self.scope['url_route']['kwargs']['username']

        if not self.user.is_authenticated:
            await self.close()
            return

        # Deterministic, unique room for this user pair
        sorted_usernames = sorted([self.user.username, self.other_username])
        self.room_name = f"chat_{sorted_usernames[0]}_{sorted_usernames[1]}"
        self.room_group_name = self.room_name

        # Join room group first
        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )

        await self.accept()

        try:
            # Mark self as online in DB
            await self.set_online_status(True)

            # Tell EVERYONE in the room that this user is now online
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'status_update',
                    'user': self.user.username,
                    'is_online': True
                }
            )

            # --- Key fix: immediately push the OTHER user's current DB status
            # to THIS newly connected client so the header shows the right value
            other_is_online = await self.get_user_online_status(self.other_username)
            await self.send(text_data=json.dumps({
                'action': 'status',
                'user': self.other_username,
                'is_online': other_is_online
            }))

        except Exception as e:
            print(f"[ChatConsumer.connect] Error: {e}")

    async def disconnect(self, close_code):
        if not self.user.is_authenticated:
            return

        try:
            await self.set_online_status(False)

            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'status_update',
                    'user': self.user.username,
                    'is_online': False
                }
            )
        except Exception as e:
            print(f"[ChatConsumer.disconnect] Error: {e}")
        finally:
            await self.channel_layer.group_discard(
                self.room_group_name,
                self.channel_name
            )

    async def receive(self, text_data):
        try:
            data = json.loads(text_data)
            action = data.get('action')

            if action == 'message':
                message = data['message']
                msg_obj = await self.save_message(message)

                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'chat_message',
                        'message': message,
                        'sender': self.user.username,
                        'timestamp': msg_obj.timestamp.isoformat()
                    }
                )

            elif action == 'typing':
                is_typing = data.get('is_typing', False)
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'typing_status',
                        'user': self.user.username,
                        'is_typing': is_typing
                    }
                )
        except Exception as e:
            print(f"[ChatConsumer.receive] Error: {e}")

    async def chat_message(self, event):
        await self.send(text_data=json.dumps({
            'action': 'message',
            'message': event['message'],
            'sender': event['sender'],
            'timestamp': event['timestamp']
        }))

    async def typing_status(self, event):
        # Don't echo typing back to the person who is typing
        if event['user'] != self.user.username:
            await self.send(text_data=json.dumps({
                'action': 'typing',
                'user': event['user'],
                'is_typing': event['is_typing']
            }))

    async def status_update(self, event):
        # Don't echo own status back to self
        if event['user'] != self.user.username:
            await self.send(text_data=json.dumps({
                'action': 'status',
                'user': event['user'],
                'is_online': event['is_online']
            }))

    # ── Database helpers ───────────────────────────────────────────────────────

    @database_sync_to_async
    def save_message(self, text):
        other_user = User.objects.get(username=self.other_username)
        msg = Message(
            sender=self.user,
            receiver=other_user,
            room_name=self.room_name
        )
        msg.set_content(text)
        msg.save()
        return msg

    @database_sync_to_async
    def set_online_status(self, status: bool):
        profile, _ = UserProfile.objects.get_or_create(user=self.user)
        profile.is_online = status
        profile.save()

    @database_sync_to_async
    def get_user_online_status(self, username: str) -> bool:
        """Return the current DB online status for the other user."""
        try:
            user = User.objects.get(username=username)
            profile, _ = UserProfile.objects.get_or_create(user=user)
            return profile.is_online
        except User.DoesNotExist:
            return False
