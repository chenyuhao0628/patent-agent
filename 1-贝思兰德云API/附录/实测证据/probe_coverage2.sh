#!/usr/bin/env bash
# 只读探针十三：
#  A. 完整走完「授权→获证」的两案（0737/0749）案卷字段是否已填（对比银生案的空白）；
#  B. 官文下载规则（PatentNoticeRule）是否解释了「受理通知书一律没有」。
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
export WANT="${1:-202606292-0737,202606292-0749}"
python3 - <<'PY'
import json,os,subprocess
from urllib.parse import urlencode
API=os.environ['API']; ORIGIN=os.environ['ORIGIN']; TOKEN=os.environ['TOKEN']
WANT=[x for x in os.environ['WANT'].split(',') if x]
N=[0]
def call(path, body=None, params=None):
    N[0]+=1
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
def brief(v,n=240):
    s=json.dumps(v,ensure_ascii=False); return s if len(s)<=n else s[:n]+'…'

# 先按案号找 CaseId
by_no={}
for tab,tt,st in [('waitHand',50010,0),('auditing',50011,200),('waitDeliver',50012,300),('delivering',50013,400),('finish',50014,500)]:
    d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':100},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':tab,'SelectedProcIdGroup':[]})
    for r in rows(d) or []:
        by_no.setdefault(clean(r.get('CaseNo')),clean(r.get('CaseId')))

print('='*88); print(' A. 已走完「授权→获证」的案件：官文清单 + 案卷字段'); print('='*88)
for no in WANT:
    cid=by_no.get(no)
    print(f'  ● {no}  CaseId={cid or "（未在个人页签中找到）"}')
    if not cid: continue
    d=call('/CaseInfo/GetNoticeListByCaseId',body={'caseId':cid,'PagedInfo':{'PageIndex':1,'PageSize':100}})
    for r in sorted(rows(d) or [],key=lambda r:clean(r.get('PostDate'))):
        print(f"      官文 {clean(r.get('PostDate'))[:10]}  {clean(r.get('NoticeName')):22s} 类型={r.get('NoticeTypeCode')} 状态={clean(r.get('NoticeStatusName'))}")
    d=call('/CaseInfo/GetUpdateCaseInfo',params={'caseId':cid})
    ci=(d.get('Data') or {}).get('CaseInfo') if isinstance(d.get('Data'),dict) else {}
    if isinstance(ci,dict):
        keys=['AuthorizeDate','AuthorizePostDate','CertificateDate','CertificateNo','IssueDate','IssueNo','PublicDate','PublicNo','CaseStatusType','IsFinishCase']
        filled=[(k,ci.get(k)) for k in keys if ci.get(k) not in (None,'',[])]
        print(f'      案卷字段（非空）：{filled if filled else "（授权/证书类字段全空）"}')
    print()

print('='*88); print(' B. 官文下载规则：是否解释「受理通知书一律没有」'); print('='*88)
for path,body,params in [('/PatentNoticeRule/GetPatentNoticeRuleList',{'PagedInfo':{'PageIndex':1,'PageSize':50}},None),
                         ('/PatentNoticeRule/GetPatentNoticeRuleList',{},None),
                         ('/PatentNoticeRule/GetPatentNoticeRuleItemList',None,{}),
                         ('/NoticeType/GetNoticeTypeRequiredFieldTypeList',None,None)]:
    d=call(path,body=body,params=params)
    rs=rows(d)
    print(f'  {path} {"body="+brief(body,40) if body is not None else "（无参）"} -> IsSuccess={d.get("IsSuccess")} Message={d.get("Message")} 行数={len(rs) if isinstance(rs,list) else rs}')
    if isinstance(rs,list) and rs:
        print('     行字段：', sorted(rs[0].keys()))
        for r in rs[:6]: print('     ', brief(r,300))
    elif d.get('Data') is not None:
        print('     Data=', brief(d.get('Data'),300))
print()
print(f'本探针共 {N[0]} 次只读请求')
PY
