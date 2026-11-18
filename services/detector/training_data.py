"""Train an isolated RGB image-pair keypoint prototype on real capture targets.

This is an offline experiment only. It does not load camera calibration into the
model, modify detector defaults, or emit board events.
"""
import argparse
from collections import OrderedDict
import hashlib
import json
import math
import os
from pathlib import Path
import random
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TARGETS = ROOT / 'build/real-keypoints-v1/targets.json'
DEFAULT_OUTPUT = ROOT / 'build/real-keypoint-model'
WIDTH, HEIGHT = 640, 360
RAW_WIDTH, RAW_HEIGHT = 1280, 720
HEAT_W, HEAT_H = 320, 180
RAW_PER_HEAT_X, RAW_PER_HEAT_Y = RAW_WIDTH / HEAT_W, RAW_HEIGHT / HEAT_H
ARCH = 'pair-heatmap-skip-8-16-32-v2'


def sha256(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def verify_source_images(samples):
    expected = {}
    for row in samples:
        for path_key, hash_key in (('imagePath', 'imageSHA256'),
                                   ('previousFrameImagePath', 'previousFrameImageSHA256'),
                                   ('baselineImagePath', 'baselineImageSHA256')):
            if not row.get(path_key):
                continue
            path = resolve_path(row[path_key])
            expected[str(path.resolve())] = row.get(hash_key)
    manifest = []
    for name, expected_hash in sorted(expected.items()):
        actual = sha256(name)
        if expected_hash and actual != expected_hash:
            raise ValueError(f'source image hash mismatch: {name}')
        manifest.append({'path': str(Path(name).relative_to(ROOT)) if Path(name).is_relative_to(ROOT) else name,
                         'sha256': actual})
    encoded = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(encoded).hexdigest(), len(manifest)


def torch_modules():
    try:
        import torch
        from PIL import Image, ImageDraw
    except ImportError as exc:
        raise RuntimeError('training environment needs CPU PyTorch and Pillow') from exc
    return torch, Image, ImageDraw


def load_samples(path, allow_retrospective):
    data = json.loads(path.read_text())
    samples = data.get('samples')
    if not isinstance(samples, list):
        raise ValueError('targets file must contain samples[]')
    retrospective = bool(data.get('allowRetrospectiveCalibration'))
    if retrospective and not allow_retrospective:
        raise ValueError('retrospective targets require explicit --allow-retrospective-labels')
    if not retrospective and allow_retrospective:
        raise ValueError('flag requested but dataset is not marked as retrospective')
    usable = []
    excluded_out_of_view = 0
    for row in samples:
        if row.get('targetType') != 'board-plane-impact-point':
            continue
        if not row.get('inView'):
            excluded_out_of_view += 1
            continue
        if not row.get('imagePath') or not row.get('previousFrameImagePath'):
            raise ValueError(f"{row.get('sampleId')}: current and previous-frame paths required")
        target = row.get('targetPixel') or {}
        if not all(type(target.get(k)) in (int, float) and math.isfinite(target[k]) for k in ('x', 'y')):
            raise ValueError(f"{row.get('sampleId')}: invalid target coordinates")
        usable.append(dict(row, isPositive=True,
                           referenceImagePath=row['previousFrameImagePath'],
                           referenceImageSHA256=row.get('previousFrameImageSHA256')))
    if not usable:
        raise ValueError('no in-view positive samples')
    data['_totalTargetSamples'] = len(samples)
    data['_excludedOutOfViewSamples'] = excluded_out_of_view
    return data, usable


class ImageCache:
    """Bounded LRU of resized RGB arrays; PIL images are not retained."""
    def __init__(self, Image, capacity=240):
        self.Image, self.capacity = Image, capacity
        self.values = OrderedDict()

    def get(self, path):
        path = Path(path)
        key = str(path.resolve())
        if key in self.values:
            self.values.move_to_end(key)
            return self.values[key]
        image = self.Image.open(path).convert('RGB').resize((WIDTH, HEIGHT), self.Image.Resampling.BILINEAR)
        value = bytearray(image.tobytes())
        self.values[key] = value
        if len(self.values) > self.capacity:
            self.values.popitem(last=False)
        return value


def resolve_path(value):
    p = Path(value)
    return p if p.is_absolute() else ROOT / p


def add_synthetic_negatives(samples):
    """Pair each captured empty baseline with itself; this is not a new real visit."""
    result = list(samples)
    for row in samples:
        baseline = row.get('baselineImagePath')
        if not baseline:
            raise ValueError(f"{row.get('sampleId')}: baselineImagePath needed for synthetic negatives")
        result.append({**row, 'sampleId': row['sampleId'] + ':synthetic-empty-pair',
                       'imagePath': baseline, 'imageSHA256': row.get('baselineImageSHA256'),
                       'referenceImagePath': baseline,
                       'referenceImageSHA256': row.get('baselineImageSHA256'),
                       'targetPixel': None, 'isPositive': False,
                       'negativeConstruction': 'same captured empty baseline image supplied as current and reference'})
    return result


def model_class(torch):
    nn = torch.nn
    class PairHeatmap(nn.Module):
        def __init__(self):
            super().__init__()
            self.encoder = nn.Sequential(
                nn.Conv2d(6, 8, 5, stride=2, padding=2), nn.ReLU(inplace=True),
                nn.Conv2d(8, 16, 3, stride=2, padding=1), nn.ReLU(inplace=True),
                nn.Conv2d(16, 32, 3, stride=2, padding=1), nn.ReLU(inplace=True),
                nn.Conv2d(32, 32, 3, padding=1), nn.ReLU(inplace=True))
            self.decode2 = nn.Sequential(nn.Conv2d(48, 16, 3, padding=1), nn.ReLU(inplace=True))
            self.decode1 = nn.Sequential(nn.Conv2d(24, 8, 3, padding=1), nn.ReLU(inplace=True))
            self.heatmap = nn.Conv2d(8, 1, 1)
            self.presence = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Linear(32, 1))

        def forward(self, value):
            x1 = self.encoder[1](self.encoder[0](value))
            x2 = self.encoder[3](self.encoder[2](x1))
            x3 = self.encoder[5](self.encoder[4](x2))
            features = self.encoder[7](self.encoder[6](x3))
            presence = self.presence(features)[:, 0]
            features = torch.nn.functional.interpolate(features, size=x2.shape[-2:], mode='bilinear', align_corners=False)
            features = self.decode2(torch.cat((features, x2), dim=1))
            features = torch.nn.functional.interpolate(features, size=x1.shape[-2:], mode='bilinear', align_corners=False)
            features = self.decode1(torch.cat((features, x1), dim=1))
            return self.heatmap(features).flatten(1), presence
    return PairHeatmap


