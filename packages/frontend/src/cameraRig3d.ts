import * as THREE from 'three';
import { BOARD_MM, SEGMENT_ORDER } from '@darts/schema';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { RenderConfiguration, RenderImages } from './nativeDetector.ts';

export const FRAME_WIDTH = 1280;
export const FRAME_HEIGHT = 720;
export const DEFAULT_HORIZONTAL_FOV = 100;
export const DEFAULT_VERTICAL_FOV = 2 * Math.atan(Math.tan(DEFAULT_HORIZONTAL_FOV * Math.PI / 360) * FRAME_HEIGHT / FRAME_WIDTH) * 180 / Math.PI;
export const CAMERA_IDS = ['cam0', 'cam1', 'cam2'] as const;
export interface RigSettings { radius: number; forward: number; rotation: number; vfov: number }
// Representative reference-style mounting, not measured hardware calibration.
export const DEFAULT_RIG: RigSettings = { radius: 260, forward: 220, rotation: 60, vfov: DEFAULT_VERTICAL_FOV };
export interface DartSpec {
  x: number; y: number; tiltX: number; tiltY: number; roll: number;
  point: number; barrel: number; barrelDiameter: number; shaft: number;
  flightLength: number; flightWidth: number; flightThickness: number;
    /** Buried length along the dart axis (mm). Missing legacy values use DEFAULT_PENETRATION. */
    penetration?: number;
}
export const DEFAULT_PENETRATION = 8;
export const DEFAULT_DART: DartSpec = {
  x: 0, y: 102, tiltX: 0, tiltY: 0, roll: 0, point: 28, penetration: DEFAULT_PENETRATION,
  barrel: 50, barrelDiameter: 6.5, shaft: 35, flightLength: 42, flightWidth: 18, flightThickness: 0.4,
};
const radians = THREE.MathUtils.degToRad;

export function validRig(s: RigSettings): boolean {
  return Object.values(s).every(Number.isFinite) && s.radius >= 230 && s.radius <= 600 &&
    s.forward >= 40 && s.forward <= 600 && Math.abs(s.rotation) <= 360 && s.vfov >= 45 && s.vfov <= 130;
}
export function validDart(d: DartSpec): boolean {
  const { penetration, ...dimensions } = d;
    const depth = penetration === undefined ? DEFAULT_PENETRATION : penetration;
    return Object.values(dimensions).every(Number.isFinite) && Math.hypot(d.x, d.y) <= BOARD_MM.BOARD_OUTER &&
    Math.abs(d.tiltX) <= 45 && Math.abs(d.tiltY) <= 45 && Math.abs(d.roll) <= 360 &&
    d.point >= 10 && d.point <= 45 && d.barrel >= 25 && d.barrel <= 65 &&
    d.barrelDiameter >= 4 && d.barrelDiameter <= 10 && d.shaft >= 15 && d.shaft <= 60 &&
    d.flightLength >= 20 && d.flightLength <= 55 && d.flightWidth >= 8 && d.flightWidth <= 25 &&
    d.flightThickness >= 0.2 && d.flightThickness <= 1 &&
        Number.isFinite(depth) && depth >= 0 && depth <= Math.min(20, d.point - 2);
}

export function rigCameras(settings: RigSettings): THREE.PerspectiveCamera[] {
  if (!validRig(settings)) throw new Error('Invalid camera rig dimensions');
  return CAMERA_IDS.map((_, i) => {
    const angle = radians(settings.rotation + i * 120);
    const camera = new THREE.PerspectiveCamera(settings.vfov, FRAME_WIDTH / FRAME_HEIGHT, 1, 2000);
    camera.position.set(settings.radius * Math.cos(angle), settings.radius * Math.sin(angle), settings.forward);
    // The bracket's upright direction is out of the board, not global board-y.
    // Each radial mount then has a horizontal tangent and its near rim below bull.
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    return camera;
  });
}

