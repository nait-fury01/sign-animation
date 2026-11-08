import './style.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { FaceLandmarker, PoseLandmarker, HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import * as Kalidokit from 'kalidokit';

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
let rotationFlip = 1;
const smoothed = new Map<string, THREE.Quaternion>();
const scratch = new THREE.Quaternion();

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
  const link = $('#share-link') as HTMLAnchorElement;
  const image = $('#share-qr') as HTMLImageElement;
  const hint = $('#share-hint');
  link.href = pageUrl;
  image.src = `https://api.qrserver.com/v1/create-qr-code/?format=svg&size=144x144&margin=3&data=${encodeURIComponent(pageUrl)}`;
  if (['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)) {
    hint.textContent = 'For phone access, open a deployed or network-hosted URL.';
  }
  image.addEventListener('error', () => { hint.textContent = 'QR unavailable. Share this page address directly.'; }, { once: true });
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
    rotationFlip = next.meta.metaVersion === '0' ? 1 : -1;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    if (vrm) { scene.remove(vrm.scene); VRMUtils.deepDispose(vrm.scene); }
    vrm = next;
    vrm.scene.position.set(0, -1.18, 0);
    vrm.scene.scale.setScalar(1.48);
    scene.add(vrm.scene);
    smoothed.clear();
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
function toHumanoidName(name: string): string {
  const limb = name.match(/^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)([123])$/);
  if (limb) {
    const side = limb[1].toLowerCase();
    const finger = limb[2].toLowerCase();
    const segment = Number(limb[3]);
    if (finger === 'thumb') return `${side}Thumb${(['Metacarpal', 'Proximal', 'Distal'] as const)[segment - 1]}`;
    const normalizedFinger = limb[2] === 'Pinky' ? 'Little' : limb[2];
    return `${side}${normalizedFinger}${(['Proximal', 'Intermediate', 'Distal'] as const)[segment - 1]}`;
  }
  if (/^(Left|Right)Hand$/.test(name)) return `${name.slice(0, 1).toLowerCase()}${name.slice(1)}`;
  return name.charAt(0).toLowerCase() + name.slice(1);
}
function bone(name: string) { return vrm?.humanoid.getNormalizedBoneNode(toHumanoidName(name) as never); }
function setEuler(name: string, x: number, y: number, z: number, alpha: number) {
  if (![x, y, z].every(Number.isFinite)) return;
  const node = bone(name); if (!node) return;
  const key = name; const target = scratch.setFromEuler(new THREE.Euler(x * rotationFlip, y, z * rotationFlip, 'XYZ'));
  let value = smoothed.get(key);
  if (!value) { value = node.quaternion.clone(); smoothed.set(key, value); }
  value.slerp(target, alpha);
  node.quaternion.copy(value);
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
      const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);
      const eyeCenterX = (leftEye.x + rightEye.x) / 2;
      const yaw = THREE.MathUtils.clamp((nose.x - eyeCenterX) * 3.8, -0.65, 0.65);
      const eyeCenterY = (leftEye.y + rightEye.y) / 2;
      const pitch = THREE.MathUtils.clamp((nose.y - eyeCenterY - 0.12) * 3.5, -0.45, 0.55);
      setEuler('Head', pitch, -yaw, -roll, 0.42);
    }
  }
  const blink = Math.max(blendshape(categories, ['eyeBlinkLeft']), blendshape(categories, ['eyeBlinkRight']));
  const smile = Math.max(blendshape(categories, ['mouthSmileLeft']), blendshape(categories, ['mouthSmileRight']));
  const jaw = blendshape(categories, ['jawOpen']);
  const frown = Math.max(blendshape(categories, ['mouthFrownLeft']), blendshape(categories, ['mouthFrownRight']));
  expression(['blink'], blink); expression(['joy', 'happy'], smile); expression(['aa', 'Aa', 'mouthOpen'], jaw);
  expression(['angry'], frown * 0.45);
}

