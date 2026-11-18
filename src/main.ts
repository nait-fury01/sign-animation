import './style.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { FaceLandmarker, PoseLandmarker, HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import * as Kalidokit from 'kalidokit';
import { loadConstraints, DEFAULT_CONSTRAINTS, clamp, clampRange, inRange, outside, widen, elbowRangeFor, rateLimit, resetRateLimits, type Constraints } from './constraints';
import { solveArm3D, toBoneSpace, palmWorldRotation, localHand, fingerSpread, spreadToYRotation } from './avatar/ArmIK3D';
import { updateCoach, type CoachInput } from './coach';
import { AvatarRig } from './avatar/AvatarRig';
import { loadRigFile } from './avatar/rigConfig';
import { mountRigEditor } from './editor/RigEditor';

type Point = { x: number; y: number; z?: number; visibility?: number };
type EulerRig = { x: number; y: number; z: number };
type HandSide = 'Left' | 'Right';
type TrackedHand = { image: Point[] };
type HandMap = Partial<Record<HandSide, TrackedHand>>;
type Tasks = { face: FaceLandmarker; pose: PoseLandmarker; hands: HandLandmarker };
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const video = $('#webcam') as HTMLVideoElement;
const host = $('#render-host');
const overlay = $('#tracking-overlay') as HTMLCanvasElement;
const overlayContext = overlay.getContext('2d');
const scene = new THREE.Scene();
scene.background = null;
const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 100);
camera.position.set(0, 1.25, 5.1);
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
host.append(renderer.domElement);
scene.add(new THREE.HemisphereLight(0xe4edff, 0x575063, 2.0));
const keyLight = new THREE.DirectionalLight(0xfff3dc, 2.8); keyLight.position.set(2.5, 4, 4); scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xa5b7ff, 1.5); fillLight.position.set(-3, 2, -1); scene.add(fillLight);
let vrm: VRM | undefined;
let tasks: Tasks | undefined;
let stream: MediaStream | undefined;
let running = false;
let lastDetect = 0;
let frameTimes: number[] = [];
let lastToast = 0;
let C: Constraints = DEFAULT_CONSTRAINTS;
let detectDt = 1 / 30;                       // seconds between tracker frames, used by the rate limiter
// --- Experimental 3D arm/palm/finger-spread solver (src/avatar/ArmIK3D.ts). Toggle: button "3D", key T, or ?arms=3d.
const MODE3D_KEY = 'motionStudio.mode3d';
let use3d = new URLSearchParams(location.search).get('arms') === '3d' || (() => { try { return localStorage.getItem(MODE3D_KEY) === '1'; } catch { return false; } })();
let showHud = (() => { try { return localStorage.getItem('motionStudio.hud') !== '0'; } catch { return true; } })();
type ArmDebug = { state: string; wx?: number; wy?: number; upperDeg?: number; elbowDeg?: number; note?: string };
const armDebug: Record<'Left' | 'Right', ArmDebug> = { Left: { state: '—' }, Right: { state: '—' } };
const lastGood: Record<'Left' | 'Right', number> = { Left: 0, Right: 0 };
const palm3d: Record<'Left' | 'Right', boolean> = { Left: false, Right: false };
// `?pose=lite` trades some elbow/shoulder accuracy for speed on weak machines.
const POSE_MODEL = new URLSearchParams(location.search).get('pose') === 'lite' ? 'lite' : 'full';
let delegateUsed: 'GPU' | 'CPU' | 'unknown' = 'unknown';
const liveAspect = () => (video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 4 / 3);
// All avatar access goes through the semantic rig (src/avatar). Poses and per-avatar calibration live in public/avatar-rig.json.
const rig = new AvatarRig();
Object.assign(window, { motionStudio: rig }); // console access: motionStudio.poses.apply('idle'), .poses.save('mine'), .poses.exportJSON()
// Until tracking starts, show the configured runtime rest pose instead of the VRM's raw bind pose.
const showRestIfIdle = () => { if (!running && rig.attached) rig.poses.apply(rig.poses.restName(), { alpha: 1, limits: C.arms }); };
// Edit mode ('rest') holds the rest pose and pauses tracking; the rig editor (src/editor) drives these.
const holdRestPose = (alpha: number) => { if (rig.attached) rig.poses.apply(rig.poses.restName(), { alpha, limits: C.arms }); };
mountRigEditor({ rig, toast: (message) => toast(message), changed: () => { if (rig.editHold === 'rest') holdRestPose(1); } });
void loadConstraints('/constraints.json').then((loaded) => { C = loaded; rig.poses.legacyNeutral = loaded.neutral; showRestIfIdle(); });
void loadRigFile('/avatar-rig.json').then((file) => { rig.configure(file); showRestIfIdle(); });

function resize() {
  const rect = host.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host); resize();

function toast(message: string) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  window.setTimeout(() => el.classList.remove('show'), 3600);
}
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as { name?: unknown; message?: unknown; details?: unknown; toString?: () => string };
    if (typeof value.message === 'string') return `${typeof value.name === 'string' ? `${value.name}: ` : ''}${value.message}`;
    if (typeof value.details === 'string') return value.details;
    try { return JSON.stringify(error); } catch { /* fall through */ }
    try { return value.toString?.() ?? 'Unknown error object'; } catch { /* fall through */ }
  }
  return String(error);
}
function status(text: string, active: boolean) {
  $('#status-label').textContent = text;
  $('#live-indicator').classList.toggle('active', active);
  $('#camera-state').textContent = active ? 'ON' : 'OFF';
  $('#camera-state').classList.toggle('on', active);
  $('#footer-status').textContent = active ? 'Tracking in progress' : 'Ready to capture';
  $('#tracking-caption').textContent = active ? 'TRACKING ACTIVE' : 'AWAITING INPUT';
}

