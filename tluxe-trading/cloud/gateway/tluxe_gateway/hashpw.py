"""Create the owner password hash for TLUXE_OWNER_PASSWORD_HASH (the password itself is never stored).

    python -m tluxe_gateway.hashpw            scrypt (PBKDF2-SHA256 automatically when this Python lacks hashlib.scrypt)
    python -m tluxe_gateway.hashpw --pbkdf2   PBKDF2-HMAC-SHA256, 600,000 iterations

The password is read with getpass (not echoed, never written anywhere); only the salted hash is printed.
"""
import getpass
import hashlib
import sys

from .auth import hash_password, hash_password_pbkdf2


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    pw = getpass.getpass("New TLUXE owner password (min 14 characters): ")
    if len(pw) < 14:
        print("Too short - use at least 14 characters.", file=sys.stderr)
        return 2
    if getpass.getpass("Repeat: ") != pw:
        print("Passwords do not match.", file=sys.stderr)
        return 2
    use_pbkdf2 = "--pbkdf2" in args or not hasattr(hashlib, "scrypt")
    print(hash_password_pbkdf2(pw) if use_pbkdf2 else hash_password(pw))
    return 0


if __name__ == "__main__":
    sys.exit(main())
