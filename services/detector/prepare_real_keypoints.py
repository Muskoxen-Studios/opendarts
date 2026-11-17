"""Project frozen real-dataset board labels into camera image coordinates.

Targets represent the planar board impact point. They are not annotations of a
visible shaft tip, and this script never modifies detector output.
"""
import argparse
import hashlib
import json
import math
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATASET = ROOT / "build/reviewed-real-v1/dataset.json"
DEFAULT_OUTPUT = ROOT / "build/real-keypoints-v1"
DEFAULT_RETROSPECTIVE_OUTPUT = ROOT / "build/real-keypoints-retrospective-v1"
DEFAULT_RETROSPECTIVE = ROOT / "data/board-calibration/2026-11-16-system-calibration.json"


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def apply(h, point):
    x, y = point
    z = h[2][0] * x + h[2][1] * y + h[2][2]
    if not math.isfinite(z) or abs(z) < 1e-12:
        raise ValueError("homography maps point to infinity")
    out = ((h[0][0]*x+h[0][1]*y+h[0][2])/z,
           (h[1][0]*x+h[1][1]*y+h[1][2])/z)
    if not all(math.isfinite(v) for v in out):
        raise ValueError("non-finite projected point")
    return out


def inverse3(m):
    if len(m) != 3 or any(len(row) != 3 for row in m) or not all(
            isinstance(v, (int, float)) and math.isfinite(v) for row in m for v in row):
        raise ValueError("homography must be a finite 3x3 matrix")
    a, b, c = m
    det = (a[0]*(b[1]*c[2]-b[2]*c[1]) - a[1]*(b[0]*c[2]-b[2]*c[0]) +
           a[2]*(b[0]*c[1]-b[1]*c[0]))
    if not math.isfinite(det) or abs(det) < 1e-12:
        raise ValueError("singular homography")
    cof = [[b[1]*c[2]-b[2]*c[1], -(b[0]*c[2]-b[2]*c[0]), b[0]*c[1]-b[1]*c[0]],
           [-(a[1]*c[2]-a[2]*c[1]), a[0]*c[2]-a[2]*c[0], -(a[0]*c[1]-a[1]*c[0])],
           [a[1]*b[2]-a[2]*b[1], -(a[0]*b[2]-a[2]*b[0]), a[0]*b[1]-a[1]*b[0]]]
    return [[cof[j][i]/det for j in range(3)] for i in range(3)]


def load_calibration(path):
    raw = path.read_bytes()
    data = json.loads(raw)
    calibration = data.get("calibration", data)
    cams = calibration.get("cams")
    if calibration.get("calibrated") is not True or not isinstance(cams, list) or len(cams) != 3:
        raise ValueError(f"{path}: expected three calibrated cameras")
    normalized = {}
    for i, cam in enumerate(cams):
        if cam.get("calibrated") is not True or cam.get("width") != 1280 or cam.get("height") != 720:
            raise ValueError(f"{path}: camera {i} is not calibrated at 1280x720")
        # The non-undistorted matrix maps raw source pixels into canonical board pixels.
        h = cam.get("homography")
        normalized[str(i)] = {"inverse": inverse3(h), "homography": h}
    return normalized, sha256(raw)


def _linked_calibration(record, root, hashes):
    cal = record.get("calibration") or {}
    if not cal.get("id") or not cal.get("path"):
        return None
    path = root / cal["path"]
    if not path.is_file():
        return None
    raw = path.read_bytes()
    digest = sha256(raw)
    expected = cal.get("sha256") or hashes.get(cal["path"])
    if digest != cal["id"] or (expected and digest != expected):
        raise ValueError(f"capture {record['id']}: linked calibration hash mismatch")
    return path, json.loads(raw), digest


def _canonical(point):
    scale = (1000.0 / 3.0) / 170.0
    return 500.0 + point["x"] * scale, 500.0 - point["y"] * scale


def _camera_matrices(data):
    calibration = data.get("calibration", data)
    result = {}
    for i, cam in enumerate(calibration["cams"]):
        if cam.get("calibrated") is not True or cam.get("width") != 1280 or cam.get("height") != 720:
            raise ValueError(f"camera {i}: invalid calibration dimensions/state")
        h = cam.get("homography")
        result[str(i)] = inverse3(h)
    return result


