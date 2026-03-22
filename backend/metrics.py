import json
from prune import prune_records

def count_tokens(text):
    return len(text.split())  # simple word count


with open("dataset.json", "r") as f:
    data = json.load(f)

sample = data[0]

# BEFORE
before_text = json.dumps(sample)
before_tokens = count_tokens(before_text)

# AFTER
pruned = prune_records(sample)
after_text = json.dumps(pruned)
after_tokens = count_tokens(after_text)

print("----- TOKEN COMPARISON -----")
print(f"Before Tokens: {before_tokens}")
print(f"After Tokens: {after_tokens}")
print(f"Reduction: {before_tokens - after_tokens}")




import time

# BEFORE latency
start = time.time()
json.dumps(sample)
end = time.time()
before_time = end - start

# AFTER latency
start = time.time()
json.dumps(pruned)
end = time.time()
after_time = end - start

print("\n----- LATENCY COMPARISON -----")
print(f"Before Latency: {before_time:.6f} sec")
print(f"After Latency: {after_time:.6f} sec")