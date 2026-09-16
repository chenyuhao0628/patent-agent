set -u
set -a; . /etc/personal-agent/patent.env 2>/dev/null || true; set +a
API="${BASELAND_API_URL:-https://cloudapi02.baselandtec.com/v1}"; ORIGIN="${BASELAND_ORIGIN:-https://cqgd.baselandtec.com}"
ACC="${RECIPIENT_A_ACCOUNT}"; PW="${RECIPIENT_A_PASSWORD}"; export ACC PW
TOKEN=$(curl -sS -k -X POST "$API/Auth/GetToken" -H "Origin: $ORIGIN" -H "Referer: $ORIGIN/login.html" -H 'Language: zh-CN' -H 'Content-Type: application/json' \
 -d "$(python3 -c 'import json,os;print(json.dumps({"UserName":os.environ["ACC"],"Password":os.environ["PW"]}))')" \
 | python3 -c 'import json,sys;print((json.load(sys.stdin).get("Data") or {}).get("Token",""))')
A=(-H "Authorization: $TOKEN" -H "Origin: $ORIGIN" -H "Referer: $ORIGIN/login.html" -H 'Language: zh-CN' -H 'Content-Type: application/json')
CASE=a853ec8d-033c-4f76-a737-75d52a25c96f
PROCID=5d092e47-f7c6-470b-8cf2-163963f5369e
RELID=d472b566-292a-45dc-b99b-e54ede40d57b
echo "### 1. ProcCaculateNextYearLegalDate  caseId + ProcId(流程模板ID)"
curl -sS -k --get "$API/CaseInfo/ProcCaculateNextYearLegalDate" "${A[@]}" \
  --data-urlencode "caseId=$CASE" --data-urlencode "procId=$PROCID" --data-urlencode "annualFeeYearTo=2026" \
  | head -c 400; echo
echo
echo "### 2. ApplyCase/GetLegalDate  countryCode=36 + CaseRelationTypeId + ApplyTypeCode=2"
curl -sS -k -X POST "$API/ApplyCase/GetLegalDate" "${A[@]}" -d "{
 \"countryCode\":36,\"caseRelatedTypeId\":\"$RELID\",\"applyTypeCode\":2,
 \"PriorityDateList\":[],\"PctApplicationDate\":null}" | head -c 500; echo
