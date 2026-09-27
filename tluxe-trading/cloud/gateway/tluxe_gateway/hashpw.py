"""Create the owner password hash for TLUXE_OWNER_PASSWORD_HASH (the password itself is never stored).

    python -m tluxe_gateway.hashpw
"""
import getpass
import sys

from .auth import hash_password


def main() -> int:
    pw = getpass.getpass("New TLUXE owner password (min 14 characters): ")
    if len(pw) < 14:
        print("Too short - use at least 14 characters.", file=sys.stderr)
        return 2
    if getpass.getpass("Repeat: ") != pw:
        print("Passwords do not match.", file=sys.stderr)
        return 2
    print(hash_password(pw))
    return 0


if __name__ == "__main__":
    sys.exit(main())
