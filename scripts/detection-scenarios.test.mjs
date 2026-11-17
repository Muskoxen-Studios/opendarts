import assert from 'node:assert/strict';
import test from 'node:test';
import { detectionScenarios, boundaryScenarios, defaultMountScenarios, SCENARIO_VERSION } from './detection-scenarios.mjs';

// Standard board radii in mm; measured independently from scenario construction.
const radii = [7, 17, 97, 107, 160, 170];
function scoringMargin({ x, y }) {
  const radius = Math.hypot(x, y);
  const angle = Math.atan2(x, y);
  const sweep = Math.PI / 10;
  const fromCentre = Math.abs(angle - Math.round(angle / sweep) * sweep);
  return Math.min(...radii.map(r => Math.abs(radius - r)),
    (radius > 17 && radius < 170 ? radius * Math.sin(sweep / 2 - fromCentre) : Infinity));
}

for (const small of [true, false]) {
  test(`deterministic, unique, family-isolated cases (small=${small})`, () => {
    const cases = detectionScenarios({ small, suite: 'legacy' });
    assert.deepEqual(cases, detectionScenarios({ small, suite: 'legacy' }));
    assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
    const splits = new Map();
    for (const c of cases) {
      if (splits.has(c.family)) assert.equal(c.split, splits.get(c.family));
      splits.set(c.family, c.split);
    }
    assert.deepEqual(Object.fromEntries(splits), {
      perpendicular: 'train', dimensions: 'train', 'empty-noise': 'train',
      tilted: 'validation', 'cluster-occlusion': 'validation', lighting: 'validation',
      shallow: 'test', nearwire: 'test', 'missing-view': 'test',
    });
    assert.equal(cases.length, small ? 33 : 66);
    assert.equal(cases.reduce((n, c) => n + c.steps.length, 0), small ? 132 : 264);
  });

  test(`ordinary darts have at least 10 mm scoring margin (small=${small})`, () => {
    for (const c of detectionScenarios({ small, suite: 'legacy' })) {
      if (['nearwire', 'cluster-occlusion'].includes(c.family)) continue;
      for (const step of c.steps) for (const dart of step.darts) {
        assert.ok(scoringMargin(dart) >= 10, `${c.id}: ${JSON.stringify(dart)}`);
      }
    }
  });

  test(`every sequence model has an independent case with its effects (small=${small})`, () => {
    const cases = detectionScenarios({ small, suite: 'legacy' });
    for (const sequence of cases.filter(c => !c.id.includes('-single-') && c.family !== 'empty-noise')) {
      assert.equal(sequence.steps[3].darts.length, 3);
      for (let i = 0; i < 3; i++) {
        const single = cases.find(c => c.id === `${sequence.id}-single-${i}`);
        assert.ok(single);
        assert.equal(single.family, sequence.family);
        assert.equal(single.split, sequence.split);
        assert.deepEqual(single.rig, sequence.rig);
        assert.deepEqual(single.steps.map(s => s.darts.length), [0, 1, 0]);
        assert.deepEqual(single.steps[0], sequence.steps[0]);
        assert.deepEqual(single.steps[1], { ...sequence.steps[i + 1], darts: [sequence.steps[3].darts[i]] });
        assert.deepEqual(single.steps[2], sequence.steps.at(-1));
      }
    }
  });
}

test('small case identities retain family and split in the full dataset', () => {
  const full = new Map(detectionScenarios({ suite: 'legacy' }).map(c => [c.id, c]));
  // RNG traversal differs after the first family; split ownership, not coordinates, must be stable.
  for (const c of detectionScenarios({ small: true, suite: 'legacy' })) {
    assert.equal(c.split, full.get(c.id).split);
    assert.equal(c.family, full.get(c.id).family);
  }
});

