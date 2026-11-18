"""CPU inference comparison for original and cleaned real-presence checkpoints.

The validation rows are built by the same hash-verifying row builder used by
presence training. Test data are never read. Example:
  build/detector-training-env/bin/python services/detector/compare_real_presence.py \
    --output build/real-presence-comparison-clean-v2
"""
import argparse
import hashlib
import json
import math
from collections import defaultdict
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
import training_data as base
import training_localizer as localizer_trainer
import train_real_presence as presence_v2_trainer
import training_presence_data as presence_v3_trainer
import evaluate_empty_pairs as evaluator

DEFAULT_LOCALIZER = ROOT / 'build/real-keypoint-model-v3/model.pt'
DEFAULT_V2 = ROOT / 'build/real-presence-model-v2/model.pt'
DEFAULT_V3 = ROOT / 'build/real-presence-model-v3/model.pt'
DEFAULT_CONTROL = ROOT / 'build/real-presence-model-v3-control/model.pt'
DEFAULT_TARGETS = ROOT / 'build/real-keypoints-retrospective-v1/targets.json'
DEFAULT_MANIFEST = ROOT / 'build/real-empty-pairs-v1-final/manifest.json'
DEFAULT_VISIBILITY = ROOT / 'data/board-captures/_visibility'
DEFAULT_OUTPUT = ROOT / 'build/real-presence-comparison-clean-v2'


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def percentile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.ceil(q * len(ordered)) - 1)]


def stats(values):
    return {'count': len(values), 'p50': percentile(values, .5), 'p90': percentile(values, .9),
            'p95': percentile(values, .95), 'max': max(values) if values else None}


def filter_real_empty_rows(rows, contaminated_reference_ids):
    """Apply the training builder's endpoint exclusion to real-empty pairs."""
    return [row for row in rows if row.get('kind') != 'real-empty' or
            (row.get('baselineA') not in contaminated_reference_ids and
             row.get('baselineB') not in contaminated_reference_ids)]


def validate_clean_cohort(rows):
    counts = {kind: sum(row.get('kind') == kind for row in rows)
              for kind in ('positive', 'synthetic-empty', 'real-empty')}
    expected = {'positive': 105, 'synthetic-empty': 75, 'real-empty': 18}
    if counts != expected:
        raise ValueError(f'clean validation cohort changed: expected {expected}, got {counts}')
    clean_ids = {r['captureId'] for r in rows if r.get('kind') == 'positive'}
    if len(clean_ids) != 35:
        raise ValueError(f'expected 35 audited clean validation throws, got {len(clean_ids)}')
    return counts, clean_ids


def presence_accepts(probability):
    return probability >= .5


def presence_triplet_accepted(probabilities):
    return len(probabilities) == 3 and all(presence_accepts(p) for p in probabilities)


def require_checkpoint_hash(path, expected):
    actual = sha256(path)
    if actual != expected:
        raise ValueError(f'{path}: checkpoint SHA-256 mismatch')
    return actual


def load_model(torch, checkpoint, kind):
    if kind == 'localizer':
        model = localizer_trainer.model_class(torch)()
        model.load_state_dict(checkpoint['state_dict'], strict=True)
    elif kind == 'spatial':
        model = presence_v3_trainer.load_model(torch, checkpoint)
        missing, unexpected = model.load_state_dict(checkpoint['state_dict'], strict=True)
        if missing or unexpected:
            raise ValueError(f'spatial checkpoint mismatch: {missing}, {unexpected}')
    else:
        model = localizer_trainer.model_class(torch)()
        model.load_state_dict(checkpoint['state_dict'], strict=True)
    model.eval()
    return model


def infer(torch, model, rows, image_cache, device, peak_radius):
    result = []
    with torch.no_grad():
        for row in rows:
            pair = localizer_trainer.pair_tensor(torch, image_cache, row).unsqueeze(0).to(device)
            heat, presence_logit = model(pair)
            localizer_trainer.require_finite('comparison heatmap', heat)
            localizer_trainer.require_finite('comparison presence', presence_logit)
            xy = localizer_trainer.decode(torch, heat, peak_radius)[0].detach().cpu().tolist()
            probability = float(torch.sigmoid(presence_logit[0]).cpu())
            result.append({'row': row, 'pixel': xy, 'probability': probability})
    return result


