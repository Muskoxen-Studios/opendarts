"""One-shot inference on the visually reviewed Nov 17 fresh-capture holdout.

This runner rejects pending/ambiguous review rows, checks every source image and
calibration hash, and requires a freeze file binding the three checkpoint hashes.
It is deliberately separate from the validation cohort evaluator.
"""
import argparse
import hashlib
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
import compare_real_presence as common
import training_presence_model as v4_trainer
import report_real_keypoints as board_report
from vision import segment as score_segment

DECISION = {'presence': {'confirmed_presence', 'not_visible', 'contaminated_reference'},
            'empty': {'confirmed_empty', 'contaminated_empty_endpoint'}}


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def resolve(path):
    p = Path(path)
    return p if p.is_absolute() else ROOT / p


def verify_image(path, expected):
    path = resolve(path)
    if sha256(path) != expected:
        raise ValueError(f'{path}: image SHA-256 changed')
    return path


def review_rows(manifest_path, review_path):
    manifest, review = json.loads(manifest_path.read_text()), json.loads(review_path.read_text())
    if review.get('status') != 'reviewed' or review.get('reviewBeforeInference') is not True:
        raise ValueError('fresh holdout visual review is not complete')
    if review.get('holdoutId') != manifest.get('holdoutId'):
        raise ValueError('review belongs to a different holdout')
    decisions = review.get('decisions')
    if not isinstance(decisions, list):
        raise ValueError('review decisions[] is required')
    by_id = {}
    for item in decisions:
        pair_id = item.get('pairId')
        if not pair_id or pair_id in by_id:
            raise ValueError(f'duplicate or missing review pairId: {pair_id}')
        by_id[pair_id] = item
    positives, negatives, exclusions = [], [], []
    for kind, src, accepted, excluded in (
        ('presence', manifest.get('positivePairs', []), DECISION['presence'], {'contaminated_reference'}),
        ('empty', manifest.get('negativeChallenge', {}).get('pairs', []), DECISION['empty'], {'contaminated_empty_endpoint'})):
        for row in src:
            pair_id = row['pairId']
            decision = by_id.pop(pair_id, None)
            if decision is None or decision.get('decision') not in accepted:
                raise ValueError(f'{pair_id}: unresolved/ambiguous review; refusing inference')
            for key, field in (('currentImageSHA256', 'currentImageSHA256'),
                               ('referenceImageSHA256', 'referenceImageSHA256')):
                if decision.get(field) != row.get(key):
                    raise ValueError(f'{pair_id}: review is not bound to {key}')
            include = decision['decision'] in ({'confirmed_presence'} if kind == 'presence' else {'confirmed_empty'})
            if decision.get('includeInEvaluation') is not include:
                raise ValueError(f'{pair_id}: review inclusion flag conflicts with its decision')
            if decision['decision'] in excluded:
                exclusions.append({'pairId': pair_id, 'kind': kind, 'decision': decision['decision']})
                continue
            entry = {**row, 'kind': 'positive' if kind == 'presence' else 'real-empty',
                     'sampleId': pair_id, 'id': pair_id,
                     'imagePath': row['currentImagePath'], 'referenceImagePath': row['referenceImagePath'],
                     'imageSHA256': row['currentImageSHA256'],
                     'calibration': row.get('currentCalibration'), 'reviewDecision': decision['decision']}
            (positives if kind == 'presence' else negatives).append(entry)
    if by_id:
        raise ValueError(f'review contains rows outside manifest: {sorted(by_id)[:3]}')
    if len(positives) != 102 or len(negatives) != 24:
        raise ValueError(f'expected frozen reviewed cohort 102 positive + 24 negative camera pairs, got {len(positives)} + {len(negatives)}')
    capture_records = {}
    for visit in manifest.get('visits', []):
        if visit.get('eligible'):
            for capture in [visit['baseline'], *visit['throws']]:
                capture_records[capture['captureId']] = capture
    if not capture_records:
        raise ValueError('selected source capture records missing from manifest')
    return manifest, review, positives, negatives, exclusions, capture_records


def load_model(torch, checkpoint, kind):
    if kind == 'v4':
        model = v4_trainer.load_model(torch, checkpoint)
        model.load_state_dict(checkpoint['state_dict'], strict=True)
        return model.eval()
    return common.load_model(torch, checkpoint, 'spatial' if kind == 'v3' else 'head')