def tensor_pair(torch, cache, row):
    import numpy as np
    current = np.frombuffer(cache.get(resolve_path(row['imagePath'])), dtype=np.uint8).copy()
    reference = np.frombuffer(cache.get(resolve_path(row['referenceImagePath'])), dtype=np.uint8).copy()
    current = torch.from_numpy(current.reshape(HEIGHT, WIDTH, 3)).permute(2, 0, 1)
    reference = torch.from_numpy(reference.reshape(HEIGHT, WIDTH, 3)).permute(2, 0, 1)
    return torch.cat((current, reference), dim=0).float().div_(255.0)


def gaussian_target(torch, x, y, sigma=1.5):
    xx = torch.arange(HEAT_W, dtype=torch.float32)
    yy = torch.arange(HEAT_H, dtype=torch.float32)
    grid_y, grid_x = torch.meshgrid(yy, xx, indexing='ij')
    target_x = (x + 0.5) / RAW_PER_HEAT_X - 0.5
    target_y = (y + 0.5) / RAW_PER_HEAT_Y - 0.5
    target = torch.exp(-((grid_x-target_x)**2 + (grid_y-target_y)**2)/(2*sigma*sigma))
    return target.flatten() / target.sum().clamp_min(1e-12)


def predict_xy(torch, logits):
    probability = torch.softmax(logits.float(), dim=1)
    xs = (torch.arange(HEAT_W, device=logits.device, dtype=torch.float32) + 0.5) * RAW_PER_HEAT_X - 0.5
    ys = (torch.arange(HEAT_H, device=logits.device, dtype=torch.float32) + 0.5) * RAW_PER_HEAT_Y - 0.5
    grid_y, grid_x = torch.meshgrid(ys, xs, indexing='ij')
    x = (probability * grid_x.flatten()[None, :]).sum(1)
    y = (probability * grid_y.flatten()[None, :]).sum(1)
    return torch.stack((x, y), dim=1), probability


