"""Build a deterministic, offline dataset from reviewed board captures.

This module only reads capture artifacts. Labels are metadata for evaluation;
they must never be passed to detector candidate extraction.
"""
import hashlib
import json
import math
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CAPTURE_DIR = ROOT / "data/board-captures"
DEFAULT_OUTPUT_DIR = ROOT / "build/reviewed-real-v1"
RADII = (7.0, 17.0, 97.0, 107.0, 160.0, 170.0)
VISIBILITY_FORMAT = "darts-capture-visibility-v1"
VISIBILITY_REASON = "no-visible-dart-all-cameras"
CONTAMINATED_REFERENCE_REASON = "contaminated-reference"
VISIBILITY_REASONS = {VISIBILITY_REASON, CONTAMINATED_REFERENCE_REASON}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def jpeg_dimensions(data):
    """Read dimensions from a JPEG SOF marker without decoding/re-encoding."""
    if not data.startswith(b"\xff\xd8"):
        raise ValueError("not a JPEG")
    i = 2
    while i < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        while i < len(data) and data[i] == 0xFF:
            i += 1
        if i >= len(data):
            break
        marker = data[i]
        i += 1
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            continue
        if i + 2 > len(data):
            break
        length = int.from_bytes(data[i:i + 2], "big")
        if length < 2 or i + length > len(data):
            break
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            return {"width": int.from_bytes(data[i + 5:i + 7], "big"),
                    "height": int.from_bytes(data[i + 3:i + 5], "big")}
        i += length
    raise ValueError("JPEG dimensions not found")


def distance_to_scoring_boundary(point):
    x, y = point["x"], point["y"]
    radius = math.hypot(x, y)
    nearest = min(abs(radius - r) for r in RADII)
    for i in range(20):
        angle = math.radians(81 + i * 18)
        ux, uy = math.cos(angle), math.sin(angle)
        projection = max(17.0, min(170.0, x * ux + y * uy))
        nearest = min(nearest, math.hypot(x - projection * ux, y - projection * uy))
    return nearest


def _finite_point(point):
    return isinstance(point, dict) and all(type(point.get(k)) in (int, float) and math.isfinite(point[k]) for k in ("x", "y"))


def _occupancy(manifest, side):
    return (manifest.get("reportedOccupancy" + side) or {}).get("throws")


def _valid_baseline(m):
    return (m.get("type") == "empty-board-baseline" and m.get("status") == "complete" and
            m.get("sceneChangedDuringCapture") is False and all(
                (m.get("reportedOccupancy" + side) or {}).get("connected") is True and
                (m.get("reportedOccupancy" + side) or {}).get("running") is True and
                _occupancy(m, side) == [] for side in ("Before", "After")))


def _images(directory, manifest):
    cameras = manifest.get("cameras") or []
    if len(cameras) != 3 or {c.get("camera") for c in cameras} != {0, 1, 2}:
        raise ValueError("not exactly three camera records")
    paths, hashes, dimensions = {}, {}, {}
    for camera in cameras:
        n = str(camera["camera"])
        expected_file = f"camera-{n}.jpg"
        if camera.get("error") or camera.get("file") != expected_file:
            raise ValueError(f"camera {n} has no image")
        p = directory / expected_file
        raw = p.read_bytes()
        size = jpeg_dimensions(raw)
        if size != {"width": 1280, "height": 720}:
            raise ValueError(f"camera {n} dimensions are not 1280x720")
        paths[n] = str(p.resolve().relative_to(ROOT))
        hashes[n] = sha256(raw)
        dimensions[n] = size
    return paths, hashes, dimensions


def _read_inputs(capture_dir):
    manifests = {}
    for path in sorted(capture_dir.glob("*/manifest.json")):
        try:
            m = json.loads(path.read_text())
            if m.get("captureId"):
                manifests[m["captureId"]] = (path, m)
        except (OSError, ValueError):
            continue
    return manifests


def _strict_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key {key!r} in {path}")
            result[key] = value
        return result

    def reject_constant(value):
        raise ValueError(f"non-finite JSON number {value!r} in {path}")

    return json.loads(Path(path).read_text(), object_pairs_hook=unique,
                      parse_constant=reject_constant)


