#!/usr/bin/env bash
# 只读探针五：把「授权公告 → 拿到授权通知书」这条链走通。
# 只读：CaseInfo/GetNoticeById、GetNoticeListByCaseId(+Count)、GetCaseHandProcRelateNoticeFileList、
#       NoPermissionRequired/FileStorageGetFile（下载到远端 /tmp 校验后删除）。
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
CID='0a7d2a5e-fa00-4bbc-a9d8-efef1abcbba3'
NOTICE_ID='14a451a0-9902-4327-a4cd-61ebe3ce6701'
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
def brief(v,n=300):
    s=json.dumps(v,ensure_ascii=False); return s if len(s)<=n else s[:n]+'…'

print('='*84); print(' A. GetNoticeById：能否用案件新动态给的 NoticeId 直接取官文'); print('='*84)
got=None
for params in ({'noticeId':NOTICE_ID},{'id':NOTICE_ID},{'Id':NOTICE_ID},{'caseNoticeId':NOTICE_ID}):
    d=call('/CaseInfo/GetNoticeById',params=params)
    key=list(params)[0]
    print(f'  params={key:14s} IsSuccess={d.get("IsSuccess")} Message={d.get("Message")}')
    if d.get('IsSuccess') is True and d.get('Data'):
        got=d['Data']; print('    Data 键：', sorted(got.keys()) if isinstance(got,dict) else type(got).__name__)
        if isinstance(got,dict):
            for k,v in got.items():
                if v not in (None,'',[]): print(f'      {k:30s} = {brief(v,160)}')
        break
print()
print('='*84); print(' B. 该案的官文清单：GetNoticeListByCaseId / Count'); print('='*84)
d=call('/CaseInfo/GetNoticeListByCaseIdCount',params={'caseId':CID})
print(f'  Count(caseId) -> IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} Data={brief(d.get("Data"),120)}')
for body in ({'caseId':CID,'PagedInfo':{'PageIndex':1,'PageSize':100}},
             {'CaseId':CID,'PagedInfo':{'PageIndex':1,'PageSize':100}},
             {'caseId':CID,'PagedInfo':{'pageIndex':1,'pageSize':100}}):
    d=call('/CaseInfo/GetNoticeListByCaseId',body=body)
    rs=rows(d)
    print(f'  List body键={list(body)} -> IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} 行数={len(rs) if isinstance(rs,list) else rs}')
    if isinstance(rs,list) and rs:
        print('    行字段：', sorted(rs[0].keys()))
        for r in rs:
            print('     ', brief({k:r.get(k) for k in r if any(s in k for s in ('NoticeName','NoticeId','PostDate','FaWen','FileNo','FileName','CaseNo','CaseProcName','NoticeType'))},320))
        break
print()
print('='*84); print(' C. 官文对应的文件：GetCaseHandProcRelateNoticeFileList / GetNoticeList 兜底'); print('='*84)
for params in ({'noticeId':NOTICE_ID},{'caseHandId':NOTICE_ID}):
    d=call('/CaseInfo/GetCaseHandProcRelateNoticeFileList',params=params)
    rs=rows(d)
    print(f'  params={list(params)[0]:12s} IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} 行数={len(rs) if isinstance(rs,list) else rs}')
    if isinstance(rs,list) and rs: print('     ', brief(rs[0],300))
print()
print('='*84); print(' D. 若已拿到 FileNo：下载校验（写到远端 /tmp，校验后删除）'); print('='*84)
PY
