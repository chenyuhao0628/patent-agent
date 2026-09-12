"""No-model local protocol probe. Uses only synthetic cases and isolated runtime data."""
import base64
import json
import os
from pathlib import Path
import queue
import secrets
import signal
import socket
import subprocess
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / '.lab' / ('probe-' + time.strftime('%Y%m%d-%H%M%S'))
RUN.mkdir(parents=True)
CASES = [RUN / '案件甲' / '第二轮', RUN / '案件乙' / '第一轮']
for path in CASES:
    path.mkdir(parents=True)
BASE_ENV = {k: os.environ[k] for k in ('PATH', 'LANG', 'TMPDIR', 'SYSTEMROOT') if k in os.environ}
BASE_ENV.update({'XDG_CONFIG_HOME': str(RUN / 'config'), 'XDG_DATA_HOME': str(RUN / 'data'), 'XDG_CACHE_HOME': str(RUN / 'cache')})
report = {'date': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'platform': os.uname().sysname + ' ' + os.uname().machine, 'scope': 'synthetic sessions; no prompt or real model request; no user credentials', 'results': {}}

def stop(p):
    if p and p.poll() is None:
        os.killpg(p.pid, signal.SIGTERM)
        try: p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL); p.wait(timeout=3)

def opencode():
    binary = ROOT / '.lab/runtimes/opencode/node_modules/.bin/opencode'
    env = dict(BASE_ENV)
    secret = secrets.token_hex(16)
    env.update({'OPENCODE_SERVER_USERNAME': 'probe', 'OPENCODE_SERVER_PASSWORD': secret, 'OPENCODE_CONFIG_CONTENT': '{"permission":"deny","share":"disabled"}'})
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    auth = 'Basic ' + base64.b64encode(('probe:' + secret).encode()).decode()
    def request(path, body=None):
        req = urllib.request.Request(url + path, data=None if body is None else json.dumps(body).encode(), headers={'Authorization': auth, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.load(response)
    def start():
        p = subprocess.Popen([str(binary), 'serve', '--pure', '--hostname', '127.0.0.1', '--port', str(port)], cwd=CASES[0], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(100):
            try: health = request('/global/health'); return p, health
            except Exception:
                if p.poll() is not None: raise RuntimeError('server exited during startup')
                time.sleep(.1)
        stop(p); raise RuntimeError('health readiness timeout')
    p = None
    try:
        p, health = start()
        a = request('/session', {'title': '案件甲 / 第二轮 / 答复'})
        b = request('/session', {'title': '案件乙 / 第一轮 / 独立审查'})
        ids = [a['id'], b['id']]
        listed = request('/session')
        before = all(i in [x['id'] for x in listed] for i in ids)
        stop(p); p, _ = start()
        after = request('/session')
        result = {'version': health['version'], 'headless_health': health['healthy'], 'two_distinct_session_ids': ids[0] != ids[1], 'list_roundtrip': before, 'survive_process_restart': all(i in [x['id'] for x in after] for i in ids), 'chinese_cwd': a.get('directory') == str(CASES[0]), 'observed_directory': a.get('directory'), 'limitation': 'Two sessions in one directory; cross-directory isolation, streaming, running cancellation and model/file support NOT tested.'}
        return result
    finally: stop(p)

def hermes():
    binary = ROOT / '.lab/runtimes/hermes-venv/bin/python'
    env = dict(BASE_ENV); env['HERMES_HOME'] = str(RUN / 'hermes-profile'); env['PYTHONUNBUFFERED'] = '1'
    p = subprocess.Popen([str(binary), '-m', 'tui_gateway.entry'], cwd=ROOT / '.lab/runtimes/hermes', env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
    lines = queue.Queue()
    def reader():
        for line in p.stdout:
            try: lines.put(json.loads(line))
            except ValueError: pass
    threading.Thread(target=reader, daemon=True).start()
    def until(predicate, seconds=30):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            try: data = lines.get(timeout=.2)
            except queue.Empty:
                if p.poll() is not None: raise RuntimeError('gateway exited before response')
                continue
            if predicate(data): return data
        raise RuntimeError('JSON-RPC response timeout')
    n = 0
    def rpc(method, params):
        nonlocal n
        n += 1
        p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': n, 'method': method, 'params': params}, ensure_ascii=False) + '\n'); p.stdin.flush()
        response = until(lambda d: d.get('id') == n)
        if 'error' in response: raise RuntimeError('RPC ' + method + ' error code ' + str(response['error'].get('code')))
        return response['result']
    try:
        until(lambda d: d.get('params', {}).get('type') == 'gateway.ready')
        a = rpc('session.create', {'cwd': str(CASES[0]), 'title': '案件甲 / 第二轮 / 答复'})
        b = rpc('session.create', {'cwd': str(CASES[1]), 'title': '案件乙 / 第一轮 / 独立审查'})
        history = rpc('session.history', {'session_id': a['session_id']})
        active = rpc('session.active_list', {})
        return {'version': '0.21.1', 'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT / '.lab/runtimes/hermes', text=True).strip(), 'gateway_ready_event': True, 'two_distinct_session_ids': a['session_id'] != b['session_id'], 'chinese_cwd': a.get('info', {}).get('cwd') == str(CASES[0]) and b.get('info', {}).get('cwd') == str(CASES[1]), 'empty_history_roundtrip': history.get('count') == 0, 'active_list_response': isinstance(active, dict), 'limitation': 'Fresh sessions are lazily persisted by upstream; durable transcript restart, model execution and running cancellation NOT tested.'}
    finally: stop(p)

for name, fn in [('opencode', opencode), ('hermes', hermes)]:
    try: report['results'][name] = fn()
    except Exception as exc: report['results'][name] = {'error': type(exc).__name__ + ': ' + str(exc)}
    print(name + ': ' + json.dumps(report['results'][name], ensure_ascii=False), flush=True)
(ROOT / 'evidence/backend-protocol-probe.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
