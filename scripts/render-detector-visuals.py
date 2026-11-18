#!/usr/bin/env python3
"""Render a local, offline visual inspection page for the validation detector."""
import argparse, json, math, shutil, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'build/detector-visuals-v4'
KEEP_CAPTURE = '2026-11-16T14-50-51-071Z-dbabc0f0-0be0-4515-a0b7-46fd1896d18f'
sys.path.insert(0, str(ROOT / 'services/detector'))
import training_localizer as trainer
import training_data as base
import training_presence_data as presence_trainer
import training_presence_model as presence_v4_trainer
import report_real_keypoints as board_report
from vision import segment as score_segment

def score_label(segment):
    if not segment: return 'Unavailable'
    ring=segment['ring']; number=segment['number']
    if ring=='BULL': return 'Bull · 50'
    if ring=='OUTER_BULL': return 'Outer bull · 25'
    if ring=='MISS': return 'Miss · 0'
    prefix={'SINGLE_INNER':'S','SINGLE_OUTER':'S','DOUBLE':'D','TRIPLE':'T'}.get(ring,'?')
    return f'{prefix}{number}'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--keypoint-run', default='real-keypoint-model-v3',
                        help='build/ run containing predictions.json')
    parser.add_argument('--presence-run', default='real-presence-model-v4',
                        help='selected build/ run containing model.pt')
    parser.add_argument('--v2-run', default='real-presence-model-v2')
    parser.add_argument('--v3-run', default='real-presence-model-v3')
    parser.add_argument('--candidate-label', default=None,
                        help='label for the selected model (defaults from --presence-run directory)')
    parser.add_argument('--output', type=Path, default=OUT,
                        help='output directory (default: build/detector-visuals)')
    args = parser.parse_args()
    out = args.output if args.output.is_absolute() else ROOT / args.output
    if out.exists() and any(out.iterdir()):
        raise FileExistsError(f'refusing to overwrite nonempty viewer directory: {out}')
    keypoint_dir = ROOT / 'build' / args.keypoint_run
    presence_dir = ROOT / 'build' / args.presence_run
    torch, Image, ImageDraw = base.torch_modules()
    import numpy as np
    torch.set_num_threads(2)
    targets_path=ROOT/'build/real-keypoints-retrospective-v1/targets.json'
    targets=json.loads(targets_path.read_text())
    source=json.loads((ROOT/targets['sourceDatasetPath']).read_text())
    labels={r['id']:r['label'] for r in source['records']}
    pred=json.loads((keypoint_dir/'predictions.json').read_text())['predictions']
    byid={r['sampleId']:r for r in pred if r['split']=='validation' and r['isPositive']}
    # Visibility annotations are an explicit exclusion list.
    annotations=[json.loads(p.read_text()) for p in (ROOT/'data/board-captures/_visibility').glob('*.json')]
    excluded={a['captureId'] for a in annotations if a.get('excludeFromPositiveTraining') is True}
    excluded_references={a['referenceCaptureId'] for a in annotations
                         if a.get('reason')=='contaminated-reference'}
    audit_path=ROOT/'build/reference-audit/audit.json'
    audit=json.loads(audit_path.read_text())
    approved={r['referenceCaptureId']:r for r in audit['references'] if r['status']=='clean'}
    baseline_dir=ROOT/'build/real-presence-model-v2'
    baseline_ck=torch.load(baseline_dir/'model.pt',map_location='cpu',weights_only=False)
    manifest=json.loads((ROOT/'build/real-empty-pairs-v1-final/manifest.json').read_text())
    _,_,_,_,validation_rows,trainer_exclusions=presence_trainer.build_rows(
        targets_path,True,baseline_ck['metadata'],manifest,source,ROOT/'data/board-captures/_visibility')
    if set(trainer_exclusions)!=excluded:
        raise ValueError('Visibility exclusions differ from presence-trainer audit')
    rows=[r for r in validation_rows if r['kind']=='positive' and r['sampleId'] in byid]
    pair_camera={p['pairId']:p['camera'] for p in manifest['pairs']}
    empty_rows=[{**r,'camera':pair_camera[r['id']]} for r in validation_rows if r['kind']=='real-empty']
    for row in rows:
        ref_id=row['previousFrameCaptureId']
        if ref_id not in approved:
            raise ValueError(f"Positive reference is not audit-approved: {ref_id}")
        expected=approved[ref_id]['referenceImageSHA256'][str(row['camera'])]
        if expected!=row['previousFrameImageSHA256']:
            raise ValueError('Positive reference hash differs from the visual audit')
    if len(rows)!=105 or len({r['captureId'] for r in rows})!=35 or len(empty_rows)!=18:
        raise ValueError(f'Expected 105 positive views / 35 captures and 18 real negatives; got {len(rows)} / {len({r["captureId"] for r in rows})} / {len(empty_rows)}')
    captures={}
    for r in rows: captures.setdefault(r['captureId'],[]).append(r)
    capture_order=sorted(captures)
    if KEEP_CAPTURE in capture_order:
        capture_order.remove(KEEP_CAPTURE)
        capture_order.insert(min(3,len(capture_order)),KEEP_CAPTURE)
    out.mkdir(parents=True,exist_ok=True); (out/'assets').mkdir(exist_ok=True)
    ck=torch.load(presence_dir/'model.pt',map_location='cpu',weights_only=False)
    candidate_label=args.candidate_label or f"presence-{presence_dir.name.rsplit('-',1)[-1]}"
    if ck.get('metadata',{}).get('presenceArchitecture')=='presence-conv-v1':
        model=presence_v4_trainer.load_model(torch,ck)
        model.load_state_dict(ck['state_dict'],strict=True)
    elif ck.get('metadata',{}).get('presenceArchitecture')=='spatial-grid-v1':
        model=presence_trainer.load_model(torch,ck)
    else:
        model=trainer.model_class(torch)()
        model.load_state_dict(ck['state_dict'])
    model.eval()
    baseline_model=trainer.model_class(torch)()
    baseline_model.load_state_dict(baseline_ck['state_dict']); baseline_model.eval()
    v3_dir=ROOT/'build'/args.v3_run
    v3_ck=torch.load(v3_dir/'model.pt',map_location='cpu',weights_only=False)
    v3_model=presence_trainer.load_model(torch,v3_ck)
    v3_model.load_state_dict(v3_ck['state_dict'],strict=True); v3_model.eval()
    cache=base.ImageCache(Image,capacity=128)
    calibration_cache={}
    records=[]
    def render_view(key, casekey, row, ispositive, title, detail):
        curpath=row['imagePath']; refpath=row.get('previousFrameImagePath',row.get('referenceImagePath'))
        cur=np.frombuffer(cache.get(base.resolve_path(curpath)),dtype=np.uint8).copy().reshape(base.HEIGHT,base.WIDTH,3)
        ref=np.frombuffer(cache.get(base.resolve_path(refpath)),dtype=np.uint8).copy().reshape(base.HEIGHT,base.WIDTH,3)
        delta=np.clip((cur.astype(np.int16)-ref.astype(np.int16))*3+128,0,255).astype(np.uint8)
        with torch.no_grad():
            x=trainer.pair_tensor(torch,cache,{'imagePath':str(base.resolve_path(curpath)),'referenceImagePath':str(base.resolve_path(refpath))}).unsqueeze(0)
            logits, presence_logits=model(x)
            _, baseline_logits=baseline_model(x)
            _, v3_logits=v3_model(x)
            score=float(torch.sigmoid(presence_logits[0]).item())
            baseline_score=float(torch.sigmoid(baseline_logits[0]).item())
            v3_score=float(torch.sigmoid(v3_logits[0]).item())
            predpx=trainer.decode(torch,logits,4)[0].tolist()
            heat=torch.softmax(logits.float(),dim=1).reshape(180,320).cpu().numpy()
        z=np.log1p(heat/max(float(heat.max()),1e-12)*99.0); z=z/max(float(z.max()),1e-12)
        color=np.zeros((180,320,3),dtype=np.uint8)
        color[:,:,0]=np.clip(255*np.minimum(1,2*z),0,255); color[:,:,1]=np.clip(255*np.maximum(0,2*z-0.25),0,255); color[:,:,2]=np.clip(255*(1-z),0,255)
        targetpx=[row['targetPixel']['x'],row['targetPixel']['y']] if ispositive else None
        reviewed=True
        if not ispositive:
            reviewed=True
            for endpoint_id, image_hash in ((row['baselineA'],row['referenceImageSHA256']),
                                            (row['baselineB'],row['imageSHA256'])):
                audit_row=approved.get(endpoint_id)
                if not audit_row or audit_row['referenceImageSHA256'].get(str(row['camera']))!=image_hash:
                    reviewed=False
        for name,arr in [('current',cur),('reference',ref),('difference',delta),('heat',color)]:
            im=Image.fromarray(arr).resize((1280,720),Image.Resampling.BILINEAR)
            if name=='heat':
                im.save(out/'assets'/f'{key}-heat-base.jpg',quality=88)
                dr=ImageDraw.Draw(im)
                if predpx: dr.ellipse((predpx[0]-9,predpx[1]-9,predpx[0]+9,predpx[1]+9),outline='#26e6dc',width=3)
                im.save(out/'assets'/f'{key}-heat-prediction.jpg',quality=88)
                if targetpx: dr.ellipse((targetpx[0]-9,targetpx[1]-9,targetpx[0]+9,targetpx[1]+9),outline='#ffd54f',width=3)
            im.save(out/'assets'/f'{key}-{name}.jpg',quality=88)
        view={'key':key,'caseKey':casekey,'camera':int(row['camera']),'title':title,'detail':detail,'positive':ispositive,
              'score':score,'baselineScore':baseline_score,'v3Score':v3_score,'prediction':predpx,'target':targetpx,
              'error':round(math.dist(predpx,targetpx),1) if ispositive else None,
              'images':{n:f'assets/{key}-{n}.jpg' for n in ['current','reference','difference','heat']},
              'heatBase':f'assets/{key}-heat-base.jpg','caseId':row.get('captureId',row.get('id')),
              'reviewedEndpoints':reviewed,
              'status':('success' if score>=.5 else 'miss') if ispositive else ('false-positive' if score>=.5 else 'true-negative'),
              'baselineStatus':('success' if baseline_score>=.5 else 'miss') if ispositive else ('false-positive' if baseline_score>=.5 else 'true-negative')}
        view['cameraCandidateScore']=None
        if ispositive:
            hs=board_report.calibration_homographies(row,calibration_cache)
            mm=board_report.board_point(predpx,hs[int(view['camera'])])
            seg,value=score_segment(*mm)
            view['cameraCandidateScore']={'segment':seg,'value':value,'boardMm':[mm[0],mm[1]]}
        records.append(view)
    for ci,cid in enumerate(capture_order):
        group=sorted(captures[cid],key=lambda x:x['camera'])
        for r in group:
            p=byid[r['sampleId']]
            r={**r,'imagePath':r['imagePath'],'previousFrameImagePath':r['previousFrameImagePath']}
            tpx=[r['targetPixel']['x'],r['targetPixel']['y']]
            err=math.dist(p['predictedRawPixel'],tpx)
            render_view(f'throw{ci}-cam{r["camera"]}',f'throw{ci}',r,True,
                        f'Validation throw · camera {r["camera"]}',f'Capture {cid} · retrospective target · {err:.1f}px localization error')
    for i,row in enumerate(empty_rows):
        render_view(f'empty{i}-cam{row["camera"]}',f'empty{i}',row,False,
                    f'Cross-visit empty pair · camera {row["camera"]}',
                    f'{row["baselineA"]} → {row["baselineB"]} · both endpoints reported empty; continuity is unknown')
    for case in sorted({v['caseKey'] for v in records}):
        group=[v for v in records if v['caseKey']==case]
        if group and group[0]['positive'] and len(group)==3:
            points=[v['cameraCandidateScore']['boardMm'] for v in group]
            mm=[sorted(p[i] for p in points)[1] for i in (0,1)]
            seg,value=score_segment(*mm)
            capture_id=capture_order[int(case.replace('throw',''))]
            reported_throw=json.loads((ROOT/'data/board-captures'/capture_id/'manifest.json').read_text())['reportedThrow']
            reported=reported_throw['segment']; reported_value=reported_throw['value']
            candidate={'segment':seg,'value':value,'boardMm':[mm[0],mm[1]]}
            for v in group:
                v['consensusScore']=candidate; v['boardReportedScore']={'segment':reported,'value':reported_value,'label':score_label(reported)}
                v['scoreMatch']=seg==reported
                misses=[str(x['camera']) for x in group if x['score']<.5]
                v['casePresencePassed']=not misses
                v['caseStatus']='Presence passed' if not misses else 'Rejected: missing presence in camera '+', '.join(misses)
        else:
            for v in group:
                v['consensusScore']=None; v['boardReportedScore']=None; v['scoreMatch']=None
                v['casePresencePassed']=None; v['caseStatus']=v['status']
    image_hashes=set()
    for r in rows+empty_rows:
        for k in ('imagePath','previousFrameImagePath','referenceImagePath'):
            if r.get(k): image_hashes.add(base.sha256(base.resolve_path(r[k])))
    positive_groups=[g for g in (records[i:i+3] for i in range(0,len(capture_order)*3,3))]
    negative_records=[r for r in records if not r['positive']]
    comparison={'positiveCaptures':len(positive_groups),
      'baselinePositivePassed':sum(all(x['baselineScore']>=.5 for x in g) for g in positive_groups),
      'v3PositivePassed':sum(all(x['v3Score']>=.5 for x in g) for g in positive_groups),
      'selectedPositivePassed':sum(all(x['score']>=.5 for x in g) for g in positive_groups),
      'realEmptyPairs':len(negative_records),
      'baselineFalsePositives':sum(x['baselineScore']>=.5 for x in negative_records),
      'v3FalsePositives':sum(x['v3Score']>=.5 for x in negative_records),
      'selectedFalsePositives':sum(x['score']>=.5 for x in negative_records)}
    provenance={'referenceAuditSHA256':base.sha256(audit_path),'referenceReviewRequired':True,'comparison':comparison,
      'keypointRun':str(keypoint_dir.relative_to(ROOT)),'baselineRun':'build/real-presence-model-v2',
      'presenceRun':str(presence_dir.relative_to(ROOT)),'candidateLabel':candidate_label,
      'model':str((presence_dir/'model.pt').relative_to(ROOT)),
      'modelSHA256':base.sha256(presence_dir/'model.pt'),'architecture':ck.get('metadata',{}).get('presenceArchitecture',ck.get('metadata',{}).get('architecture')),
      'baselineModelSHA256':base.sha256(baseline_dir/'model.pt'),
      'v3ModelSHA256':base.sha256(v3_dir/'model.pt'),'v3Run':str(v3_dir.relative_to(ROOT)),
      'threshold':.5,'validationTuningData':True,
      'targets':'build/real-keypoints-retrospective-v1/targets.json','targetsSHA256':base.sha256(ROOT/'build/real-keypoints-retrospective-v1/targets.json'),
      'excludedVisibilityCaptures':sorted(excluded),'positiveViews':sum(x['positive'] for x in records),
      'positiveCaptures':len(capture_order),'emptyViews':sum(not x['positive'] for x in records),'imageSHA256':sorted(image_hashes)}
    page=HTML.replace('__DATA__',json.dumps(records,separators=(',',':'))).replace('__PROVENANCE__',json.dumps(provenance,separators=(',',':')))
    (out/'index.html').write_text(page)
    print(json.dumps({'output':str(out/'index.html'),'views':len(records),'provenance':provenance},indent=2))

