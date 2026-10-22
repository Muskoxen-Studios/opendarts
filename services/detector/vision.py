"""Pure image detector: no simulator coordinates, labels or event metadata."""

import math

ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5]


def segment(x, y):
    radius = math.hypot(x, y)
    if radius <= 7:
        return {"number": 25, "ring": "BULL"}, 50
    if radius <= 17:
        return {"number": 25, "ring": "OUTER_BULL"}, 25
    if radius > 170:
        return {"number": 0, "ring": "MISS"}, 0
    number = ORDER[int(((math.degrees(math.atan2(x, y)) + 9) % 360) // 18)]
    ring, multiplier = ("SINGLE_INNER", 1) if radius < 97 else (
        ("TRIPLE", 3) if radius <= 107 else (
            ("SINGLE_OUTER", 1) if radius < 160 else ("DOUBLE", 2)))
    return {"number": number, "ring": ring}, number * multiplier


def confident_segment(x, y, uncertainty_mm: float = 1):
    """Score only if an uncertainty disk cannot intersect a scoring boundary."""
    if not all(math.isfinite(v) for v in (x, y, uncertainty_mm)) or uncertainty_mm < 1:
        raise ValueError("invalid scoring uncertainty")
    radius = math.hypot(x, y)
    if any(abs(radius-boundary) <= uncertainty_mm for boundary in (7, 17, 97, 107, 160, 170)):
        raise ValueError("impact uncertainty intersects radial scoring boundary; reset required")
    # Sector wires run only from the outer bull to the outer double. Bull/miss
    # points that passed the radial guard cannot reach one of these wires.
    if 17 < radius < 170:
        angle = math.degrees(math.atan2(x, y))
        offset = abs((angle + 9) % 18 - 9)
        clearance = radius * math.sin(math.radians(9-offset))
        if clearance <= uncertainty_mm:
            raise ValueError("impact uncertainty intersects angular scoring boundary; reset required")
    return segment(x, y)


def components(image, reference, width, height, calibration):
    if type(image) is not bytes or type(reference) is not bytes:
        raise ValueError("images must be immutable grayscale bytes")
    if len(image) != width*height or len(reference) != len(image):
        raise ValueError("invalid image dimensions")
    a, b, c, d, e, f = calibration
    det = a*e-b*d
    if not all(math.isfinite(v) for v in calibration) or not math.isfinite(det) or abs(det) < 0.01:
        raise ValueError("invalid calibration")
    changed = {i for i, (p, q) in enumerate(zip(image, reference)) if abs(p-q) > 80}
    points = []
    while changed:
        todo = [changed.pop()]
        blob = []
        while todo:
            i = todo.pop()
            blob.append(i)
            x, y = i % width, i // width
            for nx, ny in ((x-1,y), (x+1,y), (x,y-1), (x,y+1)):
                j = ny*width+nx
                if 0 <= nx < width and 0 <= ny < height and j in changed:
                    changed.remove(j)
                    todo.append(j)
        span_x = max(i % width for i in blob) - min(i % width for i in blob)
        span_y = max(i // width for i in blob) - min(i // width for i in blob)
        touches_edge = any(i % width in (0, width-1) or i // width in (0, height-1) for i in blob)
        if not 25 <= len(blob) <= 38 or span_x > 6 or span_y > 6 or touches_edge:
            raise ValueError("ambiguous silhouette/occlusion")
        u = sum(i % width for i in blob)/len(blob)-c
        v = sum(i // width for i in blob)/len(blob)-f
        points.append(((e*u-b*v)/det, (-d*u+a*v)/det))
    return points


def distance(a, b):
    return math.hypot(a[0]-b[0], a[1]-b[1])


def match_points(left, right, tolerance=3):
    """Require unambiguous one-to-one correspondence; never guess an occluded view."""
    if len(left) != len(right):
        raise ValueError("views disagree on occupancy")
    pairs = []
    for point in left:
        matches = [p for p in right if distance(point, p) <= tolerance]
        if len(matches) != 1:
            raise ValueError("views disagree or correspondence ambiguous")
        pairs.append(matches[0])
    if any(sum(distance(p, q) <= tolerance for p in left) != 1 for q in right):
        raise ValueError("views disagree or correspondence ambiguous")
    return pairs


def occupancy_changes(old, new, tolerance=3):
    """Partial one-to-one matching; ambiguous identities must not hide a change."""
    old_counts = [sum(distance(p, q) <= tolerance for q in new) for p in old]
    new_counts = [sum(distance(p, q) <= tolerance for p in old) for q in new]
    if any(count > 1 for count in old_counts + new_counts):
        raise ValueError("ambiguous occupancy correspondence; reset required")
    return ([p for p, count in zip(old, old_counts) if count == 0],
            [p for p, count in zip(new, new_counts) if count == 0])


class ImageDetector:
    def __init__(self, calibrations, reference, width=480, height=480):
        if type(width) is not int or type(height) is not int or min(width, height) < 1:
            raise ValueError("invalid image dimensions")
        if len(calibrations) not in (2, 3) or set(calibrations) != set(reference):
            raise ValueError("need two or three calibrated reference views")
        # Bound half-pixel centroid raster error through the inverse affine map.
        # The sum of inverse-column lengths bounds every pixel-cell corner.
        bounds = []
        for calibration in calibrations.values():
            if len(calibration) != 6 or any(type(v) not in (int, float) or not math.isfinite(v)
                                            for v in calibration):
                raise ValueError("invalid calibration")
            a, b, _, d, e, _ = calibration
            det = a*e-b*d
            if not math.isfinite(det) or abs(det) < 0.01:
                raise ValueError("invalid calibration")
            bounds.append(0.5 * (math.hypot(e, d) + math.hypot(b, a))/abs(det))
        self.raster_uncertainty_mm = max(1, *bounds)
        self.uncertainty_mm = self.raster_uncertainty_mm
        self.calibrations = {k: tuple(v) for k, v in calibrations.items()}
        self.reference = dict(reference)
        self.width, self.height = width, height
        self.pending = None
        self.stable_frames = 0

    def clear_pending(self):
        self.pending = None
        self.stable_frames = 0

    def observe(self, images):
        if set(images) != set(self.calibrations):
            self.clear_pending()
            raise ValueError("missing or unknown camera views")
        try:
            views = [components(images[k], self.reference[k], self.width, self.height, c)
                     for k, c in self.calibrations.items()]
            for view in views:
                if any(distance(p, q) <= 6 for i, p in enumerate(view) for q in view[i+1:]):
                    raise ValueError("impacts too close for reliable correspondence")
            points = views[0]
            aligned = [points] + [match_points(points, v) for v in views[1:]]
            result = [tuple(sum(v[i][axis] for v in aligned)/len(aligned) for axis in (0, 1))
                      for i in range(len(points))]
            spread = max((distance(v[i], result[i]) for v in aligned
                          for i in range(len(result))), default=0)
            self.uncertainty_mm = self.raster_uncertainty_mm + spread
            # Temporal stability measures the actual changed pixels, not source metadata.
            signature = tuple(images[k] for k in sorted(images))
            self.stable_frames = self.stable_frames + 1 if signature == self.pending else 1
            self.pending = signature
            return result if self.stable_frames >= 3 else None
        except (ValueError, TypeError):
            self.clear_pending()
            raise
