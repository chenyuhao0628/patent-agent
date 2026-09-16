#!/usr/bin/env bash
# 只读探针：查「银生」相关案件的授权信息能否从贝思兰德云 API 取到。
# 只读接口：Auth/GetToken、CaseInfo/GetPersonalCase、CaseInfo/GetUpdateCaseInfo、CaseInfo/GetCaseDetailProcList。
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
export KEY="${1:-银生}"
python3 - <<'PY'
import json,os,subprocess
from urllib.parse import urlencode
API=os.environ['API']; ORIGIN=os.environ['ORIGIN']; TOKEN=os.environ['TOKEN']; KEY=os.environ['KEY']
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

AUTH_FIELDS=['AuthorizeDate','AuthorizeDate_FormatName','CaseAuthorizePostDate','CaseAuthorizePostDate_FormatName',
             'CertificateDate','CertificateDate_FormatName','CertificateNo','IssueDate','IssueNo','PublicDate','PublicNo',
             'CaseStatus','CaseStatusType','CaseBeforeFinishStatus','CaseFinishCause','CaseTypeName','ApplyNo','CaseNo','ClientName','CaseName','CaseShortNumber']
print('='*80); print(' A. 五个页签里按关键字「%s」匹配的流程行' % KEY); print('='*80)
hits={}
for tab,tt,st in [('waitHand',50010,0),('auditing',50011,200),('waitDeliver',50012,300),('delivering',50013,400),('finish',50014,500)]:
    d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':100},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':tab,'SelectedProcIdGroup':[]})
    for r in rows(d) or []:
        blob=' '.join(clean(r.get(k)) for k in ('ClientName','CaseName','CaseNo','ApplyNo','ClientShortCode','ClientProjectNo'))
        if KEY and KEY not in blob: continue
        hits.setdefault(clean(r.get('CaseId')),[]).append((tab,r))
if not hits:
    print('  未在个人案件页签里匹配到「%s」。' % KEY)
for cid,items in hits.items():
    print(f'  案件 CaseId={cid}  （命中 {len(items)} 条流程行）')
    r=items[0][1]
    for k in AUTH_FIELDS:
        if k in r: print(f'    {k:34s} = {r.get(k)!r}')
    print(f'    页签 = {[t for t,_ in items]}；流程 = {[clean(x[1].get("CaseProcNameInfo",{}).get("CaseProcName") if isinstance(x[1].get("CaseProcNameInfo"),dict) else None) or clean(x[1].get("CaseProcName")) for x in items]}')
    print()
print('='*80); print(' B. 对命中案件取 GetUpdateCaseInfo，看 CaseInfo 里的授权字段'); print('='*80)
for cid in hits:
    d=call('/CaseInfo/GetUpdateCaseInfo',None,{'caseId':cid})
    data=d.get('Data') if isinstance(d.get('Data'),dict) else {}
    ci=data.get('CaseInfo') if isinstance(data.get('CaseInfo'),dict) else {}
    print(f'  CaseId={cid}  IsSuccess={d.get("IsSuccess")} CaseInfo键数={len(ci)}')
    keys=[k for k in ci.keys() if any(s in k for s in ('Authorize','Certificate','Issue','Public','Status','Finish','Legal'))]
    print('    相关键：', sorted(keys))
    for k in sorted(keys):
        v=ci.get(k)
        if v not in (None,'',[]): print(f'      {k:36s} = {v!r}')
    print()
print('='*80); print(' C. GetCaseDetailProcList：该案的全部流程（授权/办登类流程是否登记）'); print('='*80)
for cid in hits:
    d=call('/CaseInfo/GetCaseDetailProcList',{'caseId':cid,'TableType':80001,'SortInfo':{},'UserTableTitleColumnList':['CaseProcName','CaseProcCustomDate','CaseProcLegalDate','CaseProcFinishDate','CaseProcUndertakerUserName','CaseProcCurrentStatus','CaseProcCurrentFlowName']})
    print(f'  CaseId={cid}  IsSuccess={d.get("IsSuccess")}')
    for r in rows(d) or []:
        info=r.get('CaseProcNameInfo') if isinstance(r.get('CaseProcNameInfo'),dict) else {}
        name=clean(r.get('CaseProcName')) or clean(info.get('CaseProcName'))
        print(f'    {clean(r.get("CaseProcId"))[:8]}  {name:22s} 状态={r.get("ProcStatusCode")} 完成={clean(r.get("CaseProcFinishDate"))}')
    print()
PY
