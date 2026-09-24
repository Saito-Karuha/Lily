"""Shared pty driver for the TUI tests: spawns `lily` in a pseudo-terminal of a given size,
answers the terminal queries a real terminal would, and keeps a VT screen model."""
import os
import pty
import re
import select
import struct
import subprocess
import sys
import tempfile
import time
import fcntl
import termios

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vt import Screen  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ANSI = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)")

KEYS = {
    "enter": b"\r", "esc": b"\x1b", "up": b"\x1b[A", "down": b"\x1b[B", "right": b"\x1b[C", "left": b"\x1b[D",
    "tab": b"\t", "backspace": b"\x7f", "ctrl+c": b"\x03", "ctrl+d": b"\x04", "ctrl+l": b"\x0c", "ctrl+o": b"\x0f",
    "ctrl+t": b"\x14", "shift+enter": b"\x1b[13;2u", "alt+enter": b"\x1b\r",
}


def strip(text):
    return ANSI.sub("", text)


class Lily:
    def __init__(self, args, cwd, env=None, width=100, height=30, clean_env=False):
        self.width, self.height = width, height
        self.screen = Screen(width, height)
        self.raw = b""
        base = {k: v for k, v in os.environ.items() if clean_env is False or k in ("PATH", "HOME", "USER", "LANG", "TMPDIR", "SHELL")}
        child_env = dict(base, TERM="xterm-256color", COLUMNS=str(width), LINES=str(height))
        child_env.pop("COLORTERM", None)
        child_env.update(env or {})
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe("node", ["node", os.path.join(ROOT, "bin/lily.mjs"), *args], child_env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
        self.exit_status = None

    def pump(self, seconds):
        """Reads output for `seconds`, answering device-attribute queries like a real terminal."""
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if not r:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                return False
            if not chunk:
                return False
            self.raw += chunk
            self.screen.feed(chunk)
            if b"\x1b[c" in chunk:
                os.write(self.fd, b"\x1b[?62;22c")
        return True

    def wait_for(self, pattern, timeout=15, where="screen"):
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.1)
            if re.search(pattern, self.view(where)):
                return True
        return False

    def view(self, where="screen"):
        if where == "screen":
            return self.screen.text()
        if where == "history":
            return self.screen.history()
        return strip(self.raw.decode("utf8", "replace"))

    def type(self, text, delay=0.03):
        """Types like a person, one character at a time."""
        for ch in text:
            os.write(self.fd, ch.encode())
            self.pump(delay)

    def key(self, name, pause=0.25):
        os.write(self.fd, KEYS[name])
        self.pump(pause)

    def submit(self, text):
        self.type(text)
        self.pump(0.3)
        self.key("enter")

    def wait_exit(self, timeout=10):
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.1)
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.exit_status = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
                return self.exit_status
        return None

    def kill(self):
        try:
            os.kill(self.pid, 9)
            os.waitpid(self.pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass


def temp_dirs(prefix="lily-tui"):
    return tempfile.mkdtemp(prefix=f"{prefix}-home-"), tempfile.mkdtemp(prefix=f"{prefix}-ws-")