function setupShareQr() {
  const pageUrl = window.location.href;
  const openButton = $('#share-qr-open') as HTMLButtonElement;
  const image = $('#share-qr') as HTMLImageElement;
  const largeImage = $('#share-qr-large') as HTMLImageElement;
  const screen = $('#qr-screen');
  const backButton = $('#qr-back') as HTMLButtonElement;
  const hint = $('#share-hint');
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?format=svg&size=640x640&margin=3&data=${encodeURIComponent(pageUrl)}`;
  image.src = qrUrl;
  largeImage.src = qrUrl;
  if (['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)) {
    hint.textContent = 'For phone access, open a deployed or network-hosted URL.';
    $('#qr-screen-hint').textContent = 'For phone access, use a deployed or network-hosted URL.';
  }
  const showScreen = () => {
    screen.hidden = false;
    document.body.classList.add('qr-open');
    backButton.focus();
  };
  const hideScreen = () => {
    screen.hidden = true;
    document.body.classList.remove('qr-open');
    openButton.focus();
  };
  openButton.addEventListener('click', showScreen);
  backButton.addEventListener('click', hideScreen);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !screen.hidden) hideScreen();
  });
  const qrFailed = () => {
    hint.textContent = 'QR unavailable. Share this page address directly.';
    $('#qr-screen-hint').textContent = 'QR unavailable. Share this page address directly.';
  };
  image.addEventListener('error', qrFailed, { once: true });
  largeImage.addEventListener('error', qrFailed, { once: true });
}
setupShareQr();

async function loadAvatar(url: string) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  try {
    const gltf = await loader.loadAsync(url);
    const next = gltf.userData.vrm as VRM | undefined;
    if (!next) throw new Error('This file does not contain a readable VRM avatar.');
    VRMUtils.rotateVRM0(next);
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    if (vrm) { scene.remove(vrm.scene); VRMUtils.deepDispose(vrm.scene); }
    vrm = next;
    vrm.scene.position.set(0, -1.18, 0);
    vrm.scene.scale.setScalar(1.48);
    scene.add(vrm.scene);
    rig.attach(vrm, url.split('/').pop());
    resetRateLimits(); showRestIfIdle();
    $('#stage-placeholder').classList.add('hidden');
  } catch (error) {
    console.error(error);
    toast(error instanceof Error ? error.message : 'Could not load the avatar.');
  }
}

const preset = (names: string[]) => {
  if (!vrm?.expressionManager) return undefined;
  const available = vrm.expressionManager as unknown as { getExpression?(name: string): unknown; setValue(name: string, value: number): void };
  for (const name of names) if (available.getExpression?.(name)) return name;
  return undefined;
};
function expression(names: string[], value: number) {
  const name = preset(names);
  if (name && vrm?.expressionManager) vrm.expressionManager.setValue(name, THREE.MathUtils.clamp(value, 0, 1));
}
function blendshape(categories: Array<{ categoryName: string; score: number }> | undefined, names: string[]) {
  if (!categories) return 0;
  return Math.max(0, ...categories.filter((x) => names.includes(x.categoryName)).map((x) => x.score));
}
function point(p: Point): THREE.Vector3 { return new THREE.Vector3(p.x, p.y, p.z ?? 0); }
function visible(p?: Point) { return Boolean(p && (p.visibility === undefined || p.visibility > 0.25)); }
function updateTrack(key: string, found: boolean) {
  $(`#${key}-dot`).classList.toggle('active', found);
  $(`#${key}-state`).textContent = found ? 'Detected' : 'Waiting';
}

function driveFace(landmarks?: Point[], categories?: Array<{ categoryName: string; score: number }>) {
  const found = Boolean(landmarks?.length);
  updateTrack('face', found);
  if (found && landmarks) {
    const leftEye = landmarks[33], rightEye = landmarks[263], nose = landmarks[1];
    if (leftEye && rightEye && nose) {
      const roll = clampRange(Math.atan2((rightEye.y - leftEye.y) / liveAspect(), rightEye.x - leftEye.x), C.head.roll);
      const eyeCenterX = (leftEye.x + rightEye.x) / 2;
      const yaw = THREE.MathUtils.clamp((nose.x - eyeCenterX) * 3.8, -0.65, 0.65);
      const eyeCenterY = (leftEye.y + rightEye.y) / 2;
      const pitch = THREE.MathUtils.clamp((nose.y - eyeCenterY - 0.12) * 3.5, -0.45, 0.55);
      rig.drive('head', pitch, -yaw, -roll, 0.42);
    }
  }
  const blink = Math.max(blendshape(categories, ['eyeBlinkLeft']), blendshape(categories, ['eyeBlinkRight']));
  const smile = Math.max(blendshape(categories, ['mouthSmileLeft']), blendshape(categories, ['mouthSmileRight']));
  const jaw = blendshape(categories, ['jawOpen']);
  const frown = Math.max(blendshape(categories, ['mouthFrownLeft']), blendshape(categories, ['mouthFrownRight']));
  expression(['blink'], blink); expression(['joy', 'happy'], smile); expression(['aa', 'Aa', 'mouthOpen'], jaw);
  expression(['angry'], frown * 0.45);
}

