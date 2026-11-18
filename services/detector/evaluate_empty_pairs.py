"""Evaluate a trained v3 keypoint model on distinct real empty-frame pairs.

Only validation pairs are inferred. The challenge labels assert empty occupancy
at each capture endpoint; they do not prove continuous empty-board occupancy.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
import training_data as base
import training_localizer as trainer

DEFAULT_MODEL = ROOT / 'build/real-keypoint-model-v3/model.pt'
DEFAULT_TARGETS = ROOT / 'build/real-keypoints-retrospective-v1/targets.json'
DEFAULT_MANIFEST = ROOT / 'build/real-empty-pairs-v1-final/manifest.json'
DEFAULT_OUTPUT = ROOT / 'build/real-empty-pair-evaluation-v1/report.json'


def sha256(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def strict_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f'duplicate JSON key {key!r} in {path}')
            result[key] = value
        return result
    def reject_constant(value):
        raise ValueError(f'non-finite JSON number {value!r} in {path}')
    return json.loads(Path(path).read_text(), object_pairs_hook=unique,
                      parse_constant=reject_constant)


def resolve_image(value):
    path = Path(value)
    path = path if path.is_absolute() else ROOT / path
    path = path.resolve()
    if not path.is_relative_to(ROOT.resolve()):
        raise ValueError(f'image path escapes repository: {value}')
    return path


def load_and_verify(torch, model_path, targets_path, manifest_path, allow_retrospective):
    checkpoint = torch.load(model_path, map_location='cpu', weights_only=False)
    metadata = checkpoint.get('metadata', {})
    if metadata.get('architecture') != 'pair-current-reference-difference-spatial-presence-v3':
        raise ValueError('checkpoint is not a v3 real keypoint model')
    if not metadata.get('validationOnly') or metadata.get('testSplitInferencePerformed') is not False:
        raise ValueError('checkpoint metadata does not certify validation-only training')
    if sha256(targets_path) != metadata.get('targetsSHA256'):
        raise ValueError('checkpoint targets SHA-256 mismatch')
    if sha256(Path(trainer.__file__)) != metadata.get('scriptSHA256'):
        raise ValueError('trainer script SHA-256 mismatch; use the exact source that created the checkpoint')
    if sha256(Path(base.__file__)) != metadata.get('baseTrainerSHA256'):
        raise ValueError('base trainer SHA-256 mismatch')
    data, samples = base.load_samples(targets_path, allow_retrospective)
    base.validate_split_isolation(samples)
    eligible = [r for r in samples if r['split'] in ('development', 'validation')]
    source_manifest_hash, _ = base.verify_source_images(eligible)
    if source_manifest_hash != metadata.get('sourceImageManifestSHA256'):
        raise ValueError('training/validation source image manifest hash mismatch')
    if data.get('sourceDatasetSHA256') != metadata.get('sourceDatasetSHA256'):
        raise ValueError('source dataset hash metadata mismatch')
    manifest = strict_json(manifest_path)
    if manifest.get('format') != 'real-empty-frame-pairs-v1':
        raise ValueError('unsupported empty-pair manifest format')
    dataset_path = Path(manifest['datasetPath'])
    dataset_path = dataset_path if dataset_path.is_absolute() else ROOT / dataset_path
    if sha256(dataset_path) != manifest.get('datasetSHA256'):
        raise ValueError('empty-pair source dataset SHA-256 mismatch')
    if manifest.get('datasetSHA256') != metadata.get('sourceDatasetSHA256'):
        raise ValueError('challenge dataset SHA-256 does not match checkpoint source dataset')
    source_dataset = strict_json(dataset_path)
    if manifest.get('pairPolicy', {}).get('testImagesReadOrIncluded') is not False:
        raise ValueError('manifest does not attest that test images were excluded')
    return checkpoint, metadata, manifest, source_dataset


def run(args):
    torch, Image, _ = base.torch_modules()
    torch.set_num_threads(2)
    model_path, targets_path, manifest_path = (p.resolve() for p in (args.model, args.targets, args.manifest))
    checkpoint, metadata, manifest, source_dataset = load_and_verify(
        torch, model_path, targets_path, manifest_path, args.allow_retrospective_labels)
    output = args.output.resolve()
    if output.exists():
        raise FileExistsError(f'refusing to overwrite output: {output}')
    selected = [p for p in manifest.get('pairs', []) if p.get('split') == 'validation']
    if not selected:
        raise ValueError('manifest has no validation pairs')
    # Filter first: neither test pair metadata nor test images are read for inference.
    if any(p.get('split') not in ('development', 'validation') for p in manifest.get('pairs', [])):
        raise ValueError('manifest contains unexpected split labels')
    model = trainer.model_class(torch)()
    model.load_state_dict(checkpoint['state_dict'], strict=True)
    device = torch.device('cuda' if args.device == 'cuda' or
                          (args.device == 'auto' and torch.cuda.is_available()) else 'cpu')
    if args.device == 'cuda' and not torch.cuda.is_available():
        raise RuntimeError('CUDA requested but unavailable')
    model.to(device).eval()
    ImageCache = base.ImageCache(Image)
    rows = []
    with torch.no_grad():
        for pair in selected:
            if pair.get('occupancyLabel') != 'empty-at-both-capture-endpoints':
                raise ValueError(f"{pair.get('pairId')}: unsupported occupancy label")
            endpoints = []
            for key in ('baselineA', 'baselineB'):
                endpoint = pair[key]
                if source_dataset.get('frozenSplitByBaseline', {}).get(endpoint['captureId']) != 'validation':
                    raise ValueError(f"{pair['pairId']}: endpoint is not frozen to validation")
                expected_manifest_hash = source_dataset.get('sourceManifestHashes', {}).get(endpoint['captureId'])
                if endpoint.get('manifestSHA256'):
                    capture_manifest = ROOT / 'data/board-captures' / endpoint['captureId'] / 'manifest.json'
                    actual_manifest_hash = sha256(capture_manifest)
                    if actual_manifest_hash != endpoint['manifestSHA256']:
                        raise ValueError(f"{pair['pairId']}: {key} capture manifest SHA-256 mismatch")
                    if expected_manifest_hash and actual_manifest_hash != expected_manifest_hash:
                        raise ValueError(f"{pair['pairId']}: {key} manifest hash disagrees with frozen dataset")
                elif expected_manifest_hash:
                    raise ValueError(f"{pair['pairId']}: {key} is missing expected manifest SHA-256")
                image_path = resolve_image(endpoint['imagePath'])
                actual = sha256(image_path)
                if actual != endpoint.get('imageSHA256'):
                    raise ValueError(f"{pair['pairId']}: {key} image SHA-256 mismatch")
                endpoints.append({'imagePath': endpoint['imagePath'], 'imageSHA256': actual})
            if endpoints[0]['imageSHA256'] == endpoints[1]['imageSHA256']:
                raise ValueError(f"{pair['pairId']}: endpoint images must be distinct")
            # Pair construction is chronological: baseline B is current, A is previous.
            row = {'imagePath': endpoints[1]['imagePath'], 'referenceImagePath': endpoints[0]['imagePath']}
            pair_tensor = trainer.pair_tensor(torch, ImageCache, row).unsqueeze(0).to(device)
            heat, presence = model(pair_tensor)
            trainer.require_finite('empty-pair heat logits', heat)
            trainer.require_finite('empty-pair presence logit', presence)
            probability = float(torch.sigmoid(presence[0]).cpu())
            rows.append({'pairId': pair['pairId'], 'camera': pair['camera'],
                'split': 'validation', 'classification': pair['classification'],
                'occupancyLabel': pair['occupancyLabel'], 'continuityClaim': pair['continuityClaim'],
                'baselineA': pair['baselineA']['captureId'], 'baselineB': pair['baselineB']['captureId'],
                'baselineAImageSHA256': endpoints[0]['imageSHA256'],
                'baselineBImageSHA256': endpoints[1]['imageSHA256'],
                'timeGapSeconds': pair['timeGapSeconds'],
                'interveningCaptureCount': pair['interveningCaptureCount'],
                'interveningThrowCaptureCount': pair['interveningThrowCaptureCount'],
                'interveningTakeoutBaselineCount': pair['interveningTakeoutBaselineCount'],
                'presenceProbability': probability, 'falsePositiveAtHalf': probability >= .5})
    values = [r['presenceProbability'] for r in rows]
    ordered = sorted(values)
    percentile = lambda q: ordered[min(len(ordered)-1, math.ceil(q*len(ordered))-1)] if ordered else None
    by_class = {}
    for classification in sorted({r['classification'] for r in rows}):
        subset = [r for r in rows if r['classification'] == classification]
        probs = sorted(r['presenceProbability'] for r in subset)
        by_class[classification] = {'count': len(subset),
            'falsePositivesAtHalf': sum(r['falsePositiveAtHalf'] for r in subset),
            'falsePositiveRateAtHalf': sum(r['falsePositiveAtHalf'] for r in subset)/len(subset),
            'probabilityMedian': probs[(len(probs)-1)//2],
            'probabilityP90': probs[math.ceil(.9*len(probs))-1]}
    report = {'format': 'real-empty-pair-evaluation-v1',
        'modelSHA256': sha256(model_path), 'modelScriptSHA256': metadata['scriptSHA256'],
        'baseTrainerSHA256': metadata['baseTrainerSHA256'],
        'targetsSHA256': sha256(targets_path), 'sourceImageManifestSHA256': metadata['sourceImageManifestSHA256'],
        'challengeManifestSHA256': sha256(manifest_path), 'challengeDatasetSHA256': manifest['datasetSHA256'],
        'split': 'validation', 'testSplitInferencePerformed': False,
        'threshold': .5, 'pairCount': len(rows),
        'falsePositivesAtHalf': sum(r['falsePositiveAtHalf'] for r in rows),
        'falsePositiveRateAtHalf': sum(r['falsePositiveAtHalf'] for r in rows)/len(rows),
        'presenceProbability': {'min': min(values), 'median': percentile(.5),
                                'p90': percentile(.9), 'max': max(values)},
        'byPairCategory': by_class,
        'limitations': ['Each label records empty occupancy at both capture endpoints, not uninterrupted occupancy between them.',
            'False positive rate applies only to this captured validation pair challenge, not to live-camera noise generally.'],
        'pairs': rows}
    report['presenceFineTuned'] = metadata.get('presenceFineTuned', False)
    report['validationUsedForPresenceSelection'] = metadata.get('presenceValidationSplitIsTuningData', False)
    if report['validationUsedForPresenceSelection']:
        report['limitations'].append('These validation pairs were used to select the presence head; this is tuning performance, not a fresh test.')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False)+'\n')
    print(f"wrote {len(rows)} validation empty-pair scores; false positives at 0.5: {report['falsePositivesAtHalf']}; {output}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, default=DEFAULT_MODEL)
    parser.add_argument('--targets', type=Path, default=DEFAULT_TARGETS)
    parser.add_argument('--manifest', type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--device', choices=('auto', 'cpu', 'cuda'), default='auto')
    parser.add_argument('--allow-retrospective-labels', action='store_true',
                        help='required to verify the historical training target artifact')
    run(parser.parse_args())


if __name__ == '__main__':
    main()
