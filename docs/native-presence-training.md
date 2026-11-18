# Offline real-camera presence training

Earlier training experiments are available in Git history. The current trainer uses shared training modules and requires the historical datasets and v4 teacher checkpoint.

`train_real_presence_v6.py` adds a 0.1-weight logit MSE penalty against the frozen
v4 teacher on **historical development examples only**, using deterministic
evaluation-mode logits with student gradients enabled. It updates the same
presence branch, keeps the localizer frozen, and uses one declared AdamW setting:
learning rate 0.0001, weight decay 0.001, seed 17, 40 epochs, batch size 32.
Checkpoint selection rejects any epoch that worsens positive misses or
real-negative false positives on either validation cohort compared with v4.
Epoch zero remains selectable. The threshold stays at 0.5.

```sh
build/detector-training-env/bin/python services/detector/train_real_presence_v6.py \
  --allow-retrospective-labels --device cpu --smoke
build/detector-training-env/bin/python services/detector/train_real_presence_v6.py \
  --allow-retrospective-labels --device cuda --cuda-memory-fraction .25 \
  --output build/real-presence-model-v6
```

Use a new output path for repetitions. The exact v6 trainer is snapshotted under
`build/real-presence-session-v6/sources/` before GPU execution. The reserved test
is reviewed only after checkpoint selection, then evaluated once using
`evaluate_presence_expansion.py` with a freeze file binding checkpoint, manifest,
review, and fixed threshold. Its optional unanimous-camera segment diagnostic
reports scoring coverage separately from presence coverage; it is not connected
to live acceptance. These remain observations from one board and capture session,
not evidence across diverse physical setups or continuous hand/takeout sequences.
