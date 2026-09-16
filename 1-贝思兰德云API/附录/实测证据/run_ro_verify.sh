#!/usr/bin/env bash
set -u
export LC_ALL=C.UTF-8
set -a; . /etc/personal-agent/patent.env 2>/dev/null || true; set +a
API="${BASELAND_API_URL:-https://cloudapi02.baselandtec.com/v1}"
ORIGIN="${BASELAND_ORIGIN:-https://cqgd.baselandtec.com}"
ACC="${RECIPIENT_A_ACCOUNT:-${BASELAND_ACCOUNT:-}}"
PW="${RECIPIENT_A_PASSWORD:-${BASELAND_PASSWORD:-}}"
export ACC PW
if [ -z "$ACC" ] || [ -z "$PW" ]; then echo "FATAL creds"; exit 2; fi
TOKEN=$(curl -sS -k -X POST "$API/Auth/GetToken" -H "Origin: $ORIGIN" -H "Referer: $ORIGIN/login.html" \
  -H 'Language: zh-CN' -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,os;print(json.dumps({"UserName":os.environ["ACC"],"Password":os.environ["PW"]}))')" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print((d.get("Data") or {}).get("Token",""))')
if [ -z "$TOKEN" ]; then echo "FATAL token"; exit 3; fi
echo "OK  Token 已取得（${#TOKEN} 字符）"
AUTH=(-H "Authorization: $TOKEN" -H "Origin: $ORIGIN" -H "Referer: $ORIGIN/login.html" -H 'Language: zh-CN' -H 'Content-Type: application/json')
CASE_ID=''; CASE_PROC_ID=''; CASE_HAND_ID=''; PROC_ID=''; SEARCH_KEY=''; N_CASES=0
pick() {
  curl -sS -k -X POST "$API/CaseInfo/GetPersonalCase" "${AUTH[@]}" \
    -d "{\"PagedInfo\":{\"pageIndex\":1,\"pageSize\":5},\"ProcStatusTypeList\":[$3],\"TableType\":$1,\"ActiveName\":\"$2\",\"SelectedProcIdGroup\":[]}" \
    -o /tmp/_ro_case.json
  eval "$(python3 /tmp/_pick_ids.py)"
  echo "    样例来源 $2: ${N_CASES} 条"
}
pick 50010 waitHand 0
if [ -z "$CASE_HAND_ID" ]; then pick 50013 delivering 400; fi
echo "OK  caseId=$CASE_ID  caseProcId=$CASE_PROC_ID  caseHandId=$CASE_HAND_ID  procId=$PROC_ID"
run_one() {
  local label="$1"; shift
  local body verdict
  body=$(eval "$1" 2>&1)
  verdict=$(printf '%s' "$body" | python3 /tmp/_summarize.py 2>/dev/null)
  printf '  %-46s %s\n' "$label" "$verdict"
}
echo "==================== 逐条执行文档中的只读 curl ===================="
