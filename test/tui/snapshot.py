"""Renders TUI screens with their colors for visual review (needs `pip install pyte`).

    python3 test/tui/snapshot.py [--size 100x30] [--out DIR] [--truecolor]

Runs a few scripted scenarios against an offline model and writes one HTML page per
screen, each shown on a dark and a light terminal background side by side."""
import argparse
import html
import json
import os
import sys

sys.dont_write_bytecode = True  # keep test/tui free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from driver import Lily, temp_dirs  # noqa: E402

try:
    import pyte
except ImportError:  # pragma: no cover
    sys.exit("snapshot.py needs pyte: pip install pyte")

NAMED = {
    "black": "#000000", "red": "#cd3131", "green": "#0dbc79", "brown": "#e5e510", "yellow": "#e5e510", "blue": "#2472c8",
    "magenta": "#bc3fbc", "cyan": "#11a8cd", "white": "#e5e5e5", "brightblack": "#666666", "brightred": "#f14c4c",
    "brightgreen": "#23d18b", "brightyellow": "#f5f543", "brightblue": "#3b8eea", "brightmagenta": "#d670d6",
    "brightcyan": "#29b8db", "brightwhite": "#e5e5e5",
}
THEMES = {"dark": ("#1e1e1e", "#d4d4d4"), "light": ("#f4efe2", "#2b2b2b")}


def color(value, default):
    if value == "default":
        return default
    if value in NAMED:
        return NAMED[value]
    if len(value) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in value):
        return f"#{value}"
    return default


def to_html(raw, width, height):
    screen = pyte.Screen(width, height)
    stream = pyte.ByteStream(screen)
    stream.feed(raw)
    panes = []
    for name, (bg, fg) in THEMES.items():
        rows = []
        for y in range(height):
            line = screen.buffer[y]
            out = []
            for x in range(width):
                ch = line[x]
                f, b = color(ch.fg, fg), color(ch.bg, bg)
                if ch.reverse:
                    f, b = b, f
                style = f"color:{f};background:{b};" + ("font-weight:bold;" if ch.bold else "") + ("font-style:italic;" if ch.italics else "") + ("text-decoration:underline;" if ch.underscore else "")
                out.append(f'<span style="{style}">{html.escape(ch.data or " ")}</span>')
            rows.append("".join(out))
        panes.append(f'<div class="pane" style="background:{bg}"><div class="label">{name}</div><pre>{chr(10).join(rows)}</pre></div>')
    return (
        "<html><head><meta charset='utf-8'><style>body{margin:0;background:#888;font-family:Menlo,monospace}"
        ".pane{display:inline-block;vertical-align:top;padding:8px;margin:4px}.label{font:11px sans-serif;color:#888}"
        "pre{margin:0;font-size:13px;line-height:1.2}</style></head><body>" + "".join(panes) + "</body></html>"
    )


def scenario_run(app):
    app.wait_for(r"Let good ideas run", 20)
    yield "startup"
    app.submit("fix the greeting and run it")
    app.wait_for(r"done", 25)
    app.pump(0.5)
    yield "run"
    app.key("ctrl+o")
    app.pump(0.5)
    yield "expanded"
    app.key("ctrl+o")
    app.type("/")
    app.pump(0.8)
    yield "slash-menu"
    app.key("ctrl+c")
    app.submit("/model")
    app.wait_for(r"Select model", 10)
    app.pump(0.5)
    yield "model-picker"
    app.key("esc")
    app.submit("/tree")
    app.wait_for(r"Conversation tree", 10)
    app.pump(0.3)
    yield "tree-picker"
    app.key("esc")


def scenario_setup(app):
    app.wait_for(r"Welcome to lily", 20)
    app.pump(0.5)
    yield "setup"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--size", default="100x30")
    parser.add_argument("--out", default="/tmp/lily-snapshots")
    parser.add_argument("--truecolor", action="store_true")
    args = parser.parse_args()
    width, height = map(int, args.size.split("x"))
    os.makedirs(args.out, exist_ok=True)
    env_extra = {"COLORTERM": "truecolor"} if args.truecolor else {}

    home, ws = temp_dirs("lily-snap")
    open(os.path.join(ws, "app.py"), "w").write("def greet(name):\n    return 'Hello ' + nme\n\nprint(greet('lily'))\n")
    script = os.path.join(home, "script.json")
    json.dump([
        {"thinking": "The greeting uses an undefined variable.\nFix it, then run the file.", "text": "The greeting has a typo; fixing it.",
         "toolCalls": [{"name": "edit", "arguments": {"path": "app.py", "edits": [{"oldText": "'Hello ' + nme", "newText": "f'Hello {name}!'"}]}}]},
        {"toolCalls": [{"name": "bash", "arguments": {"command": "python3 app.py && seq 1 12"}}]},
        {"toolCalls": [{"name": "bash", "arguments": {"command": "python3 missing.py"}}]},
        {"text": "Fixed: `nme` → `name`, now an f-string.\n\n```\nHello lily!\n```\n\n- **edit** app.py\n- ran it"},
    ], open(script, "w"))
    written = []
    for name, args_, runner, env in [
        ("run", ["--script", script, "--backend", "local"], scenario_run, {"LILY_HOME": home}),
        ("setup", [], scenario_setup, {"LILY_HOME": temp_dirs("lily-snap-empty")[0]}),
    ]:
        app = Lily(args_, ws, dict(env, **env_extra), width, height, clean_env=(name == "setup"))
        try:
            for shot in runner(app):
                path = os.path.join(args.out, f"{name}-{shot}-{width}x{height}.html")
                open(path, "w").write(to_html(app.raw, width, height))
                open(path.replace(".html", ".txt"), "w").write(app.view())
                written.append(path)
        finally:
            app.kill()
    print("\n".join(written))


if __name__ == "__main__":
    main()
