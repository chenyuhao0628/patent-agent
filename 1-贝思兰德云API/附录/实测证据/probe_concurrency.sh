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
echo "=== 响应头（看是否支持 gzip）==="
curl -sS -k -o /dev/null -D - -X POST "$API/CaseInfo/GetPersonalCase" \
  -H "Authorization: $TOKEN" -H "Origin: $ORIGIN" -H 'Language: zh-CN' -H 'Content-Type: application/json' \
  -H 'Accept-Encoding: gzip, deflate, br' \
  -d '{"PagedInfo":{"pageIndex":1,"pageSize":100},"ProcStatusTypeList":[500],"TableType":50014,"ActiveName":"finish","SelectedProcIdGroup":[]}' \
  | grep -iE "^(HTTP|content-encoding|content-length|vary|transfer-encoding)" | head

echo
echo "=== 并发 vs 串行：5 个页签 ==="
python3 - <<'PY'
import json,os,subprocess,time,concurrent.futures
API=os.environ['API']; ORIGIN=os.environ['ORIGIN']; TOKEN=os.environ['TOKEN']
TABS=[('waitHand',50010,0),('auditing',50011,200),('waitDeliver',50012,300),('delivering',50013,400),('finish',50014,500)]
def one(t):
    name,tt,st=t
    b=json.dumps({'PagedInfo':{'pageIndex':1,'pageSize':100},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':name,'SelectedProcIdGroup':[]})
    cmd=['curl','-sS','-k','-m','60','-o','/dev/null','-w','%{time_total}','-X','POST',API+'/CaseInfo/GetPersonalCase',
         '-H','Authorization: '+TOKEN,'-H','Origin: '+ORIGIN,'-H','Language: zh-CN','-H','Content-Type: application/json',
         '-H','Accept-Encoding: gzip','-d',b]
    r=subprocess.run(cmd,capture_output=True,text=True)
    return name,float(r.stdout or 0)

# 串行
t0=time.time()
for t in TABS: one(t)
seq=time.time()-t0
print(f'  串行 5 个页签: {seq*1000:.0f} ms   （各次: ' + ', '.join(f'{n}={d*1000:.0f}' for n,d in [one(t) for t in TABS]) + '）')

# 并行 5 路
for width in (5,3):
    t0=time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=width) as ex:
        res=list(ex.map(one,TABS))
    par=time.time()-t0
    print(f'  并行 {width} 路:     {par*1000:.0f} ms   （各次: ' + ', '.join(f'{n}={d*1000:.0f}' for n,d in res) + '）')

# 并行 20 路（压一下，看会不会被限流/报错）
def ping(i):
    cmd=['curl','-sS','-k','-m','60','-o','/tmp/_p%d'%i,'-w','%{time_total} %{http_code}','-X','POST',API+'/CaseInfo/GetPersonalCase',
         '-H','Authorization: '+TOKEN,'-H','Origin: '+ORIGIN,'-H','Language: zh-CN','-H','Content-Type: application/json',
         '-H','Accept-Encoding: gzip','-d',json.dumps({'PagedInfo':{'pageIndex':1,'pageSize':5},'ProcStatusTypeList':[500],'TableType':50014,'ActiveName':'finish','SelectedProcIdGroup':[]})]
    r=subprocess.run(cmd,capture_output=True,text=True)
    return r.stdout.strip()
t0=time.time()
with concurrent.futures.ThreadPoolExecutor(max_workers=20) as ex:
    res=list(ex.map(ping,range(20)))
el=time.time()-t0
codes={}
for x in res:
    c=x.split()[-1] if x else '?'; codes[c]=codes.get(c,0)+1
print(f'  20 路并发同一接口: {el*1000:.0f} ms  状态码分布={codes}')
PY
