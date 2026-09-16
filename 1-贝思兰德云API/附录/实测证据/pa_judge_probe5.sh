set -u
set -a; . /etc/personal-agent/patent.env 2>/dev/null || true; set +a
API="${BASELAND_API_URL:-https://cloudapi02.baselandtec.com/v1}"
ORIGIN="${BASELAND_ORIGIN:-}"
ACC="${RECIPIENT_A_ACCOUNT}"; PW="${RECIPIENT_A_PASSWORD}"; export ACC PW ORIGIN API
TOKEN=$(curl -sS -k -m 30 -X POST "$API/Auth/GetToken" -H "Origin: $ORIGIN" -H "Referer: $ORIGIN/login.html" -H 'Language: zh-CN' -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,os;print(json.dumps({"UserName":os.environ["ACC"],"Password":os.environ["PW"]}))')" \
  | python3 -c 'import json,sys;print((json.load(sys.stdin).get("Data") or {}).get("Token",""))')
[ -n "$TOKEN" ] || { echo "FATAL token"; exit 3; }
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
    except Exception: return {'_raw':r.stdout[:400]}
def rows(d):
    v=d.get('Data') if isinstance(d,dict) else None
    if isinstance(v,list): return v
    if isinstance(v,dict):
        for k in ('List','ListData','Rows','DataList','Items'):
            if isinstance(v.get(k),list): return v[k]
    return None

print('='*74); print(' M. IsNeedSendToOfficail 扩大采样（全页签，找 false）'); print('='*74)
tabs=[('waitHand',50010,0),('auditing',50011,200),('waitDeliver',50012,300),('delivering',50013,400),('finish',50014,500)]
recs=[]
for name,tt,st in tabs:
    d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':100},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':name,'SelectedProcIdGroup':[]})
    for r in (rows(d) or []):
        recs.append((name,r))
print(f'  页签行数合计={len(recs)}')
from collections import Counter
cnt=Counter(); falses=[]
for tab,r in recs:
    pid=r.get('CaseProcId')
    h=call('/CaseInfo/GetHandInfo',params={'caseProcId':pid})
    D=h.get('Data') or {}
    if not isinstance(D,dict): D={}
    v=D.get('IsNeedSendToOfficail')
    ni=r.get('CaseProcNameInfo') or {}
    nm=ni.get('CaseProcName') or r.get('CaseProcName')
    pc=ni.get('ProcCode')
    ps=r.get('ProcStatusCode')
    cnt[(str(v),)]+=1
    if v is False: falses.append((tab,nm,pc,ps,r.get('CaseNo')))
print('  IsNeedSendToOfficail 取值分布:',dict(cnt))
if falses:
    print('  !! 发现 false 样本:')
    for f in falses: print('    ',f)
else:
    print('  未发现 false / undefined 以外的取值')

print()
print('  分业务类型统计:')
byproc={}
for tab,r in recs:
    ni=r.get('CaseProcNameInfo') or {}
    nm=str(ni.get('CaseProcName') or r.get('CaseProcName')); pc=ni.get('ProcCode')
    h=call('/CaseInfo/GetHandInfo',params={'caseProcId':r.get('CaseProcId')})
    D=h.get('Data') or {}
    v=(D or {}).get('IsNeedSendToOfficail') if isinstance(D,dict) else None
    ps=D.get('IsPackageSendSuccess') if isinstance(D,dict) else None
    byproc.setdefault(nm,set()).add((pc,v,ps,tab))
for nm,s in sorted(byproc.items()):
    print(f'    {nm:20s} {sorted(s, key=str)}')
PY