const DEG = Math.PI / 180;
function wrapAngle(value: number) { return Math.atan2(Math.sin(value), Math.cos(value)); }
function confident(point?: Point, threshold = 0.48) {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y) && (point.visibility === undefined || point.visibility >= threshold));
}
function dropArmsPose(side: HandSide, why = 'no usable wrist') {
  // The fallback pose is configuration, not code: see "runtimeRest" and "poses" in public/avatar-rig.json.
  // Poses flagged clampToTrackingLimits (signing-neutral) are clamped to this arm's tracked limits, in the same
  // angle domain as tracked frames, so tracking resumes without a visible jump.
  rig.solved3d[side === 'Left' ? 'left' : 'right'] = false;
  rig.poses.apply(rig.poses.restName(), { sides: [side], limits: C.arms });
  armDebug[side] = { state: 'NEUTRAL', note: why };
}
function driveTorsoTilt(lm: Point[]) {
  const shoulderLeft = lm[11], shoulderRight = lm[12], hipLeft = lm[23], hipRight = lm[24];
  if (![shoulderLeft, shoulderRight, hipLeft, hipRight].every(visible)) return;
  const shouldersX = (shoulderLeft.x + shoulderRight.x) * 0.5;
  const hipsX = (hipLeft.x + hipRight.x) * 0.5;
  const A = liveAspect();
  const hipsY = (hipLeft.y + hipRight.y) * 0.5 / A;
  const shouldersY = (shoulderLeft.y + shoulderRight.y) * 0.5 / A;
  const sideTilt = clampRange(Math.atan2(shouldersX - hipsX, Math.max(0.1, hipsY - shouldersY)), C.torsoTilt);
  // Freeze hips and front/back bending. Only allow a restrained side lean.
  rig.drive('spine', 0, 0, sideTilt, 0.18);
  rig.drive('chest', 0, 0, sideTilt * 0.45, 0.18);
}
/** 3D path for one arm: bone directions from pose WORLD landmarks, palm frame from the hand landmarks. Returns false to fall back to 2D. */
function driveArm3D(side: HandSide, world: Point[], hand?: Point[]): boolean {
  const left = side === 'Left', id = left ? 'left' : 'right';
  const S = world[left ? 11 : 12], E = world[left ? 13 : 14], W = world[left ? 15 : 16];
  if (!S || !E || !W || !confident(S, 0.5) || !confident(E, 0.5) || !confident(W, 0.4)) return false;
  const hinge = rig.elbowHinge(id); if (!hinge) return false;
  const flip = rig.adapter.flip;
  const sol = solveArm3D(toBoneSpace(S, flip), toBoneSpace(E, flip), toBoneSpace(W, flip), {
    side: id, flip, hingeSign: hinge.sign, hingeRange: hinge.range, fallbackTwistDeg: rig.config.frontConstraint.bendPlane,
  });
  if (!sol) return false;
  rig.adapter.setTarget(`${id}UpperArm`, sol.upper, 0.72);
  rig.adapter.setTarget(`${id}LowerArm`, sol.lower, 0.7);
  rig.solved3d[id] = true;
  palm3d[side] = false;
  if (hand && hand.length >= 21) {
    const A = liveAspect();
    const P = (i: number) => toBoneSpace({ x: hand[i].x, y: hand[i].y / A, z: hand[i].z ?? 0 }, flip);
    const palm = palmWorldRotation(P(0), P(5), P(9), P(17), { side: id, flip });
    if (palm) { rig.adapter.setTarget(`${id}Hand`, localHand(palm, sol.upper, sol.lower), 0.7); palm3d[side] = true; }
  }
  armDebug[side] = { state: '3D', elbowDeg: Math.round(sol.flexionDeg), note: palm3d[side] ? 'palm from hand frame' : 'palm: Kalidokit' };
  return true;
}