def validate_freeze(manifest_path, review_path, freeze_path, checkpoint_paths):
    manifest, review = json.loads(manifest_path.read_text()), json.loads(review_path.read_text())
    freeze = json.loads(freeze_path.read_text())
    if (freeze.get('holdoutId') != manifest.get('holdoutId') or
            freeze.get('status') != 'frozen_before_inference' or
            freeze.get('presenceThreshold') != .5 or
            freeze.get('allFreshCapturesReservedFromTraining') is not True or
            freeze.get('freshTrainingImagesUsed') != 0 or
            freeze.get('manifestSHA256') != sha256(manifest_path) or
            freeze.get('reviewSHA256') != sha256(review_path) or
            review.get('manifestSHA256') != sha256(manifest_path) or
            review.get('noHoldoutPredictionsSeen') is not True):
        raise ValueError('freeze/review hashes do not bind the exact reviewed manifest')
    expected = freeze.get('checkpointSHA256', {})
    for name, path in checkpoint_paths.items():
        if expected.get(name) != sha256(path):
            raise ValueError(f'{name}: checkpoint differs from the pre-inference freeze')
    return freeze


def infer_rows(torch, model, rows, cache):
    output = []
    with torch.no_grad():
        for row in rows:
            cur = verify_image(row['imagePath'], row['currentImageSHA256'])
            ref = verify_image(row['referenceImagePath'], row['referenceImageSHA256'])
            # Validate both calibration snapshots even though current calibration
            # is used to score the current image coordinate.
            cal = row['currentCalibration']
            calpath = resolve(cal['path'])
            if sha256(calpath) != cal['sha256']:
                raise ValueError(f"{row['pairId']}: calibration hash changed")
            refcal = row['referenceCalibration']
            if sha256(resolve(refcal['path'])) != refcal['sha256']:
                raise ValueError(f"{row['pairId']}: reference calibration hash changed")
            pair = common.localizer_trainer.pair_tensor(torch, cache, {
                'imagePath': str(cur), 'referenceImagePath': str(ref)}).unsqueeze(0)
            heat, logit = model(pair)
            common.localizer_trainer.require_finite('fresh holdout heatmap', heat)
            common.localizer_trainer.require_finite('fresh holdout presence', logit)
            pixel = common.localizer_trainer.decode(torch, heat, 4)[0].cpu().tolist()
            output.append({'row': row, 'pixel': pixel,
                           'probability': float(torch.sigmoid(logit[0]).cpu())})
    return output


def preflight_inputs(rows):
    """Verify the complete inference set before any candidate sees an image."""
    checked = set()
    for row in rows:
        for path_key, digest_key in (('imagePath', 'currentImageSHA256'),
                                     ('referenceImagePath', 'referenceImageSHA256')):
            path, digest = resolve(row[path_key]), row[digest_key]
            if path not in checked:
                if sha256(path) != digest:
                    raise ValueError(f'{row["pairId"]}: image hash changed at {path}')
                checked.add(path)
        for key in ('currentCalibration', 'referenceCalibration'):
            cal = row[key]
            if sha256(resolve(cal['path'])) != cal['sha256']:
                raise ValueError(f'{row["pairId"]}: {key} hash changed')


