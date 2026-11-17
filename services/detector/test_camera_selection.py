import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from main import Service
from rendered import RenderedSource


class FakeCamera:
    def __init__(self, config, devices, width, height):
        self.config_path = config
        self.width, self.height = width, height
        self.calibrations, self.reference, self.queue = {}, {}, []
        self.rgb = {}
        self.closed = False
        self.devices = devices
    def close(self): self.closed = True


class FakeModel:
    sha256 = 'test'
    def __init__(self, path): self.path = path


class CameraSelectionTests(unittest.TestCase):
    def test_connect_persists_selection_and_disconnect_clears_it(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'rig.json'
            service = Service(RenderedSource(), camera_config=config, model_path='model')
            service.control('stop')
            with patch('main.CameraSource', FakeCamera), patch('main.LiveModel', FakeModel), \
                 patch.object(service, 'camera_devices', return_value=['a', 'b', 'c', 'd']):
                service.connect_cameras(['a', 'b', 'c'])
                self.assertEqual(service.snapshot()['source'], 'usb')
                self.assertEqual(json.loads((Path(directory) / 'rig-selection.json').read_text()), {'devices': ['a', 'b', 'c']})
                first_path = service.source.config_path
                service.disconnect_cameras()
                self.assertFalse((Path(directory) / 'rig-selection.json').exists())
                service.connect_cameras(['b', 'a', 'c'])
                self.assertNotEqual(first_path, service.source.config_path)
                service.disconnect_cameras()
            service.close()

    def test_refuses_active_or_invalid_camera_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            service = Service(RenderedSource(), camera_config=Path(directory) / 'rig.json', model_path='model')
            with patch.object(service, 'camera_devices', return_value=['a', 'b', 'c']):
                with self.assertRaisesRegex(ValueError, 'stop detection'):
                    service.connect_cameras(['a', 'b', 'c'])
                service.control('stop')
                with self.assertRaisesRegex(ValueError, 'distinct available'):
                    service.connect_cameras(['a', 'a', 'c'])
            service.close()


if __name__ == '__main__': unittest.main()
