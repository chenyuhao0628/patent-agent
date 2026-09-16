#!/usr/bin/env python3
"""把贝思兰德前端每个写接口的「结果形态 + 业务码表」解析出来。

做法：
 1. 用模块索引（键 -> 文件+偏移）找到调用点所在模块；
 2. 在模块内解析 `别名 = n("<模块id>")`，得到码表所在模块；
 3. 在目标模块里找 `n.d(t,"<字母>",(function(){return VAR}))`，再取 `VAR = {Success:...}` 的键集合。
"""
import re, os, json, sys

ROOT = "/Users/cyh/Documents/0001/baseland-reverse"
INDEX = json.load(open("/tmp/modindex.json"))
KEY = re.compile(r'[,{]\s*("?)([0-9a-zA-Z_$]{3,24})\1\s*:\s*function\s*\(\s*[\w$]+\s*,\s*[\w$]+\s*,\s*[\w$]+\s*\)\s*\{')
_cache = {}

def read(p):
    if p not in _cache:
        _cache[p] = open(p, encoding='utf-8', errors='replace').read()
    return _cache[p]

BYFILE = {}
for _k, _v in INDEX.items():
    for _f, _o in _v:
        BYFILE.setdefault(_f, []).append(_o)
for _f in BYFILE:
    BYFILE[_f].sort()

def enclosing_module(path, pos):
    starts = BYFILE.get(path)
    if not starts:
        return None
    import bisect
    i = bisect.bisect_right(starts, pos) - 1
    if i < 0:
        return None
    start = starts[i]
    end = starts[i + 1] if i + 1 < len(starts) else len(read(path))
    return read(path)[start:end]

def resolve_alias(modtext, alias, filename=None):
    """在模块文本里解析 别名 -> 模块id。

    注意：webpack 模块的 require 形参名不固定（function(e,t,n) / function(e,t,a) 等），
    因此不假设名字，直接看 `别名 = <任意单标识符>("模块id")`。
    """
    for m in re.finditer(r'(?:^|[,;{])\s*' + re.escape(alias) + r'\s*=\s*[\w$]+\("([0-9a-zA-Z_$]{3,24})"\)', modtext):
        return m.group(1)
    if filename:   # 兜底：整个文件里找
        for m in re.finditer(r'(?:^|[,;{])\s*' + re.escape(alias) + r'\s*=\s*[\w$]+\("([0-9a-zA-Z_$]{3,24})"\)', read(filename)):
            return m.group(1)
    return None

def code_table(modid):
    locs = INDEX.get(modid)
    if not locs:
        return None, None
    for path, off in locs:
        modtext = enclosing_module(path, off)
        if not modtext:
            continue
        tables = {}
        for m in re.finditer(r'(\w+)\s*=\s*\{(Success:[^{}]{0,900}?)\}', modtext):
            tables[m.group(1)] = re.findall(r'([A-Za-z][A-Za-z0-9_]*)\s*:', m.group(2))
        if not tables:
            continue
        return path, tables
    return None, None

def probe(endpoint, path):
    src = read(path)
    out = []
    for m in re.finditer(r'\["' + re.escape(endpoint) + r'"\]\)\(', src):
        pos = m.end()
        modtext = enclosing_module(path, pos)
        if not modtext:
            continue
        tail = src[pos:pos + 900].replace('\n', ' ')
        shape = []
        if re.search(r'\w+\.Result\b', tail[:400]):
            shape.append('读.Data.Result（对象形态）')
        if re.search(r'isSuccess\(\s*\w+\s*\)', tail[:400]):
            shape.append('isSuccess(返回值)（裸字符串形态）')
        if re.search(r'is[A-Z]\w+', tail[:400]):
            for f in set(re.findall(r'\.(is[A-Z]\w+)', tail[:400])):
                shape.append(f'注入标志 {f}')
        aliases = set(re.findall(r'(\w+)\["(\w)"\]\[', tail[:500]))
        tables = []
        for al, letter in aliases:
            mid = resolve_alias(modtext, al, path)
            if not mid:
                tables.append((f'{al}["{letter}"]', '未解析到模块', None))
                continue
            tp, tb = code_table(mid)
            hit = None
            for var, keys in (tb or {}).items():
                # 该模块里哪个变量被导出为 letter？
                tsrc = read(tp) if tp else ''
                for mm in re.finditer(r'n\.d\(\w+,"' + re.escape(letter) + r'",\(function\(\)\{return (\w+)\}\)\)', tsrc):
                    if mm.group(1) == var:
                        hit = keys; break
            tables.append((f'{al}["{letter}"]', f'module {mid}', hit or (list((tb or {}).values())[0] if tb else None)))
        out.append({'tail': tail[:330], 'shape': shape, 'tables': tables})
        if len(out) >= 2:
            break
    return out

EPS = {
    'SubmitHandFlow': ['_chunks/chunk-384baaef.7c2a447e240e9196ed08.js', '_chunks/chunk-080c8887.848441b1d7cd7db7358f.js'],
    'AddCaseHandForm': ['_chunks/chunk-2eb54c96.82d8ffb111710d133659.js'],
    'DeleteFormFile': ['_chunks/chunk-2eb54c96.82d8ffb111710d133659.js'],
    'ModifyFormInstructionsAndImage': ['_chunks/chunk-2eb54c96.82d8ffb111710d133659.js'],
    'UploadExistFileFormInstructionsAndImage': ['_chunks/chunk-1e8f9322.ede8262415b8257b77f0.js', '_chunks/chunk-2eb54c96.82d8ffb111710d133659.js'],
    'InsertFromPatentRequestInfo': ['_chunks/chunk-2eb54c96.82d8ffb111710d133659.js'],
    'UpdateFormPatentRequestInfo': ['_chunks/chunk-2eb54c96.82d8ffb111710d133659.js'],
    'StartHand': ['_chunks/chunk-244055f8.42c8fbfd2b0422155f75.js', '_chunks/chunk-384baaef.7c2a447e240e9196ed08.js'],
    'DeleteFormInstructionsAndImageMixFile': ['_chunks/chunk-2eb54c96.82d8ffb111710d133659.js'],
}

os.chdir(ROOT)
for ep, paths in EPS.items():
    print('=' * 78)
    print(ep)
    printed = False
    for p in paths:
        fp = p
        if not os.path.exists(fp):
            continue
        for r in probe(ep, fp):
            printed = True
            print(f'  文件: {p}')
            print(f'  结果形态线索: {r["shape"] or "未见"}')
            for a, mid, keys in r['tables']:
                print(f'    码表 {a} -> {mid}')
                if keys:
                    print(f'        {keys}')
            print(f'  返回值处理片段: {r["tail"][:250]}')
            print()
            break
    if not printed:
        print('  （未找到调用点）')