def score_rows(torch, model, rows, cache, device):
    model.eval()
    predictions = []
    with torch.no_grad():
        for row in rows:
            pair = tensor_pair(torch, cache, row).unsqueeze(0).to(device)
            heat, presence = model(pair)
            xy, probability = predict_xy(torch, heat)
            predictions.append({'row': row, 'prediction': [float(v) for v in xy[0].cpu()],
                                'presenceProbability': float(torch.sigmoid(presence[0]).cpu()),
                                'peakProbability': float(probability.max().cpu())})
    return predictions


def errors(predictions, positives):
    rows = [p for p in predictions if p['row']['isPositive']]
    errors = [math.dist(p['prediction'], (p['row']['targetPixel']['x'], p['row']['targetPixel']['y'])) for p in rows]
    if not errors:
        return {'count': 0, 'medianPx': None, 'p90Px': None}
    ordered = sorted(errors)
    return {'count': len(errors), 'medianPx': ordered[len(ordered)//2],
            'p90Px': ordered[min(len(ordered)-1, math.ceil(.9*len(ordered))-1)]}


def baseline_metrics(rows, development_rows):
    positive = [r for r in rows if r['isPositive']]
    development = [r for r in development_rows if r['isPositive']]
    by_camera = {}
    for r in development:
        by_camera.setdefault(str(r['camera']), []).append(r['targetPixel'])
    means = {camera: [sum(p['x'] for p in points)/len(points), sum(p['y'] for p in points)/len(points)]
             for camera, points in by_camera.items()}
    def measure(predictor):
        es = [math.dist(predictor(r), (r['targetPixel']['x'], r['targetPixel']['y'])) for r in positive]
        es.sort()
        if not es: return {'count': 0, 'medianPx': None, 'p90Px': None}
        return {'count': len(es), 'medianPx': es[len(es)//2], 'p90Px': es[min(len(es)-1, math.ceil(.9*len(es))-1)]}
    return {'imageCenter': measure(lambda r: [640, 360]),
            'developmentMeanByCamera': measure(lambda r: means[str(r['camera'])]),
            'developmentMeansRawPx': means}


def validate_split_isolation(samples):
    capture_split, baseline_split, image_split = {}, {}, {}
    for row in samples:
        split = row['split']
        capture = row.get('captureId')
        if capture in capture_split and capture_split[capture] != split:
            raise ValueError(f'capture split leakage: {capture}')
        capture_split[capture] = split
        baseline = row.get('baselineId')
        if baseline in baseline_split and baseline_split[baseline] != split:
            raise ValueError(f'baseline visit crosses splits: {baseline}')
        baseline_split[baseline] = split
        for key in ('imageSHA256', 'previousFrameImageSHA256', 'baselineImageSHA256'):
            digest = row.get(key)
            if not digest:
                continue
            if digest in image_split and image_split[digest] != split:
                raise ValueError(f'image SHA-256 occurs in multiple splits: {digest}')
            image_split[digest] = split


def save_training_state(torch, path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix='.training-state-', suffix='.pt', dir=path.parent)
    os.close(fd)
    try:
        torch.save(state, temp_name)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name): os.unlink(temp_name)


def save_overlays(Image, ImageDraw, predictions, output, limit=24):
    folder = output / 'overlays'; folder.mkdir(parents=True, exist_ok=True)
    for item in [p for p in predictions if p['row']['isPositive']][:limit]:
        row = item['row']; path = resolve_path(row['imagePath'])
        image = Image.open(path).convert('RGB')
        draw = ImageDraw.Draw(image)
        px, py = item['prediction']
        tx, ty = row['targetPixel']['x'], row['targetPixel']['y']
        for x, y, color, radius in ((px, py, 'cyan', 10), (tx, ty, 'yellow', 7)):
            draw.ellipse((x-radius, y-radius, x+radius, y+radius), outline=color, width=3)
        draw.text((12, 12), f"prediction cyan; target yellow; camera {row['camera']}", fill='white', stroke_width=2, stroke_fill='black')
        image.save(folder / f"{row['sampleId'].replace(':', '-')}.jpg", quality=88)


