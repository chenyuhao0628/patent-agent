#!/usr/bin/env bash
# 只读探针四：把「案件新动态」这一组接口的枚举、窗口、明细、法律期限变体一次验全，
# 供 15-只读-授权与获证检测.md 引用。
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
    except Exception: return {'_raw':r.stdout[:300]}
def rows(d):
    v=d.get('Data') if isinstance(d,dict) else None
    if isinstance(v,list): return v
    if isinstance(v,dict):
        for k in ('List','ListData','Rows','DataList','Items'):
            if isinstance(v.get(k),list): return v[k]
    return None
def brief(v,n=500):
    s=json.dumps(v,ensure_ascii=False); return s if len(s)<=n else s[:n]+'…'

print('='*80); print(' A. ItemType 枚举全集：SystemTypeSetting/GetCaseNewTrendsItemTypeDropDown'); print('='*80)
d=call('/SystemTypeSetting/GetCaseNewTrendsItemTypeDropDown')
print('  IsSuccess=%s Message=%s' % (d.get('IsSuccess'), d.get('Message')))
print('  Data=%s' % brief(d.get('Data'),900))
print()
print('='*80); print(' B. 窗口设置：GetCaseNewTrendsUserSetting'); print('='*80)
d=call('/NoPermissionRequired/GetCaseNewTrendsUserSetting')
print('  IsSuccess=%s Message=%s Data=%s' % (d.get('IsSuccess'), d.get('Message'), brief(d.get('Data'),400)))
print()
print('='*80); print(' C. 授权/获证明细：ItemType=2 与 8，窗口 7 与 30'); print('='*80)
for item in (2,8):
    for days in (7,30):
        d=call('/NoPermissionRequired/GetCaseNewTrendsDetailList',body={'PagedInfo':{'PageIndex':1,'PageSize':50},'ItemType':item,'ReminderDuration':days})
        rs=rows(d) or []
        print(f'  ItemType={item} ReminderDuration={days} -> IsSuccess={d.get("IsSuccess")} 行数={len(rs) if isinstance(rs,list) else rs}')
        for r in rs[:5]:
            print('     ', brief({k:r.get(k) for k in r if any(s in k for s in ('CaseNo','CaseName','Client','PostDate','ApplicationDate','ItemType'))},300))
        if isinstance(rs,list) and rs: print('      全字段：', brief(rs[0],400))
print()
print('='*80); print(' D. 法律期限变体：GetCaseNewTrendsLegalDateDetailCount / List'); print('='*80)
d=call('/NoPermissionRequired/GetCaseNewTrendsLegalDateDetailCount',body={'PagedInfo':{'PageIndex':1,'PageSize':20},'ReminderDuration':30})
print('  Count IsSuccess=%s Message=%s Data=%s' % (d.get('IsSuccess'), d.get('Message'), brief(d.get('Data'),200)))
d=call('/NoPermissionRequired/GetCaseNewTrendsLegalDateDetailList',body={'PagedInfo':{'PageIndex':1,'PageSize':20},'ReminderDuration':30})
rs=rows(d)
print('  List  IsSuccess=%s Message=%s 行数=%s' % (d.get('IsSuccess'), d.get('Message'), len(rs) if isinstance(rs,list) else rs))
for r in (rs or [])[:5]: print('     ', brief(r,320))
print()
print('='*80); print(' E. 统计接口的窗口是否可调（ReminderDuration 是 GET 无参，试 query）'); print('='*80)
for q in ({},{'ReminderDuration':30},{'reminderDuration':30}):
    d=call('/NoPermissionRequired/GetCaseNewTrendsStatisticsCount',params=q or None)
    print('  query=%s -> IsSuccess=%s ReminderDuration=%s' % (sorted(q.keys()), d.get('IsSuccess'), (d.get('Data') or {}).get('ReminderDuration') if isinstance(d.get('Data'),dict) else None))
PY
