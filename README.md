# Secure P2P Messaging App

A WhatsApp clone built with Django, Channels (WebSockets), and Python `cryptography` (simulating end-to-end encryption).

## Features
- Real-time messaging (WebSockets)
- Typing indicators ("User is typing...")
- Online / Offline statuses
- "Simulated E2E" Message encryption in Database via Fernet (AES)
- Modern WhatsApp dark-mode aesthetic with CSS glassmorphism
- Session-based Authentication

## How to Run Locally

### 1. Prerequisites
- Python 3.10+
- Redis Server
  - Either install Redis natively or run via Docker:
    ```bash
    docker run -p 6379:6379 -d redis
    ```

### 2. Setup Database
Apply migrations to create the SQLite database:
```bash
python manage.py makemigrations
python manage.py migrate
```

### 3. Run the Development Server
```bash
python manage.py runserver
```

### 4. Test the App
1. Open http://localhost:8000 in your browser
2. Register an account (e.g., `alice`)
3. Open an **Incognito Window** or another browser
4. Open http://localhost:8000 again and register a second account (e.g., `bob`)
5. In Alice's window, click on Bob's name to open the chat.
6. Messages sent will appear instantly in Bob's window.

## Architecture & Security
- **Encryption:** Uses the symmetric `Fernet` encryption provided by `cryptography`. All messages are encrypted before they hit the database, meaning `db.sqlite3` only contains ciphertexts.
- **Rooms:** Channels rooms are determined automatically by sorting usernames (e.g. `chat_alice_bob`) to ensure both participants join the exact same unique layer.