"""Validate and normalize a Board Manager planar calibration export."""

import argparse
import json
import math
from pathlib import Path


def apply(h, p):
    x, y = p
    z = h[2][0] * x + h[2][1] * y + h[2][2]
    if abs(z) < 1e-12:
        raise ValueError("homography maps point to infinity")
    return ((h[0][0] * x + h[0][1] * y + h[0][2]) / z,
            (h[1][0] * x + h[1][1] * y + h[1][2]) / z)


def inverse3(m):
    a, b, c = m
    det = (a[0] * (b[1]*c[2]-b[2]*c[1]) - a[1] * (b[0]*c[2]-b[2]*c[0]) + a[2] * (b[0]*c[1]-b[1]*c[0]))
    if abs(det) < 1e-12:
        raise ValueError("singular matrix")
    cof = [[b[1]*c[2]-b[2]*c[1], -(b[0]*c[2]-b[2]*c[0]), b[0]*c[1]-b[1]*c[0]],
           [-(a[1]*c[2]-a[2]*c[1]), a[0]*c[2]-a[2]*c[0], -(a[0]*c[1]-a[1]*c[0])],
           [a[1]*b[2]-a[2]*b[1], -(a[0]*b[2]-a[2]*b[0]), a[0]*b[1]-a[1]*b[0]]]
    return [[cof[j][i] / det for j in range(3)] for i in range(3)]


def mmul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def dot(a, b):
    return sum(x*y for x, y in zip(a, b))


def scale(v, s):
    return [x*s for x in v]


def norm(v):
    return math.sqrt(dot(v, v))


def unit(v):
    n = norm(v)
    if n < 1e-12:
        raise ValueError("degenerate pose column")
    return scale(v, 1/n)


def cross(a, b):
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]


def undistort(pixel, k, d):
    x = (pixel[0]-k[0][2])/k[0][0]
    y = (pixel[1]-k[1][2])/k[1][1]
    xd, yd = x, y
    k1, k2, p1, p2, k3 = (list(d) + [0]*5)[:5]
    for _ in range(12):
        r2 = x*x + y*y
        radial = 1 + k1*r2 + k2*r2*r2 + k3*r2*r2*r2
        tx = 2*p1*x*y + p2*(r2 + 2*x*x)
        ty = p1*(r2 + 2*y*y) + 2*p2*x*y
        if abs(radial) < 1e-9:
            break
        x, y = (xd-tx)/radial, (yd-ty)/radial
    return (k[0][0]*x+k[0][2], k[1][1]*y+k[1][2])


def columns(m):
    return [[m[r][c] for r in range(3)] for c in range(3)]


def pose_from_plane_homography(h_image_to_canonical, k, radius_px, image_points):
    # Canonical raster to metric board plane, then invert to metric→image.
    s = 170.0 / radius_px
    canonical_to_mm = [[s, 0, -500*s], [0, -s, 500*s], [0, 0, 1]]
    mm_to_canonical = inverse3(canonical_to_mm)
    metric_to_image = mmul(inverse3(h_image_to_canonical), mm_to_canonical)
    normalized = mmul(inverse3(k), metric_to_image)
    c1, c2, c3 = columns(normalized)
    lam = 2 / (norm(c1) + norm(c2))
    if c3[2] * lam < 0:
        lam = -lam
    raw1, raw2, t = scale(c1, lam), scale(c2, lam), scale(c3, lam)
    r1 = unit(raw1)
    r2 = unit([raw2[i] - dot(raw2, r1)*r1[i] for i in range(3)])
    r3 = unit(cross(r1, r2))
    R = [[r1[i], r2[i], r3[i]] for i in range(3)]
    # Reprojection residual over independent ring samples after projection onto
    # the orthonormalized pose. This catches bad conventions/decomposition.
    errors = []
    for pixel in image_points:
        canonical = apply(h_image_to_canonical, pixel)
        x, y = s*(canonical[0]-500), -s*(canonical[1]-500)
        camera = [R[i][0]*x + R[i][1]*y + t[i] for i in range(3)]
        projected = apply(k, (camera[0]/camera[2], camera[1]/camera[2]))
        errors.append(math.dist(projected, pixel))
    return {"K": k, "R": R, "t": t,
            "columnNormRatio": norm(c1)/norm(c2),
            "r1DotR2BeforeOrthonormalization": dot(unit(raw1), unit(raw2)),
            "positiveDepth": t[2] > 0,
            "ringReprojectionRmsePx": math.sqrt(sum(e*e for e in errors)/len(errors))}


