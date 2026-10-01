"""Choose the one OpenCode key of a bench (owner's rule, 2026-10-01).

At start, a tiny prompt without reasoning goes to deepseek-v4.1-flash with each
key. Both answer: primary. One answers: that one. None: the bench fails.
Only the chosen key then reaches the bots, so no switch can happen mid-bench
(report.keyCheck). A key is never printed, logged or put in the report.
"""
import concurrent.futures
import json
import os
import time
import unicodedata
import urllib.error
import urllib.request

URL = 'https://opencode.ai/zen/go/v1/chat/completions'
MODEL = 'deepseek-v4.1-flash'
PROMPT = "Pas de réflexion, répond uniquement 'test validé'"
TIMEOUT_S = 20
# GitHub secret(s) holding each key, in order; PLANNER_API_KEY stays accepted
# for a local machine.
SOURCES = {'primary': ('OPENCODE_PRIMARY_API_KEY', 'PLANNER_API_KEY'),
           'secondary': ('OPENCODE_SECONDARY_API_KEY',)}
# Variable the bot reads for each key (bot/model-chain.js KEY_VARS).
BOT_VARS = {'primary': 'PLANNER_API_KEY', 'secondary': 'OPENCODE_SECONDARY_API_KEY'}
ORDER = ('primary', 'secondary')


def key_value(name, environ=None):
    environ = os.environ if environ is None else environ
    for var in SOURCES[name]:
        value = (environ.get(var) or '').strip()
        if value:
            return value
    return ''


def plain(text):
    text = unicodedata.normalize('NFKD', text or '')
    return ''.join(c for c in text if not unicodedata.combining(c)).lower()


def probe(key, urlopen=urllib.request.urlopen):
    """One call; never returns or raises anything holding the key."""
    body = json.dumps({'model': MODEL, 'temperature': 0, 'max_tokens': 200,
                       'thinking': {'type': 'disabled'},
                       'messages': [{'role': 'user', 'content': PROMPT}]}).encode()
    request = urllib.request.Request(URL, data=body, method='POST', headers={
        'Authorization': f'Bearer {key}', 'Content-Type': 'application/json',
        'User-Agent': 'minecraft-bot/1.0', 'x-opencode-session': 'minebot-ci-keyprobe'})
    started = time.monotonic()
    result = {'status': None}
    try:
        with urlopen(request, timeout=TIMEOUT_S) as response:
            result['status'] = response.status
            data = json.load(response)
        answer = ((data.get('choices') or [{}])[0].get('message') or {}).get('content') or ''
        result['answer'] = answer.strip()[:80]
    except urllib.error.HTTPError as error:
        result['status'] = error.code
        try:
            result['error'] = error.read().decode('utf-8', 'replace')[:200]
        except OSError:
            result['error'] = f'HTTP {error.code}'
    except (OSError, ValueError, AttributeError, IndexError) as error:
        result['error'] = f'{type(error).__name__}: {str(error)[:200]}'
    result['ms'] = round((time.monotonic() - started) * 1000)
    result['ok'] = result['status'] == 200 and 'test valide' in plain(result.get('answer'))
    if key and any(key in str(v) for v in result.values()):
        result = {'status': result['status'], 'ok': result['ok'], 'ms': result['ms'], 'error': 'reponse masquee'}
    return result


def choose(results):
    """primary if it answers, else secondary if it answers, else None."""
    return next((name for name in ORDER if (results.get(name) or {}).get('ok')), None)


def select(environ=None, probe_fn=probe):
    """{'chosen': name or None, 'probes': {name: result}} for the keys present."""
    keys = {name: key_value(name, environ) for name in ORDER}
    results = {name: {'ok': False, 'error': 'secret absent'} for name, key in keys.items() if not key}
    present = [name for name, key in keys.items() if key]
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(ORDER)) as pool:
        for name, result in zip(present, pool.map(lambda n: probe_fn(keys[n]), present)):
            results[name] = result
    return {'model': MODEL, 'prompt': PROMPT, 'chosen': choose(results),
            'probes': {name: results[name] for name in ORDER}}


def bot_env(env, chosen, environ=None):
    """Leave only the chosen key to the bots, under the name they read."""
    for name in ORDER:
        for var in (*SOURCES[name], BOT_VARS[name]):
            env.pop(var, None)
    if chosen:
        env[BOT_VARS[chosen]] = key_value(chosen, environ)
    return env
