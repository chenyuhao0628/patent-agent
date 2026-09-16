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

print('='*72)
print(' A. GetPersonalCase 分页：pageSize 是否被服务端截断 / Total 在哪')
print('='*72)
tabs=[('waitHand',50010,0),('auditing',50011,200),('waitDeliver',50012,300),('delivering',50013,400),('finish',50014,500)]
firstrow=None
for name,tt,st in tabs:
    line=[]
    for size in (10,100,500):
        d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':size},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':name,'SelectedProcIdGroup':[]})
        rows=d.get('Data')
        n=len(rows) if isinstance(rows,list) else -1
        if firstrow is None and isinstance(rows,list) and rows: firstrow=(name,rows[0])
        line.append(f'pageSize={size}->{n}行')
    # 第二页验证是否还有数据
    d2=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':2,'pageSize':100},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':name,'SelectedProcIdGroup':[]})
    r2=d2.get('Data'); n2=len(r2) if isinstance(r2,list) else -1
    cnt={k:v for k,v in (d2.items() if isinstance(d2,dict) else []) if 'otal' in k or 'ecord' in k}
    print(f'  {name:12s} {" ".join(line)}  第2页(pageSize=100)->{n2}行  顶层计数字段={cnt}')

print()
print('='*72)
print(' B. GetPersonalCase 行字段 vs patent-agent 读取的字段')
print('='*72)
if firstrow:
    nm,row=firstrow
    print(f'  样本: {nm} 行字段总数={len(row)}')
    print('  全部字段名:')
    print('   ',sorted(row.keys()))
    want=['CaseId','CaseProcId','CaseName','CaseNo','ApplyType','ApplyNo','ApplicationNo','ClientName','CaseRemark',
          'CaseProcLegalDate','CaseProcCustomDate','CaseProcFinishDate','CaseProcCreateDate','CreateDate','FinishDate',
          'CaseProcUndertakerUserName','CaseProcCurrentStatus','CaseProcCurrentFlowName','ProcStatusCode','Status',
          'CaseHandId','CaseProcOperateInfo','CaseProcNameInfo','CaseProcName','ProcName','ProcCode']
    print()
    print('  项目读取字段的存在性:')
    for w in want:
        v=row.get(w)
        tag='存在' if w in row else '缺失'
        if isinstance(v,(dict,list)): v=f'{type(v).__name__}({list(v.keys())[:8] if isinstance(v,dict) else len(v)})'
        print(f'    {tag:4s} {w:32s} = {v!r}'[:150])

print()
print('='*72)
print(' C. GetOfficialFormList 三个 fileType 的卡片（答复审查意见 递交实例）')
print('='*72)
FIVE=[100001,100002,100003,100004,100005]
d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':6},'ProcStatusTypeList':[400],'TableType':50013,'ActiveName':'delivering','SelectedProcIdGroup':[]})
target=None
for r in (d.get('Data') or []):
    n=r.get('CaseName') or ''
    if '答复' in str(n) or True:
        h=call('/CaseInfo/GetHandInfo',params={'caseProcId':r.get('CaseProcId')})
        D=h.get('Data') or {}
        if D.get('IsReviewing') and (D.get('HandInfo') or {}).get('CaseHandId'):
            target=(r,D); break
if not target:
    print('  未找到可编辑(IsReviewing=true)的递交实例，跳过')
else:
    r,D=target
    hid=D['HandInfo']['CaseHandId']
    print(f"  案例: {r.get('CaseName')} / {r.get('CaseNo')} handId={hid}")
    print(f"  CaseProcNameInfo={json.dumps(r.get('CaseProcNameInfo'),ensure_ascii=False)[:200]}")
    allcards=[]
    for ft in (0,2,4):
        g=call('/CaseInfo/GetOfficialFormList',params={'fileType':ft,'caseHandId':hid})
        data=g.get('Data')
        rows=data if isinstance(data,list) else (data or {}).get('List') if isinstance(data,dict) else None
        rows=rows or []
        codes=[c.get('Code') for c in rows]
        five=[c for c in rows if c.get('Code') in FIVE]
        print(f'  fileType={ft}: {len(rows)} 张卡  五书条目={len(five)}  卡名={[c.get("FormName") for c in rows][:14]}')
        # 找 000000 / 说明书、说明书摘要、权利要求书与附图
        nz=[c.get('FormName') for c in rows if str(c.get('FormName') or '').find('说明书')>=0]
        if nz: print(f'        含"说明书"的卡名: {nz}')
        allcards+= rows
    union={}
    for c in allcards: union.setdefault(int(c['Code']) if str(c.get('Code','')).isdigit() else c.get('Code'), c)
    print(f'  ---- 三个 fileType 并集共 {len(union)} 张卡 ----')
    print(f'    含100012意见陈述书: {100012 in union}')
    print(f'    含100006补正书: {100006 in union}')
    print(f'    含110101: {110101 in union}  含120101: {120101 in union}')
    print(f'    存在名为"说明书、说明书摘要、权利要求书与附图"的真实卡片: {[c.get("Code") for c in allcards if c.get("FormName")=="说明书、说明书摘要、权利要求书与附图"]}')
    five_union=[c for c in allcards if c.get('Code') in FIVE]
    print(f'    并集中五书条目数={len(five_union)} (fileType0/4 部分={len([c for c in allcards if c.get("Code") in FIVE])})')
PY
