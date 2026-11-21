#!/usr/bin/env python3
"""Receive bounded clipboard images for the existing read-only container mount."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import time

MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_CACHE_BYTES = 128 * 1024 * 1024
RETENTION_SECONDS = 7 * 24 * 60 * 60
NAME = re.compile(r"[a-f0-9-]{36}\.(?:png|jpg)")


def main():
    signal.alarm(45)
    os.umask(0o077)
    directory = Path(__file__).resolve().parent / "clipboard-images"
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("Invalid clipboard image directory.")
    with open(directory / ".upload.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        entries = {}
        for entry in directory.iterdir():
            if not NAME.fullmatch(entry.name):
                continue
            info = entry.lstat()
            if not stat.S_ISREG(info.st_mode):
                raise ValueError("Unexpected clipboard cache entry.")
            if time.time() - info.st_mtime > RETENTION_SECONDS:
                entry.unlink()
            else:
                entries[entry.name] = info.st_size
        if sys.argv[1:] == ["cleanup"]:
            return
        if len(sys.argv) != 4 or not NAME.fullmatch(sys.argv[1]):
            raise ValueError("Invalid clipboard image arguments.")
        name, length, digest = sys.argv[1:]
        length = int(length)
        if not 0 < length <= MAX_IMAGE_BYTES or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("Invalid clipboard image size or checksum.")
        if sum(entries.values()) - entries.get(name, 0) + length > MAX_CACHE_BYTES:
            raise ValueError("Remote clipboard cache is full (128 MiB). Old images expire after seven days.")
        data = sys.stdin.buffer.read(length + 1)
        if len(data) != length or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError("Clipboard image transfer was incomplete.")
        if not ((name.endswith(".png") and data.startswith(b"\x89PNG\r\n\x1a\n")) or (name.endswith(".jpg") and data.startswith(b"\xff\xd8\xff"))):
            raise ValueError("Unsupported clipboard image format.")
        temporary = directory / ".incoming"
        # Refuse links and replace only our own bounded, private cache file.
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(data)
            os.replace(temporary, directory / name)
        finally:
            temporary.unlink(missing_ok=True)
        print(json.dumps({"name": name, "containerPath": f"/opt/windows-mcp/clipboard-images/{name}"}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
