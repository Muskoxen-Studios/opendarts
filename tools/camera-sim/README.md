# Image-only synthetic camera rig

`rig.py` renders two or three calibrated views of round board-plane tip markers
on a grayscale board with bulls, rings, wires and alternating sectors. The empty
board artwork is also the detector reference, so the differencing threshold stays
unchanged.
The detector receives grayscale pixels, never coordinates or segment truth.
This is not a photorealistic shaft/camera model. See
`services/detector/README.md` for its accuracy and occlusion limitations.

Run the HTTP rig through the detector:

```sh
python3 services/detector/main.py --source synthetic
```

Regenerate the checked-in image-only replay from the repository root:

```sh
python3 tools/camera-sim/generate.py testdata/vision
```

This produces binary PGM acquisition fixtures and a manifest with only image
paths, dimensions and affine calibrations. HTTP camera previews are browser-ready
PNG, not PGM. The sequence contains a stable empty baseline, three separated
safe-interior impacts, partial removal and full removal, each repeated three
frames. Armed HTTP throws during adoption/faults return 409; throws while stopped
remain allowed and are not retrospectively scored. Near-wire images trigger a
reset-required review rather than a guessed score.
