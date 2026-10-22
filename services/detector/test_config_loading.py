import contextlib
import gzip
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from main import Service, main
from parameters import DEFAULT_PARAMETERS, DetectionParameters
from rendered import RenderedSource


class ConfigLoadingTests(unittest.TestCase):
    def run_cli(self, args):
        server = Mock()
        server.serve_forever.side_effect = KeyboardInterrupt
        with (patch('sys.argv', ['main.py', *args]),
              patch('main.Server', return_value=server) as factory,
              patch.object(Service, 'start_worker'),
              contextlib.redirect_stdout(io.StringIO())):
            main()
        return factory.call_args.args[1]

    def assert_startup_error(self, args, message):
        stderr = io.StringIO()
        with (patch('sys.argv', ['main.py', *args]),
              patch('main.Server') as server,
              patch('main.RenderedSource') as source,
              contextlib.redirect_stderr(stderr),
              self.assertRaises(SystemExit) as error):
            main()
        self.assertEqual(error.exception.code, 2)
        self.assertIn(message, stderr.getvalue())
        server.assert_not_called()
        source.assert_not_called()

    def test_explicit_plain_parameters_survive_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'params.json'
            path.write_text(json.dumps({'blob_threshold_gray': 42}))
            service = self.run_cli(['--source', 'rendered', '--parameters', str(path)])
        expected = DetectionParameters(blob_threshold_gray=42)
        self.assertEqual(service.detector.parameters, expected)
        with gzip.open(Path(__file__).with_name('fixtures') / 'configuration.json.gz', 'rt') as file:
            configuration = json.load(file)
        for _ in range(2):
            service.configure_rendered(configuration)
            self.assertIs(service.detector.parameters, service.parameters)
            self.assertEqual(service.detector.parameters, expected)

    def test_no_implicit_tuning_load(self):
        with patch('main.Path.read_bytes', side_effect=AssertionError('implicit config read')):
            service = self.run_cli(['--source', 'rendered'])
        self.assertIs(service.detector.parameters, DEFAULT_PARAMETERS)
        self.assertIs(Service(RenderedSource()).detector.parameters, DEFAULT_PARAMETERS)

    def test_non_rendered_sources_reject_parameters(self):
        for source in ('synthetic', 'replay'):
            with self.subTest(source=source):
                self.assert_startup_error(['--source', source, '--parameters', 'missing.json'],
                                          '--parameters requires --source rendered')

    def test_missing_file_is_helpful_startup_error(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'missing.json')
            self.assert_startup_error(['--source', 'rendered', '--parameters', path],
                                      'cannot load --parameters')

    def test_invalid_json_and_parameters_fail_before_startup(self):
        cases = [
            ('{', 'Expecting'),
            ('[]', 'must be an object'),
            ('{"unknown": 1}', 'unknown detection parameter fields'),
            ('{"blob_threshold_gray": 0}', 'blob_threshold_gray must be in'),
            ('{"blob_threshold_gray": true}', 'must be a finite integer'),
            ('{"blob_threshold_gray": 24.0}', 'must be a finite integer'),
            ('{"max_changed_fraction": NaN}', 'non-finite JSON number'),
            ('{"max_changed_fraction": Infinity}', 'non-finite JSON number'),
            ('{"max_changed_fraction": 1e999}', 'max_changed_fraction must be in'),
            ('{"blob_threshold_gray": 24, "blob_threshold_gray": 25}', 'duplicate JSON key'),
            ('{"selected": {"parameters": {}}}', 'unknown detection parameter fields'),
            ('{"trial": 0, "parameters": {}, "validation": {}}', 'unknown detection parameter fields'),
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'params.json'
            for payload, message in cases:
                with self.subTest(payload=payload):
                    path.write_text(payload)
                    self.assert_startup_error(['--source', 'rendered', '--parameters', str(path)], message)
            path.write_bytes(b'\xff')
            self.assert_startup_error(['--source', 'rendered', '--parameters', str(path)],
                                      'cannot load --parameters')


if __name__ == '__main__':
    unittest.main()
