"""Freeze a new development/validation/reserved-test expansion from fresh visits.

The previously reserved fresh-presence-holdout-v1 visits are permanently excluded.
This script reads only that frozen metadata and its source image/calibration files;
it does not update capture data, annotate images, or run model inference.
"""
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'build/fresh-presence-holdout-v1/manifest.json'
OUTPUT = ROOT / 'build/real-presence-expansion-v1'
CAMERAS = ('0', '1', '2')


def sha_file(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def verify_image(info):
    p = ROOT / info['path']
    actual = sha_file(p)
    if actual != info['sha256']:
        raise ValueError(f'image hash changed: {info["path"]}')
    return {'path': info['path'], 'sha256': actual, 'width': info['width'], 'height': info['height']}


def verify_calibration(cal):
    p = ROOT / cal['path']
    actual = sha_file(p)
    if actual != cal['sha256'] or actual != cal['id']:
        raise ValueError(f'calibration hash changed: {cal["path"]}')
    return {'id': cal['id'], 'path': cal['path'], 'sha256': actual, 'lastReadAt': cal.get('lastReadAt')}


def main():
    if OUTPUT.exists():
        raise SystemExit(f'refusing to overwrite {OUTPUT}')
    if not shutil.which('convert') or not shutil.which('montage'):
        raise SystemExit('ImageMagick convert and montage are required for review sheets')
    raw_source = SOURCE.read_bytes()
    source = json.loads(raw_source)
    if source.get('holdoutId') != 'fresh-presence-holdout-v1' or source.get('status') != 'frozen_unreviewed_no_inference':
        raise SystemExit('source fresh holdout is missing or no longer pre-inference')
    permanently_excluded = set(source['selectedBaselineIds'])
    old_holdout_capture_ids = set(permanently_excluded)
    for visit in source['visits']:
        if visit['baselineId'] in permanently_excluded:
            old_holdout_capture_ids.update(t['captureId'] for t in visit['throws'])
            old_holdout_capture_ids.update(t.get('reference', {}).get('captureId') for t in visit['throws'])
    candidates = [v for v in source['visits'] if v['eligible'] and v['baselineId'] not in permanently_excluded]
    candidates.sort(key=lambda v: (v.get('startedAt') or '', v['baselineId']))
    if len(candidates) != 84:
        raise SystemExit(f'expected 84 eligible unreserved visits, got {len(candidates)}')
    split_assignments = {}
    for i, visit in enumerate(candidates):
        split = 'development' if i < 50 else 'validation' if i < 67 else 'reserved-new-test'
        visit['expansionOrdinal'] = i + 1
        visit['expansionSplit'] = split
        split_assignments[visit['baselineId']] = split

    OUTPUT.mkdir(parents=True)
    sheet_dir = OUTPUT / 'contact-sheets'
    sheet_dir.mkdir()
    positive_rows = []
    for visit in candidates:
        baseline_id = visit['baselineId']
        cal = verify_calibration(visit['baseline']['calibration'])
        for throw in visit['throws']:
            cur_cal = verify_calibration(throw['calibration'])
            if cur_cal['id'] != cal['id']:
                raise ValueError(f'calibration changes inside visit {baseline_id}')
            ref = throw['reference']
            if ref['captureId'] not in {baseline_id, *(x['captureId'] for x in visit['throws'])}:
                raise ValueError(f'prefix reference escapes visit {baseline_id}')
            if ref['captureId'] in old_holdout_capture_ids or throw['captureId'] in old_holdout_capture_ids:
                raise ValueError('permanently reserved holdout endpoint leaked into expansion')
            for camera in CAMERAS:
                ref_image = verify_image(ref['images'][camera])
                cur_image = verify_image(throw['images'][camera])
                positive_rows.append({'rowId': f"presence:{throw['captureId']}:cam{camera}", 'split': visit['expansionSplit'], 'visitOrdinal': visit['expansionOrdinal'], 'baselineId': baseline_id, 'captureId': throw['captureId'], 'referenceCaptureId': ref['captureId'], 'camera': int(camera), 'referenceImage': ref_image, 'currentImage': cur_image, 'calibration': cur_cal, 'currentManifestPath': throw['manifestPath'], 'currentManifestSHA256': throw['manifestSHA256'], 'referenceManifestPath': ref['manifestPath'], 'referenceManifestSHA256': ref['manifestSHA256'], 'sourceEvent': {'reportedThrow': throw['reportedThrow'], 'occupancyPrefix': throw.get('occupancyPrefix')}, 'label': 'new_dart_reported_pending_visual_review', 'reviewStatus': 'pending'})

        panels = []
        panels.extend((f"visit {visit['expansionOrdinal']:02d} {visit['expansionSplit']} baseline cam{c}", visit['baseline']['images'][c]['path']) for c in CAMERAS)
        for ti, throw in enumerate(visit['throws'], 1):
            panels.extend((f"visit {visit['expansionOrdinal']:02d} {visit['expansionSplit']} throw{ti} cam{c}", throw['images'][c]['path']) for c in CAMERAS)
        thumbs = []
        for pi, (label, relpath) in enumerate(panels):
            thumb = sheet_dir / f'.v{visit["expansionOrdinal"]:02d}-{pi:02d}.jpg'
            proc = subprocess.run(['convert', str(ROOT / relpath), '-resize', '320x180!', '-gravity', 'south', '-background', '#181818', '-splice', '0x24', '-fill', 'white', '-stroke', 'none', '-pointsize', '12', '-annotate', '+0+4', label, str(thumb)], capture_output=True)
            if proc.returncode:
                raise RuntimeError(proc.stderr.decode(errors='replace'))
            thumbs.append(thumb)
        split_tag = visit['expansionSplit'].replace('-', '_')
        out = sheet_dir / f"{visit['expansionOrdinal']:02d}-{split_tag}.jpg"
        proc = subprocess.run(['montage', *map(str, thumbs), '-tile', '3x4', '-geometry', '+2+2', str(out)], capture_output=True)
        for path in thumbs:
            path.unlink(missing_ok=True)
        if proc.returncode:
            raise RuntimeError(proc.stderr.decode(errors='replace'))
        visit['contactSheet'] = str(out.resolve().relative_to(ROOT))
        visit['calibration'] = cal

    # Adjacent empty baselines pair only within each split, with all three cameras.
    empty_rows = []
    by_split = {name: [v for v in candidates if v['expansionSplit'] == name] for name in ('development', 'validation', 'reserved-new-test')}
    for split, visits in by_split.items():
        for older, newer in zip(visits, visits[1:]):
            older_cal = verify_calibration(older['baseline']['calibration'])
            newer_cal = verify_calibration(newer['baseline']['calibration'])
            for camera in CAMERAS:
                ref_image = verify_image(older['baseline']['images'][camera])
                cur_image = verify_image(newer['baseline']['images'][camera])
                empty_rows.append({'rowId': f"empty:{older['baselineId']}->{newer['baselineId']}:cam{camera}", 'split': split, 'referenceCaptureId': older['baselineId'], 'currentCaptureId': newer['baselineId'], 'camera': int(camera), 'referenceImage': ref_image, 'currentImage': cur_image, 'referenceCalibration': older_cal, 'currentCalibration': newer_cal, 'referenceManifestPath': older['baseline']['manifestPath'], 'referenceManifestSHA256': older['baseline']['manifestSHA256'], 'currentManifestPath': newer['baseline']['manifestPath'], 'currentManifestSHA256': newer['baseline']['manifestSHA256'], 'label': 'reported_empty_at_both_endpoints_pending_visual_review', 'reviewStatus': 'pending', 'continuityClaim': False})

    if any(row['referenceCaptureId'] in old_holdout_capture_ids or row['captureId'] in old_holdout_capture_ids for row in positive_rows):
        raise AssertionError('original holdout endpoint appeared in positive rows')
    if any(row['referenceCaptureId'] in old_holdout_capture_ids or row['currentCaptureId'] in old_holdout_capture_ids for row in empty_rows):
        raise AssertionError('original holdout endpoint appeared in empty rows')
    split_counts = {k: sum(v['expansionSplit'] == k for v in candidates) for k in by_split}
    manifest = {'schemaVersion': 1, 'expansionId': 'real-presence-expansion-v1', 'status': 'frozen_pending_visual_review_no_inference', 'sourceHoldout': {'holdoutId': source['holdoutId'], 'path': str(SOURCE.resolve().relative_to(ROOT)), 'sha256': hashlib.sha256(raw_source).hexdigest(), 'permanentlyExcludedBaselineIds': sorted(permanently_excluded), 'permanentlyExcludedCaptureIds': sorted(x for x in old_holdout_capture_ids if x)}, 'splitPolicy': 'Sort the 84 remaining eligible baseline-linked visits chronologically. First 50 are development, next 17 validation, final 17 reserved-new-test. Visit assignment is frozen before review or inference. Original fresh-presence-holdout-v1 selected visits and every endpoint are permanently excluded from all expansion splits.', 'counts': {'visitsBySplit': split_counts, 'positiveTransitionCount': len(positive_rows)//3, 'positiveCameraRows': len(positive_rows), 'emptyEndpointCameraRows': len(empty_rows), 'contactSheets': len(candidates)}, 'visits': candidates, 'positiveRows': positive_rows, 'emptyEndpointRows': empty_rows, 'reviewPolicy': {'mustReviewBeforeTrainingOrInference': True, 'newTestMustRemainUnseenUntilCandidateFreeze': True, 'reviewFile': 'build/real-presence-expansion-v1/review.json', 'decisionsRequiredForEveryRow': True}}
    (OUTPUT / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    all_row_ids = [x['rowId'] for x in positive_rows + empty_rows]
    review = {'schemaVersion': 1, 'expansionId': 'real-presence-expansion-v1', 'status': 'pending_manual_review', 'decisions': [], 'requiredRowIds': all_row_ids, 'decisionSchema': {'rowId': 'manifest rowId', 'decision': ['confirmed_presence', 'not_visible', 'ambiguous', 'contaminated_reference', 'confirmed_empty', 'contaminated_empty_endpoint'], 'reviewedBy': 'string', 'reviewedAt': 'ISO-8601 UTC', 'notes': 'optional string'}, 'rules': ['Review images before training, validation inference, or any candidate inference.', 'Presence is camera-specific; not_visible is excluded before inference and is never relabeled negative.', 'Empty endpoint pairs have no continuity claim; pair only within their fixed split.', 'Keep every row in reserved-new-test unseen until a candidate is frozen.', 'Do not modify raw captures, source annotations, this frozen split, or original holdout artifacts.']}
    (OUTPUT / 'review.json').write_text(json.dumps(review, indent=2) + '\n')
    readme = f"""# Real presence expansion v1

This manifest freezes 84 eligible visits left after permanently excluding all 12 visits in `fresh-presence-holdout-v1`: 50 development, 17 validation, and 17 reserved-new-test, assigned chronologically. The new-test split must remain unseen until a candidate is frozen. The original 12-visit holdout remains separate and untouched.

There are {len(positive_rows)} camera-level positive transition rows and {len(empty_rows)} adjacent empty-endpoint rows. Empty pairs are made only within their assigned split and make no continuous-empty claim. Every example is pending manual review; complete `review.json` before training or inference. No model inference was run for this expansion. The 84 review sheets are under `contact-sheets/`; filenames encode ordinal and split, and each is a 3-camera by 4-frame grid (baseline then throws 1–3).
"""
    (OUTPUT / 'README.md').write_text(readme)
    print(json.dumps(manifest['counts'], sort_keys=True))
    print(OUTPUT / 'manifest.json')

if __name__ == '__main__':
    main()
