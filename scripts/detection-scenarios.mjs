// Families, rather than individual frames or variants, own their split permanently.
export const SCENARIO_SEED = 20261001;
export const SCENARIO_VERSION = 6;
// Same provisional horizontal baseline as the browser, with varied mounting geometry.
export const SCENARIO_HORIZONTAL_FOV = 100;
export const SCENARIO_VERTICAL_FOV = 2 * Math.atan(Math.tan(SCENARIO_HORIZONTAL_FOV * Math.PI / 360) * 720 / 1280) * 180 / Math.PI;
export function random(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

export function detectionScenarios({ small = false, suite = 'all' } = {}) {
  if (!['all', 'boundary', 'legacy'].includes(suite)) throw new Error('Unknown scenario suite');
  const rng = random(SCENARIO_SEED);
  const families = [
    ['perpendicular', 'train'], ['dimensions', 'train'], ['empty-noise', 'train'],
    ['tilted', 'validation'], ['cluster-occlusion', 'validation'], ['lighting', 'validation'],
    ['shallow', 'test'], ['nearwire', 'test'], ['missing-view', 'test'],
  ];
  const cases = [];
  for (const [family, split] of families) {
    for (let variant = 0; variant < (small ? 1 : 2); variant++) {
      const jitter = () => rng() - 0.5;
      // Inner singles at wedge centres: even with jitter, every scoring wire is >10 mm away.
      // Explicit axial burial; dimensions family includes a 12 mm total point.
            // Placement is deliberately unrestricted, especially for near-wire stress cases.
            const base = { x: jitter(), y: 70 + jitter(), roll: Math.round(rng() * 180), penetration: 8 };
      const x = 70 * Math.sin(3 * Math.PI / 10), y = 70 * Math.cos(3 * Math.PI / 10);
      let specs = [base, { ...base, x: x + jitter(), y: y + jitter() },
        { ...base, x: -x + jitter(), y: -y + jitter() }];
      if (family === 'tilted') specs = specs.map((d, i) => ({ ...d, tiltX: 18 + i * 8, tiltY: -12 - i * 6 }));
      // Shallow insertion is still inside validDart's per-axis 45-degree limit.
      if (family === 'shallow') specs = specs.map((d, i) => ({ ...d, tiltX: 40 + i * 2, tiltY: -40 + i * 2 }));
      if (family === 'dimensions') specs = specs.map((d, i) => ({ ...d, point: 12 + i * 14, barrel: 28 + i * 17,
        barrelDiameter: 4.5 + i * 2.5, shaft: 18 + i * 19, flightLength: 23 + i * 14,
        flightWidth: 9 + i * 7, flightThickness: 0.25 + i * 0.3 }));
      if (family === 'cluster-occlusion') specs = specs.map((d, i) => ({ ...d, x: -4 + i * 4 + variant,
        y: 100 + i * 2, tiltX: 12 - i * 10, tiltY: 8, flightWidth: 24, roll: i * 45 }));
      if (family === 'nearwire') specs = [
        { ...base, x: 0, y: 99.2 + variant * 0.3 },
        { ...base, x: 0, y: 170 - 0.4 - variant * 0.2 },
        { ...base, x: Math.sin(Math.PI / 20) * 75 + 0.2, y: Math.cos(Math.PI / 20) * 75 },
      ];
      const difficult = ['cluster-occlusion', 'nearwire', 'missing-view'].includes(family);
      const step = (darts, effect, allowReject = difficult && darts.length > 0) => ({ darts, effect, allowReject });
      let steps = [step([], undefined, false), ...specs.map((_, i) => step(specs.slice(0, i + 1))),
        step(specs.slice(1)), step(specs.slice(2)), step([], undefined, false)];
      if (family === 'empty-noise') steps = [step([], undefined, false), step([], { noise: 1, seed: 100 + variant }, false),
        step([], { noise: 8, seed: 200 + variant }, true), step([], undefined, false)];
      if (family === 'lighting') steps = steps.map((s, i) => ({ ...s,
        // Sensor exposure/gain perturbations, not a claim of changing scene lights.
        effect: i ? { gain: i % 2 ? 0.82 : 1.12, offset: i % 2 ? 8 : -5 } : undefined,
        allowReject: i > 0 }));
      if (family === 'missing-view') steps = steps.map((s, i) => ({ ...s,
        effect: i > 0 && i < 6 ? { frozenCamera: `cam${variant % 3}` } : undefined }));
      const rig = { radius: 340 + variant * 20, forward: 160 + variant * 20, rotation: variant * 17, vfov: SCENARIO_VERTICAL_FOV };
      cases.push({ id: `${family}-${variant}`, family, split, rig, steps });
      // Separate cases reset detector state, so a latched first-dart fault cannot hide later models.
      if (family !== 'empty-noise') specs.forEach((dart, i) => {
        cases.push({ id: `${family}-${variant}-single-${i}`, family, split, rig,
          steps: [steps[0], { ...steps[i + 1], darts: [dart] }, steps.at(-1)] });
      });
    }
  }
  return suite === 'legacy' ? cases : suite === 'boundary' ? boundaryScenarios({ small }) : [...cases, ...defaultMountScenarios(), ...boundaryScenarios({ small })];
}

// Regression scenes at the application's default desktop mount. Keep these out
// of the historical suite so old benchmark comparisons remain reproducible.
export function defaultMountScenarios() {
  const family = 'default-mount';
  const split = 'train';
  const rig = { radius: 260, forward: 220, rotation: 60, vfov: SCENARIO_VERTICAL_FOV };
  const dart = (x, y, roll = 0) => ({ x, y, roll, penetration: 8 });
  const first = dart(0, 102);
  const second = dart(28, 111, 37);
  const third = dart(-24, 84, 91);
  return [
    { id: 'default-mount-interior', family, split, rig,
      steps: [{ darts: [], allowReject: false }, { darts: [dart(0, 70)], allowReject: false }, { darts: [], allowReject: false }] },
    { id: 'default-mount-first-dart', family, split, rig,
      steps: [{ darts: [], allowReject: false }, { darts: [first], allowReject: false }, { darts: [], allowReject: false }] },
    { id: 'default-mount-sequence-removal', family, split, rig,
      steps: [{ darts: [], allowReject: false }, { darts: [first], allowReject: false },
        { darts: [first, second], allowReject: false }, { darts: [first, second, third], allowReject: false },
        { darts: [second, third], allowReject: false }, { darts: [third], allowReject: false },
        { darts: [], allowReject: false }] },
  ];
}

// Matched difficulty strata in each split, with disjoint scene families/mounts/tilts.
// No variants of a scene cross splits. These use the application's scoring radii.
export function boundaryScenarios({ small = false } = {}) {
  const cases = [];
  for (const [index, split] of ['train', 'validation', 'test'].entries()) {
    const family = `boundary-${split}`;
    const rig = { radius: 290 + index * 23, forward: 210 - index * 17,
      rotation: 37 + index * 29, vfov: SCENARIO_VERTICAL_FOV };
    const lighting = { radius: 270 + index * 12, forward: 180 - index * 15,
      intensity: [1, 0.8, 1.2][index], ambient: [0.35, 0.25, 0.45][index], rotation: index * 7 };
    const dart = { penetration: 8, tiltX: [8, -17, 23][index], tiltY: [-5, 11, -19][index], roll: 13 + index * 31 };
    const add = (id, x, y, allowReject) => cases.push({ id: `${family}-${id}`, family, split, rig, lighting,
      steps: [{ darts: [], allowReject: false }, { darts: [{ ...dart, x, y }], allowReject },
        { darts: [], allowReject: false }] });
    add('interior', 0, 70, false);
    const boundaries = small ? [97, 170, 'spoke'] : [7, 17, 97, 107, 160, 170, 'spoke'];
    for (const boundary of boundaries) for (const margin of [0.6, 3]) for (const side of [-1, 1]) {
      // Rotate radial cases between independent wedge centres; signed normal offsets
      // put spoke entries exactly margin mm from the same physical wire.
      const angle = (index * 3 + (boundary === 'spoke' ? 0.5 : 0)) * Math.PI / 10;
      const radius = boundary === 'spoke' ? 75 : boundary + side * margin;
      const x = radius * Math.sin(angle) + (boundary === 'spoke' ? side * margin * Math.cos(angle) : 0);
      const y = radius * Math.cos(angle) - (boundary === 'spoke' ? side * margin * Math.sin(angle) : 0);
      add(`${boundary}-${margin}-${side}`, x, y, margin < 1);
    }
  }
  return cases;
}
