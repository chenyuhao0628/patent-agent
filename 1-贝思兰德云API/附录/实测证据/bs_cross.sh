set -u
set -a; . /etc/personal-agent/patent.env 2>/dev/null || true; set +a
API="${BASELAND_API_URL:-https://cloudapi02.baselandtec.com/v1}"
ORIGIN="${BASELAND_ORIGIN:-https://cqgd.baselandtec.com}"
ACC="${RECIPIENT_A_ACCOUNT}"; PW="${RECIPIENT_A_PASSWORD}"; export ACC PW
TOKEN=$(curl -sS -k -X POST "$API/Auth/GetToken" -H "Origin: $ORIGIN" -H "Referer: $ORIGIN/login.html" -H 'Language: zh-CN' -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,os;print(json.dumps({"UserName":os.environ["ACC"],"Password":os.environ["PW"]}))')" \
  | python3 -c 'import json,sys;print((json.load(sys.stdin).get("Data") or {}).get("Token",""))')
A=(-H "Authorization: $TOKEN" -H "Origin: $ORIGIN" -H 'Language: zh-CN' -H 'Content-Type: application/json')
echo "=== 贝思兰德各页签待办（TableType 50010..50013）==="
for tt in 50010 50011 50012 50013; do
  curl -sS -k -m 30 -X POST "$API/CaseInfo/GetPersonalCase" "${A[@]}" \
    -d "{\"PagedInfo\":{\"pageIndex\":1,\"pageSize\":100},\"ProcStatusTypeList\":[],\"TableType\":$tt,\"ActiveName\":\"\",\"SelectedProcIdGroup\":[]}" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
rows=d.get('Data') or []
if not isinstance(rows,list): rows=rows.get('ListData') or []
print('  TableType=$tt  IsSuccess=%s  %d 条'%(d.get('IsSuccess'),len(rows)))
for r in rows[:40]:
    print('     %-14s %-10s %-30s %s'%(r.get('CaseNo') or r.get('PcmCaseNo') or '',
        r.get('ApplyNo') or r.get('PcmApplicationNo') or '', (r.get('CaseName') or r.get('PcmCaseName') or '')[:28],
        (r.get('ProcName') or r.get('CaseProcName') or '')[:22]))
"
done
