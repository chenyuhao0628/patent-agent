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
run_one "01 GetPersonalCase-waitHand" "curl -sS -k -X POST \"$API/CaseInfo/GetPersonalCase\" -H \"Authorization: $TOKEN\" -H \"Origin: $ORIGIN\" -H 'Language: zh-CN' -H 'Content-Type: application/json' -d '{ \"PagedInfo\": {\"pageIndex\": 1, \"pageSize\": 20}, \"ProcStatusTypeList\": [0], \"TableType\": 50010, \"ActiveName\": \"waitHand\", \"SelectedProcIdGroup\": [] }'"
run_one "02 GetPersonalProcStatistics" "curl -sS -k --get \"$API/CaseInfo/GetPersonalProcStatistics\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN'"
run_one "03 GetCaseHandInfoTabCount" "curl -sS -k --get \"$API/CaseInfo/GetCaseHandInfoTabCount\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN'"
run_one "04 GetPersonalCaseSubTabStatisticsCount" "curl -sS -k --get \"$API/CaseInfo/GetPersonalCaseSubTabStatisticsCount\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode 'caseProcStatusType=400'"
run_one "05 GetPersonalCase-page2" "curl -sS -k -X POST \"$API/CaseInfo/GetPersonalCase\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' -H 'Content-Type: application/json' -d '{ \"PagedInfo\": {\"pageIndex\": 1, \"pageSize\": 20}, \"ProcStatusTypeList\": [0], \"TableType\": 50010, \"ActiveName\": \"waitHand\", \"CaseNoOrCaseNameOrClientName\": \"关键词\", \"LegalStartDate\": \"2026-01-01\", \"LegalEndDate\": \"2026-12-31\" }'"
run_one "06 GetCaseHandInfoListOfProcessing" "curl -sS -k -X POST \"$API/CaseInfo/GetCaseHandInfoListOfProcessing\" -H \"Authorization: $TOKEN\" -H 'Origin: $ORIGIN' -H 'Language: zh-CN' -H 'Content-Type: application/json' -d '{ \"IsWorkAgent\": true, \"UserTableTitleColumnList\": [\"CaseNo\",\"CaseName\",\"ClientName\",\"CaseProcName\", \"CaseProcCustomDate\",\"CaseProcLegalDate\",\"CaseProcUndertakerUserName\"], \"TableType\": 40013, \"PageInfo\": {\"pageIndex\": 1, \"pageSize\": 20, \"SortField\": null, \"SortType\": null} }'"
run_one "07 GetCaseHandInfoTabCount-2" "curl -sS -k --get \"$API/CaseInfo/GetCaseHandInfoTabCount\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN'"
run_one "08 GetUpdateCaseInfo" "curl -sS -k --get \"$API/CaseInfo/GetUpdateCaseInfo\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"caseId=$CASE_ID\""
run_one "09 GetCaseProcById" "curl -sS -k --get \"$API/CaseInfo/GetCaseProcById\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"caseProcId=$CASE_PROC_ID\""
run_one "10 GetCaseDetailProcList" "curl -sS -k -X POST \"$API/CaseInfo/GetCaseDetailProcList\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' -H 'Content-Type: application/json' -d '{ \"caseId\": \"'\"$CASE_ID\"'\", \"TableType\": 80001, \"SortInfo\": {}, \"UserTableTitleColumnList\": [ \"CaseProcName\", \"CaseProcCustomDate\", \"CaseProcLegalDate\", \"CaseProcClientDate\", \"CaseProcFinishDate\", \"CaseProcUndertakerUserName\" ] }'"
run_one "11 GetCaseEntrustInfoByCaseId" "curl -sS -k --get \"$API/CaseInfo/GetCaseEntrustInfoByCaseId\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"caseId=$CASE_ID\""
run_one "12 GetCaseFileAllList" "curl -sS -k --get \"$API/CaseInfo/GetCaseFileAllList\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"CaseId=$CASE_ID\" --data-urlencode 'IsALL=true' --data-urlencode 'PageIndex=1' --data-urlencode 'PageSize=50'"
run_one "13 GetCaseAgentList" "curl -sS -k --get \"$API/CaseInfo/GetCaseAgentList\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"caseId=$CASE_ID\""
run_one "14 GetClientListByCaseDetail" "curl -sS -k -X POST \"$API/CaseInfo/GetClientListByCaseDetail\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' -H 'Content-Type: application/json' -d '{\"caseId\":\"'\"$CASE_ID\"'\"}'"
run_one "15 GetProcFlowRecord" "curl -sS -k --get \"$API/CaseMonitor/GetProcFlowRecord\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"caseProcId=$CASE_PROC_ID\""
run_one "16 GetCaseAllFlowHistoryInfo" "curl -sS -k --get \"$API/CaseInfo/GetCaseAllFlowHistoryInfo\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"caseId=$CASE_ID\""
run_one "17 IsExistHandInfo" "curl -sS -k --get \"$API/CaseInfo/IsExistHandInfo\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"caseProcId=$CASE_PROC_ID\""
run_one "18 GetHandInfo" "curl -sS -k --get \"$API/CaseInfo/GetHandInfo\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"caseProcId=$CASE_PROC_ID\""
run_one "19 GetCaseMonitoringListByCase" "curl -sS -k -X POST \"$API/CaseMonitor/GetCaseMonitoringListByCase\" -H \"Authorization: $TOKEN\" -H 'Origin: $ORIGIN' -H 'Language: zh-CN' -H 'Content-Type: application/json' -d '{ \"HasCaseInfoMoreParam\": false, \"CaseInfoMoreParam\": {}, \"StatType\": 6, \"CaseStatusCode\": null, \"ShowType\": 2, \"pageIndex\": 1, \"pageSize\": 20 }'"
run_one "20 GetProcFlowRecord-2" "curl -sS -k --get \"$API/CaseMonitor/GetProcFlowRecord\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"caseProcId=$CASE_PROC_ID\""
run_one "21 GetOfficialFormList" "curl -sS -k --get \"$API/CaseInfo/GetOfficialFormList\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode 'fileType=2' --data-urlencode \"caseHandId=$CASE_HAND_ID\""
run_one "22 GetFormPatentRequestInfo" "curl -sS -k --get \"$API/CaseInfo/GetFormPatentRequestInfo\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"caseHandId=$CASE_HAND_ID\""
run_one "23 GetFormOpinionStatement" "curl -sS -k --get \"$API/CaseInfo/GetFormOpinionStatement\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"caseHandId=$CASE_HAND_ID\""
run_one "24 GetFormCorrection" "curl -sS -k --get \"$API/CaseInfo/GetFormCorrection\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"caseHandId=$CASE_HAND_ID\""
run_one "25 GetCaseHandFileList" "curl -sS -k --get \"$API/CaseInfo/GetCaseHandFileList\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"caseHandId=$CASE_HAND_ID\""
run_one "26 GetCaseHandProcRelateNoticeInfo" "curl -sS -k --get \"$API/CaseInfo/GetCaseHandProcRelateNoticeInfo\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"caseHandId=$CASE_HAND_ID\""
run_one "27 GetCaseProcFileList" "curl -sS -k --get \"$API/CaseInfo/GetCaseProcFileList\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"caseProcId=$CASE_PROC_ID\" -o \"/tmp/_ro_procfiles.json\""
run_one "29 GetApplicantListQueryCase" "curl -sS -k --get \"$API/CaseInfo/GetApplicantListQueryCase\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"SearchValue=$SEARCH_KEY\" --data-urlencode 'PageIndex=1' --data-urlencode 'PageSize=20'"
run_one "30 GetInventorListByQueryCase" "curl -sS -k --get \"$API/CaseInfo/GetInventorListByQueryCase\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"SearchValue=$SEARCH_KEY\" --data-urlencode 'PageIndex=1' --data-urlencode 'PageSize=20'"
run_one "31 AnnuaFeeMonitoring-TabCount" "curl -sS -k --get \"$API/AnnuaFeeMonitoring/GetAnnuaFeeMonitoringTabCount\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN'"
run_one "32 AnnuaFeeMonitoring-StatisticsList" "curl -sS -k -X POST \"$API/AnnuaFeeMonitoring/GetAnnuaFeeMonitoringsStatisticsList\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' -H 'Content-Type: application/json' -d '{\"PagedInfo\":{\"pageIndex\":1,\"pageSize\":50}}'"
run_one "33 ProcCaculateNextYearLegalDate" "curl -sS -k --get \"$API/CaseInfo/ProcCaculateNextYearLegalDate\" -H \"Authorization: $TOKEN\" -H 'Language: zh-CN' --data-urlencode \"caseId=$CASE_ID\" --data-urlencode \"procId=$PROC_ID\" --data-urlencode \"annualFeeYearTo=2026\""
run_one "34 GetLegalDate" "curl -sS -k -X POST \"$API/ApplyCase/GetLegalDate\" -H \"Authorization: $TOKEN\" -H 'Origin: $ORIGIN' -H 'Language: zh-CN' -H 'Content-Type: application/json' -d '{ \"countryCode\": 36, \"caseRelatedTypeId\": 1, \"applyTypeCode\": 2, \"PriorityDateList\": [], \"PctApplicationDate\": null }'"
