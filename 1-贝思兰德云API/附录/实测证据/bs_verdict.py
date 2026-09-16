import json, sys
label = sys.argv[1] if len(sys.argv) > 1 else "?"
raw = sys.stdin.read().strip()
try:
    d = json.loads(raw)
except Exception:
    print("  %-62s  解析失败 %s" % (label[:60], raw[:60])); raise SystemExit
ok = d.get("IsSuccess"); msg = str(d.get("Message") or "")
code = d.get("Code")
data = d.get("Data")
n = ""
if isinstance(data, list): n = "数据 %d 条" % len(data)
elif isinstance(data, dict):
    for k in ("ListData", "List", "TotalCount", "Rows"):
        if k in data:
            v = data[k]; n = "%s=%s" % (k, len(v) if isinstance(v, list) else v); break
if "无访问权限" in msg or "无权限" in msg:
    verdict = "❌ 无权限"
elif "系统错误" in msg or "参数" in msg:
    verdict = "⚠️ 有权限(缺参数)"
elif ok is True:
    verdict = "✅ 可用"
else:
    verdict = "? %s" % msg[:22]
print("  %-62s %-16s %s" % (label[:60], verdict, n))