/** OpenCV x-right/y-down/z-forward, in millimetres; arrays are row-major. */
export function cameraCalibration(camera: THREE.PerspectiveCamera): { K: number[]; R: number[]; t: number[] } {
  camera.updateMatrixWorld(true);
  const m = camera.matrixWorldInverse.elements; // Three stores matrices column-major.
  const f = (FRAME_HEIGHT / 2) / Math.tan(radians(camera.fov) / 2);
  // Pixel centres are (column + .5, row + .5); principal point is (w/2,h/2).
  return { K: [f, 0, FRAME_WIDTH / 2, 0, f, FRAME_HEIGHT / 2, 0, 0, 1],
    R: [m[0], m[4], m[8], -m[1], -m[5], -m[9], -m[2], -m[6], -m[10]],
    t: [m[12], -m[13], -m[14]] };
}

/** readRenderTargetPixels is bottom-up. Detector bytes and previews are top-down. */
export function rgbaToGray(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (rgba.length !== width * height * 4) throw new Error('Invalid framebuffer size');
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = ((height - 1 - y) * width + x) * 4;
    gray[y * width + x] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
  }
  return gray;
}
export function grayBase64(gray: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < gray.length; i += 8192) binary += String.fromCharCode(...gray.subarray(i, i + 8192));
  return btoa(binary);
}

const material = (color: THREE.ColorRepresentation, metalness = 0) => new THREE.MeshStandardMaterial({ color, metalness, roughness: 0.65 });
function cylinder(radius: number, length: number, color: THREE.ColorRepresentation): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 24), material(color, 0.4));
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

export function dartDirection(d: DartSpec): THREE.Vector3 {
  return new THREE.Vector3(Math.tan(radians(d.tiltX)), Math.tan(radians(d.tiltY)), 1).normalize();
}

// Representative round wire, not measured hardware dimensions. Shared by mesh and clearance.
export const BOARD_WIRE = { radius: 0.55, height: 0.6 } as const;
export const WIRE_RADII = [BOARD_MM.BULL_INNER, BOARD_MM.BULL_OUTER, BOARD_MM.TRIPLE_INNER,
  BOARD_MM.TRIPLE_OUTER, BOARD_MM.DOUBLE_INNER, BOARD_MM.DOUBLE_OUTER] as const;
export function wireSpokes(): THREE.LineCurve3[] {
  const sweep = 2 * Math.PI / SEGMENT_ORDER.length;
  return SEGMENT_ORDER.map((_, i) => {
    const angle = Math.PI / 2 - (i + 0.5) * sweep;
    return new THREE.LineCurve3(
      new THREE.Vector3(BOARD_MM.BULL_OUTER * Math.cos(angle), BOARD_MM.BULL_OUTER * Math.sin(angle), BOARD_WIRE.height),
      new THREE.Vector3(BOARD_MM.DOUBLE_OUTER * Math.cos(angle), BOARD_MM.DOUBLE_OUTER * Math.sin(angle), BOARD_WIRE.height));
  });
}

/** Conservative footprint of the steel point across the entire raised-wire slab.
 * Bulls and the physical miss surround are allowed beds; spokes stop at the double.
 * No snapping, scoring changes, dart/dart collision or bounce simulation.
 */
export function placementProblem(d: DartSpec, wireClear: boolean): string | null {
  if (!validDart(d)) return 'Invalid dart dimensions or board entry.';
  if (!wireClear) return null;
  const direction = dartDirection(d);
  const slope = Math.hypot(direction.x, direction.y) / direction.z;
  const x = d.x + BOARD_WIRE.height * direction.x / direction.z;
  const y = d.y + BOARD_WIRE.height * direction.y / direction.z;
  const footprint = 0.8 / direction.z + BOARD_WIRE.radius * slope + BOARD_WIRE.radius;
  const ringHit = WIRE_RADII.some(radius => Math.abs(Math.hypot(x, y) - radius) <= footprint);
  const p = new THREE.Vector3(x, y, BOARD_WIRE.height);
  const spokeHit = wireSpokes().some(line => {
    const delta = line.v2.clone().sub(line.v1);
    const t = THREE.MathUtils.clamp(p.clone().sub(line.v1).dot(delta) / delta.lengthSq(), 0, 1);
    return p.distanceTo(line.v1.clone().addScaledVector(delta, t)) <= footprint;
  });
  return ringHit || spokeHit ? 'Placement rejected: tilted point footprint intersects a raised wire. Choose another entry or use unrestricted mode; no snapping.' : null;
}

