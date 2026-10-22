// Families, rather than individual frames or variants, own their split permanently.
export const SCENARIO_SEED = 20261001;
export const SCENARIO_VERSION = 4;
// Same provisional horizontal baseline as the browser, with varied mounting geometry.
export const SCENARIO_HORIZONTAL_FOV = 100;
export const SCENARIO_VERTICAL_FOV = 2 * Math.atan(Math.tan(SCENARIO_HORIZONTAL_FOV * Math.PI / 360) * 720 / 1280) * 180 / Math.PI;
export function random(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

export function detectionScenarios({ small = false } = {}) {
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
  return cases;
}
