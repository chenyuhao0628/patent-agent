#!/usr/bin/env bash
# 只读探针十：官文类型字典——「授权 / 驳回」等官方结果对应的 NoticeTypeCode 全集。
set -u
set -a; . /etc/personal-agent/patent.env 2>/dev/null || true; set +a
API="${BASELAND_API_URL:-https://cloudapi02.baselandtec.com/v1}"
ORIGIN="${BASELAND_ORIGIN:-}"
export ORIGIN API
TOKEN=$(curl -sS -k -m 30 -X POST "$API/Auth/GetToken" -H "Origin: $ORIGIN" -H "Referer: $ORIGIN/login.html" -H 'Language: zh-CN' -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,os;print(json.dumps({"UserName":os.environ["RECIPIENT_A_ACCOUNT"],"Password":os.environ["RECIPIENT_A_PASSWORD"]}))')" \
  | python3 -c 'import json,sys;print((json.load(sys.stdin).get("Data") or {}).get("Token",""))')
[ -n "$TOKEN" ] || { echo FATAL; exit 3; }
export TOKEN
python3 - <<'PY'
import json,os,subprocess
from urllib.parse import urlencode
API=os.environ['API']; ORIGIN=os.environ['ORIGIN']; TOKEN=os.environ['TOKEN']
def call(path, body=None, params=None):
    url=API+path+('?'+urlencode(params) if params else '')
    cmd=['curl','-sS','-k','-m','40',url,'-H','Authorization: '+TOKEN,'-H','Origin: '+ORIGIN,'-H','Language: zh-CN','-H','Content-Type: application/json']
    if body is not None: cmd+=['-X','POST','-d',json.dumps(body)]
    r=subprocess.run(cmd,capture_output=True,text=True)
    try: return json.loads(r.stdout)
    except Exception: return {'_raw':r.stdout[:200]}
def rows(d):
    v=d.get('Data') if isinstance(d,dict) else None
    if isinstance(v,list): return v
    if isinstance(v,dict):
        for k in ('List','ListData','Rows','DataList','Items'):
            if isinstance(v.get(k),list): return v[k]
    return None
def clean(v): return '' if v is None else str(v).strip()
def brief(v,n=260):
    s=json.dumps(v,ensure_ascii=False); return s if len(s)<=n else s[:n]+'…'

print('='*84); print(' A. NoticeType/GetNoticeType（官文类型字典）'); print('='*84)
for params in ({},{'pageIndex':1,'pageSize':500},{'PageIndex':1,'PageSize':500}):
    d=call('/NoticeType/GetNoticeType',params=params or None)
    rs=rows(d)
    print(f'  params={list(params) or "无"} -> IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} 行数={len(rs) if isinstance(rs,list) else rs}')
    if isinstance(rs,list) and rs:
        allrows=rs
        print('  行字段：', sorted(rs[0].keys()))
        print('  前 3 行：')
        for r in rs[:3]: print('    ', brief(r,240))
        KEY=('授权','驳回','证书','登记','视为撤回','视撤','公开','实审','实质审查','复审','无效','手续','专用函','初步审查','受理')
        print()
        print('  与本页相关的类型：')
        for r in allrows:
            name=clean(r.get('NoticeName') or r.get('NoticeTypeName') or r.get('Name'))
            code=r.get('NoticeTypeCode') or r.get('Code') or r.get('Value')
            if any(k in name for k in KEY):
                print(f'    {str(code):>8}  {name}')
        print()
        print(f'  字典共 {len(allrows)} 条')
        break
print()
print('='*84); print(' B. NoticeType/GetNoticeTypeDropDown'); print('='*84)
d=call('/NoticeType/GetNoticeTypeDropDown')
print('  IsSuccess=%s Message=%s' % (d.get('IsSuccess'), d.get('Message')))
print('  Data=%s' % brief(d.get('Data'),400))
print()
print('='*84); print(' C. NoticeType/GetNoticeTypeCount'); print('='*84)
d=call('/NoticeType/GetNoticeTypeCount')
print('  IsSuccess=%s Message=%s Data=%s' % (d.get('IsSuccess'), d.get('Message'), brief(d.get('Data'),120)))
PY
