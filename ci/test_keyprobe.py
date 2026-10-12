"""Startup key choice (python3 -m unittest ci/test_keyprobe.py)."""
import io
import json
import os
import sys
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import keyprobe  # noqa: E402

ENV = {'OPENCODE_PRIMARY_API_KEY': 'k-primary', 'OPENCODE_SECONDARY_API_KEY': 'k-secondary'}


def answering(*good):
    return lambda key: {'ok': key in good, 'status': 200 if key in good else 401}


class Choice(unittest.TestCase):
    def test_both_answer_primary(self):
        self.assertEqual(keyprobe.select(ENV, answering('k-primary', 'k-secondary'))['chosen'], 'primary')

    def test_only_one_answers(self):
        self.assertEqual(keyprobe.select(ENV, answering('k-secondary'))['chosen'], 'secondary')
        self.assertEqual(keyprobe.select(ENV, answering('k-primary'))['chosen'], 'primary')

    def test_none_answers(self):
        chosen = keyprobe.select(ENV, answering())
        self.assertIsNone(chosen['chosen'])
        self.assertEqual(set(chosen['probes']), {'primary', 'secondary'})

    def test_missing_secret_is_not_probed(self):
        calls = []
        result = keyprobe.select({'OPENCODE_SECONDARY_API_KEY': 'k-secondary'},
                                 lambda key: calls.append(key) or {'ok': True, 'status': 200})
        self.assertEqual(calls, ['k-secondary'])
        self.assertEqual(result['chosen'], 'secondary')
        self.assertEqual(result['probes']['primary']['error'], 'secret absent')

    def test_bots_get_only_the_chosen_key(self):
        env = dict(ENV, PLANNER_API_KEY='old', OTHER='x')
        self.assertEqual(keyprobe.bot_env(env, 'secondary', ENV), {'OTHER': 'x', 'OPENCODE_SECONDARY_API_KEY': 'k-secondary'})
        env = dict(ENV)
        self.assertEqual(keyprobe.bot_env(env, 'primary', ENV), {'PLANNER_API_KEY': 'k-primary'})
        self.assertEqual(keyprobe.bot_env(dict(ENV), None, ENV), {})