def _load_visibility_sidecars(capture_dir, source):
    """Validate explicit all-camera invisibility exclusions before label use.

    A sidecar is accepted only for an existing throw capture and only when all
    three camera hashes still identify the current source JPEGs. Malformed or
    stale annotations raise immediately instead of silently reviving positives.
    """
    directory = Path(capture_dir) / "_visibility"
    if not directory.exists():
        return {}
    if not directory.is_dir():
        raise ValueError(f"visibility sidecar path is not a directory: {directory}")
    validated = {}
    expected_keys = {"0", "1", "2"}
    for sidecar_path in sorted(directory.glob("*.json")):
        capture_id = sidecar_path.stem
        if capture_id not in source:
            raise ValueError(f"visibility sidecar refers to missing capture {capture_id}")
        manifest_path, manifest = source[capture_id]
        if manifest.get("type") != "throw":
            raise ValueError(f"{sidecar_path}: visibility exclusion must refer to a throw capture")
        sidecar = _strict_json(sidecar_path)
        if not isinstance(sidecar, dict):
            raise ValueError(f"{sidecar_path}: sidecar must be a JSON object")
        if sidecar.get("format") != VISIBILITY_FORMAT:
            raise ValueError(f"{sidecar_path}: unsupported visibility sidecar format")
        if sidecar.get("captureId") != capture_id:
            raise ValueError(f"{sidecar_path}: captureId does not match filename")
        if sidecar.get("excludeFromPositiveTraining") is not True:
            raise ValueError(f"{sidecar_path}: explicit excludeFromPositiveTraining=true required")
        reason = sidecar.get("reason")
        if reason not in VISIBILITY_REASONS:
            raise ValueError(f"{sidecar_path}: unsupported reason {reason!r}")
        if not isinstance(sidecar.get("reviewedBy"), str) or not sidecar["reviewedBy"].strip():
            raise ValueError(f"{sidecar_path}: reviewedBy must be a nonempty string")
        if sidecar.get("userAuthorized") is not True:
            raise ValueError(f"{sidecar_path}: userAuthorized=true required")
        image_hashes = sidecar.get("imageSHA256")
        if not isinstance(image_hashes, dict) or set(image_hashes) != expected_keys:
            raise ValueError(f"{sidecar_path}: imageSHA256 must contain exactly cameras 0, 1, and 2")
        actual_hashes = {}
        for camera in sorted(expected_keys):
            expected_hash = image_hashes[camera]
            if (not isinstance(expected_hash, str) or len(expected_hash) != 64 or
                    any(ch not in "0123456789abcdef" for ch in expected_hash)):
                raise ValueError(f"{sidecar_path}: invalid camera {camera} SHA-256")
            image_path = manifest_path.parent / f"camera-{camera}.jpg"
            if not image_path.is_file():
                raise ValueError(f"{sidecar_path}: missing camera {camera} source image")
            actual_hash = sha256(image_path.read_bytes())
            actual_hashes[camera] = actual_hash
            if actual_hash != expected_hash:
                raise ValueError(f"{sidecar_path}: stale camera {camera} image hash")
        reference_id = sidecar.get("referenceCaptureId")
        reference_hashes = None
        if reason == CONTAMINATED_REFERENCE_REASON:
            if not isinstance(reference_id, str) or reference_id not in source:
                raise ValueError(f"{sidecar_path}: referenceCaptureId must identify an existing capture")
            if manifest.get("baselineForThrow") != reference_id:
                reference_manifest = source[reference_id][1]
                prefix = _occupancy(manifest, "Before")
                if (reference_manifest.get("type") != "throw" or
                        reference_manifest.get("baselineForThrow") != manifest.get("baselineForThrow") or
                        _occupancy(reference_manifest, "After") != (prefix[:-1] if isinstance(prefix, list) else None)):
                    raise ValueError(f"{sidecar_path}: reference capture is not the linked baseline or expected prefix")
            ref_path, ref_manifest = source[reference_id]
            try:
                _, reference_hashes, _ = _images(ref_path.parent, ref_manifest)
            except (OSError, ValueError, KeyError) as error:
                raise ValueError(f"{sidecar_path}: invalid referenced capture images: {error}") from error
            expected_reference = sidecar.get("referenceImageSHA256")
            if not isinstance(expected_reference, dict) or set(expected_reference) != expected_keys:
                raise ValueError(f"{sidecar_path}: referenceImageSHA256 must contain exactly cameras 0, 1, and 2")
            if expected_reference != reference_hashes:
                raise ValueError(f"{sidecar_path}: referenced image hashes do not match source images")
        validated[capture_id] = {
            "sidecarPath": str(sidecar_path.resolve().relative_to(ROOT)),
            "sidecarSHA256": sha256(sidecar_path.read_bytes()),
            "format": sidecar["format"],
            "reason": sidecar["reason"],
            "reviewedBy": sidecar["reviewedBy"],
            "reviewedAt": sidecar.get("reviewedAt"),
            "userAuthorized": True,
            "imageSHA256": actual_hashes,
            **({"referenceCaptureId": reference_id, "referenceImageSHA256": reference_hashes}
               if reason == CONTAMINATED_REFERENCE_REASON else {}),
        }
    return validated


