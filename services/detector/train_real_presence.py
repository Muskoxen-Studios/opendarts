"""Fine-tune only the v3 spatial presence head with captured empty-board pairs.

The encoder and localization heatmap remain frozen. All checkpoint selection and
predictions use development/validation material; test images are never opened.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
import training_data as base
import training_localizer as trainer
import evaluate_empty_pairs as evaluator

DEFAULT_MODEL = ROOT / 'build/real-keypoint-model-v3/model.pt'
DEFAULT_TARGETS = ROOT / 'build/real-keypoints-retrospective-v1/targets.json'
DEFAULT_MANIFEST = ROOT / 'build/real-empty-pairs-v1-final/manifest.json'
DEFAULT_OUTPUT = ROOT / 'build/real-presence-model-v1'
DEFAULT_VISIBILITY = ROOT / 'data/board-captures/_visibility'


def fail_if_nonfinite(name, value):
    trainer.require_finite(name, value)


def empty_pair_rows(manifest, source_dataset):
    groups = {'development': [], 'validation': []}
    for pair in manifest['pairs']:
        split = pair.get('split')
        if split not in groups:
            continue
        if pair.get('occupancyLabel') != 'empty-at-both-capture-endpoints':
            raise ValueError(f"{pair.get('pairId')}: unsupported occupancy label")
        a, b = pair['baselineA'], pair['baselineB']
        expected_split = source_dataset.get('frozenSplitByBaseline', {})
        if any(expected_split.get(ep['captureId']) != split for ep in (a, b)):
            raise ValueError(f"{pair['pairId']}: baseline endpoints do not match frozen split")
        verified = []
        for endpoint in (a, b):
            expected_manifest = endpoint.get('manifestSHA256')
            manifest_path = ROOT / 'data/board-captures' / endpoint['captureId'] / 'manifest.json'
            if expected_manifest:
                actual_manifest = evaluator.sha256(manifest_path)
                if actual_manifest != expected_manifest:
                    raise ValueError(f"{pair['pairId']}: capture manifest hash mismatch")
            image_path = evaluator.resolve_image(endpoint['imagePath'])
            if evaluator.sha256(image_path) != endpoint.get('imageSHA256'):
                raise ValueError(f"{pair['pairId']}: endpoint image hash mismatch")
            verified.append(endpoint)
        # The trainer's current/reference convention is newest/oldest.
        groups[split].append({'id': pair['pairId'], 'kind': 'real-empty', 'label': 0,
            'imagePath': b['imagePath'], 'imageSHA256': b['imageSHA256'],
            'referenceImagePath': a['imagePath'], 'referenceImageSHA256': a['imageSHA256'],
            'classification': pair['classification'], 'baselineA': a['captureId'],
            'baselineB': b['captureId'], 'continuityClaim': pair['continuityClaim']})
    return groups


def load_visibility_exclusions(directory, samples):
    excluded = {}
    by_capture = {}
    for row in samples:
        if row['split'] in ('development', 'validation'):
            by_capture.setdefault(row['captureId'], []).append(row)
    for capture_id, rows in by_capture.items():
        path = directory / f'{capture_id}.json'
        if not path.is_file():
            continue
        note = evaluator.strict_json(path)
        if note.get('captureId') != capture_id or note.get('excludeFromPositiveTraining') is not True:
            continue
        reason = note.get('reason')
        if reason not in ('no-visible-dart-all-cameras', 'contaminated-reference'):
            raise ValueError(f'{path}: unsupported visibility exclusion reason')
        expected = note.get('imageSHA256')
        if not isinstance(expected, dict):
            raise ValueError(f'{path}: imageSHA256 map is required')
        seen = {}
        for row in rows:
            camera = str(row['camera'])
            previous = seen.setdefault(camera, row.get('imageSHA256'))
            if previous != row.get('imageSHA256'):
                raise ValueError(f'{capture_id}: inconsistent target image hashes for camera {camera}')
        if set(expected) != set(seen):
            raise ValueError(f'{path}: visibility hash cameras do not match frozen target samples')
        if expected != seen:
            raise ValueError(f'{path}: visibility image hashes do not match frozen target samples')
        record = {'reason': reason, 'cameraCount': len(seen),
                  'sampleCount': len(rows), 'annotationSHA256': evaluator.sha256(path)}
        if reason == 'contaminated-reference':
            reference_id = note.get('referenceCaptureId')
            reference_hashes = note.get('referenceImageSHA256')
            if not isinstance(reference_id, str) or not isinstance(reference_hashes, dict) or set(reference_hashes) != {'0', '1', '2'}:
                raise ValueError(f'{path}: referenceCaptureId and three referenceImageSHA256 values are required')
            for camera, digest in reference_hashes.items():
                if not isinstance(digest, str) or len(digest) != 64 or any(ch not in '0123456789abcdef' for ch in digest):
                    raise ValueError(f'{path}: invalid reference camera {camera} SHA-256')
            if any(row.get('previousFrameCaptureId') != reference_id for row in rows):
                raise ValueError(f'{path}: target previousFrameCaptureId does not match referenceCaptureId')
            seen_ref = {str(row['camera']): row.get('previousFrameImageSHA256') for row in rows}
            if set(seen_ref) != {'0', '1', '2'} or seen_ref != reference_hashes:
                raise ValueError(f'{path}: reference hashes do not match frozen target samples')
            record.update({'referenceCaptureId': reference_id,
                           'referenceImageSHA256': reference_hashes})
        excluded[capture_id] = record
    return excluded


def build_rows(targets, allow_retrospective, model_meta, manifest, source_dataset, visibility_directory):
    data, samples = base.load_samples(targets, allow_retrospective)
    base.validate_split_isolation(samples)
    original_dev_val = [r for r in samples if r['split'] in ('development', 'validation')]
    original_source_hash, _ = base.verify_source_images(original_dev_val)
    if original_source_hash != model_meta.get('sourceImageManifestSHA256'):
        raise ValueError('v3 development/validation image manifest hash mismatch')
    excluded = load_visibility_exclusions(visibility_directory, samples)
    contaminated = {cid: item for cid, item in excluded.items() if item['reason'] == 'contaminated-reference'}
    curated = [r for r in samples if r['captureId'] not in excluded]
    development = [r for r in curated if r['split'] == 'development']
    validation = [r for r in curated if r['split'] == 'validation']
    source_hash, image_count = base.verify_source_images(development + validation)
    challenge = empty_pair_rows(manifest, source_dataset)
    bad_reference_ids = {item['referenceCaptureId'] for item in contaminated.values()}
    challenge = {split: [row for row in rows if row['baselineA'] not in bad_reference_ids and row['baselineB'] not in bad_reference_ids]
                for split, rows in challenge.items()}
    positive_dev = [{**r, 'kind': 'positive', 'label': 1, 'id': r['sampleId']} for r in development]
    positive_val = [{**r, 'kind': 'positive', 'label': 1, 'id': r['sampleId']} for r in validation]
    bad_reference_hashes = {digest for item in contaminated.values()
                            for digest in item.get('referenceImageSHA256', {}).values()}
    def clean_synthetic(row):
        return not row['isPositive'] and row.get('imageSHA256') not in bad_reference_hashes and row.get('referenceImageSHA256') not in bad_reference_hashes
    synthetic_dev = [{**r, 'kind': 'synthetic-empty', 'label': 0, 'id': r['sampleId']}
                     for r in base.add_synthetic_negatives(development) if clean_synthetic(r)][:len(development)]
    synthetic_val = [{**r, 'kind': 'synthetic-empty', 'label': 0, 'id': r['sampleId']}
                     for r in base.add_synthetic_negatives(validation) if clean_synthetic(r)][:len(validation)]
    train = positive_dev + synthetic_dev + challenge['development']
    valid = positive_val + synthetic_val + challenge['validation']
    if not challenge['development'] or not challenge['validation']:
        raise ValueError('challenge requires development and validation real-empty pairs')
    if not positive_dev or not positive_val:
        raise ValueError('positive development and validation rows are required')
    return data, source_hash, image_count, train, valid, excluded


def forward_presence_features(model, features):
    evidence = model.presenceFeatures(features)
    import torch
    pooled = torch.cat((torch.nn.functional.adaptive_max_pool2d(evidence, 1).flatten(1),
                        torch.nn.functional.adaptive_avg_pool2d(evidence, 1).flatten(1)), 1)
    return model.presence(pooled)[:, 0]


def feature_key(row):
    return row['imageSHA256'], row['referenceImageSHA256']


def build_feature_cache(model, rows, image_cache, torch, device, batch_size=8):
    unique = {}
    for row in rows:
        key = feature_key(row)
        unique.setdefault(key, row)
    ordered = list(unique.items())
    result = {}
    model.eval()
    with torch.no_grad():
        for start in range(0, len(ordered), batch_size):
            chunk = ordered[start:start+batch_size]
            pairs = torch.stack([trainer.pair_tensor(torch, image_cache, row) for _, row in chunk]).to(device)
            cur, ref = pairs[:, :3], pairs[:, 3:6]
            x = torch.cat((cur, ref, cur-ref), dim=1)
            features = model.enc3(model.enc2(model.enc1(x)))
            fail_if_nonfinite('cached frozen encoder features', features)
            for (key, _), value in zip(chunk, features):
                result[key] = value.detach().cpu().contiguous()
    print(f'cached {len(result)} frozen encoder feature maps on CPU', flush=True)
    return result


def score(model, rows, features, torch, device, batch_size):
    output = []
    model.eval()
    with torch.no_grad():
        for start in range(0, len(rows), batch_size):
            batch = rows[start:start+batch_size]
            x = torch.stack([features[feature_key(r)] for r in batch]).to(device)
            logits = forward_presence_features(model, x)
            fail_if_nonfinite('validation presence logits', logits)
            probs = torch.sigmoid(logits).cpu().tolist()
            output.extend({'row': r, 'probability': float(p)} for r, p in zip(batch, probs))
    return output


def metrics(scored):
    real = [s for s in scored if s['row']['kind'] == 'real-empty']
    positive = [s for s in scored if s['row']['kind'] == 'positive']
    synthetic = [s for s in scored if s['row']['kind'] == 'synthetic-empty']
    def errors(rows, positive_label):
        wrong = sum((s['probability'] >= .5) != positive_label for s in rows)
        return {'count': len(rows), 'errorsAtHalf': wrong,
                'errorRateAtHalf': wrong/len(rows) if rows else None}
    return {'realEmptyPairs': errors(real, False), 'positivePairs': errors(positive, True),
            'syntheticEmptyPairs': errors(synthetic, False),
            'realFalsePositivesAtHalf': sum(s['probability'] >= .5 for s in real),
            'positiveFalseNegativesAtHalf': sum(s['probability'] < .5 for s in positive),
            'syntheticFalsePositivesAtHalf': sum(s['probability'] >= .5 for s in synthetic)}


def validation_objective(values, loss):
    real_rate = values['realEmptyPairs']['errorRateAtHalf']
    positive_rate = values['positivePairs']['errorRateAtHalf']
    synthetic_rate = values['syntheticEmptyPairs']['errorRateAtHalf']
    return .5*(real_rate+positive_rate)+.1*synthetic_rate + .001*loss


def run(args):
    torch, Image, _ = base.torch_modules()
    torch.set_num_threads(2)
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    model_path, targets_path, manifest_path = (p.resolve() for p in (args.model, args.targets, args.manifest))
    checkpoint, old_meta, manifest, source_dataset = evaluator.load_and_verify(
        torch, model_path, targets_path, manifest_path, args.allow_retrospective_labels)
    if not manifest.get('pairs'):
        raise ValueError('empty-pair manifest has no pairs')
    data, source_hash, image_count, train_rows, validation_rows, visibility_exclusions = build_rows(
        targets_path, args.allow_retrospective_labels, old_meta, manifest, source_dataset,
        args.visibility_directory.resolve())
    output = args.output.resolve()
    if not args.smoke and output.exists() and any(output.iterdir()):
        raise FileExistsError(f'refusing to overwrite nonempty output: {output}')
    use_cuda = args.device == 'cuda' or (args.device == 'auto' and torch.cuda.is_available())
    if args.device == 'cuda' and not torch.cuda.is_available():
        raise RuntimeError('CUDA requested but unavailable')
    device = torch.device('cuda' if use_cuda else 'cpu')
    if use_cuda:
        torch.cuda.set_per_process_memory_fraction(args.cuda_memory_fraction, 0)
    model = trainer.model_class(torch)()
    model.load_state_dict(checkpoint['state_dict'], strict=True)
    frozen_before = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()
                     if not (k.startswith('presenceFeatures.') or k.startswith('presence.'))}
    for name, parameter in model.named_parameters():
        parameter.requires_grad_(name.startswith('presenceFeatures.') or name.startswith('presence.'))
    model.to(device)
    optimizer = torch.optim.Adam([p for p in model.parameters() if p.requires_grad], lr=args.learning_rate)
    image_cache = base.ImageCache(Image, capacity=args.image_cache)
    smoke_selected = [next(r for r in train_rows if r['kind'] == kind)
                      for kind in ('positive', 'synthetic-empty', 'real-empty')]
    cache_rows = smoke_selected if args.smoke else train_rows + validation_rows
    feature_cache = build_feature_cache(model, cache_rows, image_cache,
                                        torch, device, batch_size=8)
    group_counts = {kind: sum(r['kind'] == kind for r in train_rows)
                    for kind in ('positive', 'real-empty', 'synthetic-empty')}
    if any(count == 0 for count in group_counts.values()):
        raise ValueError(f'expected all training groups, got {group_counts}')
    row_weights = {kind: mass*len(train_rows)/group_counts[kind]
                   for kind, mass in (('positive', .5), ('real-empty', .25), ('synthetic-empty', .25))}
    if args.smoke:
        selected = smoke_selected
        smoke_rows = score(model, selected, feature_cache, torch, device, args.batch_size)
        smoke_x = torch.stack([feature_cache[feature_key(r)] for r in selected]).to(device)
        smoke_y = torch.tensor([r['label'] for r in selected], dtype=torch.float32, device=device)
        smoke_logits = forward_presence_features(model, smoke_x)
        smoke_loss = torch.nn.functional.binary_cross_entropy_with_logits(smoke_logits, smoke_y)
        fail_if_nonfinite('smoke loss', smoke_loss)
        optimizer.zero_grad(set_to_none=True); smoke_loss.backward(); optimizer.step()
        for key, old in frozen_before.items():
            if not torch.equal(model.state_dict()[key].detach().cpu(), old):
                raise AssertionError(f'frozen parameter changed during smoke: {key}')
        print(json.dumps({'smoke': 'pass', 'developmentKinds': [s['row']['kind'] for s in smoke_rows],
                          'finiteProbabilities': all(math.isfinite(s['probability']) for s in smoke_rows),
                          'frozenTensorCount': len(frozen_before)}, allow_nan=False))
        return
    if output.exists() and any(output.iterdir()):
        raise FileExistsError(f'refusing to overwrite nonempty output: {output}')
    output.mkdir(parents=True, exist_ok=True)
    history, best_state, best_obj = [], None, float('inf')
    started = time.monotonic()
    for epoch in range(1, args.epochs+1):
        model.train()
        order = list(range(len(train_rows)))
        random.Random(args.seed+epoch).shuffle(order)
        losses=[]
        for start in range(0, len(order), args.batch_size):
            batch = [train_rows[i] for i in order[start:start+args.batch_size]]
            x = torch.stack([feature_cache[feature_key(row)] for row in batch]).to(device)
            labels = torch.tensor([r['label'] for r in batch], dtype=torch.float32, device=device)
            logits = forward_presence_features(model, x)
            fail_if_nonfinite('training presence logits', logits)
            raw = torch.nn.functional.binary_cross_entropy_with_logits(logits.float(), labels, reduction='none')
            weights = torch.tensor([row_weights[row['kind']] for row in batch],
                                   dtype=torch.float32, device=device)
            loss = (raw * weights).mean()
            fail_if_nonfinite('training presence loss', loss)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            for name, parameter in model.named_parameters():
                if parameter.requires_grad and parameter.grad is not None:
                    fail_if_nonfinite(f'gradient {name}', parameter.grad)
            torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad],
                                           5.0, error_if_nonfinite=True)
            optimizer.step()
            losses.append(float(loss.detach()))
        scored = score(model, validation_rows, feature_cache, torch, device, args.batch_size)
        value = metrics(scored)
        val_loss = sum(-(s['row']['label']*math.log(max(1e-8, s['probability'])) +
                         (1-s['row']['label'])*math.log(max(1e-8, 1-s['probability'])))
                        for s in scored) / len(scored)
        objective = validation_objective(value, val_loss)
        if not math.isfinite(objective):
            raise FloatingPointError('non-finite validation objective')
        history_row = {'epoch': epoch, 'trainLossMean': sum(losses)/len(losses),
                       'validationMetrics': value, 'validationBce': val_loss,
                       'selectionObjective': objective}
        history.append(history_row)
        print(f"epoch {epoch}/{args.epochs}: real-empty FP {value['realFalsePositivesAtHalf']}/{value['realEmptyPairs']['count']}, positive FN {value['positiveFalseNegativesAtHalf']}/{value['positivePairs']['count']}, synthetic FP {value['syntheticFalsePositivesAtHalf']}/{value['syntheticEmptyPairs']['count']}", flush=True)
        if objective < best_obj:
            best_obj = objective
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
        base.save_training_state(torch, output/'training-state.pt',
            {'epoch': epoch, 'bestEpoch': min(history, key=lambda h:h['selectionObjective'])['epoch'],
             'bestObjective': best_obj, 'bestState': best_state, 'history': history})
    if best_state is None:
        raise RuntimeError('no finite validation checkpoint selected')
    model.load_state_dict(best_state)
    for key, old in frozen_before.items():
        if not torch.equal(model.state_dict()[key].detach().cpu(), old):
            raise AssertionError(f'frozen parameter changed: {key}')
    final_scores = score(model, validation_rows, feature_cache, torch, device, args.batch_size)
    final_metrics = metrics(final_scores)
    best_epoch = min(history, key=lambda h:h['selectionObjective'])['epoch']
    fine_meta = {**old_meta, 'presenceFineTuned': True,
        'presenceTrainerSHA256': evaluator.sha256(Path(__file__)),
        'warmStartModelSHA256': evaluator.sha256(model_path),
        'realEmptyPairManifestSHA256': evaluator.sha256(manifest_path),
        'presenceFineTuning': {'epochsRequested': args.epochs, 'bestEpoch': best_epoch,
            'selectionObjective': '0.5*(real-empty FP rate + positive FN rate) + 0.1*synthetic FP rate + 0.001*validation BCE',
            'groupsAndTrainingWeights': {'positive': .5, 'realEmpty': .25, 'syntheticEmpty': .25},
            'frozenModules': ['enc1', 'enc2', 'enc3', 'up1', 'up2', 'heat'],
            'trainRows': len(train_rows), 'validationRows': len(validation_rows),
            'device': str(device), 'batchSize': args.batch_size,
            'sourceImageManifestSHA256': source_hash, 'sourceImageCount': image_count,
            'groupsAndTrainingCounts': group_counts,
            'curatedPositiveCaptureCountBySplit': {'development': len({r['captureId'] for r in train_rows if r['kind'] == 'positive'}),
                'validation': len({r['captureId'] for r in validation_rows if r['kind'] == 'positive'})}},
        'presenceValidationMetrics': final_metrics,
        'explicitCaptureExclusions': visibility_exclusions,
        'presenceValidationHistory': history,
        'presenceValidationSplitIsTuningData': True,
        'testSplitInferencePerformed': False}
    output_model = output/'model.pt'
    torch.save({'state_dict': model.state_dict(), 'metadata': fine_meta}, output_model)
    preds = []
    for row in final_scores:
        source = row['row']
        preds.append({'sampleId': source.get('sampleId', source['id']),
            'pairId': source.get('id'), 'split': 'validation', 'kind': source['kind'],
            'isPositive': bool(source['label']), 'presenceProbability': row['probability'],
            'classification': source.get('classification'),
            'continuityClaim': source.get('continuityClaim')})
    report = {'format': 'real-presence-finetuning-v1', 'modelSHA256': evaluator.sha256(output_model),
        'warmStartModelSHA256': evaluator.sha256(model_path),
        'targetsSHA256': evaluator.sha256(targets_path), 'challengeManifestSHA256': evaluator.sha256(manifest_path),
        'validationMetrics': final_metrics, 'bestEpoch': best_epoch,
        'explicitCaptureExclusions': visibility_exclusions,
        'selectionObjective': fine_meta['presenceFineTuning']['selectionObjective'],
        'validationIsTuningData': True, 'testImagesOpenedOrInferred': False,
        'limitations': ['The challenge validation pairs are now tuning data, not an untouched evaluation set.',
            'Empty-pair occupancy is verified at both capture endpoints; cross-visit pairs do not prove uninterrupted occupancy.'],
        'predictions': preds}
    (output/'report.json').write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False)+'\n')
    (output/'history.json').write_text(json.dumps(history, indent=2, sort_keys=True, allow_nan=False)+'\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, default=DEFAULT_MODEL)
    parser.add_argument('--targets', type=Path, default=DEFAULT_TARGETS)
    parser.add_argument('--manifest', type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument('--visibility-directory', type=Path, default=DEFAULT_VISIBILITY)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--epochs', type=int, default=20)
    parser.add_argument('--batch-size', type=int, default=32)
    parser.add_argument('--learning-rate', type=float, default=.001)
    parser.add_argument('--device', choices=('auto','cpu','cuda'), default='auto')
    parser.add_argument('--cuda-memory-fraction', type=float, default=.25)
    parser.add_argument('--image-cache', type=int, default=240)
    parser.add_argument('--seed', type=int, default=17)
    parser.add_argument('--smoke', action='store_true',
                        help='run a disposable head-only optimizer step on development row kinds')
    parser.add_argument('--allow-retrospective-labels', action='store_true',
                        help='required to verify historical keypoint target artifact')
    args = parser.parse_args()
    if args.epochs < 1 or args.batch_size < 1 or args.image_cache < 1:
        parser.error('epochs, batch size and image cache must be positive')
    run(args)


if __name__ == '__main__':
    main()
