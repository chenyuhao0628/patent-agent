#!/usr/bin/env bash
# 只读探针六：授权/办登官文的完整字段 + 文件下载校验 + 官文列表类信号。
# 只读：CaseInfo/GetNoticeById、CaseInfo/GetNoticeList(+Count/TabCount)、
#       NoPermissionRequired/FileStorageGetFile（下载到远端 /tmp 校验后立即删除，不落盘保留）。
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
def dump(obj,title,maxn=40):
    print(f'  —— {title} ——')
    if not isinstance(obj,dict): print('   ',type(obj).__name__, brief(obj,200)); return
    n=0
    for k,v in obj.items():
        if v in (None,'',[]): continue
        print(f'    {k:30s} = {brief(v,180)}'); n+=1
        if n>=maxn: print('    …'); break

print('='*84); print(' A. 办登官文全字段：GetNoticeById?noticeId=%s' % NOTICE_ID[:8]); print('='*84)
d=call('/CaseInfo/GetNoticeById',params={'noticeId':NOTICE_ID})
data=d.get('Data') if isinstance(d.get('Data'),dict) else {}
print(f'  IsSuccess={d.get("IsSuccess")} 顶层键={sorted(data.keys())}')
dump(data.get('Notice'),'Notice')
dump(data.get('NoticeExtend'),'NoticeExtend')
dump(data.get('Case'),'Case')
print('  —— FileList ——')
files=[]
for f in (data.get('FileList') or []):
    files.append(f)
    print('    ', brief(f,240))
print('  —— NoticeFeeList ——')
for f in (data.get('NoticeFeeList') or []): print('    ', brief(f,240))
print('  —— NoticeAnnualLateFeeList ——')
for f in (data.get('NoticeAnnualLateFeeList') or []): print('    ', brief(f,240))

print()
print('='*84); print(' B. 下载校验（远端 /tmp，校验后删除）'); print('='*84)
for f in files:
    fno=clean(f.get('FileNo')); name=clean(f.get('FileName'))
    if not fno: continue
    out='/tmp/probe6_%s.bin' % fno[:8]
    cmd=['curl','-sS','-k','-m','60','--get',API+'/NoPermissionRequired/FileStorageGetFile',
         '-H','Authorization: '+TOKEN,'-H','Language: zh-CN',
         '--data-urlencode','fileNo='+fno,'--data-urlencode','forBlob=true','-o',out]
    r=subprocess.run(cmd,capture_output=True,text=True)
    if os.path.exists(out):
        head=open(out,'rb').read(5); size=os.path.getsize(out)
        print(f'  {name[:60]:60s} {size:>9d} B  头5字节={head!r}  {"PDF ✓" if head==b"%PDF-" else "非 PDF"}')
        os.remove(out)
    else:
        print(f'  {name[:60]:60s} 下载失败 rc={r.returncode} {r.stderr[:120]}')

print()
print('='*84); print(' C. 官文管理类信号：GetNoticeList / Count / TabCount'); print('='*84)
for body in ({'PagedInfo':{'PageIndex':1,'PageSize':20}},
             {'PagedInfo':{'PageIndex':1,'PageSize':20},'NoticeTypeCodeList':[200602]},
             {'PagedInfo':{'PageIndex':1,'PageSize':20},'PostDateStart':'2026-09-01T00:00:00','PostDateEnd':'2026-09-30T23:59:59'}):
    d=call('/CaseInfo/GetNoticeList',body=body)
    rs=rows(d)
    print(f'  body={brief(body,110)}')
    print(f'    -> IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} 行数={len(rs) if isinstance(rs,list) else rs}')
    for r in (rs or [])[:5]:
        print('       ', brief({k:r.get(k) for k in ('NoticeName','NoticeTypeCode','CaseNo','PostDate','NoticeStatusName','IsRead','IsUserDownloaded')},240))
for path in ('/CaseInfo/GetNoticeListCount','/CaseInfo/GetNoticeListTabCount','/CaseInfo/GetNoticeListChildTabCount'):
    d=call(path,params={'caseId':CID})
    print(f'  GET {path}?caseId=… -> IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} Data={brief(d.get("Data"),300)}')
    d=call(path)
    print(f'  GET {path}（无参） -> IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} Data={brief(d.get("Data"),300)}')

print()
print('='*84); print(' D. 该案官文清单里各官文的类型码（记录授权/办登对应的 NoticeTypeCode）'); print('='*84)
d=call('/CaseInfo/GetNoticeListByCaseId',body={'caseId':CID,'PagedInfo':{'PageIndex':1,'PageSize':100}})
for r in rows(d) or []:
    print(f'    {clean(r.get("PostDate"))[:10]}  {clean(r.get("NoticeName")):22s} NoticeTypeCode={r.get("NoticeTypeCode")} 状态={clean(r.get("NoticeStatusName"))} 已读={r.get("IsRead")} 已下载={r.get("IsUserDownloaded")} 文件数={len(r.get("FileList") or [])}')
PY
