import json
import tempfile
import unittest
from pathlib import Path

from test_rendered import configuration
from camera_source import CameraSource


class CameraSourceTests(unittest.TestCase):
    def test_mock_three_views_and_hold_last_frame(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = configuration()
            (root / 'rig.json').write_text(json.dumps(config))
            w, h = config['width'], config['height']
            frames = {}
            for i in range(3):
                name = f'{i}.pgm'
                (root / name).write_bytes(f'P5\n{w} {h}\n255\n'.encode() + bytes([i])*w*h)
                frames[f'cam{i}'] = name
            (root / 'frames.json').write_text(json.dumps([frames]))
            source = CameraSource(root / 'rig.json', mock=root / 'frames.json')
            self.assertEqual(source.capture()['cam2'], bytes([2])*w*h)
            self.assertEqual(source.capture()['cam0'], bytes(w*h))
            source.close()

    def test_requires_distinct_devices(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rig.json'
            path.write_text(json.dumps(configuration()))
            with self.assertRaisesRegex(ValueError, 'distinct'):
                CameraSource(path, devices=['a', 'a', 'b'])


if __name__ == '__main__':
    unittest.main()
