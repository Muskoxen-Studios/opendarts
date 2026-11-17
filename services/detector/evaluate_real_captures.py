"""Offline image-only diagnostics for locally captured real-board JPEGs.

Requires ffmpeg for JPEG-to-gray conversion. Reported throws/positions are
metadata only and are never passed to the detector functions below.
"""

import argparse
import hashlib
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
from parameters import DEFAULT_PARAMETERS, DetectionParameters  # noqa: E402
from rendered import changed_pixels, shaft_candidates  # noqa: E402


def gray(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vf", "format=gray", "-f", "rawvideo", "-"],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ).stdout
    # The capture service currently stores 1280x720. Refuse implicit resizing.
    if len(raw) != 1280 * 720:
        raise ValueError(f"expected 1280x720 grayscale, got {len(raw)} bytes")
    return raw


def load_params(path):
    return DetectionParameters(**json.loads(path.read_text())) if path else DEFAULT_PARAMETERS


_GRAY_CACHE = {}


def cached_gray(path):
    path = str(path)
    if path not in _GRAY_CACHE:
        _GRAY_CACHE[path] = gray(Path(path))
    return _GRAY_CACHE[path]


def analyze_capture(manifest_path, baseline_path, params, previous_path=None):
    m = json.loads(manifest_path.read_text())
    result = {"captureId": m["captureId"], "type": m.get("type"), "cameras": {}, "reportedOccupancyCount": len((m.get("reportedOccupancyAfter") or {}).get("throws", []))}
    if m.get("status") != "complete" or m.get("sceneChangedDuringCapture"):
        result["status"] = "skipped_incomplete_or_scene_changed"
        return result
    bm = json.loads(baseline_path.read_text()) if baseline_path else None
    if m.get("type") == "throw" and (bm is None or m.get("baselineForThrow") != bm.get("captureId") or
            bm.get("status") != "complete" or bm.get("type") != "empty-board-baseline" or
            bm.get("sceneChangedDuringCapture") or
            not (bm.get("reportedOccupancyAfter") or {}).get("running") or
            len((bm.get("reportedOccupancyAfter") or {}).get("throws", [])) != 0):
        result["status"] = "skipped_missing_or_mismatched_baseline"
        return result
    result["baselineId"] = bm["captureId"] if bm else None
    result["previousOccupancyId"] = previous_path.parent.name if previous_path else None
    result["status"] = "analyzed"
    for camera in range(3):
        key = f"camera-{camera}"
        raw_diff = None
        try:
            image_path = manifest_path.parent / f"{key}.jpg"
            frame = cached_gray(image_path)
            if m["type"] == "empty-board-baseline":
                result["cameras"][str(camera)] = {"status": "baseline", "sha256": hashlib.sha256(image_path.read_bytes()).hexdigest()}
                continue
            ref_path = (previous_path or baseline_path).parent / f"{key}.jpg"
            ref = cached_gray(ref_path)
            threshold = params.difference_threshold_gray
            changed = [i for i, (a, b) in enumerate(zip(frame, ref)) if abs(a-b) >= threshold]
            result["cameras"].setdefault(str(camera), {})
            border = sum(i % 1280 in (0, 1279) or i // 1280 in (0, 719) for i in changed)
            raw_diff = {"thresholdedPixels": len(changed), "fraction": round(len(changed)/(1280*720), 6), "borderPixels": border}
            pixels = changed_pixels(frame, ref, 1280, 720, params)
            candidates = shaft_candidates(pixels, parameters=params)
            lines = []
            for line, support in candidates:
                lines.append({"normal": [round(line[0], 5), round(line[1], 5)],
                              "offsetPx": round(line[2], 2), "supportLengthPx": round(support[1], 1)})
            result["cameras"][str(camera)] = {"status": "candidates", "rawDifference": raw_diff, "changedPixels": len(pixels), "candidateCount": len(lines), "candidates": lines}
        except (ValueError, subprocess.CalledProcessError, OSError) as exc:
            result["cameras"][str(camera)] = {"status": "rejected", "rawDifference": raw_diff, "reason": str(exc)[:180]}
    result["candidateAvailability"] = sum(c.get("status") == "candidates" and c.get("candidateCount", 0) > 0 for c in result["cameras"].values())
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--captures", type=Path, default=ROOT / "data/board-captures")
    parser.add_argument("--output", type=Path, default=ROOT / "build/real-captures-evaluation")
    args = parser.parse_args()
    manifests = sorted(args.captures.glob("*/manifest.json"), key=lambda p: p.parent.name)
    frozen_ids = [p.parent.name for p in manifests]
    by_id = {p.parent.name: p for p in manifests}
    profiles = {"led-ring": load_params(HERE / "led-ring.parameters.json")}
    reports = {}
    for profile, params in profiles.items():
        results = []
        ordered_throw_meta = []
        for path in manifests:
            mm = json.loads(path.read_text())
            if mm.get("type") == "throw" and mm.get("status") == "complete" and not mm.get("sceneChangedDuringCapture"):
                ordered_throw_meta.append((path, mm))
        for index, path in enumerate(manifests, 1):
            m = json.loads(path.read_text())
            baseline = by_id.get(m.get("baselineForThrow")) if m.get("type") == "throw" else None
            if m.get("type") == "empty-board-baseline":
                results.append({"captureId": m["captureId"], "type": m["type"], "status": "baseline_reference_only"})
            else:
                current_throws = (m.get("reportedOccupancyAfter") or {}).get("throws", [])
                occupancy_count = len(current_throws)
                previous = None
                if occupancy_count > 1:
                    prior = [(candidate_path, candidate) for candidate_path, candidate in ordered_throw_meta
                             if candidate.get("baselineForThrow") == m.get("baselineForThrow")
                             and candidate_path.parent.name < path.parent.name
                             and len((candidate.get("reportedOccupancyAfter") or {}).get("throws", [])) == occupancy_count-1
                             and (candidate.get("reportedOccupancyAfter") or {}).get("throws") == current_throws[:-1]]
                    if prior:
                        previous = prior[-1][0]
                if occupancy_count > 1 and previous is None:
                    results.append({"captureId": m["captureId"], "type": m.get("type"), "status": "skipped_no_matching_prior_occupancy"})
                else:
                    results.append(analyze_capture(path, baseline, params, previous))
            if index % 10 == 0:
                print(f"{profile}: {index}/{len(manifests)} manifests", flush=True)
        reports[profile] = results
    args.output.mkdir(parents=True, exist_ok=True)
    report = {"format": "real-capture-diagnostic-v1", "dimensions": [1280, 720], "captureIds": frozen_ids,
              "implementationSha256": {"script": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                                        "rendered.py": hashlib.sha256((HERE / "rendered.py").read_bytes()).hexdigest(),
                                        "parameters.py": hashlib.sha256((HERE / "parameters.py").read_bytes()).hexdigest(),
                                        "led-ring.parameters.json": hashlib.sha256((HERE / "led-ring.parameters.json").read_bytes()).hexdigest()},
              "captureCount": len(manifests), "profiles": reports,
              "limitations": ["No per-camera pinhole intrinsics/extrinsics were recorded, so image lines cannot be triangulated into board x/y positions.",
                             "Reported Autodarts positions are metadata only and were not used by candidate extraction.",
                             "JPEG decoding and thresholded shaft candidates are a diagnostic only, not native event acceptance or accuracy."]}
    (args.output / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = ["# Real board capture diagnostic", "", f"Frozen snapshot: {len(manifests)} capture manifests ({frozen_ids[0] if frozen_ids else 'none'} through {frozen_ids[-1] if frozen_ids else 'none'}).", "",
                             "The script uses the current LED-ring parameter profile. It decodes each throw JPEG, compares it with the prior same-baseline occupancy frame (or the linked empty baseline for occupancy 1), and runs the current per-camera changed-pixel and shaft-candidate routines. Reported occupancy counts only select the prior frame; position labels and reported segments are excluded from extraction. Raw thresholded pixel and image-border differences are retained even when the existing detector gate rejects a frame.", "",
             "## Results", ""]
    for name, results in reports.items():
        status_counts = Counter(x["status"] for x in results)
        throws = [x for x in results if x.get("status") == "analyzed" and x.get("type") == "throw"]
        triplets = sum(x.get("candidateAvailability") == 3 for x in throws)
        anycam = sum(x.get("candidateAvailability", 0) > 0 for x in throws)
        camera_rejections = Counter(c.get("reason", c.get("status")) for x in throws for c in x.get("cameras", {}).values() if c.get("status") != "candidates")
        lines += [f"### {name}", "", f"- Manifest status: {dict(status_counts)}", f"- Throws analyzed: {len(throws)}; candidates in all three cameras: {triplets}; candidates in at least one camera: {anycam}.", f"- Per-camera rejections: {dict(camera_rejections)}", ""]
    lines += ["## Limits", "", "No camera calibration was captured with these JPEGs, and the board calibration endpoint returned no matrices. Therefore this run cannot compare reconstructed board positions or claim score accuracy. Candidate availability is weaker than detector acceptance: it omits cross-view triangulation, shaft correspondence, physical-envelope checks, temporal stability and protocol event generation. See `results.json` for every frozen capture ID and per-camera candidate line.", "", "Reproduce from the repository root with `python3 services/detector/evaluate_real_captures.py` (requires `ffmpeg`)."]
    (args.output / "REPORT.md").write_text("\n".join(lines) + "\n")
    print(f"Wrote {args.output / 'REPORT.md'} and results.json ({len(manifests)} captures)")


if __name__ == "__main__":
    main()