class Probe(unittest.TestCase):
    def reply(self, status=200, content='Test validé.'):
        sent = {}

        class Response(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): return False

        def urlopen(request, timeout):
            sent['body'] = json.loads(request.data)
            sent['url'] = request.full_url
            sent['auth'] = request.get_header('Authorization')
            sent['x-api-key'] = request.get_header('X-api-key')
            if status != 200:
                raise urllib.error.HTTPError(request.full_url, status, 'x', {}, io.BytesIO(b'{"error":"Invalid credential"}'))
            if request.full_url.endswith('/responses'):
                data = {'output': [{'type': 'reasoning'}, {'type': 'message', 'content': [{'type': 'output_text', 'text': content}]}]}
            elif request.full_url.endswith('/messages'):
                data = {'content': [{'type': 'thinking', 'thinking': ''}, {'type': 'text', 'text': content}]}
            else:
                data = {'choices': [{'message': {'content': content}}]}
            r = Response(json.dumps(data).encode())
            r.status = 200
            return r
        return sent, urlopen

    def test_probes_the_bench_plan_model(self):
        env = Path(__file__).with_name('models.env').read_text(encoding='utf-8')
        plan = next(l.split('=', 1)[1].strip() for l in env.splitlines() if l.startswith('PLANNER_MODEL_PLAN='))
        self.assertEqual(keyprobe.MODELS, [m.strip() for m in plan.split(',')])
        self.assertEqual(keyprobe.MODEL, keyprobe.MODELS[0])

    def test_key_reaching_more_models_wins(self):
        results = {'primary': {'ok': True, 'score': 1}, 'secondary': {'ok': True, 'score': 2}}
        self.assertEqual(keyprobe.choose(results), 'secondary')
        results['secondary']['score'] = 1
        self.assertEqual(keyprobe.choose(results), 'primary')

    def test_chain_passes_on_the_first_model_that_answers(self):
        calls = []

        def fake(key, urlopen, model=None):
            calls.append(model)
            return {'status': 429 if model == 'gratuit' else 200, 'ok': model != 'gratuit', 'ms': 1}
        old = keyprobe.probe
        keyprobe.probe = fake
        try:
            result = keyprobe.probe_chain('k', models=['gratuit', 'payant', 'autre'])
        finally:
            keyprobe.probe = old
        self.assertEqual(calls, ['gratuit', 'payant', 'autre'])
        self.assertTrue(result['ok'])
        self.assertEqual(result['model'], 'payant')
        self.assertEqual(result['score'], 2)

    def test_claude_on_messages(self):
        sent, urlopen = self.reply()
        result = keyprobe.probe('k-1', urlopen, model='claude-haiku-5-5')
        self.assertTrue(result['ok'])
        self.assertTrue(sent['url'].endswith('/v1/messages'))
        self.assertEqual(sent['x-api-key'], 'k-1')
        self.assertNotIn('temperature', sent['body'])
        self.assertEqual(sent['body']['thinking'], {'type': 'disabled'})
        self.assertNotIn('k-1', json.dumps(result))

    def test_gpt_on_responses(self):
        sent, urlopen = self.reply()
        result = keyprobe.probe('k-1', urlopen, model='gpt-6-luna')
        self.assertTrue(result['ok'])
        self.assertTrue(sent['url'].endswith('/v1/responses'))
        self.assertNotIn('temperature', sent['body'])
        self.assertEqual(sent['body']['input'][0]['content'], keyprobe.PROMPT)
        self.assertNotIn('k-1', json.dumps(result))

    def test_openai_bench_model(self):
        sent, urlopen = self.reply()
        old = keyprobe.MODEL
        keyprobe.MODEL = 'openai/gpt-5.4-mini'
        try:
            result = keyprobe.select({**ENV, 'OPENAI_API_KEY': 'k-openai'},
                                     probe_fn=lambda k: keyprobe.probe(k, urlopen))
            self.assertEqual(result['chosen'], 'openai')
            self.assertTrue(sent['url'].startswith('https://api.openai.com/v1/responses'))
            self.assertEqual(sent['body']['model'], 'gpt-5.4-mini')
            self.assertEqual(sent['auth'], 'Bearer k-openai')
            self.assertEqual(keyprobe.bot_env(dict(ENV, OTHER='x'), 'openai', ENV), {'OTHER': 'x'})
            self.assertIsNone(keyprobe.select(ENV, probe_fn=lambda k: {'ok': True})['chosen'], 'sans cle OpenAI')
        finally:
            keyprobe.MODEL = old

    def test_prompt_without_reasoning(self):
        sent, urlopen = self.reply()
        result = keyprobe.probe('k-1', urlopen, model='deepseek-v4.1-flash')
        self.assertTrue(result['ok'])
        self.assertTrue(sent['url'].endswith('/v1/chat/completions'))
        self.assertEqual(sent['body']['model'], 'deepseek-v4.1-flash')
        self.assertEqual(sent['body']['thinking'], {'type': 'disabled'})
        self.assertEqual(sent['body']['messages'][0]['content'], "Pas de réflexion, répond uniquement 'test validé'")
        self.assertEqual(sent['auth'], 'Bearer k-1')
        self.assertNotIn('k-1', json.dumps(result))

    def test_refused_or_wrong_answer(self):
        result = keyprobe.probe('k-1', self.reply(status=401)[1])
        self.assertFalse(result['ok'])
        self.assertEqual(result['status'], 401)
        self.assertIn('Invalid credential', result['error'])
        self.assertFalse(keyprobe.probe('k-1', self.reply(content='')[1])['ok'])

    def test_key_never_echoed(self):
        result = keyprobe.probe('k-1', self.reply(content='test valide k-1')[1])
        self.assertNotIn('k-1', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
