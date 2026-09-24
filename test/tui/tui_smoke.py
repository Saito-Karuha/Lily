"""Drives the interactive TUI in a pseudo-terminal (100x30 by default) against an offline scripted model.

Covers: the welcome header, a run with a tool card and the run footer, /env and /help,
`@` file completion, steering a running task, Esc to interrupt, the model selector
(filter + select + saved default), /thinking, the tree selector (navigate to a prompt,
editor prefilled, re-ask), /new + the resume selector, Ctrl+C twice to exit, and the
first-run setup screen with no model configured (empty LILY_HOME, no API keys).

    python3 test/tui/tui_smoke.py [--size 80x24]
"""
import json
import os
import sys

sys.dont_write_bytecode = True  # keep test/tui free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from driver import Lily, temp_dirs  # noqa: E402

ok = True
failures = []
SIZE = sys.argv[sys.argv.index("--size") + 1] if "--size" in sys.argv else "100x30"
W, H = (int(v) for v in SIZE.split("x"))


def check(name, cond):
    global ok
    print(("PASS " if cond else "FAIL ") + name, flush=True)
    if not cond:
        ok = False
        failures.append(name)


def editor_text(app):
    """Text inside the editor box: between its top border and the rule above the footer."""
    rows = app.screen.screen()
    while rows and not rows[-1].strip():
        rows.pop()
    body = rows[:-3]  # drop the footer (2 lines) and the editor's bottom border
    for i in range(len(body) - 1, -1, -1):
        if body[i].startswith("──"):
            return "\n".join(line.strip() for line in body[i + 1:])
    return ""


home, ws = temp_dirs()
open(os.path.join(ws, "hello.py"), "w").write("print('hi from workspace')\n")
# A keyless custom provider gives the model selector a second model to pick.
json.dump({"providers": {"local": {"api": "openai-completions", "baseUrl": "http://127.0.0.1:9/v1", "models": [{"id": "tiny"}]}}}, open(os.path.join(home, "config.json"), "w"))
script = os.path.join(home, "script.json")
json.dump([
    {"text": "Running it.", "toolCalls": [{"name": "bash", "arguments": {"command": "python3 hello.py"}}]},
    {"text": "It prints **hi from workspace**."},
    {"text": "Second answer."},
    {"toolCalls": [{"name": "bash", "arguments": {"command": "sleep 3; echo slow"}}]},
    {"text": "Slow done."},
    {"toolCalls": [{"name": "bash", "arguments": {"command": "sleep 30"}}]},
    {"text": "Re-asked answer."},
] + [{"text": "Spare answer."}] * 10, open(script, "w"))