function drivePose(points?: Point[], trackedHands: HandMap = {}, world?: Point[]) {
  const lm = points ?? [];
  const A = liveAspect();
  const now = performance.now();
  const soft = C.soft;
  const torsoFound = confident(lm[11], 0.35) && confident(lm[12], 0.35);
  updateTrack('pose', torsoFound);
  const centerX = torsoFound ? (lm[11].x + lm[12].x) * 0.5 : 0.5;
  const span = torsoFound ? Math.max(0.12, Math.abs(lm[11].x - lm[12].x)) : 0.2;
  // y is divided by the video aspect so x and y share one unit (fraction of image width).
  // Every limit in constraints.json is expressed in this unit and in shoulder spans.
  const shouldersY = (torsoFound ? (lm[11].y + lm[12].y) * 0.5 : 0.32) / A;
  let armCount = 0;
  palm3d.Left = palm3d.Right = false;
  for (const side of ['Left', 'Right'] as const) {
    const isLeft = side === 'Left';
    const lim = C.arms[side];
    const s = lm[isLeft ? 11 : 12], e = lm[isLeft ? 13 : 14], poseWrist = lm[isLeft ? 15 : 16];
    const handWrist = trackedHands[side]?.image[0];
    const w = handWrist ?? (confident(poseWrist) ? poseWrist : undefined);
    if (!torsoFound || !confident(s, 0.35) || !w) {
      // Brief dropouts (a hand blurred for a few frames) hold the last pose instead of snapping to neutral.
      if (lastGood[side] && now - lastGood[side] < soft.holdMs) { armDebug[side] = { ...armDebug[side], state: 'HELD' }; armCount++; continue; }
      dropArmsPose(side, torsoFound ? 'wrist not visible' : 'shoulders not visible'); continue;
    }
    // 3D path (experimental): needs world landmarks with visible elbows; otherwise fall through to 2D for this arm.
    if (use3d && world && driveArm3D(side, world, trackedHands[side]?.image)) { lastGood[side] = now; armCount++; continue; }
    rig.solved3d[isLeft ? 'left' : 'right'] = false;

    // Rule 1 (soft): the wrist target is clamped into the signing space measured from the recordings, widened by
    // soft.workspaceMargin. Only a wrist FAR outside it (soft.hardMargin) falls back to neutral - the old hard
    // cut-off snapped hands to neutral whenever they crossed the midline or rose to face height.
    const wxRaw = (w.x - centerX) / span, wyRaw = (w.y / A - shouldersY) / span;
    const away = Math.hypot(outside(wxRaw, lim.wristX), outside(wyRaw, lim.wristY));
    if (away > soft.hardMargin) { dropArmsPose(side, `wrist ${away.toFixed(2)} spans outside workspace`); continue; }
    const wxc = clampRange(wxRaw, widen(lim.wristX, soft.workspaceMargin)), wyc = clampRange(wyRaw, widen(lim.wristY, soft.workspaceMargin));
    const wasClamped = wxc !== wxRaw || wyc !== wyRaw;
    const wt: Point = { x: centerX + wxc * span, y: (shouldersY + wyc * span) * A, z: w.z, visibility: w.visibility };

    // Rule 2: use the tracked elbow only if it is inside the elbow workspace; otherwise infer a relaxed one.
    let ex: number | undefined, ey: number | undefined;
    let elbowTracked = false;
    if (e && confident(e) && inRange((e.x - centerX) / span, widen(lim.elbowX, 0.25)) && inRange((e.y / A - shouldersY) / span, widen(lim.elbowY, 0.25))) { ex = e.x; ey = e.y / A; elbowTracked = true; }
    if (ex === undefined || ey === undefined) {
      const outward = s.x >= centerX ? 1 : -1;
      ex = clamp(s.x * 0.65 + wt.x * 0.35 + outward * span * 0.12, centerX + lim.elbowX[0] * span, centerX + lim.elbowX[1] * span);
      ey = clamp((s.y / A + wt.y / A) * 0.5, shouldersY + lim.elbowY[0] * span, shouldersY + lim.elbowY[1] * span);
    }
    const sy = s.y / A, wy = wt.y / A;
    const upperAngle = Math.atan2(ey - sy, ex - s.x);
    const forearmAngle = Math.atan2(wy - ey, wt.x - ex);
    const outwardAngle = s.x >= centerX ? C.outwardAngle : Math.PI - C.outwardAngle;

    // Rule 3: joint-angle ranges (widened by soft.angleMargin), with the elbow range conditioned on the upper-arm angle.
    // Rule 4: a per-joint speed limit rejects single-frame landmark glitches.
    const upperRaw = wrapAngle(upperAngle - outwardAngle);
    const upperRange = widen(lim.upperRotation, soft.angleMargin);
    const upper = rateLimit(`${side}U`, clampRange(upperRaw, upperRange), lim.maxRate.upper, detectDt);
    const flexRaw = Math.abs(wrapAngle(forearmAngle - upperAngle));
    const flex = rateLimit(`${side}E`, clampRange(flexRaw, elbowRangeFor(lim, upper)), lim.maxRate.elbow, detectDt);
    const sideId = side.toLowerCase();
    rig.drive(`${sideId}.upperArm`, 0, 0, upper, 0.72);
    // Previously the right elbow was clamped to [-2.15, 0] while its value was >= 0, so it never bent.
    rig.drive(`${sideId}.elbow`, 0, 0, isLeft ? -flex : flex, 0.7);
    lastGood[side] = now;
    armCount++;
    const notes = [wasClamped ? 'wrist clamped' : '', elbowTracked ? '' : 'elbow inferred', upper !== upperRaw ? 'upper clamped' : ''].filter(Boolean).join(', ');
    armDebug[side] = { state: wasClamped ? 'CLAMPED' : elbowTracked ? 'TRACKED' : 'INFERRED', wx: +wxRaw.toFixed(2), wy: +wyRaw.toFixed(2), upperDeg: Math.round(upper / DEG), elbowDeg: Math.round(flex / DEG), note: notes };
  }
  if (torsoFound) driveTorsoTilt(lm);
  $('#pose-state').textContent = armCount === 2 ? 'Tracking' : armCount === 1 ? 'Partial' : rig.poses.restLabel();
}

