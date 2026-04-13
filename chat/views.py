from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth.decorators import login_required
from django.contrib.auth import login, logout, authenticate
from django.contrib.auth.models import User
from django.contrib import messages
from .forms import UserRegistrationForm, UserLoginForm
from .models import Message, UserProfile


def register_view(request):
    if request.user.is_authenticated:
        return redirect('user_list')

    if request.method == 'POST':
        form = UserRegistrationForm(request.POST)
        if form.is_valid():
            user = form.save()
            # Ensure profile is created
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
                # Ensure profile exists on login
                UserProfile.objects.get_or_create(user=user)
                # Mark them online when they log in
                profile, _ = UserProfile.objects.get_or_create(user=user)
                profile.is_online = True
                profile.save()
                login(request, user)
                return redirect('user_list')
    else:
        form = UserLoginForm()
    return render(request, 'chat/login.html', {'form': form})


def logout_view(request):
    # Mark offline on logout
    if request.user.is_authenticated:
        profile, _ = UserProfile.objects.get_or_create(user=request.user)
        profile.is_online = False
        profile.save()
    logout(request)
    return redirect('login')


@login_required
def user_list_view(request):
    # Ensure current user's profile exists and they are marked online
    profile, _ = UserProfile.objects.get_or_create(user=request.user)
    profile.is_online = True
    profile.save()

    # Get all users except the current user, with safe profile access
    all_users = User.objects.exclude(id=request.user.id)

    # Build list with safe profile checking
    users_with_status = []
    for u in all_users:
        user_profile, _ = UserProfile.objects.get_or_create(user=u)
        users_with_status.append({
            'user': u,
            'is_online': user_profile.is_online,
        })

    return render(request, 'chat/user_list.html', {'users': users_with_status})


@login_required
def chat_room_view(request, username):
    other_user = get_object_or_404(User, username=username)

    # Ensure both users have profiles
    UserProfile.objects.get_or_create(user=request.user)
    other_profile, _ = UserProfile.objects.get_or_create(user=other_user)

    # Calculate room name for history
    sorted_usernames = sorted([request.user.username, other_user.username])
    room_name = f"chat_{sorted_usernames[0]}_{sorted_usernames[1]}"

    # Fetch and decrypt chat history
    db_messages = Message.objects.filter(room_name=room_name).order_by('timestamp')
    chat_history = []
    for msg in db_messages:
        chat_history.append({
            'sender': msg.sender.username,
            'content': msg.get_content(),
            'timestamp': msg.timestamp,
        })

    return render(request, 'chat/chat.html', {
        'other_user': other_user,
        'other_is_online': other_profile.is_online,
        'chat_history': chat_history,
    })