/** Local origin is the physical apex; world (x,y,0) is the axis/board entry. */
export function dartMesh(d: DartSpec): THREE.Group {
  if (!validDart(d)) throw new Error('Invalid dart dimensions or impact');
  const dart = new THREE.Group();
  const point = new THREE.Mesh(new THREE.ConeGeometry(0.8, d.point, 20), material('#a7aab0', 0.7));
  point.rotation.x = -Math.PI / 2;
  point.position.z = d.point / 2;
  dart.add(point);
  const barrel = cylinder(d.barrelDiameter / 2, d.barrel, '#b5b7bc');
  barrel.position.z = d.point + d.barrel / 2;
  dart.add(barrel);
  for (let z = d.point + 4; z < d.point + d.barrel - 3; z += 4) {
    const groove = new THREE.Mesh(new THREE.TorusGeometry(d.barrelDiameter / 2, 0.25, 6, 24), material('#454951'));
    groove.position.z = z;
    dart.add(groove);
  }
  const shaft = cylinder(1.5, d.shaft, '#343943');
  shaft.position.z = d.point + d.barrel + d.shaft / 2;
  dart.add(shaft);
  const flightStart = d.point + d.barrel + d.shaft - 8;
  const shape = new THREE.Shape();
  shape.moveTo(1.5, 0); shape.lineTo(d.flightWidth, d.flightLength * 0.35);
  shape.lineTo(d.flightWidth * 0.75, d.flightLength); shape.lineTo(1.5, d.flightLength); shape.closePath();
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: d.flightThickness, bevelEnabled: false }), material('#df762e'));
    fin.geometry.translate(0, 0, -d.flightThickness / 2);
    fin.rotation.x = Math.PI / 2;
    const pivot = new THREE.Group();
    pivot.position.z = flightStart;
    pivot.rotation.z = i * Math.PI / 2;
    pivot.add(fin); dart.add(pivot);
  }
  const direction = dartDirection(d);
  dart.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
  dart.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), radians(d.roll)));
  dart.position.set(d.x, d.y, 0).addScaledVector(direction, -(d.penetration ?? DEFAULT_PENETRATION));
    // Clip buried material at the board plane even at the physical rim or in a rear overview.
    dart.traverse(object => {
      if (object instanceof THREE.Mesh) {
        const m = object.material as THREE.MeshStandardMaterial;
        m.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)];
      }
    });
  return dart;
}

function boardMesh(): THREE.Group {
  const board = new THREE.Group();
  const backing = cylinder(BOARD_MM.BOARD_OUTER, 38, '#26272b');
  backing.position.z = -19.2; board.add(backing);
  const bands = [
    [BOARD_MM.BULL_OUTER, BOARD_MM.TRIPLE_INNER, false],
    [BOARD_MM.TRIPLE_INNER, BOARD_MM.TRIPLE_OUTER, true],
    [BOARD_MM.TRIPLE_OUTER, BOARD_MM.DOUBLE_INNER, false],
    [BOARD_MM.DOUBLE_INNER, BOARD_MM.DOUBLE_OUTER, true],
    [BOARD_MM.DOUBLE_OUTER, BOARD_MM.BOARD_OUTER, false],
  ] as const;
  const sweep = 2 * Math.PI / SEGMENT_ORDER.length;
  SEGMENT_ORDER.forEach((number, i) => {
    const centre = Math.PI / 2 - i * sweep;
    for (const [inner, outer, scoring] of bands) {
      const color = inner === BOARD_MM.DOUBLE_OUTER ? '#191b1e' : scoring ? (i % 2 ? '#22754a' : '#b5312f') : (i % 2 ? '#d6c7a0' : '#242327');
      board.add(new THREE.Mesh(new THREE.RingGeometry(inner, outer, 16, 1, centre - sweep / 2, sweep), material(color)));
    }

    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D unavailable');
    ctx.fillStyle = '#e7e7dc'; ctx.font = 'bold 76px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(number), 64, 64);
    const texture = new THREE.CanvasTexture(canvas);
    const label = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), new THREE.MeshStandardMaterial({ map: texture, transparent: true, depthWrite: false }));
    label.position.set(202 * Math.cos(centre), 202 * Math.sin(centre), 1.5); label.layers.set(1); board.add(label);
  });
  board.add(new THREE.Mesh(new THREE.RingGeometry(BOARD_MM.BULL_INNER, BOARD_MM.BULL_OUTER, 64), material('#22754a')));
  board.add(new THREE.Mesh(new THREE.CircleGeometry(BOARD_MM.BULL_INNER, 48), material('#b5312f')));
  board.add(boardWires());
  return board;
}

