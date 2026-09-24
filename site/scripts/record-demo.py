"""Records a real Lily TUI session in a pseudo-terminal as an asciicast v2 file.

    python3 scripts/record-demo.py demo/storyboard.json demo/session.cast

Usually run through `npm run record-demo`, which also converts the cast into the frames the
landing page replays (scripts/record-demo.mjs). The storyboard lists what to type and what
to wait for; the driver behaves like tui_smoke.py in the repo: it answers the terminal's
DA1 query, types with human-ish delays and pauses before Enter.
"""
import codecs
import fcntl
import json
import os
import pty
import random
import re
import select
import shutil
import signal
import struct
import sys
import termios
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)

storyboard_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(SITE, "demo", "storyboard.json")
cast_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(SITE, "demo", "session.cast")
board = json.load(open(storyboard_path))
site_path = lambda p: p if os.path.isabs(p) else os.path.normpath(os.path.join(SITE, p))

cols, rows = int(board.get("cols", 92)), int(board.get("rows", 26))
lily = site_path(board.get("lily", "../bin/lily.mjs"))
script = site_path(board.get("script", "../examples/scripts/chat.json"))
workspace_src = site_path(board.get("workspace", "demo/workspace"))
workspace = board.get("workspaceDir", "/tmp/lily-demo/tidy-notes")
home = board.get("home", "/tmp/lily-demo/home")
backend = os.environ.get("LILY_DEMO_BACKEND") or board.get("backend")
random.seed(board.get("seed", 7))

# A fresh workspace (a copy of the small demo repo) and a fresh Lily home on every recording.
for path in (workspace, home):
    shutil.rmtree(path, ignore_errors=True)
shutil.copytree(workspace_src, workspace)
os.makedirs(home, exist_ok=True)

argv = ["node", lily, "--script", script] + (["--backend", backend] if backend else [])
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.chdir(workspace)
    env = dict(os.environ, LILY_HOME=home, TERM="xterm-256color", COLORTERM="truecolor", COLUMNS=str(cols), LINES=str(rows))
    env.pop("NO_COLOR", None)
    os.execvpe("node", argv, env)

start = time.time()
events = []
recording = True
decoder = codecs.getincrementaldecoder("utf-8")("replace")
screen_text = ""  # everything printed so far, escape sequences stripped (for waitFor)
last_output = time.time()
ANSI = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[_P^][^\x1b]*\x1b\\|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMNOZc]")


def stamp():
    return round(time.time() - start, 4)


def pump(seconds):
    """Reads output for `seconds`, answering the queries a real terminal would answer."""
    global screen_text, last_output
    end = time.time() + seconds
    while True:
        remaining = end - time.time()
        if remaining <= 0:
            return True
        r, _, _ = select.select([fd], [], [], min(remaining, 0.05))
        if not r:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            return False
        if not chunk:
            return False
        if b"\x1b[c" in chunk or b"\x1b[0c" in chunk:
            os.write(fd, b"\x1b[?62;22c")  # DA1: a VT220-ish terminal with ANSI colour
        text = decoder.decode(chunk)
        if text:
            last_output = time.time()
            screen_text = (screen_text + ANSI.sub("", text))[-200000:]
            if recording:
                events.append([stamp(), "o", text])


def send(data):
    if recording:
        events.append([stamp(), "i", data])
    os.write(fd, data.encode())


def wait_for(pattern, timeout):
    end = time.time() + timeout
    offset = len(screen_text)
    while time.time() < end:
        pump(0.1)
        if re.search(pattern, screen_text[max(0, offset - 4000):]) or re.search(pattern, screen_text):
            return True
    return False


def wait_idle(quiet, timeout):
    """Waits until the TUI printed nothing for `quiet` seconds (bounded by `timeout`)."""
    end = time.time() + timeout
    pump(0.2)
    while time.time() < end:
        pump(0.1)
        if time.time() - last_output >= quiet:
            return True
    return False


KEYS = {"enter": "\r", "escape": "\x1b", "tab": "\t", "up": "\x1b[A", "down": "\x1b[B", "ctrl-c": "\x03", "backspace": "\x7f"}

for step in board["steps"]:
    if "waitFor" in step:
        if not wait_for(step["waitFor"], step.get("timeout", 20)):
            print(f"record-demo: timed out waiting for {step['waitFor']!r}", file=sys.stderr)
            print(screen_text[-3000:], file=sys.stderr)
            os.kill(pid, signal.SIGKILL)
            sys.exit(1)
    elif "idle" in step:
        wait_idle(step["idle"], step.get("timeout", 30))
    elif "pause" in step:
        pump(step["pause"])
    elif "type" in step:
        for ch in step["type"]:
            send(ch)
            base = step.get("delay", 0.075)
            pump(base * (0.6 + random.random() * 0.9) + (0.12 if ch == " " and random.random() < 0.25 else 0))
    elif "key" in step:
        send(KEYS[step["key"]])
        pump(0.05)
    elif step.get("end"):
        recording = False
        break

# Leave the TUI the way a person would: Ctrl+C twice.
send("\x03")
pump(0.4)
send("\x03")
pump(1.5)
try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    pass
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass

os.makedirs(os.path.dirname(cast_path), exist_ok=True)


def redact(text):
    """Keeps the local user name and home path out of the checked-in cast (same width, so
    `ls -l` columns stay aligned)."""
    home_dir = os.path.expanduser("~")
    if len(home_dir) > 1:
        text = text.replace(home_dir, "~")
    user = os.environ.get("USER") or os.environ.get("LOGNAME") or ""
    if len(user) >= 3:
        stand = "lily".ljust(len(user))[: max(len(user), 4)]
        text = re.sub(rf"\b{re.escape(user)}\b", stand, text)
    return text


with open(cast_path, "w") as out:
    header = {
        "version": 2,
        "width": cols,
        "height": rows,
        "timestamp": int(start),
        "title": board.get("title", "lily"),
        "env": {"TERM": "xterm-256color"},
    }
    out.write(json.dumps(header) + "\n")
    for event in events:
        out.write(json.dumps([event[0], event[1], redact(event[2])], ensure_ascii=False) + "\n")
if not os.environ.get("LILY_DEMO_KEEP"):
    for path in (workspace, home):
        shutil.rmtree(path, ignore_errors=True)
print(f"record-demo: wrote {cast_path} ({len(events)} events, {events[-1][0] if events else 0:.1f}s)")
