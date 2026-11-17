# Board data collector

## Review captures

Run `npm run review:captures` and open <http://127.0.0.1:8092>. The standalone
review app shows the three camera images alongside the board-reported position.
It runs independently of the scoreboard and collector and sends no requests to
the board. Use `CAPTURE_REVIEW_PORT` to choose a different port and
`BOARD_CAPTURE_DIR` to review a different capture directory.

Review decisions are saved as separate JSON sidecars under each capture's
`_reviews/` directory. Original camera images, manifests, and board-reported
positions are preserved. A correction represents a human annotation; it does
not change a match or overwrite the board's report.

The review app starts with a near-edge filter enabled at 3 mm. It keeps throws
whose board-reported position lies within the selected distance of a scoring
boundary; the distance can be adjusted from 0.5 to 15 mm or the filter can be
turned off. Boundaries include the bull, triple and double circles, and the
radial wedge wires across the scoring face. Empty-board baselines are unaffected
by this filter. Captures with missing or non-finite positions remain in the
review queue and are labelled “Position unavailable”; they are never treated as
far from an edge. Filtered throws are excluded from the visible list and review
totals, while the skipped count remains visible.

## Collect data

The optional collector runs independently of the scoreboard and desktop process.
It listens to the same Autodarts event protocol as the bridge, so it can keep
collecting while the app is closed. It retries board discovery and reconnects
after the board or network goes offline.

Set `BOARD_URL` in `.env` (the collector reads it directly) or in the service
environment, then install and enable the user service:

```sh
npm run collector:install
npm run collector:logs
```

Inspect or stop the service with `systemctl --user status darts-board-collector`
and `systemctl --user stop darts-board-collector`. Start it again with
`systemctl --user start darts-board-collector`; use `disable --now` to stop it
and prevent future automatic starts. To keep user services running after logout,
enable lingering once with `loginctl enable-linger "$USER"`.

For a foreground run, use `npm run collector`. By default, captures go under
`data/board-captures`; set `BOARD_CAPTURE_DIR` to choose another directory.
The service writes normal progress to the journal. Logs report online/offline
transitions, each saved capture's absolute path, board segment and coordinates,
and any camera failures.

Each throw gets its own directory with a JSON manifest and up to three original
camera stills. The reported label and position come from the Autodarts board
event, normalized by the bridge adapter into schema millimetres (x right, y up,
origin at the bull). The manifest also records full reported occupancy before
and after image acquisition, where available. It records the collection window
and the request/response times for each image; captures with a missing image are
retained as `partial` records with per-camera errors. Directories appear only
after the manifest and all available images have been written.

The collector reads `GET /api/system` at startup and every minute. It stores only
the response's `calibration` subtree as a content-addressed JSON file under
`_calibrations/`; it does not persist the rest of the system response. Capture
manifests link to the most recently read calibration by hash and relative path,
and record when it was read. A failed read is logged and recorded in subsequent
manifests alongside the last successful calibration, if one exists. Calibration
polling is independent of camera acquisition. Older captures are not assigned a
calibration retroactively.

When the collector confirms detection is running, ready to throw, and the board is connected and empty, it saves an
empty-board baseline and links later throw captures to the latest baseline.
Takeout completion triggers another empty-state check. A disconnect or takeout
clears the current baseline link until an empty board is confirmed again.

Reported occupancy and camera stills can differ in timing. Visual inspection
found hands or remaining darts in some captures whose reported occupancy was
already empty. Stable before/after JSON does not prove that the pixels show a
settled empty board. Review image visibility separately from position accuracy.

The still-image path is inferred from the captured Board Manager UI, which
converts `/api/streams/cams/{0,1,2}` to `/api/img/cams/{0,1,2}` for a still
frame. The stream path and image conversion are visible in the captured UI
bundle, while the exact still endpoint has not yet been verified against the
current board. Camera failures are preserved rather than treated as evidence of
a valid image. The collector does not start or stop detection and does not run
or label results from the native detector.

For an offline check of the current detector's image-difference and shaft-extraction
stages, run `python3 services/detector/evaluate_real_captures.py` (requires
`ffmpeg`). It writes a frozen capture list, per-camera failures and a summary to
`build/real-captures-evaluation/`. This diagnostic does not measure position or
score accuracy: historical captures lack calibration links, and the newer
board calibration exports still need coordinate and pose validation before
reconstructing real board positions. Reported positions
remain comparison labels and are not passed into shaft extraction.

To export a frozen, reviewed real-board dataset for offline evaluation, run
`python3 services/detector/build_real_dataset.py`. It writes
`build/reviewed-real-v1/dataset.json` and `REPORT.md`; rebuilding is deterministic
for an unchanged capture directory. Records retain source manifest hashes,
camera image hashes, linked empty-board references, the prior same-baseline frame
whose full occupancy exactly matches the throw's prefix, and any verified
calibration snapshot. The loader is `load_dataset()` in
`services/detector/build_real_dataset.py`.

Human-confirmed labels use the reviewed coordinates, preserving any manual
correction separately from the board report. Unreviewed labels are included only
when their reported coordinates are more than 3 mm from every scoring boundary;
incorrect, uncertain, missing-position, near-edge, incomplete, unstable, and
unreferenced captures are excluded. The chronological split keeps each baseline
visit together (60% development, 20% validation, 20% test). This is a historical
split, not an untouched unseen test set: earlier experiments used these captures.
Labels remain evaluation metadata and are never supplied to detector extraction.

Explicit all-camera visibility exclusions live separately under
`_visibility/<captureId>.json`. They retain the capture ID, all three current
image hashes, reviewer and reason `no-visible-dart-all-cameras`, with
`excludeFromPositiveTraining: true`. The exporter validates these annotations
before accepting positive labels and records their hashes and provenance.
Stale image hashes fail loudly. This does not change the original score review
or delete captures; historical frozen datasets stay unchanged until explicitly
rebuilt. The presence-training experiment also honors these exclusions.

The same annotations support reason `contaminated-reference`, with
`referenceCaptureId` and three `referenceImageSHA256` values. This excludes the
affected before/after pair and checks both images' hashes. Later throws using
clean prior-throw references remain eligible. Presence training also skips
negative pairs that reuse the flagged reference.
