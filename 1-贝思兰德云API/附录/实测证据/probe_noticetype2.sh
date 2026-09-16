#!/usr/bin/env bash
# 只读探针十一：官文类型字典全量（GetNoticeTypeDropDown），筛出授权/驳回/证书等官方结果。
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
d=call('/NoticeType/GetNoticeTypeDropDown')
rs=rows(d) or []
print('官文类型字典：IsSuccess=%s 共 %d 条' % (d.get('IsSuccess'), len(rs)))
print('行字段：', sorted(rs[0].keys()) if rs else '-')
print()
GROUPS={
 '授权 / 办登 / 证书': ('授权','登记','证书','办登','领证'),
 '驳回 / 视撤 / 无效': ('驳回','视为撤回','视撤','无效','放弃'),
 '公开 / 实审 / 受理 / 初审': ('公开','实质审查','进入实审','受理','初步审查','初审'),
 '审查意见 / 补正': ('审查意见','补正'),
 '复审 / 其他程序': ('复审','中止','保全','恢复'),
 '专用函 / 回执 / 手续': ('专用函','回执','手续'),
}
for title,keys in GROUPS.items():
    print('='*78); print(f' {title}'); print('='*78)
    hit=0
    for r in rs:
        name=str(r.get('label') or '')
        if any(k in name for k in keys):
            hit+=1
            print(f"  {str(r.get('NoticeCode')):>8}  中国  ApplyTypeCode={r.get('ApplyTypeCode')}  {name}")
    if not hit: print('  （本字典无此类条目）')
    print()
print('='*78); print(' 说明'); print('='*78)
print('  value 是 NoticeTypeId（与 GetNoticeListByCaseId 行的 NoticeTypeId 对应）；')
print('  NoticeCode 是纯数字类型码（与行的 NoticeTypeCode 对应）。')
PY
