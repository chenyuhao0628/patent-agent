import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    print("NON_JSON  " + raw[:70].replace("\n", " "))
    raise SystemExit
ok = d.get("IsSuccess")
msg = str(d.get("Message") or "")[:34]
n = ""
data = d.get("Data")
if isinstance(data, list):
    n = "  n=%d" % len(data)
elif isinstance(data, dict):
    for k in ("ListData", "List", "TotalCount"):
        if k in data:
            v = data[k]
            n += "  %s=%s" % (k, len(v) if isinstance(v, list) else v)
print("%-5s %-34s%s" % (ok, msg, n))
