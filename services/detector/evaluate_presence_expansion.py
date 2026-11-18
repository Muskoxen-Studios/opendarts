"""Evaluate a frozen presence candidate on the separately reviewed expansion test.

The test runner accepts only the reserved visit split, verifies a pre-inference
checkpoint/review freeze, and refuses to overwrite an earlier evaluation.
"""
import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
import training_data as base
import training_localizer as localizer
import training_presence_data as spatial
import training_presence_model as residual
import report_real_keypoints as geometry
from vision import segment


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def path(value):
    p = Path(value)
    return p if p.is_absolute() else ROOT / p


def read_rows(manifest_path, review_path):
    manifest = json.loads(manifest_path.read_text())
    review = json.loads(review_path.read_text())
    if review.get('status') != 'reserved_test_reviewed_before_inference':
        raise ValueError('reserved test requires a completed blind visual review')
    if review.get('expansionId') != manifest.get('expansionId'):
        raise ValueError('test review belongs to a different expansion')
    if review.get('manifestSHA256') != sha(manifest_path):
        raise ValueError('test review does not bind the frozen manifest')
    decisions = {}
    for decision in review['decisions']:
        if decision['rowId'] in decisions:
            raise ValueError('duplicate test review decision')
        decisions[decision['rowId']] = decision
    rows, excluded = [], []
    for name, positive in [('positiveRows', True), ('emptyEndpointRows', False)]:
        for source in manifest[name]:
            if source['split'] != 'reserved-new-test':
                continue
            decision = decisions.pop(source['rowId'], None)
            if decision is None:
                raise ValueError(f"{source['rowId']}: missing blind review")
            cur, ref = source['currentImage'], source['referenceImage']
            if (decision.get('currentImageSHA256') != cur['sha256'] or
                    decision.get('referenceImageSHA256') != ref['sha256']):
                raise ValueError('test review image hash mismatch')
            if decision.get('includeInEvaluation') is False:
                allowed = {'contaminated_reference', 'contaminated_current'} if positive else {'contaminated_empty_endpoint'}
                if decision.get('decision') not in allowed:
                    raise ValueError('unexplained test exclusion')
                excluded.append(decision)
                continue
            if decision.get('decision') != ('confirmed_presence' if positive else 'confirmed_empty'):
                raise ValueError('unresolved test label')
            if decision.get('includeInEvaluation') is not True:
                raise ValueError('included test row requires explicit approval in the blind review')
            rows.append({**source, 'positive': positive})
    if decisions:
        raise ValueError('review contains rows outside the reserved test')
    return manifest, rows, excluded