function wrapAngle(value: number) { return Math.atan2(Math.sin(value), Math.cos(value)); }
function confident(point?: Point, threshold = 0.48) {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y) && (point.visibility === undefined || point.visibility >= threshold));
}
function dropArmsPose(side: HandSide) {
  const left = side === 'Left';
  // Both bundled VRMs rest in an A-pose. Rotate upper arms down alongside the
  // torso, with just a small relaxed elbow bend when tracking is unavailable.
  setEuler(`${side}UpperArm`, 0, 0, left ? 1.48 : -1.48, 0.42);
  setEuler(`${side}LowerArm`, 0, 0, left ? -0.12 : 0.12, 0.42);
  setEuler(`${side}Hand`, palmForwardRoll(side), 0, 0, 0.42);
}
function palmForwardRoll(side: HandSide) {
  // The bundled VRMs' wrist-to-index/pinky landmarks show local palm normals
  // of +Y on the left and -Y on the right. VRM 0 avatars face local -Z after
  // rotateVRM0(), so these quarter turns align both palms toward the camera.
  return side === 'Left' ? -Math.PI / 2 : Math.PI / 2;
}
function driveTorsoTilt(lm: Point[]) {
  const shoulderLeft = lm[11], shoulderRight = lm[12], hipLeft = lm[23], hipRight = lm[24];
  if (![shoulderLeft, shoulderRight, hipLeft, hipRight].every(visible)) return;
  const shouldersX = (shoulderLeft.x + shoulderRight.x) * 0.5;
  const hipsX = (hipLeft.x + hipRight.x) * 0.5;
  const hipsY = (hipLeft.y + hipRight.y) * 0.5;
  const shouldersY = (shoulderLeft.y + shoulderRight.y) * 0.5;
  const sideTilt = THREE.MathUtils.clamp(Math.atan2(shouldersX - hipsX, Math.max(0.1, hipsY - shouldersY)), -0.08, 0.08);
  // Freeze hips and front/back bending. Only allow a restrained side lean.
  setEuler('Spine', 0, 0, sideTilt, 0.18);
  setEuler('Chest', 0, 0, sideTilt * 0.45, 0.18);
}
function drivePose(points?: Point[], trackedHands: HandMap = {}) {
  const lm = points ?? [];
  const torsoFound = confident(lm[11], 0.35) && confident(lm[12], 0.35);
  updateTrack('pose', torsoFound);
  const centerX = torsoFound ? (lm[11].x + lm[12].x) * 0.5 : 0.5;
  const shoulderSpan = torsoFound ? Math.max(0.12, Math.abs(lm[11].x - lm[12].x)) : 0.2;
  const shouldersY = torsoFound ? (lm[11].y + lm[12].y) * 0.5 : 0.32;
  const hipY = confident(lm[23], 0.35) && confident(lm[24], 0.35) ? (lm[23].y + lm[24].y) * 0.5 : shouldersY + 0.42;
  let armCount = 0;
  for (const side of ['Left', 'Right'] as const) {
    const isLeft = side === 'Left';
    const shoulderIndex = isLeft ? 11 : 12;
    const elbowIndex = isLeft ? 13 : 14;
    const wristIndex = isLeft ? 15 : 16;
    const s = lm[shoulderIndex], e = lm[elbowIndex], poseWrist = lm[wristIndex];
    const handWrist = trackedHands[side]?.image[0];
    const w = handWrist ?? (confident(poseWrist) ? poseWrist : undefined);
    // The wrist must stay in a compact, chest-to-upper-abdomen workspace.
    const wristInSigningSpace = Boolean(w && w.x >= centerX - shoulderSpan * 1.05 && w.x <= centerX + shoulderSpan * 1.05 && w.y >= shouldersY + 0.015 && w.y <= hipY - 0.07);
    if (!torsoFound || !confident(s, 0.35) || !w || !wristInSigningSpace) {
      dropArmsPose(side);
      continue;
    }

    // If elbow confidence drops, infer a relaxed bent elbow between shoulder and
    // tracked wrist. This keeps occluded arms in the normal signing workspace.
    const elbowInSigningSpace = Boolean(e && e.x >= centerX - shoulderSpan * 1.2 && e.x <= centerX + shoulderSpan * 1.2 && e.y >= s.y + 0.04 && e.y <= hipY - 0.035);
    let elbow = confident(e) && elbowInSigningSpace ? e : undefined;
    if (!elbow) {
      const outward = s.x >= centerX ? 1 : -1;
      const elbowYMax = hipY - 0.08;
      const elbowYMin = Math.min(elbowYMax, Math.max(shouldersY, s.y) + 0.1);
      elbow = {
        x: THREE.MathUtils.clamp(s.x * 0.65 + w.x * 0.35 + outward * shoulderSpan * 0.12, centerX - shoulderSpan * 0.95, centerX + shoulderSpan * 0.95),
        y: THREE.MathUtils.clamp((s.y + w.y) * 0.5, elbowYMin, elbowYMax),
      };
    }
    // Measure against the natural down-and-out arm line. Using the horizontal
    // shoulder axis as zero made a relaxed arm look raised or folded backward.
    const upperAngle = Math.atan2(elbow.y - s.y, elbow.x - s.x);
    const forearmAngle = Math.atan2(w.y - elbow.y, w.x - elbow.x);
    const outwardAngle = s.x >= centerX ? 0.78 : Math.PI - 0.78;
    const upperRotation = wrapAngle(upperAngle - outwardAngle);
    const elbowRotation = wrapAngle(forearmAngle - upperAngle);
    setEuler(`${side}UpperArm`, 0, 0, THREE.MathUtils.clamp(upperRotation, -0.95, 1.2), 0.72);
    const signedElbow = isLeft ? -Math.abs(elbowRotation) : Math.abs(elbowRotation);
    setEuler(`${side}LowerArm`, 0, 0, THREE.MathUtils.clamp(signedElbow, -2.15, 0), 0.7);
    armCount++;
  }
  if (torsoFound) driveTorsoTilt(lm);
  $('#pose-state').textContent = armCount === 2 ? 'Tracking' : armCount === 1 ? 'Partial' : 'At sides';
}

