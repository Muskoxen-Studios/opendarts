"""Offline foreground diagnostics for captured board JPEGs; never used by service."""

import argparse
import base64
import hashlib
import json
import math
import statistics
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
from parameters import DetectionParameters  # noqa: E402
from rendered import shaft_candidates  # noqa: E402

W, H = 1280, 720
ROIS = [(369, 217, 597, 364), (357, 224, 643, 401), (301, 136, 600, 359)]
CACHE = {}
PARAMETERS = DetectionParameters(**json.loads((HERE / "led-ring.parameters.json").read_text()))


def gray(path):
    path = str(path)
    if path not in CACHE:
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vf", "format=gray", "-f", "rawvideo", "-"],
                             check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
        if len(raw) != W * H:
            raise ValueError(f"expected {W}x{H} grayscale, got {len(raw)} bytes")
        CACHE[path] = raw
    return CACHE[path]


def median(values):
    return int(statistics.median(values)) if values else 0


def foreground(frame, ref, camera, threshold=8):
    """Remove robust uniform exposure offset estimated within saved board ROI."""
    x, y, w, h = ROIS[camera]
    # Subsample spatially to avoid letting textured board pixels dominate runtime.
    offsets = [frame[j * W + i] - ref[j * W + i]
               for j in range(y, y + h, 3) for i in range(x, x + w, 3)]
    offset = median(offsets)
    diff = bytearray(W * H)
    for idx, (a, b) in enumerate(zip(frame, ref)):
        residual = abs((a - b) - offset)
        if residual >= threshold:
            diff[idx] = 1
    return diff, offset


def components(mask, minimum=8):
    """Run-length connected components across the full image, without ROI clipping."""
    runs, parent, sizes = [], [], []
    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    def union(a, b):
        a, b = root(a), root(b)
        if a != b:
            if sizes[a] < sizes[b]: a, b = b, a
            parent[b] = a
            sizes[a] += sizes[b]
    previous = []
    for y in range(H):
        start, row_runs, x = y * W, [], 0
        while x < W:
            pos = mask.find(1, start + x, start + W)
            if pos < 0: break
            x0 = pos - start
            end = mask.find(0, pos, start + W)
            x1 = (end if end >= 0 else start + W) - start - 1
            idx = len(runs)
            runs.append((y, x0, x1)); parent.append(idx); sizes.append(x1 - x0 + 1)
            for prun, px0, px1 in previous:
                if px0 > x1 + 1: break
                if px1 >= x0 - 1: union(idx, prun)
            row_runs.append((idx, x0, x1)); x = x1 + 1
        previous = row_runs
    groups = {}
    for idx, run in enumerate(runs):
        r = root(idx)
        if sizes[r] >= minimum: groups.setdefault(r, []).append(run)
    result = []
    for group in groups.values():
        x0 = min(r[1] for r in group); x1 = max(r[2] for r in group)
        y0 = min(r[0] for r in group); y1 = max(r[0] for r in group)
        if math.hypot(x1 - x0, y1 - y0) < PARAMETERS.min_shaft_length_px: continue
        if x0 == 0 or y0 == 0 or x1 == W - 1 or y1 == H - 1: continue
        result.append([(x + .5, y + .5) for y, a, b in group for x in range(a, b + 1)])
    return result


def write_pgm(path, mask):
    path.write_bytes(f"P5\n{W} {H}\n255\n".encode() + bytes(255 if v else 0 for v in mask))


def write_overlay(path, candidates, source):
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
             f'<image href="data:image/jpeg;base64,{base64.b64encode(source.read_bytes()).decode()}" width="{W}" height="{H}"/>']
    for (a, b, c), (center, length) in candidates[:8]:
        offset = a * center[0] + b * center[1] + c
        cx, cy = center[0] - a * offset, center[1] - b * offset
        x0, y0 = cx + b * length / 2, cy - a * length / 2
        x1, y1 = cx - b * length / 2, cy + a * length / 2
        parts.append(f'<line x1="{x0:.2f}" y1="{y0:.2f}" x2="{x1:.2f}" y2="{y1:.2f}" stroke="#ff3344" stroke-width="2"/>')
    parts.append('</svg>')
    path.write_text('\n'.join(parts))


