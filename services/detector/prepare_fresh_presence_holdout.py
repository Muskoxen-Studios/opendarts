"""Freeze a fresh, baseline-linked real-capture presence holdout before inference.

Reads capture manifests, reviews, calibration snapshots and raw camera JPEGs. It does
not write into capture storage and never consults the historical test images.
"""
import hashlib
import json
import math
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CAPTURES = ROOT / 'data/board-captures'
FROZEN_DATASET = ROOT / 'build/reviewed-real-v1/dataset.json'
OUTPUT = ROOT / 'build/fresh-presence-holdout-v1'
CAMS = ('0', '1', '2')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def dimensions(raw):
    if not raw.startswith(b'\xff\xd8'):
        raise ValueError('not JPEG')
    i = 2
    while i < len(raw):
        if raw[i] != 255:
            i += 1
            continue
        while i < len(raw) and raw[i] == 255:
            i += 1
        if i >= len(raw):
            break
        marker = raw[i]
        i += 1
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            continue
        if i + 2 > len(raw):
            break
        length = int.from_bytes(raw[i:i+2], 'big')
        if length < 2 or i + length > len(raw):
            break
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            return int.from_bytes(raw[i+5:i+7], 'big'), int.from_bytes(raw[i+3:i+5], 'big')
        i += length
    raise ValueError('JPEG dimensions missing')


def image_info(directory, m):
    records = m.get('cameras') or []
    if len(records) != 3 or {str(x.get('camera')) for x in records} != set(CAMS):
        raise ValueError('expected camera records 0, 1, 2')
    result = {}
    for c in CAMS:
        row = next(x for x in records if str(x.get('camera')) == c)
        if row.get('error') or row.get('file') != f'camera-{c}.jpg':
            raise ValueError(f'camera {c} capture error or unexpected filename')
        p = directory / row['file']
        raw = p.read_bytes()
        w, h = dimensions(raw)
        if (w, h) != (1280, 720):
            raise ValueError(f'camera {c} dimensions {w}x{h}')
        result[c] = {'path': str(p.resolve().relative_to(ROOT)), 'sha256': sha(raw), 'width': w, 'height': h}
    return result


def occupancy(m, side):
    return (m.get('reportedOccupancy' + side) or {}).get('throws')


def cal_info(m):
    cal = m.get('calibration') or {}
    if not cal.get('id') or not cal.get('path') or cal.get('error'):
        raise ValueError('missing or errored linked calibration')
    p = CAPTURES / cal['path']
    raw = p.read_bytes()
    digest = sha(raw)
    if digest != cal['id']:
        raise ValueError('linked calibration hash does not match calibration id')
    data = json.loads(raw)
    c = data.get('calibration', data)
    cams = c.get('cams')
    if c.get('calibrated') is not True or not isinstance(cams, list) or len(cams) != 3:
        raise ValueError('linked calibration is not calibrated for three cameras')
    for i, cam in enumerate(cams):
        if cam.get('calibrated') is not True or cam.get('width') != 1280 or cam.get('height') != 720:
            raise ValueError(f'calibration camera {i} invalid')
        h = cam.get('homography')
        if not isinstance(h, list) or len(h) != 3 or any(not isinstance(row, list) or len(row) != 3 or any(type(v) not in (int, float) or not math.isfinite(v) for v in row) for row in h):
            raise ValueError(f'calibration camera {i} homography invalid')
    return {'id': cal['id'], 'path': str(p.resolve().relative_to(ROOT)), 'sha256': digest, 'lastReadAt': cal.get('lastReadAt')}


