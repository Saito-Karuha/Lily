import subprocess
out = subprocess.run(["python3", "count.py", "input.txt"], capture_output=True, text=True, check=True).stdout.strip().splitlines()
assert out == ["the 3", "brown 1", "dog 1"], out
print("ok")
