"""Validation and injection contracts for offline pixel/geometry tuning."""

import json
import unittest
from dataclasses import FrozenInstanceError, fields
from unittest.mock import patch

from parameters import DEFAULT_PARAMETERS, PARAMETER_BOUNDS, DetectionParameters
from rendered import PerspectiveDetector, RenderedSource, changed_pixels, reconstruct
from test_rendered import analytic_lines, configuration, images


class ParameterTests(unittest.TestCase):
    def test_defaults_and_json_round_trip(self):
        self.assertEqual(DetectionParameters.from_dict({}), DEFAULT_PARAMETERS)
        self.assertEqual(DetectionParameters.from_dict(json.loads(json.dumps(DEFAULT_PARAMETERS.to_dict()))),
                         DEFAULT_PARAMETERS)
        self.assertEqual(set(PARAMETER_BOUNDS), {f.name for f in fields(DetectionParameters)})
        with self.assertRaises(FrozenInstanceError):
            DEFAULT_PARAMETERS.max_candidates = 2
        values = DEFAULT_PARAMETERS.to_dict()
        values['max_candidates'] = 1
        self.assertEqual(DEFAULT_PARAMETERS.max_candidates, 10)

    def test_every_field_bounds_and_types(self):
        for field in fields(DetectionParameters):
            low, high = PARAMETER_BOUNDS[field.name]
            for value in (low, high):
                with self.subTest(field=field.name, value=value):
                    DetectionParameters.from_dict({field.name: value})
            invalid = [low-1, high+1, True, False, None, '2', [], {},
                       float('nan'), float('inf'), -float('inf'), 10**400]
            if field.type is int:
                invalid.append(float(getattr(DEFAULT_PARAMETERS, field.name)))
            for value in invalid:
                with self.subTest(field=field.name, value=value), self.assertRaises(ValueError):
                    DetectionParameters.from_dict({field.name: value})

    def test_protocol_and_occupancy_are_not_configurable(self):
        for name in ('stable_frames', 'session', 'stale_seconds', 'dedup_distance_mm',
                     'takeout', 'max_occupancy', 'truth'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                DetectionParameters.from_dict({name: 3})
        for value in (None, [], True, 'config'):
            with self.assertRaises(ValueError):
                DetectionParameters.from_dict(value)

    def test_constructor_and_fixed_stability(self):
        source = RenderedSource.configured(configuration())
        parameters = DetectionParameters(difference_threshold_gray=4)
        detector = PerspectiveDetector(source, parameters=parameters)
        self.assertIs(detector.parameters, parameters)
        self.assertIs(PerspectiveDetector(source).parameters, DEFAULT_PARAMETERS)
        for invalid in (None, {}, 3):
            with self.assertRaises(ValueError):
                PerspectiveDetector(source, invalid)
        self.assertIsNone(detector.observe(source.reference))
        self.assertIsNone(detector.observe(source.reference))
        self.assertEqual(detector.observe(source.reference), [])
        detector.clear_pending()
        self.assertEqual(detector.stable_frames, 0)

    def test_envelope_bound_matches_supported_axial_dimensions(self):
        maximum = 45 + 65 + 60 + 55 - 8
        self.assertEqual(PARAMETER_BOUNDS['shaft_envelope_length_mm'][1], maximum)
        self.assertEqual(DEFAULT_PARAMETERS.shaft_envelope_length_mm, maximum)
        self.assertEqual(DetectionParameters.from_dict({'shaft_envelope_length_mm': 160}).shaft_envelope_length_mm, 160)
        self.assertEqual(DEFAULT_PARAMETERS.flight_radius_mm, 30)

    def test_difference_threshold_injected(self):
        reference = bytes([180])*64*64
        frame = bytearray(reference)
        frame[32*64+32] = 177
        self.assertEqual(len(changed_pixels(bytes(frame), reference, 64, 64)), 1)
        parameters = DetectionParameters(difference_threshold_gray=4)
        self.assertEqual(changed_pixels(bytes(frame), reference, 64, 64, parameters), [])

    def test_reconstruction_threshold_injected(self):
        config = configuration()
        lines = analytic_lines(config, (180, 0))
        self.assertAlmostEqual(reconstruct(config['cameras'], lines)[0][0], 180)
        with self.assertRaisesRegex(ValueError, 'implausible'):
            reconstruct(config['cameras'], lines,
                        parameters=DetectionParameters(max_impact_radius_mm=170))

    def test_parameters_reach_extraction_and_reconstruction(self):
        source = RenderedSource.configured(configuration())
        parameters = DetectionParameters(max_candidates=4)
        detector = PerspectiveDetector(source, parameters)
        frames = images(configuration(), [(0, 65, 0, 0)])
        from rendered import shaft_candidates
        with patch('rendered.shaft_candidates', wraps=shaft_candidates) as extraction, \
                patch('rendered.reconstruct', wraps=reconstruct) as geometry:
            detector.observe(frames)
        self.assertTrue(extraction.call_args_list)
        self.assertTrue(geometry.call_args_list)
        for call in extraction.call_args_list:
            self.assertIs(call.kwargs['parameters'], parameters)
        for call in geometry.call_args_list:
            self.assertIs(call.kwargs.get('parameters', call.args[4] if len(call.args) > 4 else None),
                          parameters)


if __name__ == '__main__':
    unittest.main()
