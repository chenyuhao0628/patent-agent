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

d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':4},'ProcStatusTypeList':[400],'TableType':50013,'ActiveName':'delivering','SelectedProcIdGroup':[]})
sample=rows(d) or []
case=sample[0]
cid=case.get('CaseId'); pid=case.get('CaseProcId')

print('='*74); print(' N. caseInfo(): GetCaseProcById 的 CaseProc 用哪套备注字段名'); print('='*74)
g=call('/CaseInfo/GetCaseProcById',params={'caseProcId':pid})
print(f"  IsSuccess={g.get('IsSuccess')}  Data类型={type(g.get('Data')).__name__}")
D=g.get('Data')
if isinstance(D,dict):
    print(f"  Data键={sorted(D.keys())}")
    for sub in ('CaseProc','CaseInfo'):
        if isinstance(D.get(sub),dict):
            print(f"  Data.{sub} 键={sorted(D[sub].keys())}")
            for k in ('FlowRemark','OfficeNote','ProcNote','CaseProcOfficeNote','CaseProcProcNote','Remark'):
                print(f"      {k} = {D[sub].get(k)!r}" + ('  <存在>' if k in D[sub] else '  <不存在>'))

print(); print('='*74); print(' O. caseClosure(): GetUpdateCaseInfo 的 CaseInfo.Remark / IsFinishCase'); print('='*74)
u=call('/CaseInfo/GetUpdateCaseInfo',params={'caseId':cid})
D2=u.get('Data')
print(f"  IsSuccess={u.get('IsSuccess')}  Data键={sorted(D2.keys()) if isinstance(D2,dict) else D2}")
ci=(D2 or {}).get('CaseInfo') if isinstance(D2,dict) else None
if isinstance(ci,dict):
    print(f"  CaseInfo 键数={len(ci)}")
    for k in ('Remark','IsFinishCase','CaseStatusType','CaseId'):
        print(f"      {k} = {ci.get(k)!r}" + ('  <存在>' if k in ci else '  <不存在>'))

print(); print('='*74); print(' P. GetFormInstructionsAndImage 的 IsShowCaseName（官方据此决定 CaseName 是否传值）'); print('='*74)
hid=None
for r in sample:
    h=call('/CaseInfo/GetHandInfo',params={'caseProcId':r.get('CaseProcId')})
    DD=h.get('Data') or {}
    if isinstance(DD,dict) and DD.get('IsReviewing') and (DD.get('HandInfo') or {}).get('CaseHandId'):
        hid=DD['HandInfo']['CaseHandId']; break
if hid:
    fi=call('/CaseInfo/GetFormInstructionsAndImage',params={'caseHandId':hid,'formCode':'000000'})
    DD=fi.get('Data') or {}
    for k in ('IsShowCaseName','IsShowIsUseXmlFormatHand','IsUseXmlFormatHand','CaseName','CaseHandFormInstructionsAndImageSettingId'):
        print(f"      {k} = {DD.get(k)!r}")
else:
    print('  无可编辑实例')

print(); print('='*74); print(' Q. 递交状态枚举：官方前端常量 vs 项目映射'); print('='*74)
s=call('/SystemTypeSetting/GetCaseHandSendStatusViewTypeList')
print('  ',json.dumps(s.get('Data'),ensure_ascii=False))
PY
