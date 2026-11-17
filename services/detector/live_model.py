"""Live RGB pair inference using the retained v6 presence/keypoint checkpoint."""
import hashlib
import math
from pathlib import Path

from rendered import CAMERAS


class LiveModel:
    def __init__(self, path):
        try:
            import torch
            import numpy as np
            from PIL import Image
        except ImportError as exc:
            raise ValueError('v6 inference requires PyTorch, NumPy and Pillow in the detector Python environment; see the desktop setup guide') from exc
        from model_v6 import model_class
        self.torch, self.np, self.Image = torch, np, Image
        path = Path(path)
        self.sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
        with torch.serialization.safe_globals([torch.torch_version.TorchVersion]):
            checkpoint = torch.load(path, map_location='cpu', weights_only=True)
        self.model = model_class(torch)()
        self.model.load_state_dict(checkpoint['state_dict'], strict=True)
        self.model.eval()
        torch.set_num_threads(2)

    def infer(self, current, reference, width, height):
        if (width, height) != (1280, 720):
            raise ValueError('v6 requires 1280×720 camera frames, matching training')
        if set(current) != set(CAMERAS) or set(reference) != set(CAMERAS):
            raise ValueError('v6 requires current and previous RGB frames from all cameras')
        inputs = []
        for key in CAMERAS:
            pair = []
            for image in (current[key], reference[key]):
                if len(image) != width*height*3:
                    raise ValueError(f'{key}: invalid RGB frame')
                resized = self.Image.frombytes('RGB', (width, height), image).resize((640, 360), self.Image.Resampling.BILINEAR)
                pixels = self.np.array(resized, dtype=self.np.uint8, copy=True)
                pair.append(self.torch.from_numpy(pixels).permute(2, 0, 1))
            inputs.append(self.torch.cat(pair, 0).float().div_(255))
        with self.torch.no_grad():
            heat, logits = self.model(self.torch.stack(inputs))
            if not bool(self.torch.isfinite(heat).all() and self.torch.isfinite(logits).all()):
                raise ValueError('v6 inference returned non-finite values')
            probabilities = self.torch.sigmoid(logits).tolist()
            # Match the radius-4 local softmax decoder used in v6 evaluation.
            maps = heat.float().reshape(-1, 180, 320)
            coords = []
            for item in maps:
                peak = int(item.argmax())
                py, px = divmod(peak, 320)
                y0, y1 = max(0, py-4), min(180, py+5)
                x0, x1 = max(0, px-4), min(320, px+5)
                crop = item[y0:y1, x0:x1]
                weights = self.torch.softmax(crop.flatten(), 0).reshape(crop.shape)
                xs = self.torch.arange(x0, x1, dtype=weights.dtype)
                ys = self.torch.arange(y0, y1, dtype=weights.dtype)
                x = float((weights.sum(0)*xs).sum())
                y = float((weights.sum(1)*ys).sum())
                coords.append(((x+.5)*4-.5, (y+.5)*4-.5))
        if any(not math.isfinite(p) for p in probabilities):
            raise ValueError('v6 returned invalid presence probabilities')
        return {k: {'probability': p, 'pixel': xy} for k, p, xy in zip(CAMERAS, probabilities, coords)}


def board_point(calibration, pixel):
    """Intersect a pinhole pixel ray with the board plane in millimetres."""
    k, r, t = calibration['K'], calibration['R'], calibration['t']
    cy = (pixel[1]-k[5])/k[4]
    cx = (pixel[0]-k[2]-k[1]*cy)/k[0]
    direction = [sum(r[3*j+i]*v for j, v in enumerate((cx, cy, 1))) for i in range(3)]
    center = [-sum(r[3*j+i]*t[j] for j in range(3)) for i in range(3)]
    if abs(direction[2]) < 1e-8:
        raise ValueError('v6 pixel ray is parallel to the board')
    distance = -center[2]/direction[2]
    if distance <= 0:
        raise ValueError('v6 pixel ray points away from the board')
    return center[0]+distance*direction[0], center[1]+distance*direction[1]
