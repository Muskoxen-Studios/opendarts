"""Train an independent full-encoder residual presence branch on frozen features.

Only development rows train the branch. Validation rows select among the explicit
v2 incumbent and two predeclared optimizer settings; test data is never opened.
"""
import argparse
import json
import math
from pathlib import Path
import random
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
import training_data as base
import training_localizer as trainer
import training_presence_data as prior
import evaluate_empty_pairs as evaluator

DEFAULT_MODEL = ROOT / 'build/real-presence-model-v2/model.pt'
DEFAULT_TARGETS = ROOT / 'build/real-keypoints-retrospective-v1/targets.json'
DEFAULT_MANIFEST = ROOT / 'build/real-empty-pairs-v1-final/manifest.json'
DEFAULT_OUTPUT = ROOT / 'build/real-presence-model-v4'
DEFAULT_VISIBILITY = ROOT / 'data/board-captures/_visibility'


def model_class(torch):
    nn = torch.nn
    class PresenceV4(trainer.model_class(torch)):
        def __init__(self):
            super().__init__()
            # Full 48-channel encoder evidence; zero residual preserves incumbent at init.
            self.presenceEvidence = nn.Sequential(
                nn.Conv2d(48, 48, 3, padding=1), nn.ReLU(inplace=True),
                nn.Dropout2d(.10), nn.Conv2d(48, 48, 1))
            nn.init.zeros_(self.presenceEvidence[-1].weight)
            nn.init.zeros_(self.presenceEvidence[-1].bias)
            self.presenceCorrection = nn.Sequential(
                nn.Linear(48 * (2 + 2 * 3 * 5), 64), nn.ReLU(inplace=True),
                nn.Dropout(.20), nn.Linear(64, 1))
            nn.init.zeros_(self.presenceCorrection[-1].weight)
            nn.init.zeros_(self.presenceCorrection[-1].bias)
        def forward_features(self, c):
            evidence = c + self.presenceEvidence(c)
            pooled = torch.cat((torch.nn.functional.adaptive_max_pool2d(evidence, 1).flatten(1),
                torch.nn.functional.adaptive_avg_pool2d(evidence, 1).flatten(1),
                torch.nn.functional.adaptive_max_pool2d(evidence, (3, 5)).flatten(1),
                torch.nn.functional.adaptive_avg_pool2d(evidence, (3, 5)).flatten(1)), 1)
            base_evidence = self.presenceFeatures(c)
            base_pool = torch.cat((torch.nn.functional.adaptive_max_pool2d(base_evidence, 1).flatten(1),
                torch.nn.functional.adaptive_avg_pool2d(base_evidence, 1).flatten(1)), 1)
            return self.presence(base_pool)[:, 0] + self.presenceCorrection(pooled)[:, 0]
        def forward(self, x):
            cur, ref = x[:, :3], x[:, 3:6]
            inp = torch.cat((cur, ref, cur-ref), dim=1)
            a = self.enc1(inp); b = self.enc2(a); c = self.enc3(b)
            presence = self.forward_features(c)
            d = self.up2(torch.cat((torch.nn.functional.interpolate(c, size=b.shape[-2:], mode='bilinear', align_corners=False), b), 1))
            d = self.up1(torch.cat((torch.nn.functional.interpolate(d, size=a.shape[-2:], mode='bilinear', align_corners=False), a), 1))
            return self.heat(d).flatten(1), presence
    return PresenceV4


def load_model(torch, checkpoint):
    model = model_class(torch)()
    missing, unexpected = model.load_state_dict(checkpoint['state_dict'], strict=False)
    allowed = {k for k in model.state_dict() if k.startswith(('presenceEvidence.', 'presenceCorrection.'))}
    if set(missing) - allowed or unexpected:
        raise ValueError(f'incompatible checkpoint: missing={missing}, unexpected={unexpected}')
    return model


def feature_key(row):
    return row['imageSHA256'], row['referenceImageSHA256']


def cache_features(model, rows, images, torch, device):
    unique = {feature_key(r): r for r in rows}
    result = {}
    model.eval()
    with torch.no_grad():
        for key, row in unique.items():
            pair = trainer.pair_tensor(torch, images, row).unsqueeze(0).to(device)
            cur, ref = pair[:, :3], pair[:, 3:6]
            c = model.enc3(model.enc2(model.enc1(torch.cat((cur, ref, cur-ref), 1))))
            trainer.require_finite('cached frozen encoder features', c)
            result[key] = c[0].detach().cpu().contiguous()
    return result


def score(model, rows, cache, torch, device):
    out=[]; model.eval()
    with torch.no_grad():
        for row in rows:
            logit = model.forward_features(cache[feature_key(row)].unsqueeze(0).to(device))[0]
            trainer.require_finite('presence logit', logit)
            out.append({'row': row, 'probability': float(torch.sigmoid(logit).cpu())})
    return out


