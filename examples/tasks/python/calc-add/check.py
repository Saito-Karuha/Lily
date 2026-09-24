import sys
sys.path.insert(0, ".")
from calc import add, mul
assert add(2, 3) == 5, "add(2, 3) should be 5"
assert add(-1, 1) == 0
assert mul(3, 4) == 12
print("ok")