const fingers = [
  { label: 'Thumb', points: [1, 2, 3, 4] }, { label: 'Index', points: [5, 6, 7, 8] },
  { label: 'Middle', points: [9, 10, 11, 12] }, { label: 'Ring', points: [13, 14, 15, 16] }, { label: 'Pinky', points: [17, 18, 19, 20] },
];
function resolveHands(results: Point[][], handednesses: Array<Array<{ categoryName: string }>> = [], pose?: Point[]): HandMap {
  const mapped: HandMap = {};
  const leftWrist = confident(pose?.[15], 0.4) ? pose![15] : undefined;
  const rightWrist = confident(pose?.[16], 0.4) ? pose![16] : undefined;
  const distance = (hand: Point[], wrist?: Point) => wrist && hand[0] ? Math.hypot(hand[0].x - wrist.x, hand[0].y - wrist.y) : Infinity;
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
    if (Math.min(dl, dr) < Infinity) side = dl <= dr ? 'Left' : 'Right';
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
      const solver = Kalidokit.Hand as unknown as { solve(landmarks: Point[], side: 'Left' | 'Right'): Record<string, EulerRig> };
      const rig = solver.solve(hand, side);
      for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
        for (const segment of ['Proximal', 'Intermediate', 'Distal']) {
          const rotation = rig[`${side}${finger}${segment}`];
          if (!rotation) continue;
          const boneName = finger === 'Little' ? `${side}HandPinky${segment === 'Proximal' ? 1 : segment === 'Intermediate' ? 2 : 3}`
            : `${side}Hand${finger}${segment === 'Proximal' ? 1 : segment === 'Intermediate' ? 2 : 3}`;
          setEuler(boneName, rotation.x, rotation.y, rotation.z, 0.58);
        }
      }
      const wrist = rig[`${side}Wrist`];
      if (wrist) {
        setEuler(`${side}Hand`, wrist.x + palmForwardRoll(side), wrist.y, wrist.z, 0.72);
      }
    } catch (error) {
      console.warn(`Kalidokit ${side.toLowerCase()} hand solver failed.`, error);
    }
  });
  updateTrack('hands', found.some(Boolean));
  // When a hand disappears, ease all its fingers back toward neutral instead of freezing a sign.
  (['Left', 'Right'] as const).forEach((side, idx) => {
    if (found[idx]) return;
    for (const f of fingers) for (let i = 1; i <= 3; i++) setEuler(f.label === 'Thumb' ? `${side}HandThumb${i}` : `${side}Hand${f.label}${i}`, 0, 0, 0, 0.12);
    setEuler(`${side}Hand`, palmForwardRoll(side), 0, 0, 0.12);
  });
}