HTML=r'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Detector inspection · offline validation</title><style>
:root{color-scheme:dark;--bg:#0b1015;--panel:#121a22;--line:#26333f;--muted:#9babb8;--teal:#43e4d2;--yellow:#ffd54f}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 50% -20%,#1c3440 0,#0b1015 60%);color:#eef5f7;font:15px/1.5 system-ui,sans-serif}.wrap{max-width:1450px;margin:auto;padding:28px 24px 70px}header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:20px}.eyebrow{color:var(--teal);font:700 11px ui-monospace;letter-spacing:.17em;text-transform:uppercase}h1{font-size:clamp(26px,4vw,40px);letter-spacing:-.04em;margin:4px 0}p{color:var(--muted);margin:4px 0}.badge{border:1px solid #3c5963;background:#10252a;border-radius:999px;color:#a4f5eb;padding:8px 12px;font-size:12px;white-space:nowrap}.intro,.stage,.side{background:linear-gradient(145deg,#141e27,#10171e);border:1px solid var(--line);border-radius:16px}.intro{padding:17px 20px;margin:16px 0 20px;display:grid;grid-template-columns:1.5fr 1fr;gap:16px}.intro strong{color:#edf8f8}.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:12px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}.dot.cyan{background:var(--teal)}.dot.yellow{background:var(--yellow)}.layout{display:grid;grid-template-columns:minmax(0,1fr) 350px;gap:18px}.stage{padding:16px}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.tabs,.modes{display:flex;gap:6px;flex-wrap:wrap}.btn{background:#17232d;color:#b8c7cf;border:1px solid #2a3a46;padding:8px 11px;border-radius:9px;cursor:pointer;font-weight:650}.btn:hover,.btn.active{color:#f3fffd;background:#17343a;border-color:#3a9e97}.views{display:grid;grid-template-columns:1fr 1fr;gap:12px}.view{background:#0a0e12;border:1px solid #283540;border-radius:12px;overflow:hidden;cursor:zoom-in}.view h3{margin:0;padding:9px 11px;font-size:12px;color:#bdcbd1;font-weight:650}.image-frame{position:relative;width:100%;aspect-ratio:16/9;background:#080b0e}.image-frame img{display:block;width:100%;height:100%;object-fit:contain}.image-frame svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.caption{font-size:11px;color:#82929d;padding:5px 11px 9px}.side{padding:17px;height:max-content;position:sticky;top:14px}.side h2{font-size:15px;margin:0 0 6px}.samplelist{display:grid;gap:7px;max-height:50vh;overflow:auto;margin:12px 0}.sample{width:100%;text-align:left;padding:10px;border-radius:10px;background:#101820;border:1px solid #26343e;color:#d8e2e5;cursor:pointer}.sample.active{border-color:#42bcb3;background:#14282b}.sample small{display:block;color:#93a3ad;margin-top:2px}.score{font-size:27px;font-weight:750;letter-spacing:-.04em;margin:15px 0 0}.score small{font-size:11px;font-weight:500;letter-spacing:0;color:var(--muted)}.metric{display:flex;justify-content:space-between;border-top:1px solid #27333c;padding:8px 0;color:var(--muted);font-size:12px}.metric b{color:#edf5f5;font-weight:600}.foot{margin-top:18px;border-top:1px solid #24313a;padding-top:15px;color:#9baab3;font-size:12px}.foot summary{cursor:pointer;color:#c7d5da}.modal{display:none;position:fixed;inset:0;background:#05080def;z-index:4;align-items:center;justify-content:center;padding:20px;cursor:zoom-out}.modal.open{display:flex}.modal .image-frame{width:min(92vw,156vh,1600px);max-width:100%;height:auto;aspect-ratio:16/9;border:1px solid #35434d;border-radius:10px;overflow:hidden}.smallnote{font-size:11px;color:#748690}@media(max-width:950px){.layout{grid-template-columns:1fr}.side{position:static}.intro{grid-template-columns:1fr}.samplelist{grid-template-columns:1fr 1fr;max-height:none}}@media(max-width:620px){.wrap{padding:16px 12px 40px}.views{grid-template-columns:1fr}.toolbar{align-items:flex-start;flex-direction:column}.badge{white-space:normal}}
</style></head><body><main class="wrap"><header><div><div class="eyebrow">Offline model inspection · validation examples</div><h1>What the detector sees</h1><p>RGB image pairs, their signed change, and the model’s spatial evidence.</p></div><span class="badge">STATIC EXPORT · NO BOARD CONNECTION</span></header><section class="intro"><div><strong>Input pair:</strong> current frame + reference frame + signed current-minus-reference difference. Images are resized to 640×360 before inference. Coordinates, calibration, and board geometry are not model inputs.</div><div><div class="legend"><span><i class="dot cyan"></i>Prediction marker · display overlay</span><span><i class="dot yellow"></i>Retrospective target · display overlay</span></div><p class="smallnote">Markers are added for inspection; they are not part of any model input.</p></div></section><section class="intro" style="display:block"><strong>Validation comparison at threshold 0.5</strong><div id="comparison-summary"></div><p class="smallnote">Capture passes require presence in all three views. Empty-pair false positives are counted per pair.</p></section><div class="layout"><section class="stage"><div class="toolbar"><div class="tabs" id="cameras"></div><div class="modes" id="modes"></div></div><div class="views" id="views"></div><div class="foot">Heatmap colors show relative spatial softmax evidence for this image only; they are not calibrated confidence. Signed difference is amplified ×3 around middle gray. Click any panel to enlarge it. Prediction markers are shown on current RGB and heatmap for comparison.</div></section><aside class="side"><section class="intro" style="display:block;padding:12px;margin-top:14px"><strong>3-camera candidate</strong><div class="score" id="combined"></div><div id="reported"></div><p class="smallnote" id="case-status"></p></section><h2>Examples</h2><p>Positive references are hash matched to the visual audit. Empty pairs are trainer curated and image hash verified; endpoints without a matching visual audit are labeled in the selected example.</p><div class="tabs" id="filters"></div><div class="smallnote" id="result-count"></div><div class="samplelist" id="samples"></div><div class="score" id="score"></div><div id="metrics"></div><div class="foot"><details><summary>Data and limits</summary><p id="prov"></p><p>Labels use retrospective board-plane projections. The validation split was used for checkpoint selection; the presence threshold is fixed at 0.5. Per-camera and 3-camera scores project image-derived candidate pixels through retrospective calibration. The 3-camera coordinate median is a diagnostic candidate; all three presence scores must reach 0.5 for its diagnostic gate. Board reports are comparison labels only. This is not the live detector or full native-service acceptance flow.</p></details></div></aside></div></main><div class="modal" id="modal"><div class="image-frame" id="zoom-frame"></div></div><script>
const DATA=__DATA__, PROV=__PROVENANCE__;
const CASES=[...new Set(DATA.map(v=>v.caseKey))];
let caseKey=CASES.find(k=>k==='throw3')||CASES[0], camera=0, showTarget=true, statusFilter='all', renderedFilter='all', renderedCaseKey='';
const $=s=>document.querySelector(s);
function subset(){return DATA.filter(v=>v.caseKey===caseKey)}
function current(){return subset().find(v=>Number(v.camera)===camera)||subset()[0]}
function chooseCamera(key){const g=DATA.filter(v=>v.caseKey===key);if(statusFilter==='miss')return Number((g.find(v=>v.score<.5)||g[0]).camera);if(statusFilter==='success')return Number((g.find(v=>v.score>=.5)||g[0]).camera);return Number(g[0].camera)}
function selectCase(key){caseKey=key;camera=chooseCamera(key);render()}
function visibleCases(){return CASES.filter(k=>{const g=DATA.filter(v=>v.caseKey===k),x=g[0];if(statusFilter==='wrong-score')return x.positive&&x.scoreMatch===false;if(statusFilter==='segment-disagreement')return x.positive&&x.consensusScore&&g.some(v=>v.cameraCandidateScore.segment.ring!==x.consensusScore.segment.ring||v.cameraCandidateScore.segment.number!==x.consensusScore.segment.number);const outcome=x.positive?(g.every(v=>v.score>=.5)?'success':'miss'):x.status;return statusFilter==='all'||outcome===statusFilter})}
function scoreText(s){if(!s)return 'Unavailable';const r=s.segment.ring,n=s.segment.number;const label=r==='BULL'?'Bull':r==='OUTER_BULL'?'Outer bull':r==='MISS'?'Miss':(r==='DOUBLE'?'D':r==='TRIPLE'?'T':'S')+n;return `${label} · ${s.value}`}
function render(){
  const c=PROV.comparison;$('#comparison-summary').innerHTML=`<div class="metric"><span>3-camera positive captures</span><b>v2 ${c.baselinePositivePassed}/${c.positiveCaptures} · v3 ${c.v3PositivePassed}/${c.positiveCaptures} · ${PROV.candidateLabel} ${c.selectedPositivePassed}/${c.positiveCaptures}</b></div><div class="metric"><span>Real-empty false-positive camera views</span><b>v2 ${c.baselineFalsePositives}/${c.realEmptyPairs} · v3 ${c.v3FalsePositives}/${c.realEmptyPairs} · ${PROV.candidateLabel} ${c.selectedFalsePositives}/${c.realEmptyPairs}</b></div>`;
  const available=visibleCases();
  $('#filters').innerHTML=[['all','All'],['miss','Positive misses'],['success','Positive successes'],['false-positive','False positives'],['true-negative','True negatives'],['wrong-score','Score mismatches'],['segment-disagreement','Camera segment disagreements']].map(([id,label])=>`<button class="btn ${statusFilter===id?'active':''}" onclick="statusFilter='${id}';render()">${label}</button>`).join('');
  if(!available.length){$('#result-count').textContent='Showing 0 of '+CASES.length+' cases';$('#samples').innerHTML='<div class="smallnote">No matching cases.</div>';$('#views').innerHTML='';$('#cameras').innerHTML='';$('#score').innerHTML='';$('#combined').textContent='Unavailable';$('#reported').innerHTML='';$('#case-status').textContent='No matching cases';$('#metrics').innerHTML='';renderedFilter=statusFilter;renderedCaseKey='';return}
  if(!available.includes(caseKey))caseKey=available[0];
  const filterOrCaseChanged=statusFilter!==renderedFilter||caseKey!==renderedCaseKey;
  if(filterOrCaseChanged&&(statusFilter==='miss'||statusFilter==='success'))camera=chooseCamera(caseKey);
  else if(!subset().some(x=>Number(x.camera)===camera))camera=Number(subset()[0].camera);
  renderedFilter=statusFilter;renderedCaseKey=caseKey;
  const v=current();camera=Number(v.camera);
  $('#cameras').innerHTML=[0,1,2].map(c=>`<button class="btn ${camera===c?'active':''}" data-camera="${c}" onclick="camera=${c};render()" ${subset().some(a=>Number(a.camera)===c)?'':'disabled'}>Camera ${c}</button>`).join('')+`<button id="target-toggle" class="btn ${showTarget?'active':''}" aria-pressed="${showTarget}" onclick="showTarget=!showTarget;render()">Target overlay ${showTarget?'on':'off'}${v.target?'':' · unavailable'}</button>`;
  const names={current:'Current RGB · model input',reference:'Reference RGB · model input',difference:'Signed difference · ×3 around gray',heat:'Predicted impact heatmap'};
  $('#views').innerHTML=['current','reference','difference','heat'].map(m=>{
    const src=m==='heat'?v.heatBase:v.images[m];
    const marker=m==='current'||m==='heat';
    const prediction=v.prediction?`<path d="M ${v.prediction[0]-20} ${v.prediction[1]} H ${v.prediction[0]+20} M ${v.prediction[0]} ${v.prediction[1]-20} V ${v.prediction[1]+20}" fill="none" stroke="#061015" stroke-width="6"/><path d="M ${v.prediction[0]-20} ${v.prediction[1]} H ${v.prediction[0]+20} M ${v.prediction[0]} ${v.prediction[1]-20} V ${v.prediction[1]+20}" fill="none" stroke="#26e6dc" stroke-width="2.5"/><circle cx="${v.prediction[0]}" cy="${v.prediction[1]}" r="5" fill="#26e6dc" stroke="#061015" stroke-width="2"/>`:'';
    const target=showTarget&&v.target?`<circle cx="${v.target[0]}" cy="${v.target[1]}" r="23" fill="none" stroke="#17120a" stroke-width="7"/><circle cx="${v.target[0]}" cy="${v.target[1]}" r="23" fill="none" stroke="#ffd54f" stroke-width="3.5"/><text x="${v.target[0]+28}" y="${v.target[1]-17}" fill="#17120a" stroke="#17120a" stroke-width="5" font-size="20" font-weight="800">T</text><text x="${v.target[0]+28}" y="${v.target[1]-17}" fill="#ffd54f" font-size="20" font-weight="800">T</text>`:'';
    const overlays=marker?`<svg viewBox="0 0 1280 720" preserveAspectRatio="none" aria-hidden="true">${prediction}${target}</svg>`:'';
    return `<div class="view" data-panel="${m}" data-src="${src}"><h3>${names[m]}</h3><div class="image-frame"><img src="${src}" alt="${names[m]}"/>${overlays}</div><div class="caption">${m==='heat'?v.detail:(m==='difference'?'Display amplification only; the model uses signed differences without amplification.':'640×360 model input, shown enlarged. Any markers are display overlays, not model inputs.')}</div></div>`;
  }).join('');
  const visible=available;
  $('#result-count').textContent=`Showing ${visible.length} of ${CASES.length} cases`;
  $('#samples').innerHTML=visible.map(key=>{
    const group=DATA.filter(v=>v.caseKey===key), a=group[0];
    const title=a.positive?`Throw ${Number(key.replace('throw',''))+1} · all three cameras`:`Real empty · camera ${a.camera}`;
    const detail=a.positive?`${a.caseStatus} · ${scoreText(a.consensusScore)} · v2/v3/${PROV.candidateLabel} ${a.baselineScore.toFixed(2)}/${a.v3Score.toFixed(2)}/${a.score.toFixed(2)}`:`${a.status.replace('-',' ')} · ${a.reviewedEndpoints?'visually reviewed endpoints':'endpoints not fully in visual audit'} · v2/v3/${PROV.candidateLabel} ${a.baselineScore.toFixed(3)}/${a.v3Score.toFixed(3)}/${a.score.toFixed(3)}`;
    return `<button class="sample ${key===caseKey?'active':''}" data-case="${key}" onclick="selectCase('${key}')">${title}<small>${detail}</small></button>`;
  }).join('');
  $('#score').innerHTML=`${v.score.toFixed(3)} <small>${PROV.presenceRun.split('/').pop()} selected score · camera ${v.camera}</small>`;
  $('#combined').textContent=v.consensusScore?scoreText(v.consensusScore):'Unavailable';
  $('#reported').innerHTML=v.boardReportedScore?`<div class="metric"><span>Board reported</span><b>${scoreText(v.boardReportedScore)}</b></div><div class="metric"><span>Comparison with board report</span><b>${v.scoreMatch?'Match':v.labelReview?'Mismatch · board label disputed':'Mismatch'}</b></div>`:`<div class="metric"><span>Board reported</span><b>No throw</b></div>`;
  $('#case-status').textContent=(v.positive?`${v.caseStatus} · presence gate only`:`${v.caseStatus}; combined score unavailable`)+(v.labelReview?' · '+v.labelReview.note:'');
  $('#case-status').style.color=v.casePresencePassed===true?'#a4f5ce':'#ffc58b';
  $('#metrics').innerHTML=`<div class="metric"><span>Presence v2</span><b>${v.baselineScore.toFixed(3)} · ${v.baselineStatus}</b></div><div class="metric"><span>Spatial v3</span><b>${v.v3Score.toFixed(3)} · ${v.v3Score>=.5?'present':'missing'}</b></div><div class="metric"><span>${PROV.candidateLabel}</span><b>${v.score.toFixed(3)} · ${v.status}</b></div><div class="metric"><span>Per-camera candidate</span><b>${v.cameraCandidateScore?scoreText(v.cameraCandidateScore):'Unavailable'}</b></div><div class="metric"><span>Candidate pixel</span><b>${v.prediction?v.prediction.map(Math.round).join(', '):'—'}</b></div><div class="metric"><span>Target pixel</span><b>${showTarget&&v.target?v.target.map(Math.round).join(', '):'hidden / unavailable'}</b></div><div class="metric"><span>Point error</span><b>${v.error===null?'—':v.error+' px'}</b></div><p class="smallnote">Presence scores are not calibrated probabilities. Scores are diagnostic candidates; the full service acceptance flow is not modeled.</p>`;
  $('#prov').textContent=`Presence v2 ${PROV.baselineModelSHA256.slice(0,12)}…, spatial v3 ${PROV.v3ModelSHA256.slice(0,12)}…, ${PROV.candidateLabel} ${PROV.modelSHA256.slice(0,12)}…; selected architecture ${PROV.architecture}. ${PROV.positiveCaptures} positive captures / ${PROV.positiveViews} camera views and ${PROV.emptyViews} real-empty views. Fixed threshold 0.5. Visibility exclusions: ${PROV.excludedVisibilityCaptures.length}.`;
}
document.addEventListener('click',e=>{let d=e.target.closest('.view');if(d){$('#zoom-frame').innerHTML=d.querySelector('.image-frame').innerHTML;$('#modal').classList.add('open')}});$('#modal').onclick=()=>$('#modal').classList.remove('open');render();</script></body></html>'''
if __name__=='__main__': main()
