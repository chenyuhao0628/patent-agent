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
echo "TOKEN OK len=${#TOKEN}"

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

print('='*70)
print(' 1. GetPersonalCase 分页行为：服务端是否按 pageSize 返回 / Total 字段名')
print('='*70)
tabs=[('waitHand',50010,0),('auditing',50011,200),('waitDeliver',50012,300),('delivering',50013,400),('finish',50014,500)]
for name,tt,st in tabs:
    for size in (100,500):
        d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':size},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':name,'SelectedProcIdGroup':[]})
        rows=d.get('Data')
        n=len(rows) if isinstance(rows,list) else ('dict:'+str(list(rows.keys())) if isinstance(rows,dict) else str(rows))
        top=[k for k in ('Total','TotalCount','RecordCount','PageCount') if k in d]
        print(f'  {name:12s} TableType={tt} status={st} pageSize={size:<4} 返回行数={n} 顶层计数字段={top} Data键={list(rows.keys()) if isinstance(rows,dict) else "-"}')
        if isinstance(rows,dict):
            for kk in ('Total','TotalCount','RecordCount','ListData','List'):
                if kk in rows: print(f'        Data.{kk} = {rows[kk] if not isinstance(rows[kk],list) else "list(%d)"%len(rows[kk])}')

print()
print('='*70)
print(' 2. GetHandInfo / GetCaseHandSendInfo：递交实例与递交状态字段')
print('='*70)
# 取 delivering + finish 各两个流程，检查 HandInfo 字段与 SendStatus
probe=[]
for name,tt,st in [('delivering',50013,400),('finish',50014,500),('waitHand',50010,0)]:
    d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':6},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':name,'SelectedProcIdGroup':[]})
    for r in (d.get('Data') or []):
        probe.append((name,r.get('CaseNo'),r.get('CaseProcId'),r.get('CaseProcName')))
print(f'  采样流程数={len(probe)}')
for tab,no,pid,pname in probe[:12]:
    h=call('/CaseInfo/GetHandInfo',params={'caseProcId':pid})
    D=h.get('Data') or {}
    if not isinstance(D,dict): D={}
    hi=D.get('HandInfo') or {}
    hid=hi.get('CaseHandId') if isinstance(hi,dict) else None
    send=D.get('IsPackageSendSuccess'); need=D.get('IsNeedSendToOfficail'); rev=D.get('IsReviewing')
    s=None
    if hid:
        s=call('/CaseInfo/GetCaseHandSendInfo',params={'caseHandId':hid})
    sd=(s or {}).get('Data')
    cfg=D.get('CurrentFlowInfo') or {}
    print(f'  [{tab}] {no} {pname}')
    print(f'      HandInfo键={sorted(hi.keys()) if isinstance(hi,dict) else hi}')
    print(f'      IsPackageSendSuccess={send} IsNeedSendToOfficail={need} IsReviewing={rev}')
    print(f'      节点={cfg.get("FlowNodeName") if isinstance(cfg,dict) else None} 处理人={cfg.get("FlowUserName") if isinstance(cfg,dict) else None} 步={cfg.get("SerialNumber") if isinstance(cfg,dict) else None}/{cfg.get("TotalStepNumber") if isinstance(cfg,dict) else None}')
    if isinstance(sd,dict): print(f'      SendStatus={sd.get("SendStatus")} 键={sorted(sd.keys())}')
    else: print(f'      GetCaseHandSendInfo.Data={sd!r}')
PY
