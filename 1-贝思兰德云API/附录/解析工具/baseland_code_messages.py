#!/usr/bin/env python3
"""直接枚举贝思兰德前端所有「业务码 -> 官方中文文案」表，输出 TSV。

不依赖调用点解析：把每个 webpack 模块里形如 `VAR = <expr>`（expr 含 `Success:`，
可能是 Object(spread) 合成）的对象全部取出，值若是 i18n key 则查中文。
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

def expr_from(mod, pos):
    depth = 0; j = pos
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
    return mod[pos:j]

def zh(v):
    if not isinstance(v, str): return ''
    if re.fullmatch(r'r\d{15,20}', v):
        return LOCALE.get(v, '')
    return v

rows = []
for path, offs in BYFILE.items():
    if path.endswith('app_latest.js'): continue
    src = read(path)
    for i, (off, key) in enumerate(offs):
        end = offs[i + 1][0] if i + 1 < len(offs) else len(src)
        mod = src[off:end]
        for m in re.finditer(r'(?:^|[,;{])\s*(\w+)\s*=\s*', mod):
            var = m.group(1)
            e = expr_from(mod, m.end())
            if 'Success:' not in e or len(e) < 20: continue
            pairs = re.findall(r'([A-Za-z][A-Za-z0-9_]*)\s*:\s*("(?:[^"\\]|\\.)*"|[\w$.]+)', e)
            got = []
            for code, raw in pairs:
                v = raw
                if v.startswith('"'):
                    try: v = json.loads(v)
                    except Exception: v = v.strip('"')
                got.append((code, v, zh(v)))
            if len(got) < 2: continue
            if not any(c == 'Success' for c, _, _ in got): continue
            # 真码表：值要么是 i18n key(r\d+)，要么是标识符引用(如 i / o.NoAuthority)
            i18n = sum(1 for _, raw, _ in got if re.fullmatch(r'r\d{15,20}', raw))
            ident = sum(1 for _, raw, _ in got if re.fullmatch(r'[\w$]+(\.[\w$]+)?', raw))
            if i18n < 2 and ident != len(got): continue
            if not re.fullmatch(r'[A-Z][A-Za-z0-9_]*', min((c for c,_,_ in got), key=len) or 'X'): pass
            rows.append((path.split('/')[-1][:30], key, var, got))

out = os.path.join(ROOT, '业务码文案对照.tsv')
with open(out, 'w', encoding='utf-8') as f:
    f.write('文件\t模块\t变量\t业务码\t官方中文\n')
    for fn, key, var, got in rows:
        for code, raw, z in got:
            f.write(f'{fn}\t{key}\t{var}\t{code}\t{z}\n')
print('码表数:', len(rows), ' 条目数:', sum(len(g) for *_, g in rows))
print('已写入', out)
print()

WANT = {('2483', 'd'): 'SubmitHandFlow',
        ('2483', 'x'): 'AddCaseHandForm / IsHasCaseHandForm',
        ('2483', 'N'): 'DeleteFormFile',
        ('2483', 'p'): 'Insert/UpdateFormPatentRequestInfo',
        ('2483', 'J'): 'Insert/UpdateFormInstructionsAndImageSetting',
        ('2483', 'P'): '表单附件（描述/类型）',
        ('2483', 'F'): '权利要求/说明书信息',
        ('2483', 'o'): '通用表单基表',
        ('2483', 'c'): '通用表单基表2',
        ('2483', 'U'): '打包',
        ('2483', 'W'): '递交/打包状态',
        ('2483', 'B'): '可编辑性',
        ('cc6b', 'u'): 'StartHand'}
printed = set()
for fn, key, var, got in rows:
    tag = WANT.get((key, var))
    if not tag or (key, var) in printed: continue
    printed.add((key, var))
    print('=' * 78)
    print(f'{tag}     [模块 {key} 变量 {var}]  {len(got)} 项')
    for code, raw, z in got:
        print(f'   {code:48s} {z[:80]}')