export function boardWires(): THREE.Group {
  const wires = new THREE.Group();
  for (const line of wireSpokes()) {
    wires.add(new THREE.Mesh(new THREE.TubeGeometry(line, 1, BOARD_WIRE.radius, 8, false), material('#aaa9a3', 0.7)));
  }
  for (const radius of WIRE_RADII) {
    const wire = new THREE.Mesh(new THREE.TorusGeometry(radius, BOARD_WIRE.radius, 8, 128), material('#aaa9a3', 0.7));
    wire.position.z = BOARD_WIRE.height; wires.add(wire);
  }
  return wires;
}

/** Shared resources are disposed exactly once, including number textures. */
export function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const m of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(m);
      for (const value of Object.values(m)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  textures.forEach(t => t.dispose()); geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
}

export function boardImpact(camera: THREE.Camera, nx: number, ny: number): { x: number; y: number } | null {
  camera.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(nx, ny), camera);
  const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
  return hit && Math.hypot(hit.x, hit.y) <= BOARD_MM.BOARD_OUTER ? { x: hit.x, y: hit.y } : null;
}

/** All comparison annotations are excluded from calibrated camera layer 0. */
export function impactMarkers(actual: readonly { x: number; y: number }[], detected: readonly { x: number; y: number; uncertaintyMm: number }[]): THREE.Group {
  const group = new THREE.Group(); group.layers.set(1);
  const ring = (x: number, y: number, radius: number, color: string) => {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(Math.max(0, radius - 0.7), radius + 0.7, 64),
      new THREE.MeshBasicMaterial({ color, depthTest: false, side: THREE.DoubleSide }));
    mesh.position.set(x, y, 2); mesh.layers.set(1); mesh.renderOrder = 10; group.add(mesh);
  };
  actual.forEach(p => ring(p.x, p.y, 3, '#49e6a0'));
  detected.forEach(p => { ring(p.x, p.y, 5, '#ff71d4'); if (p.uncertaintyMm > 0) ring(p.x, p.y, Math.min(p.uncertaintyMm, 450), '#ffbd59'); });
  return group;
}

