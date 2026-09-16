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
def call(path, body=None, params=None):
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

print('='*78); print(' ① 案件列表里自带的「文件数 / 官文日期」是否可直接当变更信号'); print('='*78)
allrows=[]
for name,tt,st in [('waitHand',50010,0),('delivering',50013,400),('finish',50014,500)]:
    d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':100},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':name,'SelectedProcIdGroup':[]})
    for r in (rows(d) or []):
        allrows.append((name,r))
print(f'  样本 {len(allrows)} 条流程')
print(f'  {"页签":11s} {"案号":18s} {"文件数":>5s} {"CaseProcNewDocDate":20s} {"LastSyncOfficialDate":22s} {"创建日期":12s}')
from collections import Counter
cnt=Counter()
for name,r in allrows[:18]:
    ftc=r.get('CaseProcFileTotalCount')
    cnt[str(ftc)]+=1
    print(f'  {name:11s} {str(r.get("CaseNo"))[:18]:18s} {str(ftc):>5s} {str(r.get("CaseProcNewDocDate"))[:20]:20s} {str(r.get("LastSyncOfficialDate"))[:22]:22s} {str(r.get("CaseProcCreateDate"))[:12]:12s}')
print('  CaseProcFileTotalCount 取值分布:',dict(cnt))

print(); print('='*78); print(' ② 自带文件数 vs 单独的计数接口 是否一致'); print('='*78)
for name,r in allrows[:6]:
    cid=r.get('CaseId')
    a=r.get('CaseProcFileTotalCount')
    b=call('/CaseInfo/GetCaseFileAllListCount',params={'caseId':cid}).get('Data')
    print(f'  {str(r.get("CaseNo"))[:20]:22s} 案件行自带={a!r}   GetCaseFileAllListCount={b!r}  {"一致" if a==b else "★不一致"}')

print(); print('='*78); print(' ③ 聚合/工作台计数：一次请求能拿到什么'); print('='*78)
d=call('/CaseInfo/GetPersonalProcStatistics')
print('  GetPersonalProcStatistics -> IsSuccess=%s Msg=%r Data=%s'%(d.get('IsSuccess'),d.get('Message'),json.dumps(d.get('Data'),ensure_ascii=False)[:300]))
d=call('/CaseInfo/GetCaseHandInfoTabCount')
print('  GetCaseHandInfoTabCount -> IsSuccess=%s Msg=%r Data=%s'%(d.get('IsSuccess'),d.get('Message'),json.dumps(d.get('Data'),ensure_ascii=False)[:300]))
d=call('/CaseMonitor/GetCaseMonitoringCaseStatusCountInfo',{})
print('  CaseMonitor/GetCaseMonitoringCaseStatusCountInfo -> IsSuccess=%s Msg=%r Data=%s'%(d.get('IsSuccess'),d.get('Message'),json.dumps(d.get('Data'),ensure_ascii=False)[:400]))

print(); print('='*78); print(' ④ 新动态 ItemType 全集（看含不含文件）'); print('='*78)
d=call('/SystemTypeSetting/GetCaseNewTrendsItemTypeDropDown')
print('  GetCaseNewTrendsItemTypeDropDown ->', json.dumps(d.get('Data'),ensure_ascii=False)[:600])
d=call('/NoPermissionRequired/GetCaseNewTrendsStatisticsCount')
print('  统计 ->', json.dumps(d.get('Data'),ensure_ascii=False)[:600])
d=call('/NoPermissionRequired/GetCaseNewTrendsUserSetting')
print('  用户设置 ->', json.dumps(d.get('Data'),ensure_ascii=False)[:300])

print(); print('='*78); print(' ⑤ 站内消息开关（谁能开）'); print('='*78)
for p in ['/SystemCompany/IsOfficialFeeAutoSync','/SystemCompany/IsAutoLoadPendingFee','/SystemCompany/CanSeparatePackFiveForms']:
    d=call(p); print(f'  {p} -> {d.get("IsSuccess")} {d.get("Data")!r}')
PY
