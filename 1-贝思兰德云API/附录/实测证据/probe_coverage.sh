#!/usr/bin/env bash
# 只读探针十二：官文清单的「收录起点」——是完整历史，还是从某天起才有？
# 做法：取全账号案件（5 页签），按案号（含立案日期）排序抽 12 个跨月份样本，
#       逐个取官文清单与流程明细，看最早官文日期、是否含受理通知书。
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

cases={}
for tab,tt,st in [('waitHand',50010,0),('auditing',50011,200),('waitDeliver',50012,300),('delivering',50013,400),('finish',50014,500)]:
    d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':100},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':tab,'SelectedProcIdGroup':[]})
    for r in rows(d) or []:
        cid=clean(r.get('CaseId'))
        if cid and cid not in cases:
            cases[cid]={'caseNo':clean(r.get('CaseNo')),'name':clean(r.get('CaseName')),'client':clean(r.get('ClientName')),
                        'applyNo':clean(r.get('ApplyNo')),'applicantDate':clean(r.get('ApplicantDate')) or clean(r.get('ApplicationDate')),
                        'createDate':clean(r.get('CaseCreateDate')) or clean(r.get('CreateDate')),'tab':tab}
order=sorted(cases.items(),key=lambda kv:kv[1]['caseNo'])
print(f'账号共 {len(order)} 案；按案号（含立案日期）排序后抽跨月份样本')
idx=sorted(set([0,1,2,3,len(order)//2-2,len(order)//2-1,len(order)//2,len(order)//2+1,len(order)-4,len(order)-3,len(order)-2,len(order)-1]))
sample=[order[i] for i in idx if 0<=i<len(order)]
print()
print('%-16s %-11s %-11s %-11s %4s %-11s %-24s %s' % ('案号','申请日','立案日','申请号','官文数','最早官文','最早官文名称','受理通知书?'))
print('-'*150)
summary=[]
for cid,info in sample:
    d=call('/CaseInfo/GetNoticeListByCaseId',body={'caseId':cid,'PagedInfo':{'PageIndex':1,'PageSize':100}})
    rs=rows(d) or []
    dated=sorted([r for r in rs if clean(r.get('PostDate'))],key=lambda r:clean(r.get('PostDate')))
    first=dated[0] if dated else {}
    has101=any(str(r.get('NoticeTypeCode'))=='200101' for r in rs)
    names=' | '.join(f"{clean(r.get('NoticeName'))}({r.get('NoticeTypeCode')})" for r in dated[:6])
    print('%-16s %-11s %-11s %-11s %4d %-11s %-24s %s' % (
        info['caseNo'], info['applicantDate'][:10] or '-', info['createDate'][:10] or '-', info['applyNo'] or '-',
        len(rs), clean(first.get('PostDate'))[:10] or '-', clean(first.get('NoticeName'))[:24] or '-',
        '是' if has101 else '否'))
    summary.append((info,rs,dated))
    print('     全部官文：', names if names else '（空）')
print()
print('='*100); print(' 汇总'); print('='*100)
alltypes={}
for info,rs,dated in summary:
    for r in rs: alltypes[str(r.get('NoticeTypeCode'))]=clean(r.get('NoticeName'))
print('  出现过的官文类型：')
for k in sorted(alltypes): print(f'    {k:>8}  {alltypes[k]}')
earliest=sorted([(clean(d[0].get('PostDate'))[:10],i['caseNo'],clean(d[0].get('NoticeName'))) for i,rs,d in summary if d])
print()
print('  各案最早官文（按日期）：')
for dt,no,nm in earliest: print(f'    {dt}  {no}  {nm}')
print()
print(f'  含受理通知书(200101)的案件数：{sum(1 for i,rs,d in summary if any(str(r.get("NoticeTypeCode"))=="200101" for r in rs))} / {len(summary)}')
print(f'  本探针共 {N[0]} 次只读请求')
PY
