import subprocess
out = subprocess.run(["python3", "fizzbuzz.py", "15"], capture_output=True, text=True, check=True).stdout.split()
expected = ["1", "2", "Fizz", "4", "Buzz", "Fizz", "7", "8", "Fizz", "Buzz", "11", "Fizz", "13", "14", "FizzBuzz"]
assert out == expected, out
print("ok")