def analyze(manifests, out, block_limit):
    by_id = {m["captureId"]: (path, m) for path, m in manifests}
    valid = [(path, m) for path, m in manifests if m.get("type") == "throw" and m.get("status") == "complete"
             and not m.get("sceneChangedDuringCapture") and m.get("baselineForThrow") in by_id]
    # Keep all frames from one baseline group in one partition; evaluate the latest fifth as held out.
    groups = sorted({m["baselineForThrow"] for _, m in valid})[-block_limit:]
    valid = [(p, m) for p, m in valid if m["baselineForThrow"] in groups]
    held = set(groups[max(0, int(len(groups) * .8)):])
    results = []
    for n, (path, m) in enumerate(valid, 1):
        count = len((m.get("reportedOccupancyAfter") or {}).get("throws", []))
        prior = by_id[m["baselineForThrow"]][0]
        baseline_manifest = by_id[m["baselineForThrow"]][1]
        baseline_occ = baseline_manifest.get("reportedOccupancyAfter") or {}
        if (baseline_manifest.get("status") != "complete" or baseline_manifest.get("type") != "empty-board-baseline"
                or baseline_manifest.get("sceneChangedDuringCapture") or baseline_occ.get("throws")
                or not baseline_occ.get("running")):
            continue
        if count > 1:
            target = (m.get("reportedOccupancyAfter") or {}).get("throws", [])[:-1]
            candidates = [(p, q) for p, q in valid if q.get("baselineForThrow") == m["baselineForThrow"]
                          and p.parent.name < path.parent.name
                          and len((q.get("reportedOccupancyAfter") or {}).get("throws", [])) == count - 1
                          and (q.get("reportedOccupancyAfter") or {}).get("throws", []) == target]
            if not candidates:
                continue
            prior = candidates[-1][0]
        row = {"captureId": m["captureId"], "block": m["baselineForThrow"],
               "split": "heldout" if m["baselineForThrow"] in held else "development", "cameras": {}}
        for cam in range(3):
            try:
                image_path = path.parent / f"camera-{cam}.jpg"
                frame = gray(image_path)
                ref = gray(prior.parent / f"camera-{cam}.jpg")
                mask, offset = foreground(frame, ref, cam)
                raw_count = sum(mask)
                blobs = components(mask)
                candidates = []
                for blob in blobs:
                    try:
                        candidates.extend(shaft_candidates(blob, parameters=PARAMETERS))
                    except ValueError:
                        pass
                candidates.sort(key=lambda candidate: candidate[1][1], reverse=True)
                row["cameras"][str(cam)] = {"offsetGray": offset, "foregroundPixels": raw_count,
                    "componentCountMin8": len(blobs), "rawCandidateCount": len(candidates),
                    "topCandidates": [{"line": [a, b, c], "supportCenter": s[0], "supportPx": s[1]}
                                      for (a, b, c), s in candidates[:PARAMETERS.max_candidates]]}
                if m["baselineForThrow"] in held:
                    d = out / "masks" / m["captureId"]
                    d.mkdir(parents=True, exist_ok=True)
                    write_pgm(d / f"camera-{cam}.pgm", mask)
                    write_overlay(d / f"camera-{cam}.svg", candidates[:PARAMETERS.max_candidates], image_path)
            except (OSError, ValueError, subprocess.CalledProcessError) as exc:
                row["cameras"][str(cam)] = {"error": str(exc)[:160]}
        row["proposalViews"] = sum(c.get("rawCandidateCount", 0) > 0 for c in row["cameras"].values())
        results.append(row)
        if n % 10 == 0 or n == 1 or n == len(valid):
            print(f"{n}/{len(valid)} throws", flush=True)
    return results, len(groups)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--captures", type=Path, default=ROOT / "data/board-captures")
    parser.add_argument("--output", type=Path, default=ROOT / "build/real-foreground")
    parser.add_argument("--blocks", type=int, default=6, help="latest chronological baseline blocks to inspect")
    args = parser.parse_args()
    manifests = []
    for path in sorted(args.captures.glob("*/manifest.json")):
        try:
            manifests.append((path, json.loads(path.read_text())))
        except (OSError, ValueError):
            continue
    args.output.mkdir(parents=True, exist_ok=True)
    rows, group_count = analyze(manifests, args.output, max(1, args.blocks))
    report = {"format": "real-foreground-diagnostic-v1", "dimensions": [W, H],
              "captureCount": len(manifests), "captureIds": [m["captureId"] for _, m in manifests],
              "throwCount": len(rows), "baselineGroups": group_count,
              "thresholdGray": PARAMETERS.difference_threshold_gray, "illumination": "subtract median signed frame-reference offset sampled every 3 px inside saved camera board ROI",
              "components": "8-connected run components over full frame; no ROI clipping; skip too-short or frame-edge components",
              "implementationSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "throws": rows,
              "limitations": ["Candidates are image-line hypotheses, not reconstructed positions or accepted events.",
                             "Group split is chronological baseline-block holdout, not independent camera/visit calibration.",
                             "No threshold tuning or synthetic data was used."]}
    (args.output / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = ["# Real foreground extraction diagnostic", "", f"{len(manifests)} manifests; {len(rows)} analyzed throws across {group_count} baseline blocks. Entire chronological blocks assigned to development or heldout.", "",
             "Foreground uses the saved camera ROIs only to estimate a robust signed exposure offset. The corrected difference is thresholded at the existing LED-ring profile value; connected components span the whole image, so shafts are not clipped to board ROIs. Components below 8 pixels and components that cannot meet the configured minimum shaft length or touch the image edge are skipped. Existing line geometry runs unchanged. Labels select reference frames, prior occupancy and split groups only.", "",
             "## Availability", ""]
    for split in ("development", "heldout"):
        subset = [r for r in rows if r["split"] == split]
        pixels = [c["foregroundPixels"] for r in subset for c in r["cameras"].values() if "foregroundPixels" in c]
        lines.append(f"- {split}: {len(subset)} throws; at least one camera produced a raw line proposal for {sum(r['proposalViews'] > 0 for r in subset)}; all 3 views {sum(r['proposalViews'] == 3 for r in subset)}; median foreground pixels per view {statistics.median(pixels):.0f}. This is not usable detection coverage: proposals are unvalidated and many are noise.")
    lines += ["", "Heldout PGM masks and SVG overlays (source JPEG plus top ranked raw proposals) are under `masks/`; per-camera proposals and offsets are in `results.json`. Manual review of a heldout camera-0 overlay found top proposals following board spokes/wire structure instead of the dart shaft, while the mask contains broad board-texture noise. Raw proposal availability is not usable detector coverage. These diagnostics do not modify defaults or call board controls.", ""]
    (args.output / "REPORT.md").write_text("\n".join(lines))
    print(f"Wrote {args.output / 'REPORT.md'}")


if __name__ == "__main__":
    main()
