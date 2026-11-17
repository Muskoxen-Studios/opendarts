# Bundled camera model

`presence-v6.pt` is the selected output from `build/real-presence-model-v6/model.pt`.
SHA-256: `bc5b45538ae8d4308874b910f870aa11d4171ccba500dc2739a4694b045a1588`.
The v6 selection retained the unchanged v4 weights. Training and validation
provenance and limitations are documented in `docs/native-presence-training.md`.
The checkpoint is bundled with the detector and must not be replaced automatically
by a training run.
