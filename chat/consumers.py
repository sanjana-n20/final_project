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

        # Create unique room
        sorted_usernames = sorted([self.user.username, self.other_username])
        self.room_name = f"chat_{sorted_usernames[0]}_{sorted_usernames[1]}"
        self.room_group_name = self.room_name

        # Join group
        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )

        await self.accept()
        print("CONNECTED:", self.user.username)

        # Set online
        await self.set_online_status(True)

        # Notify others
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                'type': 'status_update',
                'user': self.user.username,
                'is_online': True
            }
        )

        # Send other user status
        other_status = await self.get_user_online_status(self.other_username)
        await self.send(text_data=json.dumps({
            'action': 'status',
            'user': self.other_username,
            'is_online': other_status
        }))


    async def disconnect(self, close_code):
        print("DISCONNECTED:", self.user)

        if self.user.is_authenticated:
            await self.set_online_status(False)

            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'status_update',
                    'user': self.user.username,
                    'is_online': False
                }
            )

        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name
        )


    async def receive(self, text_data):
        data = json.loads(text_data)
        action = data.get('action')

        if action == 'message':
            message = data.get('message')

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
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'typing_status',
                    'user': self.user.username,
                    'is_typing': data.get('is_typing', False)
                }
            )


    async def chat_message(self, event):
        await self.send(text_data=json.dumps({
            'action': 'message',
            'message': event['message'],
            'sender': event['sender'],
            'timestamp': event['timestamp']
        }))


    async def typing_status(self, event):
        if event['user'] != self.user.username:
            await self.send(text_data=json.dumps({
                'action': 'typing',
                'user': event['user'],
                'is_typing': event['is_typing']
            }))


    async def status_update(self, event):
        if event['user'] != self.user.username:
            await self.send(text_data=json.dumps({
                'action': 'status',
                'user': event['user'],
                'is_online': event['is_online']
            }))


    # ─── DATABASE ─────────────────────────

    @database_sync_to_async
    def save_message(self, text):
        other_user = User.objects.get(username=self.other_username)
        msg = Message.objects.create(
            sender=self.user,
            receiver=other_user,
            room_name=self.room_name
        )
        msg.set_content(text)
        return msg

    @database_sync_to_async
    def set_online_status(self, status):
        profile, _ = UserProfile.objects.get_or_create(user=self.user)
        profile.is_online = status
        profile.save()

    @database_sync_to_async
    def get_user_online_status(self, username):
        try:
            user = User.objects.get(username=username)
            profile, _ = UserProfile.objects.get_or_create(user=user)
            return profile.is_online
        except User.DoesNotExist:
            return False