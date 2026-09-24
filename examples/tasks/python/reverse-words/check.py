import sys
sys.path.insert(0, ".")
from text_utils import reverse_words
assert reverse_words("hello world") == "world hello"
assert reverse_words("  a   b c ") == "c b a"
assert reverse_words("") == ""
print("ok")
