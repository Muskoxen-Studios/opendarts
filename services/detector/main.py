"""Local native detector with simulated, replay, rendered and USB camera sources.

Rendered sources can explicitly load --parameters PATH: a plain (possibly partial)
DetectionParameters JSON object. For benchmark tune artifacts, export only
selected.parameters, not the enclosing artifact or selected object. No tuned
configuration is discovered or loaded automatically.
"""

import argparse
import hashlib
import glob
import sys
import json
import os
import pickle
import tempfile
import struct
import threading
import time
import uuid
import zlib
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import cast

from parameters import DEFAULT_PARAMETERS, DetectionParameters
from sources import ReplaySource, synthetic
from rendered import CAMERAS, RenderedSource, PerspectiveDetector, exact
from camera_source import CameraSource
from calibration import calibrate
from live_model import LiveModel, board_point
from stability import StableFrames
from vision import ImageDetector, confident_segment, occupancy_changes


def strict_json(data):
    def constant(value):
        raise ValueError(f'non-finite JSON number: {value}')
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f'duplicate JSON key: {key}')
            result[key] = value
        return result
    return json.loads(data, parse_constant=constant, object_pairs_hook=unique_object)


def png(pixels, width, height):
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind+data))
    rows = b''.join(b'\0' + pixels[y*width:(y+1)*width] for y in range(height))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 0, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