def build_dataset(capture_dir=DEFAULT_CAPTURE_DIR, output_dir=DEFAULT_OUTPUT_DIR):
    capture_dir, output_dir = Path(capture_dir), Path(output_dir)
    source = _read_inputs(capture_dir)
    visibility_exclusions = _load_visibility_sidecars(capture_dir, source)
    calibration_snapshots = []
    for cid, (_, m) in source.items():
        cal = m.get("calibration") or {}
        if cal.get("id") and cal.get("path"):
            cp = capture_dir / cal["path"]
            if cp.is_file() and sha256(cp.read_bytes()) == cal["id"]:
                calibration_snapshots.append((cal.get("lastReadAt", ""), {"id": cal["id"], "path": str(cp.resolve().relative_to(ROOT)),
                    "sha256": sha256(cp.read_bytes()), "lastReadAt": cal.get("lastReadAt")}))
    calibration_snapshots.sort(key=lambda x: x[0])
    baselines = {cid: m for cid, (_, m) in source.items() if _valid_baseline(m)}
    exclusions, candidates = [], []
    for cid, (path, m) in sorted(source.items()):
        if m.get("type") != "throw":
            continue
        visibility = visibility_exclusions.get(cid)
        if visibility is not None:
            exclusions.append({"id": cid, "reason": "contaminated_reference" if visibility["reason"] == CONTAMINATED_REFERENCE_REASON else "explicit_no_visible_dart_all_cameras",
                               "visibility": visibility})
            continue
        review_path = path.parent / "_reviews" / f"{cid}.json"
        review = json.loads(review_path.read_text()) if review_path.exists() else {}
        status = review.get("status")
        if status in ("incorrect", "uncertain"):
            exclusions.append({"id": cid, "reason": f"review_{status}"})
            continue
        baseline_id = m.get("baselineForThrow")
        baseline = baselines.get(baseline_id)
        if baseline is None:
            exclusions.append({"id": cid, "reason": "missing_or_invalid_baseline"})
            continue
        if m.get("status") != "complete" or m.get("sceneChangedDuringCapture") is not False:
            exclusions.append({"id": cid, "reason": "incomplete_or_unstable_capture"})
            continue
        if any((m.get("reportedOccupancy" + side) or {}).get("connected") is not True or
               (m.get("reportedOccupancy" + side) or {}).get("running") is not True
               for side in ("Before", "After")):
            exclusions.append({"id": cid, "reason": "board_not_connected_and_running"})
            continue
        try:
            paths, image_hashes, dimensions = _images(path.parent, m)
            ref_path, ref_m = source[baseline_id]
            ref_paths, ref_hashes, ref_dims = _images(ref_path.parent, ref_m)
        except (OSError, ValueError, KeyError):
            exclusions.append({"id": cid, "reason": "missing_or_invalid_jpeg"})
            continue
        occupancy = _occupancy(m, "Before")
        if not isinstance(occupancy, list) or not occupancy or len(occupancy) > 3:
            exclusions.append({"id": cid, "reason": "unknown_occupancy_prefix"})
            continue
        reported = m.get("reportedThrow") or {}
        raw_coords, segment = reported.get("coords"), reported.get("segment")
        corrected = review.get("correctedCoords")
        if status == "confirmed":
            if corrected is not None:
                exclusions.append({"id": cid, "reason": "manual_correction_requires_adjudication",
                                   "correctedCoords": corrected, "reportedCoords": raw_coords})
                continue
            elif _finite_point(raw_coords) and isinstance(segment, dict):
                coords, provenance = raw_coords, "reviewed"
            else:
                exclusions.append({"id": cid, "reason": "confirmed_without_position_label"})
                continue
        elif _finite_point(raw_coords) and isinstance(segment, dict) and distance_to_scoring_boundary(raw_coords) > 3:
            coords, provenance = raw_coords, "trusted-board-interior"
        else:
            exclusions.append({"id": cid, "reason": "unreviewed_near_edge_or_unknown"})
            continue
        cal = m.get("calibration") or {}
        linked_cal = next((snapshot for _, snapshot in calibration_snapshots if snapshot["id"] == cal.get("id")), None)
        retrospective = False
        if linked_cal is None:
            eligible_calibrations = [snapshot for when, snapshot in calibration_snapshots if when <= (m.get("captureStartedAt") or "")]
            linked_cal = eligible_calibrations[-1] if eligible_calibrations else None
            retrospective = linked_cal is not None
        candidates.append({"id": cid, "baselineId": baseline_id, "referenceCaptureId": baseline_id,
            "captureStartedAt": m.get("captureStartedAt"), "cameraPaths": paths, "imageHashes": image_hashes,
            "dimensions": dimensions, "baselineCameraPaths": ref_paths, "baselineImageHashes": ref_hashes,
            "baselineDimensions": ref_dims,
            "review": {"status": status, "updatedAt": review.get("updatedAt"),
                       "sourceSHA256": sha256(review_path.read_bytes()) if review_path.is_file() else None},
            "label": {"coords": coords, "segment": segment, "provenance": provenance,
                      "rawReported": {"coords": raw_coords, "segment": segment},
                      "correctedCoords": corrected},
            "calibration": {**(linked_cal or {}), "retrospectiveSnapshot": retrospective}, "_visitTime": baseline.get("captureStartedAt", ""),
            "_occupancy": len(occupancy)})

    # Require a prior same-baseline image whose complete occupancy is exactly the
    # prefix before this throw. A matching count alone is not sufficient.
    with_previous = []
    for rec in candidates:
        path, manifest = source[rec["id"]]
        current = _occupancy(manifest, "Before") or []
        prefix = current[:-1]
        choices = []
        if not prefix:
            choices.append((rec["baselineId"], source[rec["baselineId"]][1]))
        else:
            for other_id, (_, other) in source.items():
                if other_id == rec["id"] or other.get("baselineForThrow") != rec["baselineId"]:
                    continue
                after = _occupancy(other, "After")
                if after == prefix and other.get("status") == "complete" and other.get("sceneChangedDuringCapture") is False:
                    choices.append((other_id, other))
        choices = [(pid, pm) for pid, pm in choices if pm.get("captureFinishedAt", "") < manifest.get("captureStartedAt", "")]
        if not choices:
            exclusions.append({"id": rec["id"], "reason": "no_matching_full_occupancy_prefix_frame"})
            continue
        previous_id, previous_m = max(choices, key=lambda item: item[1].get("captureFinishedAt", ""))
        pp = source[previous_id][0].parent
        try:
            prev_paths, prev_hashes, prev_dims = _images(pp, previous_m)
        except (OSError, ValueError, KeyError):
            exclusions.append({"id": rec["id"], "reason": "invalid_prefix_reference_jpeg"})
            continue
        rec.update({"previousFrameCaptureId": previous_id, "previousFrameCameraPaths": prev_paths,
                    "previousFrameImageHashes": prev_hashes, "previousFrameDimensions": prev_dims,
                    "occupancyPrefix": prefix})
        with_previous.append(rec)
    candidates = with_previous

    # Any baseline visit containing an incorrect review is wholly excluded from evaluation.
    blocked_visits = set()
    for cid, (p, m) in source.items():
        review_file = p.parent / "_reviews" / f"{cid}.json"
        review = json.loads(review_file.read_text()) if review_file.exists() else {}
        if m.get("type") == "throw" and review.get("status") == "incorrect" and m.get("baselineForThrow"):
            blocked_visits.add(cid)
    blocked_baselines = {source[cid][1].get("baselineForThrow") for cid in blocked_visits}
    kept = []
    for rec in candidates:
        if rec["baselineId"] in blocked_baselines:
            exclusions.append({"id": rec["id"], "reason": "visit_contains_incorrect_review"})
        else:
            kept.append(rec)

    groups = sorted({(r["_visitTime"], r["baselineId"]) for r in kept})
    n = len(groups)
    dev_end, val_end = math.ceil(n * .6), math.ceil(n * .8)
    split_by_baseline = {bid: ("development" if i < dev_end else "validation" if i < val_end else "test")
                         for i, (_, bid) in enumerate(groups)}
    prior_path = output_dir / "dataset.json"
    if prior_path.is_file():
        try:
            prior = json.loads(prior_path.read_text())
            frozen_prior = prior.get("frozenSplitByBaseline") or {
                rec["baselineId"]: rec["split"] for rec in prior.get("records", [])}
            split_by_baseline.update({bid: split for bid, split in frozen_prior.items()
                                      if bid in split_by_baseline and split in ("development", "validation", "test")})
        except (OSError, ValueError):
            pass
    for rec in kept:
        rec["split"] = split_by_baseline[rec["baselineId"]]
        rec.pop("_visitTime")
        rec.pop("_occupancy")
    output_dir.mkdir(parents=True, exist_ok=True)
    frozen = {"schemaVersion": 1, "datasetId": "reviewed-real-v1", "splitPolicy": "whole-baseline-visits-chronological-60-20-20",
              "frozenSplitByBaseline": split_by_baseline,
              "records": kept, "exclusions": sorted(exclusions, key=lambda x: x["id"]),
              "sourceManifestHashes": {cid: sha256(path.read_bytes()) for cid, (path, _) in sorted(source.items())},
              "sourceVisibilityHashes": {cid: visibility["sidecarSHA256"]
                                         for cid, visibility in sorted(visibility_exclusions.items())},
              "visibilityExclusions": [{"captureId": cid, **visibility}
                                       for cid, visibility in sorted(visibility_exclusions.items())],
              "sourceReviewHashes": {cid: sha256(review_path.read_bytes()) for cid, (path, _) in sorted(source.items())
                                     if (review_path := path.parent / "_reviews" / f"{cid}.json").is_file()},
              "calibrationFileHashes": {str(p.resolve().relative_to(ROOT)): sha256(p.read_bytes())
                                         for p in sorted((capture_dir / "_calibrations").glob("*.json")) if p.is_file()},
              "labelPolicy": {"reviewed": "confirmed human review; confirmed corrected coordinates retained separately",
                              "trusted-board-interior": "unreviewed finite board-reported coordinates >3mm from exact scoring boundary",
                              "nearEdgeMm": 3, "boundaryRadiiMm": list(RADII), "spokes": {"count": 20, "firstDegrees": 81, "stepDegrees": 18, "innerRadiusMm": 17, "outerRadiusMm": 170}}}
    (output_dir / "dataset.json").write_text(json.dumps(frozen, indent=2, sort_keys=True) + "\n")
    counts = Counter(r["label"]["provenance"] for r in kept)
    splits = Counter(r["split"] for r in kept)
    reasons = Counter(x["reason"] for x in exclusions)
    report = ["# Reviewed real capture dataset", "", "Frozen offline export; detector output is not modified and labels are not supplied to detector extraction.", "",
              f"- Included records: {len(kept)} ({dict(counts)})", f"- Excluded records: {len(exclusions)} ({dict(reasons)})",
              f"- Explicit capture exclusions: {len(visibility_exclusions)}; sidecar hashes and reviewer provenance are frozen in dataset.json.",
              f"- Splits: {dict(splits)}; baseline visits: {n}", "- Chronological whole-visit split: 60% development, 20% validation, 20% test.",
              "- The test split is historical and has been consumed by earlier experiments; it is not an untouched unseen test set.",
              "- Images, manifests, and review sidecars remain unchanged. SHA-256 hashes and source manifest hashes are in dataset.json.", "",
              "## Explicit capture exclusions", "",
              "No-visible-dart exclusions lack a visible dart across all three cameras. Contaminated-reference exclusions identify a linked capture pair with a contaminated reference image."]
    for cid, visibility in sorted(visibility_exclusions.items()):
        camera_hashes = ", ".join(f"cam{camera} `{digest_value}`"
                                  for camera, digest_value in sorted(visibility["imageSHA256"].items()))
        report.append(f"- `{cid}`: `{visibility['reason']}`; reviewed by `{visibility['reviewedBy']}`"
                      f" at `{visibility.get('reviewedAt')}`; sidecar `{visibility['sidecarPath']}` SHA-256"
                      f" `{visibility['sidecarSHA256']}`; source images: {camera_hashes}.")
    report.extend(["", "Rebuild with `python3 services/detector/build_real_dataset.py`."])
    (output_dir / "REPORT.md").write_text("\n".join(report) + "\n")
    return frozen


def load_dataset(path=DEFAULT_OUTPUT_DIR / "dataset.json"):
    """Load the frozen JSON dataset for offline evaluation."""
    return json.loads(Path(path).read_text())


if __name__ == "__main__":
    result = build_dataset()
    print(f"Wrote {DEFAULT_OUTPUT_DIR}/dataset.json ({len(result['records'])} records)")
