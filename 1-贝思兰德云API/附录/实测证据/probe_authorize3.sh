#!/usr/bin/env bash
# 只读探针三：解析该案自定义案件状态名 + 取「授权专利」新动态明细。
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
STATUS_ID='a750af0a-2171-42fe-8f23-789ad86ab125'
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
def clean(v): return '' if v is None else str(v).strip()
def brief(v,n=300):
    s=json.dumps(v,ensure_ascii=False); return s if len(s)<=n else s[:n]+'…'

print('='*80); print(' A. 该案的案件状态行（a750af0a）全字段'); print('='*80)
d=call('/CaseStatus/GetCaseStatus',params={'pageIndex':1,'pageSize':100})
rs=rows(d) or []
target=[r for r in rs if clean(r.get('CaseStatusId'))==STATUS_ID]
print(f'  字典共 {len(rs)} 条；命中目标 {len(target)} 条')
for r in target:
    for k,v in r.items(): print(f'    {k:26s} = {v!r}')
print('  字典前 3 条全字段（看名字字段名）：')
for r in rs[:3]: print('    ', brief(r,260))
print('  NameResourceId 取值分布（前 8 个）：')
for r in rs[:8]: print(f'    {clean(r.get("CaseStatusId"))[:8]}  NameResourceId={clean(r.get("NameResourceId"))}  其它名字类键={[k for k in r if "ame" in k]}')

print()
print('='*80); print(' B. 案件新动态明细（试不同请求体）'); print('='*80)
variants=[
    {},
    {'PagedInfo':{'PageIndex':1,'PageSize':20}},
    {'PagedInfo':{'PageIndex':1,'PageSize':20},'ItemType':2,'ReminderDuration':7},
    {'PagedInfo':{'PageIndex':1,'PageSize':20},'ItemTypeList':[2],'ReminderDuration':7},
    {'PagedInfo':{'PageIndex':1,'PageSize':20},'ItemTypeList':[2]},
    {'ItemTypeList':[2],'ReminderDuration':30,'PagedInfo':{'PageIndex':1,'PageSize':50}},
    {'ItemType':2},
]
for body in variants:
    d=call('/NoPermissionRequired/GetCaseNewTrendsDetailList',body=body)
    rs=rows(d)
    print(f'  {brief(body,80)}')
    print(f'    -> IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} 行数={len(rs) if isinstance(rs,list) else rs}')
    for r in (rs or [])[:8]:
        keys=[k for k in r.keys() if any(s in k for s in ('CaseNo','CaseName','Client','ItemType','Authorize','Date','Sync'))]
        print('       ', brief({k:r.get(k) for k in keys},300))
    if isinstance(rs,list) and rs: break
print()
print('  GetCaseNewTrendsDetailCount 试打：')
d=call('/NoPermissionRequired/GetCaseNewTrendsDetailCount',body={'ItemType':2,'ReminderDuration':7})
print(f'    IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} Data={brief(d.get("Data"),200)}')
PY