export class CameraRig3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private overview = new THREE.PerspectiveCamera(50, FRAME_WIDTH / FRAME_HEIGHT, 1, 2500);
  private controls?: OrbitControls;
  private targets = CAMERA_IDS.map(() => new THREE.WebGLRenderTarget(FRAME_WIDTH, FRAME_HEIGHT, { depthBuffer: true }));
  private pixels = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
  private darts = new THREE.Group();
  private mounts = new THREE.Group();
  private markers = new THREE.Group();
  private cameras: THREE.PerspectiveCamera[] = [];
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, private previews: HTMLCanvasElement[], settings: RigSettings) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
    this.renderer.localClippingEnabled = true;
        this.renderer.setPixelRatio(1); this.renderer.setSize(FRAME_WIDTH, FRAME_HEIGHT, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color('#343941');
    this.scene.add(boardMesh(), this.darts, this.mounts, this.markers);
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#727888', 2));
    const light = new THREE.DirectionalLight('#ffffff', 2.5); light.position.set(-180, 280, 500); this.scene.add(light);
    this.overview.position.set(450, 320, 650); this.overview.lookAt(0, 0, 0); this.overview.layers.enable(1);
    this.setRig(settings);
  }
  async enableOrbit(): Promise<void> {
    const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
    if (this.disposed) return;
    this.controls = new OrbitControls(this.overview, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.minDistance = 180; this.controls.maxDistance = 1500;
  }
  setRig(settings: RigSettings): void {
    this.cameras = rigCameras(settings);
    disposeObject(this.mounts); this.mounts.clear();
    this.cameras.forEach((camera, i) => {
      const marker = new THREE.Mesh(new THREE.BoxGeometry(18, 12, 24), material(['#46b8ef', '#ebbd4a', '#ca7aea'][i]));
      marker.position.copy(camera.position); marker.quaternion.copy(camera.quaternion); marker.layers.set(1);
      this.mounts.add(marker);
      const lens = cylinder(4, 8, '#1e2025');
      lens.position.copy(camera.position).addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 16);
      lens.quaternion.premultiply(camera.quaternion); lens.layers.set(1); this.mounts.add(lens);
    });
  }
  setDarts(specs: readonly DartSpec[]): void {
    disposeObject(this.darts); this.darts.clear();
    specs.forEach(spec => this.darts.add(dartMesh(spec)));
  }
  pickImpact(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return boardImpact(this.overview, 2 * (clientX - rect.left) / rect.width - 1, 1 - 2 * (clientY - rect.top) / rect.height);
  }
  setMarkers(actual: readonly { x: number; y: number }[], detected: readonly { x: number; y: number; uncertaintyMm: number }[]): void {
    disposeObject(this.markers); this.scene.remove(this.markers);
    this.markers = impactMarkers(actual, detected); this.scene.add(this.markers);
  }
  renderOverview(): void {
    if (this.disposed) return;
    this.controls?.update(); this.renderer.setRenderTarget(null); this.renderer.render(this.scene, this.overview);
  }
  frames(): RenderImages {
    if (this.disposed) throw new Error('Renderer disposed');
    const images = {} as RenderImages;
    // No scene updates between these renders: all cameras observe the same logical tick.
    CAMERA_IDS.forEach((id, i) => {
      this.renderer.setRenderTarget(this.targets[i]); this.renderer.render(this.scene, this.cameras[i]);
      this.renderer.readRenderTargetPixels(this.targets[i], 0, 0, FRAME_WIDTH, FRAME_HEIGHT, this.pixels);
      const gray = rgbaToGray(this.pixels, FRAME_WIDTH, FRAME_HEIGHT);
      images[id] = grayBase64(gray);
      const canvas = this.previews[i]; canvas.width = FRAME_WIDTH; canvas.height = FRAME_HEIGHT;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const image = ctx.createImageData(FRAME_WIDTH, FRAME_HEIGHT);
        for (let p = 0; p < gray.length; p++) {
          image.data[p * 4] = image.data[p * 4 + 1] = image.data[p * 4 + 2] = gray[p]; image.data[p * 4 + 3] = 255;
        }
        ctx.putImageData(image, 0, 0);
      }
    });
    this.renderer.setRenderTarget(null);
    return images;
  }
  configuration(): RenderConfiguration {
    if (this.darts.children.length) throw new Error('Configure requires an empty scene');
    const images = this.frames();
    return { width: FRAME_WIDTH, height: FRAME_HEIGHT, cameras: Object.fromEntries(CAMERA_IDS.map((id, i) =>
      [id, { ...cameraCalibration(this.cameras[i]), reference: images[id] }])) as RenderConfiguration['cameras'] };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.controls?.dispose();
    disposeObject(this.scene); this.targets.forEach(t => t.dispose());
    this.scene.clear(); this.renderer.dispose(); this.renderer.forceContextLoss();
  }
}
