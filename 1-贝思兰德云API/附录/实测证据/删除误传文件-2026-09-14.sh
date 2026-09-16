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
    except Exception: return {'_raw':r.stdout[:400]}
def rows(d):
    v=d.get('Data') if isinstance(d,dict) else None
    if isinstance(v,list): return v
    if isinstance(v,dict):
        for k in ('List','ListData','Rows','DataList','Items'):
            if isinstance(v.get(k),list): return v[k]
    return None

CID='dea01908-8a21-490c-868a-cff148138d63'
WANT_NAME='同步验证_202608262-1258_20260914.txt'
WANT_ID='08df1217-b6ae-4bdb-8704-f8ccb493ffb2'

print('='*74); print(' 第1步 删除前校验'); print('='*74)
g=call('/CaseInfo/GetCaseFileAllList',params={'caseId':CID})
rs=rows(g) or []
print(f'  案内文件数 = {len(rs)}')
match=[r for r in rs if r.get('CaseFileId')==WANT_ID and r.get('FileName')==WANT_NAME]
for r in rs:
    print(f"    {r.get('FileName')}  | CaseFileId={r.get('CaseFileId')} | 类型={r.get('FileTypeName')}")
print()
print(f'  唯一命中（CaseFileId+文件名 同时相等）= {len(match)}')
if len(match)!=1:
    print('  !! 校验不通过，放弃删除'); raise SystemExit(1)
m=match[0]
print(f"  目标确认: {m.get('FileName')}  CaseFileId={m.get('CaseFileId')}  上传人={m.get('UploadUsername')}  {m.get('UploadDate')}")
print('  校验通过，执行删除')

print(); print('='*74); print(' 第2步 调用 GET /CaseInfo/DeleteFile'); print('='*74)
d=call('/CaseInfo/DeleteFile',params={'caseFileId':WANT_ID})
print('  原始响应:', json.dumps(d,ensure_ascii=False)[:500])

print(); print('='*74); print(' 第3步 删除后复核'); print('='*74)
g2=call('/CaseInfo/GetCaseFileAllList',params={'caseId':CID})
rs2=rows(g2) or []
print(f'  案内文件数 = {len(rs2)}')
for r in rs2:
    print(f"    {r.get('FileName')}  | CaseFileId={r.get('CaseFileId')} | 类型={r.get('FileTypeName')}")
still=[r for r in rs2 if r.get('CaseFileId')==WANT_ID]
print()
print('  结论:', '已删除 ✅' if not still else '仍存在 ❌')
fp=call('/CaseInfo/GetCaseProcFileList',params={'caseProcId':'ca1942f9-3085-4fdb-b035-a8d939567535'})
print(f"  流程文件列表复核: {len(rows(fp) or [])} 个文件")
PY
