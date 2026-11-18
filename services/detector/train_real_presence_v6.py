"""Fine-tune the V4 presence branch with hard old/new validation retention guards.

V6 warms from V4, updates only presenceEvidence/presenceCorrection, and distills
old-development logits from the frozen V4 teacher. The reserved new-test rows
are never loaded. Epoch 0 V4 remains a selectable candidate.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
import training_data as base
import training_localizer as localizer
import training_presence_data as metrics_lib
import training_presence_model as v4
import evaluate_empty_pairs as evaluator

DEFAULT_MODEL = ROOT / 'build/real-presence-model-v4/model.pt'
DEFAULT_TARGETS = ROOT / 'build/real-keypoints-retrospective-v1/targets.json'
DEFAULT_OLD_MANIFEST = ROOT / 'build/real-empty-pairs-v1-final/manifest.json'
DEFAULT_EXPANSION = ROOT / 'build/real-presence-expansion-v1/development-validation-rows.json'
DEFAULT_REVIEW = ROOT / 'build/real-presence-expansion-v1/review-dev-validation.json'
DEFAULT_OUTPUT = ROOT / 'build/real-presence-model-v6'
MASS = {'positive': .5, 'real-empty': .4, 'synthetic-empty': .1}
NEW_PREFIXES = ('presenceEvidence.', 'presenceCorrection.')


def model_class(torch):
    return v4.model_class(torch)


def load_model(torch, checkpoint):
    return v4.load_model(torch, checkpoint)


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _image_record(row, name):
    value = row.get(name)
    if not isinstance(value, dict) or not value.get('path') or not value.get('sha256'):
        raise ValueError(f"{row.get('rowId')}: {name} image path and SHA-256 are required")
    return value


def build_new_rows(manifest_path, review_path, verify_images=True):
    """Build development/validation rows only; never dereference reserved test fields."""
    manifest_path, review_path = Path(manifest_path), Path(review_path)
    manifest = json.loads(manifest_path.read_text())
    review = json.loads(review_path.read_text())
    if review.get('status') != 'development_validation_reviewed':
        raise ValueError('development/validation review is not complete')
    if (review.get('rowsSHA256') != sha256(manifest_path) or
            review.get('sourceManifestSHA256') != manifest.get('sourceManifestSHA256')):
        raise ValueError('review does not bind the development/validation projection')
    expected_counts = {'development': {'positiveRows': 450, 'emptyEndpointRows': 147},
                       'validation': {'positiveRows': 153, 'emptyEndpointRows': 48}}
    if manifest.get('counts', {}).get('rowsBySplit') != expected_counts:
        raise ValueError('expansion projection split counts changed')
    decisions = {}
    for item in review.get('decisions', []):
        row_id = item.get('rowId')
        if not row_id or row_id in decisions:
            raise ValueError(f'duplicate or missing reviewed rowId: {row_id}')
        decisions[row_id] = item

    groups = {'development': [], 'validation': []}
    accepted_ids = set()
    # Split is the first and only field read from a reserved-test row.
    source_capture_splits = {}
    source_rows = {}
    verified_files = {}
    for source_key, kind, expected_decision, excluded_decisions in (
        ('positiveRows', 'positive', 'confirmed_presence', {'not_visible', 'contaminated_reference'}),
        ('emptyEndpointRows', 'real-empty', 'confirmed_empty', {'contaminated_empty_endpoint'})):
        for source in manifest.get(source_key, []):
            split = source.get('split')
            if split not in groups:
                raise ValueError(f'projection contains unsupported split {split}')
            row_id = source.get('rowId')
            if not row_id or row_id in source_rows:
                raise ValueError(f'duplicate or missing manifest rowId: {row_id}')
            source_rows[row_id] = source
            decision = decisions.pop(row_id, None)
            if not decision:
                raise ValueError(f'{row_id}: missing visual review decision')
            ref, cur = _image_record(source, 'referenceImage'), _image_record(source, 'currentImage')
            if (decision.get('referenceImageSHA256') != ref['sha256'] or
                    decision.get('currentImageSHA256') != cur['sha256']):
                raise ValueError(f'{row_id}: review image hashes do not match manifest')
            for path_key, digest_key in (('referenceManifestPath', 'referenceManifestSHA256'),
                                         ('currentManifestPath', 'currentManifestSHA256')):
                path, digest = source.get(path_key), source.get(digest_key)
                if not path or not digest:
                    raise ValueError(f'{row_id}: {path_key} hash is missing or changed')
                resolved = base.resolve_path(path)
                actual = verified_files.setdefault(str(resolved), base.sha256(resolved))
                if actual != digest:
                    raise ValueError(f'{row_id}: {path_key} hash is missing or changed')
            if decision.get('decision') in excluded_decisions and decision.get('includeInEvaluation') is False:
                continue
            if decision.get('decision') != expected_decision or decision.get('includeInEvaluation') is not True:
                raise ValueError(f'{row_id}: unresolved or conflicting visual review')
            if verify_images:
                for image in (ref, cur):
                    path = base.resolve_path(image['path'])
                    actual = verified_files.setdefault(str(path), base.sha256(path))
                    if actual != image['sha256']:
                        raise ValueError(f'{row_id}: source image hash changed: {path}')
            current_capture_id = source.get('currentCaptureId') or source.get('captureId')
            reference_capture_id = source.get('referenceCaptureId')
            if not current_capture_id or not reference_capture_id:
                raise ValueError(f'{row_id}: current/reference capture IDs missing')
            for capture_id in (current_capture_id, reference_capture_id):
                previous = source_capture_splits.setdefault(capture_id, split)
                if previous != split:
                    raise ValueError(f'{row_id}: capture {capture_id} crosses development/validation')
            row = {'id': row_id, 'sampleId': row_id, 'kind': kind,
                   'label': 1 if kind == 'positive' else 0, 'split': split,
                   'imagePath': cur['path'], 'imageSHA256': cur['sha256'],
                   'referenceImagePath': ref['path'], 'referenceImageSHA256': ref['sha256'],
                   'currentCaptureId': current_capture_id,
                   'referenceCaptureId': reference_capture_id,
                   'captureId': current_capture_id, 'camera': source.get('camera'),
                   'calibration': source.get('currentCalibration', source.get('calibration')),
                   'reviewDecision': decision['decision'],
                   'reviewRowId': row_id, 'datasetSource': 'expansion'}
            groups[split].append(row)
            accepted_ids.add(row_id)
    if decisions:
        raise ValueError('review file contains IDs not consumed from development/validation manifest rows')
    if not groups['development'] or not groups['validation']:
        raise ValueError('reviewed expansion must contain both development and validation rows')
    # Capture groups and image pairs must not cross the frozen split boundary.
    dev_ids = {r['currentCaptureId'] for r in groups['development']} | {r['referenceCaptureId'] for r in groups['development']}
    val_ids = {r['currentCaptureId'] for r in groups['validation']} | {r['referenceCaptureId'] for r in groups['validation']}
    if dev_ids & val_ids:
        raise ValueError(f'expansion split leakage across capture IDs: {sorted(dev_ids & val_ids)[:3]}')
    dev_hashes = {h for r in groups['development'] for h in (r['imageSHA256'], r['referenceImageSHA256'])}
    val_hashes = {h for r in groups['validation'] for h in (r['imageSHA256'], r['referenceImageSHA256'])}
    if dev_hashes & val_hashes:
        raise ValueError('expansion image leakage across development/validation')
    if set(decisions):
        raise ValueError('review contains row IDs outside the development/validation projection')
    expected_ids = set(manifest.get('requiredRowIds', []))
    if expected_ids and expected_ids != set(source_rows):
        raise ValueError('development/validation requiredRowIds differ from row projection')
    return groups, {'rowsSHA256': sha256(manifest_path), 'reviewSHA256': sha256(review_path),
                    'includedRows': len(accepted_ids), 'splitCounts': {k: len(v) for k, v in groups.items()},
                    'excludedRows': len(source_rows) - len(accepted_ids),
                    'sourceManifestSHA256': manifest.get('sourceManifestSHA256'),
                    'reservedNewTestVisits': 17, 'reservedNewTestRowsOpened': 0}


def score_metrics(scored):
    return metrics_lib.metrics(scored)


def combined_objective(metrics):
    """Fixed 0.5 threshold: .5 positive FN + .4 real-empty FP + .1 identity FP rates."""
    rates = (metrics['positivePairs']['errorRateAtHalf'],
             metrics['realEmptyPairs']['errorRateAtHalf'],
             metrics['syntheticEmptyPairs']['errorRateAtHalf'])
    if any(x is None for x in rates):
        raise ValueError(f'combined objective group missing: {rates}')
    return .5*rates[0] + .4*rates[1] + .1*rates[2]


def retention_guard(candidate, incumbent_old, incumbent_new):
    """Reject any candidate that worsens positive FN or real-empty FP per cohort."""
    failures = []
    for split, incumbent in (('historical', incumbent_old), ('expansion', incumbent_new)):
        metrics = candidate[split]
        for group, count_key in (('positivePairs', 'positiveFalseNegativesAtHalf'),
                                 ('realEmptyPairs', 'realFalsePositivesAtHalf')):
            actual, limit = metrics[count_key], incumbent[count_key]
            if actual > limit:
                failures.append({'split': split, 'metric': count_key, 'actual': actual, 'maximum': limit})
    return not failures, failures


def candidate_rank(candidate):
    return (candidate['combinedPositiveFalseNegatives'],
            candidate['combinedRealFalsePositives'], candidate['validationBce'])


def select_candidate(candidates):
    feasible = [c for c in candidates if c['feasible']]
    if not feasible:
        raise ValueError('epoch-0 incumbent must be included as a feasible candidate')
    incumbent = next((c for c in feasible if c.get('epoch') == 0), None)
    if incumbent is None:
        raise ValueError('epoch-0 incumbent candidate missing')
    return min(feasible, key=candidate_rank)


def validation_bce(scored):
    if not scored:
        raise ValueError('validation scores are empty')
    return sum(-(s['row']['label'] * math.log(max(1e-8, s['probability'])) +
                 (1-s['row']['label']) * math.log(max(1e-8, 1-s['probability'])))
               for s in scored) / len(scored)


def run(args):
    torch, Image, _ = base.torch_modules()
    torch.set_num_threads(2)
    torch.manual_seed(args.seed)
    random.seed(args.seed)
    model_path, targets_path, old_manifest_path = (p.resolve() for p in (args.model, args.targets, args.old_manifest))
    expansion_path, review_path = args.expansion.resolve(), args.review.resolve()
    out = args.output.resolve()
    if out.exists() and any(out.iterdir()):
        raise FileExistsError(f'refusing to overwrite nonempty output: {out}')

    warm_checkpoint, old_metadata, old_manifest, source_dataset = evaluator.load_and_verify(
        torch, model_path, targets_path, old_manifest_path, args.allow_retrospective_labels)
    _, _, _, old_train, old_valid, visibility_exclusions = v4.prior.build_rows(
        targets_path, args.allow_retrospective_labels, old_metadata, old_manifest, source_dataset,
        args.visibility_directory.resolve())
    expansion, expansion_provenance = build_new_rows(expansion_path, review_path)
    old_train = [{**r, 'datasetSource': 'historical'} for r in old_train]
    old_valid = [{**r, 'datasetSource': 'historical'} for r in old_valid]
    train_rows = old_train + expansion['development']
    old_valid_rows = old_valid
    new_valid_rows = expansion['validation']
    valid_rows = old_valid_rows + new_valid_rows
    if any(r.get('split') == 'reserved-new-test' for r in train_rows + valid_rows):
        raise AssertionError('reserved new-test row entered train/validation')
    if not old_train or not old_valid:
        raise ValueError('historical development and validation rows required')
    historical_hashes = {h for r in old_train + old_valid for h in (r['imageSHA256'], r['referenceImageSHA256'])}
    expansion_hashes = {h for r in expansion['development'] + expansion['validation']
                        for h in (r['imageSHA256'], r['referenceImageSHA256'])}
    if historical_hashes & expansion_hashes:
        raise ValueError('expansion images overlap historical train/validation material')

    use_cuda = args.device == 'cuda' or (args.device == 'auto' and torch.cuda.is_available())
    if args.device == 'cuda' and not torch.cuda.is_available():
        raise RuntimeError('CUDA requested but unavailable')
    device = torch.device('cuda' if use_cuda else 'cpu')
    if use_cuda:
        torch.cuda.set_per_process_memory_fraction(args.cuda_memory_fraction, 0)
    model = load_model(torch, warm_checkpoint)
    frozen = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()
              if not k.startswith(NEW_PREFIXES)}
    for name, parameter in model.named_parameters():
        parameter.requires_grad_(name.startswith(NEW_PREFIXES))
    model.to(device)
    initial = {k: v.detach().cpu().clone() for k, v in model.state_dict().items() if k.startswith(NEW_PREFIXES)}
    images = base.ImageCache(Image, capacity=args.image_cache)
    if args.smoke:
        selected_rows = [next(r for r in old_train if r['kind'] == 'positive'),
                         next(r for r in expansion['development'] if r['kind'] == 'positive'),
                         next(r for r in expansion['development'] if r['kind'] == 'real-empty'),
                         next(r for r in old_train if r['kind'] == 'synthetic-empty')]
        smoke_features = v4.cache_features(model, selected_rows, images, torch, device)
        x = torch.stack([smoke_features[v4.feature_key(r)] for r in selected_rows]).to(device)
        y = torch.tensor([r['label'] for r in selected_rows], dtype=torch.float32, device=device)
        teacher = v4.load_model(torch, warm_checkpoint).to(device).eval()
        with torch.no_grad():
            teacher_logit = teacher.forward_features(x[:1]).detach()
        optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=1e-4, weight_decay=1e-3)
        model.train()
        optimizer.zero_grad(set_to_none=True)
        logits = model.forward_features(x)
        bce = torch.nn.functional.binary_cross_entropy_with_logits(logits.float(), y)
        model.eval()
        student_old_logit = model.forward_features(x[:1])
        distillation = torch.nn.functional.mse_loss(student_old_logit, teacher_logit)
        loss = bce + .1 * distillation
        localizer.require_finite('v6 smoke loss', loss)
        loss.backward()
        for name, parameter in model.named_parameters():
            if parameter.requires_grad and parameter.grad is not None:
                localizer.require_finite(f'v6 smoke gradient {name}', parameter.grad)
        optimizer.step()
        updated = any(not torch.equal(model.state_dict()[k].detach().cpu(), v) for k, v in initial.items())
        if not updated:
            raise AssertionError('V6 presenceEvidence/presenceCorrection branch did not update')
        for key, value in frozen.items():
            if not torch.equal(model.state_dict()[key].detach().cpu(), value):
                raise AssertionError(f'frozen V4 tensor changed in smoke step: {key}')
        print(json.dumps({'smoke': 'pass', 'selectedKinds': [r['kind'] for r in selected_rows],
                          'bce': float(bce.detach()), 'oldDevelopmentDistillationMSE': float(distillation.detach()),
                          'loss': float(loss.detach()), 'frozenTensorCount': len(frozen),
                          'updatedPrefixes': list(NEW_PREFIXES)}))
        return
    features = v4.cache_features(model, train_rows + valid_rows, images, torch, device)
    counts = {kind: sum(r['kind'] == kind for r in train_rows) for kind in MASS}
    if any(x == 0 for x in counts.values()):
        raise ValueError(f'training group missing: {counts}')
    weights = {kind: mass * len(train_rows) / counts[kind] for kind, mass in MASS.items()}

    model.eval()
    incumbent_scored = v4.score(model, valid_rows, features, torch, device)
    incumbent_metrics = score_metrics(incumbent_scored)
    incumbent_old = score_metrics([s for s in incumbent_scored if s['row']['datasetSource'] == 'historical'])
    incumbent_new = score_metrics([s for s in incumbent_scored if s['row']['datasetSource'] == 'expansion'])
    incumbent_bce = validation_bce(incumbent_scored)
    incumbent_objective = combined_objective(incumbent_metrics)
    incumbent_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
    incumbent_candidate = {'name': 'v4-incumbent', 'epoch': 0, 'feasible': True,
                           'oldValidation': incumbent_old, 'newValidation': incumbent_new,
                           'combinedValidation': incumbent_metrics, 'validationBce': incumbent_bce,
                           'combinedPositiveFalseNegatives': incumbent_metrics['positiveFalseNegativesAtHalf'],
                           'combinedRealFalsePositives': incumbent_metrics['realFalsePositivesAtHalf'],
                           'state': incumbent_state, 'selectionObjective': incumbent_objective,
                           'guardFailures': []}
    teacher = v4.load_model(torch, warm_checkpoint).to(device).eval()
    teacher_logits = {}
    with torch.no_grad():
        for start in range(0, len(old_train), args.batch_size):
            batch = old_train[start:start + args.batch_size]
            x = torch.stack([features[v4.feature_key(r)] for r in batch]).to(device)
            logits = teacher.forward_features(x)
            localizer.require_finite('cached old-development teacher logits', logits)
            teacher_logits.update({r['id']: float(value) for r, value in zip(batch, logits.cpu())})
    history, best_v6_candidate = [], None
    candidate_states = {'v4-incumbent': incumbent_state}
    branch_updated = False
    optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],
                                  lr=1e-4, weight_decay=1e-3)
    output_provenance = {'warmStartModelSHA256': sha256(model_path),
                         'historicalTargetsSHA256': sha256(targets_path),
                         'historicalEmptyManifestSHA256': sha256(old_manifest_path),
                         **expansion_provenance, 'trainerSHA256': sha256(Path(__file__))}
    for epoch in range(1, args.epochs + 1):
        model.train()
        order = list(range(len(train_rows)))
        random.Random(args.seed + epoch).shuffle(order)
        loss_total = 0.0
        for start in range(0, len(order), args.batch_size):
            batch = [train_rows[i] for i in order[start:start + args.batch_size]]
            x = torch.stack([features[v4.feature_key(r)] for r in batch]).to(device)
            y = torch.tensor([r['label'] for r in batch], dtype=torch.float32, device=device)
            model.train()
            logits = model.forward_features(x)
            localizer.require_finite('v6 training logits', logits)
            raw = torch.nn.functional.binary_cross_entropy_with_logits(logits.float(), y, reduction='none')
            w = torch.tensor([weights[r['kind']] for r in batch], dtype=torch.float32, device=device)
            bce = (raw * w).mean()
            old_positions = [i for i, r in enumerate(batch)
                             if r['datasetSource'] == 'historical' and r.get('split') == 'development']
            if old_positions:
                model.eval()
                old_x = x[old_positions]
                student_old = model.forward_features(old_x)
                teacher_old = torch.tensor([teacher_logits[batch[i]['id']] for i in old_positions],
                                           dtype=torch.float32, device=device)
                distillation = torch.nn.functional.mse_loss(student_old.float(), teacher_old)
                model.train()
            else:
                distillation = logits.sum() * 0.0
            loss = bce + .1 * distillation
            localizer.require_finite('v6 BCE', bce)
            localizer.require_finite('v6 old-development distillation loss', distillation)
            localizer.require_finite('v6 training loss', loss)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            for name, parameter in model.named_parameters():
                if parameter.requires_grad and parameter.grad is not None:
                    localizer.require_finite(f'v6 gradient {name}', parameter.grad)
            torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 5.0,
                                           error_if_nonfinite=True)
            optimizer.step()
            branch_updated = branch_updated or any(
                not torch.equal(model.state_dict()[k].detach().cpu(), value) for k, value in initial.items())
            loss_total += float(loss.detach()) * len(batch)
        scored = v4.score(model, valid_rows, features, torch, device)
        all_metrics = score_metrics(scored)
        old_scored = [s for s in scored if s['row']['datasetSource'] == 'historical']
        new_scored = [s for s in scored if s['row']['datasetSource'] == 'expansion']
        old_metrics, new_metrics = score_metrics(old_scored), score_metrics(new_scored)
        old_bce, new_bce = validation_bce(old_scored), validation_bce(new_scored)
        val_bce = validation_bce(scored)
        feasible, failures = retention_guard({'historical': old_metrics, 'expansion': new_metrics},
                                             incumbent_old, incumbent_new)
        combined_fn = old_metrics['positiveFalseNegativesAtHalf'] + new_metrics['positiveFalseNegativesAtHalf']
        combined_fp = old_metrics['realFalsePositivesAtHalf'] + new_metrics['realFalsePositivesAtHalf']
        row = {'epoch': epoch, 'trainLossMean': loss_total / len(train_rows),
               'oldValidation': old_metrics, 'newValidation': new_metrics,
               'oldValidationBce': old_bce, 'newValidationBce': new_bce,
               'combinedValidation': all_metrics, 'combinedValidationBce': val_bce,
               'combinedPositiveFalseNegatives': combined_fn, 'combinedRealFalsePositives': combined_fp,
               'selectionObjective': combined_objective(all_metrics), 'feasible': feasible,
               'guardFailures': failures}
        history.append(row)
        print(f"v6 epoch {epoch}: feasible={feasible}, old/new FN "
              f"{old_metrics['positiveFalseNegativesAtHalf']}/{new_metrics['positiveFalseNegativesAtHalf']}, "
              f"old/new real FP {old_metrics['realFalsePositivesAtHalf']}/{new_metrics['realFalsePositivesAtHalf']}", flush=True)
        if feasible:
            candidate = {'name': 'v6-epoch', 'epoch': epoch, 'feasible': True,
                         'oldValidation': old_metrics, 'newValidation': new_metrics,
                         'combinedValidation': all_metrics, 'validationBce': val_bce,
                         'combinedPositiveFalseNegatives': combined_fn,
                         'combinedRealFalsePositives': combined_fp,
                         'selectionObjective': row['selectionObjective'], 'guardFailures': []}
            if best_v6_candidate is None or candidate_rank(candidate) < candidate_rank(best_v6_candidate):
                candidate_key = f'v6-epoch-{epoch}'
                candidate_states[candidate_key] = {k: v.detach().cpu().clone()
                                                   for k, v in model.state_dict().items()}
                candidate['stateKey'] = candidate_key
                if best_v6_candidate and best_v6_candidate.get('stateKey'):
                    candidate_states.pop(best_v6_candidate['stateKey'], None)
                best_v6_candidate = candidate

    if not branch_updated:
        raise AssertionError('V6 optimization did not update the V4 presence branch')
    selection_candidates = [incumbent_candidate] + ([best_v6_candidate] if best_v6_candidate else [])
    selected = select_candidate(selection_candidates)
    selected_state = candidate_states[selected.get('stateKey', 'v4-incumbent')]
    model.load_state_dict(selected_state, strict=True)
    for key, expected in frozen.items():
        if not torch.equal(model.state_dict()[key].detach().cpu(), expected):
            raise AssertionError(f'frozen v4 tensor changed: {key}')
    selected_scores = v4.score(model, valid_rows, features, torch, device)
    final_combined = score_metrics(selected_scores)
    final_old = score_metrics([s for s in selected_scores if s['row']['datasetSource'] == 'historical'])
    final_new = score_metrics([s for s in selected_scores if s['row']['datasetSource'] == 'expansion'])
    provenance = {**output_provenance, 'format': 'real-presence-training-v6',
                  'architecture': 'presence-conv-v1', 'warmStartArchitecture': 'presence-conv-v1', 'seed': args.seed,
                  'device': str(device), 'cudaMemoryFraction': args.cuda_memory_fraction if use_cuda else None,
                  'epochsRequested': args.epochs,
                  'selection': 'epoch 0 V4 incumbent plus feasible epochs; rank combined positive FN, then real-empty FP, then combined validation BCE',
                  'retentionGuards': 'historical and expansion validation positive FN and real-empty FP each must be no greater than epoch-0 V4',
                  'selectionObjective': '.5*positive_FN_rate + .4*real_empty_FP_rate + .1*synthetic_identity_FP_rate',
                  'trainingWeights': MASS, 'bestEpoch': selected['epoch'],
                  'bestFeasibleV6Epoch': best_v6_candidate['epoch'] if best_v6_candidate else None,
                  'selectedCandidate': selected['name'],
                  'optimizer': 'AdamW', 'learningRate': 1e-4, 'weightDecay': 1e-3,
                  'oldDevelopmentLogitDistillationWeight': .1,
                  'oldDevelopmentTeacherLogitsSHA256': hashlib.sha256(json.dumps(teacher_logits, sort_keys=True).encode()).hexdigest(),
                  'randomSeed': 17, 'requestedEpochs': 40, 'batchSize': 32,
                  'reservedNewTestInferencePerformed': False, 'reservedNewTestRowsOpened': 0,
                  'frozenV4TensorCount': len(frozen), 'trainedOnlyPrefixes': list(NEW_PREFIXES),
                  'visibilityExclusions': visibility_exclusions}
    meta = {**warm_checkpoint['metadata'], 'presenceArchitecture': provenance['architecture'],
            'presenceFineTuning': provenance,
            'presenceValidationMetrics': {'historical': final_old, 'expansion': final_new,
                                          'combined': final_combined}}
    out.mkdir(parents=True, exist_ok=True)
    torch.save({'state_dict': model.state_dict(), 'metadata': meta}, out / 'model.pt')
    candidate_dir = out / 'candidates'
    candidate_dir.mkdir()
    candidate_hashes = {}
    export_candidates = [('v4-incumbent', incumbent_state)]
    if best_v6_candidate:
        export_candidates.append(('v6-best-feasible-epoch', candidate_states[best_v6_candidate['stateKey']]))
    for name, state in export_candidates:
        candidate_path = candidate_dir / f'{name}.pt'
        torch.save({'state_dict': state, 'metadata': {**meta, 'candidate': name}}, candidate_path)
        candidate_hashes[name] = sha256(candidate_path)
    report = {'format': 'real-presence-training-v6', 'metadata': provenance,
              'incumbentValidationObjective': incumbent_objective,
              'incumbentValidationMetrics': incumbent_metrics,
              'incumbentHistoricalValidationMetrics': incumbent_old,
              'incumbentExpansionValidationMetrics': incumbent_new,
              'historicalValidationMetrics': final_old, 'expansionValidationMetrics': final_new,
              'combinedValidationMetrics': final_combined, 'history': history,
              'feasibleV6CandidateFound': best_v6_candidate is not None,
              'selectedCandidate': selected['name'],
              'selectedEpoch': selected['epoch'],
              'incumbentValidationPredictions': [{'id': s['row']['id'], 'datasetSource': s['row']['datasetSource'],
                                                  'kind': s['row']['kind'], 'label': s['row']['label'],
                                                  'probability': s['probability']} for s in incumbent_scored],
              'selectedValidationPredictions': [{'id': s['row']['id'], 'datasetSource': s['row']['datasetSource'],
                                                 'kind': s['row']['kind'], 'label': s['row']['label'],
                                                 'probability': s['probability']} for s in selected_scores],
              'candidateCheckpointSHA256': candidate_hashes,
              'checkpointSHA256': sha256(out / 'model.pt')}
    (out / 'report.json').write_text(json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + '\n')
    (out / 'history.json').write_text(json.dumps(history, indent=2, sort_keys=True, allow_nan=False) + '\n')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--model', type=Path, default=DEFAULT_MODEL)
    p.add_argument('--targets', type=Path, default=DEFAULT_TARGETS)
    p.add_argument('--old-manifest', type=Path, default=DEFAULT_OLD_MANIFEST)
    p.add_argument('--expansion', type=Path, default=DEFAULT_EXPANSION)
    p.add_argument('--review', type=Path, default=DEFAULT_REVIEW)
    p.add_argument('--visibility-directory', type=Path, default=ROOT / 'data/board-captures/_visibility')
    p.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    p.add_argument('--epochs', type=int, default=40)
    p.add_argument('--batch-size', type=int, default=32)
    p.add_argument('--image-cache', type=int, default=512)
    p.add_argument('--seed', type=int, default=17)
    p.add_argument('--device', choices=('auto', 'cpu', 'cuda'), default='cuda')
    p.add_argument('--cuda-memory-fraction', type=float, default=.25)
    p.add_argument('--allow-retrospective-labels', action='store_true')
    p.add_argument('--smoke', action='store_true', help='one optimizer step on three reviewed development examples only')
    a = p.parse_args()
    if not a.smoke and (a.epochs, a.batch_size, a.seed) != (40, 32, 17):
        p.error('this predeclared run requires --epochs 40 --batch-size 32 --seed 17')
    if not a.smoke and a.cuda_memory_fraction != .25:
        p.error('this predeclared run requires --cuda-memory-fraction 0.25')
    run(a)


if __name__ == '__main__':
    main()
