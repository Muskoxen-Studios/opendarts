"""Prepare a challenge manifest of distinct, captured empty-frame pairs.

The manifest uses only empty baselines referenced by the frozen reviewed-real
dataset and assigned to its development or validation split. It never copies
images or changes existing capture/dataset artifacts. Pair labels describe
observed empty occupancy at capture endpoints; they do not imply uninterrupted
observation between those endpoints.
"""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATASET = ROOT / "build/reviewed-real-v1/dataset.json"
DEFAULT_CAPTURES = ROOT / "data/board-captures"
DEFAULT_OUTPUT = ROOT / "build/real-empty-pairs-v1-final/manifest.json"
CAMERAS = ("0", "1", "2")
MAX_GAP_SECONDS = 120.0


def strict_json(path):
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


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def timestamp(value, label):
    if not isinstance(value, str):
        raise ValueError(f"{label}: timestamp must be a string")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{label}: invalid ISO timestamp {value!r}") from exc


def safe_path(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f"path escapes repository root: {relative}")
    return path


def calibration_info(manifest, baseline_id):
    calibration = manifest.get("calibration") or {}
    value = calibration.get("sha256") or calibration.get("id")
    if value is not None and (not isinstance(value, str) or len(value) != 64):
        raise ValueError(f"{baseline_id}: invalid baseline-manifest calibration hash")
    if value:
        return {"sha256": value, "group": f"sha256:{value}",
                "retrospective": calibration.get("retrospectiveSnapshot") is True,
                "grouping": "same-calibration-sha256"}
    if calibration.get("retrospectiveSnapshot") is True:
        # Retrospective status is explicit; without a digest it is not safe to
        # claim that two targets used the same calibration artifact.
        return {"sha256": None, "group": None, "retrospective": True,
                "grouping": "retrospective-hash-unavailable; not-paired"}
    return {"sha256": None, "group": "unavailable",
            "retrospective": False, "grouping": "calibration-hash-unavailable"}


def occupancy_is_verified_empty(manifest):
    if (manifest.get("type") != "empty-board-baseline" or
            manifest.get("status") != "complete" or
            manifest.get("sceneChangedDuringCapture") is not False):
        return False
    for field in ("reportedOccupancyBefore", "reportedOccupancyAfter"):
        occupancy = manifest.get(field)
        if not isinstance(occupancy, dict):
            return False
        if (occupancy.get("connected") is not True or
                occupancy.get("running") is not True or
                occupancy.get("status") != "Throw" or
                occupancy.get("throws") != []):
            return False
    return True


def load_capture_index(captures_root):
    result = []
    for path in sorted(captures_root.glob("*/manifest.json")):
        manifest = strict_json(path)
        capture_id = manifest.get("captureId")
        if not isinstance(capture_id, str) or capture_id != path.parent.name:
            raise ValueError(f"capture ID/path mismatch in {path}")
        started = timestamp(manifest.get("captureStartedAt"), capture_id)
        result.append({"captureId": capture_id, "type": manifest.get("type"),
                       "baselineReason": manifest.get("baselineReason"),
                       "captureStartedAt": manifest["captureStartedAt"],
                       "_time": started})
    return sorted(result, key=lambda row: (row["_time"], row["captureId"]))


