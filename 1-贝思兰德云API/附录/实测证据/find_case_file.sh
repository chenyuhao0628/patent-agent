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
    except Exception: return {'_raw':r.stdout[:300]}
def rows(d):
    v=d.get('Data') if isinstance(d,dict) else None
    if isinstance(v,list): return v
    if isinstance(v,dict):
        for k in ('List','ListData','Rows','DataList','Items'):
            if isinstance(v.get(k),list): return v[k]
    return None
NO='202608262-1258'

print('='*74); print(' 1. 在五个页签里找这个案号'); print('='*74)
hits=[]
for name,tt,st in [('waitHand',50010,0),('auditing',50011,200),('waitDeliver',50012,300),('delivering',50013,400),('finish',50014,500)]:
    d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':100},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':name,'SelectedProcIdGroup':[],'CaseNoOrCaseNameOrClientName':NO})
    rs=rows(d) or []
    print(f'  {name:12s} -> {len(rs)} 行  IsSuccess={d.get("IsSuccess")}')
    for r in rs:
        hits.append((name,r))
        print(f'      CaseNo={r.get("CaseNo")} CaseName={r.get("CaseName")} CaseId={r.get("CaseId")} CaseProcId={r.get("CaseProcId")} Proc={((r.get("CaseProcNameInfo") or {}).get("CaseProcName"))} status={r.get("ProcStatusCode")}')
if not hits:
    print('  五个页签都没找到，换全局检索'); raise SystemExit(0)

name,row=hits[0]
cid=row.get('CaseId'); pid=row.get('CaseProcId')

print(); print('='*74); print(' 2. 案件级文件中心（GetCaseFileAllList）'); print('='*74)
for params in ({'caseId':cid},{'caseId':cid,'pageIndex':1,'pageSize':200}):
    g=call('/CaseInfo/GetCaseFileAllList',params=params)
    rs=rows(g)
    print(f'  params={params} -> IsSuccess={g.get("IsSuccess")} Message={g.get("Message")!r} 行数={len(rs) if rs is not None else None}')
    if rs:
        for f in rs:
            print('   ', json.dumps({k:f.get(k) for k in ('CaseFileId','FileNo','FileName','FileTypeName','FileTypeCode','CreateDate','UploadUserName','CreateUserName','FileRemark','IsCanDelete') if k in f},ensure_ascii=False))
        print('  首行全部键:', sorted(rs[0].keys()))
        break

print(); print('='*74); print(' 3. 流程级文件（GetCaseProcFileList）'); print('='*74)
for _,r2 in hits:
    p2=r2.get('CaseProcId')
    g=call('/CaseInfo/GetCaseProcFileList',params={'caseProcId':p2})
    rs=rows(g) or []
    print(f'  caseProcId={p2} -> {len(rs)} 个文件')
    for f in rs:
        print('   ', json.dumps({k:f.get(k) for k in ('CaseFileId','FileNo','FileName','FileTypeName','FileTypeCode','CreateDate','FileRemark') if k in f},ensure_ascii=False))
    if rs: print('  首行全部键:', sorted(rs[0].keys()))
PY
