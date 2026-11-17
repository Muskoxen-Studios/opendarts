"""Validation-only trainer for real dart keypoints; never reads test images."""
import argparse
import hashlib
import json
import math
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
import training_data as base

DEFAULT_TARGETS = ROOT / 'build/real-keypoints-retrospective-v1/targets.json'
DEFAULT_OUTPUT = ROOT / 'build/real-keypoint-model-v3'


def require_finite(name, value):
    if not bool(value.isfinite().all()):
        raise FloatingPointError(f'non-finite {name}; stopping before optimizer update')


def model_class(torch):
    nn = torch.nn
    class PairNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.enc1 = nn.Sequential(nn.Conv2d(9, 16, 5, 2, 2), nn.ReLU(inplace=True), nn.Conv2d(16, 16, 3, padding=1), nn.ReLU(inplace=True))
            self.enc2 = nn.Sequential(nn.Conv2d(16, 32, 3, 2, 1), nn.ReLU(inplace=True))
            self.enc3 = nn.Sequential(nn.Conv2d(32, 48, 3, 2, 1), nn.ReLU(inplace=True), nn.Conv2d(48, 48, 3, padding=1), nn.ReLU(inplace=True))
            self.up2 = nn.Sequential(nn.Conv2d(80, 32, 3, padding=1), nn.ReLU(inplace=True))
            self.up1 = nn.Sequential(nn.Conv2d(48, 16, 3, padding=1), nn.ReLU(inplace=True))
            self.heat = nn.Conv2d(16, 1, 1)
            self.presenceFeatures = nn.Sequential(nn.Conv2d(48, 24, 1), nn.ReLU(inplace=True))
            self.presence = nn.Linear(48, 1)
        def forward(self, x):
            cur, ref = x[:, :3], x[:, 3:6]
            features = torch.cat((cur, ref, cur-ref), dim=1)
            a = self.enc1(features); b = self.enc2(a); c = self.enc3(b)
            # Shared spatial evidence keeps tiny localized changes visible to presence head.
            evidence = self.presenceFeatures(c)
            pooled = torch.cat((torch.nn.functional.adaptive_max_pool2d(evidence, 1).flatten(1),
                                torch.nn.functional.adaptive_avg_pool2d(evidence, 1).flatten(1)), 1)
            p = self.presence(pooled)[:, 0]
            d = self.up2(torch.cat((torch.nn.functional.interpolate(c, size=b.shape[-2:], mode='bilinear', align_corners=False), b), 1))
            d = self.up1(torch.cat((torch.nn.functional.interpolate(d, size=a.shape[-2:], mode='bilinear', align_corners=False), a), 1))
            return self.heat(d).flatten(1), p
    return PairNet


def negatives(samples):
    out = list(samples)
    for r in samples:
        for key, suffix in (('imagePath', 'current-self'), ('referenceImagePath', 'reference-self')):
            path = r[key]
            digest = r.get('imageSHA256') if key == 'imagePath' else r.get('referenceImageSHA256')
            out.append({**r, 'sampleId': r['sampleId'] + ':negative-' + suffix, 'imagePath': path,
                        'imageSHA256': digest, 'referenceImagePath': path, 'referenceImageSHA256': digest,
                        'targetPixel': None, 'isPositive': False,
                        'negativeConstruction': f'{suffix} same-image pair; not a real noisy empty visit'})
    return out


def pair_tensor(torch, cache, row):
    import numpy as np
    cur = torch.from_numpy(np.frombuffer(cache.get(base.resolve_path(row['imagePath'])), dtype=np.uint8).copy().reshape(base.HEIGHT, base.WIDTH, 3)).permute(2,0,1)
    ref = torch.from_numpy(np.frombuffer(cache.get(base.resolve_path(row['referenceImagePath'])), dtype=np.uint8).copy().reshape(base.HEIGHT, base.WIDTH, 3)).permute(2,0,1)
    return torch.cat((cur, ref), 0).float().div_(255)


def decode(torch, logits, radius=None):
    maps = logits.float().reshape(-1, base.HEAT_H, base.HEAT_W)
    peak = maps.flatten(1).argmax(1)
    ys, xs = peak // base.HEAT_W, peak % base.HEAT_W
    if radius is None:
        cells = torch.softmax(maps.flatten(1), dim=1).reshape_as(maps)
        yy, xx = torch.meshgrid(torch.arange(base.HEAT_H, device=maps.device), torch.arange(base.HEAT_W, device=maps.device), indexing='ij')
        x, y = (cells * xx).sum((1,2)), (cells * yy).sum((1,2))
    else:
        yy, xx = torch.meshgrid(torch.arange(base.HEAT_H, device=maps.device), torch.arange(base.HEAT_W, device=maps.device), indexing='ij')
        mask = ((xx[None]-xs[:,None,None]).abs() <= radius) & ((yy[None]-ys[:,None,None]).abs() <= radius)
        probs = torch.softmax(maps.flatten(1), dim=1).reshape_as(maps) * mask
        probs = probs / probs.sum((1,2), keepdim=True).clamp_min(1e-12)
        x, y = (probs*xx).sum((1,2)), (probs*yy).sum((1,2))
    return torch.stack(((x+.5)*base.RAW_PER_HEAT_X-.5, (y+.5)*base.RAW_PER_HEAT_Y-.5), 1)


def evaluate(torch, model, rows, cache, device, radius):
    model.eval(); result=[]
    with torch.no_grad():
        for r in rows:
            h,p = model(pair_tensor(torch,cache,r).unsqueeze(0).to(device))
            require_finite('validation logits', h); require_finite('validation presence logits', p)
            xy=decode(torch,h,radius)[0].cpu().tolist()
            result.append({'row':r,'prediction':xy,'presenceProbability':float(torch.sigmoid(p[0]).cpu())})
    return result


def localization(preds):
    e=sorted(math.dist(p['prediction'],(p['row']['targetPixel']['x'],p['row']['targetPixel']['y'])) for p in preds if p['row']['isPositive'])
    at=lambda q:e[min(len(e)-1,math.ceil(q*len(e))-1)] if e else None
    return {'count':len(e),'medianPx':at(.5),'p90Px':at(.9)}


def presence_metrics(preds):
    pos=[p for p in preds if p['row']['isPositive']]; neg=[p for p in preds if not p['row']['isPositive']]
    t=sum(p['presenceProbability']>=.5 for p in pos); n=sum(p['presenceProbability']<.5 for p in neg)
    return {'balancedAccuracy':((t/len(pos) if pos else 0)+(n/len(neg) if neg else 0))/2,
            'positiveRecall':t/len(pos) if pos else None,'negativeSpecificity':n/len(neg) if neg else None,
            'truePositive':t,'falseNegative':len(pos)-t,'trueNegativeSynthetic':n,'falsePositiveSynthetic':len(neg)-n}


