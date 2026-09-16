#!/usr/bin/env bash
# 只读探针：确认 GetCaseAllFlowHistoryInfo / GetCaseDetailProcList 的名字字段是否同样存在
# 「CaseProcName 为 null、真名在 CaseProcNameInfo.CaseProcName」的情况。
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
# 取一个有历史的案件：用已知案件号
CASE_ID='a853ec8d-033c-4f76-a737-75d52a25c96f'
print('='*78); print(' A. GetCaseAllFlowHistoryInfo（项目 baseland.ts:441 直接读 CaseProcName）'); print('='*78)
d=call('/CaseInfo/GetCaseAllFlowHistoryInfo',None,{'caseId':CASE_ID})
print('  IsSuccess=%s Message=%s' % (d.get('IsSuccess'), d.get('Message')))
rs=rows(d)
print('  行数=%s' % (len(rs) if isinstance(rs,list) else rs))
for r in (rs or []):
    print('    CaseProcName     = %r' % r.get('CaseProcName'))
    print('    CaseProcNameInfo = %s' % json.dumps(r.get('CaseProcNameInfo'),ensure_ascii=False)[:200])
    print('    ProcName/LatestProcName = %r / %r' % (r.get('ProcName'), r.get('LatestProcName')))
    print('    ProcCode=%r FinishDate=%r' % (r.get('ProcCode'), r.get('FinishDate')))
print()
print('='*78); print(' B. GetCaseDetailProcList（项目走 processRow，有兜底）'); print('='*78)
d=call('/CaseInfo/GetCaseDetailProcList',{'caseId':CASE_ID,'TableType':80001,'SortInfo':{},'UserTableTitleColumnList':['CaseProcName','CaseProcCustomDate','CaseProcLegalDate','CaseProcFinishDate','CaseProcUndertakerUserName','CaseProcCurrentStatus','CaseProcCurrentFlowName']})
print('  IsSuccess=%s Message=%s' % (d.get('IsSuccess'), d.get('Message')))
rs=rows(d)
print('  行数=%s' % (len(rs) if isinstance(rs,list) else rs))
for r in (rs or [])[:3]:
    print('    CaseProcId=%s CaseProcName=%r Info=%s' % (r.get('CaseProcId'), r.get('CaseProcName'), json.dumps(r.get('CaseProcNameInfo'),ensure_ascii=False)[:160]))
print()
print('='*78); print(' C. GetCaseHandFileList / 其他含 CaseProcName 的只读接口抽样'); print('='*78)
for path,params in [('/CaseInfo/GetCaseProcFileList',{'caseId':CASE_ID})]:
    d=call(path,None,params); rs=rows(d)
    print('  %s -> IsSuccess=%s 行数=%s' % (path, d.get('IsSuccess'), len(rs) if isinstance(rs,list) else rs))
PY
