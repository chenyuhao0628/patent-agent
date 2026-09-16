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
probe() {  # $1=label $2=METHOD $3=path
  local out
  if [ "$2" = "GET" ]; then
    out=$(curl -sS -k -m 25 --get "$API$3" -H "Authorization: $TOKEN" -H "Origin: $ORIGIN" -H 'Language: zh-CN')
  else
    out=$(curl -sS -k -m 25 -X POST "$API$3" -H "Authorization: $TOKEN" -H "Origin: $ORIGIN" -H 'Language: zh-CN' -H 'Content-Type: application/json' -d '{}')
  fi
  printf '%s\n' "$out" | python3 /tmp/_bs_verdict.py "$1"
}
echo "==================== 只读权限探测 ===================="
probe "客户与商务 | /Client/GetAutoGenerateServiceFeeTiming" GET "/Client/GetAutoGenerateServiceFeeTiming"
probe "客户与商务 | /CrmCommissionOrder/GetBusinessLeaderCommissionList" GET "/CrmCommissionOrder/GetBusinessLeaderCommissionList"
probe "客户与商务 | /CrmHomePage/GetContractSignalSituation" POST "/CrmHomePage/GetContractSignalSituation"
probe "客户与商务 | /ContractQuery/GetContractChooseCollectionMoneyList" POST "/ContractQuery/GetContractChooseCollectionMoneyList"
probe "客户与商务 | /EntrustCase/GetCaseProcEntrustDate" GET "/EntrustCase/GetCaseProcEntrustDate"
probe "客户与商务 | /CrEntrustCase/GetCaseProcEntrustDate" GET "/CrEntrustCase/GetCaseProcEntrustDate"
probe "客户与商务 | /TmEntrustCase/GetCaseProcEntrustDate" GET "/TmEntrustCase/GetCaseProcEntrustDate"
probe "财务与费用 | /Finance/GetBillBankDefaultValue" GET "/Finance/GetBillBankDefaultValue"
probe "财务与费用 | /PayOrder/GetCaseFeeItemList" POST "/PayOrder/GetCaseFeeItemList"
probe "财务与费用 | /PtPayOfficalFeeBill/GetAuthority" GET "/PtPayOfficalFeeBill/GetAuthority"
probe "财务与费用 | /ChargeOffOrder/GetChargeOffOrderBillList" GET "/ChargeOffOrder/GetChargeOffOrderBillList"
probe "财务与费用 | /BusinessFinanceReport/GetBusinessDetailReport" POST "/BusinessFinanceReport/GetBusinessDetailReport"
probe "财务与费用 | /PtFeeMonitorOrder/GetPtFeeMonitorOrderDetail" GET "/PtFeeMonitorOrder/GetPtFeeMonitorOrderDetail"
probe "财务与费用 | /ServiceFeeRule/GetClientServiceFeeRuleMapList" GET "/ServiceFeeRule/GetClientServiceFeeRuleMapList"
probe "商标线 | /TmCaseInfo/GetAnnualYearByCaseProc" GET "/TmCaseInfo/GetAnnualYearByCaseProc"
probe "商标线 | /TmPayOfficalFeeBill/GetCanSelectPayOfficalFeeBillFeeCount" POST "/TmPayOfficalFeeBill/GetCanSelectPayOfficalFeeBillFeeCount"
probe "著作权线 | /CrCaseInfo/GetAnnualYearByCaseProc" GET "/CrCaseInfo/GetAnnualYearByCaseProc"
probe "著作权线 | /CrPayOfficalFeeBill/GetCanSelectPayOfficalFeeBillFeeCount" POST "/CrPayOfficalFeeBill/GetCanSelectPayOfficalFeeBillFeeCount"
probe "诉讼线 | /LsCaseInfo/GetCaseProcById" GET "/LsCaseInfo/GetCaseProcById"
probe "无效线 | /PiCaseInfo/GetCaseContactById" GET "/PiCaseInfo/GetCaseContactById"
probe "集成电路线 | /TsCaseInfo/GetAnnualYearByCaseProc" GET "/TsCaseInfo/GetAnnualYearByCaseProc"
probe "批量与规则 | /PatentRule/GetCrPatentRuleById" GET "/PatentRule/GetCrPatentRuleById"
probe "批量与规则 | /PatentNoticeRule/GetCrMailLabelList" GET "/PatentNoticeRule/GetCrMailLabelList"
probe "行政与报表 | /ExpressBill/GetClientCountByExpressBill" GET "/ExpressBill/GetClientCountByExpressBill"
probe "行政与报表 | /Email/GetCaseDetailEmailAttachInfo" GET "/Email/GetCaseDetailEmailAttachInfo"
probe "行政与报表 | /Report/GetAgentUserCaseCount" POST "/Report/GetAgentUserCaseCount"
probe "系统与配置 | /SystemCompany/GetClientContactRequiredFieldType" GET "/SystemCompany/GetClientContactRequiredFieldType"
probe "其它 | /AnnualFee/GetAnnualFeeById" GET "/AnnualFee/GetAnnualFeeById"
probe "其它 | /CaseFile/GetAgencyCaseFileList" POST "/CaseFile/GetAgencyCaseFileList"
probe "其它 | /CrmMarketActivityFee/GetCrmMarketActivityFeeAuthority" GET "/CrmMarketActivityFee/GetCrmMarketActivityFeeAuthority"
probe "其它 | /PtOfficalFeeMonitor/GetCpqueryAccountById" GET "/PtOfficalFeeMonitor/GetCpqueryAccountById"
probe "其它 | /CrOfficalFeeMonitoring/GetCaseProcUndertakerTreeWithUser" GET "/CrOfficalFeeMonitoring/GetCaseProcUndertakerTreeWithUser"
probe "其它 | /TmOfficalFeeMonitoring/GetCaseProcUndertakerTreeWithUser" GET "/TmOfficalFeeMonitoring/GetCaseProcUndertakerTreeWithUser"
