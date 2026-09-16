set -u
set -a; . /etc/personal-agent/patent.env 2>/dev/null || true; set +a
API="${BASELAND_API_URL:-https://cloudapi02.baselandtec.com/v1}"; ORIGIN="${BASELAND_ORIGIN:-https://cqgd.baselandtec.com}"
ACC="${RECIPIENT_A_ACCOUNT}"; PW="${RECIPIENT_A_PASSWORD}"; export ACC PW
TOKEN=$(curl -sS -k -X POST "$API/Auth/GetToken" -H "Origin: $ORIGIN" -H "Referer: $ORIGIN/login.html" -H 'Language: zh-CN' -H 'Content-Type: application/json' \
 -d "$(python3 -c 'import json,os;print(json.dumps({"UserName":os.environ["ACC"],"Password":os.environ["PW"]}))')" \
 | python3 -c 'import json,sys;print((json.load(sys.stdin).get("Data") or {}).get("Token",""))')
A=(-H "Authorization: $TOKEN" -H "Origin: $ORIGIN" -H "Referer: $ORIGIN/login.html" -H 'Language: zh-CN' -H 'Content-Type: application/json')
echo "### A. 上一轮 GetCaseProcFileList 落盘内容"
python3 -c "
import json
try:
  d=json.load(open('/tmp/_ro_procfiles.json'))
  print('  IsSuccess',d.get('IsSuccess'),'Message',d.get('Message'))
  x=d.get('Data')
  print('  Data 条数',len(x) if isinstance(x,list) else type(x).__name__)
  if isinstance(x,list) and x: print('  首条字段:',sorted(x[0].keys())[:24])
except Exception as e: print('  读取失败',e)
"
echo
echo "### B. 取自递交中案件，找 procId 与 caseRelatedTypeId"
curl -sS -k -X POST "$API/CaseInfo/GetPersonalCase" "${A[@]}" -d '{"PagedInfo":{"pageIndex":1,"pageSize":5},"ProcStatusTypeList":[400],"TableType":50013,"ActiveName":"delivering","SelectedProcIdGroup":[]}' -o /tmp/_d.json
CASE=$(python3 -c "import json;d=json.load(open('/tmp/_d.json'));print(d['Data'][0]['CaseId'])")
CPROC=$(python3 -c "import json;d=json.load(open('/tmp/_d.json'));print(d['Data'][0].get('CaseProcId') or '')")
echo "  caseId=$CASE caseProcId=$CPROC"
python3 -c "
import json
d=json.load(open('/tmp/_d.json'));r=d['Data'][0]
print('  行内所有含 ID/Type 的字段:')
for k,v in sorted(r.items()):
    if any(s in k for s in ('Id','ID','Type','Code')) and v not in (None,''): print('    %-34s %s'%(k,str(v)[:50]))
"
curl -sS -k --get "$API/CaseInfo/GetUpdateCaseInfo" "${A[@]}" --data-urlencode "caseId=$CASE" -o /tmp/_u.json
python3 -c "
import json
d=json.load(open('/tmp/_u.json'));x=d.get('Data') or {}
print('  GetUpdateCaseInfo 含 Type/Id 字段:')
for k,v in sorted(x.items()):
    if any(s in k for s in ('Type','Related','Country')) and v not in (None,''): print('    %-34s %s'%(k,str(v)[:50]))
"
echo
echo "### C. GetCaseDetailProcList 行里的 procId"
curl -sS -k -X POST "$API/CaseInfo/GetCaseDetailProcList" "${A[@]}" -H 'Content-Type: application/json' \
 -d "{\"caseId\":\"$CASE\",\"TableType\":80001,\"SortInfo\":{},\"UserTableTitleColumnList\":[\"CaseProcName\",\"CaseProcCustomDate\",\"CaseProcUndertakerUserName\"]}" -o /tmp/_p.json
python3 -c "
import json
d=json.load(open('/tmp/_p.json'));x=d.get('Data') or []
print('  行数',len(x) if isinstance(x,list) else '?')
if isinstance(x,list) and x:
    print('  首行含 Id 字段:')
    for k,v in sorted(x[0].items()):
        if 'Id' in k and v not in (None,''): print('    %-34s %s'%(k,str(v)[:50]))
"
printf 'CASE=%q\n' "$CASE" > /tmp/_ids2.sh; printf 'CPROC=%q\n' "$CPROC" >> /tmp/_ids2.sh
. /tmp/_ids2.sh
echo
echo "### D. 用真实 procId 重试 ProcCaculateNextYearLegalDate"
if [ -n "$CPROC" ]; then
curl -sS -k --get "$API/CaseInfo/ProcCaculateNextYearLegalDate" "${A[@]}" \
  --data-urlencode "caseId=$CASE" --data-urlencode "procId=$CPROC" --data-urlencode "annualFeeYearTo=2026" \
  -w '\n  http=%{http_code}\n' | head -c 600
else echo "  无 caseProcId，跳过"; fi
