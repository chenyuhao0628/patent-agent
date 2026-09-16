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
import json,os,subprocess,time
API=os.environ['API']; ORIGIN=os.environ['ORIGIN']; TOKEN=os.environ['TOKEN']

def timed(path, body=None, params=None, label='', compressed=False):
    from urllib.parse import urlencode
    url=API+path+('?'+urlencode(params) if params else '')
    cmd=['curl','-sS','-k','-m','60','-o','/tmp/_b','-w','%{time_total} %{size_download} %{http_code}',url,
         '-H','Authorization: '+TOKEN,'-H','Origin: '+ORIGIN,'-H','Language: zh-CN','-H','Content-Type: application/json']
    if compressed: cmd.append('--compressed')
    if body is not None: cmd+=['-X','POST','-d',json.dumps(body)]
    # 3 次取中位数
    ts=[];size=0
    for _ in range(3):
        r=subprocess.run(cmd,capture_output=True,text=True)
        parts=r.stdout.split()
        if len(parts)>=3:
            ts.append(float(parts[0])); size=int(parts[1])
    if not ts: return None
    ts.sort()
    raw=open('/tmp/_b','rb').read()
    try: d=json.loads(raw.decode('utf-8','replace'))
    except Exception: d={}
    n=len(d.get('Data')) if isinstance(d.get('Data'),list) else None
    keys=len(d['Data'][0]) if isinstance(d.get('Data'),list) and d['Data'] and isinstance(d['Data'][0],dict) else None
    print(f'  {label:44s} {ts[len(ts)//2]*1000:7.0f} ms   {size/1024:8.1f} KB   行={n} 字段/行={keys}')
    return d

TABS=[('waitHand',50010,0),('auditing',50011,200),('waitDeliver',50012,300),('delivering',50013,400),('finish',50014,500)]
def body(name,tt,st,size=100,cols=None):
    b={'PagedInfo':{'pageIndex':1,'pageSize':size},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':name,'SelectedProcIdGroup':[]}
    if cols is not None: b['UserTableTitleColumnList']=cols
    return b

print('='*96); print(' ① 现有同步路径的耗时与体积（逐页签）'); print('='*96)
tot=0
for name,tt,st in TABS:
    d=timed('/CaseInfo/GetPersonalCase',body(name,tt,st),label=f'GetPersonalCase [{name}] pageSize=100')
print()
print('='*96); print(' ② 轻量替代：计数类'); print('='*96)
timed('/CaseInfo/GetPersonalCaseCount',body('waitHand',50010,0),label='GetPersonalCaseCount [waitHand]')
timed('/CaseInfo/GetPersonalProcStatistics',label='GetPersonalProcStatistics（1 次拿 5 个）')
timed('/CaseInfo/GetCaseHandInfoTabCount',label='GetCaseHandInfoTabCount（9 个计数）')

print(); print('='*96); print(' ③ UserTableTitleColumnList 能否裁剪返回体？'); print('='*96)
tiny=['CaseId','CaseProcId','CaseNo','CaseName']
timed('/CaseInfo/GetPersonalCase',body('finish',50014,500,cols=tiny),label='GetPersonalCase[finish] cols=4 个')
timed('/CaseInfo/GetPersonalCase',body('finish',50014,500,cols=[]),label='GetPersonalCase[finish] cols=[]')
timed('/CaseInfo/GetPersonalCase',body('finish',50014,500),label='GetPersonalCase[finish] 不带 cols')

print(); print('='*96); print(' ④ pageSize 的影响'); print('='*96)
for s in (10,25,100,500):
    timed('/CaseInfo/GetPersonalCase',body('finish',50014,500,size=s),label=f'GetPersonalCase[finish] pageSize={s}')

print(); print('='*96); print(' ⑤ 压缩传输是否开启（gzip）'); print('='*96)
timed('/CaseInfo/GetPersonalCase',body('finish',50014,500),label='GetPersonalCase[finish] 默认',compressed=False)
timed('/CaseInfo/GetPersonalCase',body('finish',50014,500),label='GetPersonalCase[finish] --compressed',compressed=True)

print(); print('='*96); print(' ⑥ 文件级计数'); print('='*96)
FB={'PagedInfo':{'PageIndex':1,'PageSize':1,'SortField':None,'SortType':None},'UserTableTitleColumnList':[],'TableType':20101}
timed('/CaseFile/GetFileCount',FB,label='CaseFile/GetFileCount')
timed('/CaseInfo/GetCaseFileAllListCount',params={'caseId':'dea01908-8a21-490c-868a-cff148138d63'},label='GetCaseFileAllListCount?caseId=')
PY
