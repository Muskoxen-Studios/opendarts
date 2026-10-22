"""Independent analytic cameras/pixel fixtures; never feed fixture truth to the service."""

import base64
import copy
import http.client
import json
import math
import threading
import time
import unittest
from unittest.mock import patch

from main import Server, Service
from rendered import CAMERAS, RenderedSource, reconstruct

WIDTH, HEIGHT = 640, 480


def configuration():
    cameras = {}
    for i, key in enumerate(CAMERAS):
        angle = i*2*math.pi/3
        center = (260*math.cos(angle), 260*math.sin(angle), 100)
        norm = math.sqrt(260**2+100**2)
        forward = tuple(-v/norm for v in center)
        right = (-math.sin(angle), math.cos(angle), 0)
        down = (forward[1]*right[2]-forward[2]*right[1],
                forward[2]*right[0]-forward[0]*right[2],
                forward[0]*right[1]-forward[1]*right[0])
        rows = (right, down, forward)
        cameras[key] = {'K': [400, 0, 320, 0, 400, 240, 0, 0, 1],
                        'R': [v for row in rows for v in row],
                        't': [-sum(a*b for a, b in zip(row, center)) for row in rows],
                        'reference': base64.b64encode(bytes([180])*(WIDTH*HEIGHT)).decode()}
    return {'width': WIDTH, 'height': HEIGHT, 'cameras': cameras}


def pixel(camera, point):
    # Fixture projection is intentionally separate from the implementation under test.
    xyz = [sum(camera['R'][3*i+j]*point[j] for j in range(3))+camera['t'][i] for i in range(3)]
    return (400*xyz[0]/xyz[2]+320, 400*xyz[1]/xyz[2]+240)


def analytic_lines(config, impact, slope=(0, 0)):
    result = {}
    for key in CAMERAS:
        first = pixel(config['cameras'][key], (*impact, 0))
        last = pixel(config['cameras'][key], (impact[0]+60*slope[0], impact[1]+60*slope[1], 60))
        a, b = first[1]-last[1], last[0]-first[0]
        norm = math.hypot(a, b)
        result[key] = (a/norm, b/norm, -(a*first[0]+b*first[1])/norm)
    return result


def images(config, darts):
    frames = {}
    for key in CAMERAS:
        frame = bytearray([180])*(WIDTH*HEIGHT)
        for x, y, dx, dy in darts:
            # Tip is invisible: shaft begins at z=10. A wide flight at its far end
            # exercises cross-section extraction rather than whole-silhouette PCA.
            first = pixel(config['cameras'][key], (x+10*dx, y+10*dy, 10))
            last = pixel(config['cameras'][key], (x+90*dx, y+90*dy, 90))
            vx, vy = last[0]-first[0], last[1]-first[1]
            length2 = vx*vx+vy*vy
            for py in range(max(0, int(min(first[1], last[1])-14)), min(HEIGHT, int(max(first[1], last[1])+15))):
                for px in range(max(0, int(min(first[0], last[0])-14)), min(WIDTH, int(max(first[0], last[0])+15))):
                    fraction = ((px+0.5-first[0])*vx+(py+0.5-first[1])*vy)/length2
                    perpendicular = abs((px+0.5-first[0])*vy-(py+0.5-first[1])*vx)/math.sqrt(length2)
                    radius = 1.8 if fraction < 0.75 else 9
                    if 0 <= fraction <= 1 and perpendicular <= radius:
                        frame[py*WIDTH+px] = 25
        frames[key] = bytes(frame)
    return frames


def upload(source, frames, sequence=None):
    n = source.sequence+1 if sequence is None else sequence
    return {'session': source.render_session, 'sequence': n, 'timestampMs': n*100,
            'images': {k: base64.b64encode(v).decode() for k, v in frames.items()}}


