"""Actual Three.js pixels; fixture labels never enter the detector."""

import base64
import gzip
import json
import math
from pathlib import Path
import unittest
from unittest.mock import patch

from parameters import DEFAULT_PARAMETERS, DetectionParameters
from main import Service
from rendered import CAMERAS, PerspectiveDetector, RenderedSource, changed_pixels, project
from test_rendered import configuration, images, upload
from vision import confident_segment


class RenderedRegressionTests(unittest.TestCase):
    def test_captured_near_wire_throw_scores_after_stability(self):
        with gzip.open(Path(__file__).parent / 'fixtures/rendered-near-wire-regression.json.gz', 'rt') as file:
            fixture = json.load(file)
        source = RenderedSource.configured(fixture['configuration'])
        service = Service(source, parameters=DetectionParameters.from_dict(fixture['parameters']))
        # Establish the empty baseline before submitting the labelled pixels.
        for _ in range(3):
            source.submit(upload(source, source.reference))
            service.tick()
        frames = {k: base64.b64decode(v) for k, v in fixture['images'].items()}
        for _ in range(2):
            source.submit(upload(source, frames))
            service.tick()
        self.assertFalse(any(e['type'] == 'throw.detected' for _, e in service.history))
        source.submit(upload(source, frames))
        service.tick()
        self.assertFalse(service.faults, service.faults)
        throws = [e for _, e in service.history if e['type'] == 'throw.detected']
        self.assertEqual(len(throws), 1)
        self.assertEqual(confident_segment(*service.occupancy[0], service.detector.uncertainty_mm)[1], 60)
        error = math.dist(service.occupancy[0], fixture['expected'][0])
        self.assertLess(error, 0.1)
        self.assertGreaterEqual(service.detector.uncertainty_mm, error)
        self.assertGreaterEqual(service.detector.uncertainty_mm, 1)
        self.assertLess(service.detector.uncertainty_mm, 1.67)
        details = service.detector.diagnostics['cam0']['reconstructed'][0]['uncertaintyDetails']
        self.assertEqual(details['model'], 'endpoint-bound-with-floor-v1')
        # The historical additive allowance would still reject this same fit.
        with self.assertRaisesRegex(ValueError, 'radial scoring boundary'):
            confident_segment(*service.occupancy[0], details['propagatedRadiusMm']+1)
        # An uncertainty region actually crossing the wire must still reject.
        with self.assertRaisesRegex(ValueError, 'radial scoring boundary'):
            confident_segment(0, 98, service.detector.uncertainty_mm)
        for _ in range(3):
            source.submit(upload(source, frames))
            service.tick()
        self.assertEqual(sum(e['type'] == 'throw.detected' for _, e in service.history), 1)

    @classmethod
    def setUpClass(cls):
        path = Path(__file__).parent / 'fixtures/rendered-occupancy-regression.json.gz'
        cls.fixture = json.loads(gzip.decompress(path.read_bytes()))

    def case(self, name):
        return next(c for c in self.fixture['cases'] if c['id'] == name)

    def frames(self, step):
        return {k: base64.b64decode(v) for k, v in step['images'].items()}

    def settle(self, detector, frames):
        self.assertIsNone(detector.observe(frames))
        self.assertIsNone(detector.observe(frames))
        return detector.observe(frames)

    def test_actual_cluster_cannot_bootstrap_after_ambiguous_first_dart(self):
        case = self.case('cluster-occlusion-0')
        source = RenderedSource.configured(case['configuration'])
        detector = PerspectiveDetector(source, DetectionParameters.from_dict(self.fixture['parameters']))
        empty = self.frames(case['steps'][0])
        detector.accept(empty, self.settle(detector, empty))
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            detector.observe(self.frames(case['steps'][1]))
        self.assertEqual(detector.accepted_points, [])
        for _ in range(3):
            with self.assertRaisesRegex(ValueError, 'unresolved prior occupancy'):
                detector.observe(self.frames(case['steps'][2]))
        self.assertEqual(detector.accepted_points, [])
        self.assertEqual(detector.stable_frames, 0)
        self.assertEqual(self.settle(detector, empty), [])
        self.assertFalse(detector.unresolved_occupancy)

    def test_actual_large_dart_needs_supported_axial_extent(self):
        case = self.case('dimensions-0-single-2')
        source = RenderedSource.configured(case['configuration'])
        frames = self.frames(case['steps'][1])
        pixels = {k: changed_pixels(frames[k], source.reference[k], source.width, source.height)
                  for k in CAMERAS}
        short = PerspectiveDetector(source, DetectionParameters(shaft_envelope_length_mm=160))
        with self.assertRaisesRegex(ValueError, 'outside reconstructed'):
            short.resolve_axis(pixels)
        detector = PerspectiveDetector(source)
        points = self.settle(detector, frames)
        self.assertEqual(len(points), 1)
        expected = case['steps'][1]['expected'][0]
        self.assertLess(math.dist(points[0], expected), 1)
        self.assertEqual(DEFAULT_PARAMETERS.flight_radius_mm, 30)
        detector.accept(frames, points)
        self.assertEqual(self.settle(detector, self.frames(case['steps'][2])), [])

    def test_tilted_endpoint_uses_axial_length_not_z_height(self):
        config = configuration()
        source = RenderedSource.configured(config)
        frames = images(config, [(0, 65, 0.2, -0.15)])
        pixels = {k: changed_pixels(frames[k], source.reference[k], source.width, source.height)
                  for k in CAMERAS}
        detector = PerspectiveDetector(source)
        with patch('rendered.project', wraps=project) as projection:
            detector.resolve_axis(pixels)
        calls = projection.call_args_list[-6:]
        for start, end in zip(calls[::2], calls[1::2]):
            self.assertAlmostEqual(math.dist(start.args[1], end.args[1]),
                                   DEFAULT_PARAMETERS.shaft_envelope_length_mm)
            self.assertLess(end.args[1][2], DEFAULT_PARAMETERS.shaft_envelope_length_mm)

    def test_lower_area_with_new_background_occupancy_is_not_removal(self):
        config = configuration()
        source = RenderedSource.configured(config)
        detector = PerspectiveDetector(source)
        old = images(config, [(0, 65, 0, 0)])
        detector.accept(old, [(0, 65)])
        changed = {}
        for key in CAMERAS:
            frame = bytearray(old[key])
            occupied = [i for i, value in enumerate(frame) if value != 180]
            for i in occupied[:len(occupied)//2]:
                frame[i] = 180
            frame[100*source.width+100] = 25
            changed[key] = bytes(frame)
        with patch.object(detector, 'resolve_axis', return_value=((0, 65), 1)):
            with self.assertRaisesRegex(ValueError, 'removal exposes unresolved'):
                detector.observe(changed)
        self.assertEqual(detector.accepted_points, [(0, 65)])


if __name__ == '__main__':
    unittest.main()
