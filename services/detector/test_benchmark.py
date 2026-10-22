"""Offline evaluator/tuner protocol, safety, labels and reproducibility tests."""

import base64
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import benchmark
from parameters import DEFAULT_PARAMETERS
from rendered import RenderedSource
from test_rendered import configuration, images


def summary(coverage=0, **changes):
    result = dict(objective=coverage, requiredImpactCoverage=coverage, phantoms=0,
                  duplicates=0, removalErrors=0, wrongAccept=0, localizationMeanMm=None)
    result.update(changes)
    return result


class BenchmarkTests(unittest.TestCase):
    def test_uncertainty_audit_includes_boundary_rejections(self):
        steps = [{'images': {}, 'expected': [[0, 98]], 'allowReject': True, 'toleranceMm': 3}]
        steps[0]['images'] = self.empty
        with patch.object(benchmark, 'PerspectiveDetector', self.fake([[(0, 98.5)]], uncertainty=2)):
            report = benchmark.evaluate(self.dataset(steps), splits=('validation',))
        self.assertEqual(report['summary']['rejected'], 1)
        self.assertEqual(report['steps'][0]['localizationMm'], [])
        audit = report['summary']['uncertaintyCalibration']
        self.assertEqual(audit['comparisons'], 1)
        self.assertEqual(audit['maxErrorMm'], 0.5)
        self.assertEqual(audit['outsideBound'], 0)

    def test_uncertainty_audit_reports_underestimated_errors(self):
        steps = [{'images': {}, 'expected': [[0, 70]], 'allowReject': False, 'toleranceMm': 3}]
        steps[0]['images'] = self.empty
        with patch.object(benchmark, 'PerspectiveDetector', self.fake([[(0, 72)]], uncertainty=1)):
            report = benchmark.evaluate(self.dataset(steps), splits=('train',))
        audit = report['summary']['uncertaintyCalibration']
        self.assertEqual(audit['comparisons'], 1)
        self.assertEqual(audit['outsideBound'], 1)
        self.assertEqual(audit['maxErrorToBoundRatio'], 2)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = configuration()
        self.empty = {k: c['reference'] for k, c in self.config['cameras'].items()}

    def dataset(self, steps=None):
        steps = steps or [{'images': self.empty, 'expected': [], 'allowReject': False, 'toleranceMm': 3}]
        return {'hash': 'fixture', 'cases': [dict(id=split, family='fixture', split=split,
                configuration=self.config, steps=copy.deepcopy(steps)) for split in ('train', 'validation', 'test')]}

    def write_dataset(self):
        (self.root / 'configuration.json').write_text(json.dumps(self.config))
        (self.root / 'images.json').write_text(json.dumps(self.empty))
        manifest = {'version': 1, 'cases': [{'id': 'empty', 'family': 'baseline', 'split': 'train',
                    'configuration': 'configuration.json', 'steps': [{'images': 'images.json',
                    'expected': [], 'allowReject': False, 'toleranceMm': 3}]}]}
        path = self.root / 'dataset.json'
        path.write_text(json.dumps(manifest))
        return path, manifest

    def fake(self, outputs, uncertainty=1):
        class Detector:
            def __init__(self, source, parameters):
                self.calls = 0
                self.uncertainty_mm = uncertainty
                self.accepted = []

            def observe(self, frame):
                assert all(type(v) is bytes for v in frame.values())
                self.calls += 1
                if self.calls % 3:
                    return None
                result = outputs[(self.calls - 1) // 3]
                if isinstance(result, Exception):
                    raise result
                return result

            def clear_pending(self):
                pass

            def accept(self, frame, points):
                self.accepted.append(points)
        return Detector

    def test_manifest_and_content_hash(self):
        path, _ = self.write_dataset()
        first = benchmark.load_dataset(path)
        self.assertEqual(first['hash'], benchmark.load_dataset(path)['hash'])
        (self.root / 'images.json').write_text(json.dumps(self.empty, indent=2))
        self.assertNotEqual(first['hash'], benchmark.load_dataset(path)['hash'])

    def test_invalid_labels_paths_and_images(self):
        path, manifest = self.write_dataset()
        changes = [lambda m: m.update(version=True),
                   lambda m: m['cases'][0].update(configuration='../escape.json'),
                   lambda m: m['cases'][0]['steps'][0].update(expected=[[True, 2]]),
                   lambda m: m['cases'][0]['steps'][0].update(toleranceMm=0),
                   lambda m: m['cases'][0]['steps'][0].update(allowReject=1),
                   lambda m: m['cases'].append(copy.deepcopy(m['cases'][0]))]
        for change in changes:
            invalid = copy.deepcopy(manifest)
            change(invalid)
            path.write_text(json.dumps(invalid))
            with self.assertRaises(ValueError):
                benchmark.load_dataset(path)
        path.write_text(json.dumps(manifest))
        (self.root / 'images.json').write_text('{"cam0":"bad"}')
        with self.assertRaises(ValueError):
            benchmark.load_dataset(path)

    def test_three_distinct_submissions_and_real_empty_detection(self):
        calls = []
        original = RenderedSource.submit
        def submit(source, body):
            calls.append((body['sequence'], body['timestampMs'], set(body)))
            return original(source, body)
        with patch.object(RenderedSource, 'submit', submit):
            result = benchmark.evaluate(self.dataset(), splits=('train',))
        self.assertEqual([c[0] for c in calls], [0, 1, 2])
        self.assertEqual([c[1] for c in calls], [1, 2, 3])
        self.assertTrue(all(c[2] == {'session', 'sequence', 'timestampMs', 'images'} for c in calls))
        self.assertEqual(result['summary']['correct'], 1)

    def test_real_rendered_add_repeat_remove(self):
        frames = {k: base64.b64encode(v).decode() for k, v in images(self.config, [(0, 60, 0, 0)]).items()}
        steps = [dict(images=frames, expected=[[0, 60]], allowReject=False, toleranceMm=3),
                 dict(images=frames, expected=[[0, 60]], allowReject=False, toleranceMm=3),
                 dict(images=self.empty, expected=[], allowReject=False, toleranceMm=3)]
        report = benchmark.evaluate(self.dataset(steps), splits=('train',))
        self.assertEqual(report['summary']['correct'], 3, report)
        self.assertEqual(report['summary']['wrongAccept'], 0)

    def test_uncertainty_rejection_latches_and_no_accept(self):
        steps = [dict(images=self.empty, expected=[[0, 95]], allowReject=True, toleranceMm=3),
                 dict(images=self.empty, expected=[], allowReject=False, toleranceMm=3)]
        with patch.object(benchmark, 'PerspectiveDetector', self.fake([[(0, 95)], []], uncertainty=3)):
            report = benchmark.evaluate(self.dataset(steps), splits=('train',))
        self.assertEqual(report['summary']['rejected'], 2)
        self.assertEqual(report['summary']['objective'], 0)
        self.assertIn('uncertainty', report['steps'][0]['fault'])

    def test_wrong_accept_localization_and_missing(self):
        step = dict(images=self.empty, expected=[[0, 60]], allowReject=True, toleranceMm=3)
        with patch.object(benchmark, 'PerspectiveDetector', self.fake([[(0, 80)]])):
            report = benchmark.evaluate(self.dataset([step]), splits=('train',))
        self.assertEqual(report['summary']['wrongAccept'], 1)
        self.assertEqual(report['summary']['phantoms'], 1)
        self.assertEqual(report['summary']['missing'], 1)
        self.assertLess(report['summary']['objective'], 0)
        with patch.object(benchmark, 'PerspectiveDetector', self.fake([[(0, 61)]])):
            report = benchmark.evaluate(self.dataset([step]), splits=('train',))
        self.assertEqual(report['summary']['localizationMeanMm'], 1)
        self.assertEqual(report['summary']['correct'], 1)

    def test_assignment_is_one_to_one_not_greedy(self):
        pairs = benchmark.correspondence([(0, 0), (2, 0)], [(1, 0), (-1, 0)], 2)
        self.assertEqual(len(pairs), 2)
        self.assertEqual(len({j for _, j, _ in pairs}), 2)

    def test_multiple_impacts_and_takeout_guard(self):
        step = dict(images=self.empty, expected=[], allowReject=True, toleranceMm=3)
        with patch.object(benchmark, 'PerspectiveDetector', self.fake([[(0, 60), (60, 0)]])):
            report = benchmark.evaluate(self.dataset([step]), splits=('train',))
        self.assertIn('multiple simultaneous', report['steps'][0]['fault'])
        outputs = [[(0, 60)], [(0, 60), (60, 0)], [(60, 0)], [(60, 0), (0, 80)]]
        with patch.object(benchmark, 'PerspectiveDetector', self.fake(outputs)):
            report = benchmark.evaluate(self.dataset([step] * 4), splits=('train',))
        self.assertIn('incomplete takeout', report['steps'][-1]['fault'])

    def test_reject_all_cannot_win_and_test_never_used(self):
        calls = []
        def evaluate(dataset, parameters, splits):
            calls.append(splits)
            score = 1 if parameters == DEFAULT_PARAMETERS else 0
            return {'summary': summary(score)}
        with patch.object(benchmark, 'evaluate', evaluate):
            state = benchmark.tune(self.dataset(), self.root / 'tune.json', trials=5)
        self.assertEqual(state['selected']['trial'], 0)
        self.assertTrue(all(s in (('train',), ('validation',)) for s in calls))

    def test_resume_same_rng_and_candidate_sequence(self):
        def evaluate(dataset, parameters, splits):
            return {'summary': summary(parameters.min_blob_pixels / 100)}
        with patch.object(benchmark, 'evaluate', evaluate):
            full = benchmark.tune(self.dataset(), self.root / 'full.json', trials=16, seed=42)
            benchmark.tune(self.dataset(), self.root / 'resume.json', trials=3, seed=42)
            resumed = benchmark.tune(self.dataset(), self.root / 'resume.json', trials=16, seed=42, resume=True)
        self.assertEqual(full['rngState'], resumed['rngState'])
        self.assertEqual(full['selected'], resumed['selected'])
        self.assertEqual([{k: v for k, v in t.items() if k != 'validation'} for t in full['trials']],
                         [{k: v for k, v in t.items() if k != 'validation'} for t in resumed['trials']])

    def test_resume_incompatible_and_required_splits(self):
        with patch.object(benchmark, 'evaluate', return_value={'summary': summary()}):
            benchmark.tune(self.dataset(), self.root / 'tune.json', trials=1)
            for kwargs in ({'seed': 2}, {'shortlist': 1}):
                with self.assertRaises(ValueError):
                    benchmark.tune(self.dataset(), self.root / 'tune.json', resume=True, **kwargs)
            changed = self.dataset()
            changed['hash'] = 'different'
            with self.assertRaises(ValueError):
                benchmark.tune(changed, self.root / 'tune.json', resume=True)
        data = self.dataset()
        data['cases'][1]['steps'][0]['allowReject'] = True
        with self.assertRaises(ValueError):
            benchmark.tune(data, self.root / 'other.json')

    def test_time_budget_and_atomic_failure(self):
        clock = iter([0, 0, 2, 2])
        with patch.object(benchmark.time, 'monotonic', side_effect=lambda: next(clock)), patch.object(
                benchmark, 'evaluate', return_value={'summary': summary()}):
            state = benchmark.tune(self.dataset(), self.root / 'tune.json', trials=10, seconds=1)
        self.assertEqual(len(state['trials']), 1)
        self.assertIsNone(state['selected'])
        target = self.root / 'atomic.json'
        benchmark.atomic_json(target, {'old': True})
        with self.assertRaises(ValueError):
            benchmark.atomic_json(target, {'bad': float('nan')})
        self.assertEqual(json.loads(target.read_text()), {'old': True})
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['atomic.json', 'tune.json'])

    def test_safety_ranking_dominates_coverage_and_legacy_objective(self):
        safe = summary(0)
        for invariant in ('phantoms', 'duplicates', 'removalErrors'):
            unsafe = summary(1, objective=1000000, **{invariant: 1})
            self.assertLess(benchmark.ranking_key(safe), benchmark.ranking_key(unsafe))
        self.assertLess(benchmark.ranking_key(safe), benchmark.ranking_key(summary(1, wrongAccept=1)))
        self.assertLess(benchmark.ranking_key(summary(.1, wrongAccept=1)),
                        benchmark.ranking_key(summary(1, wrongAccept=2)))
        self.assertLess(benchmark.ranking_key(summary(.9, localizationMeanMm=3)),
                        benchmark.ranking_key(summary(.8, localizationMeanMm=.1)))
        self.assertLess(benchmark.ranking_key(summary(1, localizationMeanMm=.1)),
                        benchmark.ranking_key(summary(1, localizationMeanMm=1)))
        self.assertEqual(benchmark.ranking_key(summary(1, runtimeSeconds=100)),
                         benchmark.ranking_key(summary(1, runtimeSeconds=0, objective=-100)))

    def test_empty_rewards_and_explicit_reject_all_coverage(self):
        steps = [dict(images=self.empty, expected=[], allowReject=False, toleranceMm=3)] * 10
        steps += [dict(images=self.empty, expected=[[0, 60]], allowReject=False, toleranceMm=3)]
        with patch.object(benchmark, 'PerspectiveDetector', self.fake([[]] * 10 + [ValueError('unresolved')])):
            result = benchmark.evaluate(self.dataset(steps), splits=('train',))['summary']
        self.assertEqual(result['correctRequired'], 10)
        self.assertEqual(result['requiredNonemptySteps'], 1)
        self.assertEqual(result['requiredImpactCoverage'], 0)
        self.assertEqual(result['objective'], 0)
        self.assertTrue(result['impactCoverageAvailable'])
        with patch.object(benchmark, 'PerspectiveDetector', self.fake([ValueError('unresolved')] * 11)):
            result = benchmark.evaluate(self.dataset(steps), splits=('train',))['summary']
        self.assertTrue(result['rejectAll'])
        self.assertEqual(result['correctRequiredNonempty'], 0)
        empty = benchmark.evaluate(self.dataset(), splits=('train',))['summary']
        self.assertFalse(empty['impactCoverageAvailable'])
        self.assertEqual(empty['objective'], 0)

    def test_refinement_uses_train_best_with_bounded_radius(self):
        def evaluate(dataset, parameters, splits):
            # Validation deliberately prefers the opposite direction.
            coverage = parameters.min_blob_pixels / 100
            return {'summary': summary(coverage if splits == ('train',) else 1 - coverage)}
        with patch.object(benchmark, 'evaluate', evaluate):
            state = benchmark.tune(self.dataset(), self.root / 'local.json', trials=18, seed=42)
        for index, trial in enumerate(state['trials']):
            if index < benchmark.EXPLORATION_TRIALS:
                self.assertEqual(trial['phase'], 'exploration')
                self.assertIsNone(trial['parentTrial'])
                continue
            self.assertEqual(trial['phase'], 'refinement')
            prior = state['trials'][:index]
            best = min(prior, key=lambda t: (benchmark.ranking_key(t['train']), t['index']))
            self.assertEqual(trial['parentTrial'], best['index'])
            for key, value in trial['parameters'].items():
                low, high = benchmark.PARAMETER_BOUNDS[key]
                self.assertLessEqual(abs(value - best['parameters'][key]),
                                     (high - low) * benchmark.LOCAL_RADIUS_FRACTION + 1e-12)
                self.assertTrue(low <= value <= high)

    def test_zero_coverage_continues_broad_exploration_and_resume(self):
        with patch.object(benchmark, 'evaluate', return_value={'summary': summary()}):
            full = benchmark.tune(self.dataset(), self.root / 'full.json', trials=20, seed=42)
            benchmark.tune(self.dataset(), self.root / 'resume.json', trials=10, seed=42)
            resumed = benchmark.tune(self.dataset(), self.root / 'resume.json', trials=20,
                                     seed=42, resume=True)
        self.assertEqual(full, resumed)
        defaults = DEFAULT_PARAMETERS.to_dict()
        for trial in full['trials']:
            self.assertEqual(trial['phase'], 'exploration')
            self.assertIsNone(trial['parentTrial'])
            for key, value in trial['parameters'].items():
                low, high = benchmark.PARAMETER_BOUNDS[key]
                self.assertTrue(low <= value <= high)
            if trial['index'] % benchmark.FULL_DRAW_INTERVAL == benchmark.FULL_DRAW_INTERVAL - 1:
                changed = sum(value != defaults[key] for key, value in trial['parameters'].items())
                self.assertGreater(changed, len(defaults) - 4)
        self.assertIsNone(full['selected'])
        self.assertEqual(full['status'], 'no_acceptable_candidate')

    def test_positive_coverage_transitions_to_refinement_after_initial_exploration(self):
        for productive in (2, 10):
            with self.subTest(productive=productive):
                count = 0
                def evaluate(dataset, parameters, splits):
                    nonlocal count
                    if splits == ('train',):
                        index = count
                        count += 1
                        return {'summary': summary(.5 if index == productive else 0)}
                    return {'summary': summary()}
                with patch.object(benchmark, 'evaluate', evaluate):
                    state = benchmark.tune(self.dataset(), self.root / 'positive.json', trials=15)
                transition = max(benchmark.EXPLORATION_TRIALS, productive + 1)
                for trial in state['trials']:
                    refining = trial['index'] >= transition
                    self.assertEqual(trial['phase'], 'refinement' if refining else 'exploration')
                    self.assertEqual(trial['parentTrial'], productive if refining else None)

    def test_unsafe_positive_coverage_does_not_end_exploration(self):
        count = 0
        def evaluate(dataset, parameters, splits):
            nonlocal count
            count += splits == ('train',)
            return {'summary': summary(1, phantoms=1) if count > 1 else summary()}
        with patch.object(benchmark, 'evaluate', evaluate):
            state = benchmark.tune(self.dataset(), self.root / 'unsafe.json', trials=12)
        self.assertTrue(all(t['phase'] == 'exploration' and t['parentTrial'] is None
                            for t in state['trials']))

    def test_coupled_exploration_groups_cover_only_bounded_parameters(self):
        import random
        keys = [key for group in benchmark.EXPLORATION_GROUPS for key in group]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertEqual(set(keys), set(benchmark.PARAMETER_BOUNDS))
        defaults = DEFAULT_PARAMETERS.to_dict()
        rng = random.Random(42)
        for completed in range(20):
            candidate = benchmark.propose(rng, completed=completed).to_dict()
            changed = {key for key in candidate if candidate[key] != defaults[key]}
            for group in benchmark.EXPLORATION_GROUPS:
                if changed.intersection(group):
                    # Integer draws can land on defaults, but the whole group is sampled.
                    float_keys = {key for key in group if type(defaults[key]) is float}
                    self.assertTrue(float_keys <= changed)

    def test_train_and_validation_selection_use_safety_key(self):
        count = 0
        def evaluate(dataset, parameters, splits):
            nonlocal count
            if splits == ('train',):
                index = count
                count += 1
                return {'summary': summary(1 if index else .5, phantoms=int(index == 2))}
            # Default trial is safe; others are wrong despite higher coverage.
            return {'summary': summary(.5 if parameters == DEFAULT_PARAMETERS else 1,
                                        wrongAccept=int(parameters != DEFAULT_PARAMETERS))}
        with patch.object(benchmark, 'evaluate', evaluate):
            state = benchmark.tune(self.dataset(), self.root / 'safety.json', trials=3, shortlist=2)
        self.assertNotIn('validation', state['trials'][2])
        self.assertEqual(state['selected']['trial'], 0)

    def test_unsafe_top_three_cannot_displace_safe_baseline(self):
        count = 0
        def evaluate(dataset, parameters, splits):
            nonlocal count
            if splits == ('train',):
                count += 1
                return {'summary': summary(.1 if count == 1 else 1)}
            self.assertEqual(splits, ('validation',))
            return {'summary': summary(.1) if parameters == DEFAULT_PARAMETERS else summary(1, wrongAccept=1)}
        with patch.object(benchmark, 'evaluate', evaluate):
            state = benchmark.tune(self.dataset(), self.root / 'baseline.json', trials=4)
        self.assertEqual(state['finalists'], [0, 1, 2, 3])
        self.assertEqual(state['selected']['trial'], 0)
        self.assertEqual(state['status'], 'selected')

    def test_retained_validated_candidate_survives_new_shortlist(self):
        count = 0
        safe_parameters = None
        def evaluate(dataset, parameters, splits):
            nonlocal count, safe_parameters
            if splits == ('train',):
                index = count
                count += 1
                if index == 1:
                    safe_parameters = parameters
                return {'summary': summary(.05 if index == 0 else index / 10)}
            self.assertEqual(splits, ('validation',))
            return {'summary': summary(.5) if parameters == safe_parameters else summary(1, phantoms=1)}
        path = self.root / 'retained.json'
        with patch.object(benchmark, 'evaluate', evaluate):
            first = benchmark.tune(self.dataset(), path, trials=2, shortlist=1)
            resumed = benchmark.tune(self.dataset(), path, trials=5, shortlist=1, resume=True)
        self.assertNotIn(1, resumed['finalists'])
        self.assertEqual(resumed['trials'][1]['validation'], first['trials'][1]['validation'])
        self.assertEqual(resumed['selected']['trial'], 1)

    def test_no_acceptable_candidate_is_explicit(self):
        for changes in ({}, {'wrongAccept': 1}, {'phantoms': 1}, {'duplicates': 1},
                        {'removalErrors': 1}, {'impactCoverageAvailable': False}):
            with self.subTest(changes=changes):
                coverage = 0 if not changes or 'impactCoverageAvailable' in changes else 1
                with patch.object(benchmark, 'evaluate', return_value={'summary': summary(coverage, **changes)}):
                    state = benchmark.tune(self.dataset(), self.root / 'none.json', trials=1)
                self.assertIsNone(state['selected'])
                self.assertEqual(state['status'], 'no_acceptable_candidate')
                self.assertIn('positive requiredImpactCoverage', state['reason'])

    def test_partial_validation_resumes_before_new_train_work(self):
        clock = [0]
        calls = []
        def evaluate(dataset, parameters, splits):
            calls.append(splits)
            clock[0] += 1
            return {'summary': summary(1)}
        path = self.root / 'budget.json'
        with patch.object(benchmark.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(
                benchmark, 'evaluate', evaluate):
            first = benchmark.tune(self.dataset(), path, trials=2, seconds=3)
            self.assertEqual(first['status'], 'validation_pending')
            self.assertIn('validation', first['trials'][0])
            self.assertNotIn('validation', first['trials'][1])
            calls.clear()
            resumed = benchmark.tune(self.dataset(), path, trials=3, seconds=10, resume=True)
        self.assertEqual(calls[0], ('validation',))
        self.assertEqual(resumed['status'], 'selected')
        self.assertTrue(all('validation' in resumed['trials'][i] for i in resumed['finalists']))

    def test_search_bounds(self):
        import random
        rng = random.Random(123)
        for _ in range(100):
            candidate = benchmark.propose(rng)
            self.assertEqual(candidate, type(candidate).from_dict(candidate.to_dict()))


if __name__ == '__main__':
    unittest.main()