def candidate_baselines(dataset, captures_root):
    split_map = dataset.get("frozenSplitByBaseline")
    records = dataset.get("records")
    if not isinstance(split_map, dict) or not isinstance(records, list):
        raise ValueError("dataset must contain frozenSplitByBaseline and records[]")

    referenced = {}
    for row in records:
        baseline_id = row.get("baselineId")
        split = row.get("split")
        if split not in ("development", "validation", "test"):
            raise ValueError(f"{row.get('id')}: invalid frozen split {split!r}")
        frozen_split = split_map.get(baseline_id)
        if frozen_split != split:
            raise ValueError(f"{baseline_id}: record split does not match frozen split map")
        if split == "test":
            continue
        prior = referenced.get(baseline_id)
        if prior is not None and prior != split:
            raise ValueError(f"{baseline_id}: conflicting frozen split assignment")
        referenced[baseline_id] = split

    candidates, excluded = [], []
    source_manifest_hashes = dataset.get("sourceManifestHashes") or {}
    for baseline_id, split in sorted(referenced.items()):
        manifest_path = captures_root / baseline_id / "manifest.json"
        if not manifest_path.is_file():
            excluded.append({"baselineId": baseline_id, "split": split,
                             "reason": "missing_baseline_manifest"})
            continue
        manifest = strict_json(manifest_path)
        if manifest.get("captureId") != baseline_id:
            raise ValueError(f"{baseline_id}: manifest captureId mismatch")
        if not occupancy_is_verified_empty(manifest):
            excluded.append({"baselineId": baseline_id, "split": split,
                             "reason": "baseline_not_verified_empty_at_both_endpoints"})
            continue
        manifest_hash = digest(manifest_path)
        expected_manifest_hash = source_manifest_hashes.get(baseline_id)
        if expected_manifest_hash and manifest_hash != expected_manifest_hash:
            raise ValueError(f"{baseline_id}: baseline manifest hash mismatch")
        calibration = calibration_info(manifest, baseline_id)
        source_row = next(row for row in records if row.get("baselineId") == baseline_id and row.get("split") == split)
        started = timestamp(manifest.get("captureStartedAt"), baseline_id)
        cameras = {}
        for camera in CAMERAS:
            relative = source_row.get("baselineCameraPaths", {}).get(camera)
            expected = source_row.get("baselineImageHashes", {}).get(camera)
            if not relative or not expected:
                raise ValueError(f"{baseline_id}: missing frozen camera {camera} path/hash")
            image_path = safe_path(ROOT, relative)
            if not image_path.is_file():
                raise ValueError(f"{baseline_id}: missing baseline image {relative}")
            actual = digest(image_path)
            if actual != expected:
                raise ValueError(f"{baseline_id}: camera {camera} hash mismatch")
            cameras[camera] = {"imagePath": relative, "imageSHA256": actual}
        candidates.append({"baselineId": baseline_id, "split": split,
                          "captureStartedAt": manifest["captureStartedAt"], "_time": started,
                          "baselineReason": manifest.get("baselineReason"),
                          "provenance": manifest.get("provenance"),
                          "calibration": calibration, "manifestSHA256": manifest_hash,
                          "manifestSHA256VerifiedAgainstDataset": expected_manifest_hash is not None,
                          "cameras": cameras})
    return candidates, excluded


def make_pairs(candidates, capture_index):
    by_group = {}
    for candidate in candidates:
        calibration = candidate["calibration"]
        if calibration["group"] is None:
            continue
        key = (candidate["split"], calibration["group"])
        by_group.setdefault(key, []).append(candidate)

    sorted_events = capture_index
    pairs = []
    for (split, calibration_group), rows in sorted(by_group.items()):
        rows.sort(key=lambda row: (row["_time"], row["baselineId"]))
        # Adjacent eligible baseline visits are the closest distinct frames in
        # each frozen split/calibration group; never pair identical captures.
        for left, right in zip(rows, rows[1:]):
            gap = (right["_time"] - left["_time"]).total_seconds()
            if gap <= 0:
                raise ValueError("baseline timestamps must be strictly increasing")
            if gap > MAX_GAP_SECONDS:
                continue
            intervening = [event for event in sorted_events
                           if left["_time"] < event["_time"] < right["_time"]]
            throw_count = sum(event["type"] == "throw" for event in intervening)
            takeout_count = sum(event["type"] == "empty-board-baseline" and
                                event["baselineReason"] == "takeout-completed"
                                for event in intervening)
            if throw_count or takeout_count:
                classification = "cross-visit-empty-endpoints"
                continuity = "not-continuous-no-change; intervening throw/takeout capture exists"
            else:
                classification = "same-empty-run-candidate"
                continuity = "no intervening throw/takeout capture found; not continuous occupancy proof"
            for camera in CAMERAS:
                a, b = left["cameras"][camera], right["cameras"][camera]
                if a["imageSHA256"] == b["imageSHA256"]:
                    raise ValueError(f"identical empty-frame images for {left['baselineId']} and {right['baselineId']} camera {camera}")
                pairs.append({"pairId": f"{left['baselineId']}__{right['baselineId']}__cam{camera}",
                    "split": split, "camera": int(camera), "classification": classification,
                    "occupancyLabel": "empty-at-both-capture-endpoints",
                    "continuityClaim": continuity,
                    "sameCalibrationSHA256": left["calibration"]["sha256"],
                    "calibrationGrouping": left["calibration"]["grouping"],
                    "retrospectiveCalibrationGrouping": left["calibration"]["retrospective"],
                    "baselineA": {"captureId": left["baselineId"],
                        "captureStartedAt": left["captureStartedAt"],
                        "baselineReason": left["baselineReason"],
                        "manifestSHA256": left["manifestSHA256"],
                        "manifestSHA256VerifiedAgainstDataset": left["manifestSHA256VerifiedAgainstDataset"], **a},
                    "baselineB": {"captureId": right["baselineId"],
                        "captureStartedAt": right["captureStartedAt"],
                        "baselineReason": right["baselineReason"],
                        "manifestSHA256": right["manifestSHA256"],
                        "manifestSHA256VerifiedAgainstDataset": right["manifestSHA256VerifiedAgainstDataset"], **b},
                    "timeGapSeconds": round(gap, 3),
                    "interveningCaptureCount": len(intervening),
                    "interveningThrowCaptureCount": throw_count,
                    "interveningTakeoutBaselineCount": takeout_count,
                    "sourceProvenance": {"baselineA": left["provenance"],
                                          "baselineB": right["provenance"]}})
    return pairs


