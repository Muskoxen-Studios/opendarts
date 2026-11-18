#!/usr/bin/env python3
"""Render reviewed fresh-holdout predictions for offline visual inspection."""
import argparse
import importlib.util
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/detector'))
import training_data as base
import training_localizer as localizer
import evaluate_fresh_presence_holdout as evaluator
import evaluate_presence_expansion as expansion_evaluator
import report_real_keypoints as board_report
from vision import segment as score_segment


def template_module():
    path = ROOT / 'scripts/render-detector-visuals.py'
    spec = importlib.util.spec_from_file_location('detector_visual_template', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def score_label(segment):
    if not segment: return 'Unavailable'
    ring, number = segment['ring'], segment['number']
    if ring == 'BULL': return 'Bull · 50'
    if ring == 'OUTER_BULL': return 'Outer bull · 25'
    if ring == 'MISS': return 'Miss · 0'
    return f"{'D' if ring == 'DOUBLE' else 'T' if ring == 'TRIPLE' else 'S'}{number}"


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--evaluation', type=Path, default=ROOT/'build/fresh-presence-evaluation-v1/comparison.json')
    p.add_argument('--manifest', type=Path, default=ROOT/'build/fresh-presence-holdout-v1/manifest.json')
    p.add_argument('--review', type=Path, default=ROOT/'build/fresh-presence-holdout-v1/review.json')
    p.add_argument('--v2', type=Path, default=ROOT/'build/real-presence-model-v2/model.pt')
    p.add_argument('--candidate', default='presence-v4', help='selected checkpoint label in saved evaluation')
    p.add_argument('--candidate-label', default=None, help='display label; saved checkpoint selection stays unchanged')
    p.add_argument('--output', type=Path, default=ROOT/'build/detector-visuals-fresh-v4')
    args = p.parse_args()
    out = args.output if args.output.is_absolute() else ROOT/args.output
    if out.exists() and any(out.iterdir()): raise FileExistsError(f'refusing to overwrite nonempty viewer directory: {out}')
    result = json.loads(args.evaluation.read_text())
    is_expansion = result.get('format') == 'reserved-presence-expansion-evaluation-v1'
    if result.get('manifestSHA256') != base.sha256(args.manifest) or result.get('reviewSHA256') != base.sha256(args.review):
        raise ValueError('saved evaluation does not match the reviewed manifest')
    if is_expansion:
        manifest, reviewed_rows, exclusions = expansion_evaluator.read_rows(args.manifest, args.review)
        positives, negatives = [], []
        for source in reviewed_rows:
            row = {**source, 'pairId': source['rowId'],
                'currentCaptureId': source.get('captureId', source.get('currentCaptureId')),
                'imagePath': source['currentImage']['path'], 'currentImageSHA256': source['currentImage']['sha256'],
                'referenceImagePath': source['referenceImage']['path'], 'referenceImageSHA256': source['referenceImage']['sha256'],
                'calibration': source.get('calibration', source.get('currentCalibration')),
                'kind': 'positive' if source['positive'] else 'real-empty',
                'reviewDecision': 'confirmed_presence' if source['positive'] else 'confirmed_empty'}
            (positives if source['positive'] else negatives).append(row)
        exclusions = [{**d, 'pairId': d.get('rowId')} for d in exclusions]
    else:
        manifest, review, positives, negatives, exclusions, _ = evaluator.review_rows(args.manifest, args.review)
    by_pair = {r['pairId']: r for r in positives + negatives}
    model_names = ('presence-v2', 'presence-v3-spatial', args.candidate)
    scores = {}
    for name in model_names:
        data = result.get('models', {}).get(name)
        if not data: raise ValueError(f'missing {name} in frozen evaluation report')
        records = ([{**r, 'pairId': r['rowId'], 'predictedPixel': r['pixel']} for r in data['predictions']]
                   if is_expansion else data['pairScores'])
        scores[name] = {r['pairId']: r for r in records}
    if any(set(scores[n]) != set(by_pair) for n in model_names):
        raise ValueError('evaluation pair IDs do not match the reviewed cohort')
    torch, Image, ImageDraw = base.torch_modules()
    import numpy as np
    torch.set_num_threads(2)
    checkpoint = torch.load(args.v2, map_location='cpu', weights_only=False)
    if base.sha256(args.v2) != result['models']['presence-v2']['checkpointSHA256']:
        raise ValueError('heatmap checkpoint differs from frozen evaluation')
    model = localizer.model_class(torch)(); model.load_state_dict(checkpoint['state_dict']); model.eval()
    cache = base.ImageCache(Image, capacity=128)
    out.mkdir(parents=True, exist_ok=True); (out/'assets').mkdir()
    records = []
    capture_order = sorted({r['currentCaptureId'] for r in positives})
    capture_index = {cid: i for i, cid in enumerate(capture_order)}
    calibration_cache = {}

    def render(pair_id, row):
        prediction = scores[args.candidate][pair_id]
        # Evaluator rows bind both source files and hashes; retain that provenance.
        current_path = base.resolve_path(row['imagePath'])
        reference_path = base.resolve_path(row['referenceImagePath'])
        if base.sha256(current_path) != row['currentImageSHA256'] or base.sha256(reference_path) != row['referenceImageSHA256']:
            raise ValueError(f'{pair_id}: source image hash changed after holdout inference')
        cur = np.frombuffer(cache.get(current_path), dtype=np.uint8).copy().reshape(base.HEIGHT,base.WIDTH,3)
        ref = np.frombuffer(cache.get(reference_path), dtype=np.uint8).copy().reshape(base.HEIGHT,base.WIDTH,3)
        delta = np.clip((cur.astype(np.int16)-ref.astype(np.int16))*3+128,0,255).astype(np.uint8)
        pair = localizer.pair_tensor(torch, cache, {'imagePath':str(current_path),'referenceImagePath':str(reference_path)}).unsqueeze(0)
        with torch.no_grad():
            heat_logits, _ = model(pair)
            heat = torch.softmax(heat_logits.float(),dim=1).reshape(180,320).cpu().numpy()
        z=np.log1p(heat/max(float(heat.max()),1e-12)*99.0); z=z/max(float(z.max()),1e-12)
        color=np.zeros((180,320,3),dtype=np.uint8)
        color[:,:,0]=np.clip(255*np.minimum(1,2*z),0,255); color[:,:,1]=np.clip(255*np.maximum(0,2*z-.25),0,255); color[:,:,2]=np.clip(255*(1-z),0,255)
        pixel = prediction['predictedPixel']
        is_positive = row['kind']=='positive'
        camera = int(row['camera'])
        if is_positive:
            homographies=board_report.calibration_homographies(row,calibration_cache)
            board=board_report.board_point(pixel,homographies[camera]); segment,value=score_segment(*board)
            camera_candidate={'segment':segment,'value':value,'boardMm':list(board)}
            target=None  # Fresh labels are reviewed presence decisions, not pixel targets.
        else:
            camera_candidate=None; target=None
        key = f"{'throw'+str(capture_index[row['currentCaptureId']]) if is_positive else 'empty'+str(neg_index[pair_id])}-cam{camera}"
        for name, arr in [('current',cur),('reference',ref),('difference',delta),('heat',color)]:
            im=Image.fromarray(arr).resize((1280,720),Image.Resampling.BILINEAR)
            if name=='heat':
                im.save(out/'assets'/f'{key}-heat-base.jpg',quality=88)
                draw=ImageDraw.Draw(im); draw.ellipse((pixel[0]-9,pixel[1]-9,pixel[0]+9,pixel[1]+9),outline='#26e6dc',width=3)
            im.save(out/'assets'/f'{key}-{name}.jpg',quality=88)
        decision = row.get('reviewDecision','confirmed_presence' if is_positive else 'confirmed_empty')
        probs={n:float(scores[n][pair_id]['probability']) for n in model_names}
        status=lambda prob: ('success' if prob>=.5 else 'miss') if is_positive else ('false-positive' if prob>=.5 else 'true-negative')
        view={'key':key,'caseKey':f"throw{capture_index[row['currentCaptureId']]}" if is_positive else f"empty{neg_index[pair_id]}",
            'camera':camera,'title':f"Fresh reviewed {row['kind']} · camera {camera}",
            'detail':f"{decision} · {row['currentCaptureId']} ← {row['referenceCaptureId']}",'positive':is_positive,
            'score':probs[args.candidate],'baselineScore':probs['presence-v2'],'v3Score':probs['presence-v3-spatial'],
            'prediction':pixel,'target':target,'error':None,
            'images':{n:f'assets/{key}-{n}.jpg' for n in ['current','reference','difference','heat']},
            'heatBase':f'assets/{key}-heat-base.jpg','caseId':row['currentCaptureId'],'reviewedEndpoints':True,
            'status':status(probs[args.candidate]),'baselineStatus':status(probs['presence-v2']),
            'v3Status':status(probs['presence-v3-spatial']),'reviewDecision':decision,
            'cameraCandidateScore':camera_candidate,'consensusScore':None,'boardReportedScore':None,
            'scoreMatch':None,'casePresencePassed':None,'caseStatus':status(probs[args.candidate])}
        records.append(view)

    neg_index={r['pairId']:i for i,r in enumerate(negatives)}
    for row in positives+negatives: render(row['pairId'],row)
    by_case={}
    for v in records: by_case.setdefault(v['caseKey'],[]).append(v)
    for key, group in by_case.items():
        if group[0]['positive'] and len(group)==3:
            points=[v['cameraCandidateScore']['boardMm'] for v in group]
            mm=[sorted(pt[i] for pt in points)[1] for i in (0,1)]
            seg,value=score_segment(*mm)
            reported=json.loads((ROOT/'data/board-captures'/group[0]['caseId']/'manifest.json').read_text()).get('reportedThrow',{})
            for v in group:
                v['consensusScore']={'segment':seg,'value':value,'boardMm':mm}
                v['boardReportedScore']={'segment':reported.get('segment'),'value':reported.get('value'),'label':score_label(reported.get('segment'))}
                v['scoreMatch']=seg==reported.get('segment')
                misses=[str(x['camera']) for x in group if x['score']<.5]
                v['casePresencePassed']=not misses
                v['caseStatus']='Presence passed' if not misses else 'Rejected: missing presence in camera '+', '.join(misses)
    positive_groups=[g for g in by_case.values() if g and g[0]['positive']]
    negative_records=[r for r in records if not r['positive']]
    comparison={'positiveCaptures':len(positive_groups),'realEmptyPairs':len(negative_records)}
    for prefix,name in [('baseline','presence-v2'),('v3','presence-v3-spatial'),('selected',args.candidate)]:
        field='baselineScore' if name=='presence-v2' else 'v3Score' if name=='presence-v3-spatial' else 'score'
        comparison[prefix+'PositivePassed']=sum(all(x[field]>=.5 for x in g) for g in positive_groups)
        comparison[prefix+'FalsePositives']=sum(r[field]>=.5 for r in negative_records)
    provenance={'comparison':comparison,'presenceRun':str(args.evaluation.resolve().parent.relative_to(ROOT)),
        'candidateLabel':args.candidate_label or args.candidate,'baselineModelSHA256':result['models']['presence-v2']['checkpointSHA256'],
        'v3ModelSHA256':result['models']['presence-v3-spatial']['checkpointSHA256'],'modelSHA256':result['models'][args.candidate]['checkpointSHA256'],
        'architecture':'presence-conv-v1','threshold':result['threshold'],'positiveCaptures':len(positive_groups),
        'positiveViews':len(positives),'emptyViews':len(negatives),'excludedVisibilityCaptures':[],
        'holdoutId':manifest.get('holdoutId') or str(manifest.get('expansionId'))+'/reserved-new-test','manifestSHA256':result['manifestSHA256'],'reviewSHA256':result['reviewSHA256'],
        'freezeSHA256':result['freezeSHA256'],'reviewedExclusions':exclusions,
        'validationTuningData':False,'scope':'One frozen fresh holdout; no threshold/model tuning after inference.'}
    # Post-evaluation label disputes are display annotations, never metric or
    # training-label overrides. Bind them to the exact reviewed camera images.
    label_review_path = args.evaluation.parent/'label-review.json'
    if label_review_path.is_file():
        label_reviews = json.loads(label_review_path.read_text())
        if label_reviews.get('format') != 'offline-score-label-review-v1':
            raise ValueError('unsupported post-evaluation label review')
        for review in label_reviews['reviews']:
            expected = {str(r['camera']):r['currentImageSHA256'] for r in positives
                        if r['currentCaptureId']==review['captureId']}
            if not expected or review.get('imageSHA256') != expected or review.get('status') != 'disputed':
                raise ValueError('label dispute does not match the reviewed source images')
            for record in records:
                if record['caseId']==review['captureId']:
                    record['labelReview']=review
        provenance['postEvaluationLabelReviewSHA256']=base.sha256(label_review_path)
    template=template_module().HTML
    template=(template.replace('Detector inspection · offline validation','Detector inspection · fresh holdout')
        .replace('Offline model inspection · validation examples','Fresh reviewed holdout · frozen comparison')
        .replace('Validation comparison at threshold 0.5','Fresh holdout comparison at threshold 0.5')
        .replace('Validation throw','Fresh throw').replace('Real empty · camera','Reviewed empty · camera')
        .replace('Labels use retrospective board-plane projections. The validation split was used for checkpoint selection; the presence threshold is fixed at 0.5.','Fresh labels come from review decisions made before inference. This holdout was not used for selection; the threshold is fixed at 0.5.')
        .replace('Positive references are hash matched to the visual audit. Empty pairs are trainer curated and image hash verified; endpoints without a matching visual audit are labeled in the selected example.','Current and reference images are hash checked against the pre-inference review. Excluded contaminated pairs are listed in provenance.')
        .replace('Visibility exclusions: ${PROV.excludedVisibilityCaptures.length}.',
            'Fresh review exclusions: ${PROV.reviewedExclusions.length}; holdout ${PROV.holdoutId}; no post-inference tuning. Decisions: '+
            '${PROV.reviewedExclusions.map(x=>x.pairId+" ("+x.decision+")").join("; ")}.'))
    page=template.replace('__DATA__',json.dumps(records,separators=(',',':'))).replace('__PROVENANCE__',json.dumps(provenance,separators=(',',':')))
    (out/'index.html').write_text(page)
    print(json.dumps({'output':str(out/'index.html'),'positiveCameraViews':len(positives),'negativeCameraViews':len(negatives),'excluded':len(exclusions)},indent=2))


if __name__=='__main__': main()
