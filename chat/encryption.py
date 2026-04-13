from cryptography.fernet import Fernet
from django.conf import settings
import logging

logger = logging.getLogger(__name__)

fernet = None

def get_fernet():
    global fernet
    if fernet is None:
        try:
            key = settings.ENCRYPTION_KEY
            if isinstance(key, str):
                key = key.encode()
            fernet = Fernet(key)
        except Exception as e:
            logger.error(f"Failed to initialize Fernet: {e}")
            raise RuntimeError(f"Encryption setup failed. Invalid ENCRYPTION_KEY? {e}")
    return fernet

def encrypt_message(text: str) -> str:
    """Encrypts a plaintext string and returns a URL-safe base64-encoded URL-safe string token."""
    f = get_fernet()
    return f.encrypt(text.encode('utf-8')).decode('utf-8')

def decrypt_message(token: str) -> str:
    """Decrypts a Fernet token and returns the plaintext string."""
    f = get_fernet()
    try:
        return f.decrypt(token.encode('utf-8')).decode('utf-8')
    except Exception as e:
        logger.error(f"Failed to decrypt message: {e}")
        return "[Decryption Error]"