def compute_metrics(scored, clean_ids, calibration_cache):
    from report_real_keypoints import board_point, calibration_homographies

    positives = defaultdict(dict)
    positive_presence = defaultdict(lambda: {'TP': 0, 'FN': 0})
    negative_presence = defaultdict(lambda: {'FP': 0, 'TN': 0})
    synthetic_presence = defaultdict(lambda: {'FP': 0, 'TN': 0})
    neg_pair_keys = set()
    negative_triplets = defaultdict(dict)
    for item in scored:
        row = item['row']
        camera = int(row['camera']) if 'camera' in row else int(str(row['id']).rsplit('__cam', 1)[-1])
        if row.get('kind') == 'positive':
            if row['captureId'] not in clean_ids:
                continue
            positives[row['captureId']][camera] = (row, item)
            key = 'TP' if presence_accepts(item['probability']) else 'FN'
            positive_presence[str(camera)][key] += 1
        elif row.get('kind') == 'real-empty':
            pair_key = row['id'].rsplit('__cam', 1)[0]
            neg_pair_keys.add(pair_key)
            negative_triplets[pair_key][camera] = item['probability']
            key = 'FP' if presence_accepts(item['probability']) else 'TN'
            negative_presence[str(camera)][key] += 1
        elif row.get('kind') == 'synthetic-empty':
            key = 'FP' if presence_accepts(item['probability']) else 'TN'
            synthetic_presence[str(camera)][key] += 1

    per_camera_errors = defaultdict(list)
    consensus_errors, consensus_by_capture = [], {}
    for capture_id, cams in positives.items():
        if set(cams) != {0, 1, 2}:
            raise ValueError(f'{capture_id}: expected complete camera triplet')
        points, targets = [], []
        for camera in range(3):
            row, item = cams[camera]
            hs = calibration_homographies(row, calibration_cache)
            h = hs[camera]
            if not h:
                raise ValueError(f'{capture_id} camera {camera}: missing homography')
            pred_mm = board_point(item['pixel'], h)
            target = row['targetPixel']
            target_mm = board_point((target['x'], target['y']), h)
            per_camera_errors[str(camera)].append(math.dist(pred_mm, target_mm))
            points.append(pred_mm)
            targets.append(target_mm)
        median_xy = (percentile([p[0] for p in points], .5), percentile([p[1] for p in points], .5))
        # All three projections should map the same labeled board-plane point.
        target_xy = (percentile([p[0] for p in targets], .5), percentile([p[1] for p in targets], .5))
        err = math.dist(median_xy, target_xy)
        consensus_errors.append(err)
        consensus_by_capture[capture_id] = err

    accepted = 0
    hard_misses = []
    for capture_id, cams in sorted(positives.items()):
        is_accepted = presence_triplet_accepted([cams[c][1]['probability'] for c in range(3)])
        accepted += is_accepted
        if not is_accepted:
            hard_misses.append({'captureId': capture_id, 'localizationErrorMm': consensus_by_capture[capture_id],
                                'probabilityByCamera': {str(c): cams[c][1]['probability'] for c in range(3)}})
    pinned_id = '2026-11-16T14-50-51-071Z-dbabc0f0-0be0-4515-a0b7-46fd1896d18f'
    if pinned_id in positives:
        pinned_cams = positives[pinned_id]
        pinned_case = {'captureId': pinned_id, 'label': 'single 10; Throw 4; camera 0',
                       'includedInCohort': True,
                       'camera0PresenceProbability': pinned_cams[0][1]['probability'],
                       'localizationErrorMm': consensus_by_capture[pinned_id],
                       'allCameraPresenceAccepted': presence_triplet_accepted(
                           [pinned_cams[c][1]['probability'] for c in range(3)])}
    else:
        pinned_case = {'captureId': pinned_id, 'label': 'single 10; Throw 4; camera 0',
                       'includedInCohort': False}
    return {
        'positiveCameraConfusionAtHalf': dict(sorted(positive_presence.items())),
        'distinctRealNegativeCameraConfusionAtHalf': dict(sorted(negative_presence.items())),
        'syntheticNegativeCameraConfusionAtHalf': dict(sorted(synthetic_presence.items())),
        'distinctRealNegativePairCount': len(neg_pair_keys),
        'distinctRealNegativeCompleteTripletCount': sum(len(probs) == 3 for probs in negative_triplets.values()),
        'negativeThreeCameraFalseAdditionsAtHalf': sum(
            presence_triplet_accepted([probs[c] for c in range(3)])
            for probs in negative_triplets.values()),
        'positiveTriplets': len(positives),
        'threeCameraPresenceAcceptedThrows': accepted,
        'localizationMm': {'threeCameraCoordinateMedianPerThrow': stats(consensus_errors),
                           'perCamera': {c: stats(v) for c, v in sorted(per_camera_errors.items())}},
        'hardMisses': hard_misses,
        'perThrow': [{'captureId': cid, 'localizationErrorMm': consensus_by_capture[cid],
                      'presenceProbabilityByCamera': {str(c): positives[cid][c][1]['probability'] for c in range(3)},
                      'allCameraPresenceAccepted': all(presence_accepts(positives[cid][c][1]['probability'])
                                                       for c in range(3))}
                     for cid in sorted(positives)],
        'pinnedCase': pinned_case}