const fingers = [
  { label: 'Thumb', points: [1, 2, 3, 4] }, { label: 'Index', points: [5, 6, 7, 8] },
  { label: 'Middle', points: [9, 10, 11, 12] }, { label: 'Ring', points: [13, 14, 15, 16] }, { label: 'Pinky', points: [17, 18, 19, 20] },
];
function resolveHands(results: Point[][], handednesses: Array<Array<{ categoryName: string }>> = [], pose?: Point[]): HandMap {
  const mapped: HandMap = {};
  const leftWrist = confident(pose?.[15], 0.4) ? pose![15] : undefined;
  const rightWrist = confident(pose?.[16], 0.4) ? pose![16] : undefined;
  const A = liveAspect();
  const distance = (hand: Point[], wrist?: Point) => wrist && hand[0] ? Math.hypot(hand[0].x - wrist.x, (hand[0].y - wrist.y) / A) : Infinity;
  const spanNow = pose && confident(pose[11], 0.35) && confident(pose[12], 0.35) ? Math.abs(pose[11].x - pose[12].x) : 0;
  // A hand whose wrist is farther from both pose wrists than the recordings ever showed is not trusted by proximity.
  const maxDist = spanNow > 0 ? C.handAssign.maxDistSpan * spanNow : Infinity;
  if (results.length === 2 && leftWrist && rightWrist) {
    const tracked = (index: number): TrackedHand => ({ image: results[index] });
    const direct = distance(results[0], leftWrist) + distance(results[1], rightWrist);
    const crossed = distance(results[0], rightWrist) + distance(results[1], leftWrist);
    if (direct <= crossed) { mapped.Left = tracked(0); mapped.Right = tracked(1); }
    else { mapped.Right = tracked(0); mapped.Left = tracked(1); }
    return mapped;
  }
  results.forEach((hand, index) => {
    const dl = distance(hand, leftWrist), dr = distance(hand, rightWrist);
    let side: HandSide;
    if (Math.min(dl, dr) <= maxDist) side = dl <= dr ? 'Left' : 'Right';
    else {
      const label = handednesses[index]?.[0]?.categoryName?.toLowerCase();
      side = label === 'left' ? 'Left' : label === 'right' ? 'Right' : index === 0 ? 'Right' : 'Left';
    }
    const tracked = { image: hand };
    if (!mapped[side]) mapped[side] = tracked;
    else mapped[side === 'Left' ? 'Right' : 'Left'] = tracked;
  });
  return mapped;
}
/** 3D mode: Kalidokit only produces finger curl. Returns the spread (abduction, radians, toward the pinky) the camera sees for each finger, applied later as the y rotation of each proximal joint. */
function fingerSpreads(hand: Point[]): Record<string, number> {
  const A = liveAspect(), flip = rig.adapter.flip;
  const P = (i: number) => toBoneSpace({ x: hand[i].x, y: hand[i].y / A, z: hand[i].z ?? 0 }, flip);
  const wrist = P(0), idx = P(5), mid = P(9), pky = P(17);
  const out: Record<string, number> = {};
  for (const [name, mcp, pip] of [['Index', 5, 6], ['Middle', 9, 10], ['Ring', 13, 14], ['Little', 17, 18]] as const) {
    out[name] = clamp(fingerSpread(P(mcp), P(pip), wrist, mid, idx, pky), -0.6, 0.6);
  }
  return out;
}
function driveHands(handMap: HandMap) {
  const found = [false, false];
  (['Left', 'Right'] as const).forEach((side) => {
    const trackedHand = handMap[side];
    if (!trackedHand) return;
    // Kalidokit is calibrated for MediaPipe's normalized image landmarks.
    // Tasks world landmarks use different up/depth axes and roll the palms down here.
    const hand = trackedHand.image;
    found[side === 'Left' ? 0 : 1] = true;
    try {
      const spread = use3d && hand.length >= 21 ? fingerSpreads(hand) : undefined;
      const solver = Kalidokit.Hand as unknown as { solve(landmarks: Point[], side: 'Left' | 'Right'): Record<string, EulerRig> };
      const solved = solver.solve(hand, side);
      for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
        for (const segment of ['Proximal', 'Intermediate', 'Distal']) {
          const rotation = solved[`${side}${finger}${segment}`];
          if (!rotation) continue;
          const jointName = `${side.toLowerCase()}.${finger === 'Little' ? 'pinky' : finger.toLowerCase()}.${segment === 'Proximal' ? 1 : segment === 'Intermediate' ? 2 : 3}`;
          const fl = C.fingers?.[`${side}${finger}${segment}`];
          const sp = spread && segment === 'Proximal' ? spread[finger] : undefined; // 3D mode: spread comes from the landmarks, curl stays Kalidokit's
          const yRot = sp !== undefined ? spreadToYRotation(sp, side === 'Left' ? 'left' : 'right') : fl ? clampRange(rotation.y, fl.y) : rotation.y;
          rig.drive(jointName, fl ? clampRange(rotation.x, fl.x) : rotation.x, yRot, fl ? clampRange(rotation.z, fl.z) : rotation.z, 0.58);
        }
      }
      const wrist = solved[`${side}Wrist`];
      if (wrist && !palm3d[side]) {
        rig.drive(`${side.toLowerCase()}.wrist`, wrist.x + rig.palmForwardRoll(side), wrist.y, wrist.z, 0.72);
      }
    } catch (error) {
      console.warn(`Kalidokit ${side.toLowerCase()} hand solver failed.`, error);
    }
  });
  updateTrack('hands', found.some(Boolean));
  // When a hand disappears, ease all its fingers back toward neutral instead of freezing a sign.
  (['Left', 'Right'] as const).forEach((side, idx) => {
    if (found[idx]) return;
    for (const f of fingers) for (let i = 1; i <= 3; i++) rig.drive(`${side.toLowerCase()}.${f.label.toLowerCase()}.${i}`, 0, 0, 0, 0.12);
    rig.drive(`${side.toLowerCase()}.wrist`, rig.palmForwardRoll(side), 0, 0, 0.12);
  });
}

