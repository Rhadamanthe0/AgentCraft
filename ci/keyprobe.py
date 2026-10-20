"""Check the one OpenCode key of a bench (PLANNER_API_KEY) before the levels.

At start, a tiny prompt without reasoning goes to the model the bots plan with
(PLANNER_MODEL_PLAN of ci/models.env; 2026-10-10: a spent Go limit refuses
every model). It answers: the bench plays. It does not: the bench fails at once
instead of 75 min of red levels. An `openai/<model>` bench model (manual run,
input base_model) is probed with OPENAI_API_KEY at the OpenAI API instead, and
the OpenCode key does not reach the bots (report.keyCheck). A key is never
printed, logged or put in the report.
"""
import json
import os
import time
import unicodedata
import urllib.error
import urllib.request

from pathlib import Path

BASE = 'https://opencode.ai/zen/go/v1'
URL = BASE + '/chat/completions'
MODELS_ENV = Path(__file__).with_name('models.env')
DEFAULT_MODEL = 'deepseek-v4.1-flash'


def bench_model(path=MODELS_ENV):
    """PLANNER_MODEL_PLAN (else PLANNER_MODEL) of ci/models.env."""
    values = {}
    try:
        for line in path.read_text(encoding='utf-8').splitlines():
            name, sep, value = line.partition('=')
            if sep and not name.strip().startswith('#'):
                values[name.strip()] = value.strip()
    except OSError:
        pass
    return values.get('PLANNER_MODEL_PLAN') or values.get('PLANNER_MODEL') or DEFAULT_MODEL


MODEL = bench_model()
PROMPT = "Pas de réflexion, répond uniquement 'test validé'"
TIMEOUT_S = 20
KEY_VAR = 'PLANNER_API_KEY'
OPENAI_PREFIX = 'openai/'
OPENAI_BASE = (os.environ.get('OPENAI_BASE_URL') or 'https://api.openai.com/v1').rstrip('/')


def plain(text):
    text = unicodedata.normalize('NFKD', text or '')
    return ''.join(c for c in text if not unicodedata.combining(c)).lower()


def probe(key, urlopen=urllib.request.urlopen, model=None):
    """One call; never returns or raises anything holding the key."""
    model = model or MODEL
    openai = model.startswith(OPENAI_PREFIX)
    if openai:
        model = model[len(OPENAI_PREFIX):]
    claude = model.startswith('claude-')
    gpt = model.startswith('gpt-')
    headers = {'Authorization': f'Bearer {key}', 'Content-Type': 'application/json',
               'User-Agent': 'minecraft-bot/1.0', 'x-opencode-session': 'minebot-ci-keyprobe'}
    if claude:
        # Claude is served on /messages only (bot/llm.js): no temperature.
        headers.update({'x-api-key': key, 'anthropic-version': '2023-06-01'})
        body = {'model': model, 'max_tokens': 200, 'thinking': {'type': 'disabled'},
                'messages': [{'role': 'user', 'content': PROMPT}]}
    elif gpt:
        # GPT is served on /responses only (bot/llm.js): no temperature, least effort.
        body = {'model': model, 'max_output_tokens': 200, 'reasoning': {'effort': 'low'},
                'input': [{'role': 'user', 'content': PROMPT}]}
    else:
        body = {'model': model, 'temperature': 0, 'max_tokens': 200, 'thinking': {'type': 'disabled'},
                'messages': [{'role': 'user', 'content': PROMPT}]}
    url = (OPENAI_BASE if openai else BASE) + ('/messages' if claude else '/responses' if gpt else '/chat/completions')
    request = urllib.request.Request(url, data=json.dumps(body).encode(),
                                     method='POST', headers=headers)
    started = time.monotonic()
    result = {'status': None}
    try:
        with urlopen(request, timeout=TIMEOUT_S) as response:
            result['status'] = response.status
            data = json.load(response)
        if claude:
            answer = ''.join(c.get('text') or '' for c in data.get('content') or [] if c.get('type') == 'text')
        elif gpt:
            answer = data.get('output_text') or ''.join(
                c.get('text') or '' for item in data.get('output') or [] for c in item.get('content') or []
                if c.get('type') == 'output_text')
        else:
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


def select(environ=None, probe_fn=probe):
    """{'chosen': 'opencode', 'openai' or None, 'probes': {name: result}}."""
    environ = os.environ if environ is None else environ
    name, var = ('openai', 'OPENAI_API_KEY') if MODEL.startswith(OPENAI_PREFIX) else ('opencode', KEY_VAR)
    key = (environ.get(var) or '').strip()
    result = probe_fn(key) if key else {'ok': False, 'error': 'secret absent'}
    return {'model': MODEL, 'prompt': PROMPT, 'chosen': name if result.get('ok') else None,
            'probes': {name: result}}


def bot_env(env, chosen):
    """The OpenCode key reaches the bots only when it is the bench key."""
    if chosen != 'opencode':
        env.pop(KEY_VAR, None)
    return env