class GeometryTests(unittest.TestCase):
    def test_analytic_axis_and_translation(self):
        config = configuration()
        calibrations = {k: c for k, c in config['cameras'].items()}
        for impact, slope in (((0, 0), (0, 0)), ((42, 66), (0.2, -0.15)), ((-90, -30), (-0.1, 0.3))):
            result, uncertainty, error = reconstruct(calibrations, analytic_lines(config, impact, slope))
            self.assertAlmostEqual(result[0], impact[0], places=7)
            self.assertAlmostEqual(result[1], impact[1], places=7)
            self.assertGreaterEqual(uncertainty, 1)
            self.assertLess(error, 1e-8)
        bad = analytic_lines(config, (0, 0))
        a, b, c = bad['cam2']
        bad['cam2'] = (a, b, c+15)
        with self.assertRaises(ValueError):
            reconstruct(calibrations, bad)

    def test_invalid_calibration(self):
        for mutate in (
                lambda c: c['cameras'].pop('cam2'),
                lambda c: c['cameras']['cam0']['K'].__setitem__(0, -1),
                lambda c: c['cameras']['cam0']['R'].__setitem__(0, 2),
                lambda c: c['cameras']['cam0']['t'].__setitem__(0, float('nan')),
                lambda c: c['cameras'].__setitem__('cam1', copy.deepcopy(c['cameras']['cam0'])),
                lambda c: c.__setitem__('truth', [0, 0]),
                lambda c: c.__setitem__('width', True)):
            c = configuration()
            mutate(c)
            with self.assertRaises(ValueError):
                RenderedSource.configured(c)

    def test_uncertainty_covers_independent_offset_and_angle_errors(self):
        config = configuration()
        impact, slope = (42, 66), (0.2, -0.15)
        ideal = analytic_lines(config, impact, slope)
        supports = {}
        for key in CAMERAS:
            first = pixel(config['cameras'][key], (impact[0]+10*slope[0], impact[1]+10*slope[1], 10))
            last = pixel(config['cameras'][key], (impact[0]+70*slope[0], impact[1]+70*slope[1], 70))
            supports[key] = (((first[0]+last[0])/2, (first[1]+last[1])/2), math.dist(first, last))
        # Deterministic interior endpoint errors independent of the corner
        # enumeration in reconstruct. Angular errors pivot at the observed run.
        for offsets in ((0.2, -0.3, 0.4), (-0.6, 0.1, -0.2), (0, 0, 0)):
            for rotations in ((0, 0, 0), (0.002, -0.003, 0.001), (-0.004, 0.001, -0.002)):
                lines = {}
                for key, offset, angle in zip(CAMERAS, offsets, rotations):
                    a, b, c = ideal[key]
                    center, _ = supports[key]
                    na = a*math.cos(angle)-b*math.sin(angle)
                    nb = a*math.sin(angle)+b*math.cos(angle)
                    residual = a*center[0]+b*center[1]+c
                    lines[key] = (na, nb, residual-na*center[0]-nb*center[1]+offset)
                point, radius, _ = reconstruct(config['cameras'], lines, supports)
                self.assertGreaterEqual(radius, 1)
                self.assertLessEqual(math.dist(point, impact), radius)

    def test_shaft_pixels_without_visible_tip(self):
        service = Service(RenderedSource())
        config = configuration()
        service.configure_rendered(config)
        frames = images(config, [(0, 65, 0.05, -0.1)])
        for _ in range(3):
            service.source.submit(upload(service.source, frames))
            service.tick()
        self.assertFalse(service.faults, service.faults)
        self.assertEqual(len(service.occupancy), 1)
        x, y = service.occupancy[0]
        self.assertLess(math.hypot(x, y-65), 2)
        self.assertFalse(any(e['type'] == 'throw.detected' for _, e in service.history))
        self.assertTrue(service.detector.diagnostics['cam0']['candidateLines'])

    def test_upload_stability_and_takeout(self):
        service = Service(RenderedSource())
        config = configuration()
        service.configure_rendered(config)
        empty = images(config, [])
        def settle(frames):
            for _ in range(3):
                service.source.submit(upload(service.source, frames))
                service.tick()
        settle(empty)
        one = images(config, [(0, 65, 0, 0)])
        service.source.submit(upload(service.source, one))
        service.tick()
        for _ in range(5):
            service.tick()
        self.assertEqual(service.detector.stable_frames, 1)
        self.assertEqual(service.occupancy, [])
        for _ in range(2):
            service.source.submit(upload(service.source, one))
            service.tick()
        self.assertFalse(service.faults, service.faults)
        self.assertEqual(len(service.occupancy), 1)
        settle(one)
        throws = [e for _, e in service.history if e['type'] == 'throw.detected']
        self.assertEqual(len(throws), 1)
        # One camera still sees the dart: no false full takeout.
        occluded = dict(empty, cam2=one['cam2'])
        settle(occluded)
        self.assertTrue(service.faults)
        self.assertFalse(any(e['type'] == 'takeout.completed' for _, e in service.history))
        settle(empty)
        self.assertEqual([e['type'] for _, e in service.history if e['type'].startswith('takeout.')],
                         ['takeout.started', 'takeout.completed'])

    def test_multiple_separated_darts(self):
        service = Service(RenderedSource())
        config = configuration()
        service.configure_rendered(config)
        darts = []
        for dart in (None, (-62, 20, 0, 0), (38, 52, 0, 0), (0, -65, 0, 0)):
            if dart:
                darts.append(dart)
            frames = images(config, darts)
            for _ in range(3):
                service.source.submit(upload(service.source, frames))
                service.tick()
            self.assertFalse(service.faults, service.faults)
            self.assertEqual(len(service.occupancy), len(darts))
        self.assertEqual(sum(e['type'] == 'throw.detected' for _, e in service.history), 3)
        for remaining in (darts[1:], darts[2:], []):
            frames = images(config, remaining)
            for _ in range(3):
                service.source.submit(upload(service.source, frames))
                service.tick()
            self.assertFalse(service.faults, service.faults)
            self.assertEqual(len(service.occupancy), len(remaining))
        self.assertEqual([e['type'] for _, e in service.history if e['type'].startswith('takeout.')],
                         ['takeout.started', 'takeout.completed'])

    def test_clustered_addition_fails_closed(self):
        service = Service(RenderedSource())
        config = configuration()
        service.configure_rendered(config)
        for darts in ([], [(0, 65, 0, 0)], [(0, 65, 0, 0), (2, 65, 0, 0)]):
            frames = images(config, darts)
            for _ in range(3):
                service.source.submit(upload(service.source, frames))
                service.tick()
        self.assertTrue(service.faults)
        self.assertEqual(sum(e['type'] == 'throw.detected' for _, e in service.history), 1)
        self.assertFalse(any(e['type'] == 'takeout.completed' for _, e in service.history))

    def test_monotonic_atomic_and_stall(self):
        source = RenderedSource.configured(configuration())
        frames = images(configuration(), [])
        body = upload(source, frames)
        source.submit(body)
        for key, value in (('sequence', 0), ('timestampMs', 0), ('sequence', True),
                           ('timestampMs', float('inf')), ('session', 'old'), ('truth', [])):
            bad = upload(source, frames)
            bad[key] = value
            with self.assertRaises(ValueError):
                source.submit(bad)
            self.assertEqual(source.sequence, 0)
        bad = upload(source, frames)
        bad['images']['cam2'] = 'AAAA'
        with self.assertRaises(ValueError):
            source.submit(bad)
        self.assertEqual(len(source.queue), 1)
        service = Service(source)
        service.tick()
        source.received_at = time.monotonic()-4
        service.tick()
        self.assertEqual(service.status, 'Error')
        self.assertEqual(service.detector.stable_frames, 0)
        self.assertIn('cam0', service.images)