function withStartupTimeout<T>(promise: Promise<T>, label: string, onLateResult?: (value: T) => void): Promise<T> {
  let timedOut = false;
  let timer: number | undefined;
  const guarded = promise.then((value) => {
    if (timedOut) {
      onLateResult?.(value);
      throw new Error(`${label} finished after its startup timeout.`);
    }
    return value;
  });
  const timeout = new Promise<T>((_, reject) => {
    timer = window.setTimeout(() => {
      timedOut = true;
      reject(new Error(`${label} is taking too long. Check your network connection and reload.`));
    }, 90_000);
  });
  return Promise.race([guarded, timeout]).finally(() => { if (timer !== undefined) window.clearTimeout(timer); });
}

async function initTasks(onProgress: (message: string) => void): Promise<Tasks> {
  onProgress('Loading MediaPipe runtime…');
  const vision = await withStartupTimeout(
    FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm'),
    'MediaPipe WASM initialization',
  );
  const create = async (delegate: 'GPU' | 'CPU'): Promise<Tasks> => {
    let face: FaceLandmarker | undefined;
    let pose: PoseLandmarker | undefined;
    let hands: HandLandmarker | undefined;
    try {
      onProgress(`Initializing face tracker (${delegate})…`);
      face = await withStartupTimeout(
        FaceLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', delegate }, outputFaceBlendshapes: true, numFaces: 1, runningMode: 'VIDEO' }),
        'Face tracker initialization', (task) => task.close(),
      );
      onProgress(`Initializing upper-body tracker (${delegate})…`);
      pose = await withStartupTimeout(
        PoseLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${POSE_MODEL}/float16/1/pose_landmarker_${POSE_MODEL}.task`, delegate }, numPoses: 1, outputSegmentationMasks: false, runningMode: 'VIDEO' }),
        'Upper-body tracker initialization', (task) => task.close(),
      );
      onProgress(`Initializing hand tracker (${delegate})…`);
      hands = await withStartupTimeout(
        HandLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', delegate }, numHands: 2, runningMode: 'VIDEO' }),
        'Hand tracker initialization', (task) => task.close(),
      );
      delegateUsed = delegate;
      return { face, pose, hands };
    } catch (error) {
      face?.close(); pose?.close(); hands?.close();
      throw error;
    }
  };
  try { return await create('GPU'); }
  catch (gpuError) {
    console.warn('MediaPipe GPU initialization failed; retrying on CPU.', gpuError);
    return create('CPU');
  }
}

const handConnections: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9],
  [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
function drawOverlay(face?: Point[], pose?: Point[], hands: Point[][] = [], bySide: HandMap = {}) {
  if (!overlayContext) return;
  const width = video.videoWidth || 640, height = video.videoHeight || 480;
  if (overlay.width !== width || overlay.height !== height) { overlay.width = width; overlay.height = height; }
  const ctx = overlayContext;
  ctx.clearRect(0, 0, width, height);
  const dot = (p: Point, color: string, radius: number) => {
    ctx.beginPath(); ctx.arc(p.x * width, p.y * height, radius, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  };
  const line = (a: Point, b: Point, color: string, thickness: number) => {
    ctx.beginPath(); ctx.moveTo(a.x * width, a.y * height); ctx.lineTo(b.x * width, b.y * height);
    ctx.strokeStyle = color; ctx.lineWidth = thickness; ctx.stroke();
  };
  if (face?.length) {
    for (let i = 0; i < face.length; i += 5) dot(face[i], 'rgba(194,163,255,.78)', 2.5);
    [33, 133, 263, 362, 1, 61, 291, 13, 14].forEach((i) => { if (face[i]) dot(face[i], '#f3deff', 4); });
  }
  if (pose?.length) {
    const limbs: Array<[number, number]> = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16]];
    for (const [a, b] of limbs) if (pose[a] && pose[b] && visible(pose[a]) && visible(pose[b])) line(pose[a], pose[b], 'rgba(201,243,107,.92)', 3.2);
    for (const i of [11, 12, 13, 14, 15, 16]) if (pose[i] && visible(pose[i])) dot(pose[i], '#eaffb2', i === 11 || i === 12 ? 5 : 4.5);
  }
  hands.forEach((hand) => {
    // Colour = which avatar arm the hand drives: teal = the person's LEFT (avatar Left), orange = RIGHT. Unassigned hands are grey.
    const color = bySide.Left?.image === hand ? '#63e6d0' : bySide.Right?.image === hand ? '#ffb86b' : '#9aa0aa';
    for (const [a, b] of handConnections) if (hand[a] && hand[b]) line(hand[a], hand[b], `${color}cc`, 2.8);
    hand.forEach((p, i) => dot(p, i === 0 ? '#ffffff' : color, i === 0 ? 5 : 4.5));
  });
}

// --- Detection scheduling -------------------------------------------------------------------------------------
// The three MediaPipe tasks used to run back-to-back on every frame, which on this machine meant ~7 FPS for EVERYTHING
// (rendering included). Now ONE model runs per frame in a round-robin (hands twice as often as pose or face), the latest
// result of each is cached, and the avatar is eased toward its targets every rendered frame (VRMAdapter.step), so the
// display stays smooth even when a model is slow. If a machine is still slow, the face model runs less often.
type Model = 'hands' | 'pose' | 'face';
const ORDER: Model[] = ['hands', 'pose', 'hands', 'face'];
const ORDER_SLOW: Model[] = ['hands', 'pose', 'hands', 'pose', 'hands', 'pose', 'hands', 'face'];
let tickIndex = 0, tickMsEma = 0, lastFrameAt = 0;
let cache: { face?: Point[]; blend?: Array<{ categoryName: string; score: number }>; pose?: Point[]; world?: Point[]; hands: Point[][]; handed: Array<Array<{ categoryName: string }>> } = { hands: [], handed: [] };
let detectTimes: number[] = [];
let lastHudAt = 0, lastCoach = 0, lumaSample = { mean: 128, edgeDelta: 0 };
const lumaCanvas = document.createElement('canvas'); lumaCanvas.width = 32; lumaCanvas.height = 24;
const lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true });
function sampleLuma() {
  if (!lumaCtx || !video.videoWidth) return;
  lumaCtx.drawImage(video, 0, 0, 32, 24);
  const d = lumaCtx.getImageData(0, 0, 32, 24).data;
  let sum = 0, edge = 0, ec = 0, centre = 0, cc = 0;
  for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) {
    const i = (y * 32 + x) * 4, l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    sum += l;
    if (y < 6 && (x < 6 || x > 25)) { edge += l; ec++; }           // background corners
    if (y >= 3 && y < 14 && x >= 11 && x < 21) { centre += l; cc++; } // roughly where the face is
  }
  lumaSample = { mean: sum / 768, edgeDelta: ec && cc ? edge / ec - centre / cc : 0 };
}

function renderHud() {
  const el = document.getElementById('arm-hud'); if (!el) return;
  el.hidden = !showHud || !running;
  if (el.hidden) return;
  const row = (side: 'Left' | 'Right') => {
    const d = armDebug[side];
    const nums = [d.wx !== undefined ? `wx ${d.wx}` : '', d.wy !== undefined ? `wy ${d.wy}` : '', d.upperDeg !== undefined ? `up ${d.upperDeg}°` : '', d.elbowDeg !== undefined ? `elb ${d.elbowDeg}°` : ''].filter(Boolean).join(' · ');
    return `<div class="hud-row s-${d.state.toLowerCase()}"><b>${side}</b><i>${d.state}</i><span>${nums}${d.note ? ` <em>${d.note}</em>` : ''}</span></div>`;
  };
  const detHz = detectTimes.length;
  el.innerHTML = `<button class="hud-close" type="button" aria-label="Hide arm info">×</button><div class="hud-title">ARMS · ${use3d ? '3D (beta)' : '2D'} · ${delegateUsed} · pose ${POSE_MODEL}</div>${row('Left')}${row('Right')}<div class="hud-foot">teal = Left hand · orange = Right hand · det ${detHz}/s · D hides</div>`;
  el.querySelector('.hud-close')?.addEventListener('click', () => setHud(false));
}

function runCoach(now: number) {
  if (now - lastCoach < 500) return; lastCoach = now;
  sampleLuma();
  const input: CoachInput = {
    running, videoWidth: video.videoWidth, videoHeight: video.videoHeight, pose: cache.pose, hands: cache.hands, faceFound: Boolean(cache.face?.length),
    luma: lumaSample.mean, backlight: lumaSample.edgeDelta, renderFps: frameTimes.length, detectHz: detectTimes.length, delegate: delegateUsed,
    arms: { Left: armDebug.Left.state, Right: armDebug.Right.state },
  };
  const tips = updateCoach(input);
  const el = document.getElementById('coach-list'); if (!el) return;
  el.innerHTML = tips.length ? tips.map((t) => `<li class="coach-${t.level}"><b>${t.title}</b><span>${t.detail}</span></li>`).join('') : '<li class="coach-ok"><b>Setup looks good</b><span>Keep your hands inside the frame and sign at chest-to-face height.</span></li>';
}

function animate(now: number) {
  requestAnimationFrame(animate);
  const dt = lastFrameAt ? Math.min(0.1, (now - lastFrameAt) / 1000) : 1 / 60; lastFrameAt = now;
  if (rig.editHold === 'rest') holdRestPose(0.4);
  if (running && rig.editHold === 'off' && tasks && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    const t0 = performance.now();
    detectDt = Math.min(0.25, Math.max(0.008, dt));
    const order = tickMsEma > 45 ? ORDER_SLOW : ORDER;
    const model = order[tickIndex++ % order.length];
    try {
      if (model === 'hands') { const r = tasks.hands.detectForVideo(video, now); cache.hands = r.landmarks as Point[][]; cache.handed = r.handednesses as typeof cache.handed; }
      else if (model === 'pose') { const r = tasks.pose.detectForVideo(video, now); cache.pose = r.landmarks[0] as Point[] | undefined; cache.world = r.worldLandmarks?.[0] as Point[] | undefined; }
      else { const r = tasks.face.detectForVideo(video, now); cache.face = r.faceLandmarks[0] as Point[] | undefined; cache.blend = r.faceBlendshapes[0]?.categories; }
      const handsBySide = resolveHands(cache.hands, cache.handed, cache.pose);
      drawOverlay(cache.face, cache.pose, cache.hands, handsBySide);
      if (model === 'face' || tickIndex <= 3) driveFace(cache.face, cache.blend);
      drivePose(cache.pose, handsBySide, cache.world);
      driveHands(handsBySide);
      $('#latency-label').textContent = 'LIVE TRACKING';
    } catch (error) { if (now - lastToast > 5000) { console.warn('Landmark detection frame failed', error); lastToast = now; } }
    const ms = performance.now() - t0; tickMsEma = tickMsEma ? tickMsEma * 0.9 + ms * 0.1 : ms;
    detectTimes.push(now); detectTimes = detectTimes.filter((t) => now - t < 1000);
    runCoach(now);
  }
  rig.update(dt); // eases bones toward their targets, then the 2D arm constraint solver: after tracking, before rendering
  if (vrm) vrm.update(dt);
  renderer.render(scene, camera);
  frameTimes.push(now); frameTimes = frameTimes.filter((t) => now - t < 1000);
  $('#fps-label').textContent = running ? `${frameTimes.length} FPS · tracking ${detectTimes.length}/s` : `${frameTimes.length} FPS`;
  if (now - lastHudAt > 150) { lastHudAt = now; renderHud(); }
}
requestAnimationFrame(animate);

$('#camera-button').addEventListener('click', async () => {
  const button = $('#camera-button') as HTMLButtonElement;
  if (running) {
    running = false; cache = { hands: [], handed: [] }; tickIndex = 0; stream?.getTracks().forEach((track) => track.stop()); stream = undefined; video.srcObject = null; $('#coach-list').innerHTML = '';
    overlayContext?.clearRect(0, 0, overlay.width, overlay.height);
    $('#webcam-preview').classList.remove('visible'); $('#button-label').textContent = 'Enable camera'; status('Camera off', false); $('#latency-label').textContent = 'LOCAL PROCESSING';
    return;
  }
  button.disabled = true; $('#button-label').textContent = 'Preparing camera…';
  let startupStep = 'requesting webcam access';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access needs HTTPS or localhost in a supported browser.');
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' }, audio: false });
    startupStep = 'starting webcam video';
    video.srcObject = stream; await video.play();
    const sizeLabel = () => { if (video.videoWidth) { ($('#webcam-preview') as HTMLElement).style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`; $('#res-label').textContent = `${video.videoWidth} × ${video.videoHeight}`; } };
    sizeLabel(); video.addEventListener('loadedmetadata', sizeLabel, { once: true });
    $('#webcam-preview').classList.add('visible');
    $('#button-label').textContent = 'Loading motion models…';
    startupStep = 'loading MediaPipe WASM and models';
    tasks ??= await initTasks((message) => { $('#button-label').textContent = message; });
    running = true; status('Camera active', true); $('#button-label').textContent = 'Disable camera';
    toast('Tracking started. Keep your face and hands in view.');
  } catch (error) {
    console.error(`Motion capture startup failed while ${startupStep}.`, error);
    stream?.getTracks().forEach((track) => track.stop()); stream = undefined;
    video.srcObject = null; $('#webcam-preview').classList.remove('visible');
    overlayContext?.clearRect(0, 0, overlay.width, overlay.height);
    const message = describeError(error);
    toast(`Could not start while ${startupStep}: ${message}`); status('Camera off', false); $('#button-label').textContent = 'Enable camera';
  } finally { button.disabled = false; }
});

