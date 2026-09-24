"""tidy-notes: a tiny command-line notebook stored in notes.json."""
import json
import sys
from pathlib import Path

STORE = Path(__file__).with_name("notes.json")


def load() -> list[str]:
    return json.loads(STORE.read_text()) if STORE.exists() else []


def add(text: str) -> None:
    notes = load()
    notes.append(text)
    STORE.write_text(json.dumps(notes, indent=2))


def main(argv: list[str]) -> None:
    if argv[:1] == ["add"]:
        add(" ".join(argv[1:]))
    for i, note in enumerate(load(), 1):
        print(f"{i}. {note}")


if __name__ == "__main__":
    main(sys.argv[1:])
