#!/usr/bin/env python3
"""严格版：在「调用点所在模块」内解析码表别名，不跨模块兜底。

输出每个写接口：结果形态 + 真正使用的码表变量及其定义。
"""
import re, os, json, bisect

ROOT = "/Users/cyh/Documents/0001/baseland-reverse"
INDEX = json.load(open("/tmp/modindex.json"))
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

def enclosing(path, pos):
    lst = BYFILE.get(path)
    if not lst: return None, None, None
    offs = [o for o, _ in lst]
    i = bisect.bisect_right(offs, pos) - 1
    if i < 0: return None, None, None
    start = offs[i]; end = offs[i + 1] if i + 1 < len(lst) else len(read(path))
    return lst[i][1], read(path)[start:end], (start, end)

def imports_of(modtext):
    """返回模块内的 别名 -> 模块id（只在本模块内）"""
    out = {}
    for m in re.finditer(r'([\w$]+)\s*=\s*[\w$]+\("([0-9a-zA-Z_$]{3,24})"\)', modtext):
        out.setdefault(m.group(1), m.group(2))
    return out

def module_by_id(mid):
    locs = INDEX.get(mid)
    if not locs: return None, None
    p, off = locs[0]
    _, mod, _ = enclosing(p, off)
    return p, mod

def export_var(mid, letter):
    p, mod = module_by_id(mid)
    if not mod: return None, None, None
    m = re.search(r'n\.d\(\w+,"' + re.escape(letter) + r'",\(function\(\)\{return (\w+)\}\)\)', mod)
    if not m: return p, None, None
    var = m.group(1)
    d = re.search(r'(?:^|[,;{])\s*' + re.escape(var) + r'\s*=\s*(\{[^{}]{0,900}?\})', mod)
    return p, var, (d.group(1) if d else None)

CASES = [
    ('SubmitHandFlow', '_chunks/chunk-384baaef.7c2a447e240e9196ed08.js'),
    ('AddCaseHandForm', '_chunks/chunk-2eb54c96.82d8ffb111710d133659.js'),
    ('DeleteFormFile', '_chunks/chunk-2eb54c96.82d8ffb111710d133659.js'),
    ('InsertFromPatentRequestInfo', '_chunks/chunk-2eb54c96.82d8ffb111710d133659.js'),
    ('StartHand', '_chunks/chunk-384baaef.7c2a447e240e9196ed08.js'),
    ('GetUpdateCaseInfo', '_chunks/chunk-7035dc44.0432bf141bad93bb9b1d.js'),
]
os.chdir(ROOT)
for ep, path in CASES:
    src = read(path)
    print('=' * 78); print(ep, '|', path)
    found = 0
    for m in re.finditer(r'\["' + re.escape(ep) + r'"\]\)\(', src):
        key, mod, span = enclosing(path, m.end())
        if not mod: continue
        tail = src[m.end():m.end() + 700].replace('\n', ' ')
        used = re.findall(r'(\w+)\["(\w)"\]\[', tail)
        imps = imports_of(mod)
        print(f'  模块键={key}  模块内导入数={len(imps)}')
        for al, letter in dict.fromkeys(used):
            mid = imps.get(al)
            if not mid:
                # 别名可能定义在同一文件的另一个模块（组件子模块）
                cand = re.findall(r'(?:^|[,;{])\s*' + re.escape(al) + r'\s*=\s*[\w$]+\("([0-9a-zA-Z_$]{3,24})"\)', mod)
                print(f'    表 {al}["{letter}"]: 本模块无该别名' + (f'（本模块内候选 {cand}）' if cand else ''))
                continue
            p2, var, defi = export_var(mid, letter)
            print(f'    表 {al}["{letter}"] -> 模块 {mid} 导出变量 {var}')
            if defi:
                keys = re.findall(r'([A-Za-z][A-Za-z0-9_]*)\s*:', defi)
                print(f'       ★ 码表键: {keys}')
            else:
                print(f'       定义片段: {str(defi)[:200]}')
        print(f'  返回值处理: {tail[:210]}')
        print()
        found += 1
        if found >= 1: break
    if not found:
        print('  （未找到直接调用点）')