def main():
    if OUTPUT.exists():
        raise SystemExit(f'refusing to overwrite {OUTPUT}')
    if not shutil.which('convert') or not shutil.which('montage'):
        raise SystemExit('ImageMagick convert and montage are required for review sheets')
    frozen = json.loads(FROZEN_DATASET.read_text())
    frozen_ids = {r['id'] for r in frozen['records']} | {x['id'] for x in frozen['exclusions']}
    manifests = {}
    for p in sorted(CAPTURES.glob('*/manifest.json')):
        try:
            m = json.loads(p.read_text())
            if m.get('captureId'):
                manifests[m['captureId']] = (p, m)
        except (OSError, ValueError):
            continue
    fresh_throws = [(cid, pair) for cid, pair in manifests.items()
                    if pair[1].get('type') == 'throw' and cid not in frozen_ids]
    groups = {}
    for cid, (p, m) in fresh_throws:
        groups.setdefault(m.get('baselineForThrow'), []).append((cid, p, m))

    baseline_rows = []
    for cid, (p, m) in manifests.items():
        if m.get('type') == 'empty-board-baseline' and cid not in frozen_ids:
            baseline_rows.append({'captureId': cid, 'manifestPath': str(p.resolve().relative_to(ROOT)), 'manifestSHA256': sha(p.read_bytes()), 'captureStartedAt': m.get('captureStartedAt'), 'reportedOccupancyBefore': occupancy(m, 'Before'), 'reportedOccupancyAfter': occupancy(m, 'After')})

    visit_rows, eligible = [], []
    for baseline_id, rows in groups.items():
        rows.sort(key=lambda x: x[2].get('captureStartedAt', ''))
        base_entry = manifests.get(baseline_id)
        reasons = []
        base_meta = None
        if not baseline_id or not base_entry or base_entry[1].get('type') != 'empty-board-baseline' or baseline_id in frozen_ids:
            reasons.append('baseline_missing_not_empty_or_frozen')
        else:
            bp, bm = base_entry
            if bm.get('status') != 'complete' or bm.get('sceneChangedDuringCapture') is not False:
                reasons.append('baseline_incomplete_or_unstable')
            for side in ('Before', 'After'):
                st = bm.get('reportedOccupancy' + side) or {}
                if st.get('connected') is not True or st.get('running') is not True or st.get('throws') != []:
                    reasons.append(f'baseline_{side.lower()}_not_verified_empty')
            try:
                base_meta = {'captureId': baseline_id, 'manifestPath': str(bp.resolve().relative_to(ROOT)), 'manifestSHA256': sha(bp.read_bytes()), 'captureStartedAt': bm.get('captureStartedAt'), 'images': image_info(bp.parent, bm), 'calibration': cal_info(bm)}
            except Exception as e:
                reasons.append('baseline_assets_invalid: ' + str(e))
        if len(rows) != 3:
            reasons.append(f'visit_has_{len(rows)}_throws_instead_of_three')
        throw_rows = []
        prev_by_prefix = {(): (baseline_id, base_entry[0], base_entry[1])} if base_entry else {}
        # Candidate exact-prefix references must be in the same linked visit and precede the throw.
        for cid, p, m in rows:
            mr = {'captureId': cid, 'manifestPath': str(p.resolve().relative_to(ROOT)), 'manifestSHA256': sha(p.read_bytes()), 'captureStartedAt': m.get('captureStartedAt'), 'reportedThrow': m.get('reportedThrow')}
            if m.get('status') != 'complete' or m.get('sceneChangedDuringCapture') is not False:
                reasons.append(f'{cid}:throw_incomplete_or_unstable')
            for side in ('Before', 'After'):
                st = m.get('reportedOccupancy' + side) or {}
                if st.get('connected') is not True or st.get('running') is not True:
                    reasons.append(f'{cid}:occupancy_{side.lower()}_not_connected_running')
            before, after = occupancy(m, 'Before'), occupancy(m, 'After')
            if not isinstance(before, list) or not isinstance(after, list) or len(before) != 1 + len(throw_rows) or len(after) != len(before) or after[:-1] != before or after[-1:] != before[-1:]:
                # The prefix is checked below by relation to actual reported throw identity; retain a clear failure.
                if not isinstance(before, list) or not isinstance(after, list) or len(before) not in (1, 2, 3) or len(after) != len(before):
                    reasons.append(f'{cid}:occupancy_prefix_unknown_or_wrong_length')
            if not isinstance(before, list) or not before or len(before) > 3:
                reasons.append(f'{cid}:occupancy_before_not_known_prefix')
                prefix = None
            else:
                prefix = tuple(json.dumps(x, sort_keys=True) for x in before[:-1])
                # Verify reported occupancy grows by exactly the current reported dart.
                reported = m.get('reportedThrow') or {}
                after = occupancy(m, 'After')
                if not isinstance(after, list) or after != before:
                    reasons.append(f'{cid}:after_occupancy_not_exact_extension')
                choices = []
                for rid, rp, rm in [*[(baseline_id, *(base_entry or (None, None)))], *[(x[0], x[1], x[2]) for x in rows if x[0] != cid]]:
                    if not rp or not rm or rm.get('captureFinishedAt', '') >= m.get('captureStartedAt', ''):
                        continue
                    occ_after = occupancy(rm, 'After')
                    if isinstance(occ_after, list) and tuple(json.dumps(x, sort_keys=True) for x in occ_after) == prefix:
                        choices.append((rm.get('captureFinishedAt', ''), rid, rp, rm))
                if not choices:
                    reasons.append(f'{cid}:no_exact_earlier_occupancy_prefix_reference')
                else:
                    _, ref_id, rp, rm = max(choices)
                    try:
                        ref_images = image_info(rp.parent, rm)
                        mr['reference'] = {'captureId': ref_id, 'manifestPath': str(rp.resolve().relative_to(ROOT)), 'manifestSHA256': sha(rp.read_bytes()), 'captureFinishedAt': rm.get('captureFinishedAt'), 'images': ref_images}
                    except Exception as e:
                        reasons.append(f'{cid}:prefix_reference_assets_invalid: {e}')
            try:
                mr['images'] = image_info(p.parent, m)
                mr['calibration'] = cal_info(m)
            except Exception as e:
                reasons.append(f'{cid}:throw_assets_invalid: {e}')
            throw_rows.append(mr)
        cals = {r.get('calibration', {}).get('id') for r in throw_rows if r.get('calibration')}
        if base_meta and base_meta.get('calibration'):
            cals.add(base_meta['calibration']['id'])
        if len(cals) != 1:
            reasons.append('visit_calibration_id_not_stable')
        visit = {'baselineId': baseline_id, 'baseline': base_meta, 'throws': throw_rows, 'startedAt': (base_meta or {}).get('captureStartedAt'), 'throwCount': len(rows), 'eligible': not reasons, 'exclusionReasons': sorted(set(reasons))}
        visit_rows.append(visit)
        if visit['eligible']:
            eligible.append(visit)
    eligible.sort(key=lambda v: (v.get('startedAt') or '', v['baselineId'] or ''))
    if len(eligible) < 12:
        raise SystemExit(f'only {len(eligible)} eligible visits; expected at least 12')
    chosen_indexes = [round(i * (len(eligible)-1) / 11) for i in range(12)]
    selected = [eligible[i] for i in chosen_indexes]
    for i, visit in enumerate(selected, 1):
        visit['selectionOrder'] = i

    OUTPUT.mkdir(parents=True)
    contact_dir = OUTPUT / 'contact-sheets'
    contact_dir.mkdir()
    for ix, visit in enumerate(selected, 1):
        temp, thumbs = [], []
        panels = []
        # Each visit sheet: 3 cameras for the empty baseline, then 3 cameras for each current throw.
        panels.extend((f"baseline {visit['baselineId'][-8:]} cam{c}", visit['baseline']['images'][c]['path']) for c in CAMS)
        for ti, throw in enumerate(visit['throws'], 1):
            panels.extend((f"throw {ti} {throw['captureId'][-8:]} cam{c}", throw['images'][c]['path']) for c in CAMS)
        for pi, (label, relpath) in enumerate(panels):
            out = contact_dir / f'.visit-{ix:02d}-{pi:02d}.jpg'
            cmd = ['convert', str(ROOT / relpath), '-resize', '320x180!', '-gravity', 'south', '-background', '#181818', '-splice', '0x22', '-fill', 'white', '-stroke', 'none', '-pointsize', '12', '-annotate', '+0+4', label, str(out)]
            proc = subprocess.run(cmd, capture_output=True)
            if proc.returncode:
                raise RuntimeError(proc.stderr.decode(errors='replace'))
            temp.append(out)
        output = contact_dir / f'visit-{ix:02d}.jpg'
        proc = subprocess.run(['montage', *map(str, temp), '-tile', '3x4', '-geometry', '+2+2', str(output)], capture_output=True)
        for p in temp:
            p.unlink(missing_ok=True)
        if proc.returncode:
            raise RuntimeError(proc.stderr.decode(errors='replace'))
        visit['contactSheet'] = str(output.resolve().relative_to(ROOT))

    result = {'schemaVersion': 1, 'holdoutId': 'fresh-presence-holdout-v1', 'status': 'frozen_unreviewed_no_inference', 'createdAtUtc': '2026-11-17', 'selectionPolicy': 'From all eligible uncatalogued post-freeze visits, choose 12 evenly spaced chronological indices with first and last included; eligibility does not inspect images visually or detector outputs.', 'labelPolicy': 'Presence only: each throw current frame is paired with the immediately prior frame whose complete reported occupancy exactly matches the current frame occupancy prefix. Presence labels remain pending visual review. Board score/coordinates are retained as metadata only and are not passed to any detector.', 'sourceDataset': {'datasetId': frozen.get('datasetId'), 'path': str(FROZEN_DATASET.resolve().relative_to(ROOT)), 'sha256': sha(FROZEN_DATASET.read_bytes()), 'frozenCaptureIdsExcluded': len(frozen_ids)}, 'counts': {'freshThrowCaptures': len(fresh_throws), 'baselineLinkedVisits': len(visit_rows), 'eligibleThreeThrowVisits': len(eligible), 'selectedVisits': len(selected), 'selectedThrowCaptures': sum(len(v['throws']) for v in selected), 'selectedPairs': sum(len(v['throws']) for v in selected), 'excludedVisits': sum(not v['eligible'] for v in visit_rows)}, 'freshBaselines': baseline_rows, 'visits': visit_rows, 'selectedBaselineIds': [v['baselineId'] for v in selected]}
    selected_order = sorted(selected, key=lambda v: v['selectionOrder'])
    result['positivePairs'] = []
    for visit in selected_order:
        for throw in visit['throws']:
            reference = throw['reference']
            for camera in CAMS:
                result['positivePairs'].append({'pairId': f"presence:{throw['captureId']}:cam{camera}", 'referenceCaptureId': reference['captureId'], 'currentCaptureId': throw['captureId'], 'camera': int(camera), 'referenceImagePath': reference['images'][camera]['path'], 'referenceImageSHA256': reference['images'][camera]['sha256'], 'currentImagePath': throw['images'][camera]['path'], 'currentImageSHA256': throw['images'][camera]['sha256'], 'referenceCalibration': throw['calibration'], 'currentCalibration': throw['calibration'], 'label': 'new_dart_reported_pending_visual_confirmation', 'reviewStatus': 'pending', 'contactSheet': visit['contactSheet']})
    negative_pairs = []
    for older, newer in zip(selected_order, selected_order[1:]):
        for camera in CAMS:
            ref, cur = older['baseline'], newer['baseline']
            negative_pairs.append({'pairId': f"empty:{older['baselineId']}->{newer['baselineId']}:cam{camera}", 'referenceCaptureId': ref['captureId'], 'currentCaptureId': cur['captureId'], 'camera': int(camera), 'referenceImagePath': ref['images'][camera]['path'], 'referenceImageSHA256': ref['images'][camera]['sha256'], 'currentImagePath': cur['images'][camera]['path'], 'currentImageSHA256': cur['images'][camera]['sha256'], 'referenceCalibration': ref['calibration'], 'currentCalibration': cur['calibration'], 'label': 'no_new_dart_reported_empty_at_both_snapshots', 'reviewStatus': 'pending', 'continuityClaim': False})
    result['negativeChallenge'] = {'policy': 'Adjacent selected chronological visit empty baselines, older to newer, all cameras. Endpoint metadata labels only; no continuous-empty inference. Review contamination blind before any candidate inference.', 'pairCount': len(negative_pairs), 'tripletCount': len(negative_pairs)//3, 'pairs': negative_pairs}
    result['counts']['positivePairs'] = len(result['positivePairs'])
    result['reviewPolicy'] = {'reviewMustPrecedeInference': True, 'status': 'pending_visual_review', 'reviewFile': 'build/fresh-presence-holdout-v1/review.json', 'allowedPairDecisions': ['confirmed_presence', 'not_visible', 'ambiguous', 'contaminated_reference', 'confirmed_empty', 'contaminated_empty_endpoint'], 'decisionMeaning': 'confirmed_presence means visible new dart for that camera; not_visible means exclude the camera pair before inference, not relabel negative.'}
    review = {'schemaVersion': 1, 'holdoutId': 'fresh-presence-holdout-v1', 'status': 'pending_visual_review', 'reviewBeforeInference': True, 'decisions': [], 'decisionSchema': {'pairId': 'manifest pairId', 'decision': result['reviewPolicy']['allowedPairDecisions'], 'reviewedBy': 'string', 'reviewedAt': 'ISO-8601 UTC', 'notes': 'optional string'}, 'rules': ['Review selected contact sheets and source frames before any candidate inference.', 'For a presence pair, confirm a newly visible dart in the current camera image relative to its occupancy-prefix reference. not_visible means exclude this camera pair before inference, never relabel it negative.', 'For an empty pair, confirm both endpoints are empty; if either is contaminated, record that blind and exclude the pair before inference.', 'Do not change source captures or manifest labels. Ambiguous and not-visible rows remain documented and are not silently removed.']}
    (OUTPUT / 'review.json').write_text(json.dumps(review, indent=2) + '\n')
    target = OUTPUT / 'manifest.json'
    target.write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
    (OUTPUT / 'README.md').write_text('# Fresh real presence holdout\n\nThis cohort was reserved from post-freeze captures before any candidate inference. It remains **unreviewed**: inspect the contact sheets and source frames, confirm each visible presence transition and calibration association, then mark review status separately. No model was run.\n\nThe manifest records all fresh baseline-linked groups and eligibility/exclusion reasons. The selected 12 visits are chronologically spaced and each contains an empty reference plus three current throw frames, across all three cameras. This is a new-session diagnostic cohort, not by itself a broad detector-readiness claim. Scores and board coordinates are metadata only and must not be fed to detector extraction.\n\nContact sheets are 3 columns by 4 rows (baseline, then throws 1–3; each row group has cameras 0–2).\n')
    print(json.dumps(result['counts'], sort_keys=True))
    print(target)

if __name__ == '__main__':
    main()
