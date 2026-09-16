set -u
set -a; . /etc/personal-agent/patent.env 2>/dev/null || true; set +a
API="${BASELAND_API_URL:-https://cloudapi02.baselandtec.com/v1}"
ORIGIN="${BASELAND_ORIGIN:-}"
ACC="${RECIPIENT_A_ACCOUNT}"; PW="${RECIPIENT_A_PASSWORD}"; export ACC PW ORIGIN API
TOKEN=$(curl -sS -k -m 30 -X POST "$API/Auth/GetToken" -H "Origin: $ORIGIN" -H "Referer: $ORIGIN/login.html" -H 'Language: zh-CN' -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,os;print(json.dumps({"UserName":os.environ["ACC"],"Password":os.environ["PW"]}))')" \
  | python3 -c 'import json,sys;print((json.load(sys.stdin).get("Data") or {}).get("Token",""))')
[ -n "$TOKEN" ] || { echo "FATAL token"; exit 3; }
export TOKEN
echo "TOKEN OK"
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
    except Exception: return {'_raw':r.stdout[:400]}
def rows(d):
    v=d.get('Data') if isinstance(d,dict) else None
    if isinstance(v,list): return v
    if isinstance(v,dict):
        for k in ('List','ListData','Rows','DataList','Items'):
            if isinstance(v.get(k),list): return v[k]
    return None

print('='*72); print(' J. identity() 依赖的两个接口（项目登录后立刻调用）'); print('='*72)
a=call('/Auth/GetLoginInfo',params={'checkVersion':'false','isLogin':'true'})
print(f"  /Auth/GetLoginInfo?checkVersion=false&isLogin=true -> IsSuccess={a.get('IsSuccess')} Message={a.get('Message')!r}")
D=a.get('Data')
print(f"     Data类型={type(D).__name__} 键={sorted(D.keys()) if isinstance(D,dict) else D}")
if isinstance(D,dict):
    for k in ('UserInfo','TenantUserInfo','User','TenantName','TenantInfo'):
        if k in D: print(f"     Data.{k} = {json.dumps(D[k],ensure_ascii=False)[:400]}")
b=call('/TenantUser/GetCurrentUserInfo')
print(f"  /TenantUser/GetCurrentUserInfo -> IsSuccess={b.get('IsSuccess')} Message={b.get('Message')!r} Data={json.dumps(b.get('Data'),ensure_ascii=False)[:400]}")

print(); print('='*72); print(' K. GetCaseDetailProcList 用项目原样的 body'); print('='*72)
d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':5},'ProcStatusTypeList':[400],'TableType':50013,'ActiveName':'delivering','SelectedProcIdGroup':[]})
case=None
for r in (rows(d) or []):
    case=r; break
cid=case.get('CaseId')
print(f"  用 caseId={cid} ({case.get('CaseNo')})")
body={"caseId":cid,"TableType":80001,"SortInfo":{},"UserTableTitleColumnList":['CaseProcName','CaseProcCustomDate','CaseProcLegalDate','CaseProcFinishDate','CaseProcUndertakerUserName','CaseProcCurrentStatus','CaseProcCurrentFlowName']}
g=call('/CaseInfo/GetCaseDetailProcList',body)
print(f"  IsSuccess={g.get('IsSuccess')} Message={g.get('Message')!r}")
rr=rows(g)
print(f"  行数={len(rr) if rr is not None else None}")
for x in (rr or [])[:6]:
    print(f"    ProcId={x.get('ProcId')} CaseProcId={x.get('CaseProcId')} name={x.get('CaseProcName') or (x.get('CaseProcNameInfo') or {}).get('CaseProcName')} status={x.get('ProcStatusCode') or x.get('_status')} legal={x.get('CaseProcLegalDate')} custom={x.get('CaseProcCustomDate')} finish={x.get('CaseProcFinishDate')} undertaker={x.get('CaseProcUndertakerUserName')}")
print(f"  首行全部键={sorted((rr or [{}])[0].keys())}")

print(); print('='*72); print(' L. GetCaseAllFlowHistoryInfo 直接取 Data 后 listOf 能否工作'); print('='*72)
h=call('/CaseInfo/GetCaseAllFlowHistoryInfo',params={'caseId':cid})
print(f"  Data类型={type(h.get('Data')).__name__}  Data键={list(h['Data'].keys()) if isinstance(h.get('Data'),dict) else '-'}")
DATA=h.get('Data')
print(f"  listOf(Data) 命中键={[k for k in ('List','ListData','Rows','DataList','Items') if isinstance(DATA,dict) and k in DATA]}")
if isinstance(DATA,dict) and isinstance(DATA.get('List'),list):
    for it in DATA['List'][:5]:
        print(f"    {it.get('CaseProcName')}  created={it.get('ProcCreateDate')} finished={it.get('FinishDate')}")
PY
