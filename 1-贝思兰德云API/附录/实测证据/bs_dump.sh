set -u
set -a; . /etc/personal-agent/patent.env 2>/dev/null || true; set +a
API="${BASELAND_API_URL:-https://cloudapi02.baselandtec.com/v1}"
ORIGIN="${BASELAND_ORIGIN:-https://cqgd.baselandtec.com}"
ACC="${RECIPIENT_A_ACCOUNT}"; PW="${RECIPIENT_A_PASSWORD}"; export ACC PW
TOKEN=$(curl -sS -k -X POST "$API/Auth/GetToken" -H "Origin: $ORIGIN" -H "Referer: $ORIGIN/login.html" -H 'Language: zh-CN' -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,os;print(json.dumps({"UserName":os.environ["ACC"],"Password":os.environ["PW"]}))')" \
  | python3 -c 'import json,sys;print((json.load(sys.stdin).get("Data") or {}).get("Token",""))')
A=(-H "Authorization: $TOKEN" -H "Origin: $ORIGIN" -H 'Language: zh-CN' -H 'Content-Type: application/json')
python3 - <<PY > /tmp/bs_pending.json
import json, subprocess, os
API="$API"; TOKEN="$TOKEN"; ORIGIN="$ORIGIN"
tabs=[("waitHand",50010,0),("auditing",50011,200),("waitDeliver",50012,300),("delivering",50013,400),("finish",50014,500)]
out={}
for name,tt,st in tabs:
    body=json.dumps({"PagedInfo":{"pageIndex":1,"pageSize":500},"ProcStatusTypeList":[st],
                     "TableType":tt,"ActiveName":name,"SelectedProcIdGroup":[]})
    r=subprocess.run(["curl","-sS","-k","-m","40","-X","POST",API+"/CaseInfo/GetPersonalCase",
        "-H","Authorization: "+TOKEN,"-H","Origin: "+ORIGIN,"-H","Language: zh-CN",
        "-H","Content-Type: application/json","-d",body],capture_output=True,text=True)
    try:
        d=json.loads(r.stdout)
    except Exception:
        out[name]={"err":r.stdout[:200]}; continue
    rows=d.get("Data") or []
    if isinstance(rows,dict): rows=rows.get("ListData") or []
    out[name]=[{"name":(x.get("CaseName") or x.get("PcmCaseName") or ""),
                "no":(x.get("CaseNo") or x.get("PcmCaseNo") or ""),
                "proc":(x.get("ProcName") or x.get("CaseProcName") or ""),
                "applyno":(x.get("ApplyNo") or x.get("PcmApplicationNo") or "")} for x in rows]
print(json.dumps(out,ensure_ascii=False))
PY
echo "done"
