#!/usr/bin/env bash
# 只读探针：dump finish 页签一行原始字段，确认 CaseProcName 是否为空、名字是否在 CaseProcNameInfo。
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
def clean(v):
    return '' if v is None else str(v).strip()
print('='*78); print(' finish 页签行：名字字段实况'); print('='*78)
d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':3},'ProcStatusTypeList':[500],'TableType':50014,'ActiveName':'finish','SelectedProcIdGroup':[]})
rs=d.get('Data')
for r in (rs if isinstance(rs,list) else []):
    print(f"  CaseNo={clean(r.get('CaseNo'))}")
    print(f"    CaseProcName        = {r.get('CaseProcName')!r}")
    print(f"    CaseProcNameInfo    = {json.dumps(r.get('CaseProcNameInfo'),ensure_ascii=False)[:400]}")
    print(f"    ProcCode            = {r.get('ProcCode')!r}")
    print(f"    CaseHandId          = {r.get('CaseHandId')!r}")
    op=r.get('CaseProcOperateInfo') or {}
    print(f"    IsExistsHand={op.get('IsExistsHand')!r} IsExistsNoFinishHand={op.get('IsExistsNoFinishHand')!r}")
    print(f"    ProcStatusCode      = {r.get('ProcStatusCode')!r}")
    print()
if isinstance(rs,list) and rs:
    print('  一行全部键：'); print('   ', sorted(rs[0].keys()))
    names=sorted({k for r in rs for k in r.keys() if 'ame' in k})
    print('  含 name 的键：', names)
print()
print('='*78); print(' waitHand / delivering 页签同字段对照'); print('='*78)
for tab,tt,st in [('waitHand',50010,0),('delivering',50013,400)]:
    d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':1},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':tab,'SelectedProcIdGroup':[]})
    r=(d.get('Data') or [{}])[0] if isinstance(d.get('Data'),list) and d.get('Data') else {}
    print(f"  [{tab}] CaseNo={clean(r.get('CaseNo'))} CaseProcName={r.get('CaseProcName')!r} CaseProcNameInfo={json.dumps(r.get('CaseProcNameInfo'),ensure_ascii=False)[:200]} ProcCode={r.get('ProcCode')!r}")
PY