def evaluate(args):
    out = args.output.resolve()
    if out.exists() and any(out.iterdir()):
        raise FileExistsError(f'refusing to overwrite {out}')
    freeze = json.loads(args.freeze.read_text())
    if freeze.get('status') != 'frozen_before_reserved_test_inference':
        raise ValueError('candidate must be frozen before reserved test inference')
    if freeze.get('manifestSHA256') != sha(args.manifest) or freeze.get('reviewSHA256') != sha(args.review):
        raise ValueError('candidate freeze does not bind test manifest/review')
    manifest, rows, excluded = read_rows(args.manifest, args.review)
    if freeze.get('threshold') != .5 or freeze.get('expansionId') != manifest.get('expansionId'):
        raise ValueError('test freeze threshold or expansion identity changed')
    models = {}
    for value in args.model:
        label, filename = value.split('=', 1)
        if label in models:
            raise ValueError('duplicate model label')
        model_path = path(filename)
        if freeze.get('checkpointSHA256', {}).get(label) != sha(model_path):
            raise ValueError(f'{label}: checkpoint differs from the pre-test freeze')
        models[label] = model_path
    if set(models) != set(freeze.get('checkpointSHA256', {})):
        raise ValueError('candidate list differs from pre-test freeze')
    # Verify every included source before loading models or running a forward pass.
    capture_sources = {}
    for visit in manifest['visits']:
        if visit['expansionSplit'] == 'reserved-new-test':
            for capture in [visit['baseline'], *visit['throws']]:
                capture_sources[capture['captureId']] = capture
    for row in rows:
        for image in [row['currentImage'], row['referenceImage']]:
            if sha(path(image['path'])) != image['sha256']:
                raise ValueError('reserved test image changed')
        ids = [row.get('captureId', row.get('currentCaptureId')), row['referenceCaptureId']]
        for capture_id, image in zip(ids, [row['currentImage'], row['referenceImage']]):
            source = capture_sources[capture_id]
            source_image = source['images'][str(row['camera'])]
            if source_image['path'] != image['path'] or source_image['sha256'] != image['sha256']:
                raise ValueError('test image is not bound to its reviewed source capture and camera')
            if sha(path(source['manifestPath'])) != source['manifestSHA256']:
                raise ValueError('reserved test capture manifest changed')
            calibration = source['calibration']
            if sha(path(calibration['path'])) != calibration['sha256']:
                raise ValueError('reserved test calibration changed')
        current_calibration = row.get('calibration', row.get('currentCalibration'))
        if current_calibration != capture_sources[ids[0]]['calibration']:
            raise ValueError('test row calibration differs from linked capture calibration')
        if not row['positive'] and row['currentImage']['sha256'] == row['referenceImage']['sha256']:
            raise ValueError('real negative unexpectedly uses identical images')
    reviewed_triplets = defaultdict(set)
    for row in rows:
        key = ('positive', row['captureId']) if row['positive'] else ('negative', row['referenceCaptureId'], row['currentCaptureId'])
        if row['camera'] in reviewed_triplets[key]:
            raise ValueError('duplicate camera in reviewed test triplet')
        reviewed_triplets[key].add(row['camera'])
    if any(cameras != {0, 1, 2} for cameras in reviewed_triplets.values()):
        raise ValueError('test review must preserve complete camera triplets before inference')
    torch, Image, _ = base.torch_modules()
    torch.set_num_threads(2)
    cache = base.ImageCache(Image, capacity=256)
    all_results, pixel_reference, calibration_cache = {}, None, {}
    for label, checkpoint_path in models.items():
        checkpoint = torch.load(checkpoint_path, map_location='cpu', weights_only=False)
        state = checkpoint['state_dict']
        if any(k.startswith('presenceSpatial.') for k in state):
            model = spatial.load_model(torch, checkpoint)
        elif any(k.startswith('presenceCorrection.') for k in state):
            model = residual.load_model(torch, checkpoint)
        else:
            model = localizer.model_class(torch)()
        model.load_state_dict(state, strict=True)
        model.eval()
        predictions = []
        with torch.no_grad():
            for row in rows:
                inp = {'imagePath': row['currentImage']['path'], 'referenceImagePath': row['referenceImage']['path']}
                heat, logit = model(localizer.pair_tensor(torch, cache, inp).unsqueeze(0))
                localizer.require_finite('reserved test heat', heat)
                localizer.require_finite('reserved test presence', logit)
                predictions.append({'rowId': row['rowId'], 'camera': row['camera'],
                    'captureId': row.get('captureId', row.get('currentCaptureId')),
                    'referenceCaptureId': row['referenceCaptureId'], 'positive': row['positive'],
                    'probability': float(torch.sigmoid(logit[0])),
                    'pixel': localizer.decode(torch, heat, 4)[0].tolist(),
                    'currentImage': row['currentImage'], 'referenceImage': row['referenceImage']})
        signature = [(p['rowId'], p['pixel']) for p in predictions]
        if pixel_reference is None:
            pixel_reference = signature
        elif signature != pixel_reference:
            raise ValueError('localization changed across presence-only checkpoints')
        positives, negatives = defaultdict(dict), defaultdict(dict)
        per_camera = {str(c): {'TP': 0, 'FN': 0, 'TN': 0, 'FP': 0} for c in range(3)}
        for pred in predictions:
            present = pred['probability'] >= .5
            per_camera[str(pred['camera'])][('TP' if present else 'FN') if pred['positive'] else ('FP' if present else 'TN')] += 1
            if pred['positive']:
                positives[pred['captureId']][pred['camera']] = pred
            else:
                negatives[(pred['referenceCaptureId'], pred['captureId'])][pred['camera']] = pred
        throw_results, errors, accepted_errors = [], [], []
        for capture_id, cams in positives.items():
            if set(cams) != {0, 1, 2}:
                raise ValueError('review must preserve complete positive camera triplets')
            capture = capture_sources[capture_id]
            hs = geometry.calibration_homographies({'calibration': capture['calibration']}, calibration_cache)
            board = [geometry.board_point(cams[c]['pixel'], hs[c]) for c in range(3)]
            median = [sorted(p[i] for p in board)[1] for i in (0, 1)]
            reported = capture['reportedThrow']
            error = ((median[0]-reported['coords']['x'])**2 + (median[1]-reported['coords']['y'])**2)**.5
            errors.append(error)
            candidate, value = segment(*median)
            accepted = all(p['probability'] >= .5 for p in cams.values())
            camera_segments = [segment(*p)[0] for p in board]
            unanimous = accepted and all(s == candidate for s in camera_segments)
            if accepted:
                accepted_errors.append(error)
            throw_results.append({'captureId': capture_id, 'presenceAccepted': accepted,
                'probabilityByCamera': {str(c): cams[c]['probability'] for c in range(3)},
                'candidateSegment': candidate, 'candidateValue': value,
                'reportedSegment': reported['segment'], 'segmentMatches': candidate == reported['segment'],
                'cameraSegments': camera_segments, 'unanimousCameraSegmentGate': unanimous,
                'localizationErrorMm': error})
        accepted = [t for t in throw_results if t['presenceAccepted']]
        unanimous = [t for t in throw_results if t['unanimousCameraSegmentGate']]
        if any(set(cams) != {0, 1, 2} for cams in negatives.values()):
            raise ValueError('review must preserve complete negative camera triplets')
        from compare_real_presence import stats
        all_results[label] = {'checkpointSHA256': sha(checkpoint_path), 'perCamera': per_camera,
            'positiveCameraPairs': sum(p['positive'] for p in predictions),
            'negativeCameraPairs': sum(not p['positive'] for p in predictions),
            'positiveFalseNegatives': sum(v['FN'] for v in per_camera.values()),
            'negativeFalsePositives': sum(v['FP'] for v in per_camera.values()),
            'positiveThrows': len(throw_results), 'presenceAcceptedThrows': len(accepted),
            'negativeTriplets': len(negatives),
            'falseAdditionTriplets': sum(all(p['probability'] >= .5 for p in cams.values()) for cams in negatives.values()),
            'segmentMatchesAllThrows': sum(t['segmentMatches'] for t in throw_results),
            'segmentMatchesAcceptedThrows': sum(t['segmentMatches'] for t in accepted),
            'wrongAcceptedCaptureIds': [t['captureId'] for t in accepted if not t['segmentMatches']],
            'unanimousSegmentDiagnostic': {'rule': 'All three presence scores >= 0.5 and all three camera-derived segments equal the median candidate segment',
                'coveredThrows': len(unanimous), 'correctSegmentThrows': sum(t['segmentMatches'] for t in unanimous),
                'wrongCaptureIds': [t['captureId'] for t in unanimous if not t['segmentMatches']],
                'liveAcceptanceImplemented': False},
            'localizationMm': stats(errors), 'acceptedLocalizationMm': stats(accepted_errors),
            'throws': throw_results, 'predictions': predictions}
    report = {'format': 'reserved-presence-expansion-evaluation-v1', 'threshold': .5,
        'manifestSHA256': sha(args.manifest), 'reviewSHA256': sha(args.review), 'freezeSHA256': sha(args.freeze),
        'evaluatorSHA256': sha(Path(__file__)), 'excludedBeforeInference': excluded, 'models': all_results,
        'limitations': ['One board and session; these are separated baseline visits, not independent physical setups.',
            'Empty endpoints do not measure continuous live false-alarm rate.',
            'Candidate segments and coordinate errors use board-reported labels and linked calibration, not surveyed ground truth.',
            'This test is evaluated after model selection; no model or threshold changes follow its results.']}
    out.mkdir(parents=True, exist_ok=True)
    (out/'comparison.json').write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False)+'\n')
    lines = ['# Reserved expansion test', '',
        '| Model | Presence throws | Positive FN cameras | Negative FP cameras | False-add triplets | Correct segment among presence-passed | Unanimous segment diagnostic |',
        '|---|---:|---:|---:|---:|---:|---:|']
    for label, r in all_results.items():
        u = r['unanimousSegmentDiagnostic']
        lines.append(f"| {label} | {r['presenceAcceptedThrows']}/{r['positiveThrows']} | {r['positiveFalseNegatives']} | {r['negativeFalsePositives']}/{r['negativeCameraPairs']} | {r['falseAdditionTriplets']} | {r['segmentMatchesAcceptedThrows']}/{r['presenceAcceptedThrows']} | {u['correctSegmentThrows']}/{u['coveredThrows']} correct, covers {u['coveredThrows']}/{r['positiveThrows']} |")
    lines += ['', *report['limitations'], '']
    (out/'REPORT.md').write_text('\n'.join(lines))
    print('\n'.join(lines))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest', type=Path, default=ROOT/'build/real-presence-expansion-v1/manifest.json')
    p.add_argument('--review', type=Path, required=True)
    p.add_argument('--freeze', type=Path, required=True)
    p.add_argument('--model', action='append', required=True, help='label=checkpoint path; must match freeze')
    p.add_argument('--output', type=Path, default=ROOT/'build/real-presence-expansion-test-v5')
    evaluate(p.parse_args())


if __name__ == '__main__':
    main()
