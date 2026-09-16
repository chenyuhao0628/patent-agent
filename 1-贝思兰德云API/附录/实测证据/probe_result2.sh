#!/usr/bin/env bash
# 只读探针九：验证「案件新动态 = 尚未处理的官方动态」这一假设。
# 做法：拿动态里的案件，逐个看它官文清单中最新的官文是否仍是「待导入」；
#       并对照已知案件（银生案：审查意见通知书已导入 → 动态里没有「审查意见」类目）。
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
    except Exception: return {'_raw':r.stdout[:200]}
def rows(d):
    v=d.get('Data') if isinstance(d,dict) else None
    if isinstance(v,list): return v
    if isinstance(v,dict):
        for k in ('List','ListData','Rows','DataList','Items'):
            if isinstance(v.get(k),list): return v[k]
    return None
def clean(v): return '' if v is None else str(v).strip()

print('='*84); print(' A. 动态里出现的案件（授权 2 / 其他官文 10，365 天）'); print('='*84)
dyn=[]
for t in (2,10,7):
    d=call('/NoPermissionRequired/GetCaseNewTrendsDetailList',body={'PagedInfo':{'PageIndex':1,'PageSize':50},'ItemType':t,'ReminderDuration':365})
    for r in rows(d) or []:
        dyn.append((t,r))
        print(f"  [ItemType={t}] {clean(r.get('PostDate'))[:10]}  {clean(r.get('CaseNo'))}  {clean(r.get('ClientName'))}  CaseId={clean(r.get('CaseId'))}")
print()
print('='*84); print(' B. 这些案件的最新官文状态（是否仍为「待导入」）'); print('='*84)
seen=set()
for t,r in dyn:
    cid=clean(r.get('CaseId'))
    if not cid or cid in seen: continue
    seen.add(cid)
    d=call('/CaseInfo/GetNoticeListByCaseId',body={'caseId':cid,'PagedInfo':{'PageIndex':1,'PageSize':50}})
    rs=rows(d) or []
    print(f"  {clean(r.get('CaseNo'))}  {clean(r.get('CaseName'))[:28]}  官文 {len(rs)} 条：")
    for x in rs[:4]:
        print(f"     {clean(x.get('PostDate'))[:10]}  {clean(x.get('NoticeName')):22s} 类型={x.get('NoticeTypeCode')} 状态={clean(x.get('NoticeStatusName'))}")
    pend=[x for x in rs if clean(x.get('NoticeStatusName'))=='待导入']
    print(f"     → 其中「待导入」{len(pend)} 条")
    print()
print('='*84); print(' C. 对照：银生案官文状态 vs 动态类目'); print('='*84)
cid='0a7d2a5e-fa00-4bbc-a9d8-efef1abcbba3'
d=call('/CaseInfo/GetNoticeListByCaseId',body={'caseId':cid,'PagedInfo':{'PageIndex':1,'PageSize':50}})
for x in rows(d) or []:
    print(f"  {clean(x.get('PostDate'))[:10]}  {clean(x.get('NoticeName')):24s} 类型={x.get('NoticeTypeCode')} 状态={clean(x.get('NoticeStatusName'))}")
print()
for t,name in ((2,'授权专利(中国)'),(3,'审查意见专利(中国)'),(1,'受理专利(中国)'),(8,'获证专利(中国)')):
    c=call('/NoPermissionRequired/GetCaseNewTrendsDetailCount',body={'ItemType':t,'ReminderDuration':365}).get('Data')
    print(f'  该案动态里 {name:20s} 条数={c}')
PY
