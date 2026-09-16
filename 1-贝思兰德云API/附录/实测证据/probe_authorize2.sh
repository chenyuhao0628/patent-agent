#!/usr/bin/env bash
# 只读探针二：银生案（CaseId 0a7d2a5e-fa00-4bbc-a9d8-efef1abcbba3）的授权信息还能从哪些地方取到。
# 只读：CaseStatus/GetCaseStatus*、CaseInfo/GetCaseFileAllList、NoPermissionRequired/GetCaseNewTrends*。
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
STATUS_ID='a750af0a-2171-42fe-8f23-789ad86ab125'
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
def brief(v,n=400):
    s=json.dumps(v,ensure_ascii=False)
    return s if len(s)<=n else s[:n]+'…'

print('='*80); print(' A. 该案的自定义案件状态 CaseStatusId=%s' % STATUS_ID); print('='*80)
for params in ({'id':STATUS_ID},{'caseStatusId':STATUS_ID},{'Id':STATUS_ID}):
    d=call('/CaseStatus/GetCaseStatusById',params=params)
    print(f'  params={list(params)[0]:14s} IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} Data={brief(d.get("Data"),200)}')
    if d.get('IsSuccess') is True and d.get('Data'): break
print()
print('  CaseStatus/GetCaseStatus（案件状态字典全量）：')
d=call('/CaseStatus/GetCaseStatus',params={'pageIndex':1,'pageSize':100})
rs=rows(d)
print(f'    IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} 行数={len(rs) if isinstance(rs,list) else rs}')
for r in (rs or [])[:40]:
    print(f'      {clean(r.get("CaseStatusId") or r.get("Id"))[:8]}  {clean(r.get("CaseStatusName") or r.get("Name"))}  类型={r.get("CaseStatusType")}  {brief(r,160)}')
print()
print('='*80); print(' B. 该案文件中心 GetCaseFileAllList（找 授权通知书/办理登记手续/证书）'); print('='*80)
d=call('/CaseInfo/GetCaseFileAllList',params={'caseId':CID,'pageIndex':1,'pageSize':200})
rs=rows(d)
print(f'  IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} 行数={len(rs) if isinstance(rs,list) else rs}')
for r in (rs or []):
    name=clean(r.get('FileName'))
    flag=' <<<' if any(k in name for k in ('授权','授予','登记','证书','办登','专利证书')) else ''
    print(f'    {clean(r.get("FileTypeName")):12s} {name}{flag}')
print()
print('='*80); print(' C. 案件新动态 GetCaseNewTrendsStatisticsCount（近 7 天，含「授权/获证」类）'); print('='*80)
d=call('/NoPermissionRequired/GetCaseNewTrendsStatisticsCount')
print('  IsSuccess=%s Data=%s' % (d.get('IsSuccess'), brief(d.get('Data'),700)))
print()
print('  GetCaseNewTrendsDetailList 探形状（body 试两种）：')
for body in ({'PagedInfo':{'pageIndex':1,'pageSize':20}},{'PagedInfo':{'pageIndex':1,'pageSize':20},'ItemTypeList':[0,1,2,3],'ReminderDuration':7}):
    d=call('/NoPermissionRequired/GetCaseNewTrendsDetailList',body=body)
    rs=rows(d)
    print(f'    body={brief(body,90)} -> IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} 行数={len(rs) if isinstance(rs,list) else rs}')
    for r in (rs or [])[:6]:
        print('       ', brief({k:r.get(k) for k in list(r.keys())[:14]},260))
PY
