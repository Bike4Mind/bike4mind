import json
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_selfhost_chunk_pipeline as v  # noqa: E402


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class PollTests(unittest.TestCase):
    def test_returns_first_satisfying_value(self):
        clock = FakeClock()
        values = iter([0, 1, 2, 3])
        result = v.poll(lambda: next(values), lambda n: n >= 2, 100, 1, clock.clock, clock.sleep)
        self.assertEqual(result, 2)
        self.assertEqual(clock.now, 2)

    def test_timeout_names_last_state(self):
        clock = FakeClock()
        with self.assertRaises(v.Timeout) as caught:
            v.poll(lambda: {'chunks': 0}, lambda s: False, 5, 1, clock.clock, clock.sleep, what='chunks')
        self.assertIn("{'chunks': 0}", str(caught.exception))
        self.assertIn('chunks', str(caught.exception))


class ChunkStateTests(unittest.TestCase):
    def test_accepts_fully_embedded(self):
        self.assertTrue(v.chunk_state_ok({'chunks': 3, 'embedded': 3, 'models': ['m']}))

    def test_rejects_zero_chunks(self):
        self.assertFalse(v.chunk_state_ok({'chunks': 0, 'embedded': 0, 'models': []}))

    def test_rejects_partially_embedded(self):
        self.assertFalse(v.chunk_state_ok({'chunks': 3, 'embedded': 2, 'models': ['m']}))

    def test_rejects_mixed_models(self):
        self.assertFalse(v.chunk_state_ok({'chunks': 3, 'embedded': 3, 'models': ['a', 'b']}))


class SearchHitTests(unittest.TestCase):
    def test_finds_file(self):
        self.assertTrue(v.search_hit({'results': [{'file_id': 'x'}, {'file_id': 'f1'}]}, 'f1'))

    def test_false_on_empty_or_other_files(self):
        self.assertFalse(v.search_hit({'results': []}, 'f1'))
        self.assertFalse(v.search_hit({'results': [{'file_id': 'x'}]}, 'f1'))
        self.assertFalse(v.search_hit(None, 'f1'))

    def test_coerces_non_string_file_id(self):
        self.assertTrue(v.search_hit({'results': [{'file_id': 123}]}, '123'))


class ReplayVerdictTests(unittest.TestCase):
    def test_equal_passes(self):
        self.assertTrue(v.replay_verdict(4, 4)[0])

    def test_growth_fails_with_delta(self):
        ok, message = v.replay_verdict(4, 7)
        self.assertFalse(ok)
        self.assertIn('+3', message)
        self.assertIn('duplicated', message)

    def test_shrink_fails(self):
        ok, message = v.replay_verdict(4, 2)
        self.assertFalse(ok)
        self.assertIn('replay lost chunks', message)


class CountsMatchTests(unittest.TestCase):
    def test_requires_equal_and_nonzero(self):
        self.assertTrue(v.counts_match(3, 3))
        self.assertFalse(v.counts_match(3, 4))
        self.assertFalse(v.counts_match(0, 0))


class ParseMongoshTests(unittest.TestCase):
    def test_parses_last_line(self):
        self.assertEqual(v.parse_mongosh_json('{"a": 1}\n'), {'a': 1})

    def test_ignores_leading_noise_lines(self):
        self.assertEqual(v.parse_mongosh_json('warning\n{"a": 1}\n'), {'a': 1})

    def test_raises_on_non_json(self):
        with self.assertRaises(ValueError):
            v.parse_mongosh_json('MongoServerError: boom')

    def test_raises_on_empty(self):
        with self.assertRaises(AssertionError):
            v.parse_mongosh_json('  \n')


class SqsParamsTests(unittest.TestCase):
    def test_body_is_json_payload(self):
        params = v.sqs_send_params('http://q/queue/x', {'fabFileId': 'f', 'userId': 'u'})
        self.assertEqual(params['Action'], 'SendMessage')
        self.assertEqual(params['QueueUrl'], 'http://q/queue/x')
        self.assertEqual(json.loads(params['MessageBody']), {'fabFileId': 'f', 'userId': 'u'})