class Service:
    def __init__(self, source, history_size=512, parameters=DEFAULT_PARAMETERS, live_model=None, camera_config=None, model_path=None):
        self.parameters = parameters
        self.camera_config = Path(camera_config) if camera_config else None
        self.model_path = model_path
        self.source = source
        self.live_model = live_model
        self.rgb_accepted = None
        self.stabilizer = StableFrames() if isinstance(source, CameraSource) else None
        self.model_diagnostics = None
        self.width, self.height = getattr(source, 'width', 480), getattr(source, 'height', 480)
        self.detector = (PerspectiveDetector(source, self.parameters) if isinstance(source, (RenderedSource, CameraSource)) else
                         ImageDetector(source.calibrations, source.reference, self.width, self.height))
        self.condition = threading.Condition(threading.RLock())
        # Frame receipt must remain responsive while the worker fits shafts.
        # Always acquire condition before acquisition when both are needed.
        self.acquisition = threading.Condition(threading.RLock())
        self.session = uuid.uuid4().hex
        self.counter = 0
        self.history = deque(maxlen=history_size)
        self.running = not isinstance(source, CameraSource) or bool(source.calibrations)
        self.calibration_snapshot = None
        self.status = 'Starting'
        self.occupancy = []
        self.faults = []
        self.review_fault = None
        self.images = {}
        self.adopt = True
        self.taking_out = False
        self.closed = threading.Event()
        self.thread = None
        self.last_heartbeat = time.monotonic()

    def emit(self, event):
        # All producers and consumers share the same condition lock.
        with self.condition:
            self.counter += 1
            self.history.append((self.counter, event))
            self.condition.notify_all()

    def set_status(self, status):
        if status != self.status:
            self.status = status
            self.emit({'type': 'board.status', 'status': status, 'running': self.running})

    def tick(self):
        with self.condition:
            try:
                if not isinstance(self.source, (RenderedSource, CameraSource)):
                    self.images = {}
                with self.acquisition:
                    try:
                        frame = self.source.capture()
                    finally:
                        self.acquisition.notify_all()
                if frame is not None and self.stabilizer is not None and self.source.calibrations:
                    stable = self.stabilizer.observe(frame, self.source.rgb)
                    if stable is None:
                        frame = None
                    else:
                        frame, self.source.rgb = stable
                if frame is not None:
                    self.images = frame
                    points = (None if isinstance(self.source, CameraSource) and not self.source.calibrations
                              else self.detector.observe(frame))
                    if isinstance(self.source, CameraSource) and not self.source.calibrations:
                        self.faults = []
                        self.set_status('Setup')
                else:
                    points = None
                if self.review_fault:
                    raise ValueError(self.review_fault)
                if points is not None:
                    if self.adopt or not self.running:
                        self.occupancy = points
                        self.adopt = False
                        self.taking_out = False
                    else:
                        try:
                            self.transition(points)
                        except ValueError as exc:
                            self.review_fault = str(exc)
                            raise
                    if isinstance(self.detector, PerspectiveDetector):
                        self.detector.accept(self.images, points)
                        if isinstance(self.source, CameraSource):
                            self.rgb_accepted = dict(self.source.rgb)
                    self.faults = []
                    self.set_status('Stopped' if not self.running else (
                        'Takeout in progress' if self.taking_out else
                        'Takeout' if len(self.occupancy) >= 3 else 'Throw'))
            # Acquisition/processing boundary: preserve unexpected source failures
            # as visible faults rather than killing capture and heartbeat silently.
            except Exception as exc:
                if isinstance(self.source, CameraSource):
                    self.images = {}
                    if self.stabilizer is not None:
                        self.stabilizer.reset()
                if isinstance(self.source, RenderedSource) and 'reset required' in str(exc):
                    self.review_fault = str(exc)
                self.faults = list(dict.fromkeys(filter(None, (self.review_fault, str(exc)))))
                self.detector.clear_pending()
                self.set_status('Error')
            now = time.monotonic()
            if now-self.last_heartbeat >= 1:
                self.emit({'type': 'board.heartbeat'})
                self.last_heartbeat = now

    def transition(self, points):
        old, new = self.occupancy, points
        removed, added = occupancy_changes(old, new)
        if removed and added:
            raise ValueError('simultaneous addition/removal; reset required')
        if len(added) > 1:
            raise ValueError('multiple simultaneous impacts; reset required')
        if added and self.taking_out:
            raise ValueError('impact during incomplete takeout; reset required')
        # Validate every proposed score before emitting any event or changing state.
        scored = [(point, confident_segment(point[0], point[1], self.detector.uncertainty_mm))
                  for point in added]
        if added and isinstance(self.source, CameraSource):
            if self.live_model is None or self.rgb_accepted is None:
                raise ValueError('v6 model or previous RGB frame unavailable; reset required')
            try:
                results = self.live_model.infer(self.source.rgb, self.rgb_accepted, self.width, self.height)
                self.model_diagnostics = results
                expected = scored[0][1]
                for key in CAMERAS:
                    item = results[key]
                    if item['probability'] < 0.5:
                        raise ValueError(f'{key}: v6 presence below 0.5')
                    x, y = board_point(self.detector.calibrations[key], item['pixel'])
                    if confident_segment(x, y, 3.0) != expected:
                        raise ValueError(f'{key}: v6 keypoint disagrees with geometric score')
            except Exception as exc:
                raise ValueError(f'v6 rejected throw: {exc}; reset required') from exc
        if removed and not self.taking_out:
            self.emit({'type': 'takeout.started'})
            self.taking_out = True
        if self.taking_out and not new:
            self.emit({'type': 'takeout.completed'})
            self.taking_out = False
        for (x, y), (seg, value) in scored:
            self.emit({'type': 'throw.detected', 'throw': {
                'id': f'{self.session}:throw:{self.counter+1}',
                'ts': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                'segment': seg, 'value': value, 'coords': {'x': x/170, 'y': y/170}, 'source': 'board'}})
        self.occupancy = new

    def camera_devices(self):
        if sys.platform.startswith('linux'):
            stable = sorted(glob.glob('/dev/v4l/by-id/*-video-index0'))
            return stable if stable else sorted(glob.glob('/dev/video[0-9]*'))
        # OpenCV uses numeric indices on Windows/macOS; availability is checked on connect.
        return [str(i) for i in range(10)]

    def connect_cameras(self, devices):
        if self.camera_config is None or self.model_path is None:
            raise ValueError('camera setup is not configured for this detector')
        if (not isinstance(devices, list) or len(devices) != 3 or
                any(not isinstance(d, str) for d in devices) or len(set(devices)) != 3 or
                any(d not in self.camera_devices() for d in devices)):
            raise ValueError('select three distinct available camera devices')
        with self.condition, self.acquisition:
            if self.running:
                raise ValueError('stop detection before changing cameras')
            if self.review_fault:
                raise ValueError('resolve the review fault before changing cameras')
            # Device order is part of the calibration: never reuse a rig for another mapping.
            digest = hashlib.sha256(json.dumps(devices, separators=(',', ':')).encode()).hexdigest()[:16]
            config = self.camera_config.with_name(f'{self.camera_config.stem}-{digest}.json')
            if isinstance(self.source, CameraSource):
                raise ValueError('restart the detector before changing an existing USB connection')
            source = CameraSource(config, devices=devices, width=1280, height=720)
            try:
                if (source.width, source.height) != (1280, 720):
                    raise ValueError('v6 requires a 1280×720 camera rig')
                model = LiveModel(self.model_path)
            except Exception as exc:
                source.close()
                raise ValueError(f'cannot initialize camera model: {exc}') from exc
            selection = self.camera_config.with_name(self.camera_config.stem + '-selection.json')
            temporary = None
            try:
                selection.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(mode='w', dir=selection.parent, delete=False) as file:
                    temporary = file.name
                    json.dump({'devices': devices}, file)
                os.replace(temporary, selection)
            except OSError as exc:
                source.close()
                raise ValueError(f'cannot save camera selection: {exc}') from exc
            finally:
                if temporary and os.path.exists(temporary):
                    os.unlink(temporary)
            self.source, self.live_model = source, model
            self.width, self.height = source.width, source.height
            self.detector = PerspectiveDetector(source, self.parameters)
            self.stabilizer = StableFrames()
            self.rgb_accepted = None
            self.images = {}
            self.occupancy = []
            self.adopt = True
            self.taking_out = False
            self.calibration_snapshot = None
            self.faults = []
            self.set_status('Starting' if source.calibrations else 'Setup')

    def disconnect_cameras(self):
        with self.condition, self.acquisition:
            if self.running:
                raise ValueError('stop detection before disconnecting cameras')
            if self.review_fault:
                raise ValueError('resolve the review fault before changing cameras')
            if not isinstance(self.source, CameraSource):
                raise ValueError('USB cameras are not connected')
            selection = self.camera_config.with_name(self.camera_config.stem + '-selection.json') if self.camera_config else None
            try:
                if selection:
                    selection.unlink(missing_ok=True)
            except OSError as exc:
                raise ValueError(f'cannot clear camera selection: {exc}') from exc
            self.source.close()
            self.source = RenderedSource()
            self.width, self.height = self.source.width, self.source.height
            self.detector = PerspectiveDetector(self.source, self.parameters)
            self.stabilizer = None
            self.rgb_accepted = None
            self.images = {}
            self.occupancy = []
            self.adopt = True
            self.set_status('Stopped')

    def configure_rendered(self, body):
        # Validate the entire rig before replacing anything. SSE history/session survives.
        if not isinstance(self.source, RenderedSource):
            raise ValueError('render configuration requires rendered source')
        source = RenderedSource.configured(body)
        with self.condition, self.acquisition:
            self.source = source
            self.width, self.height = source.width, source.height
            self.detector = PerspectiveDetector(source, self.parameters)
            self.images = dict(source.reference)
            self.occupancy = []
            self.control('reset')
            return source.render_session

    def submit_rendered(self, body):
        # Keep the bounded FIFO; never overwrite a pending scene or retry a
        # potentially scoring upload. Backpressure waits for a worker slot.
        deadline = time.monotonic()+2.5
        with self.acquisition:
            while True:
                if not isinstance(self.source, RenderedSource):
                    raise ValueError('render routes require rendered source')
                self.source.validate_session(body)
                if len(self.source.queue) < 6:
                    self.source.submit(body)
                    return
                remaining = deadline-time.monotonic()
                if remaining <= 0:
                    raise ValueError('frame queue full; worker did not catch up')
                self.acquisition.wait(remaining)

    def control(self, action):
        with self.condition, self.acquisition:
            if action == 'start' and isinstance(self.source, CameraSource) and not self.source.calibrations:
                raise ValueError('camera calibration required before starting detection')
            # Only reset resolves review faults; re-arm must not bypass a rejected impact.
            if action == 'reset':
                self.review_fault = None
                self.faults = []
            # Re-arm and reset establish a new stable occupancy baseline, never a takeout.
            if action in ('start', 'reset'):
                self.calibration_snapshot = None
                self.rgb_accepted = None
                if self.stabilizer is not None:
                    self.stabilizer.reset()
                if action == 'start':
                    self.running = True
                self.adopt = True
                self.taking_out = False
                self.detector.clear_pending()
                if isinstance(self.detector, PerspectiveDetector):
                    self.source.queue.clear()
                    self.detector.accepted = None
            elif action == 'stop':
                self.running = False
                if isinstance(self.detector, PerspectiveDetector):
                    self.detector.accepted = None
                self.adopt = True
                self.detector.clear_pending()
            self.status = 'Error' if self.review_fault else ('Starting' if self.running else 'Stopped')
            self.acquisition.notify_all()
            self.emit({'type': 'board.status', 'status': self.status, 'running': self.running})

    def snapshot(self):
        with self.condition, self.acquisition:
            rendered = isinstance(self.source, RenderedSource)
            perspective = isinstance(self.source, (RenderedSource, CameraSource))
            result = {'session': self.session, 'source': 'usb' if isinstance(self.source, CameraSource) else 'rendered' if rendered else (
                        'synthetic' if hasattr(self.source, 'throw') else 'replay'),
                    'running': self.running, 'status': self.status,
                    'cameras': [{'id': k, 'calibrated': k in self.detector.calibrations,
                                 'available': k in self.images, 'frameUrl': f'/cameras/{k}/frame'}
                                for k in (CAMERAS if perspective else self.detector.calibrations)],
                    'occupancy': len(self.occupancy),
                    'pending': {'stableFrames': self.detector.stable_frames, 'requiredFrames': 3,
                                'adoptingBaseline': self.adopt,
                                'reviewRequired': self.review_fault is not None,
                                'uncertaintyMm': self.detector.uncertainty_mm}, 'faults': list(self.faults)}
            if isinstance(self.source, CameraSource):
                result['model'] = {'name': 'v6', 'sha256': self.live_model.sha256 if self.live_model else None,
                                   'diagnostics': self.model_diagnostics}
            if rendered:
                result.update(renderSession=self.source.render_session, width=self.width, height=self.height,
                              sequence=self.source.sequence, timestampMs=self.source.timestamp_ms,
                              diagnostics=self.detector.diagnostics)
            return result

    def cursor(self, event_id):
        with self.condition:
            if event_id is None:
                return self.counter  # A fresh subscription must not replay old throws.
            try:
                session, counter = event_id.split(':')
                counter = int(counter)
            except (ValueError, AttributeError):
                raise ValueError('invalid Last-Event-ID')
            oldest = self.history[0][0] if self.history else self.counter+1
            if session != self.session or not oldest-1 <= counter <= self.counter:
                raise ValueError('event history unavailable; fetch /state and reconnect without Last-Event-ID')
            return counter

    def subscribe(self, event_id):
        with self.condition:
            cursor = self.cursor(event_id)
            if event_id is None:
                # Publish a replayable cursor immediately. No scoring event can
                # interleave between the fresh cutoff and its numbered heartbeat.
                self.emit({'type': 'board.heartbeat'})
            return cursor

    def start_worker(self):
        def work():
            while not self.closed.is_set():
                self.tick()
                self.closed.wait(0.1)
        self.thread = threading.Thread(target=work, daemon=True)
        self.thread.start()

    def close(self):
        self.closed.set()
        with self.condition:
            self.condition.notify_all()
        if self.thread:
            self.thread.join(timeout=3)
        if isinstance(self.source, CameraSource):
            self.source.close()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, service):
        self.service = service
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def handle(self):
        # Preview requests and keep-alive clients can disappear after a proxy
        # timeout or a source switch. This is a transport close, not a fault
        # in acquisition or scoring; leave other exceptions visible.
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def log_message(self, format, *args):
        pass

    def respond(self, code, body, content_type='application/json'):
        if content_type == 'application/json':
            body = json.dumps(body, allow_nan=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        if self.close_connection:
            self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        service = cast(Server, self.server).service
        if self.path == '/health':
            return self.respond(200, {'ok': True, 'session': service.session})
        if self.path == '/state':
            return self.respond(200, service.snapshot())
        if self.path == '/usb/devices':
            return self.respond(200, {'ok': True, 'devices': service.camera_devices()})
        if self.path == '/events':
            return self.events()
        parts = self.path.split('/')
        if len(parts) == 4 and parts[1] == 'calibration' and parts[2] == 'frame':
            with service.condition:
                snapshot = service.calibration_snapshot
                if snapshot is None or parts[3] not in snapshot['images']:
                    return self.respond(404, {'ok': False, 'error': 'no frozen calibration frame'})
                data = png(snapshot['images'][parts[3]], service.width, service.height)
            return self.respond(200, data, 'image/png')
        if len(parts) == 4 and parts[1] == 'cameras' and parts[3] == 'frame':
            with service.condition, service.acquisition:
                if parts[2] not in (CAMERAS if isinstance(service.source, CameraSource) else service.detector.calibrations):
                    return self.respond(404, {'ok': False, 'error': 'unknown camera'})
                pixels = (service.source.latest.get(parts[2], service.images.get(parts[2]))
                          if isinstance(service.source, RenderedSource) else service.images.get(parts[2]))
                if pixels is None or len(pixels) != service.width*service.height:
                    return self.respond(503, {'ok': False, 'error': 'frame unavailable'})
                width, height = service.width, service.height
            data = png(pixels, width, height)
            return self.respond(200, data, 'image/png')
        self.respond(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        service = cast(Server, self.server).service
        try:
            if self.headers.get('Transfer-Encoding') is not None:
                raise ValueError('Transfer-Encoding is not supported')
            lengths = self.headers.get_all('Content-Length', [])
            if len(lengths) > 1 or (lengths and (not lengths[0].isascii() or not lengths[0].isdigit())):
                raise ValueError('invalid Content-Length')
            length = int(lengths[0]) if lengths else 0
            limit = 6*1024*1024 if self.path in ('/render/configure', '/render/frames') else 4096
            if length > limit:
                raise ValueError('body too large')
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('incomplete body')
            body = strict_json(raw) if length else {}
            if not isinstance(body, dict):
                raise TypeError('expected JSON object')
            parts = self.path.split('/')
            if self.path == '/usb/connect':
                exact(body, ('devices',))
                service.connect_cameras(body['devices'])
                return self.respond(200, {'ok': True})
            elif self.path == '/usb/disconnect':
                if body:
                    raise ValueError('expected empty body')
                service.disconnect_cameras()
                return self.respond(200, {'ok': True})
            elif self.path == '/calibration/freeze':
                if body:
                    raise ValueError('expected empty body')
                with service.condition, service.acquisition:
                    if not isinstance(service.source, CameraSource):
                        raise ValueError('calibration requires USB source')
                    if service.running:
                        raise ValueError('stop detection before calibration')
                    if service.faults:
                        raise ValueError('resolve camera faults before calibration')
                    if set(service.images) != set(CAMERAS):
                        raise ValueError('all three camera frames must be available')
                    token = uuid.uuid4().hex
                    service.calibration_snapshot = {'token': token, 'images': dict(service.images)}
                    return self.respond(200, {'ok': True, 'token': token, 'width': service.width, 'height': service.height})
            elif self.path == '/calibration/apply':
                exact(body, ('token', 'landmarks'))
                with service.condition, service.acquisition:
                    if not isinstance(service.source, CameraSource) or service.running:
                        raise ValueError('stop USB detection before calibration')
                    snap = service.calibration_snapshot
                    if snap is None or body['token'] != snap['token']:
                        raise ValueError('calibration snapshot expired; capture again')
                    if not isinstance(body['landmarks'], dict):
                        raise ValueError('expected camera landmark map')
                    config, errors = calibrate(service.width, service.height, snap['images'], body['landmarks'])
                    rig = RenderedSource.configured(config)
                    target = service.source.config_path
                    temp = None
                    try:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with tempfile.NamedTemporaryFile(mode='w', dir=target.parent, delete=False) as file:
                            temp = file.name
                            json.dump(config, file, allow_nan=False)
                        os.replace(temp, target)
                    except OSError as exc:
                        raise ValueError(f'cannot save camera calibration: {exc}') from exc
                    finally:
                        if temp and os.path.exists(temp):
                            os.unlink(temp)
                    service.source.calibrations, service.source.reference = rig.calibrations, rig.reference
                    service.detector = PerspectiveDetector(service.source, service.parameters)
                    service.calibration_snapshot = None
                    service.control('reset')
                    return self.respond(200, {'ok': True, 'rms': errors})
            elif self.path == '/render/frames':
                with service.acquisition:
                    if not isinstance(service.source, RenderedSource):
                        return self.respond(409, {'ok': False, 'error': 'render routes require rendered source'})
                service.submit_rendered(body)
            elif self.path in ('/render/configure', '/render/reset'):
                with service.condition, service.acquisition:
                    if not isinstance(service.source, RenderedSource):
                        return self.respond(409, {'ok': False, 'error': 'render routes require rendered source'})
                    if self.path == '/render/configure':
                        session = service.configure_rendered(body)
                        return self.respond(200, {'ok': True, 'session': session})
                    exact(body, ('session',))
                    service.source.validate_session(body)
                    service.source.queue.clear()
                    service.control('reset')
            elif len(parts) == 3 and parts[1] == 'control' and parts[2] in ('start', 'stop', 'reset'):
                if body:
                    raise ValueError('control body must be empty')
                service.control(parts[2])
            elif len(parts) == 3 and parts[1] == 'sim' and parts[2] in ('throw', 'takeout', 'reset'):
                if not hasattr(service.source, 'throw'):
                    return self.respond(409, {'ok': False, 'error': 'simulator controls require synthetic source'})
                with service.condition:
                    if parts[2] == 'throw':
                        if set(body) != {'x_mm', 'y_mm'}:
                            raise ValueError('expected x_mm and y_mm only')
                        service.source.validate_throw(body['x_mm'], body['y_mm'])
                        # Stopped simulation is intentional and never retrospectively scored.
                        # While armed, do not silently swallow throws into a reset baseline.
                        if service.running and (service.adopt or service.faults or service.review_fault):
                            return self.respond(409, {'ok': False, 'error': 'detector not ready; wait for baseline or reset review fault'})
                        service.source.throw(body['x_mm'], body['y_mm'])
                    elif parts[2] == 'takeout':
                        if set(body) - {'count'}:
                            raise ValueError('expected optional count only')
                        if 'count' in body and type(body['count']) is not int:
                            raise ValueError('count must be a positive integer')
                        service.source.takeout(body.get('count'))
                    else:
                        if body:
                            raise ValueError('reset body must be empty')
                        service.source.takeout()
                        service.control('reset')
            else:
                return self.respond(404, {'ok': False, 'error': 'not found'})
            self.respond(200, {'ok': True})
        except (ValueError, TypeError, KeyError, UnicodeError, TimeoutError, OverflowError, RecursionError) as exc:
            # Rejected framing may leave unread bytes; never reuse that connection.
            self.close_connection = True
            self.respond(400, {'ok': False, 'error': str(exc)})

    def events(self):
        service = cast(Server, self.server).service
        try:
            cursor = service.subscribe(self.headers.get('Last-Event-ID'))
        except ValueError as exc:
            return self.respond(409, {'ok': False, 'error': str(exc)})
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        self.connection.settimeout(5)
        try:
            self.wfile.write(b': connected\n\n')
            self.wfile.flush()
            while not service.closed.is_set():
                with service.condition:
                    oldest = service.history[0][0] if service.history else service.counter+1
                    if cursor < oldest-1:
                        break  # slow client must resync, never silently drop scoring events
                    batch = [(n, e) for n, e in service.history if n > cursor]
                    if not batch:
                        service.condition.wait(timeout=1)
                        continue
                for n, event in batch:
                    self.wfile.write(f'id: {service.session}:{n}\ndata: {json.dumps(event)}\n\n'.encode())
                    cursor = n
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', choices=('synthetic', 'replay', 'rendered', 'usb'), default='synthetic')
    parser.add_argument('--self-test', action='store_true', help='load USB mock frames and run one v6 inference, then exit')
    parser.add_argument('--model', default=str(Path(__file__).resolve().parent / 'models' / 'presence-v6.pt'), help='v6 checkpoint for USB inference')
    parser.add_argument('--camera-width', type=int, default=1280)
    parser.add_argument('--camera-height', type=int, default=720)
    parser.add_argument('--camera-config', default='data/native-camera-rig.json', help='camera rig file or base path for UI-selected devices')
    parser.add_argument('--device', action='append', help='USB camera device path, in cam0/cam1/cam2 order (repeat three times)')
    parser.add_argument('--mock-cameras', help='JSON list of three-camera PGM frame maps')
    parser.add_argument('--replay', help='image-only replay manifest')
    parser.add_argument('--parameters', metavar='PATH',
                        help='rendered only: plain partial DetectionParameters JSON object; '
                             'export selected.parameters from benchmark tune artifacts')
    parser.add_argument('--cameras', choices=(2, 3), type=int, default=3)
    parser.add_argument('--port', type=int, default=8091)
    args = parser.parse_args()
    if args.parameters is not None and args.source not in ('rendered', 'usb'):
        parser.error('--parameters requires --source rendered')
    parameters = DEFAULT_PARAMETERS
    if args.parameters is not None:
        try:
            parameters = DetectionParameters.from_dict(strict_json(Path(args.parameters).read_bytes()))
        except (OSError, ValueError) as exc:
            parser.error(f'cannot load --parameters {args.parameters!r}: {exc}; '
                         'expected a plain DetectionParameters JSON object '
                         '(export selected.parameters from a tune artifact)')
    if args.source == 'usb' and not (64 <= args.camera_width <= 1280 and 64 <= args.camera_height <= 720):
        parser.error('camera dimensions must be within 64..1280 by 64..720')
    if args.source == 'usb' and not args.camera_config:
        parser.error('--camera-config required for usb source')
    if args.source == 'replay' and not args.replay:
        parser.error('--replay required for replay source')
    source = (synthetic(args.cameras) if args.source == 'synthetic' else
              ReplaySource(args.replay) if args.source == 'replay' else
              CameraSource(args.camera_config, args.device, args.mock_cameras, width=args.camera_width, height=args.camera_height) if args.source == 'usb' else RenderedSource())
    if isinstance(source, CameraSource) and (source.width, source.height) != (1280, 720):
        source.close()
        parser.error('v6 requires a 1280×720 camera rig')
    try:
        model = LiveModel(args.model) if args.source == 'usb' else None
    except (OSError, ValueError, RuntimeError, KeyError, pickle.UnpicklingError) as exc:
        if isinstance(source, CameraSource):
            source.close()
        parser.error(f'cannot load v6 model: {exc}')
    if args.self_test:
        if not isinstance(source, CameraSource) or source.mock is None:
            parser.error('--self-test requires --source usb and --mock-cameras')
        try:
            source.capture()
            model.infer(source.rgb, source.rgb, source.width, source.height)
            print(f'v6 self-test ok {model.sha256}', flush=True)
        finally:
            source.close()
        return
    service = Service(source, parameters=parameters, live_model=model, camera_config=args.camera_config, model_path=args.model)
    if args.source == 'rendered' and args.camera_config:
        selection = Path(args.camera_config).with_name(Path(args.camera_config).stem + '-selection.json')
        if selection.exists():
            try:
                devices = strict_json(selection.read_bytes())['devices']
                service.control('stop')
                service.connect_cameras(devices)
            except Exception as exc:
                print(f'could not restore USB cameras: {exc}', flush=True)
    server = Server(('127.0.0.1', args.port), service)
    service.start_worker()
    print(f'detector ({args.source}) http://127.0.0.1:{server.server_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        service.close()
        server.server_close()


if __name__ == '__main__':
    main()
