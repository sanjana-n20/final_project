from django.urls import path
from . import views

urlpatterns = [
    # Auth
    path('register/', views.register_view, name='register'),
    path('login/', views.login_view, name='login'),
    path('logout/', views.logout_view, name='logout'),

    # Media API — must come BEFORE the <str:username> catch-all
    path('chat/upload/', views.media_upload_view, name='media_upload'),
    path('chat/media/<int:msg_id>/download/', views.media_download_view, name='media_download'),
    path('chat/messages/<int:msg_id>/seen/', views.mark_message_seen_view, name='mark_seen'),

    # Chat room — parameterised route last
    path('chat/<str:username>/', views.chat_room_view, name='chat_room'),

    # Home / contact list
    path('', views.user_list_view, name='user_list'),
]
