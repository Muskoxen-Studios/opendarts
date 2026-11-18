"""Pixel-only, single-increment evaluation on frozen reviewed real captures.

Labels are loaded only after detector prediction and are used for scoring/overlays.
This is an experimental geometric baseline, not the temporal native service.
"""
import argparse
import hashlib
import json
import math
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import real_foreground as fg
from rendered import CAMERAS, PerspectiveDetector
from rendered import changed_pixels
from vision import confident_segment

GRAY_CACHE = {}


def gray_bounded(path):
    path = str(path)
    if path not in GRAY_CACHE:
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-vf', 'format=gray',
                              '-f', 'rawvideo', '-'], check=True, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, timeout=20).stdout
        if len(raw) != 1280*720:
            raise ValueError(f'expected 1280x720 grayscale, got {len(raw)} bytes')
        GRAY_CACHE[path] = raw
    return GRAY_CACHE[path]


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def points(mask, camera, calibration):
    d = calibration.get('distortion', [])
    # Existing run component extractor and parameters are intentionally unchanged.
    blobs = fg.components(mask)
    raw = []
    for blob in blobs:
        try:
            raw.extend(fg.shaft_candidates(blob, parameters=fg.PARAMETERS))
        except ValueError:
            pass
    raw.sort(key=lambda c: c[1][1], reverse=True)
    pixels = [(x, y) for blob in blobs for x, y in blob]
    # Points and fitted lines share the undistorted pinhole coordinate frame used
    # by imported R/t. The same undistorted points are used by envelope validation.
    k = calibration['K']
    undistorted = [fg_undistort((x, y), k, d) for x, y in pixels]
    return undistorted, raw, len(blobs), sum(mask)


def fg_undistort(pixel, k, d):
    # Calibration importer owns the established Brown-Conrady inverse routine.
    from import_board_calibration import undistort
    return undistort(pixel, k, d)


def calibration_for(path):
    obj = json.loads(Path(path).read_text())
    result = {}
    for i, key in enumerate(CAMERAS):
        c = obj['cameras'][str(i)]
        result[key] = {'width': c['width'], 'height': c['height'],
                       'K': c['K'], 'R': c['R'],
                       't': tuple(c['t']), 'distortion': c.get('distortion', [])}
    return result


def image_path(record, cam, captures, baseline=False):
    key = ('previousFrameCameraPaths' if record.get('previousFrameCameraPaths') else 'baselineCameraPaths') if baseline else 'cameraPaths'
    paths = record.get(key)
    if paths and str(cam) in paths:
        p = Path(paths[str(cam)])
        return p if p.is_absolute() else ROOT / p
    ident = (record.get('previousFrameCaptureId') or record.get('baselineId')) if baseline else record.get('captureId')
    if not ident:
        raise ValueError('missing baseline/capture identifier')
    return captures / ident / f'camera-{cam}.jpg'


def overlay(path, source, lines, predicted, label):
    import base64
    w, h = 1280, 720
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">',
             f'<image href="data:image/jpeg;base64,{base64.b64encode(source.read_bytes()).decode()}" width="{w}" height="{h}"/>']
    parts.append('<text x="12" y="24" fill="#ffffff" stroke="#111111" stroke-width="3" paint-order="stroke">retrospective current calibration assumption</text>')
    # Raw pixel candidate fits are red; board positions are projected retrospectively
    # into this camera only after prediction has completed.
    for (a, b, c), support in lines[:8]:
        sx, sy = support[0]
        offset = a*sx + b*sy + c
        cx, cy = sx-a*offset, sy-b*offset
        parts.append(f'<line x1="{cx+b*support[1]/2:.2f}" y1="{cy-a*support[1]/2:.2f}" x2="{cx-b*support[1]/2:.2f}" y2="{cy+a*support[1]/2:.2f}" stroke="#ff3030" stroke-width="2"/>')
    if predicted:
        x, y = predicted
        parts.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="9" fill="none" stroke="#00e5ff" stroke-width="3"/><text x="{x+12:.2f}" y="{y:.2f}" fill="#00e5ff">prediction</text>')
    if label:
        x, y = label
        parts.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="7" fill="none" stroke="#ffe600" stroke-width="3"/><text x="{x+12:.2f}" y="{y+16:.2f}" fill="#ffe600">review label</text>')
    parts.append('</svg>')
    path.write_text('\n'.join(parts))


