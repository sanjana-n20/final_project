import os
import django
import sys

# Setup django environment
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from django.contrib.auth.models import User

# Create user 1
if not User.objects.filter(username='alice').exists():
    User.objects.create_user('alice', 'alice@example.com', 'password123')
    print("Created user: alice")
else:
    print("User alice already exists")

# Create user 2 
if not User.objects.filter(username='bob').exists():
    User.objects.create_user('bob', 'bob@example.com', 'password123')
    print("Created user: bob")
else:
    print("User bob already exists")
    
sys.exit(0)