app = Lily(["--script", script, "--backend", "local"], ws, {"LILY_HOME": home}, W, H)
try:
    check("banner", app.wait_for(r"Let good ideas run", 20))
    check("header shows model and environment", app.wait_for(r"scripted/script .*local \(no isolation\)", 5))
    check("footer shows the model", "scripted/script" in app.view().splitlines()[-1] or app.wait_for(r"scripted/script\s*$", 3))

    app.submit("run the script")
    check("tool card", app.wait_for(r"\$ python3 hello\.py", 20))
    check("tool output", app.wait_for(r"hi from workspace", 10))
    check("assistant reply", app.wait_for(r"It prints hi from workspace", 10))
    check("run footer", app.wait_for(r"done .*2 turns", 10))
    check("session title in footer", app.wait_for(r"• run the script", 5))

    app.submit("/env")
    check("/env shows environment", app.wait_for(r"workspace\s+\S*lily-tui-ws", 10, where="history"))
    app.submit("/help")
    check("/help lists commands", app.wait_for(r"/fork", 10, where="history"))
    check("/help lists keys", app.wait_for(r"ctrl\+o\s+expand", 5, where="history"))

    app.type("look at @hel")
    check("@ file completion", app.wait_for(r"hello\.py", 5))
    app.key("tab", 0.5)
    check("@ completion applied", "@hello.py" in editor_text(app))
    app.key("ctrl+c", 0.3)
    check("ctrl+c clears the editor", editor_text(app) == "")

    app.submit("second question")
    check("second answer", app.wait_for(r"Second answer", 15))

    app.submit("slow task")
    check("slow tool running", app.wait_for(r"sleep 3; echo slow", 15))
    app.submit("also this")
    check("steer shown as pending", app.wait_for(r"steer: also this", 5))
    check("working status in the editor border", app.wait_for(r"── . Running bash", 3))
    check("steer delivered", app.wait_for(r"↳ also this", 15, where="history"))
    check("slow run finished", app.wait_for(r"Slow done", 15))
    check("pending line cleared", "steer: also this" not in app.view())

    app.submit("wait forever")
    check("long tool running", app.wait_for(r"sleep 30", 15))
    app.pump(1.0)
    app.key("esc", 0.3)
    check("esc interrupts the run", app.wait_for(r"cancelled", 15))

    app.key("ctrl+l", 0.3)
    check("model selector opens", app.wait_for(r"Select model", 10))
    check("model selector lists models", app.wait_for(r"tiny", 5) and "script" in app.view())
    app.type("tiny")
    app.pump(0.5)
    check("model selector filters", "tiny" in app.view() and not any(line.strip().startswith(("› ✓ script", "✓ script")) for line in app.view().splitlines()))
    app.key("enter", 0.5)
    check("model selected and saved", app.wait_for(r"model local/tiny · saved as default", 10))
    saved = json.load(open(os.path.join(home, "config.json")))
    check("config.json default model", saved.get("model") == "local/tiny" and "providers" in saved)
    app.submit("/model scripted/script")
    check("model switched back", app.wait_for(r"✓ model scripted/script", 10) and app.wait_for(r"scripted/script\s*$", 3))

    app.submit("/thinking")
    check("thinking selector opens", app.wait_for(r"Thinking level", 10))
    app.key("esc", 0.3)
    check("esc closes the selector", app.wait_for(r"(?m)^─+$", 5) and "Thinking level" not in app.view())

    app.submit("/tree")
    check("tree selector opens", app.wait_for(r"Conversation tree", 10))
    check("tree shows the current position", app.wait_for(r"◆", 5))
    app.key("tab", 0.3)
    check("tree filter cycles", app.wait_for(r"Filter: user", 5))
    app.type("second")
    app.pump(0.4)
    app.key("enter", 0.5)
    check("summarize prompt", app.wait_for(r"Summarize the branch you are leaving", 5))
    app.key("enter", 0.5)
    check("tree navigates", app.wait_for(r"moved to", 15))
    check("editor prefilled with the prompt", app.wait_for(r"second question", 5) and editor_text(app) == "second question")
    check("abandoned branch left the transcript", "Slow done" not in app.view("screen"))
    app.key("enter", 0.3)
    check("re-asked from the tree", app.wait_for(r"Re-asked answer", 15))

    app.submit("/new")
    check("/new starts a session", app.wait_for(r"new session", 10))
    app.submit("/resume")
    check("resume selector opens", app.wait_for(r"Resume a session", 10))
    check("resume selector lists sessions", app.wait_for(r"run the script .*runs", 5))
    app.type("run the")
    app.pump(0.4)
    app.key("enter", 0.5)
    check("resumed session replays history", app.wait_for(r"Re-asked answer", 10))

    app.key("ctrl+c", 0.3)
    app.key("ctrl+c", 0.3)
    status = app.wait_exit(10)
    check("exits cleanly", status == 0)
finally:
    if app.exit_status is None:
        app.kill()
if not ok:
    print(app.view("history")[-5000:])

# First run: no model configured and no API keys in the environment.
home2, ws2 = temp_dirs("lily-tui-first")
setup = Lily([], ws2, {"LILY_HOME": home2}, W, H, clean_env=True)
try:
    check("first run shows setup instead of an error", setup.wait_for(r"Welcome to lily\. No model is configured yet", 20))
    check("setup explains API keys", setup.wait_for(r"export ANTHROPIC_API_KEY", 5))
    check("setup explains self-hosted endpoints", "openai-completions" in setup.view())
    check("setup offers the offline demo", "Try the offline demo" in setup.view())
    setup.key("enter", 0.5)
    check("offline demo starts a session", setup.wait_for(r"offline demo · a scripted model", 15))
    setup.submit("hello")
    check("offline demo answers", setup.wait_for(r"done .*turns", 20))
    check("offline demo is not saved as default", not os.path.exists(os.path.join(home2, "config.json")) or "scripted" not in open(os.path.join(home2, "config.json")).read())
    setup.key("ctrl+d", 0.3)
    check("ctrl+d on an empty editor exits", setup.wait_exit(10) == 0)
finally:
    if setup.exit_status is None:
        setup.kill()
if failures and "first run" in " ".join(failures):
    print(setup.view("history")[-3000:])

print("OK" if ok else f"FAILED: {', '.join(failures)}")
sys.exit(0 if ok else 1)
