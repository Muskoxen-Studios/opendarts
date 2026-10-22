import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { BOARD_MM } from '@darts/schema';
import { cameraCalibration, DEFAULT_DART, DEFAULT_RIG, dartMesh, disposeObject, FRAME_HEIGHT, FRAME_WIDTH,
  boardImpact, boardWires, BOARD_WIRE, WIRE_RADII, wireSpokes, placementProblem, DEFAULT_PENETRATION, impactMarkers, grayBase64, rgbaToGray, rigCameras, validDart, validRig } from './cameraRig3d.ts';

import { placementClick, renderedResults, type NativeState } from './nativeDetector.ts';

afterEach(() => vi.restoreAllMocks());

describe('interactive overview', () => {
  it('picks the board plane from an oblique view and rejects outside/behind hits', () => {
    const camera = new THREE.PerspectiveCamera(50, 4 / 3, 1, 2500);
    camera.position.set(450, 320, 650); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
    const target = new THREE.Vector3(32, 108, 0).project(camera);
    const hit = boardImpact(camera, target.x, target.y)!;
    expect(hit.x).toBeCloseTo(32); expect(hit.y).toBeCloseTo(108);
    const outside = new THREE.Vector3(230, 0, 0).project(camera);
    expect(boardImpact(camera, outside.x, outside.y)).toBeNull();
    camera.lookAt(900, 640, 1300);
    expect(boardImpact(camera, 0, 0)).toBeNull();
  });

  it('rejects orbit drags even when the pointer returns to its origin', () => {
    expect(placementClick({ x: 10, y: 10 }, { x: 12, y: 11 }, 3)).toBe(true);
    expect(placementClick({ x: 10, y: 10 }, { x: 10, y: 10 }, 30)).toBe(false);
    expect(placementClick({ x: 10, y: 10 }, { x: 20, y: 10 }, 0)).toBe(false);
  });

  it('excludes every actual/detector/uncertainty annotation from all camera inputs', () => {
    const markers = impactMarkers([{ x: 0, y: 102 }], [{ x: 2, y: 103, uncertaintyMm: 4 }]);
    expect(markers.children).toHaveLength(3);
    for (const camera of rigCameras(DEFAULT_RIG)) markers.traverse(object => expect(object.layers.test(camera.layers)).toBe(false));
    const overviewLayers = new THREE.Layers(); overviewLayers.enable(1);
    markers.traverse(object => expect(object.layers.test(overviewLayers)).toBe(true));
    disposeObject(markers);
  });

  it('uses verified cam0 reconstructed rows once, never alternative hypotheses or malformed results', () => {
    const row = { impactMm: [2, 103], uncertaintyMm: 1.5, reprojectionPx: 0.4 };
    const state = { diagnostics: { cam0: { reconstructed: [row], hypotheses: [{ impactMm: [99, 99] }] },
      cam1: { reconstructed: [row] } } } as unknown as NativeState;
    expect(renderedResults(state)).toEqual([{ x: 2, y: 103, uncertaintyMm: 1.5, reprojectionPx: 0.4 }]);
    expect(renderedResults(null)).toEqual([]);
    for (const bad of [{ ...row, impactMm: [NaN, 1] }, { ...row, uncertaintyMm: -1 }, { ...row, reprojectionPx: Infinity }, { impactMm: [1, 2] }]) {
      expect(renderedResults({ diagnostics: { cam0: { reconstructed: [bad] } } } as unknown as NativeState)).toEqual([]);
    }
  });
});

