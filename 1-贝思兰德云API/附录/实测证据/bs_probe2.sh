set -u
set -a; . /etc/personal-agent/patent.env 2>/dev/null || true; set +a
API="${BASELAND_API_URL:-https://cloudapi02.baselandtec.com/v1}"
ORIGIN="${BASELAND_ORIGIN:-https://cqgd.baselandtec.com}"
ACC="${RECIPIENT_A_ACCOUNT}"; PW="${RECIPIENT_A_PASSWORD}"; export ACC PW
TOKEN=$(curl -sS -k -X POST "$API/Auth/GetToken" -H "Origin: $ORIGIN" -H "Referer: $ORIGIN/login.html" -H 'Language: zh-CN' -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,os;print(json.dumps({"UserName":os.environ["ACC"],"Password":os.environ["PW"]}))')" \
  | python3 -c 'import json,sys;print((json.load(sys.stdin).get("Data") or {}).get("Token",""))')
[ -n "$TOKEN" ] || { echo "FATAL token"; exit 3; }
echo "OK token"
p() {  # $1=label $2=METHOD $3=path $4=body(optional)
  local out
  if [ "$2" = "GET" ]; then
    out=$(curl -sS -k -m 25 --get "$API$3" -H "Authorization: $TOKEN" -H "Origin: $ORIGIN" -H 'Language: zh-CN' ${4:+--data-urlencode "$4"})
  else
    out=$(curl -sS -k -m 25 -X POST "$API$3" -H "Authorization: $TOKEN" -H "Origin: $ORIGIN" -H 'Language: zh-CN' -H 'Content-Type: application/json' -d "${4:-{}}")
  fi
  printf '%s\n' "$out" | python3 /tmp/_bs_verdict.py "$1"
}
echo "==================== 业务线列表接口探测 ===================="
p "诉讼 | LsCaseInfo/GetCaseProcList"        GET  /LsCaseInfo/GetCaseProcList
p "诉讼 | LsCaseInfo/GetLsCaseContractList"  GET  /LsCaseInfo/GetLsCaseContractList
p "无效 | PiCaseInfo/GetCaseProcList"        GET  /PiCaseInfo/GetCaseProcList
p "无效 | PiCaseInfo/GetCaseContactList"     GET  /PiCaseInfo/GetCaseContactList
p "著作权 | CrCaseInfo/CrGetCaseReviewDraftList" POST /CrCaseInfo/CrGetCaseReviewDraftList '{"PagedInfo":{"pageIndex":1,"pageSize":10}}'
p "著作权 | CrCaseInfo/GetApplicantListDropdownByQueryCaseQuery" GET /CrCaseInfo/GetApplicantListDropdownByQueryCaseQuery
p "商标 | TmCaseInfo/GetCaseFeeList"         GET  /TmCaseInfo/GetCaseFeeList
p "商标 | TmCaseInfo/GetApplicantListDropdownByQueryCaseQuery" GET /TmCaseInfo/GetApplicantListDropdownByQueryCaseQuery
p "集成电路 | TsCaseInfo/GetCaseIpInfoList"  GET  /TsCaseInfo/GetCaseIpInfoList
p "集成电路 | TsCaseInfo/GetCaseFeeList"     GET  /TsCaseInfo/GetCaseFeeList
p "客户 | Client/GetClientApplicantList"     GET  /Client/GetClientApplicantList
p "客户 | Client/GetBillTitleList"           GET  /Client/GetBillTitleList
p "客户 | Client/GetClientBusinessUserInfo"  GET  /Client/GetClientBusinessUserInfo
p "财务 | Finance/GetBillAuditingList"       POST /Finance/GetBillAuditingList '{"PagedInfo":{"pageIndex":1,"pageSize":10}}'
p "财务 | Finance/GetBillChooseFeeList"      POST /Finance/GetBillChooseFeeList '{"PagedInfo":{"pageIndex":1,"pageSize":10}}'
p "合同 | ContractQuery/GetContractQueryList" POST /ContractQuery/GetContractQueryList '{"PagedInfo":{"pageIndex":1,"pageSize":10}}'
p "合同 | ContractQuery/GetContractQueryTabCount" POST /ContractQuery/GetContractQueryTabCount '{}'
p "委托 | EntrustCase/GetEntrustCaseList"    POST /EntrustCase/GetEntrustCaseList '{"PagedInfo":{"pageIndex":1,"pageSize":10}}'
p "委托 | EntrustCase/GetMyEntrustCaseCount" GET  /EntrustCase/GetMyEntrustCaseCount
p "系统 | SystemCompany/CanSeparatePackFiveForms" GET /SystemCompany/CanSeparatePackFiveForms
p "费用监控 | PtOfficalFeeMonitor/GetPtOfficalFeeMonitorList" GET /PtOfficalFeeMonitor/GetPtOfficalFeeMonitorList
p "年费 | AnnuaFeeMonitoring/GetAnnuaFeeMonitorings" POST /AnnuaFeeMonitoring/GetAnnuaFeeMonitorings '{"PagedInfo":{"pageIndex":1,"pageSize":10}}'
