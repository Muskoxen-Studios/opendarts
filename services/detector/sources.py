"""Acquisition boundary: capture() returns only grayscale images keyed by camera ID."""

import importlib.util
import json
from pathlib import Path


def synthetic(cameras=3):
    path = Path(__file__).resolve().parents[2] / 'tools/camera-sim/rig.py'
    spec = importlib.util.spec_from_file_location('camera_rig', path)
    if spec is None or spec.loader is None:
        raise ImportError(f'cannot load synthetic camera rig: {path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.SyntheticRig(cameras)


def read_pgm(path, width, height):
    # Deliberately narrow, deterministic fixture format; HTTP previews are PNG.
    data = path.read_bytes()
    header = f'P5\n{width} {height}\n255\n'.encode()
    if not data.startswith(header) or len(data) != len(header) + width*height:
        raise ValueError(f'invalid PGM fixture: {path}')
    return data[len(header):]


class ReplaySource:
    def __init__(self, manifest):
        path = Path(manifest).resolve()
        config = json.loads(path.read_text())
        self.width, self.height = config['width'], config['height']
        self.calibrations = config['calibrations']
        self.reference = {k: read_pgm(path.parent / p, self.width, self.height)
                          for k, p in config['reference'].items()}
        self.frames = [{k: read_pgm(path.parent / p, self.width, self.height)
                        for k, p in frame.items()} for frame in config['frames']]
        if not self.frames:
            raise ValueError('replay must contain frames')
        self.index = 0

    def capture(self):
        frame = self.frames[min(self.index, len(self.frames)-1)]
        self.index += 1
        return frame
