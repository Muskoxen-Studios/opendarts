"""Three independently selected camera streams for the perspective detector."""
import json
from pathlib import Path

from rendered import CAMERAS, RenderedSource
from sources import read_pgm


class CameraSource:
    def __init__(self, configuration, devices=None, mock=None, cv2_module=None, width=640, height=480):
        path = Path(configuration)
        self.config_path = path
        self.width, self.height = width, height
        self.calibrations, self.reference = {}, {}
        self.queue = []
        if path.exists():
            rig = RenderedSource.configured(json.loads(path.read_text()))
            self.width, self.height = rig.width, rig.height
            self.calibrations, self.reference = rig.calibrations, rig.reference
        self.queue = []  # reset discards queued frames for all perspective sources
        self.devices = []
        self.mock = None
        self.rgb = {}
        if mock:
            manifest = Path(mock)
            data = json.loads(manifest.read_text())
            if not isinstance(data, list) or not data:
                raise ValueError('mock camera manifest must be a nonempty list of frame maps')
            self.mock = []
            for batch in data:
                if set(batch) != set(CAMERAS):
                    raise ValueError('mock frame must contain cam0, cam1 and cam2')
                self.mock.append({k: read_pgm(manifest.parent / batch[k], self.width, self.height) for k in CAMERAS})
            self.index = 0
            return
        if not devices or len(devices) != 3 or len(set(devices)) != 3:
            raise ValueError('three distinct camera device paths are required')
        if cv2_module is None:
            try:
                import cv2 as cv2_module
            except ImportError as exc:
                raise ValueError('USB capture requires OpenCV in the detector Python environment; see the desktop setup guide') from exc
        self.cv2 = cv2_module
        try:
            for device in devices:
                camera = self.cv2.VideoCapture(int(device) if device.isdecimal() else device)
                self.devices.append(camera)
                if not camera.isOpened():
                    raise ValueError(f'cannot open camera {device}')
                camera.set(self.cv2.CAP_PROP_FRAME_WIDTH, self.width)
                camera.set(self.cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        except Exception:
            self.close()
            raise

    def capture(self):
        if self.mock is not None:
            frame = self.mock[min(self.index, len(self.mock)-1)]
            self.index += 1
            self.rgb = {}
            for k, data in frame.items():
                rgb = bytearray(len(data)*3)
                rgb[0::3] = rgb[1::3] = rgb[2::3] = data
                self.rgb[k] = bytes(rgb)
            return frame
        # Grab all views before decoding to reduce skew between cameras.
        if not all(camera.grab() for camera in self.devices):
            raise ValueError('camera acquisition failed')
        images = {}
        rgb_images = {}
        for key, camera in zip(CAMERAS, self.devices):
            ok, frame = camera.retrieve()
            if not ok or frame is None:
                raise ValueError(f'{key}: camera frame unavailable')
            if frame.shape[:2] != (self.height, self.width):
                raise ValueError(f'{key}: camera resolution does not match calibration')
            if len(frame.shape) != 3 or frame.shape[2] != 3:
                raise ValueError(f'{key}: camera must provide three-channel BGR images')
            rgb_images[key] = self.cv2.cvtColor(frame, self.cv2.COLOR_BGR2RGB).tobytes()
            images[key] = self.cv2.cvtColor(frame, self.cv2.COLOR_BGR2GRAY).tobytes()
        self.rgb = rgb_images
        return images

    def close(self):
        for camera in self.devices:
            camera.release()
        self.devices = []