describe('rendered camera calibration', () => {
  it('uses exact 720p intrinsics for the provisional 100-degree horizontal baseline', () => {
    expect([FRAME_WIDTH, FRAME_HEIGHT]).toEqual([1280, 720]);
    for (const camera of rigCameras(DEFAULT_RIG)) {
      const { K } = cameraCalibration(camera);
      expect(camera.fov).toBeCloseTo(2 * Math.atan(Math.tan(50 * Math.PI / 180) * 9 / 16) * 180 / Math.PI, 12);
      expect(K[0]).toBeCloseTo(640 / Math.tan(50 * Math.PI / 180), 10);
      expect(K[4]).toBe(K[0]);
      expect([K[2], K[5]]).toEqual([640, 360]);
    }
  });
  it('places three genuine perspective cameras 120 degrees apart on the default circle', () => {
    const cameras = rigCameras(DEFAULT_RIG);
    for (let i = 0; i < 3; i++) {
      const camera = cameras[i];
      expect(camera.isPerspectiveCamera).toBe(true);
      expect(Math.hypot(camera.position.x, camera.position.y)).toBeCloseTo(260);
      expect(camera.position.z).toBe(220);
      const next = cameras[(i + 1) % 3];
      const dot = (camera.position.x * next.position.x + camera.position.y * next.position.y) / 260 ** 2;
      expect(dot).toBeCloseTo(Math.cos(2 * Math.PI / 3));
      expect(new THREE.Vector3().project(camera).x).toBeCloseTo(0);
      expect(new THREE.Vector3().project(camera).y).toBeCloseTo(0);
    }
    expect(cameras[0].position.x).toBeCloseTo(130);
    expect(cameras[0].position.y).toBeCloseTo(260 * Math.sin(Math.PI / 3));
    expect(THREE.MathUtils.radToDeg(Math.atan2(DEFAULT_RIG.forward, DEFAULT_RIG.radius))).toBeCloseTo(40.2364, 3);
  });

  it('keeps every radial mount tangent horizontal and the nearby board edge below bull', () => {
    for (const camera of rigCameras(DEFAULT_RIG)) {
      const radial = new THREE.Vector3(camera.position.x, camera.position.y, 0).normalize();
      const tangent = new THREE.Vector3(-radial.y, radial.x, 0);
      const left = tangent.clone().multiplyScalar(-170).project(camera);
      const right = tangent.clone().multiplyScalar(170).project(camera);
      expect(left.y).toBeCloseTo(right.y);
      const near = radial.clone().multiplyScalar(170).project(camera);
      const far = radial.clone().multiplyScalar(-170).project(camera);
      expect(near.y).toBeLessThan(0);
      expect(far.y).toBeGreaterThan(0);
      // A provisional narrower vertical FOV can crop the physical outer board.
      // Do not widen it implicitly to preserve the old full-board framing.
      expect(camera.aspect).toBe(16 / 9);
      const horizontal = 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect) * 180 / Math.PI;
      expect(horizontal).toBeCloseTo(100, 10);
    }
  });

  it('matches independent pinhole projection to Three for off-plane and board points', () => {
    for (const camera of rigCameras({ ...DEFAULT_RIG, rotation: 17, forward: 145, vfov: 92 })) {
      const { K, R, t } = cameraCalibration(camera);
      expect(K[0]).toBeCloseTo((FRAME_HEIGHT / 2) / Math.tan(92 * Math.PI / 360));
      expect(K[0]).toBe(K[4]); expect(K[2]).toBe(640); expect(K[5]).toBe(360);
      for (const point of [new THREE.Vector3(), new THREE.Vector3(40, 102, 0), new THREE.Vector3(-60, -80, 92)]) {
        const p = point.toArray();
        const cv = t.map((value, row) => value + R[row * 3] * p[0] + R[row * 3 + 1] * p[1] + R[row * 3 + 2] * p[2]);
        expect(cv[2]).toBeGreaterThan(0);
        const u = K[0] * cv[0] / cv[2] + K[2];
        const v = K[4] * cv[1] / cv[2] + K[5];
        const projected = point.clone().project(camera);
        expect(u).toBeCloseTo((projected.x + 1) * FRAME_WIDTH / 2, 8);
        expect(v).toBeCloseTo((1 - projected.y) * FRAME_HEIGHT / 2, 8);
      }
      const rotation = new THREE.Matrix3().set(...R as [number, number, number, number, number, number, number, number, number]);
      expect(rotation.determinant()).toBeCloseTo(1);
    }
  });

  it('uses top-down grayscale, not RGBA or bottom-up detector bytes', () => {
    const rgba = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, // bottom row
      0, 0, 255, 255, 255, 255, 255, 255, // top row
    ]);
    const gray = rgbaToGray(rgba, 2, 2);
    expect([...gray]).toEqual([29, 255, 76, 150]);
    expect([...atob(grayBase64(gray))].map(char => char.charCodeAt(0))).toEqual([...gray]);
    expect(() => rgbaToGray(rgba, 3, 2)).toThrow('framebuffer');
  });
});