def prepare(dataset_path=DEFAULT_DATASET, output_dir=DEFAULT_OUTPUT, allow_retrospective=False,
            retrospective_path=DEFAULT_RETROSPECTIVE):
    dataset_path = Path(dataset_path)
    output_dir = Path(output_dir) if output_dir else (DEFAULT_RETROSPECTIVE_OUTPUT if allow_retrospective else DEFAULT_OUTPUT)
    raw_dataset = dataset_path.read_bytes()
    dataset = json.loads(raw_dataset)
    dataset_hash = sha256(raw_dataset)
    capture_root = ROOT
    calibration_hashes = dataset.get("calibrationFileHashes", {})
    retrospective = None
    retrospective_captured_at = None
    if allow_retrospective:
        ret_path = Path(retrospective_path)
        if not ret_path.is_absolute():
            ret_path = ROOT / ret_path
        ret_data = json.loads(ret_path.read_text())
        retrospective = (_camera_matrices(ret_data), sha256(ret_path.read_bytes()),
                         str(ret_path.resolve().relative_to(ROOT)) if ret_path.resolve().is_relative_to(ROOT) else str(ret_path))
        retrospective_captured_at = ret_data.get("capturedAt")

    samples, excluded = [], []
    for record in dataset["records"]:
        linked = _linked_calibration(record, capture_root, calibration_hashes)
        if linked:
            cal_path, cal_data, cal_hash = linked
            inverses = _camera_matrices(cal_data)
            cal_info = {"id": record["calibration"]["id"],
                        "path": str(cal_path.resolve().relative_to(ROOT)), "sha256": cal_hash,
                        "retrospective": False}
        elif allow_retrospective and retrospective:
            inverses, cal_hash, cal_path = retrospective
            cal_info = {"id": None, "path": cal_path, "sha256": cal_hash,
                        "retrospective": True, "sourceCapturedAt": retrospective_captured_at}
        else:
            excluded.append({"captureId": record["id"], "reason": "no_capture_linked_calibration"})
            continue

        point = record["label"]["coords"]
        if not all(type(point.get(k)) in (int, float) and math.isfinite(point[k]) for k in ("x", "y")):
            excluded.append({"captureId": record["id"], "reason": "invalid_board_label"})
            continue
        canonical = _canonical(point)
        for camera in range(3):
            number = str(camera)
            try:
                pixel = apply(inverses[number], canonical)
            except (KeyError, ValueError) as exc:
                excluded.append({"captureId": record["id"], "camera": camera,
                                 "reason": "invalid_projection", "detail": str(exc)})
                continue
            visible = 0 <= pixel[0] < 1280 and 0 <= pixel[1] < 720
            samples.append({"sampleId": f"{record['id']}:cam{camera}", "captureId": record["id"],
                "baselineId": record["baselineId"], "camera": camera,
                "imagePath": record["cameraPaths"][number], "imageSHA256": record["imageHashes"][number],
                "baselineImagePath": record["baselineCameraPaths"][number],
                "baselineImageSHA256": record["baselineImageHashes"][number],
                "previousFrameCaptureId": record["previousFrameCaptureId"],
                "previousFrameImagePath": record["previousFrameCameraPaths"][number],
                "previousFrameImageSHA256": record["previousFrameImageHashes"][number],
                "targetPixel": {"x": pixel[0], "y": pixel[1]}, "inView": visible,
                "split": record["split"], "labelProvenance": record["label"]["provenance"],
                "targetType": "board-plane-impact-point", "calibration": cal_info})

    # Each capture's three camera samples are emitted from one record and share one split.
    by_capture = {}
    for sample in samples:
        by_capture.setdefault(sample["captureId"], []).append(sample)
    if any(len(group) != 3 or len({s["split"] for s in group}) != 1 for group in by_capture.values()):
        raise AssertionError("camera samples escaped their capture split group")
    output_dir.mkdir(parents=True, exist_ok=True)
    result = {"schemaVersion": 1, "datasetId": "real-keypoints-v1", "sourceDatasetPath": str(dataset_path.resolve().relative_to(ROOT)),
              "sourceDatasetSHA256": dataset_hash, "allowRetrospectiveCalibration": bool(allow_retrospective),
              "samples": samples, "excludedCaptures": excluded}
    target_file = output_dir / "targets.json"
    target_file.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    label_counts = {}
    for sample in samples:
        label_counts[sample["labelProvenance"]] = label_counts.get(sample["labelProvenance"], 0) + 1
    split_counts = {split: sum(s["split"] == split for s in samples) for split in ("development", "validation", "test")}
    out_of_view = sum(not s["inView"] for s in samples)
    linked_samples = sum(not s["calibration"]["retrospective"] for s in samples)
    provenance_groups = {}
    for record in dataset["records"]:
        provenance_groups[record["label"]["provenance"]] = provenance_groups.get(record["label"]["provenance"], 0) + 1
    report = ["# Real board keypoint targets", "", "Targets are projections of labelled board-plane impact coordinates into each camera view. They do not claim that the impact point, shaft tip, or dart is visible in the image.", "",
              f"- Samples: {len(samples)} across {len(by_capture)} captures; excluded captures: {len(excluded)}.",
              f"- Source label provenance by capture: {provenance_groups}", f"- Label provenance by camera sample: {label_counts}", f"- Splits by camera sample: {split_counts}",
              f"- Projected points outside 1280x720: {out_of_view} (coordinates retained without clamping).",
              f"- Capture-linked calibration samples: {linked_samples}; retrospective calibration samples: {len(samples) - linked_samples}.",
              f"- Input reviewed dataset SHA-256: `{dataset_hash}`.",
              "- Each capture's three cameras stay in the same frozen split. Calibration is linked per capture by default; `--allow-retrospective` applies the standalone calibration to records lacking a linked snapshot and marks that provenance explicitly.",
              "- Raw homographies are inverted to project canonical board-plane coordinates (bull at 500,500; 170 mm radius maps to 1000/3 pixels; y points down in the image) to raw 1280x720 image pixels. The raw matrix is used without undistorting images. The image and calibration must share the same camera orientation and mount; retrospective mappings have additional temporal mismatch risk.",
              "- Board-plane impact points are weak image targets, not hand-annotated shaft-tip locations or visibility claims.", ""]
    (output_dir / "REPORT.md").write_text("\n".join(report) + "\n")
    _write_development_contact_sheet(samples, output_dir)
    return result


