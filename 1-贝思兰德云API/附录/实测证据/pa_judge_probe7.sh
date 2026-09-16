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

echo "=========================================================================="
echo " R. Token 失效时的真实形态（用伪造 token，只读调用）"
echo "=========================================================================="
for T in "bogus-token-123" "" "abc.def.ghi"; do
  echo "--- Authorization: '${T}'"
  curl -sS -k -m 25 -o /tmp/_r.json -w "  HTTP=%{http_code}\n" --get "$API/CaseInfo/GetPersonalProcStatistics" \
    -H "Authorization: $T" -H "Origin: $ORIGIN" -H 'Language: zh-CN' 2>&1
  head -c 400 /tmp/_r.json; echo; echo
done

echo "=========================================================================="
echo " S. /Auth/GetToken 响应是否带过期时间"
echo "=========================================================================="
curl -sS -k -m 30 -X POST "$API/Auth/GetToken" -H "Origin: $ORIGIN" -H "Referer: $ORIGIN/login.html" -H 'Language: zh-CN' -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,os;print(json.dumps({"UserName":os.environ["ACC"],"Password":os.environ["PW"]}))')" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); D=d.get("Data") or {}; print("  Data 键:", sorted(D.keys())); print("  Token 前20:", str(D.get("Token"))[:20]); [print(f"  {k} = {D.get(k)!r}") for k in D if k!="Token"]'

echo
echo "=========================================================================="
echo " T. 分页上限的替代方案：GetPersonalCaseCount 是否存在/可用"
echo "=========================================================================="
for M in GetPersonalCaseCount GetPersonalCaseSubTabStatisticsCount; do
  echo "--- $M"
  curl -sS -k -m 25 --get "$API/CaseInfo/$M" -H "Authorization: $TOKEN" -H "Origin: $ORIGIN" -H 'Language: zh-CN' \
    --data-urlencode 'caseProcStatusType=400' --data-urlencode 'ProcStatusTypeList=400' --data-urlencode 'TableType=50013' --data-urlencode 'ActiveName=delivering' \
    | head -c 300; echo
done

echo
echo "=========================================================================="
echo " U. pageSize 上限探测：能否一次取回全部 50 条（跨页签）"
echo "=========================================================================="
curl -sS -k -m 40 -X POST "$API/CaseInfo/GetPersonalCase" -H "Authorization: $TOKEN" -H "Origin: $ORIGIN" -H 'Language: zh-CN' -H 'Content-Type: application/json' \
  -d '{"PagedInfo":{"pageIndex":1,"pageSize":1000},"ProcStatusTypeList":[0,200,300,400,500],"TableType":50010,"ActiveName":"waitHand","SelectedProcIdGroup":[]}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); v=d.get("Data"); print("  IsSuccess=",d.get("IsSuccess"),"Message=",d.get("Message")); print("  行数=",len(v) if isinstance(v,list) else v)'
curl -sS -k -m 40 -X POST "$API/CaseInfo/GetPersonalCase" -H "Authorization: $TOKEN" -H "Origin: $ORIGIN" -H 'Language: zh-CN' -H 'Content-Type: application/json' \
  -d '{"PagedInfo":{"pageIndex":1,"pageSize":100},"ProcStatusTypeList":[0,200,300,400,500],"TableType":50010,"ActiveName":"waitHand","SelectedProcIdGroup":[]}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); v=d.get("Data"); print("  pageSize=100 跨状态 行数=",len(v) if isinstance(v,list) else v)'
