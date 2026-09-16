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

CID='dea01908-8a21-490c-868a-cff148138d63'
print('='*74); print(' 1. 目标文件完整字段'); print('='*74)
g=call('/CaseInfo/GetCaseFileAllList',params={'caseId':CID})
r=(rows(g) or [{}])[0]
for k in sorted(r.keys()):
    v=r.get(k)
    if v not in (None,'',[]): print(f'   {k:26s} = {v!r}')

print(); print('='*74); print(' 2. 横向对照：别的案件的文件 IsCanDelete 是什么'); print('='*74)
seen=0
for name,tt,st in [('delivering',50013,400),('finish',50014,500),('waitHand',50010,0)]:
    d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':6},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':name,'SelectedProcIdGroup':[]})
    for row in (rows(d) or []):
        cid=row.get('CaseId')
        gg=call('/CaseInfo/GetCaseFileAllList',params={'caseId':cid})
        rr=rows(gg) or []
        for f in rr:
            print(f"   [{name}] {row.get('CaseNo')} | {str(f.get('FileName'))[:34]:36s} 类型={f.get('FileTypeName')} IsCanDelete={f.get('IsCanDelete')} 上传={f.get('UploadUsername')} {f.get('UploadDate')}")
            seen+=1
        if rr==[]:
            print(f"   [{name}] {row.get('CaseNo')} | (无文件)")
        if seen>=10: break
    if seen>=10: break
PY