class EnvTests(unittest.TestCase):
    def test_parse_env(self):
        env = v.parse_env('# c\n\nA=1\nB="two"\nC = x=y \nnoequals\n')
        self.assertEqual(env, {'A': '1', 'B': 'two', 'C': 'x=y'})

    def test_db_name_from_uri(self):
        self.assertEqual(v.db_name_from_uri('mongodb://mongo:27017/custom?replicaSet=rs0'), 'custom')
        self.assertEqual(v.db_name_from_uri('mongodb://mongo:27017/?replicaSet=rs0'), 'bike4mind')
        self.assertEqual(v.db_name_from_uri(None), 'bike4mind')

    def test_setting_on(self):
        self.assertTrue(v.setting_on(None, True))
        self.assertFalse(v.setting_on(None, False))
        self.assertFalse(v.setting_on(False, True))
        self.assertTrue(v.setting_on(True, False))
        self.assertTrue(v.setting_on('true', False))


class SentinelTests(unittest.TestCase):
    def test_equal_length_bodies(self):
        a, b = v.new_sentinel(), v.new_sentinel()
        self.assertNotEqual(a, b)
        self.assertEqual(len(v.sentinel_text(a)), len(v.sentinel_text(b)))


class ReplaySettledTests(unittest.TestCase):
    def state(self, **kw):
        return {'isChunking': False, 'claimedAt': 200, 'ids': ['a', 'b'], **kw}

    def test_first_poll_never_settles(self):
        self.assertFalse(v.replay_settled(100, None, self.state()))

    def test_settles_when_claim_advanced_and_ids_stable(self):
        self.assertTrue(v.replay_settled(100, ['a', 'b'], self.state()))
        self.assertTrue(v.replay_settled(None, ['a', 'b'], self.state()))

    def test_unadvanced_claim_does_not_settle(self):
        self.assertFalse(v.replay_settled(200, ['a', 'b'], self.state()))
        self.assertFalse(v.replay_settled(100, ['a', 'b'], self.state(claimedAt=None)))

    def test_changed_ids_or_busy_does_not_settle(self):
        self.assertFalse(v.replay_settled(100, ['a'], self.state()))
        self.assertFalse(v.replay_settled(100, ['a', 'b'], self.state(isChunking=True)))

    def test_zero_ids_settle_and_verdict_catches_them(self):
        self.assertTrue(v.replay_settled(100, [], self.state(ids=[])))
        self.assertFalse(v.replay_verdict(4, 0)[0])


class SearchPacingTests(unittest.TestCase):
    def test_interval_under_rate_limit(self):
        self.assertGreaterEqual(v.SEARCH_POLL_INTERVAL, 6)


class MainSetupFailureTests(unittest.TestCase):
    def test_lake_creation_failure_is_a_fail_line_not_a_traceback(self):
        stack = mock.Mock()
        stack.create_lake.side_effect = AssertionError('POST /api/data-lakes -> 403: FEATURE_DISABLED')
        with mock.patch.dict('os.environ', {'B4M_API_KEY': 'k'}), \
                mock.patch.object(v, 'load_env', return_value={}), \
                mock.patch.object(v, 'setting_value', return_value=True), \
                mock.patch.object(v, 'Stack', return_value=stack), \
                mock.patch.object(v, 'Run') as run_cls, \
                mock.patch('builtins.print') as printed:
            code = v.main([])
        self.assertEqual(code, 1)
        self.assertTrue(any(str(c.args[0]).startswith('FAIL setup:') for c in printed.call_args_list))
        run_cls.return_value.cleanup.assert_called_once_with(None)

    def test_data_lakes_off_exits_with_message(self):
        values = {'enableAutoChunk': None, 'EnableDataLakes': None}
        with mock.patch.dict('os.environ', {'B4M_API_KEY': 'k'}), \
                mock.patch.object(v, 'load_env', return_value={}), \
                mock.patch.object(v, 'setting_value', side_effect=values.get):
            with self.assertRaises(SystemExit) as caught:
                v.main([])
        self.assertIn('Enable Data Lakes', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
