#!/usr/bin/env bash
# 只读探针（第三轮，修正第二轮的类型判断错误）：逐案打印「当前流程」的选择结果，
# 并区分「当前流程口径」与「全部流程口径」的终态数量。仅只读接口。
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
import json,os,re,subprocess
from urllib.parse import urlencode
API=os.environ['API']; ORIGIN=os.environ['ORIGIN']; TOKEN=os.environ['TOKEN']
CALLS=[0]
def call(path, body=None, params=None):
    CALLS[0]+=1
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
def clean(v):
    if v is None: return ''
    return str(v).strip()
def boolTri(v):
    if v is True: return True
    if v is False: return False
    return None
AUX=re.compile(r'取得申请号|缴申请费|缴纳申请费|申请费')
def businessKind(name):
    n=name.strip()
    if re.match(r'^取消提出申请(?:$|[（(\s])',n): return None
    if '补正' in n: return 'correction'
    if '复审' in n: return 'reply'
    if '答复' in n or '审查意见' in n: return 'reply'
    if '提出申请' in n or '撰写' in n: return 'write'
    return None
def rowStamp(r):
    for k in ('CaseProcFinishDate','FinishDate','ProcCreateDate','CaseProcCreateDate','CreateDate'):
        if clean(r.get(k)): return clean(r.get(k))
    return ''
def existsHandFromRow(r):
    op=(r or {}).get('CaseProcOperateInfo') or {}
    return op.get('IsExistsHand') is True or op.get('IsExistsNoFinishHand') is True
SEND_STATUS={0:'draft',1:'queued',2:'sent',3:'failed',6:'received',100:'sending'}
def sendStatusState(v):
    if isinstance(v,dict):
        if 'SendStatus' not in v: return None
        return sendStatusState(v['SendStatus'])
    if isinstance(v,bool): return None
    if isinstance(v,str):
        t=v.strip()
        if not t or not re.match(r'^-?\d+$',t): return None
        return SEND_STATUS.get(int(t))
    if isinstance(v,int): return SEND_STATUS.get(v)
    return None
def combine(flag,send):
    s=sendStatusState(send)
    if flag is True: return 'received' if s=='received' else 'sent'
    if s: return s
    if flag is False: return 'draft'
    return 'unknown'
def selectCurrentProcess(procs):
    active=[p for p in procs if p[2]>=0 and p[2]!=500 and not AUX.search(p[1])]
    if len(active)==1: return active[0]
    if len(active)>1: return {'none':'multi-active','n':len(active)}
    fin=[p for p in procs if p[2]==500 and businessKind(p[1]) and not AUX.search(p[1]) and (p[3] or existsHandFromRow(p[4]))]
    if not fin: return {'none':'no-candidate','n':0}
    if len(fin)==1: return fin[0]
    dated=[(p,rowStamp(p[4])) for p in fin]
    known=[d for d in dated if d[1]]
    if not known or len(known)!=len(dated): return {'none':'ambiguous-stamp','n':len(fin)}
    known.sort(key=lambda d:d[1]); last=known[-1][1]
    tied=[d[0] for d in known if d[1]==last]
    return tied[0] if len(tied)==1 else {'none':'ambiguous-tie','n':len(fin)}
def nameOf(r):
    # 与 desktop/baseland.ts processRow 一致：CaseProcName ?? CaseProcNameInfo.CaseProcName（仅 None 时回退）
    v=r.get('CaseProcName')
    if v is None:
        info=r.get('CaseProcNameInfo') or {}
        v=info.get('CaseProcName') if isinstance(info,dict) else None
    return clean(v)
def shouldQuery(p):
    pid,name,status,handId,row=p
    if not pid: return False
    if handId or existsHandFromRow(row): return True
    if status in (200,300,400): return True
    if status==500 and businessKind(name): return True
    return False
CACHE={}
def probeHand(pid,handId):
    if pid in CACHE: return CACHE[pid]
    info=call('/CaseInfo/GetHandInfo',None,{'caseProcId':pid})
    obj=info.get('Data') if isinstance(info.get('Data'),dict) else {}
    hand=obj.get('HandInfo') if isinstance(obj.get('HandInfo'),dict) else {}
    hid=clean(hand.get('CaseHandId') or obj.get('CaseHandId')) or handId
    send=None
    if hid: send=call('/CaseInfo/GetCaseHandSendInfo',None,{'caseHandId':hid})
    CACHE[pid]=(combine(boolTri(obj.get('IsPackageSendSuccess')),send.get('Data') if isinstance(send,dict) else None),boolTri(obj.get('IsReviewing')))
    return CACHE[pid]

grouped={}
for tab,tt,st in [('waitHand',50010,0),('auditing',50011,200),('waitDeliver',50012,300),('delivering',50013,400),('finish',50014,500)]:
    d=call('/CaseInfo/GetPersonalCase',{'PagedInfo':{'pageIndex':1,'pageSize':100},'ProcStatusTypeList':[st],'TableType':tt,'ActiveName':tab,'SelectedProcIdGroup':[]})
    for r in rows(d) or []:
        r['_status']=st; r['_tab']=tab
        grouped.setdefault(clean(r.get('CaseId')),[]).append(r)
print(f'账号：{len(grouped)} 个案件 / {sum(len(v) for v in grouped.values())} 条流程')
print()
print('逐案：当前流程选择 / 是否查官方 / 递交状态（冷启动，无 preferredId）')
print('-'*96)
sel=0; none={}; q=0; states={}; curterm=0
for cid,rs in sorted(grouped.items(),key=lambda kv:clean(kv[1][0].get('CaseNo'))):
    procs=[(clean(r.get('CaseProcId')),nameOf(r),int(r['_status']),clean(r.get('CaseHandId')) or None,r) for r in rs]
    no=clean(rs[0].get('CaseNo'))
    shape='+'.join(f'{p[2]}/{businessKind(p[1]) or "-"}' for p in procs)
    p=selectCurrentProcess(procs)
    if isinstance(p,dict):
        none[p['none']]=none.get(p['none'],0)+1
        print(f'  {no:16s} {shape:22s} 未选中：{p["none"]}')
        continue
    sel+=1
    sq=shouldQuery(p)
    if not sq:
        print(f'  {no:16s} {shape:22s} 当前={p[2]}/{p[1]}  不查')
        continue
    state,reviewing=probeHand(p[0],p[3]); q+=1
    states[state]=states.get(state,0)+1
    if state=='received': curterm+=1
    print(f'  {no:16s} {shape:22s} 当前={p[2]}/{p[1]}  查-> {state}  IsReviewing={reviewing}')
print('-'*96)
print(f'选中当前流程 {sel} 案；未选中 {sum(none.values())} 案 {json.dumps(none,ensure_ascii=False)}')
print(f'其中需要查官方状态 {q} 案；状态分布 {json.dumps(states,ensure_ascii=False)}')
print(f'【当前流程口径】终态 received = {curterm} 个 -> 每轮强制同步可省的 queryOfficial 次数 = {curterm}（= {2*curterm} 次 HTTP）')
allh={}
for cid,rs in grouped.items():
    for r in rs:
        if not(clean(r.get('CaseHandId')) or existsHandFromRow(r)): continue
        state,_=probeHand(clean(r.get('CaseProcId')),clean(r.get('CaseHandId')) or None)
        allh[state]=allh.get(state,0)+1
print(f'【全部流程口径】带递交实例的流程 {sum(allh.values())} 条；状态分布 {json.dumps(allh,ensure_ascii=False)}')
print(f'探针共发出 {CALLS[0]} 次只读请求')
PY
