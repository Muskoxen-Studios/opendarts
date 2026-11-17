"""Offline board-plane and segment diagnostics for real keypoint predictions."""
import argparse
import hashlib
import json
import math
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = ROOT / 'build/real-keypoint-model-v2'


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def resolve(path):
    p = Path(path)
    return p if p.is_absolute() else ROOT / p


def apply(h, point):
    x, y = point
    z = h[2][0]*x + h[2][1]*y + h[2][2]
    if abs(z) < 1e-12:
        raise ValueError('homography maps point to infinity')
    return ((h[0][0]*x+h[0][1]*y+h[0][2])/z,
            (h[1][0]*x+h[1][1]*y+h[1][2])/z)


def board_point(pixel, h):
    # Imported calibration canonical coordinates put bull at (500, 500),
    # with the double-outer ring at radius 1000/3 pixels.
    u, v = apply(h, pixel)
    scale = 170.0 / (1000.0 / 3.0)
    return (scale*(u-500), -scale*(v-500))


def percentile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered)-1, math.ceil(q*len(ordered))-1)]


def stats(values):
    return {'count': len(values), 'median': percentile(values, .5),
            'p90': percentile(values, .9), 'max': max(values) if values else None}


def calibration_homographies(row, cache):
    cal = row.get('calibration') or {}
    if not cal.get('path'):
        raise ValueError(f"{row.get('sampleId')}: missing calibration path")
    path = resolve(cal['path'])
    content = path.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    if cal.get('sha256') and cal['sha256'] != digest:
        raise ValueError(f'{path}: calibration SHA256 mismatch')
    if cal.get('id') and cal['id'] != digest:
        raise ValueError(f'{path}: calibration id mismatch')
    if digest not in cache:
        data = json.loads(content)
        if 'calibration' in data:
            data = data['calibration']
        cams = data.get('cams')
        if not isinstance(cams, list) or len(cams) != 3:
            raise ValueError(f'{path}: expected three calibration cameras')
        # Predictions and targets are expressed in raw image pixels, matching
        # prepare_real_keypoints.py's raw homography.
        cache[digest] = [cam.get('homography') for cam in cams]
    return cache[digest]