def _write_development_contact_sheet(samples, output_dir):
    """Optional ImageMagick audit montage for development targets only."""
    if not shutil.which("convert") or not shutil.which("montage"):
        return False
    chosen = []
    seen = set()
    for sample in samples:
        if sample["split"] == "development" and sample["inView"] and sample["captureId"] not in seen:
            chosen.append(sample)
            seen.add(sample["captureId"])
            if len(chosen) == 12:
                break
    if not chosen:
        return False
    thumb_w, thumb_h = 320, 180
    thumbnails = []
    for i, sample in enumerate(chosen):
        path = output_dir / f".development-target-{i}.jpg"
        x = sample["targetPixel"]["x"] * thumb_w / 1280
        y = sample["targetPixel"]["y"] * thumb_h / 720
        label = f"...{sample['captureId'][-8:]} cam{sample['camera']} retro"
        result = subprocess.run(["convert", str(ROOT / sample["imagePath"]), "-resize", f"{thumb_w}x{thumb_h}!",
            "-fill", "none", "-stroke", "red", "-strokewidth", "2", "-draw", f"circle {x},{y} {x+5},{y}",
            "-gravity", "south", "-background", "#181818", "-splice", "0x20", "-fill", "white", "-stroke", "none",
            "-pointsize", "10", "-annotate", "+0+4", label, str(path)], capture_output=True)
        if result.returncode != 0:
            for thumb in thumbnails:
                thumb.unlink(missing_ok=True)
            return False
        thumbnails.append(path)
    result = subprocess.run(["montage", *map(str, thumbnails), "-tile", "3x", "-geometry", "+0+0",
                             str(output_dir / "development-contact-sheet.jpg")], capture_output=True)
    for thumb in thumbnails:
        thumb.unlink(missing_ok=True)
    if result.returncode != 0:
        return False
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--output", type=Path, default=None,
                        help="output directory (default: linked-only or retrospective-specific build directory)")
    parser.add_argument("--allow-retrospective", action="store_true",
                        help="use a standalone calibration for records without capture-linked calibration")
    parser.add_argument("--retrospective-calibration", type=Path, default=DEFAULT_RETROSPECTIVE)
    args = parser.parse_args()
    result = prepare(args.dataset, args.output, args.allow_retrospective, args.retrospective_calibration)
    output_dir = args.output or (DEFAULT_RETROSPECTIVE_OUTPUT if args.allow_retrospective else DEFAULT_OUTPUT)
    print(f"Wrote {output_dir / 'targets.json'} ({len(result['samples'])} camera samples)")


if __name__ == "__main__":
    main()
