"""Offline labelled rendered evaluation. Labels never cross the detector boundary.

Run: python benchmark.py evaluate DATASET --output report.json
     python benchmark.py tune DATASET --output tuning.json --trials 20 --seed 1
Outputs are offline artifacts, never active detector configuration.

Ranking is lexicographic: no phantom/duplicate/removal errors beats any such
error, then fewer wrong accepts, greater required nonempty-step coverage, lower
mean matched localization error, and earlier trial index. Runtime is excluded.
The legacy objective is informational: coverage - 1000 * wrong accepts.
A nonempty step counts only when its entire occupancy and scores are correct;
repeat/nonempty removal steps also count, not just newly added darts. Empty
successes remain reported but earn no tuning reward. Reject-all has zero impact
coverage; safety-first ranking may still prefer it to unsafe candidates. With no
required nonempty steps, coverage is unavailable, not evidence of detection.
Trial 0 (baseline) always joins the train shortlist. Completed validation summaries
are retained across resumes, and selection considers all validated trials. Selection
requires zero safety errors and positive impact coverage; otherwise it is null with
an explicit status/reason. An unfinished shortlist resumes before new train work.

Trials 0..7 explore defaults/coupled bounded draws, with a full draw every fourth
trial. Exploration continues while the safety-ranked best train trial has zero
impact coverage. Only then do trials mutate 1..4 parameters within 10% of their
bounded ranges around that best trial. Uncertainty is sampled without a downward
bias; acceptance and safety invariants are never tuned.
The phase depends on completed trial count and train results, never total budget.
Checkpoint trials expose phase/parentTrial; config records the search constants.
Existing checkpoints from older implementations fail compatibility checks.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import random
import tempfile
import time

from main import strict_json
from parameters import DEFAULT_PARAMETERS, DetectionParameters, PARAMETER_BOUNDS
from rendered import CAMERAS, PerspectiveDetector, RenderedSource, gray
from vision import confident_segment, distance, occupancy_changes, segment

VERSION = 1
EXPLORATION_TRIALS = 8
LOCAL_RADIUS_FRACTION = 0.1
FULL_DRAW_INTERVAL = 4
EXPLORATION_GROUPS = (
    ('difference_threshold_gray', 'blob_threshold_gray', 'max_changed_fraction',
     'min_blob_pixels', 'max_shaft_width_px'),
    ('hough_sample_target', 'hough_angle_step_deg', 'hough_rho_bin_px',
     'hough_peaks_per_angle', 'hough_proposal_limit'),
    ('section_bin_px', 'core_half_width_px', 'core_max_gap_bins', 'min_core_pixels',
     'min_shaft_length_px', 'min_support_fraction', 'max_core_residual_px',
     'section_center_tolerance_px', 'max_empty_section_bins', 'min_section_bins',
     'max_section_residual_px'),
    ('candidate_normal_similarity', 'candidate_offset_tolerance_px', 'max_candidates',
     'min_triangulation_condition', 'max_impact_radius_mm', 'max_shaft_slope',
     'max_reprojection_error_px'),
    ('line_offset_uncertainty_px', 'refine_uncertainty_mm', 'refine_short_support_px',
     'comparable_support_fraction', 'refine_reprojection_penalty', 'ambiguity_distance_mm'),
    ('shaft_envelope_length_mm', 'flight_radius_mm', 'min_envelope_radius_px'),
)


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
            name = stream.name
            json.dump(value, stream, sort_keys=True, indent=2, allow_nan=False)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


def load_dataset(path):
    """Validate and snapshot every referenced file; hash content, not filenames alone."""
    if os.environ.get('DETECTOR_CAPTURE'):
        raise ValueError('unset DETECTOR_CAPTURE for offline evaluation')
    path = Path(path).resolve()
    digest = hashlib.sha256()
    cache = {}

    def read(relative):
        if type(relative) is not str or Path(relative).is_absolute():
            raise ValueError('dataset references must be relative paths')
        target = (path.parent / relative).resolve()
        if not target.is_relative_to(path.parent):
            raise ValueError('dataset reference escapes dataset directory')
        if relative not in cache:
            raw = target.read_bytes()
            digest.update(relative.encode() + b'\0' + len(raw).to_bytes(8, 'big') + raw)
            cache[relative] = strict_json(raw)
        return cache[relative]

    manifest = read(path.name)
    if type(manifest) is not dict or type(manifest.get('version')) is not int or manifest['version'] != 1:
        raise ValueError('unsupported dataset version')
    if type(manifest.get('cases')) is not list or not manifest['cases']:
        raise ValueError('dataset needs cases')
    cases, ids = [], set()
    for case in manifest['cases']:
        if type(case) is not dict:
            raise ValueError('case must be an object')
        if type(case.get('id')) is not str or not case['id'] or case['id'] in ids:
            raise ValueError('case ids must be unique nonempty strings')
        ids.add(case['id'])
        if type(case.get('family')) is not str or not case['family'] or case.get('split') not in ('train', 'validation', 'test'):
            raise ValueError('invalid family or split')
        config = read(case.get('configuration'))
        source = RenderedSource.configured(config)
        if type(case.get('steps')) is not list or not case['steps']:
            raise ValueError('case needs steps')
        steps = []
        for step in case['steps']:
            if type(step) is not dict or type(step.get('expected')) is not list or type(step.get('allowReject')) is not bool:
                raise ValueError('invalid step labels')
            expected = step['expected']
            if any(type(p) is not list or len(p) != 2 or any(type(v) not in (int, float) or not math.isfinite(v) for v in p) for p in expected):
                raise ValueError('expected must contain finite xy pairs')
            tolerance = step.get('toleranceMm', 3)
            if type(tolerance) not in (int, float) or not math.isfinite(tolerance) or tolerance <= 0:
                raise ValueError('toleranceMm must be positive and finite')
            images = read(step.get('images'))
            if type(images) is not dict or set(images) != set(CAMERAS):
                raise ValueError('images must contain cam0..cam2 only')
            for value in images.values():
                gray(value, source.width * source.height)
            steps.append(dict(images=images, expected=expected, allowReject=step['allowReject'], toleranceMm=tolerance))
        cases.append(dict(id=case['id'], family=case['family'], split=case['split'], configuration=config, steps=steps))
    return {'hash': digest.hexdigest(), 'cases': cases}


def correspondence(expected, actual, tolerance):
    """Maximum-cardinality, minimum-distance one-to-one assignment (small occupancy)."""
    best = ([], float('inf'))

    def visit(index, used, pairs, total):
        nonlocal best
        if index == len(expected):
            if len(pairs) > len(best[0]) or (len(pairs) == len(best[0]) and total < best[1]):
                best = (list(pairs), total)
            return
        visit(index + 1, used, pairs, total)
        for j, point in enumerate(actual):
            error = distance(expected[index], point)
            if j not in used and error <= tolerance:
                visit(index + 1, used | {j}, pairs + [(index, j, error)], total + error)

    visit(0, set(), [], 0)
    return best[0]


def evaluate(dataset, parameters=DEFAULT_PARAMETERS, splits=('train', 'validation', 'test')):
    if os.environ.get('DETECTOR_CAPTURE'):
        raise ValueError('unset DETECTOR_CAPTURE for offline evaluation')
    rows = []
    started = time.perf_counter()
    for case in dataset['cases']:
        if case['split'] not in splits:
            continue
        source = RenderedSource.configured(case['configuration'])
        detector = PerspectiveDetector(source, parameters)
        occupancy, previous_truth = [], []
        taking_out, review_fault = False, None
        for step in case['steps']:
            begin = time.perf_counter()
            accepted, fault = None, None
            measured = None
            for _ in range(3):
                sequence = source.sequence + 1
                source.submit({'session': source.render_session, 'sequence': sequence,
                               'timestampMs': sequence + 1, 'images': step['images']})
                frame = source.capture()
                try:
                    points = detector.observe(frame)
                    if review_fault:
                        raise ValueError(review_fault)
                    if points is not None:
                        removed, added = occupancy_changes(occupancy, points)
                        if removed and added:
                            raise ValueError('simultaneous addition/removal; reset required')
                        if len(added) > 1:
                            raise ValueError('multiple simultaneous impacts; reset required')
                        if added and taking_out:
                            raise ValueError('impact during incomplete takeout; reset required')
                        # Audit only occupancy that passed acquisition and
                        # reconciliation, including points rejected by scoring.
                        # Labels stay here; they never enter the detector.
                        measured = list(points)
                        for point in added:
                            confident_segment(*point, detector.uncertainty_mm)
                        taking_out = (taking_out or bool(removed)) and bool(points)
                        detector.accept(frame, points)
                        occupancy = list(points)
                        accepted = list(points)
                        fault = None
                except (ValueError, TypeError) as exc:
                    fault = str(exc)
                    if 'reset required' in fault:
                        review_fault = fault
                    detector.clear_pending()
            truth = step['expected']
            pairs = correspondence(truth, accepted or [], step['toleranceMm'])
            correct = accepted is not None and len(pairs) == len(truth) == len(accepted) and all(
                segment(*truth[i]) == segment(*accepted[j]) for i, j, _ in pairs)
            unmatched = [p for j, p in enumerate(accepted or []) if j not in {pair[1] for pair in pairs}]
            duplicates = sum(any(distance(p, q) <= step['toleranceMm'] for q in truth) for p in unmatched)
            removals = sum(any(distance(p, q) <= step['toleranceMm'] for q in previous_truth) and
                           not any(distance(p, q) <= step['toleranceMm'] for q in truth) for p in unmatched)
            calibration = None
            if measured:
                measured_pairs = correspondence(truth, measured, float('inf'))
                errors = [error for _, _, error in measured_pairs]
                calibration = {'errorsMm': errors, 'radiusMm': detector.uncertainty_mm,
                               'outsideBound': sum(error > detector.uncertainty_mm for error in errors),
                               'unmatched': len(truth)+len(measured)-2*len(measured_pairs)}
            rows.append({'case': case['id'], 'family': case['family'], 'split': case['split'],
                         'step': len([r for r in rows if r['case'] == case['id']]),
                         'required': not step['allowReject'], 'expectedCount': len(truth), 'correct': correct,
                         'rejected': accepted is None, 'wrongAccept': accepted is not None and not correct,
                         'points': accepted, 'fault': fault, 'uncertaintyMm': detector.uncertainty_mm,
                         'uncertaintyCalibration': calibration,
                         'localizationMm': [error for _, _, error in pairs],
                         'phantoms': len(unmatched) - duplicates - removals,
                         'duplicates': duplicates, 'removalErrors': removals,
                         'missing': len(truth) - len(pairs) if accepted is not None else 0,
                         'runtimeSeconds': time.perf_counter() - begin})
            previous_truth = truth
    required = sum(r['required'] for r in rows)
    correct_required = sum(r['required'] and r['correct'] for r in rows)
    impact_rows = [r for r in rows if r['required'] and r['expectedCount']]
    required_impacts = len(impact_rows)
    correct_impacts = sum(r['correct'] for r in impact_rows)
    wrong = sum(r['wrongAccept'] for r in rows)
    errors = [e for r in rows for e in r['localizationMm']]
    audits = [r['uncertaintyCalibration'] for r in rows if r['uncertaintyCalibration'] is not None]
    audit_errors = [error for audit in audits for error in audit['errorsMm']]
    summary = {key: sum(r[key] for r in rows) for key in
               ('correct', 'rejected', 'wrongAccept', 'phantoms', 'duplicates', 'removalErrors', 'missing')}
    summary.update(requiredRejects=sum(r['required'] and r['rejected'] for r in rows),
                   allowedRejects=sum(not r['required'] and r['rejected'] for r in rows),
                   steps=len(rows), required=required, correctRequired=correct_required,
                   requiredRecall=correct_required / required if required else 0,
                   requiredNonemptySteps=required_impacts, correctRequiredNonempty=correct_impacts,
                   requiredImpactCoverage=correct_impacts / required_impacts if required_impacts else 0,
                   impactCoverageAvailable=bool(required_impacts),
                   rejectAll=sum(r['rejected'] for r in rows) == len(rows) if rows else False,
                   # Legacy scalar is informational; selection uses ranking_key below.
                   objective=(correct_impacts / max(1, required_impacts)) - 1000 * wrong,
                   localizationMeanMm=sum(errors) / len(errors) if errors else None,
                   uncertaintyCalibration={
                       'comparisons': len(audit_errors),
                       'outsideBound': sum(audit['outsideBound'] for audit in audits),
                       'unmatched': sum(audit['unmatched'] for audit in audits),
                       'maxErrorMm': max(audit_errors, default=None),
                       'maxErrorToBoundRatio': max((error/audit['radiusMm'] for audit in audits
                                                    for error in audit['errorsMm']), default=None)},
                   runtimeSeconds=time.perf_counter() - started)
    return {'version': VERSION, 'datasetHash': dataset['hash'], 'parameters': parameters.to_dict(),
            'summary': summary, 'steps': rows}


def compatibility():
    digest = hashlib.sha256()
    for name in ('benchmark.py', 'parameters.py', 'rendered.py', 'vision.py', 'main.py'):
        digest.update(Path(__file__).with_name(name).read_bytes())
    return digest.hexdigest()


def tuple_tree(value):
    return tuple(tuple_tree(v) for v in value) if isinstance(value, list) else value


def ranking_key(summary):
    """Lower is better: invariant safety, wrong accepts, impact coverage, localization.

    Empty-board successes cannot improve coverage. Runtime and legacy objective
    never participate. Callers append trial index for deterministic final ties.
    """
    unsafe = any(summary[key] > 0 for key in ('phantoms', 'duplicates', 'removalErrors'))
    localization = summary['localizationMeanMm']
    return (unsafe, summary['wrongAccept'], -summary['requiredImpactCoverage'],
            localization if localization is not None else float('inf'))


def propose(rng, center=None, completed=0):
    """Sample coupled groups/full bounds, or locally refine a productive center."""
    values = (center or DEFAULT_PARAMETERS).to_dict()
    if center is not None:
        keys = rng.sample(sorted(values), rng.randint(1, 4))
    elif completed % FULL_DRAW_INTERVAL == FULL_DRAW_INTERVAL - 1:
        keys = sorted(values)
    else:
        groups = rng.sample(EXPLORATION_GROUPS, rng.randint(1, 3))
        keys = sorted(key for group in groups for key in group)
    for key in keys:
        low, high = PARAMETER_BOUNDS[key]
        if center is not None:
            radius = (high - low) * LOCAL_RADIUS_FRACTION
            low, high = max(low, values[key] - radius), min(high, values[key] + radius)
        if type(values[key]) is int:
            values[key] = rng.randint(math.ceil(low), math.floor(high))
        else:
            values[key] = rng.uniform(low, high)
    return DetectionParameters.from_dict(values)


def tune(dataset, output, trials=20, seconds=None, seed=1, resume=False, shortlist=3):
    if type(trials) is not int or trials < 1 or type(shortlist) is not int or shortlist < 1:
        raise ValueError('trials and shortlist must be positive integers')
    if seconds is not None and (not math.isfinite(seconds) or seconds <= 0):
        raise ValueError('seconds must be positive and finite')
    for split in ('train', 'validation'):
        if not any(c['split'] == split and any(not s['allowReject'] for s in c['steps']) for c in dataset['cases']):
            raise ValueError(f'{split} needs at least one required step')
    config = {'seed': seed, 'shortlist': shortlist, 'compatibility': compatibility(),
                  'explorationTrials': EXPLORATION_TRIALS, 'localRadiusFraction': LOCAL_RADIUS_FRACTION,
                                    'fullDrawInterval': FULL_DRAW_INTERVAL,
                                                      'explorationGroups': [list(group) for group in EXPLORATION_GROUPS]}
    rng = random.Random(seed)
    state = {'version': VERSION, 'datasetHash': dataset['hash'], 'config': config,
             'trials': [], 'rngState': rng.getstate(), 'selected': None}
    if resume:
        state = strict_json(Path(output).read_bytes())
        if state.get('version') != VERSION or state.get('datasetHash') != dataset['hash'] or state.get('config') != config:
            raise ValueError('checkpoint dataset/configuration incompatible')
        rng.setstate(tuple_tree(state['rngState']))
    start = time.monotonic()

    def validate_finalists():
        ranked = sorted(state['trials'], key=lambda t: (ranking_key(t['train']), t['index']))[:shortlist]
        finalists = sorted({0, *(trial['index'] for trial in ranked)}) if ranked else []
        state['finalists'] = finalists
        state['selected'] = None
        state['status'] = 'validation_pending'
        state['reason'] = 'Finalist validation is incomplete; resume to finish.'
        atomic_json(output, state)
        for index in finalists:
            trial = state['trials'][index]
            if 'validation' not in trial:
                # Soft deadline: complete in-flight work, checkpoint each summary.
                if seconds is not None and time.monotonic() - start >= seconds:
                    return False
                trial['validation'] = evaluate(dataset, DetectionParameters.from_dict(trial['parameters']), ('validation',))['summary']
                atomic_json(output, state)
        return True

    # Finish a previous shortlist before spending a new budget on train search.
    if resume and state['trials'] and not validate_finalists():
        return state
    while len(state['trials']) < trials and (seconds is None or time.monotonic() - start < seconds):
        center_trial = None
        if len(state['trials']) >= EXPLORATION_TRIALS:
            best = min(state['trials'], key=lambda t: (ranking_key(t['train']), t['index']))
            if best['train']['requiredImpactCoverage'] > 0:
                center_trial = best
        center = DetectionParameters.from_dict(center_trial['parameters']) if center_trial else None
        parameters = DEFAULT_PARAMETERS if not state['trials'] else propose(rng, center, len(state['trials']))
        report = evaluate(dataset, parameters, ('train',))
        state['trials'].append({'index': len(state['trials']), 'parameters': parameters.to_dict(),
                                'train': report['summary'],
                                'phase': 'refinement' if center_trial else 'exploration',
                                'parentTrial': center_trial['index'] if center_trial else None})
        state['rngState'] = rng.getstate()
        state['selected'] = None
        state['status'] = 'validation_pending'
        state['reason'] = 'Train search changed the finalists; validation must complete before selection.'
        atomic_json(output, state)
    if not validate_finalists():
        return state
    acceptable = [trial for trial in state['trials'] if 'validation' in trial and
                  all(trial['validation'][key] == 0 for key in
                      ('wrongAccept', 'phantoms', 'duplicates', 'removalErrors')) and
                  trial['validation'].get('impactCoverageAvailable', True) and
                  trial['validation']['requiredImpactCoverage'] > 0]
    if acceptable:
        winner = min(acceptable, key=lambda t: (ranking_key(t['validation']), t['index']))
        state['selected'] = {'trial': winner['index'], 'parameters': winner['parameters'],
                             'validation': winner['validation']}
        state['status'] = 'selected'
        state['reason'] = 'Selected a safety-clean candidate with positive validation impact coverage.'
    else:
        state['status'] = 'no_acceptable_candidate'
        state['reason'] = ('No validated candidate has zero wrongAccept, phantoms, duplicates and '
                           'removalErrors plus positive requiredImpactCoverage.')
    atomic_json(output, state)
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('evaluate', 'tune'))
    parser.add_argument('dataset')
    parser.add_argument('--output', required=True)
    parser.add_argument('--parameters', help='partial DetectionParameters JSON (evaluate only)')
    parser.add_argument('--split', choices=('train', 'validation', 'test', 'all'), default='all')
    parser.add_argument('--trials', type=int, default=20)
    parser.add_argument('--seconds', type=float)
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--shortlist', type=int, default=3)
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    try:
        if os.environ.get('DETECTOR_CAPTURE'):
            raise ValueError('unset DETECTOR_CAPTURE for offline evaluation')
        if Path(args.output).resolve() == Path(args.dataset).resolve():
            raise ValueError('output must not overwrite dataset')
        dataset = load_dataset(args.dataset)
        if args.command == 'evaluate':
            parameters = DetectionParameters.from_dict(strict_json(Path(args.parameters).read_bytes())) if args.parameters else DEFAULT_PARAMETERS
            atomic_json(args.output, evaluate(dataset, parameters, ('train', 'validation', 'test') if args.split == 'all' else (args.split,)))
        else:
            if args.parameters or args.split != 'all':
                raise ValueError('tune owns train/validation splits and parameter search')
            tune(dataset, args.output, args.trials, args.seconds, args.seed, args.resume, args.shortlist)
    except (ValueError, OSError) as exc:
        parser.error(str(exc))


if __name__ == '__main__':
    main()
