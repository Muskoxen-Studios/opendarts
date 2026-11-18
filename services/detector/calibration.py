"""Estimate pinhole poses from manually identified board-plane landmarks."""
import math

from rendered import CAMERAS, RenderedSource, project

# Outer double wire at both sides of 20, 6, 3 and 11; y points up.
ANGLES = (-9, 9, 81, 99, 171, 189, 261, 279)
BOARD_POINTS = [(0., 0.)] + [(170*math.sin(math.radians(a)), 170*math.cos(math.radians(a))) for a in ANGLES]


def solve_linear(a, b):
    rows = [list(row) + [value] for row, value in zip(a, b)]
    for col in range(len(b)):
        pivot = max(range(col, len(b)), key=lambda i: abs(rows[i][col]))
        if abs(rows[pivot][col]) < 1e-10:
            raise ValueError('landmarks are degenerate; select distinct board points')
        rows[col], rows[pivot] = rows[pivot], rows[col]
        factor = rows[col][col]
        rows[col] = [x/factor for x in rows[col]]
        for i in range(len(b)):
            if i != col:
                factor = rows[i][col]
                rows[i] = [x-factor*y for x, y in zip(rows[i], rows[col])]
    return [row[-1] for row in rows]


def dot(a, b):
    return sum(x*y for x, y in zip(a, b))


def unit(v):
    length = math.sqrt(dot(v, v))
    if length < 1e-10:
        raise ValueError('degenerate camera pose')
    return [x/length for x in v]


def estimate(points, width, height, fov):
    if type(fov) not in (int, float) or not math.isfinite(fov) or not 30 <= fov <= 150:
        raise ValueError('horizontal field of view must be 30–150 degrees')
    if not isinstance(points, list) or len(points) != len(BOARD_POINTS):
        raise ValueError('nine landmarks are required per camera')
    for p in points:
        if (not isinstance(p, list) or len(p) != 2 or
            any(type(v) not in (int, float) or not math.isfinite(v) for v in p) or
            not (0 <= p[0] < width and 0 <= p[1] < height)):
            raise ValueError('landmark outside the image')
    f = width/(2*math.tan(math.radians(fov)/2))
    # Solve board unit coordinates to normalized camera coordinates by least squares.
    equations, values = [], []
    for (x, y), (u, v) in zip(BOARD_POINTS, points):
        x, y = x/170, y/170
        u, v = (u-width/2)/f, (v-height/2)/f
        equations.extend(([x, y, 1, 0, 0, 0, -u*x, -u*y],
                          [0, 0, 0, x, y, 1, -v*x, -v*y]))
        values.extend((u, v))
    normal = [[sum(row[i]*row[j] for row in equations) for j in range(8)] for i in range(8)]
    rhs = [sum(row[i]*v for row, v in zip(equations, values)) for i in range(8)]
    h = solve_linear(normal, rhs)
    c1, c2, c3 = [h[0], h[3], h[6]], [h[1], h[4], h[7]], [h[2], h[5], 1]
    n1, n2 = math.sqrt(dot(c1, c1)), math.sqrt(dot(c2, c2))
    if min(n1, n2) < 1e-10:
        raise ValueError('degenerate camera pose')
    scale = 2/(n1+n2)
    r1 = unit(c1)
    r2 = unit([v-dot(c2, r1)*r for v, r in zip(c2, r1)])
    r3 = [r1[1]*r2[2]-r1[2]*r2[1], r1[2]*r2[0]-r1[0]*r2[2], r1[0]*r2[1]-r1[1]*r2[0]]
    camera = {'K': [f, 0, width/2, 0, f, height/2, 0, 0, 1],
              'R': [v for row in zip(r1, r2, r3) for v in row],
              't': [v*scale*170 for v in c3]}
    errors = [math.dist(project(camera, (x, y, 0)), p) for (x, y), p in zip(BOARD_POINTS, points)]
    rms = math.sqrt(sum(e*e for e in errors)/len(errors))
    return camera, rms


def estimate_automatic(points, width, height):
    # Search the allowed focal length range for the pose with the lowest
    # reprojection error. The fitted camera remains an ideal pinhole model.
    candidates = []
    for i in range(121):
        fov = 30 + i
        try:
            camera, error = estimate(points, width, height, fov)
        except ValueError:
            continue
        candidates.append((error, fov, camera))
    if not candidates:
        raise ValueError("cannot estimate camera pose from these points")
    _, best, _ = min(candidates, key=lambda item: item[0])
    lo, hi = max(30., best - 1), min(150., best + 1)
    for _ in range(30):
        a, b = lo + (hi-lo)/3, hi - (hi-lo)/3
        def score(fov):
            try:
                return estimate(points, width, height, fov)[1]
            except ValueError:
                return float("inf")
        if score(a) < score(b):
            hi = b
        else:
            lo = a
    return estimate(points, width, height, (lo+hi)/2)


def calibrate(width, height, references, landmarks):
    import base64
    if set(landmarks) != set(CAMERAS):
        raise ValueError('all three cameras are required')
    cameras, errors = {}, {}
    for key in CAMERAS:
        camera, errors[key] = estimate_automatic(landmarks[key], width, height)
        camera['reference'] = base64.b64encode(references[key]).decode('ascii')
        cameras[key] = camera
    config = {'width': width, 'height': height, 'cameras': cameras}
    RenderedSource.configured(config)  # shared geometric validation, including three-view triangulation
    return config, errors
