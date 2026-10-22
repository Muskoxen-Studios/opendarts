"""Browser acquisition and calibrated geometry. Only calibration and gray pixels enter here."""

import base64
import binascii
import gzip
import json
import os
import math
import time
import uuid
from collections import deque
from itertools import product
from pathlib import Path

from parameters import DEFAULT_PARAMETERS, DetectionParameters
from vision import distance

CAMERAS = ('cam0', 'cam1', 'cam2')


def exact(value, keys):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError('expected fields: ' + ', '.join(keys))


def finite(value):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError('expected finite number')
    return value


def vector(value, size):
    if type(value) is not list or len(value) != size:
        raise ValueError(f'expected {size} numbers')
    return tuple(finite(v) for v in value)


def dot(a, b):
    return sum(x*y for x, y in zip(a, b))


def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def transpose_mul(matrix, v):
    return tuple(sum(matrix[3*j+i]*v[j] for j in range(3)) for i in range(3))


def matmul(matrix, v):
    return tuple(dot(matrix[3*i:3*i+3], v) for i in range(3))


def gray(value, size):
    if type(value) is not str or len(value) != 4*((size+2)//3):
        raise ValueError('expected base64 raw grayscale of configured dimensions')
    try:
        result = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError('invalid grayscale base64') from exc
    if len(result) != size:
        raise ValueError('incorrect grayscale byte count')
    return result


def project(calibration, point):
    camera = tuple(a+b for a, b in zip(matmul(calibration['R'], point), calibration['t']))
    if camera[2] <= 1:
        raise ValueError('board/shaft behind camera')
    pixel = matmul(calibration['K'], camera)
    return pixel[0]/pixel[2], pixel[1]/pixel[2]


def plane(calibration, line):
    # l^T K (R X + t) = 0, so n = R^T K^T l, offset = (K^T l)^T t.
    camera_normal = transpose_mul(calibration['K'], line)
    return transpose_mul(calibration['R'], camera_normal), dot(camera_normal, calibration['t'])


def solve_xy(rows, values, parameters=DEFAULT_PARAMETERS):
    aa = sum(r[0]*r[0] for r in rows)
    ab = sum(r[0]*r[1] for r in rows)
    bb = sum(r[1]*r[1] for r in rows)
    det = aa*bb-ab*ab
    if aa+bb == 0 or det/(aa+bb)**2 < parameters.min_triangulation_condition:
        raise ValueError('ill-conditioned shaft triangulation')
    av = sum(r[0]*v for r, v in zip(rows, values))
    bv = sum(r[1]*v for r, v in zip(rows, values))
    return ((bb*av-ab*bv)/det, (aa*bv-ab*av)/det)


def reconstruct(calibrations, lines, supports=None, calculate_uncertainty=True,
                parameters=DEFAULT_PARAMETERS, uncertainty_details=None):
    planes = [plane(calibrations[k], lines[k]) for k in CAMERAS]
    # Normalize planes for least squares; image lines have unit pixel normals.
    planes = [(tuple(v/math.hypot(n[0], n[1]) for v in n), d/math.hypot(n[0], n[1]))
              for n, d in planes if math.hypot(n[0], n[1]) > 1e-8]
    if len(planes) != 3:
        raise ValueError('shaft plane parallel to board')
    # Angular raster error decreases with observed shaft length. Weight plane
    # fits by relative observed support length.
    weights = ([supports[k][1]/max(s[1] for s in supports.values()) for k in CAMERAS]
               if supports is not None else [1, 1, 1])
    rows = [tuple(v*w for v in n[:2]) for (n, _), w in zip(planes, weights)]
    impact = solve_xy(rows, [-d*w for (_, d), w in zip(planes, weights)], parameters)
    slope = solve_xy(rows, [-n[2]*w for (n, _), w in zip(planes, weights)], parameters)
    if math.hypot(*impact) > parameters.max_impact_radius_mm or math.hypot(*slope) > parameters.max_shaft_slope:
        raise ValueError('implausible reconstructed shaft')
    # Check all three cameras, not just the pair that produced an intersection.
    error = 0
    for k in CAMERAS:
        a, b, c = lines[k]
        for z in (0, 60):
            u, v = project(calibrations[k], (impact[0]+z*slope[0], impact[1]+z*slope[1], z))
            error = max(error, abs(a*u+b*v+c))
    if error > parameters.max_reprojection_error_px:
        raise ValueError('third-view shaft reprojection disagrees')
    # Propagate independent pixel-offset and angular error. Opposite endpoint errors
    # rotate a short observed run; extrapolation to an invisible tip amplifies them.
    if not calculate_uncertainty:
        return impact, 1.0, error
    camera_variants = []
    for k in CAMERAS:
        a, b, c = lines[k]
        offset = parameters.line_offset_uncertainty_px
        variants = [(a, b, c-offset), (a, b, c+offset)]
        if supports is not None:
            center, length = supports[k]
            for sign in (-1, 1):
                angle = sign*math.atan2(2*offset, length)
                na = a*math.cos(angle)-b*math.sin(angle)
                nb = a*math.sin(angle)+b*math.cos(angle)
                variants.append((na, nb, -na*center[0]-nb*center[1]))
        camera_variants.append(variants)
    # Enumerate simultaneous endpoint-error corners instead of summing per-camera
    # scalar maxima whose directions cannot all coincide. Every endpoint-error
    # combination is represented, including opposing angular errors.
    propagated = 0.0
    for combination in product(*camera_variants):
        ps = [plane(calibrations[k], line) for k, line in zip(CAMERAS, combination)]
        normalized = [(tuple(v/math.hypot(n[0], n[1]) for v in n), d/math.hypot(n[0], n[1]))
                      for n, d in ps]
        p = solve_xy([tuple(v*w for v in n[:2]) for (n, _), w in zip(normalized, weights)],
                     [-d*w for (_, d), w in zip(normalized, weights)], parameters)
        propagated = max(propagated, distance(impact, p))
    # The raster allowance is a minimum bound, not an independent measured
    # source of error to add to the endpoint perturbations. Keep the 1 mm floor
    # even for long, perfectly intersecting lines. This is an empirical geometry
    # guard, not statistical confidence or a hardware calibration.
    uncertainty = max(1.0, propagated)
    if uncertainty_details is not None:
        uncertainty_details.update(model='endpoint-bound-with-floor-v1',
                                   propagatedRadiusMm=propagated, minimumRadiusMm=1.0)
    return impact, uncertainty, error


class RenderedSource:
    width, height = 640, 480

    def __init__(self):
        self.calibrations = {}
        self.reference = {}
        self.render_session = None
        self.sequence = -1
        self.timestamp_ms = -1
        self.received_at = None
        self.configured_at = None
        self.queue = deque()
        self.latest = {}

    @classmethod
    def configured(cls, body):
        exact(body, ('width', 'height', 'cameras'))
        width, height = body['width'], body['height']
        if type(width) is not int or type(height) is not int or not (64 <= width <= 1280 and 64 <= height <= 720):
            raise ValueError('dimensions must be integers in 64..1280 by 64..720')
        exact(body['cameras'], CAMERAS)
        source = cls()
        source.width, source.height = width, height
        centers = []
        for k in CAMERAS:
            camera = body['cameras'][k]
            exact(camera, ('K', 'R', 't', 'reference'))
            K, R, t = vector(camera['K'], 9), vector(camera['R'], 9), vector(camera['t'], 3)
            if not (1 <= K[0] <= 10000 and 1 <= K[4] <= 10000) or any(abs(K[i]) > 1e-8 for i in (3, 6, 7)) or abs(K[8]-1) > 1e-8:
                raise ValueError('invalid pinhole intrinsics')
            if abs(K[1]) > min(K[0], K[4])*0.1 or not (0 <= K[2] < width and 0 <= K[5] < height):
                raise ValueError('invalid intrinsic skew/principal point')
            rows = [R[i:i+3] for i in (0, 3, 6)]
            if any(abs(dot(rows[i], rows[j])-(1 if i == j else 0)) > 1e-5 for i in range(3) for j in range(3)) or abs(dot(rows[0], cross(rows[1], rows[2]))-1) > 1e-5:
                raise ValueError('R must be a proper orthonormal world-to-camera rotation')
            center = tuple(-v for v in transpose_mul(R, t))
            if not (10 < center[2] < 2000 and 50 < math.hypot(*center) < 3000):
                raise ValueError('camera must face board from player side, in millimetres')
            centers.append(center)
            calibration = {'K': K, 'R': R, 't': t}
            u, v = project(calibration, (0, 0, 0))
            if not (0 <= u < width and 0 <= v < height):
                raise ValueError('bull must be visible in every camera')
            source.calibrations[k] = calibration
            source.reference[k] = gray(camera['reference'], width*height)
        if any(math.dist(a, b) < 50 for i, a in enumerate(centers) for b in centers[i+1:]):
            raise ValueError('camera baselines too short')
        # A board-normal shaft at the bull must be recoverable with this rig.
        lines = {}
        for k in CAMERAS:
            p, q = project(source.calibrations[k], (0, 0, 0)), project(source.calibrations[k], (0, 0, 60))
            a, b = p[1]-q[1], q[0]-p[0]
            norm = math.hypot(a, b)
            if norm < 5:
                raise ValueError('rig cannot resolve shaft direction')
            lines[k] = (a/norm, b/norm, -(a*p[0]+b*p[1])/norm)
        reconstruct(source.calibrations, lines)
        source.render_session = uuid.uuid4().hex
        source.configured_at = time.monotonic()
        source._capture_previous = None
        source._capture_index = 0
        if os.environ.get('DETECTOR_CAPTURE'):
            Path(os.environ['DETECTOR_CAPTURE'], 'configuration.json.gz').write_bytes(gzip.compress(json.dumps(body).encode()))
        return source

    def validate_session(self, body):
        if type(body.get('session')) is not str or body['session'] != self.render_session or self.render_session is None:
            raise ValueError('stale or unconfigured render session')

    def submit(self, body):
        exact(body, ('session', 'sequence', 'timestampMs', 'images'))
        self.validate_session(body)
        sequence, timestamp = body['sequence'], finite(body['timestampMs'])
        if type(sequence) is not int or sequence < 0 or sequence <= self.sequence:
            raise ValueError('sequence must be a strictly increasing nonnegative integer')
        if timestamp < 0 or timestamp <= self.timestamp_ms:
            raise ValueError('timestampMs must be strictly increasing and nonnegative')
        exact(body['images'], CAMERAS)
        images = {k: gray(body['images'][k], self.width*self.height) for k in CAMERAS}
        if len(self.queue) >= 6:
            raise ValueError('frame queue full; wait for worker')
        if os.environ.get('DETECTOR_CAPTURE') and images != self._capture_previous:
            Path(os.environ['DETECTOR_CAPTURE'], f'scene{self._capture_index}.json.gz').write_bytes(gzip.compress(json.dumps(body).encode()))
            self._capture_index += 1
            self._capture_previous = images
        self.queue.append(images)
        self.latest = images
        self.sequence, self.timestamp_ms = sequence, timestamp
        self.received_at = time.monotonic()

    def capture(self):
        if self.render_session is None:
            raise ValueError('rendered source awaiting configuration')
        if self.received_at is None and time.monotonic()-self.configured_at <= 3:
            return None
        if self.received_at is None or time.monotonic()-self.received_at > 3:
            self.queue.clear()
            raise ValueError('rendered frame stream stalled (>3s)')
        return self.queue.popleft() if self.queue else None


def blobs(image, reference, width, height, parameters=DEFAULT_PARAMETERS):
    changed = {i for i, (p, q) in enumerate(zip(image, reference))
               if abs(p-q) >= parameters.blob_threshold_gray}
    if len(changed) > width*height*parameters.max_changed_fraction:
        raise ValueError('occlusion or lighting change')
    result = []
    while changed:
        todo = [changed.pop()]
        blob = []
        while todo:
            i = todo.pop()
            blob.append((i % width+0.5, i//width+0.5))
            x, y = i % width, i//width
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)):
                nx, ny = x+dx, y+dy
                j = ny*width+nx
                if 0 <= nx < width and 0 <= ny < height and j in changed:
                    changed.remove(j)
                    todo.append(j)
        if len(blob) < parameters.min_blob_pixels:
            raise ValueError('unresolved small changed region')
        if any(x in (0.5, width-0.5) or y in (0.5, height-0.5) for x, y in blob):
            raise ValueError('clipped silhouette')
        result.append(blob)
    if len(result) > 3:
        raise ValueError('too many disconnected silhouettes')
    return result


def shaft_candidates(blob, max_width=None, cores=False, parameters=DEFAULT_PARAMETERS):
    """Hough proposal, then narrow cross-section centers; never whole-flight PCA."""
    max_width = parameters.max_shaft_width_px if max_width is None else max_width
    sample = blob[::max(1, len(blob)//parameters.hough_sample_target)]
    proposals = []
    for degrees in range(0, 180, parameters.hough_angle_step_deg):
        a, b = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
        votes = {}
        for x, y in sample:
            rho = round((a*x+b*y)/parameters.hough_rho_bin_px)*parameters.hough_rho_bin_px
            votes[rho] = votes.get(rho, 0)+1
        for rho, count in sorted(votes.items(), key=lambda item: item[1], reverse=True)[:parameters.hough_peaks_per_angle]:
            proposals.append((count, a, b, rho))
    candidates, core_candidates = [], []
    for _, a, b, rho in sorted(proposals, reverse=True)[:parameters.hough_proposal_limit]:
        # Contrast can expose only one side of a barrel when an older dart
        # occludes it. Keep independently voted narrow cores as alternatives;
        # cross-view geometry, not a whole-region centroid, selects the axis.
        core_bins = {}
        for x, y in blob:
            s, r = -b*x+a*y, a*x+b*y
            if abs(r-rho) <= parameters.core_half_width_px:
                core_bins.setdefault(math.floor(s/parameters.section_bin_px), []).append((s, r))
        groups, group, last = [], [], None
        for index in sorted(core_bins):
            if last is not None and index-last > parameters.core_max_gap_bins:
                groups.append(group)
                group = []
            group.extend(core_bins[index])
            last = index
        if group:
            groups.append(group)
        for group in groups:
            length = max(s for s, r in group)-min(s for s, r in group)
            occupied = len({math.floor(s/parameters.section_bin_px) for s, r in group})
            if (len(group) < parameters.min_core_pixels or length < parameters.min_shaft_length_px
                    or occupied*parameters.section_bin_px < length*parameters.min_support_fraction):
                continue
            ms, mr = (sum(p[j] for p in group)/len(group) for j in (0, 1))
            variance = sum((s-ms)**2 for s, r in group)
            slope = sum((s-ms)*(r-mr) for s, r in group)/variance
            residual = max(abs(r-mr-slope*(s-ms)) for s, r in group)
            if residual > parameters.max_core_residual_px:
                continue
            na, nb, nc = a+slope*b, b-slope*a, slope*ms-mr
            norm = math.hypot(na, nb)
            core_candidates.append((length, -residual, (na/norm, nb/norm, nc/norm),
                               ((-b*ms+a*mr, a*ms+b*mr), length)))
        if cores:
            continue
        bins = {}
        for x, y in blob:
            s, r = -b*x+a*y, a*x+b*y
            bins.setdefault(math.floor(s/parameters.section_bin_px), []).append((s, r))
        run, runs, gaps = [], [], 0
        for index in range(min(bins), max(bins)+1):
            pixels = bins.get(index, [])
            values = [r for s, r in pixels]
            # Flight/barrel cross-sections are excluded; narrow shaft supplies the axis.
            if values and max(values)-min(values) <= max_width and abs((max(values)+min(values))/2-rho) <= parameters.section_center_tolerance_px:
                run.append((sum(s for s, r in pixels)/len(pixels), (max(values)+min(values))/2))
                gaps = 0
            elif not values and gaps < parameters.max_empty_section_bins:
                gaps += 1
            else:
                if len(run) >= parameters.min_section_bins:
                    runs.append(run)
                run, gaps = [], 0
        if len(run) >= parameters.min_section_bins:
            runs.append(run)
        for run in runs:
            # A thin, edge-on flight can join the shaft at a bend without ever
            # becoming wide. Find the longest straight sub-run, retaining equally
            # supported alternatives for the independent three-view check.
            for trim in range(len(run)-parameters.min_section_bins+1):
                found = False
                for start in range(trim+1):
                    section = run[start:len(run)-trim+start]
                    ms, mr = (sum(p[j] for p in section)/len(section) for j in (0, 1))
                    variance = sum((s-ms)**2 for s, r in section)
                    slope = sum((s-ms)*(r-mr) for s, r in section)/variance
                    residual = max(abs(r-mr-slope*(s-ms)) for s, r in section)
                    length = section[-1][0]-section[0][0]
                    if (residual > parameters.max_section_residual_px or length < parameters.min_shaft_length_px
                                                or len(section)*parameters.section_bin_px < length*parameters.min_support_fraction):
                        continue
                    na, nb, nc = a+slope*b, b-slope*a, slope*ms-mr
                    norm = math.hypot(na, nb)
                    line = (na/norm, nb/norm, nc/norm)
                    center = (-b*ms+a*mr, a*ms+b*mr)
                    candidates.append((length, -residual, line, (center, length)))
                    found = True
                if found:
                    break
    if cores:
        candidates = core_candidates
    if not candidates:
        raise ValueError('no resolvable narrow shaft run')
    candidates.sort(reverse=True)
    unique = []
    for length, residual, line, support in candidates:
        if any(abs(dot(line[:2], previous[0][:2])) > parameters.candidate_normal_similarity and
               abs(dot(line[:2], previous[1][0])+line[2]) < parameters.candidate_offset_tolerance_px for previous in unique):
            continue
        unique.append((line, support))
        if len(unique) >= parameters.max_candidates:
            break
    return unique


def shaft_line(blob):
    return shaft_candidates(blob)[0]


def changed_pixels(image, reference, width, height, parameters=DEFAULT_PARAMETERS):
    points = [(i % width+0.5, i//width+0.5)
              for i, (p, q) in enumerate(zip(image, reference)) if abs(p-q) >= parameters.difference_threshold_gray]
    if len(points) > width*height*parameters.max_changed_fraction:
        raise ValueError('occlusion or lighting change')
    if any(x in (0.5, width-0.5) or y in (0.5, height-0.5) for x, y in points):
        raise ValueError('clipped silhouette')
    return points


class PerspectiveDetector:
    def __init__(self, source, parameters=DEFAULT_PARAMETERS):
        if not isinstance(parameters, DetectionParameters):
            raise ValueError('parameters must be DetectionParameters')
        self.parameters = parameters
        self.calibrations, self.reference = source.calibrations, source.reference
        self.width, self.height = source.width, source.height
        self.pending = None
        self.stable_frames = 0
        self.uncertainty_mm = 1.0
        self.diagnostics = {}
        self.accepted = None
        self.accepted_points = []
        self.unresolved_occupancy = False
        self.cached_points = None
        self.resolved_signature = None
        self.resolved_points = []
        self.resolved_uncertainty = 1.0

    def clear_pending(self):
        self.pending = None
        self.stable_frames = 0
        self.cached_points = None

    def accept(self, images, points):
        self.accepted = dict(images)
        self.accepted_points = list(points)

    def resolve_axis(self, pixels):
        parameters = self.parameters
        candidates = {}
        for k in CAMERAS:
            candidates[k] = shaft_candidates(pixels[k], parameters=parameters)
            self.diagnostics[k] = {'changedPixels': len(pixels[k]),
                                   'candidateLines': [list(line) for line, _ in candidates[k]]}
        hypotheses = []
        for combination in product(*(candidates[k] for k in CAMERAS)):
            lines = {k: value[0] for k, value in zip(CAMERAS, combination)}
            supports = {k: value[1] for k, value in zip(CAMERAS, combination)}
            try:
                point, uncertainty, error = reconstruct(self.calibrations, lines, supports, False, parameters)
            except ValueError:
                continue
            score = sum(support[1] for support in supports.values())
            hypotheses.append((score, -error, point, uncertainty, lines, supports))
        if not hypotheses:
            raise ValueError('no three-view shaft correspondence')
        hypotheses.sort(reverse=True)
        primary_uncertainty = reconstruct(self.calibrations, hypotheses[0][4], hypotheses[0][5], parameters=parameters)[1]
        # Parameter files used an additive 1 mm allowance for this trigger.
        # Preserve their refinement decisions while changing the scoring bound.
        if primary_uncertainty > max(1.0, parameters.refine_uncertainty_mm-1.0):
            refined = {}
            for k in CAMERAS:
                cores = shaft_candidates(pixels[k], cores=True, parameters=parameters)
                longest = candidates[k][0][1][1]
                # Long symmetric cross-section fits anchor the reconstruction.
                # Only a short, partially occluded view needs voted-core alternatives.
                refined[k] = (cores+candidates[k])[:parameters.max_candidates] if longest < parameters.refine_short_support_px else [
                    value for value in candidates[k] if value[1][1] >= longest*parameters.comparable_support_fraction]
            alternatives = []
            for combination in product(*(refined[k] for k in CAMERAS)):
                lines = {k: value[0] for k, value in zip(CAMERAS, combination)}
                supports = {k: value[1] for k, value in zip(CAMERAS, combination)}
                try:
                    point, uncertainty, error = reconstruct(self.calibrations, lines, supports, False, parameters)
                except ValueError:
                    continue
                score = sum(support[1] for support in supports.values())/(1+parameters.refine_reprojection_penalty*error)
                alternatives.append((score, -error, point, uncertainty, lines, supports))
            if alternatives:
                hypotheses = sorted(alternatives, reverse=True)
        best = hypotheses[0]
        self.diagnostics['cam0']['hypotheses'] = [
            {'supportScore': h[0], 'impactMm': list(h[2]), 'reprojectionPx': -h[1],
             'supportLengthsPx': [h[5][k][1] for k in CAMERAS]} for h in hypotheses[:8]]
        # Short flight-edge runs cannot outweigh a shaft spanning many separated
        # contrast fragments. Comparable support for a distinct impact is ambiguous.
        if any(h[0] >= best[0]*parameters.comparable_support_fraction and distance(h[2], best[2]) > parameters.ambiguity_distance_mm for h in hypotheses[1:]):
            raise ValueError('ambiguous three-view shaft correspondence')
        _, negative_error, point, uncertainty, lines, supports = best
        uncertainty_details = {}
        point, uncertainty, error = reconstruct(self.calibrations, lines, supports,
                                               parameters=parameters,
                                               uncertainty_details=uncertainty_details)
        for k in CAMERAS:
            self.diagnostics[k]['reconstructed'] = [{'impactMm': list(point),
                'reprojectionPx': -negative_error, 'uncertaintyMm': uncertainty,
                'uncertaintyDetails': dict(uncertainty_details),
                'selectedLine': list(lines[k]), 'supportLengthPx': supports[k][1]}]
            # All changed pixels, including fragmented flights, must lie near the
            # selected shaft's physically bounded axial projection. Unrelated
            # blobs/occluders are not discarded just because a line fit succeeded.
        planes = [plane(self.calibrations[k], lines[k]) for k in CAMERAS]
        normalized = [(tuple(v/math.hypot(n[0], n[1]) for v in n), d/math.hypot(n[0], n[1]))
                      for n, d in planes]
        slope = solve_xy([n[:2] for n, _ in normalized], [-n[2] for n, _ in normalized], parameters)
        for k in CAMERAS:
            start = project(self.calibrations[k], (*point, 0))
            # Dimensions are lengths along the dart, not board-normal z heights.
            axial_z = parameters.shaft_envelope_length_mm/math.sqrt(1+slope[0]**2+slope[1]**2)
            end_world = (point[0]+axial_z*slope[0], point[1]+axial_z*slope[1], axial_z)
            end = project(self.calibrations[k], end_world)
            vx, vy = end[0]-start[0], end[1]-start[1]
            length = math.hypot(vx, vy)
            depth = matmul(self.calibrations[k]['R'], end_world)[2]+self.calibrations[k]['t'][2]
            radius = max(parameters.min_envelope_radius_px, self.calibrations[k]['K'][0]*parameters.flight_radius_mm/depth)
            for x, y in pixels[k]:
                along = ((x-start[0])*vx+(y-start[1])*vy)/length
                perpendicular = abs((x-start[0])*vy-(y-start[1])*vx)/length
                if not -radius <= along <= length+radius or perpendicular > radius:
                    raise ValueError('changed pixels outside reconstructed shaft/flight envelope')
        return point, uncertainty

    def observe(self, images):
        try:
            exact(images, CAMERAS)
            for image in images.values():
                if type(image) is not bytes or len(image) != self.width*self.height:
                    raise ValueError('invalid grayscale image')
            signature = tuple(images[k] for k in CAMERAS)
            if signature == self.pending:
                self.stable_frames += 1
                if self.stable_frames >= 3 and self.cached_points == []:
                    self.unresolved_occupancy = False
                return self.cached_points if self.stable_frames >= 3 else None
            self.clear_pending()
            if signature == self.resolved_signature:
                if self.unresolved_occupancy and self.resolved_points:
                    raise ValueError('unresolved prior occupancy; empty board required')
                points = list(self.resolved_points)
                self.uncertainty_mm = self.resolved_uncertainty
            else:
                self.diagnostics = {}
                current = {k: changed_pixels(images[k], self.reference[k], self.width, self.height, self.parameters) for k in CAMERAS}
                if not any(current.values()):
                    points = []
                else:
                    if self.unresolved_occupancy:
                        raise ValueError('unresolved prior occupancy; empty board required')
                    if not all(current.values()):
                        raise ValueError('views disagree on occupancy; possible occlusion')
                    baseline = self.accepted if self.accepted is not None else self.reference
                    pixels = {k: changed_pixels(images[k], baseline[k], self.width, self.height, self.parameters) for k in CAMERAS}
                    if not all(pixels.values()):
                        raise ValueError('views disagree on change; possible occlusion')
                    point, uncertainty = self.resolve_axis(pixels)
                    points = list(self.accepted_points) if self.accepted is not None else []
                    previous = {k: changed_pixels(baseline[k], self.reference[k], self.width, self.height, self.parameters) for k in CAMERAS}
                    matches = [p for p in points if distance(p, point) <= 3]
                    if matches:
                        if len(matches) != 1 or not all(len(current[k]) < len(previous[k]) for k in CAMERAS):
                            raise ValueError('silhouette changed without resolvable occupancy change; reset required')
                        # Decreased area alone is not removal evidence: a new dart can
                        # cover an old one. Newly occupied background is incompatible
                        # with a confidently isolated removal.
                        if any(set(current[k])-set(previous[k]) for k in CAMERAS):
                            raise ValueError('removal exposes unresolved silhouette; reset required')
                        points.remove(matches[0])
                    else:
                        if any(distance(p, point) <= 6 for p in points):
                            raise ValueError('clustered impacts cannot be separated reliably')
                        if not all(len(current[k]) > len(previous[k]) for k in CAMERAS):
                            raise ValueError('simultaneous addition/removal; reset required')
                        points.append(point)
                    self.uncertainty_mm = max(uncertainty, self.uncertainty_mm if points else 1)
                self.resolved_signature = signature
                self.resolved_points = list(points)
                self.resolved_uncertainty = self.uncertainty_mm
            self.pending, self.stable_frames, self.cached_points = signature, 1, points
            return None
        except (ValueError, TypeError):
            # A rejected scene may contain unseen darts. Do not later bootstrap
            # that accumulated scene as a single new impact without an empty frame.
            self.unresolved_occupancy = True
            self.clear_pending()
            raise
