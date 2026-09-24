#!/usr/bin/env python3
"""Print test files whose name mentions one of the given source modules."""
import os
import sys

changed = [os.path.splitext(os.path.basename(p))[0] for p in sys.argv[1:]]
matches = []
for root, _dirs, files in os.walk("tests"):
    for name in files:
        if name.startswith("test_") and name.endswith(".py"):
            if any(module in name for module in changed):
                matches.append(os.path.join(root, name))
print("\n".join(sorted(matches)))