describe('raised board wires and optional placement', () => {
  it('uses schema ring radii and 20 wedge boundaries with raised solid geometry', () => {
    const wires = boardWires();
    expect(wires.children).toHaveLength(26);
    const spokes = wireSpokes();
    expect(spokes).toHaveLength(20);
    for (const line of spokes) {
      expect(Math.hypot(line.v1.x, line.v1.y)).toBeCloseTo(BOARD_MM.BULL_OUTER);
      expect(Math.hypot(line.v2.x, line.v2.y)).toBeCloseTo(BOARD_MM.DOUBLE_OUTER);
      expect(line.v1.z).toBe(BOARD_WIRE.height);
    }
    expect(Math.atan2(spokes[0].v1.x, spokes[0].v1.y)).toBeCloseTo(Math.PI / 20);
    WIRE_RADII.forEach((radius, i) => {
      const mesh = wires.children[20 + i] as THREE.Mesh<THREE.TorusGeometry>;
      expect(mesh.geometry.parameters.radius).toBe(radius);
      expect(mesh.geometry.parameters.tube).toBe(BOARD_WIRE.radius);
    });
    const bounds = new THREE.Box3().setFromObject(wires);
    expect(bounds.min.z).toBeCloseTo(0.05);
    expect(bounds.max.z).toBeCloseTo(1.15);
    disposeObject(wires);
  });

  it('rejects ring/spoke footprints without snapping; unrestricted retains the exact entry', () => {
    for (const radius of WIRE_RADII) {
      const spec = { ...DEFAULT_DART, x: 0, y: radius };
      const before = { ...spec };
      expect(placementProblem(spec, true)).toContain('intersects a raised wire');
      expect(placementProblem(spec, false)).toBeNull();
      expect(spec).toEqual(before);
    }
    const spec = { ...DEFAULT_DART, x: 75 * Math.sin(Math.PI / 20), y: 75 * Math.cos(Math.PI / 20) };
    expect(placementProblem(spec, true)).toContain('no snapping');
    expect(placementProblem({ ...DEFAULT_DART, x: NaN }, false)).toContain('Invalid');
  });

  it('allows bull, outer bull, single/triple/double and miss beds, but accounts for tilt', () => {
    for (const y of [0, 11, 70, 103, 130, 166, 200]) {
      expect(placementProblem({ ...DEFAULT_DART, x: 0, y }, true)).toBeNull();
    }
    const near = { ...DEFAULT_DART, x: 0, y: BOARD_MM.TRIPLE_INNER - 1.6 };
    expect(placementProblem(near, true)).toBeNull();
    expect(placementProblem({ ...near, tiltY: 45 }, true)).not.toBeNull();
    // Outside scoring area, no imaginary extension of wedge wires into the miss surround.
    expect(placementProblem({ ...DEFAULT_DART, x: 200 * Math.sin(Math.PI / 20), y: 200 * Math.cos(Math.PI / 20) }, true)).toBeNull();
  });
});

