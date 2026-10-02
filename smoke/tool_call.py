# Day-1 smoke test: Nemotron tool calling on Nebius Token Factory (forced, then auto).
import json, sys, time, urllib.request
env = dict(l.strip().split('=', 1) for l in open('.env', encoding='utf-8') if '=' in l and not l.startswith('#'))
KEY, BASE = env['NEBIUS_API_KEY'].strip(), env['NEBIUS_BASE_URL'].rstrip('/')
TOOLS = [{"type": "function", "function": {
    "name": "quote",
    "description": "Get the price for a service for this customer.",
    "parameters": {"type": "object", "properties": {
        "service": {"type": "string", "enum": ["cv_rewrite", "linkedin_profile", "interview_coaching"]},
        "seniority": {"type": "string", "enum": ["junior", "mid", "senior", "executive"]}},
        "required": ["service", "seniority"]}}}]
MSG = [{"role": "system", "content": "You are the service desk of a career-services studio. Use tools for prices; never guess."},
       {"role": "user", "content": "انا مدير اول واحتاج اعيد كتابة سيرتي الذاتية، كم السعر؟"}]
def call(model, choice):
    body = {"model": model, "messages": MSG, "tools": TOOLS, "tool_choice": choice, "temperature": 0}
    r = urllib.request.Request(BASE + '/chat/completions', data=json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'})
    t = time.time(); d = json.load(urllib.request.urlopen(r, timeout=120)); dt = time.time() - t
    m = d['choices'][0]['message']; tc = m.get('tool_calls') or []
    return dt, [(c['function']['name'], json.loads(c['function']['arguments'])) for c in tc], (m.get('content') or '')[:120]
for model in sys.argv[1:]:
    for label, choice in [('forced', {"type": "function", "function": {"name": "quote"}}), ('auto', 'auto')]:
        try:
            dt, calls, text = call(model, choice)
            ok = bool(calls) and calls[0][0] == 'quote' and calls[0][1].get('service') == 'cv_rewrite' and calls[0][1].get('seniority') in ('senior', 'executive')
            print(f"{'PASS' if ok else 'FAIL'} {model} {label} {dt:.1f}s calls={calls} text={text!r}")
        except Exception as e:
            print(f"ERROR {model} {label}: {e}")