def run_record(rec, args, cal, out):
    started = time.monotonic()
    capture_id = rec.get('captureId', rec['id'])
    result = {'id': rec['id'], 'captureId': capture_id, 'baselineId': rec.get('baselineId'),
              'previousFrameCaptureId': rec.get('previousFrameCaptureId'),
              'split': rec.get('split'), 'calibration': rec.get('calibration'), 'stage': 'load', 'cameras': {}}
    current = {}; prior = {}; paths = {}
    for cam in range(3):
        cp = image_path(rec, cam, args.captures)
        bp = image_path(rec, cam, args.captures, baseline=True)
        paths[str(cam)] = {'current': str(cp), 'baseline': str(bp), 'currentSha256': digest(cp), 'baselineSha256': digest(bp)}
        current[cam] = gray_bounded(cp); prior[cam] = gray_bounded(bp)
    masks = {}; pp = {}; candidate_lines = {}; strict = {}
    for cam in range(3):
        try:
            changed = changed_pixels(current[cam], prior[cam], 1280, 720, fg.PARAMETERS)
            strict[str(cam)] = {'status': 'pass', 'changedPixels': len(changed)}
        except ValueError as exc:
            strict[str(cam)] = {'status': 'reject', 'reason': str(exc)[:160]}
        masks[cam], offset = fg.foreground(current[cam], prior[cam], cam)
        pp[CAMERAS[cam]], raw, nblobs, count = points(masks[cam], cam, cal[CAMERAS[cam]])
        candidate_lines[cam] = raw
        result['cameras'][str(cam)] = {'offsetGray': offset, 'foregroundPixels': count,
            'componentCountMin8': nblobs, 'rawCandidateCount': len(raw),
            'topCandidates': [{'line': list(c[0]), 'supportCenter': list(c[1][0]), 'supportPx': c[1][1]} for c in raw[:8]]}
    result['sourceHashes'] = paths
    result['strictChangedGate'] = strict
    source = SimpleNamespace(calibrations={k: {'width': cal[k]['width'], 'height': cal[k]['height'],
                             'K': tuple(v for row in cal[k]['K'] for v in row),
                             'R': tuple(v for row in cal[k]['R'] for v in row), 't': cal[k]['t']}
                             for k in CAMERAS},
                             reference={}, width=1280, height=720)
    detector = PerspectiveDetector(source, fg.PARAMETERS)
    result['stage'] = 'candidate-resolution'
    try:
        prediction, uncertainty = detector.resolve_axis(pp)
        result['predictionMm'] = list(prediction); result['uncertaintyMm'] = uncertainty
        result['diagnostics'] = detector.diagnostics
        result['stage'] = 'score'
        predicted_segment, _ = confident_segment(*prediction, uncertainty)
        result['predictedSegment'] = predicted_segment
        # Label access begins only after the complete detector prediction/acceptance.
        label = rec['label']
        truth = label.get('correctedCoords') or label.get('coords')
        result['labelCoordsMm'] = truth
        result['labelSegment'] = label.get('segment')
        result['errorMm'] = math.dist(prediction, (truth['x'], truth['y'])) if truth else None
        result['wrongSegment'] = bool(label.get('segment') and predicted_segment != label['segment'])
        result['labelProvenance'] = label.get('provenance')
        result['stage'] = 'accepted'
    except Exception as exc:
        result['error'] = f'{type(exc).__name__}: {str(exc)[:240]}'
        result['diagnostics'] = detector.diagnostics
        result['stage'] = 'rejected'
    overlay_dir = out / 'overlays' / capture_id; overlay_dir.mkdir(parents=True, exist_ok=True)
    for cam in range(3):
        cp = Path(paths[str(cam)]['current'])
        pred_px = label_px = None
        if result['stage'] == 'accepted':
            from rendered import project
            c = detector.calibrations[CAMERAS[cam]]
            pred_px = project(c, (*result['predictionMm'], 0))
            truth = result.get('labelCoordsMm')
            if truth:
                label_px = project(c, (truth['x'], truth['y'], 0))
        overlay(overlay_dir / f'camera-{cam}.svg', cp, candidate_lines.get(cam, []), pred_px, label_px)
    result['elapsedSeconds'] = round(time.monotonic() - started, 3)
    print(f"{capture_id}: {result['stage']} ({result['elapsedSeconds']}s)", flush=True)
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--dataset', type=Path, default=ROOT/'build/reviewed-real-v1/dataset.json')
    ap.add_argument('--calibration', type=Path, default=ROOT/'build/real-board-calibration.json')
    ap.add_argument('--captures', type=Path, default=ROOT/'data/board-captures')
    ap.add_argument('--output', type=Path, default=ROOT/'build/reviewed-real-evaluation')
    ap.add_argument('--split', choices=['development', 'validation', 'test'], default='development')
    ap.add_argument('--limit', type=int, default=12)
    ap.add_argument('--case', action='append', default=[])
    args = ap.parse_args()
    dataset = json.loads(args.dataset.read_text())
    records = [r for r in dataset['records'] if r.get('split') == args.split]
    if args.case: records = [r for r in records if r.get('captureId') in args.case or r.get('id') in args.case]
    records = records[:max(0, args.limit)]
    cal = calibration_for(args.calibration); args.output.mkdir(parents=True, exist_ok=True)
    rows = []
    for rec in records:
        try: rows.append(run_record(rec, args, cal, args.output))
        except Exception as exc:
            rows.append({'id': rec.get('id'), 'captureId': rec.get('captureId', rec.get('id')), 'stage': 'input-error',
                         'error': f'{type(exc).__name__}: {str(exc)[:240]}'})
            print(f"{rec.get('captureId')}: input-error", flush=True)
    report = {'format': 'reviewed-real-single-increment-v1', 'datasetId': dataset.get('datasetId'),
              'datasetSha256': digest(args.dataset), 'calibrationUsed': str(args.calibration.resolve()),
              'calibrationSha256': digest(args.calibration),
              'calibrationAssumption': 'Retrospective current imported camera calibration is applied to historical images; temporal mount agreement is unverified.',
              'implementationSha256': digest(Path(__file__)), 'foregroundImplementationSha256': digest(HERE/'real_foreground.py'),
              'parameterFileSha256': digest(HERE/'led-ring.parameters.json'), 'split': args.split,
              'candidateCount': len(records), 'results': rows,
              'limitations': ['Experimental single-increment fit only; not full native service acceptance.',
                              'No temporal stability, occupancy reconciliation, or event emission.',
                              'Calibration is retrospectively selected and may not match capture-time mounts.',
                              'Only accepted predictions count as scored; rejects are not correct predictions.']}
    report['stageCounts'] = {stage: sum(r.get('stage') == stage for r in rows)
                             for stage in sorted({r.get('stage') for r in rows})}
    report['failureReasons'] = {reason: sum(r.get('error') == reason for r in rows)
                                for reason in sorted({r.get('error') for r in rows if r.get('error')})}
    report['strictChangedGateReasons'] = {}
    for row in rows:
        for cam in row.get('strictChangedGate', {}).values():
            if cam.get('status') == 'reject':
                reason = cam.get('reason', 'unknown')
                report['strictChangedGateReasons'][reason] = report['strictChangedGateReasons'].get(reason, 0) + 1
    (args.output/'results.json').write_text(json.dumps(report, indent=2)+'\n')
    accepted = [r for r in rows if r.get('stage') == 'accepted']
    errors = [r['errorMm'] for r in accepted if r.get('errorMm') is not None]
    print(f"summary: {len(accepted)}/{len(rows)} accepted; median error {sorted(errors)[len(errors)//2] if errors else 'n/a'} mm; output {args.output}")

if __name__ == '__main__': main()
