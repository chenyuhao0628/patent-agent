#!/usr/bin/env python3
"""输出「已核实的端点码表 -> 官方中文文案」对照表。

只收录通过调用点证据确认过绑定的表，并展开一层 Object(spread) 基表。
产出：baseland-reverse/业务码文案对照.tsv
"""
import re, os, json

ROOT = "/Users/cyh/Documents/0001/baseland-reverse"
os.chdir(ROOT)
LOCALE = json.load(open('/tmp/locale_zh.json'))
INDEX = json.load(open('/tmp/modindex.json'))
BYFILE = {}
for k, v in INDEX.items():
    for f, o in v:
        BYFILE.setdefault(f, []).append((o, k))
for f in BYFILE:
    BYFILE[f].sort()

_cache = {}
def read(p):
    if p not in _cache:
        _cache[p] = open(p, encoding='utf-8', errors='replace').read()
    return _cache[p]

def module_slice(path, key):
    for off, k in BYFILE.get(path, []):
        if k == key:
            lst = BYFILE[path]
            i = [o for o, _ in lst].index(off)
            end = lst[i + 1][0] if i + 1 < len(lst) else len(read(path))
            return read(path)[off:end]
    return None

def expr_of(mod, var):
    outs = []
    for m in re.finditer(r'(?:^|[,;{])\s*' + re.escape(var) + r'\s*=\s*', mod):
        i = m.end(); depth = 0; j = i
        while j < len(mod):
            ch = mod[j]
            if ch == '"':
                j += 1
                while j < len(mod) and mod[j] != '"':
                    if mod[j] == '\\': j += 1
                    j += 1
                j += 1; continue
            if ch in '([{': depth += 1
            elif ch in ')]}':
                if depth == 0: break
                depth -= 1
            elif depth == 0 and ch in ',;': break
            j += 1
        outs.append(mod[i:j])
    return max(outs, key=len) if outs else ''

def dec(s):
    try: return json.loads('"' + s + '"')
    except Exception: return s

def pairs_of(expr):
    out = {}
    for code, raw in re.findall(r'([A-Za-z][A-Za-z0-9_]*)\s*:\s*("(?:[^"\\]|\\.)*"|[\w$.]+)', expr):
        out[code] = dec(raw[1:-1]) if raw.startswith('"') else raw
    return out

def resolve(path, key, var, depth=2):
    mod = module_slice(path, key)
    if not mod: return {}
    e = expr_of(mod, var)
    if not e: return {}
    merged = {}
    # 展开 Object(spread) 的标识符基表（含 ({},X) 这种无尾逗号的写法）
    bases = set(re.findall(r'\{\}\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]', e))
    bases |= set(BASE_OVERRIDES.get(var, []))
    for base in bases:
        if base != var and depth > 0:
            merged.update(resolve(path, key, base, depth - 1))
    merged.update(pairs_of(e))
    return merged

def zh(v):
    return LOCALE.get(v, '') if isinstance(v, str) and re.fullmatch(r'r\d{15,20}', v) else ''

BASE_OVERRIDES = {'N': ['c'], 'p': ['o'], 'c': ['x']}

TABLES = [
    ('SubmitHandFlow', 'submit-递交流程提交', '_chunks/chunk-080c8887.848441b1d7cd7db7358f.js', '2483', 'd'),
    ('StartHand', 'start-启动递交实例', '_chunks/chunk-080c8887.848441b1d7cd7db7358f.js', 'cc6b', 'u'),
    ('AddCaseHandForm / IsHasCaseHandForm', 'form-表单勾选', '_chunks/chunk-080c8887.848441b1d7cd7db7358f.js', '2483', 'x'),
    ('DeleteFormFile', 'form-删除表单文件', '_chunks/chunk-080c8887.848441b1d7cd7db7358f.js', '2483', 'N'),
    ('Insert/UpdateFormPatentRequestInfo', 'form-请求书保存', '_chunks/chunk-080c8887.848441b1d7cd7db7358f.js', '2483', 'p'),
    ('Insert/UpdateFormInstructionsAndImageSetting', 'form-五书设置', '_chunks/chunk-080c8887.848441b1d7cd7db7358f.js', '2483', 'J'),
    ('(基表) 通用表单', 'base-通用表单', '_chunks/chunk-080c8887.848441b1d7cd7db7358f.js', '2483', 'o'),
    ('(基表) 通用表单2', 'base-通用表单2', '_chunks/chunk-080c8887.848441b1d7cd7db7358f.js', '2483', 'c'),
    ('(参考) 打包', 'ref-打包', '_chunks/chunk-080c8887.848441b1d7cd7db7358f.js', '2483', 'U'),
    ('(参考) 递交状态', 'ref-递交状态', '_chunks/chunk-080c8887.848441b1d7cd7db7358f.js', '2483', 'W'),
    ('(参考) 启动前校验', 'ref-启动前校验', '_chunks/chunk-080c8887.848441b1d7cd7db7358f.js', '2483', 'B'),
]

rows = []
for endpoint, tag, path, key, var in TABLES:
    t = resolve(path, key, var)
    if not t:
        print('!! 未解析:', endpoint, key, var); continue
    for code, raw in t.items():
        rows.append((endpoint, tag, code, raw if re.fullmatch(r'r\d{15,20}', str(raw)) else '', zh(raw)))

with open('业务码文案对照.tsv', 'w', encoding='utf-8') as f:
    f.write('端点\t用途\t业务码\ti18nKey\t官方中文\n')
    for r in rows:
        f.write('\t'.join(r) + '\n')

print('已写入 业务码文案对照.tsv  行数:', len(rows))
print('覆盖端点:', len({r[0] for r in rows}), ' 有中文的条目:', sum(1 for r in rows if r[4]))
