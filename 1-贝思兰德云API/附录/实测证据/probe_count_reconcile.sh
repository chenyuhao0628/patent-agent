set -u
set -a; . /etc/personal-agent/patent.env 2>/dev/null || true; set +a
API="${BASELAND_API_URL:-https://cloudapi02.baselandtec.com/v1}"
ORIGIN="${BASELAND_ORIGIN:-}"
export ORIGIN API
TOKEN=$(curl -sS -k -m 30 -X POST "$API/Auth/GetToken" -H "Origin: $ORIGIN" -H "Referer: $ORIGIN/login.html" -H 'Language: zh-CN' -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,os;print(json.dumps({"UserName":os.environ["RECIPIENT_A_ACCOUNT"],"Password":os.environ["RECIPIENT_A_PASSWORD"]}))')" \
  | python3 -c 'import json,sys;print((json.load(sys.stdin).get("Data") or {}).get("Token",""))')
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
print('=== GetPersonalProcStatistics 连续 3 次（看稳定性）===')
for i in range(3):
    d=call('/CaseInfo/GetPersonalProcStatistics')
    print(f'  #{i+1}:', json.dumps(d.get('Data'),ensure_ascii=False))
print()
print('=== GetPersonalCaseCount 五页签 ===')
tot=0
for name,tt,st in [('waitHand',50010,0),('auditing',50011,200),('waitDeliver',50012,300),('delivering',50013,400),('finish',50014,500)]:
    body={'PagedInfo':{'pageIndex':1,'pageSize':100},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':name,'SelectedProcIdGroup':[]}
    c=call('/CaseInfo/GetPersonalCaseCount',body).get('Data')
    l=call('/CaseInfo/GetPersonalCase',body)
    v=l.get('Data'); n=len(v) if isinstance(v,list) else None
    tot+= (c or 0)
    print(f'  {name:12s} Count={c!r}  列表={n}')
print('  Count 合计 =',tot)
print()
print('=== GetPersonalCase 加关键词/无关键词 是否影响 ===')
b1={'PagedInfo':{'pageIndex':1,'pageSize':100},'ProcStatusTypeList':[0],'TableType':50010,'ActiveName':'waitHand','SelectedProcIdGroup':[]}
print('  无关键词 Count=',call('/CaseInfo/GetPersonalCaseCount',b1).get('Data'))
print('=== GetPersonalProcStatistics 是否随筛选变化（试加参数）===')
for b in ({},{'IsWorkAgent':True},{'TableType':50010},{'ProcStatusTypeList':[0]}):
    d=call('/CaseInfo/GetPersonalProcStatistics',b)
    print(f'  {json.dumps(b,ensure_ascii=False):34s} -> IsSuccess={d.get("IsSuccess")} Msg={d.get("Message")!r} Data={json.dumps(d.get("Data"),ensure_ascii=False)[:120]}')
PY