class RenderHTTPTests(unittest.TestCase):
    def setUp(self):
        self.service = Service(RenderedSource())
        self.server = Server(('127.0.0.1', 0), self.service)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.service.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def request(self, path, body=None, method='POST'):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.request(method, path, None if body is None else json.dumps(body))
        response = conn.getresponse()
        data = response.read()
        status = response.status
        conn.close()
        return status, data

    def test_protocol_and_sessions(self):
        sse_session = self.service.session
        cursor = self.service.subscribe(None)
        code, data = self.request('/render/configure', configuration())
        self.assertEqual(code, 200, data)
        session = json.loads(data)['session']
        self.assertNotEqual(session, sse_session)
        self.assertEqual(self.service.session, sse_session)
        self.assertEqual(self.service.cursor(f'{sse_session}:{cursor}'), cursor)
        code, data = self.request('/state', method='GET')
        state = json.loads(data)
        self.assertEqual(state['source'], 'rendered')
        self.assertEqual(state['renderSession'], session)
        self.assertEqual(len(state['cameras']), 3)
        body = upload(self.service.source, images(configuration(), []))
        self.assertEqual(self.request('/render/frames', body)[0], 200)
        self.assertEqual(self.request('/render/frames', body)[0], 400)
        self.assertEqual(self.request('/sim/throw', {'x_mm': 0, 'y_mm': 65})[0], 409)
        self.assertEqual(self.request('/render/reset', {'session': 'old'})[0], 400)
        self.assertEqual(self.request('/render/reset', {'session': session})[0], 200)
        self.assertEqual(self.request('/cameras/cam0/frame', method='GET')[0], 200)
        self.assertEqual(self.request('/render/configure', configuration())[0], 200)
        self.assertEqual(self.request('/render/frames', body)[0], 400)
        self.assertFalse(any(e['type'].startswith('takeout.') or e['type'] == 'throw.detected'
                             for _, e in self.service.history))

    def test_frame_receipt_does_not_wait_for_shaft_processing(self):
        self.service.configure_rendered(configuration())
        source = self.service.source
        frames = source.reference
        self.service.submit_rendered(upload(source, frames))
        processing, release, acknowledged = threading.Event(), threading.Event(), threading.Event()
        result = []
        original = self.service.detector.observe
        def slow_observe(frame):
            processing.set()
            if not release.wait(3):
                raise TimeoutError('test did not release processing')
            return original(frame)
        def submit():
            try:
                result.append(self.request('/render/frames', upload(source, frames)))
            finally:
                acknowledged.set()
        with patch.object(self.service.detector, 'observe', slow_observe):
            worker = threading.Thread(target=self.service.tick)
            sender = threading.Thread(target=submit)
            worker.start()
            try:
                self.assertTrue(processing.wait(1))
                sender.start()
                # The state lock is still held by slow_observe, but upload
                # acknowledgement and receive-time liveness must advance.
                self.assertTrue(acknowledged.wait(1), 'upload blocked on detection')
                self.assertEqual(result[0][0], 200, result)
                self.assertEqual(source.sequence, 1)
                self.assertEqual(len(source.queue), 1)
            finally:
                release.set()
                worker.join(3)
                if sender.ident is not None:
                    sender.join(3)
        self.service.tick()
        self.assertTrue(self.service.adopt)
        self.service.submit_rendered(upload(source, frames))
        self.service.tick()
        self.assertFalse(self.service.adopt)
        self.assertFalse(self.service.faults, self.service.faults)
        self.assertFalse(any(e['type'] == 'throw.detected' for _, e in self.service.history))

    def test_full_queue_applies_backpressure_without_dropping_frames(self):
        self.service.configure_rendered(configuration())
        source = self.service.source
        for _ in range(6):
            self.service.submit_rendered(upload(source, source.reference))
        waiting, completed = threading.Event(), threading.Event()
        response = []
        body = upload(source, source.reference)
        def submit():
            try:
                response.append(self.request('/render/frames', body))
            finally:
                completed.set()
        original_wait = self.service.acquisition.wait
        def wait(timeout=None):
            waiting.set()
            return original_wait(timeout)
        sender = threading.Thread(target=submit)
        with patch.object(self.service.acquisition, 'wait', wait):
            sender.start()
            try:
                self.assertTrue(waiting.wait(1))
                self.assertFalse(completed.is_set())
                self.assertEqual(len(source.queue), 6)
                self.service.tick()
                self.assertTrue(completed.wait(1))
                self.assertEqual(response[0][0], 200, response)
                self.assertEqual(len(source.queue), 6)
                self.assertEqual(source.sequence, 6)
            finally:
                sender.join(5)

    def test_waiting_upload_cannot_enter_a_reconfigured_session(self):
        self.service.configure_rendered(configuration())
        source = self.service.source
        for _ in range(6):
            self.service.submit_rendered(upload(source, source.reference))
        body = upload(source, source.reference)
        waiting, completed = threading.Event(), threading.Event()
        response = []
        original_wait = self.service.acquisition.wait
        def wait(timeout=None):
            waiting.set()
            return original_wait(timeout)
        def submit():
            try:
                response.append(self.request('/render/frames', body))
            finally:
                completed.set()
        sender = threading.Thread(target=submit)
        with patch.object(self.service.acquisition, 'wait', wait):
            sender.start()
            try:
                self.assertTrue(waiting.wait(1))
                self.service.configure_rendered(configuration())
                self.assertTrue(completed.wait(1))
                self.assertEqual(response[0][0], 400, response)
                self.assertIn(b'stale', response[0][1])
                self.assertEqual(self.service.source.sequence, -1)
                self.assertEqual(len(self.service.source.queue), 0)
            finally:
                sender.join(5)

    def test_render_routes_reject_nonrendered_source(self):
        from sources import synthetic
        self.service.source = synthetic()
        for path in ('/render/configure', '/render/frames', '/render/reset'):
            self.assertEqual(self.request(path, {})[0], 409)

    def test_full_resolution_upload_and_legacy_compatibility(self):
        config = configuration()
        config.update(width=1280, height=720)
        reference = base64.b64encode(bytes([180])*(1280*720)).decode()
        for camera in config['cameras'].values():
            camera['K'] = [640/math.tan(math.radians(50)), 0, 640,
                           0, 640/math.tan(math.radians(50)), 360, 0, 0, 1]
            camera['reference'] = reference
        self.assertGreater(len(json.dumps(config)), 2*1024*1024)
        code, data = self.request('/render/configure', config)
        self.assertEqual(code, 200, data)
        source = self.service.source
        self.assertEqual((source.width, source.height), (1280, 720))
        self.assertTrue(all(len(v) == 1280*720 for v in source.reference.values()))
        batch = upload(source, {k: bytes([180])*(1280*720) for k in CAMERAS})
        code, data = self.request('/render/frames', batch)
        self.assertEqual(code, 200, data)
        batch['sequence'] += 1
        batch['timestampMs'] += 100
        batch['images']['cam0'] = base64.b64encode(bytes(640*480)).decode()
        self.assertEqual(self.request('/render/frames', batch)[0], 400)
        self.assertEqual(self.request('/render/configure', configuration())[0], 200)
        self.assertEqual((self.service.source.width, self.service.source.height), (640, 480))

    def test_request_cap_and_extra_fields(self):
        self.assertEqual(self.request('/render/configure', configuration())[0], 200)
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.putrequest('POST', '/render/frames')
        conn.putheader('Content-Length', str(6*1024*1024+1))
        conn.endheaders()
        response = conn.getresponse()
        self.assertEqual(response.status, 400)
        response.read()
        conn.close()
        bad = upload(self.service.source, images(configuration(), []))
        bad['coords'] = [0, 65]
        self.assertEqual(self.request('/render/frames', bad)[0], 400)


if __name__ == '__main__':
    unittest.main()
