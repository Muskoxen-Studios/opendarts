import http.client
import json
import math
import tempfile
import threading
import unittest
from pathlib import Path

from calibration import BOARD_POINTS, estimate, estimate_automatic
from main import Server, Service
from rendered import CAMERAS, RenderedSource, project
from test_rendered import configuration
from camera_source import CameraSource


def landmarks():
    rig = RenderedSource.configured(configuration())
    return {k: [list(project(rig.calibrations[k], (*p, 0))) for p in BOARD_POINTS] for k in CAMERAS}


class CalibrationTests(unittest.TestCase):
    def test_pose_recovers_independent_projected_board(self):
        points = landmarks()['cam0']
        camera, error = estimate(points, 640, 480, math.degrees(2*math.atan(640/800)))
        self.assertLess(error, 1e-6)
        # Check an off-plane point too: the shaft direction depends on pose.
        expected = RenderedSource.configured(configuration()).calibrations['cam0']
        self.assertLess(math.dist(project(camera, (10, 20, 70)), project(expected, (10, 20, 70))), 1e-6)

    def test_automatic_fov_and_imperfect_landmarks(self):
        points = landmarks()["cam0"]
        camera, error = estimate_automatic(points, 640, 480)
        self.assertLess(error, 0.01)
        self.assertAlmostEqual(camera["K"][0], 400, delta=0.1)
        points[1][0] += 35
        _, error = estimate_automatic(points, 640, 480)
        self.assertGreater(error, 8)

    def test_degenerate_landmarks_rejected(self):
        with self.assertRaises(ValueError):
            estimate([[320, 240]]*9, 640, 480, 77)

    def test_first_time_mock_calibration_and_rearm(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            frames = {}
            for key in CAMERAS:
                name = key + '.pgm'
                (root / name).write_bytes(b'P5\n640 480\n255\n' + bytes([180])*(640*480))
                frames[key] = name
            (root / 'frames.json').write_text(json.dumps([frames]))
            source = CameraSource(root / 'rig.json', mock=root / 'frames.json')
            service = Service(source)
            service.tick()
            self.assertFalse(service.running)
            self.assertEqual(service.status, 'Setup')
            with self.assertRaisesRegex(ValueError, 'calibration required'):
                service.control('start')
            server = Server(('127.0.0.1', 0), service)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
            def post(path, body):
                connection.request('POST', path, json.dumps(body), {'Content-Type': 'application/json'})
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            try:
                status, frozen = post('/calibration/freeze', {})
                self.assertEqual(status, 200)
                body = {'token': frozen['token'], 'landmarks': landmarks()}
                status, result = post('/calibration/apply', body)
                self.assertEqual(status, 200, result)
                self.assertTrue((root / 'rig.json').exists())
                self.assertFalse(service.running)
                self.assertEqual(post('/calibration/apply', body)[0], 400)
                service.control('start')
                service.tick()
                self.assertTrue(service.running)
            finally:
                connection.close()
                server.shutdown()
                worker.join()
                server.server_close()
                service.close()
