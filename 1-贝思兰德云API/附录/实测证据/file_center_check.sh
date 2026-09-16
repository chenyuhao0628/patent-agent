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
echo "TOKEN OK"
python3 - <<'PY'
import json,os,subprocess
API=os.environ['API']; ORIGIN=os.environ['ORIGIN']; TOKEN=os.environ['TOKEN']
def call(path, body=None):
    cmd=['curl','-sS','-k','-m','40',API+path,'-H','Authorization: '+TOKEN,'-H','Origin: '+ORIGIN,'-H','Language: zh-CN','-H','Content-Type: application/json']
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
TARGET='08df1217-b6ae-4bdb-8704-f8ccb493ffb2'

print('='*74); print(' 文件中心 GetFileList（表 20101）—— IsCanDelete 的真正来源'); print('='*74)
for tag,extra in [('无筛选',{}),('按案号',{'CaseNo':'202608262-1258'})]:
    body={'PagedInfo':{'PageIndex':1,'PageSize':200,'SortField':None,'SortType':None},
          'UserTableTitleColumnList':[],'TableType':20101}
    body.update(extra)
    d=call('/CaseFile/GetFileList',body)
    rs=rows(d)
    print(f'\n  [{tag}] IsSuccess={d.get("IsSuccess")} Code={d.get("Code")} Message={d.get("Message")!r} 行数={len(rs) if rs is not None else None}')
    if rs:
        print('   首行键:', sorted(rs[0].keys()))
        hit=[r for r in rs if r.get('CaseFileId')==TARGET]
        print(f'   命中目标文件: {len(hit)}')
        for r in hit:
            for k in sorted(r.keys()):
                v=r.get(k)
                if v not in (None,'',[]): print(f'      {k:26s} = {v!r}')
        # 统计 IsCanDelete 分布
        from collections import Counter
        c=Counter(str(r.get('IsCanDelete')) for r in rs)
        print('   IsCanDelete 分布:', dict(c))
        print('   前 6 行:')
        for r in rs[:6]:
            print(f"      {str(r.get('FileName'))[:40]:42s} 类型={r.get('FileTypeName')} IsCanDelete={r.get('IsCanDelete')} IsCanLink={r.get('IsCanLink')}")
    else:
        print('   预览:', json.dumps(d,ensure_ascii=False)[:300])

print(); print('='*74); print(' GetFileCount 同参数'); print('='*74)
body={'PagedInfo':{'PageIndex':1,'PageSize':200,'SortField':None,'SortType':None},'UserTableTitleColumnList':[],'TableType':20101}
d=call('/CaseFile/GetFileCount',body)
print('  IsSuccess=',d.get('IsSuccess'),' Message=',d.get('Message'),' Data=',d.get('Data'))
PY