async function initTasks(): Promise<Tasks> {
  const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm');
  const create = async (delegate: 'GPU' | 'CPU'): Promise<Tasks> => {
    const [face, pose, hands] = await Promise.all([
      FaceLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', delegate }, outputFaceBlendshapes: true, numFaces: 1, runningMode: 'VIDEO' }),
      PoseLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task', delegate }, numPoses: 1, outputSegmentationMasks: false, runningMode: 'VIDEO' }),
      HandLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', delegate }, numHands: 2, runningMode: 'VIDEO' }),
    ]);
    return { face, pose, hands };
  };
  try { return await create('GPU'); }
  catch (gpuError) { console.warn('MediaPipe GPU delegate unavailable; retrying on CPU.', gpuError); return create('CPU'); }
}

const handConnections: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9],
  [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
function drawOverlay(face?: Point[], pose?: Point[], hands: Point[][] = []) {
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
  hands.forEach((hand, handIndex) => {
    const color = handIndex === 0 ? '#63e6d0' : '#ffb86b';
    for (const [a, b] of handConnections) if (hand[a] && hand[b]) line(hand[a], hand[b], `${color}cc`, 2.8);
    hand.forEach((p, i) => dot(p, i === 0 ? '#ffffff' : color, i === 0 ? 5 : 4.5));
  });
}

function animate(now: number) {
  requestAnimationFrame(animate);
  if (running && tasks && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && now - lastDetect > 32) {
    lastDetect = now;
    try {
      const faceResult = tasks.face.detectForVideo(video, now);
      const poseResult = tasks.pose.detectForVideo(video, now);
      const handResult = tasks.hands.detectForVideo(video, now);
      const poseLandmarks = poseResult.landmarks[0] as Point[] | undefined;
      const handsBySide = resolveHands(handResult.landmarks as Point[][], handResult.handednesses as Array<Array<{ categoryName: string }>>, poseLandmarks);
      drawOverlay(faceResult.faceLandmarks[0] as Point[] | undefined, poseResult.landmarks[0] as Point[] | undefined, handResult.landmarks as Point[][]);
      driveFace(faceResult.faceLandmarks[0] as Point[] | undefined, faceResult.faceBlendshapes[0]?.categories);
      drivePose(poseLandmarks, handsBySide);
      driveHands(handsBySide);
      $('#latency-label').textContent = 'LIVE TRACKING';
    } catch (error) { if (now - lastToast > 5000) { console.warn('Landmark detection frame failed', error); lastToast = now; } }
  }
  if (vrm) vrm.update(1 / 60);
  renderer.render(scene, camera);
  frameTimes.push(now); frameTimes = frameTimes.filter((t) => now - t < 1000);
  $('#fps-label').textContent = `${frameTimes.length} FPS`;
}
requestAnimationFrame(animate);

$('#camera-button').addEventListener('click', async () => {
  const button = $('#camera-button') as HTMLButtonElement;
  if (running) {
    running = false; stream?.getTracks().forEach((track) => track.stop()); stream = undefined; video.srcObject = null;
    overlayContext?.clearRect(0, 0, overlay.width, overlay.height);
    $('#webcam-preview').classList.remove('visible'); $('#button-label').textContent = 'Enable camera'; status('Camera off', false); $('#latency-label').textContent = 'LOCAL PROCESSING';
    return;
  }
  button.disabled = true; $('#button-label').textContent = 'Preparing camera…';
  let startupStep = 'requesting webcam access';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access needs HTTPS or localhost in a supported browser.');
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
    startupStep = 'starting webcam video';
    video.srcObject = stream; await video.play();
    $('#webcam-preview').classList.add('visible');
    $('#button-label').textContent = 'Loading motion models…';
    startupStep = 'loading MediaPipe WASM and models';
    tasks ??= await initTasks();
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
$('#reset-button').addEventListener('click', () => { camera.position.set(0, 1.25, 5.1); camera.lookAt(0, 0.2, 0); if (vrm) { vrm.humanoid.resetNormalizedPose(); smoothed.clear(); } });
$('#fullscreen-button').addEventListener('click', () => { const stage = $('.stage') as HTMLElement; if (!document.fullscreenElement) void stage.requestFullscreen?.(); else void document.exitFullscreen(); });
$('#stage-model-name').textContent = ($('#avatar-select') as HTMLSelectElement).selectedOptions[0].textContent ?? 'Viverse · Black';
$('#caption-name').textContent = $('#stage-model-name').textContent;
void loadAvatar('/viverse_avatar_model_178277black.vrm');