def prepare(dataset_path=DEFAULT_DATASET, captures_root=DEFAULT_CAPTURES,
            output_path=DEFAULT_OUTPUT, overwrite=False):
    dataset_path = Path(dataset_path).resolve()
    captures_root = Path(captures_root).resolve()
    dataset = strict_json(dataset_path)
    candidates, excluded = candidate_baselines(dataset, captures_root)
    capture_index = load_capture_index(captures_root)
    pairs = make_pairs(candidates, capture_index)
    output = Path(output_path)
    if not output.is_absolute():
        output = ROOT / output
    if output.exists() and not overwrite:
        raise FileExistsError(f"{output} exists; pass --overwrite to replace it")
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {"format": "real-empty-frame-pairs-v1",
        "datasetId": dataset.get("datasetId"),
        "datasetPath": str(dataset_path.relative_to(ROOT)) if dataset_path.is_relative_to(ROOT) else str(dataset_path),
        "datasetSHA256": digest(dataset_path),
        "splitPolicy": "frozen dataset baseline assignment; development and validation only; test excluded",
        "purpose": "challenge-only presence stress set prepared after model training started",
        "pairPolicy": {"maximumTimeGapSeconds": MAX_GAP_SECONDS,
            "adjacentWithinFrozenSplitAndCalibrationGroup": True,
            "requiredEndpointOccupancy": "connected=true, running=true, status=Throw, throws=[] before and after",
            "requiredSceneChangedDuringCapture": False,
            "testImagesReadOrIncluded": False,
            "crossVisitPairsAreNotContinuousNoChangeNegatives": True},
        "counts": {"candidateBaselinesBySplit": {
                split: sum(row["split"] == split for row in candidates)
                for split in ("development", "validation")},
            "excludedBaselines": len(excluded),
            "distinctBaselinePairLinksBySplitAndClass": {split: {
                classification: len({(p["baselineA"]["captureId"], p["baselineB"]["captureId"])
                    for p in pairs if p["split"] == split and p["classification"] == classification})
                for classification in ("same-empty-run-candidate", "cross-visit-empty-endpoints")}
                for split in ("development", "validation")},
            "pairsBySplitAndClass": {split: {
                classification: sum(p["split"] == split and p["classification"] == classification for p in pairs)
                for classification in ("same-empty-run-candidate", "cross-visit-empty-endpoints")}
                for split in ("development", "validation")},
            "distinctBaselineIds": len({p["baselineA"]["captureId"] for p in pairs} |
                                       {p["baselineB"]["captureId"] for p in pairs})},
        "excludedBaselines": excluded, "pairs": pairs}
    output.write_text(json.dumps(manifest, indent=2, sort_keys=True, allow_nan=False) + "\n")
    print(json.dumps({"output": str(output), "counts": manifest["counts"]}, indent=2))
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--captures", type=Path, default=DEFAULT_CAPTURES)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--overwrite", action="store_true",
                        help="replace the selected output manifest if it already exists")
    args = parser.parse_args()
    try:
        prepare(args.dataset, args.captures, args.output, args.overwrite)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
