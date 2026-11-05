import json
from pathlib import Path
import sys
import unittest

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


class ReplayVerdictTests(unittest.TestCase):
    def test_equal_passes(self):
        self.assertTrue(v.replay_verdict(4, 4)[0])

    def test_growth_fails_with_delta(self):
        ok, message = v.replay_verdict(4, 7)
        self.assertFalse(ok)
        self.assertIn('+3', message)
        self.assertIn('duplicated', message)

    def test_shrink_fails(self):
        self.assertFalse(v.replay_verdict(4, 2)[0])


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


if __name__ == '__main__':
    unittest.main()
