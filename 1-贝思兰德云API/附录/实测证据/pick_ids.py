import json, os, sys
d = json.load(open('/tmp/_ro_case.json'))
data = d.get('Data') or []
if isinstance(data, dict):
    data = data.get('ListData') or data.get('List') or []
if not data:
    print("N_CASES=0")
    sys.exit(0)
r = data[0]
def q(v):
    return "'" + str(v or '').replace("'", "") + "'"
print('CASE_ID=' + q(r.get('CaseId')))
print('CASE_PROC_ID=' + q(r.get('CaseProcId')))
print('CASE_HAND_ID=' + q(r.get('CaseHandId')))
print('PROC_ID=' + q(r.get('ProcId')))
print('SEARCH_KEY=' + q(r.get('ApplicantName') or r.get('ApplicantNames') or ''))
print('N_CASES=%d' % len(data))
