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
    if not isinstance(d,dict): return None
    v=d.get('Data')
    if isinstance(v,list): return v
    if isinstance(v,dict):
        for k in ('List','ListData','Rows','DataList','Items'):
            if isinstance(v.get(k),list): return v[k]
    return None

print('='*72); print(' D. CaseProcOperateInfo 全键（项目读 IsExistsHand / IsExistsNoFinishHand）'); print('='*72)
for name,tt,st in [('waitHand',50010,0),('delivering',50013,400),('finish',50014,500)]:
    d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':3},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':name,'SelectedProcIdGroup':[]})
    for r in (rows(d) or [])[:2]:
        op=r.get('CaseProcOperateInfo') or {}
        print(f"  [{name}] {r.get('CaseNo')} op键={sorted(op.keys())}")
        print(f"      IsExistsHand={op.get('IsExistsHand')} IsExistsNoFinishHand={op.get('IsExistsNoFinishHand')} StatusCode={op.get('StatusCode')} IsCanHand={op.get('IsCanHand')}")
        print(f"      CaseHandId={r.get('CaseHandId')} ProcStatusCode={r.get('ProcStatusCode')} ApplyNo={r.get('ApplyNo')} CurrentFlowNodeName={r.get('CurrentFlowNodeName')!r} CurrentFlowUserName={r.get('CurrentFlowUserName')!r}")
        ni=r.get('CaseProcNameInfo') or {}
        print(f"      ProcName={ni.get('CaseProcName')} ProcCode={ni.get('ProcCode')}")

print(); print('='*72); print(' E. 提出申请 的 ProcCode 是不是 105（项目 isInitialApplication 判定）'); print('='*72)
seen={}
for name,tt,st in [('finish',50014,500),('waitHand',50010,0),('delivering',50013,400)]:
    d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':100},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':name,'SelectedProcIdGroup':[]})
    for r in (rows(d) or []):
        ni=r.get('CaseProcNameInfo') or {}
        nm=ni.get('CaseProcName') or r.get('CaseProcName')
        pc=ni.get('ProcCode')
        if nm and pc is not None: seen.setdefault(nm,set()).add(pc)
for nm,pcs in sorted(seen.items(), key=lambda x:str(x[0])):
    print(f'   {str(nm):28s} ProcCode={sorted(pcs)}')

print(); print('='*72); print(' F. GetOfficialFormList 原始信封（项目 kind=list 取 DataList/ListData/Data）'); print('='*72)
d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':30},'ProcStatusTypeList':[400],'TableType':50013,'ActiveName':'delivering','SelectedProcIdGroup':[]})
hid=None; pid=None; cno=None
for r in (rows(d) or []):
    h=call('/CaseInfo/GetHandInfo',params={'caseProcId':r.get('CaseProcId')})
    D=h.get('Data') or {}
    if D.get('IsReviewing') and (D.get('HandInfo') or {}).get('CaseHandId'):
        hid=D['HandInfo']['CaseHandId']; pid=r.get('CaseProcId'); cno=r.get('CaseNo'); break
if not hid:
    print('  没有可编辑递交实例'); raise SystemExit
print(f'  使用样本 {cno} procId={pid} handId={hid}')
g=call('/CaseInfo/GetOfficialFormList',params={'fileType':2,'caseHandId':hid})
print(f'  信封顶层键={sorted(g.keys())}  Data类型={type(g.get("Data")).__name__}')
if isinstance(g.get('Data'),dict): print(f'  Data键={sorted(g["Data"].keys())}')
print(f'  卡片样例={json.dumps((rows(g) or [{}])[0],ensure_ascii=False)[:400]}')

print(); print('='*72); print(' G. GetHandNextFlowList / GetHandNextFlowUserByStepId（项目传 caseReviewDraftId=handId）'); print('='*72)
nl=call('/CaseInfo/GetHandNextFlowList',params={'caseReviewDraftId':hid})
print(f'  GetHandNextFlowList 信封键={sorted(nl.keys())} IsSuccess={nl.get("IsSuccess")} Data={json.dumps(nl.get("Data"),ensure_ascii=False)[:600]}')
for step in (rows(nl) or [])[:4]:
    sid=step.get('CaseHandStepId')
    print(f'     step={json.dumps(step,ensure_ascii=False)[:200]}')
    if sid:
        u=call('/CaseInfo/GetHandNextFlowUserByStepId',params={'caseHandStepId':sid})
        print(f'       users信封键={sorted(u.keys())} Data={json.dumps(u.get("Data"),ensure_ascii=False)[:300]}')

print(); print('='*72); print(' H. GetFormInstructionsAndImage formCode=000000（项目 instructionsCode 回退值）'); print('='*72)
fi=call('/CaseInfo/GetFormInstructionsAndImage',params={'caseHandId':hid,'formCode':'000000'})
print(f'  IsSuccess={fi.get("IsSuccess")} Message={fi.get("Message")!r} Data键={sorted((fi.get("Data") or {}).keys()) if isinstance(fi.get("Data"),dict) else type(fi.get("Data")).__name__}')
D=fi.get('Data') or {}
if isinstance(D,dict):
    print(f'  FormGroup={json.dumps(D.get("FormGroup"),ensure_ascii=False)[:700]}')
    print(f'  Setting键={sorted((D.get("Setting") or {}).keys()) if isinstance(D.get("Setting"),dict) else D.get("Setting")}')
    print(f'  InstructionsAndImageSetting={json.dumps(D.get("InstructionsAndImageSetting"),ensure_ascii=False)[:400]}')

print(); print('='*72); print(' I. 其他只读：通知书关联/文件列表/递交状态字典/流程明细'); print('='*72)
for label,path,params in [
    ('GetCaseHandProcRelateNoticeInfo','/CaseInfo/GetCaseHandProcRelateNoticeInfo',{'caseHandId':hid}),
    ('GetCaseHandFileList','/CaseInfo/GetCaseHandFileList',{'caseHandId':hid}),
    ('GetCaseHandSendStatusViewTypeList','/SystemTypeSetting/GetCaseHandSendStatusViewTypeList',None),
    ('GetCaseProcFileList','/CaseInfo/GetCaseProcFileList',{'caseProcId':pid}),
]:
    r=call(path,params=params)
    D2=r.get('Data')
    print(f'  {label}: IsSuccess={r.get("IsSuccess")} Data={json.dumps(D2,ensure_ascii=False)[:420]}')

det=call('/CaseInfo/GetCaseDetailProcList',{'caseId':None,'TableType':80001,'SortInfo':{},'UserTableTitleColumnList':['CaseProcName','CaseProcCustomDate','CaseProcLegalDate','CaseProcFinishDate','CaseProcUndertakerUserName','CaseProcCurrentStatus','CaseProcCurrentFlowName']})
print(f'  GetCaseDetailProcList(用第2次真实caseId): 先取 caseId')
PY
