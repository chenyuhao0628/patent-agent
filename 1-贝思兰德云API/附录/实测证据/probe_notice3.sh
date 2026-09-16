#!/usr/bin/env bash
# 只读探针七：流程名目录与官文状态字典（判断「办登/领证」类流程是否在系统内）。
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
    except Exception: return {'_raw':r.stdout[:300]}
def rows(d):
    v=d.get('Data') if isinstance(d,dict) else None
    if isinstance(v,list): return v
    if isinstance(v,dict):
        for k in ('List','ListData','Rows','DataList','Items'):
            if isinstance(v.get(k),list): return v[k]
    return None
def brief(v,n=400):
    s=json.dumps(v,ensure_ascii=False); return s if len(s)<=n else s[:n]+'…'
def clean(v): return '' if v is None else str(v).strip()

print('='*84); print(' A. 流程名目录：CaseProcProcess/GetCaseProcProcessDropdownList'); print('='*84)
d=call('/CaseProcProcess/GetCaseProcProcessDropdownList')
print('  IsSuccess=%s Message=%s' % (d.get('IsSuccess'), d.get('Message')))
rs=rows(d)
print('  行数=%s' % (len(rs) if isinstance(rs,list) else rs))
KEY=('授权','办登','登记','领证','证书','年费','放弃','恢复','复审','查阅','副本','加快','优先')
for r in (rs or []):
    label=clean(r.get('label') or r.get('Label') or r.get('Name') or r.get('CaseProcName'))
    value=r.get('value') if 'value' in r else r.get('Value') or r.get('ProcCode')
    mark=' <<<' if any(k in label for k in KEY) else ''
    print(f'    {str(value):8s}  {label}{mark}')
if not rs: print('  原始：', brief(d.get('Data'),400))
print()
print('='*84); print(' B. 官文状态字典：SystemTypeSetting/GetNoticeStatusType'); print('='*84)
d=call('/SystemTypeSetting/GetNoticeStatusType')
print('  IsSuccess=%s Message=%s' % (d.get('IsSuccess'), d.get('Message')))
print('  Data=%s' % brief(d.get('Data'),700))
print()
print('='*84); print(' C. 个人流程状态字典：SystemTypeSetting/GetCaseProcStatusType'); print('='*84)
d=call('/SystemTypeSetting/GetCaseProcStatusType')
print('  IsSuccess=%s Message=%s' % (d.get('IsSuccess'), d.get('Message')))
print('  Data=%s' % brief(d.get('Data'),700))
print()
print('='*84); print(' D. 案件状态类型：SystemTypeSetting/GetCaseStatusType'); print('='*84)
d=call('/SystemTypeSetting/GetCaseStatusType')
print('  IsSuccess=%s Message=%s' % (d.get('IsSuccess'), d.get('Message')))
print('  Data=%s' % brief(d.get('Data'),700))
PY
