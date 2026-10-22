import http.client
import json
import math
import threading
import unittest
from pathlib import Path
from typing import cast

from main import Server, Service
from sources import ReplaySource, synthetic
from vision import (
    ORDER,
    ImageDetector,
    components,
    confident_segment,
    match_points,
    occupancy_changes,
    segment,
)


class DetectorTests(unittest.TestCase):
    def setUp(self):
        self.rig = synthetic()
        self.service = Service(self.rig)
        self.settle()

    def settle(self):
        for _ in range(3):
            self.service.tick()

    def events(self, kind):
        return [e for _, e in self.service.history if e['type'] == kind]

    def test_boundaries(self):
        for r, ring in [(7, 'BULL'), (7.001, 'OUTER_BULL'), (17, 'OUTER_BULL'),
                        (17.001, 'SINGLE_INNER'), (96.999, 'SINGLE_INNER'),
                        (97, 'TRIPLE'), (107, 'TRIPLE'), (107.001, 'SINGLE_OUTER'),
                        (159.999, 'SINGLE_OUTER'), (160, 'DOUBLE'), (170, 'DOUBLE'),
                        (170.001, 'MISS')]:
            self.assertEqual(segment(0, r)[0]['ring'], ring)
        for index, number in enumerate(ORDER):
            angle = math.radians(index*18)
            self.assertEqual(segment(100*math.sin(angle), 100*math.cos(angle))[0]['number'], number)
        self.assertEqual(segment(100*math.sin(math.radians(9.001)), 100*math.cos(math.radians(9.001)))[0]['number'], 1)

    def test_scoring_uncertainty_boundaries(self):
        for boundary in (7, 17, 97, 107, 160, 170):
            for offset in (-1, -.5, 0, .5, 1):
                with (self.subTest(boundary=boundary, offset=offset),
                      self.assertRaisesRegex(ValueError, 'radial scoring boundary')):
                    confident_segment(0, boundary+offset)
        for index in range(20):
            angle = math.radians(9+index*18)
            with self.assertRaisesRegex(ValueError, 'angular scoring boundary'):
                confident_segment(80*math.sin(angle), 80*math.cos(angle))
        # Angular wires do not continue through the bull or outside scoring area.
        self.assertEqual(confident_segment(0, 0)[1], 50)
        self.assertEqual(confident_segment(200, 200)[1], 0)
        self.assertEqual(confident_segment(0, 102)[1], 60)
        angle = math.radians(234)
        self.assertEqual(confident_segment(165*math.sin(angle), 165*math.cos(angle)),
                         ({'number': 16, 'ring': 'DOUBLE'}, 32))

    def test_uncertain_images_latch_until_explicit_reset(self):
        self.rig.throw(0, 97.5)
        self.settle()
        self.assertFalse(self.events('throw.detected'))
        self.assertTrue(self.service.snapshot()['pending']['reviewRequired'])
        self.assertIn('radial scoring boundary', self.service.faults[0])
        # Changes cannot make a rejected throw become accepted later.
        self.rig.takeout()
        self.rig.throw(0, 102)
        self.settle()
        self.assertFalse(self.events('throw.detected'))
        self.assertFalse(self.events('takeout.started'))
        self.service.control('stop')
        self.service.control('start')
        self.settle()
        self.assertTrue(self.service.snapshot()['pending']['reviewRequired'])
        self.service.control('reset')
        self.settle()
        self.assertFalse(self.service.snapshot()['pending']['reviewRequired'])
        self.assertEqual(self.service.snapshot()['occupancy'], 1)
        self.assertFalse(self.events('throw.detected'))
        angle = math.radians(234)
        self.rig.throw(165*math.sin(angle), 165*math.cos(angle))
        self.settle()
        self.assertEqual(self.events('throw.detected')[0]['throw']['segment'],
                         {'number': 16, 'ring': 'DOUBLE'})

    def test_angular_wire_images_and_center_d16(self):
        self.rig.throw(50, 50)
        self.settle()
        self.assertFalse(self.events('throw.detected'))
        self.assertIn('angular scoring boundary', self.service.faults[0])
        self.rig.takeout()
        self.service.control('reset')
        self.settle()
        angle = math.radians(234)
        self.rig.throw(165*math.sin(angle), 165*math.cos(angle))
        self.settle()
        throw = self.events('throw.detected')[0]['throw']
        self.assertEqual((throw['segment'], throw['value']), ({'number': 16, 'ring': 'DOUBLE'}, 32))

    def test_matching_and_transition_ambiguity(self):
        for old, new in [([(0, 0)], [(-2, 0), (2, 0)]),
                         ([(-2, 0), (2, 0)], [(0, 0)])]:
            with self.assertRaisesRegex(ValueError, 'ambiguous occupancy'):
                occupancy_changes(old, new)
        with self.assertRaises(ValueError):
            match_points([(0, 0), (2, 0)], [(0, 0), (2, 0)])
        self.rig.throw(0, 102)
        self.rig.throw(60, 45)
        self.settle()
        self.assertTrue(self.service.snapshot()['pending']['reviewRequired'])
        self.assertFalse(self.events('throw.detected'))
        self.assertEqual(self.service.snapshot()['occupancy'], 0)
        self.rig.takeout(1)
        self.settle()
        self.assertFalse(self.events('throw.detected'))
        self.service.control('reset')
        self.settle()
        self.assertEqual(self.service.snapshot()['occupancy'], 1)

    def test_image_noise_shape_and_view_disagreement(self):
        detector = ImageDetector(self.rig.calibrations, self.rig.reference)
        noisy = dict(self.rig.reference)
        pixels = bytearray(noisy['cam0'])
        pixels[100*480+100] = 0
        noisy['cam0'] = bytes(pixels)
        with self.assertRaisesRegex(ValueError, 'ambiguous silhouette'):
            detector.observe(noisy)
        self.assertEqual(detector.stable_frames, 0)
        # Low-amplitude noise does not become a silhouette or a scored impact.
        low_noise = {k: bytes(p+1 for p in image) for k, image in self.rig.reference.items()}
        points = None
        for _ in range(3):
            points = detector.observe(low_noise)
        self.assertEqual(points, [])
        self.rig.throw(0, 102)
        images = self.rig.capture()
        self.rig.takeout()
        self.rig.throw(60, 45)
        images['cam1'] = self.rig.capture()['cam1']
        with self.assertRaisesRegex(ValueError, 'views disagree'):
            detector.observe(images)

    def test_invalid_calibration_and_edge_silhouette(self):
        for values in ([1, 0, 0, 0, 0, 0], [True, 0, 0, 0, -1, 0],
                       [1e308, 0, 0, 0, 1e308, 0], [1, 0, 0, 0, float('nan'), 0]):
            calibrations = dict(self.rig.calibrations)
            calibrations['cam0'] = values
            with self.assertRaises(ValueError):
                ImageDetector(calibrations, self.rig.reference)
        with self.assertRaises(ValueError):
            # Deliberately bypass the static contract to test runtime input validation.
            ImageDetector(self.rig.calibrations, self.rig.reference, width=cast(int, 480.0))
        image = bytearray(self.rig.reference['cam0'])
        for row in range(96, 105):
            for col in range(7):
                if (col-2)**2 + (row-100)**2 <= 3.2**2:
                    image[row*480+col] = 20
        with self.assertRaisesRegex(ValueError, 'ambiguous silhouette'):
            components(bytes(image), self.rig.reference['cam0'], 480, 480, self.rig.calibrations['cam0'])

    def test_removed_and_added_transition_emits_nothing_before_reset(self):
        self.rig.throw(0, 102)
        self.settle()
        self.rig.takeout()
        self.rig.throw(60, 45)
        self.settle()
        self.assertTrue(self.service.snapshot()['pending']['reviewRequired'])
        self.assertEqual(len(self.events('throw.detected')), 1)
        self.assertFalse(self.events('takeout.started'))
        self.assertEqual(self.service.snapshot()['occupancy'], 1)
        self.service.tick()
        self.assertTrue(self.service.snapshot()['faults'])
        self.service.control('reset')
        self.settle()
        self.assertFalse(self.service.snapshot()['pending']['reviewRequired'])
        self.assertEqual(len(self.events('throw.detected')), 1)

    def test_board_reference_artwork_does_not_change_detection_mask(self):
        for image in self.rig.reference.values():
            self.assertGreater(len(set(image)), 5)
            self.assertGreaterEqual(min(image), 120)
        self.rig.throw(0, 102)
        frames = self.rig.capture()
        for camera in frames:
            changed = [i for i, (p, q) in enumerate(zip(frames[camera], self.rig.reference[camera]))
                       if abs(p-q) > 80]
            self.assertTrue(25 <= len(changed) <= 38)
        self.settle()
        self.assertEqual(self.events('throw.detected')[0]['throw']['value'], 60)

    def test_image_truth_separation_and_stability(self):
        images = self.rig.capture()
        self.assertTrue(all(type(v) is bytes for v in images.values()))
        self.rig.throw(0, 102)
        self.service.tick()
        self.service.tick()
        self.assertFalse(self.events('throw.detected'))
        self.service.tick()
        throw = self.events('throw.detected')[0]['throw']
        self.assertEqual(throw['segment'], {'number': 20, 'ring': 'TRIPLE'})
        self.assertEqual(throw['value'], 60)
        self.assertEqual(throw['source'], 'board')
        self.assertTrue(throw['ts'].endswith('Z'))
        self.assertAlmostEqual(throw['coords']['y'], 102/170, delta=.005)
        for _ in range(5):
            self.service.tick()
        self.assertEqual(len(self.events('throw.detected')), 1)
        # Poison simulator truth after capturing: detector sees only recorded pixels.
        saved = self.rig.capture()
        self.rig.takeout()
        self.rig.throw(-100, 0)
        detector = ImageDetector(self.rig.calibrations, self.rig.reference)
        points = None
        for _ in range(3):
            points = detector.observe(saved)
        assert points is not None, 'three stable frames must produce measured points'
        self.assertAlmostEqual(points[0][1], 102, delta=1)

    def test_three_throws_partial_then_full_takeout(self):
        for point in [(0, 102), (60, 45), (-80, -60)]:
            self.rig.throw(*point)
            self.settle()
        self.assertEqual(self.service.snapshot()['occupancy'], 3)
        self.rig.takeout(1)
        self.settle()
        self.assertEqual(len(self.events('takeout.started')), 1)
        self.assertFalse(self.events('takeout.completed'))
        self.rig.takeout()
        self.settle()
        self.assertEqual(len(self.events('takeout.completed')), 1)
        self.settle()
        self.assertEqual(len(self.events('takeout.completed')), 1)
        ids = [e['throw']['id'] for e in self.events('throw.detected')]
        self.assertEqual(len(set(ids)), 3)

    def test_reset_stop_restart_no_reinterpretation(self):
        self.rig.throw(0, 102)
        self.settle()
        self.service.control('reset')
        self.settle()
        self.assertEqual(self.service.snapshot()['occupancy'], 1)
        self.assertEqual(len(self.events('throw.detected')), 1)
        self.assertFalse(self.events('takeout.started'))
        self.service.control('stop')
        self.rig.throw(50, 50)
        self.settle()
        self.service.control('start')
        self.settle()
        self.assertEqual(len(self.events('throw.detected')), 1)
        self.assertEqual(self.service.snapshot()['occupancy'], 2)
        restarted = Service(self.rig)
        for _ in range(3):
            restarted.tick()
        self.assertFalse([e for _, e in restarted.history if e['type'] == 'throw.detected'])
        self.assertNotEqual(restarted.session, self.service.session)
        with self.assertRaises(ValueError):
            restarted.cursor(f'{self.service.session}:0')

    def test_reset_during_pending_change(self):
        self.rig.throw(0, 100)
        self.service.tick()
        self.service.control('reset')
        self.settle()
        self.assertFalse(self.events('throw.detected'))
        self.assertEqual(self.service.snapshot()['occupancy'], 1)

    def test_bad_views_block_scoring(self):
        detector = ImageDetector(self.rig.calibrations, self.rig.reference)
        self.rig.throw(0, 100)
        frames = self.rig.capture()
        frames['cam1'] = self.rig.reference['cam1']
        for _ in range(3):
            with self.assertRaises(ValueError):
                detector.observe(frames)
        self.assertEqual(detector.stable_frames, 0)
        frames['unknown'] = frames.pop('cam1')
        with self.assertRaises(ValueError):
            detector.observe(frames)
        original = self.rig.capture
        self.rig.capture = lambda: frames
        self.settle()
        self.assertEqual(self.service.status, 'Error')
        self.assertFalse(self.events('throw.detected'))
        self.rig.capture = original

    def test_two_cameras_and_ambiguous_overlap(self):
        rig = synthetic(2)
        service = Service(rig)
        for _ in range(3):
            service.tick()
        rig.throw(10, 100)
        for _ in range(3):
            service.tick()
        self.assertEqual(service.snapshot()['occupancy'], 1)
        rig.throw(11, 100)
        for _ in range(3):
            service.tick()
        # Identical/overlapping silhouettes cannot reliably resolve a second dart.
        self.assertEqual(len([e for _, e in service.history if e['type'] == 'throw.detected']), 1)
        self.assertEqual(service.status, 'Error')

    def test_transient_images_and_acquisition_failure(self):
        self.rig.throw(0, 102)
        self.service.tick()
        self.rig.takeout()
        self.settle()
        self.assertFalse(self.events('throw.detected'))
        original = self.rig.capture
        def fail():
            raise OSError('camera disconnected')
        self.rig.capture = fail
        self.service.tick()
        self.assertEqual(self.service.status, 'Error')
        self.assertEqual(self.service.snapshot()['faults'], ['camera disconnected'])
        self.rig.capture = original
        self.rig.throw(0, 102)
        self.service.tick()
        self.service.tick()
        self.assertFalse(self.events('throw.detected'))
        self.assertTrue(self.service.faults)
        self.service.tick()
        self.assertEqual(len(self.events('throw.detected')), 1)
        self.assertFalse(self.service.faults)

    def test_concurrent_event_ids(self):
        workers = [threading.Thread(target=lambda: [self.service.emit({'type': 'board.heartbeat'})
                                                   for _ in range(30)]) for _ in range(4)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
        ids = [n for n, _ in self.service.history]
        self.assertEqual(ids, list(range(1, self.service.counter+1)))

    def test_cursor_history_and_heartbeat(self):
        service = Service(self.rig, history_size=3)
        for _ in range(5):
            service.emit({'type': 'board.heartbeat'})
        self.assertEqual(service.cursor(None), 5)
        self.assertEqual(service.cursor(f'{service.session}:2'), 2)
        for cursor in ['garbage', f'{service.session}:1', f'{service.session}:6', 'other:5']:
            with self.assertRaises(ValueError):
                service.cursor(cursor)
        service.last_heartbeat -= 2
        service.tick()
        self.assertEqual(service.history[-1][1]['type'], 'board.heartbeat')

    def test_replay_images(self):
        path = Path(__file__).resolve().parents[2] / 'testdata/vision/sequence.json'
        source = ReplaySource(path)
        service = Service(source)
        for _ in range(len(source.frames)):
            service.tick()
        kinds = [e['type'] for _, e in service.history]
        self.assertEqual(kinds.count('throw.detected'), 3)
        self.assertEqual(kinds.count('takeout.started'), 1)
        self.assertEqual(kinds.count('takeout.completed'), 1)
        self.assertEqual(service.snapshot()['occupancy'], 0)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.service = Service(synthetic())
        for _ in range(3):
            self.service.tick()
        self.server = Server(('127.0.0.1', 0), self.service)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_port

    def tearDown(self):
        self.service.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        connection.request(method, path, json.dumps(body) if body is not None else None, headers or {})
        response = connection.getresponse()
        data = response.read()
        connection.close()
        return response.status, response.getheader('Content-Type'), data

    def test_contracts(self):
        self.assertEqual(self.request('GET', '/health')[0], 200)
        state = json.loads(self.request('GET', '/state')[2])
        self.assertIn('pending', state)
        self.assertIn('faults', state)
        for action in ('stop', 'start', 'reset'):
            status, _, data = self.request('POST', '/control/'+action, {})
            self.assertEqual((status, json.loads(data)), (200, {'ok': True}))
        for _ in range(3):
            self.service.tick()
        self.assertEqual(self.request('POST', '/sim/throw', {'x_mm': 0, 'y_mm': 102})[0], 200)
        for _ in range(3):
            self.service.tick()
        status, mime, data = self.request('GET', '/cameras/cam0/frame')
        self.assertEqual((status, mime), (200, 'image/png'))
        self.assertTrue(data.startswith(b'\x89PNG'))
        self.assertEqual(self.request('GET', '/cameras/no/frame')[0], 404)
        self.assertEqual(self.request('POST', '/sim/throw', {'x_mm': 'bad', 'y_mm': 1})[0], 400)
        self.assertEqual(self.request('POST', '/sim/throw', {'x_mm': float('nan'), 'y_mm': 1})[0], 400)
        self.assertEqual(self.request('POST', '/sim/takeout', {'count': 0})[0], 400)
        self.assertEqual(self.request('POST', '/sim/reset', {})[0], 200)
        for _ in range(3):
            self.service.tick()
        self.assertFalse([e for _, e in self.service.history if e['type'].startswith('takeout.')])
        self.assertEqual(self.request('GET', '/events', headers={'Last-Event-ID': 'old:1'})[0], 409)
        self.assertEqual(self.request('POST', '/unknown', {})[0], 404)

    def test_readiness_stopped_simulation_and_review(self):
        self.service.control('reset')
        self.assertEqual(self.request('POST', '/sim/throw', {'x_mm': 0, 'y_mm': 102})[0], 409)
        self.assertEqual(self.service.source.capture(), self.service.source.reference)
        self.service.control('stop')
        self.assertEqual(self.request('POST', '/sim/throw', {'x_mm': 0, 'y_mm': 102})[0], 200)
        for _ in range(3):
            self.service.tick()
        self.service.control('start')
        for _ in range(3):
            self.service.tick()
        self.assertFalse([e for _, e in self.service.history if e['type'] == 'throw.detected'])
        self.assertEqual(self.request('POST', '/sim/throw', {'x_mm': 50, 'y_mm': 50})[0], 200)
        for _ in range(3):
            self.service.tick()
        state = json.loads(self.request('GET', '/state')[2])
        self.assertTrue(state['pending']['reviewRequired'])
        self.assertEqual(self.request('POST', '/sim/throw', {'x_mm': 60, 'y_mm': 45})[0], 409)
        self.assertEqual(self.request('POST', '/control/reset', {})[0], 200)
        for _ in range(3):
            self.service.tick()
        self.assertEqual(self.request('POST', '/sim/throw', {'x_mm': 60, 'y_mm': 45})[0], 200)

    def test_strict_body_validation(self):
        for value in (True, False, '1', None, [], {}, 201, 10**400, float('inf')):
            self.assertEqual(self.request('POST', '/sim/throw', {'x_mm': value, 'y_mm': 102})[0], 400)
        for value in (True, False, 1.0, None, '1', [], {}, -1, 0):
            self.assertEqual(self.request('POST', '/sim/takeout', {'count': value})[0], 400)
        for raw in (b'{"x_mm":1,"x_mm":2,"y_mm":102}', b'{"x_mm":NaN,"y_mm":102}',
                    b'{"x_mm":Infinity,"y_mm":102}', b'\xff', b'null', b'[]', b'{' , b'x'*4097):
            connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
            connection.request('POST', '/sim/throw', raw)
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertEqual(response.getheader('Connection'), 'close')
            response.read()
            connection.close()
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        connection.request('POST', '/control/reset', b'0\r\n\r\n', headers={'Transfer-Encoding': 'chunked'})
        response = connection.getresponse()
        self.assertEqual(response.status, 400)
        response.read()
        connection.close()

    def test_invalid_request_framing(self):
        for lengths in (['-1'], ['1.0'], ['+1'], ['0', '0']):
            connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
            connection.putrequest('POST', '/control/reset')
            for length in lengths:
                connection.putheader('Content-Length', length)
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertEqual(response.getheader('Connection'), 'close')
            response.read()
            connection.close()

    def test_sse_fresh_and_reconnect(self):
        self.assertEqual(self.request('POST', '/sim/throw', {'x_mm': 0, 'y_mm': 102})[0], 200)
        for _ in range(3):
            self.service.tick()
        self.assertEqual(sum(e['type'] == 'throw.detected' for _, e in self.service.history), 1)
        historic_cutoff = self.service.counter
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        connection.request('GET', '/events')
        response = connection.getresponse()
        self.assertEqual(response.getheader('Content-Type'), 'text/event-stream')
        self.assertEqual(response.fp.readline(), b': connected\n')
        self.assertEqual(response.fp.readline(), b'\n')
        # No worker or explicit heartbeat emit: the handshake must provide it now.
        event_id = response.fp.readline().decode().strip().removeprefix('id: ')
        self.assertEqual(event_id, f'{self.service.session}:{historic_cutoff+1}')
        self.assertEqual(json.loads(response.fp.readline().decode()[6:]), {'type': 'board.heartbeat'})
        self.assertEqual(response.fp.readline(), b'\n')
        response.close()
        connection.close()
        self.service.emit({'type': 'board.status', 'status': 'Throw', 'running': True})
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        connection.request('GET', '/events', headers={'Last-Event-ID': event_id})
        response = connection.getresponse()
        response.fp.readline()
        response.fp.readline()
        self.assertTrue(response.fp.readline().startswith(b'id: '))
        event = json.loads(response.fp.readline().decode()[6:])
        self.assertEqual(event['type'], 'board.status')
        response.close()
        connection.close()

    def test_sse_immediate_cursor_replays_throw_in_disconnect_gap_once(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        connection.request('GET', '/events')
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.fp.readline(), b': connected\n')
        self.assertEqual(response.fp.readline(), b'\n')
        event_id = response.fp.readline().decode().strip().removeprefix('id: ')
        session, counter = event_id.split(':')
        self.assertEqual(session, self.service.session)
        self.assertEqual(int(counter), self.service.counter)
        self.assertEqual(json.loads(response.fp.readline().decode()[6:]), {'type': 'board.heartbeat'})
        self.assertEqual(response.fp.readline(), b'\n')
        response.close()
        connection.close()

        # A real image-derived throw lands while the subscriber is disconnected.
        self.assertEqual(self.request('POST', '/sim/throw', {'x_mm': 0, 'y_mm': 102})[0], 200)
        for _ in range(3):
            self.service.tick()
        throws = [e for _, e in self.service.history if e['type'] == 'throw.detected']
        self.assertEqual(len(throws), 1)
        self.service.emit({'type': 'board.heartbeat'})
        replay_end = self.service.counter

        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        connection.request('GET', '/events', headers={'Last-Event-ID': event_id})
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.fp.readline(), b': connected\n')
        self.assertEqual(response.fp.readline(), b'\n')
        self.assertEqual(self.service.counter, replay_end)  # reconnect allocates nothing
        replayed = []
        ids = []
        while not ids or ids[-1] != replay_end:
            line = response.fp.readline().decode().strip()
            self.assertTrue(line.startswith(f'id: {session}:'))
            ids.append(int(line.rsplit(':', 1)[1]))
            replayed.append(json.loads(response.fp.readline().decode()[6:]))
            self.assertEqual(response.fp.readline(), b'\n')
        self.assertEqual(ids, list(range(int(counter)+1, replay_end+1)))
        self.assertEqual([e for e in replayed if e['type'] == 'throw.detected'], throws)
        self.assertEqual(throws[0]['throw']['value'], 60)
        response.close()
        connection.close()

    def test_replay_rejects_sim_controls(self):
        path = Path(__file__).resolve().parents[2] / 'testdata/vision/sequence.json'
        self.service.source = ReplaySource(path)
        self.assertEqual(self.request('POST', '/sim/throw', {'x_mm': 0, 'y_mm': 1})[0], 409)


if __name__ == '__main__':
    unittest.main()
