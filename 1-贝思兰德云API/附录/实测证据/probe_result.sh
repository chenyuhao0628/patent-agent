#!/usr/bin/env bash
# 只读探针八：只回答一个问题——「授权 / 驳回」这两个官方结果，现在能不能直接拿到。
# 检验：13 个 ItemType 的历史条数、订阅类目是否限制明细、窗口能开多大、驳回明细长什么样。
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
N=0
def call(path, body=None, params=None):
    global N
    N+=1
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
def brief(v,n=300):
    s=json.dumps(v,ensure_ascii=False); return s if len(s)<=n else s[:n]+'…'
def clean(v): return '' if v is None else str(v).strip()

NAMES={1:'受理专利(中国)',2:'授权专利(中国)',3:'审查意见专利(中国)',4:'补正专利(中国)',5:'驳回专利(中国)',
       6:'法限到期专利',7:'审查业务专用函专利(中国)',8:'获证专利(中国)',9:'视撤专利(中国)',10:'其他官文(中国)',
       11:'手续合格(著录项目变更)(中国)',12:'手续合格(撤回专利申请)(中国)',13:'手续合格(放弃专利权)(中国)'}
SUB=[1,2,3,4,5,6,7,8,11,12,13]

print('='*84); print(' A. 各类目历史条数（明细计数接口，窗口 365 天）—— 订阅类目 vs 未订阅类目'); print('='*84)
print('  订阅设置 ItemTypeList =', SUB, '（9 视撤 与 10 其他官文 未订阅）')
print()
print('  ItemType  名称                              365天条数   7天条数')
for t in sorted(NAMES):
    c365=call('/NoPermissionRequired/GetCaseNewTrendsDetailCount',body={'ItemType':t,'ReminderDuration':365}).get('Data')
    c7=call('/NoPermissionRequired/GetCaseNewTrendsDetailCount',body={'ItemType':t,'ReminderDuration':7}).get('Data')
    tag='' if t in SUB else '  ← 未订阅'
    print(f'  {t:>8}  {NAMES[t]:32s} {str(c365):>8}  {str(c7):>8}{tag}')

print()
print('='*84); print(' B. 窗口能开多大（ItemType=2 授权）'); print('='*84)
for days in (7,30,90,365,3650,36500):
    d=call('/NoPermissionRequired/GetCaseNewTrendsDetailCount',body={'ItemType':2,'ReminderDuration':days})
    print(f'  ReminderDuration={days:<6} -> IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} Data={d.get("Data")!r}')

print()
print('='*84); print(' C. 驳回明细长什么样（ItemType=5，窗口 365）'); print('='*84)
d=call('/NoPermissionRequired/GetCaseNewTrendsDetailList',body={'PagedInfo':{'PageIndex':1,'PageSize':50},'ItemType':5,'ReminderDuration':365})
rs=rows(d)
print(f'  IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} 行数={len(rs) if isinstance(rs,list) else rs}')
for r in (rs or [])[:10]:
    print('   ', brief({k:r.get(k) for k in ('CaseNo','CaseName','ClientName','PostDate','ApplicationNo','ApplyTypeName','NoticeId')},300))

print()
print('='*84); print(' D. 授权明细（ItemType=2，窗口 365）—— 与 7 天口径对比'); print('='*84)
d=call('/NoPermissionRequired/GetCaseNewTrendsDetailList',body={'PagedInfo':{'PageIndex':1,'PageSize':50},'ItemType':2,'ReminderDuration':365})
rs=rows(d)
print(f'  IsSuccess={d.get("IsSuccess")} 行数={len(rs) if isinstance(rs,list) else rs}')
for r in (rs or [])[:10]:
    print('   ', brief({k:r.get(k) for k in ('CaseNo','CaseName','ClientName','PostDate','ApplicationNo','ApplyTypeName','NoticeId')},300))

print()
print('='*84); print(' E. 未订阅类目能否在明细里查到（ItemType=9 视撤 / 10 其他官文，窗口 365）'); print('='*84)
for t in (9,10):
    d=call('/NoPermissionRequired/GetCaseNewTrendsDetailList',body={'PagedInfo':{'PageIndex':1,'PageSize':20},'ItemType':t,'ReminderDuration':365})
    print(f'  ItemType={t} -> IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} 行数={len(rows(d)) if isinstance(rows(d),list) else None}')
    for r in (rows(d) or [])[:3]: print('     ', brief({k:r.get(k) for k in ('CaseNo','CaseName','ClientName','PostDate')},200))

print()
print('='*84); print(' F. 一次请求能否同时看授权+驳回（明细不带 ItemType / 带列表）'); print('='*84)
for body in ({'PagedInfo':{'PageIndex':1,'PageSize':20},'ReminderDuration':365},
             {'PagedInfo':{'PageIndex':1,'PageSize':20},'ItemTypeList':[2,5],'ReminderDuration':365},
             {'PagedInfo':{'PageIndex':1,'PageSize':20},'ItemTypeList':[2,5],'ReminderDuration':7}):
    d=call('/NoPermissionRequired/GetCaseNewTrendsDetailList',body=body)
    rs=rows(d)
    print(f'  body={brief(body,120)}')
    print(f'    -> IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} 行数={len(rs) if isinstance(rs,list) else rs}')
    for r in (rs or [])[:4]:
        print('       ', brief({k:r.get(k) for k in ('CaseNo','ClientName','PostDate','ItemType','ItemTypeName')},200))
print()
print(f'本探针共 {N} 次只读请求')
PY
