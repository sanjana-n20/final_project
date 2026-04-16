from cryptography.fernet import Fernet
from django.conf import settings
from Crypto.Cipher import AES
from Crypto.Random import get_random_bytes
import base64
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
    """Encrypts a plaintext string and returns a URL-safe base64-encoded token."""
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


# ─── AES-256-GCM Media Encryption ─────────────────────────────────────────────

def encrypt_media_bytes(data: bytes):
    """
    Encrypt binary media data with AES-256-GCM.
    Returns (ciphertext_with_tag: bytes, key_b64: str, nonce_b64: str).
    The key_b64 should be wrapped with Fernet before storing in DB.
    """
    key = get_random_bytes(32)          # 256-bit AES key
    cipher = AES.new(key, AES.MODE_GCM)
    ciphertext, tag = cipher.encrypt_and_digest(data)
    # Pack ciphertext + 16-byte GCM tag together
    encrypted_blob = ciphertext + tag
    key_b64 = base64.b64encode(key).decode('utf-8')
    nonce_b64 = base64.b64encode(cipher.nonce).decode('utf-8')
    return encrypted_blob, key_b64, nonce_b64


def decrypt_media_bytes(ciphertext_with_tag: bytes, key_b64: str, nonce_b64: str) -> bytes:
    """
    Decrypt AES-256-GCM encrypted media blob.
    The key_b64 should already be unwrapped (decrypted from Fernet) before calling.
    """
    key = base64.b64decode(key_b64)
    nonce = base64.b64decode(nonce_b64)
    # Last 16 bytes is the GCM authentication tag
    ciphertext = ciphertext_with_tag[:-16]
    tag = ciphertext_with_tag[-16:]
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    return cipher.decrypt_and_verify(ciphertext, tag)


def wrap_aes_key(key_b64: str) -> str:
    """Encrypt the raw AES key with Fernet before storing it in the database."""
    f = get_fernet()
    return f.encrypt(key_b64.encode('utf-8')).decode('utf-8')


def unwrap_aes_key(wrapped_key: str) -> str:
    """Decrypt the Fernet-wrapped AES key retrieved from the database."""
    f = get_fernet()
    return f.decrypt(wrapped_key.encode('utf-8')).decode('utf-8')
