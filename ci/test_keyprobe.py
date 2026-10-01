"""Startup key choice (python3 -m unittest ci/test_keyprobe.py)."""
import io
import json
import os
import sys
import unittest
import urllib.error

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
            sent['auth'] = request.get_header('Authorization')
            if status != 200:
                raise urllib.error.HTTPError(request.full_url, status, 'x', {}, io.BytesIO(b'{"error":"Invalid credential"}'))
            r = Response(json.dumps({'choices': [{'message': {'content': content}}]}).encode())
            r.status = 200
            return r
        return sent, urlopen

    def test_prompt_without_reasoning(self):
        sent, urlopen = self.reply()
        result = keyprobe.probe('k-1', urlopen)
        self.assertTrue(result['ok'])
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