def audit(calibration_path, ellipses_path, output_path):
    source = json.loads(calibration_path.read_text())
    ellipses = json.loads(ellipses_path.read_text())
    calibration = source.get("calibration", source)
    if not calibration.get("calibrated") or len(calibration.get("cams", [])) != 3:
        raise ValueError("expected three calibrated cameras")
    mode = "homographyUndistorted"
    cameras = {}
    for index, cam in enumerate(calibration["cams"]):
        if not cam.get("calibrated") or cam.get("width") != 1280 or cam.get("height") != 720:
            raise ValueError(f"camera {index}: unsupported calibration state or dimensions")
        h = cam.get(mode)
        if not isinstance(h, list) or len(h) != 3 or any(len(row) != 3 for row in h):
            raise ValueError(f"camera {index}: missing {mode}")
        e = ellipses[str(index)]
        bull_input = undistort(e["bull"], cam["k"], cam.get("d", []))
        ring_points = [undistort(p, cam["k"], cam.get("d", [])) for p in e["doubleOuterPoints"]]
        bull = apply(h, bull_input)
        mapped = [apply(h, p) for p in ring_points]
        radii = [math.dist(bull, p) for p in mapped]
        mean_radius = sum(radii) / len(radii)
        deviation = max(abs(r - mean_radius) for r in radii)
        if not (300 < mean_radius < 370 and deviation < 8 and
                abs(bull[0] - 500) < 8 and abs(bull[1] - 500) < 8):
            raise ValueError(f"camera {index}: bull/ring geometry failed sanity checks")
        # Canonical plane coordinates are centered at the bull, with x right,
        # y up, and the measured outer-double radius assigned the schema value.
        scale = 170.0 / mean_radius
        k = cam.get("k")
        if not isinstance(k, list) or len(k) != 3 or any(len(row) != 3 for row in k):
            raise ValueError(f"camera {index}: missing pinhole intrinsics")
        pose = pose_from_plane_homography(h, k, mean_radius, ring_points)
        if (not pose["positiveDepth"] or pose["ringReprojectionRmsePx"] > 5 or
                not (0.85 < pose["columnNormRatio"] < 1.15) or
                abs(pose["r1DotR2BeforeOrthonormalization"]) > 0.05):
            raise ValueError(f"camera {index}: pose decomposition failed sanity checks: {pose}")
        canonical_to_mm = [[scale, 0, -500*scale], [0, -scale, 500*scale], [0, 0, 1]]
        pixel_to_board = mmul(canonical_to_mm, h)
        imported_bull = apply(pixel_to_board, bull_input)
        imported_radii = [math.dist(imported_bull, apply(pixel_to_board, p)) for p in ring_points]
        if max(abs(r-170) for r in imported_radii) > 5 or math.dist(imported_bull, (0, 0)) > 5:
            raise ValueError(f"camera {index}: normalized board-plane mapping failed")
        cameras[str(index)] = {
            "width": cam["width"], "height": cam["height"],
            "K": k, "distortion": cam.get("d", []),
            "R": pose["R"], "t": pose["t"],
            "pixelToBoardHomography": pixel_to_board,
            "validation": {
                "sourceMode": mode,
                "undistortedRingPoints": True,
                "bullBoardPx": [round(bull[0], 3), round(bull[1], 3)],
                "doubleOuterRadiusPxMean": round(mean_radius, 3),
                "doubleOuterRadiusPxMaxDeviation": round(deviation, 3),
                "inputFitErrorPx": cam.get("errorPx"),
                "poseDecomposition": pose,
            },
        }
    result = {
        "format": "board-manager-plane-calibration-v1",
        "sourceCapturedAt": source.get("capturedAt"),
        "sourceMethod": source.get("method"),
        "planeCoordinates": "millimetres; bull origin; x right, y up; outer double radius 170 mm",
        "cameras": cameras,
        "limitations": [
            "Planar mapping validated against bull and double-outer ellipse points only.",
            "Wedge angle/clockwise segment orientation was not independently validated.",
            "Approximate pose is decomposed from the planar homography and reported intrinsics; this does not establish a native uncertainty guarantee.",
            "Pose and homography use undistorted image pixels; runtime must undistort images or points with the supplied K and distortion.",
            "Calibration-to-capture temporal binding and camera mount stability are unverified unless calibration was captured with the image set.",
        ],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2) + "\n")
    return result


def main():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--calibration", type=Path, default=root / "data/board-calibration/2026-11-16-system-calibration.json")
    parser.add_argument("--ellipses", type=Path, default=root / "data/board-calibration/2026-11-16-calibration-ellipses.json")
    parser.add_argument("--output", type=Path, default=root / "build/real-board-calibration.json")
    args = parser.parse_args()
    result = audit(args.calibration, args.ellipses, args.output)
    print(f"Wrote {args.output}")
    for camera, details in result["cameras"].items():
        print(f"cam{camera}: bull={details['validation']['bullBoardPx']} "
              f"outer radius={details['validation']['doubleOuterRadiusPxMean']} px "
              f"max deviation={details['validation']['doubleOuterRadiusPxMaxDeviation']} px")


if __name__ == "__main__":
    main()
