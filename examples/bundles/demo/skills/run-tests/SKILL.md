---
name: run-tests
description: Run only the tests related to the files you changed, instead of the whole suite. Use after editing Python code in a repository with a tests/ directory.
---

# Run related tests

1. List the files you changed.
2. Run `python3 scripts/select_tests.py <changed files...>` from this skill's directory
   (use the absolute path of the script) to print the matching test files.
3. Run `python3 -m pytest -q <printed test files>` in the repository root.
4. If nothing matches, fall back to `python3 -m pytest -q`.