$('#avatar-select').addEventListener('change', (event) => {
  const value = (event.currentTarget as HTMLSelectElement).value;
  const label = (event.currentTarget as HTMLSelectElement).selectedOptions[0].textContent ?? 'Avatar';
  $('#stage-model-name').textContent = label; $('#caption-name').textContent = label;
  void loadAvatar(`/${value}`);
});
$('#reset-button').addEventListener('click', () => { camera.position.set(0, 1.25, 5.1); camera.lookAt(0, 0.2, 0); if (vrm) { rig.resetPose(); resetRateLimits(); } });
$('#fullscreen-button').addEventListener('click', () => { const stage = $('.stage') as HTMLElement; if (!document.fullscreenElement) void stage.requestFullscreen?.(); else void document.exitFullscreen(); });
$('#stage-model-name').textContent = ($('#avatar-select') as HTMLSelectElement).selectedOptions[0].textContent ?? 'Viverse · Black';
$('#caption-name').textContent = $('#stage-model-name').textContent;
void loadAvatar('/viverse_avatar_model_178277black.vrm');

// --- 3D toggle and HUD toggle ---------------------------------------------------------------------------------
const mode3dButton = document.getElementById('mode3d-button') as HTMLButtonElement | null;
function setMode3d(on: boolean) {
  use3d = on; try { localStorage.setItem(MODE3D_KEY, on ? '1' : '0'); } catch { /* ignore */ }
  mode3dButton?.classList.toggle('active', on);
  if (!on) { rig.solved3d.left = rig.solved3d.right = false; }
  toast(on ? '3D arm solver (beta) on - uses depth from the pose model.' : '2D arm solver on.');
}
mode3dButton?.classList.toggle('active', use3d);
mode3dButton?.addEventListener('click', () => setMode3d(!use3d));
function setHud(on: boolean) { showHud = on; try { localStorage.setItem('motionStudio.hud', on ? '1' : '0'); } catch { /* ignore */ } renderHud(); }
document.addEventListener('keydown', (event) => {
  const t = event.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if (event.key === 't' || event.key === 'T') setMode3d(!use3d);
  if (event.key === 'd' || event.key === 'D') setHud(!showHud);
});
