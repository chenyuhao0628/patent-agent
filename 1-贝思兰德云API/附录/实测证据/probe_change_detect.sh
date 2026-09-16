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
    except Exception: return {'_raw':r.stdout[:250]}
def brief(d,n=260):
    if not isinstance(d,dict): return str(d)[:n]
    s=json.dumps(d,ensure_ascii=False)
    return s[:n]

CID='dea01908-8a21-490c-868a-cff148138d63'
print('='*76); print(' A. 案件级文件计数  GET /CaseInfo/GetCaseFileAllListCount'); print('='*76)
for p in ({'caseId':CID},):
    d=call('/CaseInfo/GetCaseFileAllListCount',params=p)
    print(f'   {p} -> IsSuccess={d.get("IsSuccess")} Code={d.get("Code")} Msg={d.get("Message")!r} Data={d.get("Data")!r}')

print(); print('='*76); print(' B. 文件中心计数  POST /CaseFile/GetFileCount'); print('='*76)
for tag,extra in [('空',{}),('仅表',{'PagedInfo':{'PageIndex':1,'PageSize':10},'TableType':20101}),('按案号',{'PagedInfo':{'PageIndex':1,'PageSize':10},'TableType':20101,'CaseNo':'202608262-1258'})]:
    b={'PagedInfo':{'PageIndex':1,'PageSize':10,'SortField':None,'SortType':None},'UserTableTitleColumnList':[],'TableType':20101}
    b.update(extra)
    d=call('/CaseFile/GetFileCount',b)
    print(f'   [{tag}] IsSuccess={d.get("IsSuccess")} Code={d.get("Code")} Msg={d.get("Message")!r} Data={d.get("Data")!r}')

print(); print('='*76); print(' C. 消息中心  /WebSiteMessage/*'); print('='*76)
d=call('/WebSiteMessage/IsOpenWebSiteMessage')
print(f'   IsOpenWebSiteMessage -> IsSuccess={d.get("IsSuccess")} Msg={d.get("Message")!r} Data={d.get("Data")!r}')
for b in ({},{'PagedInfo':{'pageIndex':1,'pageSize':10}},{'pageIndex':1,'pageSize':10}):
    d=call('/WebSiteMessage/GetWebSiteMessageCount',b)
    print(f'   GetWebSiteMessageCount {b} -> IsSuccess={d.get("IsSuccess")} Code={d.get("Code")} Msg={d.get("Message")!r} Data={d.get("Data")!r}')
for b in ({'PagedInfo':{'pageIndex':1,'pageSize':5}},{'pageIndex':1,'pageSize':5},{}):
    d=call('/WebSiteMessage/GetWebSiteMessageList',b)
    print(f'   GetWebSiteMessageList {b} -> IsSuccess={d.get("IsSuccess")} Msg={d.get("Message")!r} Data={brief(d.get("Data"),400)}')

print(); print('='*76); print(' D. 案件新动态  /NoPermissionRequired/*'); print('='*76)
d=call('/NoPermissionRequired/IsViewCaseNewTrends')
print(f'   IsViewCaseNewTrends -> IsSuccess={d.get("IsSuccess")} Msg={d.get("Message")!r} Data={d.get("Data")!r}')
d=call('/NoPermissionRequired/GetCaseNewTrendsStatisticsCount')
print(f'   GetCaseNewTrendsStatisticsCount -> IsSuccess={d.get("IsSuccess")} Msg={d.get("Message")!r} Data={brief(d.get("Data"),300)}')
for b in ({},{'Date':None},{'PageInfo':{'pageIndex':1,'pageSize':5}}):
    d=call('/NoPermissionRequired/GetCaseNewTrendsDetailCount',b)
    print(f'   GetCaseNewTrendsDetailCount {b} -> IsSuccess={d.get("IsSuccess")} Msg={d.get("Message")!r} Data={d.get("Data")!r}')
for b in ({'PageInfo':{'pageIndex':1,'pageSize':3}},):
    d=call('/NoPermissionRequired/GetCaseNewTrendsDetailList',b)
    print(f'   GetCaseNewTrendsDetailList -> IsSuccess={d.get("IsSuccess")} Msg={d.get("Message")!r} Data={brief(d.get("Data"),400)}')

print(); print('='*76); print(' E. 操作日志  POST /TenantOperationLog/GetQueryListCount'); print('='*76)
for b in ({},{'PagedInfo':{'PageIndex':1,'PageSize':5}},{'PageInfo':{'pageIndex':1,'pageSize':5}}):
    d=call('/TenantOperationLog/GetQueryListCount',b)
    print(f'   {b} -> IsSuccess={d.get("IsSuccess")} Code={d.get("Code")} Msg={d.get("Message")!r} Data={d.get("Data")!r}')
PY
