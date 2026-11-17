import json
import tempfile
import unittest
from pathlib import Path

from live_model import board_point
from main import Service
from rendered import CAMERAS, RenderedSource, project
from test_rendered import configuration
from camera_source import CameraSource


class StubModel:
    sha256 = 'test'
    def __init__(self, results): self.results = results
    def infer(self, current, reference, width, height):
        if not current or not reference:
            raise ValueError('missing frame')
        return self.results


class LiveModelTests(unittest.TestCase):
    def test_ray_round_trip(self):
        rig = RenderedSource.configured(configuration())
        for camera in rig.calibrations.values():
            xy = board_point(camera, project(camera, (10, 60, 0)))
            self.assertAlmostEqual(xy[0], 10)
            self.assertAlmostEqual(xy[1], 60)

    def test_scores_only_when_all_views_accept_and_agree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'rig.json').write_text(json.dumps(configuration()))
            frames = {}
            for k in CAMERAS:
                name = k + '.pgm'
                (root / name).write_bytes(b'P5\n640 480\n255\n' + bytes([180])*(640*480))
                frames[k] = name
            (root / 'frames.json').write_text(json.dumps([frames]))
            source = CameraSource(root / 'rig.json', mock=root / 'frames.json')
            source.capture()
            rig = RenderedSource.configured(configuration())
            result = {k: {'probability': .9, 'pixel': project(rig.calibrations[k], (0, 60, 0))} for k in CAMERAS}
            service = Service(source, live_model=StubModel(result))
            service.rgb_accepted = dict(source.rgb)
            result['cam1']['probability'] = .1
            with self.assertRaisesRegex(ValueError, 'presence below'):
                service.transition([(0, 60)])
            self.assertFalse(any(event['type'] == 'throw.detected' for _, event in service.history))
            result['cam1']['probability'] = .9
            result['cam1']['pixel'] = project(rig.calibrations['cam1'], (60, 0, 0))
            with self.assertRaisesRegex(ValueError, 'disagrees'):
                service.transition([(0, 60)])
            result['cam1']['pixel'] = project(rig.calibrations['cam1'], (0, 60, 0))
            service.transition([(0, 60)])
            self.assertEqual(sum(event['type'] == 'throw.detected' for _, event in service.history), 1)
            service.close()
