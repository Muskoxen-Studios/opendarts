# LED-ring detection experiment — 2026-11-14

Implemented twelve sampled LED sources with cast shadows and ambient fill, plus 4× camera-target antialiasing. Dimensions and light output remain representative. The earlier bright debug images were amplified differences, not scene brightness.

Generated 72 cases / 249 steps, including independent boundary scenes on both sides of radial and angular wires. Labels remain offline. The boundary-only search ran 16 trials, reevaluating the previous candidate; trial 1 won. Its only change from the previous candidate is difference_threshold_gray: 2 → 8. Full-corpus validation and the following held-out evaluation did not change selection.

| Split | Correct required nonempty steps | Wrong acceptances | Mean accepted localization |
| --- | --- | --- | --- |
| Train | 9/23 | 0 | 0.242 mm |
| Validation | 7/15 | 0 | 0.187 mm |
| Held-out test | 3/15 | 0 | 1.013 mm |

The previous candidate accepted 0/23 required nonempty training steps under the new ring lighting. These are complete occupancy steps, including removal/repeat steps, not per-dart recall. Localization excludes rejected scenes. Many cases still reject; this is not evidence of hardware accuracy or a general improvement over the historical unshadowed corpus. The new renderer is a harder experiment, and existing parameter files are not validated for it. Detector defaults have not been changed.

Artifacts (local, ignored by git):

- `build/rendered-ring-v5/dataset.json`: complete small corpus.
- `build/rendered-ring-v5/initial-train.json`, `initial-validation.json`, `held-out.json`: complete reports including original failure reasons and boundary-distance buckets.
- `build/rendered-ring-v5-small/tuning.json`: 16-trial boundary search with provenance and RNG checkpoint.
- `build/rendered-ring-v5-small/candidate.json`: validated plain parameter object for explicit experimental startup.
- `build/test-rendered/reference-dart.png`: normal scene preview.

Follow-up checkpoint (2026-11-16): a fallback now separates disconnected transverse intervals when the original shaft fit finds no candidates. With the threshold-8 candidate it accepts 13/23 required training steps and 7/15 validation steps, with zero wrong acceptances. Generic detector defaults retain threshold 2; development desktop startup explicitly loads `services/detector/led-ring.parameters.json`. Neither scoring uncertainty nor occupancy safeguards were relaxed.

The actual default-mount WebGL smoke still rejects its first dart at (0, 102) with “no resolvable narrow shaft run,” despite 94 Python detector tests and 10 desktop tests passing. The live issue remains unresolved. The generated corpus used different camera mountings from the desktop default (260 mm radius, 220 mm forward, 60° rotation), so these offline results cannot establish default-scene acceptance. Investigate the actual default frames and add that mounting to training regressions before treating the lighting change as ready. The held-out set is now consumed; use fresh independent scenes for future generalization claims.

Validation: npm run check (774 tests plus typechecking), Python detector suite (90 tests with localhost access), scenario tests, real WebGL preview generation, complete corpus generation and verified cache reuse. No live match was used.
