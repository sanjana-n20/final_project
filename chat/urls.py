from django.urls import path
from . import views

urlpatterns = [
    path('', views.user_list_view, name='user_list'),
    path('register/', views.register_view, name='register'),
    path('login/', views.login_view, name='login'),
    path('logout/', views.logout_view, name='logout'),
    path('chat/<str:username>/', views.chat_room_view, name='chat_room'),
]