describe('dart mesh and resource ownership', () => {
  it('buries the physical apex axially while the tilted axis crosses the clicked board entry', () => {
    const spec = { ...DEFAULT_DART, x: 32, y: 108, tiltX: 25, tiltY: -18, roll: 67 };
    const dart = dartMesh(spec); dart.updateMatrixWorld(true);
    const point = dart.children[0] as THREE.Mesh;
    const apex = point.localToWorld(new THREE.Vector3(0, spec.point / 2, 0));
    const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(dart.quaternion);
    const entry = apex.clone().addScaledVector(direction, spec.penetration!);
    expect(entry.x).toBeCloseTo(spec.x); expect(entry.y).toBeCloseTo(spec.y); expect(entry.z).toBeCloseTo(0);
    expect(apex.z).toBeLessThan(0);
    expect(apex.distanceTo(entry)).toBeCloseTo(spec.penetration!);
    expect((point.material as THREE.MeshStandardMaterial).clippingPlanes![0].distanceToPoint(apex)).toBeLessThan(0);
        dart.traverse(object => {
          if (object instanceof THREE.Mesh) {
            const plane = (object.material as THREE.MeshStandardMaterial).clippingPlanes![0];
            expect(plane.normal.toArray()).toEqual([0, 0, 1]);
            expect(plane.constant).toBe(0);
            expect(plane.distanceToPoint(entry.clone().addScaledVector(direction, 1))).toBeGreaterThan(0);
          }
        });
        const barrel = dart.children[1] as THREE.Mesh;
        const barrelCentre = barrel.localToWorld(new THREE.Vector3());
        expect(barrelCentre.distanceTo(entry)).toBeCloseTo(spec.point - spec.penetration! + spec.barrel / 2);
    expect(direction.x / direction.z).toBeCloseTo(Math.tan(25 * Math.PI / 180));
    expect(direction.y / direction.z).toBeCloseTo(Math.tan(-18 * Math.PI / 180));
    const fins: THREE.Mesh[] = [];
    dart.traverse(object => { if (object instanceof THREE.Mesh && object.geometry instanceof THREE.ExtrudeGeometry) fins.push(object); });
    expect(fins).toHaveLength(4);
    for (const fin of fins) {
      fin.geometry.computeBoundingBox();
      expect(fin.geometry.boundingBox!.max.z - fin.geometry.boundingBox!.min.z).toBeCloseTo(spec.flightThickness);
      expect((fin.material as THREE.MeshStandardMaterial).depthTest).toBe(true);
    }
    disposeObject(dart);
  });

  it('supports legacy omitted penetration, zero burial and unchanged dimensional envelope', () => {
      for (const penetration of [undefined, 0, 20]) {
        const spec = { ...DEFAULT_DART, penetration, tiltX: 45, tiltY: -45 };
        const mesh = dartMesh(spec); mesh.updateMatrixWorld(true);
        const entry = mesh.localToWorld(new THREE.Vector3(0, 0, penetration ?? DEFAULT_PENETRATION));
        expect(entry.x).toBeCloseTo(spec.x); expect(entry.y).toBeCloseTo(spec.y); expect(entry.z).toBeCloseTo(0);
        const tip = mesh.localToWorld(new THREE.Vector3());
        expect(tip.z).toBeLessThanOrEqual(0);
        disposeObject(mesh);
      }
      const spec = { ...DEFAULT_DART, point: 45, barrel: 65, shaft: 60, flightLength: 55, penetration: 0 };
      const mesh = dartMesh(spec);
      const bounds = new THREE.Box3().setFromObject(mesh);
      expect(bounds.max.z).toBeCloseTo(217);
      expect(validDart({ ...DEFAULT_DART, penetration: -1 })).toBe(false);
      expect(validDart({ ...DEFAULT_DART, penetration: NaN })).toBe(false);
      expect(validDart({ ...DEFAULT_DART, penetration: Infinity })).toBe(false);
      expect(validDart({ ...DEFAULT_DART, point: 10, penetration: 9 })).toBe(false);
      disposeObject(mesh);
    });

    it('disposes shared geometry, material and textures only once', () => {
    const root = new THREE.Group();
    const geometry = new THREE.BoxGeometry(); const texture = new THREE.Texture();
    const material = new THREE.MeshStandardMaterial({ map: texture });
    root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
    const g = vi.spyOn(geometry, 'dispose'); const m = vi.spyOn(material, 'dispose'); const t = vi.spyOn(texture, 'dispose');
    disposeObject(root);
    expect(g).toHaveBeenCalledTimes(1); expect(m).toHaveBeenCalledTimes(1); expect(t).toHaveBeenCalledTimes(1);
  });

  it('rejects non-finite geometry, extreme tilts and impacts off the board', () => {
    expect(validDart(DEFAULT_DART)).toBe(true); expect(validRig(DEFAULT_RIG)).toBe(true);
    expect(validDart({ ...DEFAULT_DART, x: 220, y: 220 })).toBe(false);
    expect(validDart({ ...DEFAULT_DART, flightThickness: 0 })).toBe(false);
    expect(validDart({ ...DEFAULT_DART, tiltX: 90 })).toBe(false);
    expect(validRig({ ...DEFAULT_RIG, forward: NaN })).toBe(false);
    expect(() => dartMesh({ ...DEFAULT_DART, barrel: Infinity })).toThrow();
    expect(() => rigCameras({ ...DEFAULT_RIG, vfov: 0 })).toThrow();
  });
});