def run(predictions_path, dataset_path, output_dir):
    pred_data = json.loads(predictions_path.read_text())
    targets = json.loads(dataset_path.read_text())
    if pred_data.get('format') != 'real-keypoint-predictions-v1':
        raise ValueError('unsupported predictions format')
    if pred_data.get('targetsSHA256') != sha256(dataset_path):
        raise ValueError('predictions targetsSHA256 does not match supplied targets file')
    prediction_rows = pred_data.get('predictions')
    if not isinstance(prediction_rows, list):
        raise ValueError('predictions[] required')
    source_dataset = json.loads(resolve(targets['sourceDatasetPath']).read_text())
    source_digest = sha256(resolve(targets['sourceDatasetPath']))
    if targets.get('sourceDatasetSHA256') != source_digest:
        raise ValueError('targets sourceDatasetSHA256 does not match source dataset file')
    if (pred_data.get('sourceDatasetSHA256') is not None and
            pred_data['sourceDatasetSHA256'] != source_digest):
        raise ValueError('predictions sourceDatasetSHA256 does not match source dataset file')
    labels = {r['id']: r for r in source_dataset.get('records', [])}
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from build_real_dataset import distance_to_scoring_boundary
    from vision import segment

    cache, rows, per_camera, groups = {}, [], defaultdict(list), defaultdict(list)
    positives = [p for p in prediction_rows if p.get('isPositive') is True]
    negative_count = sum(p.get('isPositive') is False for p in prediction_rows)
    negative_fp = sum(p.get('isPositive') is False and p.get('presenceProbability', 0) >= .5
                      for p in prediction_rows)
    presence_confusion = {}
    present_splits = [split for split in ('validation', 'test')
                      if any(p.get('split') == split for p in prediction_rows)]
    for split in present_splits:
        selected = [p for p in prediction_rows if p.get('split') == split]
        presence_confusion[split] = {
            'truePositive': sum(p['isPositive'] and p['presenceProbability'] >= .5 for p in selected),
            'falseNegative': sum(p['isPositive'] and p['presenceProbability'] < .5 for p in selected),
            'falsePositiveSynthetic': sum(not p['isPositive'] and p['presenceProbability'] >= .5 for p in selected),
            'trueNegativeSynthetic': sum(not p['isPositive'] and p['presenceProbability'] < .5 for p in selected),
        }
    for p in prediction_rows:
        if p.get('split') not in ('validation', 'test'):
            raise ValueError(f"unexpected prediction split: {p.get('split')}")
        label = labels.get(p.get('captureId'))
        if p.get('isPositive'):
            if label is None:
                raise ValueError(f"missing target dataset record for {p.get('captureId')}")
            hs = calibration_homographies(p, cache)
            ci = int(p['camera'])
            h = hs[ci]
            if not h:
                raise ValueError(f"camera {ci}: missing raw homography")
            target_px = p['targetPixel']
            pred_px = p['predictedRawPixel']
            target_mm, pred_mm = board_point((target_px['x'], target_px['y']), h), board_point(pred_px, h)
            source_mm = (label['label']['coords']['x'], label['label']['coords']['y'])
            if math.dist(target_mm, source_mm) > 1e-5:
                raise ValueError(f"{p['sampleId']}: target pixel projection disagrees with source coordinates")
            err = math.dist(target_mm, pred_mm)
            pred_seg = segment(*pred_mm)[0]
            label_seg = label['label']['segment']
            agreed = pred_seg == label_seg
            row = {'sampleId': p['sampleId'], 'captureId': p['captureId'], 'camera': ci,
                   'split': p['split'], 'boardPlaneErrorMm': err, 'segmentAgreement': agreed,
                   'predictedSegment': pred_seg, 'targetSegment': label_seg,
                   'targetBoundaryDistanceMm': distance_to_scoring_boundary(label['label']['coords'])}
            rows.append(row); per_camera[str(ci)].append(row); groups[p['captureId']].append((p, label, h, row))

    consensus, incomplete = [], []
    for capture_id, items in sorted(groups.items()):
        by_cam = {int(p['camera']): (p, label, h, row) for p, label, h, row in items}
        if set(by_cam) != {0, 1, 2}:
            incomplete.append(capture_id)
            continue
        points = [board_point(by_cam[c][0]['predictedRawPixel'], by_cam[c][2]) for c in range(3)]
        x, y = sorted(pt[0] for pt in points)[1], sorted(pt[1] for pt in points)[1]
        _, label, _, _ = by_cam[0]
        target = label['label']['coords']
        pred_seg = segment(x, y)[0]
        consensus.append({'captureId': capture_id, 'split': by_cam[0][0]['split'],
                          'errorMm': math.dist((x, y), (target['x'], target['y'])),
                          'segmentAgreement': pred_seg == label['label']['segment'],
                          'nearBoundary3mm': distance_to_scoring_boundary(target) <= 3})

    by_split = {}
    for split in present_splits:
        subset = [r for r in rows if r['split'] == split]
        by_split[split] = {'perCamera': {cam: stats([r['boardPlaneErrorMm'] for r in subset if str(r['camera']) == cam])
                                         for cam in ('0', '1', '2')},
                           'allPredictionsPositiveErrors': stats([r['boardPlaneErrorMm'] for r in subset]),
                           'pointSegmentAgreement': {'count': len(subset), 'agreed': sum(r['segmentAgreement'] for r in subset),
                                                     'rate': (sum(r['segmentAgreement'] for r in subset)/len(subset) if subset else None)}}
    consensus_split = {}
    for split in present_splits:
        subset = [r for r in consensus if r['split'] == split]
        consensus_split[split] = {'count': len(subset), 'errorMm': stats([r['errorMm'] for r in subset]),
            'segmentAgreementCount': sum(r['segmentAgreement'] for r in subset),
            'segmentAgreementRate': sum(r['segmentAgreement'] for r in subset)/len(subset) if subset else None,
            'nearBoundary3mmCount': sum(r['nearBoundary3mm'] for r in subset)}
    report = {'format': 'real-keypoint-board-metrics-v1', 'predictionsSHA256': sha256(predictions_path),
        'targetsSHA256': sha256(dataset_path), 'trainerScriptSHA256': pred_data.get('scriptSHA256'),
        'predictionCount': len(prediction_rows), 'positiveCount': len(positives),
        'syntheticEmptyPairCount': negative_count,
        'syntheticEmptyPairPresenceFalsePositivesAtHalf': negative_fp,
        'syntheticEmptyPairFalsePositiveRate': negative_fp/negative_count if negative_count else None,
        'presenceConfusionAtHalf': presence_confusion,
        'bySplit': by_split, 'threeCameraConsensus': {'method': 'coordinate-wise median of exactly cameras 0, 1, 2',
            'count': len(consensus), 'incompleteTripletCaptureCount': len(incomplete),
            'incompleteTripletCaptureIds': incomplete, 'bySplit': consensus_split},
        'retrospectiveCalibration': bool(targets.get('allowRetrospectiveCalibration')),
        'limitations': ['Retrospective planar calibration maps target and predicted raw pixels to a diagnostic board plane; this is not 3D shaft localization or service acceptance.',
            'Calibration stability and capture association are unverified; errors inherit that uncertainty.',
            'Consensus is a coordinate median diagnostic, not a calibration-accuracy claim.',
            'Synthetic negative pairs repeat one captured image and do not measure real empty-board noise.']}
    report['limitations'].append('The test split was consumed in earlier experiments; this report does not establish a fresh untouched test evaluation.')
    # Copy baseline pixel metrics for comparison; no new inference is performed.
    training_report = output_dir / 'report.json'
    if training_report.is_file():
        metadata = json.loads(training_report.read_text())
        report['pixelComparison'] = {'model': {split: metadata.get(f'{split}Metrics') for split in present_splits},
            'baseline': metadata.get('baselineMetrics')}
    report['presenceAccuracy'] = {}
    report['presenceBalancedAccuracy'] = {}
    for split, counts in presence_confusion.items():
        tp, fn = counts['truePositive'], counts['falseNegative']
        tn, fp = counts['trueNegativeSynthetic'], counts['falsePositiveSynthetic']
        total = tp + fn + tn + fp
        report['presenceAccuracy'][split] = (tp + tn) / total if total else None
        report['presenceBalancedAccuracy'][split] = (
            (tp / (tp + fn) + tn / (tn + fp)) / 2
            if tp + fn and tn + fp else None)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / 'board-metrics.json').write_text(json.dumps(report, indent=2, sort_keys=True)+'\n')
    lines = ['# Real keypoint model board-plane diagnostics', '',
        f"Predictions: {len(prediction_rows)} total, {len(positives)} positive; targets SHA256 `{report['targetsSHA256']}`.", '',
        'Assessment: diagnostic prototype only; not usable as a live detector.', '',
        'These are retrospective planar diagnostics. They do not establish 3D localization, service acceptance, or calibration accuracy.', '',
        '## Positive prediction errors', '']
    for split, metrics in by_split.items():
        lines += [f"### {split}", '', '| Camera | Count | Median mm | P90 mm | Max mm |', '|---|---:|---:|---:|---:|']
        for cam, value in metrics['perCamera'].items():
            lines.append(f"| {cam} | {value['count']} | {value['median']} | {value['p90']} | {value['max']} |")
        v = metrics['allPredictionsPositiveErrors']
        lines += ['', f"Point-derived segment agreement: {metrics['pointSegmentAgreement']['agreed']}/{metrics['pointSegmentAgreement']['count']} ({metrics['pointSegmentAgreement']['rate']}).",
                  f"Across all camera rows: median {v['median']} mm, P90 {v['p90']} mm, max {v['max']} mm.", '']
    lines += ['## Three-camera median consensus', '',
        f"Complete triplets: {len(consensus)}; excluded incomplete triplets: {len(incomplete)}.",
        'For each complete capture, x and y are medianed across all three cameras. No presence threshold is applied.', '']
    for split, value in consensus_split.items():
        lines.append(f"- {split}: n={value['count']}, median/P90/max error mm={value['errorMm']['median']}/{value['errorMm']['p90']}/{value['errorMm']['max']}; segment agreement={value['segmentAgreementCount']}/{value['count']}; target within 3 mm of boundary={value['nearBoundary3mmCount']}.")
    lines += ['', '## Presence classifier', '']
    for split, value in presence_confusion.items():
        total_positive = value['truePositive'] + value['falseNegative']
        lines.append(f"- {split}: TP={value['truePositive']}, FN={value['falseNegative']}, FP={value['falsePositiveSynthetic']}, TN={value['trueNegativeSynthetic']} at threshold 0.5 (positive and synthetic-negative camera samples).")
    lines += ['', f"Synthetic identical-image presence false positives at 0.5: {negative_fp}/{negative_count} ({report['syntheticEmptyPairFalsePositiveRate']}); this is not real empty-board noise performance.", '']
    lines.append('The test split was consumed in earlier experiments; this report does not establish a fresh untouched test evaluation.')
    lines.append('')
    lines += ['See `board-metrics.json` for hashes, detailed metrics, and limitations.', '']
    (output_dir / 'REPORT.md').write_text('\n'.join(lines))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--predictions', type=Path, default=DEFAULT_OUTPUT/'predictions.json')
    parser.add_argument('--dataset', type=Path, default=None)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    dataset = args.dataset
    if dataset is None:
        metadata_path = args.output/'report.json'
        metadata = json.loads(metadata_path.read_text()) if metadata_path.is_file() else {}
        dataset = Path(metadata.get('targetsPath') or ROOT/'build/real-keypoints-v1/targets.json')
    report = run(args.predictions, dataset, args.output)
    print(f"wrote board metrics for {report['predictionCount']} predictions to {args.output}")


if __name__ == '__main__':
    main()