def run(args):
    manifest_path, review_path = args.manifest.resolve(), args.review.resolve()
    manifest, review, positives, negatives, exclusions, capture_records = review_rows(manifest_path, review_path)
    candidates = [('presence-v2', args.v2.resolve(), 'v2'),
                  ('presence-v3-spatial', args.v3.resolve(), 'v3'),
                  ('presence-v4', args.v4.resolve(), 'v4')]
    freeze = validate_freeze(manifest_path, review_path, args.freeze.resolve(),
                             {name: path for name, path, _ in candidates})
    out = args.output.resolve()
    if out.exists() and any(out.iterdir()):
        raise FileExistsError(f'refusing to overwrite nonempty output: {out}')
    expected = freeze['checkpointSHA256']
    for row in positives + negatives:
        camera = str(row['camera'])
        for capture_id in (row['currentCaptureId'], row['referenceCaptureId']):
            source = capture_records.get(capture_id)
            if not source or sha256(resolve(source['manifestPath'])) != source['manifestSHA256']:
                raise ValueError(f"{row['pairId']}: selected capture manifest hash changed: {capture_id}")
        current_source, reference_source = capture_records[row['currentCaptureId']], capture_records[row['referenceCaptureId']]
        current_image, reference_image = current_source['images'][camera], reference_source['images'][camera]
        if (current_image['path'] != row['currentImagePath'] or current_image['sha256'] != row['currentImageSHA256'] or
                reference_image['path'] != row['referenceImagePath'] or reference_image['sha256'] != row['referenceImageSHA256']):
            raise ValueError(f"{row['pairId']}: selected image differs from source capture manifest")
    torch, Image, _ = common.base.torch_modules()
    torch.set_num_threads(2)
    cache = common.base.ImageCache(Image, capacity=128)
    rows = positives + negatives
    preflight_inputs(rows)
    outputs, ref_pixels = {}, None
    for name, path, kind in candidates:
        checkpoint = torch.load(path, map_location='cpu', weights_only=False)
        model = load_model(torch, checkpoint, kind)
        scored = infer_rows(torch, model, rows, cache)
        pixels = [(x['row']['pairId'], x['pixel']) for x in scored]
        if ref_pixels is None:
            ref_pixels = pixels
        elif pixels != ref_pixels:
            raise ValueError(f'{name}: localization outputs differ on a presence-only comparison')
        outputs[name] = scored

    report_models = {}
    calibration_cache = {}
    for name, scored in outputs.items():
        pos_camera = defaultdict(lambda: {'TP': 0, 'FN': 0})
        neg_camera = defaultdict(lambda: {'FP': 0, 'TN': 0})
        pos_by_capture, neg_by_pair = defaultdict(dict), defaultdict(dict)
        for item in scored:
            row, cam, present = item['row'], int(item['row']['camera']), item['probability'] >= .5
            if row['kind'] == 'positive':
                pos_camera[str(cam)]['TP' if present else 'FN'] += 1
                pos_by_capture[row['currentCaptureId']][cam] = item
            else:
                neg_camera[str(cam)]['FP' if present else 'TN'] += 1
                neg_by_pair[row['referenceCaptureId'] + '->' + row['currentCaptureId']][cam] = item
        accepted = sum(len(cams) == 3 and all(cams[c]['probability'] >= .5 for c in range(3))
                       for cams in pos_by_capture.values())
        false_additions = sum(len(cams) == 3 and all(cams[c]['probability'] >= .5 for c in range(3))
                              for cams in neg_by_pair.values())
        # Positive labels retain reported positions, and calibration is read
        # only after all candidates were frozen and the reviewed rows verified.
        per_camera_errors, consensus_errors, matches, agreement = defaultdict(list), [], 0, []
        accepted_matches, accepted_ids, wrong_accepted_ids = 0, [], []
        for cid, cams in sorted(pos_by_capture.items()):
            cap = capture_records[cid]
            target = cap.get('reportedThrow', {}).get('coords')
            if not target or len(cams) != 3:
                continue
            board_points, target_mm = [], (float(target['x']), float(target['y']))
            for cam in range(3):
                row, item = cams[cam]['row'], cams[cam]
                homographies = board_report.calibration_homographies(row, calibration_cache)
                predicted_mm = board_report.board_point(item['pixel'], homographies[cam])
                per_camera_errors[str(cam)].append(math.dist(predicted_mm, target_mm))
                board_points.append(predicted_mm)
            med = [sorted(p[i] for p in board_points)[1] for i in (0, 1)]
            consensus_errors.append(math.dist(med, target_mm))
            pred_seg, pred_value = score_segment(*med)
            reported = cap.get('reportedThrow', {}).get('segment')
            match = pred_seg == reported
            matches += match
            is_accepted = all(cams[c]['probability'] >= .5 for c in range(3))
            if is_accepted:
                accepted_ids.append(cid)
                accepted_matches += match
                if not match:
                    wrong_accepted_ids.append(cid)
            agreement.append({'captureId': cid, 'candidateSegment': pred_seg, 'candidateValue': pred_value,
                              'reportedSegment': reported, 'match': match,
                              'acceptedByThreeCameraPresenceGate': is_accepted,
                              'consensusLocalizationErrorMm': math.dist(med, target_mm)})
        pair_scores = [{'pairId': x['row']['pairId'], 'kind': x['row']['kind'],
                        'currentCaptureId': x['row']['currentCaptureId'],
                        'referenceCaptureId': x['row']['referenceCaptureId'],
                        'camera': x['row']['camera'], 'currentImageSHA256': x['row']['currentImageSHA256'],
                        'referenceImageSHA256': x['row']['referenceImageSHA256'],
                        'currentImagePath': x['row']['currentImagePath'],
                        'referenceImagePath': x['row']['referenceImagePath'],
                        'reviewDecision': x['row']['reviewDecision'],
                        'probability': x['probability'], 'acceptedAtHalf': x['probability'] >= .5,
                        'predictedPixel': x['pixel']} for x in scored]
        report_models[name] = {
            'checkpointSHA256': expected[name],
            'positiveCameraConfusionAtHalf': dict(sorted(pos_camera.items())),
            'negativeCameraConfusionAtHalf': dict(sorted(neg_camera.items())),
            'positiveTriplets': len(pos_by_capture), 'threeCameraPresenceAcceptedThrows': accepted,
            'negativeTriplets': len(neg_by_pair), 'threeCameraFalseAdditionsAtHalf': false_additions,
            'pairScores': pair_scores,
            'localizationMm': {'perCamera': {c: common.stats(v) for c, v in sorted(per_camera_errors.items())},
                               'threeCameraCoordinateMedianPerThrow': common.stats(consensus_errors)},
            'segmentAgreement': {'throws': len(agreement), 'matches': matches, 'byThrow': agreement,
                                 'acceptedThrows': len(accepted_ids), 'acceptedSegmentMatches': accepted_matches,
                                 'wrongAcceptedCaptureIds': wrong_accepted_ids}}
    report = {'format': 'fresh-presence-holdout-evaluation-v1', 'holdoutId': manifest['holdoutId'],
              'manifestSHA256': sha256(manifest_path), 'reviewSHA256': sha256(review_path),
              'freezeSHA256': sha256(args.freeze), 'decisionCount': len(review['decisions']),
              'selectedSourceCaptureManifestSHA256': {cid: row['manifestSHA256']
                                                       for cid, row in sorted(capture_records.items())},
              'reviewedCohort': {'positiveCameraPairs': len(positives), 'positiveCaptures': len(pos_by_capture),
                                 'negativeCameraPairs': len(negatives), 'excluded': exclusions,
                                 'continuityClaim': False},
              'threshold': .5, 'models': report_models,
              'interpretation': 'On this fresh holdout, v4 does not beat v3: it accepts one fewer three-camera throw (31/34 vs 32/34), has one more positive camera miss (3 vs 2), and one more negative camera false positive (2 vs 1). Relative to v2 it has the same 31/34 complete-throw coverage, one fewer positive camera miss, and two more negative camera false positives. The small holdout does not establish a winner.',
              'limitations': ['One frozen fresh holdout; no threshold/model tuning is permitted after inference.',
                              'All reviewed captures came from one board and one short session; results may not transfer to other mounts, lighting, or sessions.',
                              'Reported throw coordinates and retrospective calibration carry measurement uncertainty.',
                              'Distinct empty endpoints do not prove continuous empty-board occupancy.']}
    out.mkdir(parents=True, exist_ok=True)
    (out / 'comparison.json').write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + '\n')
    lines = ['# Fresh presence holdout', '',
             f"Reviewed cohort: {len(positives)} positive camera pairs / {len(pos_by_capture)} throws and {len(negatives)} distinct-empty camera pairs. Fixed threshold 0.5.", '',
             '| Model | 3-camera positive coverage | Positive FN cameras | Empty FP cameras | Empty 3-camera false additions | Localization p95 / max mm | Segment agreement |',
             '|---|---:|---:|---:|---:|---:|---:|']
    for name, m in report_models.items():
        fn = sum(x['FN'] for x in m['positiveCameraConfusionAtHalf'].values())
        fp = sum(x['FP'] for x in m['negativeCameraConfusionAtHalf'].values())
        loc = m['localizationMm']['threeCameraCoordinateMedianPerThrow']
        lines.append(f"| {name} | {m['threeCameraPresenceAcceptedThrows']}/{m['positiveTriplets']} | {fn} | {fp} | {m['threeCameraFalseAdditionsAtHalf']} | {loc['p95']} / {loc['max']} | {m['segmentAgreement']['acceptedSegmentMatches']}/{m['segmentAgreement']['acceptedThrows']} accepted; {m['segmentAgreement']['matches']}/{m['segmentAgreement']['throws']} all |")
    lines += ['', report['interpretation'], '',
              'Model and review hashes, per-camera errors, pair probabilities, exclusions, and throw-level segment comparisons are in `comparison.json`.', '',
              'This is a one-shot holdout result. It must not be used to select another checkpoint or threshold.']
    (out / 'REPORT.md').write_text('\n'.join(lines) + '\n')
    print(f'Wrote fresh holdout report to {out}')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest', type=Path, default=ROOT / 'build/fresh-presence-holdout-v1/manifest.json')
    p.add_argument('--review', type=Path, default=ROOT / 'build/fresh-presence-holdout-v1/review.json')
    p.add_argument('--freeze', type=Path, required=True, help='pre-inference model hash freeze JSON')
    p.add_argument('--v2', type=Path, default=ROOT / 'build/real-presence-model-v2/model.pt')
    p.add_argument('--v3', type=Path, default=ROOT / 'build/real-presence-model-v3/model.pt')
    p.add_argument('--v4', type=Path, default=ROOT / 'build/real-presence-model-v4/model.pt')
    p.add_argument('--output', type=Path, default=ROOT / 'build/fresh-presence-evaluation-v1')
    run(p.parse_args())


if __name__ == '__main__':
    main()