def run(args):
    torch, Image, _ = base.torch_modules()
    torch.set_num_threads(2)
    torch.manual_seed(17)
    device = torch.device('cpu')
    localizer_path = args.localizer.resolve()
    targets_path, manifest_path = args.targets.resolve(), args.manifest.resolve()
    out = args.output.resolve()
    if out.exists() and any(out.iterdir()):
        raise FileExistsError(f'refusing to overwrite nonempty output: {out}')
    localizer_ckpt, meta, manifest, source_dataset = evaluator.load_and_verify(
        torch, localizer_path, targets_path, manifest_path, True)
    _, _, _, _, validation_rows, exclusions = presence_v3_trainer.build_rows(
        targets_path, True, meta, manifest, source_dataset, args.visibility_directory.resolve())
    counts, clean_ids = validate_clean_cohort(validation_rows)
    audit_path = ROOT / 'build/reference-audit/audit.json'
    audit = json.loads(audit_path.read_text())
    if audit.get('format') != 'darts-reference-visual-audit-v1' or audit.get('reviewedBy') == 'unverified-agent-audit':
        raise ValueError('verified reference audit missing or invalid')
    approved = {row['referenceCaptureId']: row for row in audit['references'] if row.get('status') == 'clean'}
    for row in validation_rows:
        if row.get('kind') != 'positive':
            continue
        reference_id = row.get('previousFrameCaptureId')
        record = approved.get(reference_id)
        camera = str(row['camera'])
        if not record or record.get('referenceImageSHA256', {}).get(camera) != row.get('previousFrameImageSHA256'):
            raise ValueError(f"{row['sampleId']}: previous-frame camera hash is not approved by verified audit")
    contaminated_ids = {item.get('referenceCaptureId') for item in exclusions.values()
                        if item.get('reason') == 'contaminated-reference'}
    validation_rows = [r for r in validation_rows if r.get('kind') != 'real-empty' or
                       (r.get('baselineA') not in contaminated_ids and r.get('baselineB') not in contaminated_ids)]
    counts, clean_ids = validate_clean_cohort(validation_rows)
    for row in validation_rows:
        if row.get('kind') == 'real-empty' and row.get('imageSHA256') == row.get('referenceImageSHA256'):
            raise ValueError(f"{row['id']}: real-empty challenge unexpectedly uses an identical image pair")
    reviewed_ids = set(approved)
    negative_provenance = {'bothEndpointsAuditReviewedClean': 0, 'containsUnauditedEndpoint': 0}
    negative_by_pair = {(row['baselineA'], row['baselineB']): row for row in validation_rows
                        if row.get('kind') == 'real-empty'}
    for row in negative_by_pair.values():
        key = ('bothEndpointsAuditReviewedClean' if row['baselineA'] in reviewed_ids and row['baselineB'] in reviewed_ids
               else 'containsUnauditedEndpoint')
        negative_provenance[key] += 1

    keypoint_state = localizer_ckpt['state_dict']
    candidates = [
        ('original-localizer', localizer_path, 'localizer'),
        ('presence-v2', args.presence_v2.resolve(), 'head'),
        ('presence-v3-spatial', args.presence_v3.resolve(), 'spatial'),
        ('presence-v3-cleaned-control', args.control.resolve(), 'head'),
    ]
    cache = base.ImageCache(Image, capacity=300)
    calibration_cache = {}
    outputs = {}
    targets_sha, manifest_sha = sha256(targets_path), sha256(manifest_path)
    inference_rows = validation_rows
    for label, path, kind in candidates:
        report_path = path.parent / 'report.json'
        if report_path.is_file():
            model_meta = json.loads(report_path.read_text())
            if model_meta.get('targetsSHA256') and model_meta['targetsSHA256'] != targets_sha:
                raise ValueError(f'{label}: checkpoint report targets hash differs from evaluated rows')
            if model_meta.get('challengeManifestSHA256') and model_meta['challengeManifestSHA256'] != manifest_sha:
                raise ValueError(f'{label}: checkpoint report challenge manifest differs from evaluated rows')
            model_digest = model_meta.get('modelSHA256')
            if model_digest:
                require_checkpoint_hash(path, model_digest)
        checkpoint = torch.load(path, map_location='cpu', weights_only=False)
        model = load_model(torch, checkpoint, kind)
        state = model.state_dict()
        shared = [k for k in keypoint_state if not k.startswith(('presenceFeatures.', 'presence.', 'presenceSpatial.'))]
        if any(k not in state or not torch.equal(state[k].cpu(), keypoint_state[k].cpu()) for k in shared):
            raise ValueError(f'{label}: encoder/heat localization tensors differ from original localizer')
        outputs[label] = compute_metrics(infer(torch, model, inference_rows, cache, device, args.peak_radius),
                                         clean_ids, calibration_cache)
        outputs[label]['checkpointSHA256'] = sha256(path)
        outputs[label]['sharedLocalizationTensorsBitwiseEqual'] = True
        outputs[label]['realNegativeEndpointAuditProvenance'] = negative_provenance
        outputs[label]['positiveFalseNegativeCameraSamples'] = sum(
            x['FN'] for x in outputs[label]['positiveCameraConfusionAtHalf'].values())
        outputs[label]['realNegativeFalsePositiveCameraSamples'] = sum(
            x['FP'] for x in outputs[label]['distinctRealNegativeCameraConfusionAtHalf'].values())
        print(f"{label}: {outputs[label]['threeCameraPresenceAcceptedThrows']}/35 presence triplets; "
              f"localization p50/p90/p95/max = "
              f"{outputs[label]['localizationMm']['threeCameraCoordinateMedianPerThrow']['p50']:.2f}/"
              f"{outputs[label]['localizationMm']['threeCameraCoordinateMedianPerThrow']['p90']:.2f}/"
              f"{outputs[label]['localizationMm']['threeCameraCoordinateMedianPerThrow']['p95']:.2f}/"
              f"{outputs[label]['localizationMm']['threeCameraCoordinateMedianPerThrow']['max']:.2f} mm", flush=True)

    report = {
        'format': 'real-presence-cleaned-checkpoint-comparison-v1',
        'cohort': {'split': 'validation', 'captureCount': len(clean_ids), 'positiveCameraSamples': counts['positive'],
                   'realEmptyCameraPairSamples': counts['real-empty'],
                   'distinctRealEmptyThrowPairs': len(negative_by_pair), 'syntheticEmptyPairs': counts['synthetic-empty'],
                   'captureExclusionCount': 12, 'visibilityExclusions': exclusions,
                   'cleanCaptureIds': sorted(clean_ids)},
        'verifiedAuditSHA256': sha256(audit_path), 'targetsSHA256': sha256(targets_path),
        'emptyPairManifestSHA256': sha256(manifest_path),
        'comparisonScriptSHA256': sha256(Path(__file__)),
        'peakRadiusHeatmapCells': args.peak_radius,
        'models': outputs,
        'historicalArtifactOnlyComparison': 'build/real-presence-baseline-clean-v1 is superseded; it used saved predictions, the broader 60-pair negatives and did not freshly infer all checkpoints.',
        'limitations': ['Validation rows were used during prior model selection; this is exploratory, not an untouched evaluation.',
                        'Localization errors inherit retrospective calibration uncertainty.',
                        'Real-empty endpoints are distinct capture pairs and are filtered by the verified training cohort, but do not prove continuous empty-board occupancy.',
                        'The fixed 0.5 presence threshold is reported for direct checkpoint comparison, not as a production decision threshold.']}
    out.mkdir(parents=True, exist_ok=True)
    (out / 'comparison.json').write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + '\n')
    lines = ['# Cleaned real-camera checkpoint comparison', '',
             'CPU inference; common frozen validation cohort: 35 throws, 105 positive camera samples, 18 distinct real-empty camera pairs (6 three-camera throw pairs), and 75 synthetic identity pairs.', '',
             '| Checkpoint | 3-camera presence | Positive FN cameras | Negative FP cameras | 3-camera false additions | Localization P50 | P90 | P95 | Max |',
             '|---|---:|---:|---:|---:|---:|---:|---:|---:|']
    for label, values in outputs.items():
        s = values['localizationMm']['threeCameraCoordinateMedianPerThrow']
        lines.append(f"| {label} | {values['threeCameraPresenceAcceptedThrows']}/35 | {values['positiveFalseNegativeCameraSamples']} | {values['realNegativeFalsePositiveCameraSamples']} | {values['negativeThreeCameraFalseAdditionsAtHalf']} | {s['p50']:.2f} | {s['p90']:.2f} | {s['p95']:.2f} | {s['max']:.2f} |")
    lines += ['', 'Per-camera FP/FN counts, all per-throw predictions and hard misses, the pinned single-10 Throw 4 camera-0 case, hashes, and exclusions are in `comparison.json`.', '', report['historicalArtifactOnlyComparison'], '']
    v2 = outputs['presence-v2']
    spatial = outputs['presence-v3-spatial']
    lines.insert(-2, f"On this cleaned cohort, v2 accepts {v2['threeCameraPresenceAcceptedThrows']}/35 throws and spatial v3 accepts {spatial['threeCameraPresenceAcceptedThrows']}/35; v2 has {v2['realNegativeFalsePositiveCameraSamples']} camera false positives versus {spatial['realNegativeFalsePositiveCameraSamples']} for spatial v3. Both have {v2['negativeThreeCameraFalseAdditionsAtHalf']}/{spatial['negativeThreeCameraFalseAdditionsAtHalf']} three-camera false additions respectively, and identical localization metrics. This is a presence tradeoff, not a recall improvement.")
    pinned_probs = ', '.join(f"{name}={value['pinnedCase'].get('camera0PresenceProbability')}"
                             for name, value in outputs.items())
    lines.insert(-2, f'Pinned single-10 Throw 4 camera-0 presence probability: {pinned_probs}.')
    (out / 'REPORT.md').write_text('\n'.join(lines))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--localizer', type=Path, default=DEFAULT_LOCALIZER)
    parser.add_argument('--presence-v2', type=Path, default=DEFAULT_V2)
    parser.add_argument('--presence-v3', type=Path, default=DEFAULT_V3)
    parser.add_argument('--control', type=Path, default=DEFAULT_CONTROL)
    parser.add_argument('--targets', type=Path, default=DEFAULT_TARGETS)
    parser.add_argument('--manifest', type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument('--visibility-directory', type=Path, default=DEFAULT_VISIBILITY)
    parser.add_argument('--peak-radius', type=int, default=4)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    report = run(args)
    print(f"wrote fresh CPU comparison for {report['cohort']['captureCount']} throws to {args.output}")


if __name__ == '__main__':
    main()
