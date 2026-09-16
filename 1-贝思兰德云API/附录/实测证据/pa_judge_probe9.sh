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
API=os.environ['API']; ORIGIN=os.environ['ORIGIN']; TOKEN=os.environ['TOKEN']
def call(path, body=None, params=None):
    from urllib.parse import urlencode
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

COLS=["CaseNo","CaseName","ClientName","CaseProcName","CaseProcCustomDate","CaseProcLegalDate","CaseProcUndertakerUserName","CaseProcCurrentHandler"]

print('='*76); print(' V. 视图A：个人案件 5 页签（项目当前使用）'); print('='*76)
A={}; Arows={}
for name,tt,st in [('waitHand',50010,0),('auditing',50011,200),('waitDeliver',50012,300),('delivering',50013,400),('finish',50014,500)]:
    d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':100},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':name,'SelectedProcIdGroup':[]})
    rs=rows(d) or []
    Arows[name]=rs
    for r in rs: A[str(r.get('CaseProcId'))]=(name,r.get('CaseNo'))
    print(f'  {name:12s} -> {len(rs)} 行')
print(f'  视图A 去重 CaseProcId 数 = {len(A)}')

print()
print('='*76); print(' W. 视图B：案件办理 6 页签（项目未使用）IsWorkAgent=true'); print('='*76)
B={}; Bnames={}
for name,tt in [('waitStartAudit',40010),('waitAudit',40011),('wait2Official',40016),('auditing',40013),('auditingThirdParty',40014),('finishAudit',40015)]:
    d=call('/CaseInfo/GetCaseHandInfoListOfProcessing' if name=='auditing' else
           {'waitStartAudit':'/CaseInfo/GetCaseHandInfoListOfStart','waitAudit':'/CaseInfo/GetCaseHandInfoListOfPending',
            'wait2Official':'/CaseInfo/GetCaseHandInfoListOfWaitSend','auditingThirdParty':'/CaseInfo/GetCaseHandInfoListOfEntrustCase',
            'finishAudit':'/CaseInfo/GetCaseHandInfoListOfFinish'}[name],
           {'IsWorkAgent':True,'UserTableTitleColumnList':COLS,'TableType':tt,'PageInfo':{'pageIndex':1,'pageSize':100}})
    rs=rows(d) or []
    ok=d.get('IsSuccess')
    for r in rs: B[str(r.get('CaseProcId'))]=(name,r.get('CaseNo'))
    Bnames[name]=len(rs)
    print(f'  {name:18s} TableType={tt} IsSuccess={ok} -> {len(rs)} 行')
print(f'  视图B 去重 CaseProcId 数 = {len(B)}')

print()
print('='*76); print(' X. 差集'); print('='*76)
onlyB=set(B)-set(A); onlyA=set(A)-set(B)
print(f'  仅在视图B（项目漏掉）: {len(onlyB)}')
for pid in sorted(onlyB): print(f'     {B[pid][1]}  [{B[pid][0]}]')
print(f'  仅在视图A: {len(onlyA)}')
for pid in sorted(onlyA)[:20]: print(f'     {A[pid][1]}  [{A[pid][0]}]')
PY