test('mild noise is required, hard noise and explicit difficult darts remain', () => {
  assert.equal(SCENARIO_VERSION, 6);
    for (const c of detectionScenarios({ suite: 'legacy' })) for (const step of c.steps) for (const dart of step.darts) {
      assert.equal(dart.penetration, 8);
      assert.ok(dart.penetration <= (dart.point ?? 28) - 2);
    }
  const cases = detectionScenarios({ suite: 'legacy' });
  for (const c of cases.filter(c => c.family === 'empty-noise')) {
    assert.equal(c.steps[1].effect.noise, 1);
    assert.equal(c.steps[1].allowReject, false);
    assert.equal(c.steps[2].effect.noise, 8);
    assert.equal(c.steps[2].allowReject, true);
  }
  for (const c of cases.filter(c => ['nearwire', 'cluster-occlusion', 'missing-view'].includes(c.family))) {
    for (const s of c.steps.filter(s => s.darts.length)) assert.equal(s.allowReject, true);
  }
  const nearwire = cases.find(c => c.id === 'nearwire-0');
  assert.ok(scoringMargin(nearwire.steps[2].darts[1]) < 1);
  const cluster = cases.find(c => c.id === 'cluster-occlusion-0');
  assert.deepEqual(cluster.steps[3].darts.map(d => [d.x, d.y]), [[-4, 100], [0, 102], [4, 104]]);
});

test('version-6 rigs use the explicit 100-degree horizontal baseline at 720p', () => {
  for (const { rig } of detectionScenarios({ suite: 'legacy' })) {
    const horizontal = 2 * Math.atan(Math.tan(rig.vfov * Math.PI / 360) * 1280 / 720) * 180 / Math.PI;
    assert.ok(Math.abs(horizontal - 100) < 1e-10);
  }
});

test('default desktop mount regression stays train-only and covers first dart, interior, sequence and removal', () => {
  const cases = defaultMountScenarios();
  assert.equal(cases.length, 3);
  assert.deepEqual(cases, defaultMountScenarios());
  assert.ok(cases.every(c => c.family === 'default-mount' && c.split === 'train'));
  assert.ok(cases.every(c => c.rig.radius === 260 && c.rig.forward === 220 && c.rig.rotation === 60));
  const first = cases.find(c => c.id === 'default-mount-first-dart');
  assert.deepEqual(first.steps[1].darts[0], { x: 0, y: 102, roll: 0, penetration: 8 });
  const interior = cases.find(c => c.id === 'default-mount-interior');
  assert.deepEqual(interior.steps.map(s => s.darts.length), [0, 1, 0]);
  const sequence = cases.find(c => c.id === 'default-mount-sequence-removal');
  assert.deepEqual(sequence.steps.map(s => s.darts.length), [0, 1, 2, 3, 2, 1, 0]);
  assert.deepEqual(sequence.steps[4].darts, sequence.steps[3].darts.slice(1));
  assert.deepEqual(sequence.steps[5].darts, sequence.steps[3].darts.slice(2));
  assert.deepEqual(detectionScenarios({ suite: 'legacy' }).some(c => c.family === 'default-mount'), false);
  assert.equal(detectionScenarios().filter(c => c.family === 'default-mount').length, 3);
});

for (const small of [true, false]) {
  test(`boundary suite covers both sides with independent splits (small=${small})`, () => {
    const cases = boundaryScenarios({ small });
    assert.equal(cases.length, small ? 39 : 87);
    assert.deepEqual(cases, boundaryScenarios({ small }));
    const families = new Map();
    for (const c of cases) {
      if (families.has(c.family)) assert.equal(families.get(c.family), c.split);
      families.set(c.family, c.split);
      assert.deepEqual(c.steps.map(s => s.darts.length), [0, 1, 0]);
      const step = c.steps[1];
      const margin = scoringMargin(step.darts[0]);
      if (c.id.endsWith('interior')) assert.ok(margin > 10);
      else {
        // Bull-adjacent wedge centres can be nearer a spoke than the radial ring.
        assert.ok(margin >= (step.allowReject ? 0.6 : 3) - 1e-10, c.id);
        assert.ok(margin <= (step.allowReject ? 0.6 : 3) + 1e-10, c.id);
      }
    }
    for (const split of ['train', 'validation', 'test']) {
      const scenes = cases.filter(c => c.split === split);
      assert.equal(scenes.filter(c => c.steps[1].allowReject).length, small ? 6 : 14);
      assert.equal(scenes.filter(c => !c.steps[1].allowReject).length, small ? 7 : 15);
    }
    assert.equal(detectionScenarios({ small }).length, cases.length + detectionScenarios({ small, suite: 'legacy' }).length + 3);
  });
}
