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
    except Exception: return {'_raw':r.stdout[:250]}
def rows(d):
    v=d.get('Data') if isinstance(d,dict) else None
    if isinstance(v,list): return v
    if isinstance(v,dict):
        for k in ('List','ListData','Rows','DataList','Items'):
            if isinstance(v.get(k),list): return v[k]
    return None
BASE={'PagedInfo':{'PageIndex':1,'PageSize':10,'SortField':None,'SortType':None},'UserTableTitleColumnList':[],'TableType':20101}

print('='*76); print(' A. GetFileCount 的筛选能力'); print('='*76)
tests=[
 ('无筛选',{}),
 ('按案号',{'CaseNo':'202608262-1258'}),
 ('上传日期起 2026-09-01',{'UploadDateStart':'2026-09-01','UploadDateEnd':'2026-09-30'}),
 ('上传日期起 2026-09-14',{'UploadDateStart':'2026-09-14','UploadDateEnd':'2026-09-15'}),
 ('文件名模糊',{'FileName':'同步验证'}),
]
for tag,extra in tests:
    b={**BASE,**extra}
    d=call('/CaseFile/GetFileCount',b)
    print(f'   {tag:24s} -> IsSuccess={d.get("IsSuccess")} Msg={d.get("Message")!r} Count={d.get("Data")!r}')

print(); print('='*76); print(' B. 计数 vs 列表条数 是否一致（同一筛选）'); print('='*76)
for tag,extra in [('按案号',{'CaseNo':'202608262-1258'}),('无筛选',{})]:
    b={**BASE,**extra}
    c=call('/CaseFile/GetFileCount',b).get('Data')
    l=rows(call('/CaseFile/GetFileList',{**b,'PagedInfo':{'PageIndex':1,'PageSize':10,'SortField':None,'SortType':None}}))
    print(f'   {tag}: Count={c}  首页返回 {len(l) if l is not None else None} 行')

print(); print('='*76); print(' C. 取「最新一个文件」—— 排序参数'); print('='*76)
for sf,st in [('UploadDate','desc'),('UploadDate','DESC'),('UploadDate','descending'),(None,None)]:
    b={**BASE,'PagedInfo':{'PageIndex':1,'PageSize':1,'SortField':sf,'SortType':st}}
    d=call('/CaseFile/GetFileList',b)
    l=rows(d)
    if l:
        f=l[0]
        print(f'   SortField={sf} SortType={st} -> {len(l)} 行  最新: {str(f.get("FileName"))[:40]} | {f.get("UploadDate")} | FileNo={f.get("FileNo")}')
    else:
        print(f'   SortField={sf} SortType={st} -> IsSuccess={d.get("IsSuccess")} Msg={d.get("Message")!r}')

print(); print('='*76); print(' D. 案件新动态详情列表的参数形状'); print('='*76)
for b in ({'PagedInfo':{'pageIndex':1,'pageSize':5}},{'PageInfo':{'PageIndex':1,'PageSize':5}},
          {'PagedInfo':{'pageIndex':1,'pageSize':5},'ItemType':3},{'ReminderDuration':7,'PagedInfo':{'pageIndex':1,'pageSize':5}}):
    d=call('/NoPermissionRequired/GetCaseNewTrendsDetailList',b)
    l=rows(d)
    print(f'   {json.dumps(b,ensure_ascii=False)[:70]:72s} -> IsSuccess={d.get("IsSuccess")} Msg={d.get("Message")!r} 行数={len(l) if l is not None else None}')
PY
