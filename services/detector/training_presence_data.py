"""Train a spatially pooled presence head with captured empty-board pairs.

The encoder, feature extractor and localization heatmap remain frozen. The old global
presence head is retained as a comparison output; a new spatial head is trained.
All checkpoint selection uses development/validation material; test images are never opened.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
import training_data as base
import training_localizer as trainer
import evaluate_empty_pairs as evaluator

DEFAULT_MODEL = ROOT / 'build/real-presence-model-v2/model.pt'
DEFAULT_TARGETS = ROOT / 'build/real-keypoints-retrospective-v1/targets.json'
DEFAULT_MANIFEST = ROOT / 'build/real-empty-pairs-v1-final/manifest.json'
DEFAULT_OUTPUT = ROOT / 'build/real-presence-model-v3'
DEFAULT_VISIBILITY = ROOT / 'data/board-captures/_visibility'


def fail_if_nonfinite(name, value):
    trainer.require_finite(name, value)


def empty_pair_rows(manifest, source_dataset):
    groups = {'development': [], 'validation': []}
    for pair in manifest['pairs']:
        split = pair.get('split')
        if split not in groups:
            continue
        if pair.get('occupancyLabel') != 'empty-at-both-capture-endpoints':
            raise ValueError(f"{pair.get('pairId')}: unsupported occupancy label")
        a, b = pair['baselineA'], pair['baselineB']
        expected_split = source_dataset.get('frozenSplitByBaseline', {})
        if any(expected_split.get(ep['captureId']) != split for ep in (a, b)):
            raise ValueError(f"{pair['pairId']}: baseline endpoints do not match frozen split")
        verified = []
        for endpoint in (a, b):
            expected_manifest = endpoint.get('manifestSHA256')
            manifest_path = ROOT / 'data/board-captures' / endpoint['captureId'] / 'manifest.json'
            if expected_manifest:
                actual_manifest = evaluator.sha256(manifest_path)
                if actual_manifest != expected_manifest:
                    raise ValueError(f"{pair['pairId']}: capture manifest hash mismatch")
            image_path = evaluator.resolve_image(endpoint['imagePath'])
            if evaluator.sha256(image_path) != endpoint.get('imageSHA256'):
                raise ValueError(f"{pair['pairId']}: endpoint image hash mismatch")
            verified.append(endpoint)
        # The trainer's current/reference convention is newest/oldest.
        groups[split].append({'id': pair['pairId'], 'kind': 'real-empty', 'label': 0,
            'imagePath': b['imagePath'], 'imageSHA256': b['imageSHA256'],
            'referenceImagePath': a['imagePath'], 'referenceImageSHA256': a['imageSHA256'],
            'classification': pair['classification'], 'baselineA': a['captureId'],
            'baselineB': b['captureId'], 'continuityClaim': pair['continuityClaim']})
    return groups


def load_visibility_exclusions(directory, samples):
    excluded = {}
    by_capture = {}
    for row in samples:
        if row['split'] in ('development', 'validation'):
            by_capture.setdefault(row['captureId'], []).append(row)
    for capture_id, rows in by_capture.items():
        path = directory / f'{capture_id}.json'
        if not path.is_file():
            continue
        note = evaluator.strict_json(path)
        if note.get('captureId') != capture_id or note.get('excludeFromPositiveTraining') is not True:
            continue
        reason = note.get('reason')
        if reason not in ('no-visible-dart-all-cameras', 'contaminated-reference'):
            raise ValueError(f'{path}: unsupported visibility exclusion reason')
        expected = note.get('imageSHA256')
        if not isinstance(expected, dict):
            raise ValueError(f'{path}: imageSHA256 map is required')
        seen = {}
        for row in rows:
            camera = str(row['camera'])
            previous = seen.setdefault(camera, row.get('imageSHA256'))
            if previous != row.get('imageSHA256'):
                raise ValueError(f'{capture_id}: inconsistent target image hashes for camera {camera}')
        if set(expected) != set(seen):
            raise ValueError(f'{path}: visibility hash cameras do not match frozen target samples')
        if expected != seen:
            raise ValueError(f'{path}: visibility image hashes do not match frozen target samples')
        record = {'reason': reason, 'cameraCount': len(seen),
                  'sampleCount': len(rows), 'annotationSHA256': evaluator.sha256(path)}
        if reason == 'contaminated-reference':
            reference_id = note.get('referenceCaptureId')
            reference_hashes = note.get('referenceImageSHA256')
            if not isinstance(reference_id, str) or not isinstance(reference_hashes, dict) or set(reference_hashes) != {'0', '1', '2'}:
                raise ValueError(f'{path}: referenceCaptureId and three referenceImageSHA256 values are required')
            for camera, digest in reference_hashes.items():
                if not isinstance(digest, str) or len(digest) != 64 or any(ch not in '0123456789abcdef' for ch in digest):
                    raise ValueError(f'{path}: invalid reference camera {camera} SHA-256')
            if any(row.get('previousFrameCaptureId') != reference_id for row in rows):
                raise ValueError(f'{path}: target previousFrameCaptureId does not match referenceCaptureId')
            seen_ref = {str(row['camera']): row.get('previousFrameImageSHA256') for row in rows}
            if set(seen_ref) != {'0', '1', '2'} or seen_ref != reference_hashes:
                raise ValueError(f'{path}: reference hashes do not match frozen target samples')
            record.update({'referenceCaptureId': reference_id,
                           'referenceImageSHA256': reference_hashes})
        excluded[capture_id] = record
    return excluded


def build_rows(targets, allow_retrospective, model_meta, manifest, source_dataset, visibility_directory):
    data, samples = base.load_samples(targets, allow_retrospective)
    base.validate_split_isolation(samples)
    original_dev_val = [r for r in samples if r['split'] in ('development', 'validation')]
    original_source_hash, _ = base.verify_source_images(original_dev_val)
    if original_source_hash != model_meta.get('sourceImageManifestSHA256'):
        raise ValueError('v3 development/validation image manifest hash mismatch')
    excluded = load_visibility_exclusions(visibility_directory, samples)
    contaminated = {cid: item for cid, item in excluded.items() if item['reason'] == 'contaminated-reference'}
    curated = [r for r in samples if r['captureId'] not in excluded]
    development = [r for r in curated if r['split'] == 'development']
    validation = [r for r in curated if r['split'] == 'validation']
    source_hash, image_count = base.verify_source_images(development + validation)
    challenge = empty_pair_rows(manifest, source_dataset)
    bad_reference_ids = {item['referenceCaptureId'] for item in contaminated.values()}
    challenge = {split: [row for row in rows if row['baselineA'] not in bad_reference_ids and row['baselineB'] not in bad_reference_ids]
                for split, rows in challenge.items()}
    positive_dev = [{**r, 'kind': 'positive', 'label': 1, 'id': r['sampleId']} for r in development]
    positive_val = [{**r, 'kind': 'positive', 'label': 1, 'id': r['sampleId']} for r in validation]
    bad_reference_hashes = {digest for item in contaminated.values()
                            for digest in item.get('referenceImageSHA256', {}).values()}
    def clean_synthetic(row):
        return not row['isPositive'] and row.get('imageSHA256') not in bad_reference_hashes and row.get('referenceImageSHA256') not in bad_reference_hashes
    synthetic_dev = [{**r, 'kind': 'synthetic-empty', 'label': 0, 'id': r['sampleId']}
                     for r in base.add_synthetic_negatives(development) if clean_synthetic(r)][:len(development)]
    synthetic_val = [{**r, 'kind': 'synthetic-empty', 'label': 0, 'id': r['sampleId']}
                     for r in base.add_synthetic_negatives(validation) if clean_synthetic(r)][:len(validation)]
    train = positive_dev + synthetic_dev + challenge['development']
    valid = positive_val + synthetic_val + challenge['validation']
    if not challenge['development'] or not challenge['validation']:
        raise ValueError('challenge requires development and validation real-empty pairs')
    if not positive_dev or not positive_val:
        raise ValueError('positive development and validation rows are required')
    return data, source_hash, image_count, train, valid, excluded


def model_class(torch):
    """Return v3 architecture; old v2 layers remain intact for comparison/loading."""
    import torch.nn as nn
    class SpatialPresence(trainer.model_class(torch)):
        def __init__(self):
            super().__init__()
            # Preserve a coarse 3x5 map so localized evidence is not collapsed globally.
            self.presenceSpatial = nn.Sequential(nn.Linear(24 * 2 * 15, 64), nn.ReLU(inplace=True),
                                                 nn.Dropout(p=.15), nn.Linear(64, 1))
        def forward(self, x):
            cur, ref = x[:, :3], x[:, 3:6]
            inp = torch.cat((cur, ref, cur-ref), dim=1)
            a = self.enc1(inp); b = self.enc2(a); c = self.enc3(b)
            evidence = self.presenceFeatures(c)
            pooled = torch.cat((torch.nn.functional.adaptive_max_pool2d(evidence, (3, 5)).flatten(1),
                                torch.nn.functional.adaptive_avg_pool2d(evidence, (3, 5)).flatten(1)), 1)
            presence = self.presenceSpatial(pooled)[:, 0]
            d = self.up2(torch.cat((torch.nn.functional.interpolate(c, size=b.shape[-2:], mode='bilinear', align_corners=False), b), 1))
            d = self.up1(torch.cat((torch.nn.functional.interpolate(d, size=a.shape[-2:], mode='bilinear', align_corners=False), a), 1))
            return self.heat(d).flatten(1), presence
    return SpatialPresence


def load_model(torch, checkpoint):
    """Load v2 warm start while strictly checking all preexisting parameter shapes."""
    model = model_class(torch)()
    missing, unexpected = model.load_state_dict(checkpoint['state_dict'], strict=False)
    new_head = {'presenceSpatial.0.weight', 'presenceSpatial.0.bias',
                'presenceSpatial.3.weight', 'presenceSpatial.3.bias'}
    if set(missing) not in (new_head, set()) or unexpected:
        raise ValueError(f'incompatible checkpoint: missing={missing}, unexpected={unexpected}')
    return model


def forward_presence_features(model, features):
    evidence = model.presenceFeatures(features)
    import torch
    pooled = torch.cat((torch.nn.functional.adaptive_max_pool2d(evidence, (3, 5)).flatten(1),
                        torch.nn.functional.adaptive_avg_pool2d(evidence, (3, 5)).flatten(1)), 1)
    return model.presenceSpatial(pooled)[:, 0]


def feature_key(row):
    return row['imageSHA256'], row['referenceImageSHA256']


def build_feature_cache(model, rows, image_cache, torch, device, batch_size=8):
    unique = {}
    for row in rows:
        key = feature_key(row)
        unique.setdefault(key, row)
    ordered = list(unique.items())
    result = {}
    model.eval()
    with torch.no_grad():
        for start in range(0, len(ordered), batch_size):
            chunk = ordered[start:start+batch_size]
            pairs = torch.stack([trainer.pair_tensor(torch, image_cache, row) for _, row in chunk]).to(device)
            cur, ref = pairs[:, :3], pairs[:, 3:6]
            x = torch.cat((cur, ref, cur-ref), dim=1)
            features = model.enc3(model.enc2(model.enc1(x)))
            fail_if_nonfinite('cached frozen encoder features', features)
            for (key, _), value in zip(chunk, features):
                result[key] = value.detach().cpu().contiguous()
    print(f'cached {len(result)} frozen encoder feature maps on CPU', flush=True)
    return result


def score(model, rows, features, torch, device, batch_size):
    output = []
    model.eval()
    with torch.no_grad():
        for start in range(0, len(rows), batch_size):
            batch = rows[start:start+batch_size]
            x = torch.stack([features[feature_key(r)] for r in batch]).to(device)
            logits = forward_presence_features(model, x)
            fail_if_nonfinite('validation presence logits', logits)
            probs = torch.sigmoid(logits).cpu().tolist()
            output.extend({'row': r, 'probability': float(p)} for r, p in zip(batch, probs))
    return output


def metrics(scored):
    real = [s for s in scored if s['row']['kind'] == 'real-empty']
    positive = [s for s in scored if s['row']['kind'] == 'positive']
    synthetic = [s for s in scored if s['row']['kind'] == 'synthetic-empty']
    def errors(rows, positive_label):
        wrong = sum((s['probability'] >= .5) != positive_label for s in rows)
        return {'count': len(rows), 'errorsAtHalf': wrong,
                'errorRateAtHalf': wrong/len(rows) if rows else None}
    return {'realEmptyPairs': errors(real, False), 'positivePairs': errors(positive, True),
            'syntheticEmptyPairs': errors(synthetic, False),
            'realFalsePositivesAtHalf': sum(s['probability'] >= .5 for s in real),
            'positiveFalseNegativesAtHalf': sum(s['probability'] < .5 for s in positive),
            'syntheticFalsePositivesAtHalf': sum(s['probability'] >= .5 for s in synthetic)}


def validation_objective(values, loss):
    real_rate = values['realEmptyPairs']['errorRateAtHalf']
    positive_rate = values['positivePairs']['errorRateAtHalf']
    synthetic_rate = values['syntheticEmptyPairs']['errorRateAtHalf']
    return .5*(real_rate+positive_rate)+.1*synthetic_rate + .001*loss


