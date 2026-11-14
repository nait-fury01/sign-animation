// Avatar rig configuration: the schema for public/avatar-rig.json.
//
// Three concerns live here, deliberately separate from constraints.json (which holds the learned
// KSL motion statistics) and from the tracking code:
//   * calibration - facts about how a VRM skeleton behaves (axis flip, palm-forward wrist roll)
//   * joints      - semantic joint -> VRM bone + axis/sign mapping (each can be overridden per avatar)
//   * poses       - named poses written in semantic terms (degrees), not raw Euler angles
//
// Everything is validated on load. Malformed entries are dropped with a console warning and the
// built-in default stays in force, so a typo in the JSON can never break tracking.

import type { Range } from '../constraints';

export type Side = 'Left' | 'Right';
export type Axis = 'x' | 'y' | 'z';
export type PalmOrientation = 'forward' | 'down';

export type DofDef = { axis: Axis; sign: 1 | -1; limits?: Range }; // limits in degrees
export type JointDef = { bone: string; dofs: Record<string, DofDef> };

/** Pose for one arm. All values are degrees. Omitted joints are left untouched when the pose is applied. */
export type SidePose = {
  upperArm?: { lowering?: number }; // 0 = bind pose, + = arm swung down toward the body (both sides)
  elbow?: { flexion?: number };     // 0 = straight, + = bent (both sides)
  wrist?: { palm?: PalmOrientation; roll?: number }; // palm facing, plus extra roll in degrees
};
export type PoseDef = {
  label?: string;
  description?: string;
  blend?: number;                    // 0..1 smoothing factor when applied (higher = faster)
  clampToTrackingLimits?: boolean;   // clamp to constraints.json arm ranges, as the old neutral fallback did
  Left?: SidePose;
  Right?: SidePose;
};
export type RigCalibration = { rotationFlip: 'auto' | 1 | -1; palmForwardRoll: Record<Side, number> }; // roll in degrees

/**
 * "Arms stay in front of the body." The tracker only measures arm angles in the camera image plane, so with
 * no extra information the elbows/forearms swing sideways (hands beside the head, arms looking pushed behind
 * the back). This block tells the arm solver (src/avatar/ArmSolver.ts) which way is forward. Degrees.
 */
export type FrontConstraint = {
  enabled: boolean;
  bendPlane: number;            // 0 = elbow bends sideways (raw image plane); 90 = elbow bends straight forward
  upperArmMinForward: number;   // the upper arm is lifted at least this many degrees in front of the shoulder plane (negative = may go that far behind)
  forearmMinForward: number;    // same rule for the forearm (0 = never behind the shoulder plane)
  keepPalmOrientation: number;  // 0..1: 1 keeps the tracked hand orientation in space (palm direction is meaningful in KSL)
};
export const DEFAULT_FRONT_CONSTRAINT: FrontConstraint = { enabled: true, bendPlane: 70, upperArmMinForward: 8, forearmMinForward: 0, keepPalmOrientation: 1 };

export type RigLayer = {
  runtimeRest?: string;
  frontConstraint?: Partial<FrontConstraint>;
  calibration?: { rotationFlip?: 'auto' | 1 | -1; palmForwardRoll?: Partial<Record<Side, number>> };
  joints?: Record<string, JointDef>;
  poses?: Record<string, PoseDef>;
};
export type RigFile = RigLayer & { version?: number; avatars?: Record<string, RigLayer> };
export type ResolvedRig = {
  runtimeRest?: string;
  frontConstraint: FrontConstraint;
  calibration: RigCalibration;
  joints: Record<string, JointDef>;
  poses: Record<string, PoseDef>;
};

export const DEFAULT_PALM_FORWARD_ROLL: Record<Side, number> = { Left: -90, Right: 90 };

/** Semantic joint table for the bundled VRMs. Axis/sign pairs come from the previous hard-coded Euler usage. */
export function defaultJoints(): Record<string, JointDef> {
  const rawDofs = (): Record<string, DofDef> => ({ rawX: { axis: 'x', sign: 1 }, rawY: { axis: 'y', sign: 1 }, rawZ: { axis: 'z', sign: 1 } });
  const joints: Record<string, JointDef> = {
    head: { bone: 'head', dofs: { pitch: { axis: 'x', sign: 1 }, yaw: { axis: 'y', sign: -1 }, roll: { axis: 'z', sign: -1 } } },
    spine: { bone: 'spine', dofs: { sideLean: { axis: 'z', sign: 1 } } },
    chest: { bone: 'chest', dofs: { sideLean: { axis: 'z', sign: 1 } } },
  };
  for (const side of ['left', 'right'] as const) {
    const left = side === 'left';
    joints[`${side}.upperArm`] = { bone: `${side}UpperArm`, dofs: { lowering: { axis: 'z', sign: left ? 1 : -1 } } };
    joints[`${side}.elbow`] = { bone: `${side}LowerArm`, dofs: { flexion: { axis: 'z', sign: left ? -1 : 1, limits: [0, 170] } } }; // illustrative anatomical limit, edit in avatar-rig.json or the rig editor
    joints[`${side}.wrist`] = { bone: `${side}Hand`, dofs: { roll: { axis: 'x', sign: 1 } } };
    for (const finger of ['thumb', 'index', 'middle', 'ring', 'pinky'] as const) {
      const segments = finger === 'thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
      const base = finger === 'pinky' ? 'little' : finger;
      segments.forEach((segment, i) => { joints[`${side}.${finger}.${i + 1}`] = { bone: `${side}${base[0].toUpperCase()}${base.slice(1)}${segment}`, dofs: rawDofs() }; });
    }
  }
  return joints;
}

const armPose = (lowering: number, flexion: number): SidePose =>
  ({ upperArm: { lowering }, elbow: { flexion }, wrist: { palm: 'forward', roll: 0 } });

export const DEFAULT_POSES: Record<string, PoseDef> = {
  bind: {
    label: 'Bind pose', description: 'The pose stored in the VRM file.', blend: 0.3,
    Left: { upperArm: { lowering: 0 }, elbow: { flexion: 0 }, wrist: { palm: 'down', roll: 0 } },
    Right: { upperArm: { lowering: 0 }, elbow: { flexion: 0 }, wrist: { palm: 'down', roll: 0 } },
  },
  idle: {
    label: 'At sides', description: 'Relaxed standing pose with a small elbow bend.', blend: 0.42,
    Left: armPose(84.797751, 6.875494), Right: armPose(84.797751, 6.875494),
  },
  'test-hands-up': {
    label: 'Test: hands up', description: 'Stress test: the pose that used to look like hands beside the head / arms behind the back.', blend: 0.4,
    Left: armPose(25, 120), Right: armPose(25, 120),
  },
  'test-arms-out': {
    label: 'Test: arms out', description: 'Stress test: arms straight out to the sides.', blend: 0.4,
    Left: armPose(0, 0), Right: armPose(0, 0),
  },
  // 'signing-neutral' has no built-in default: when absent it is derived from constraints.json `neutral`.
};

// ---------------------------------------------------------------- validation

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
type Warn = (message: string) => void;

function parseSide(raw: unknown, path: string, warn: Warn): SidePose | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) { warn(`${path} must be an object`); return undefined; }
  const out: SidePose = {};
  if (raw.upperArm !== undefined) {
    const v = isObj(raw.upperArm) ? num(raw.upperArm.lowering) : undefined;
    if (v === undefined) warn(`${path}.upperArm.lowering must be a number (degrees)`); else out.upperArm = { lowering: v };
  }
  if (raw.elbow !== undefined) {
    const v = isObj(raw.elbow) ? num(raw.elbow.flexion) : undefined;
    if (v === undefined) warn(`${path}.elbow.flexion must be a number (degrees)`); else out.elbow = { flexion: v };
  }
  if (raw.wrist !== undefined) {
    if (!isObj(raw.wrist)) warn(`${path}.wrist must be an object`);
    else {
      const wrist: NonNullable<SidePose['wrist']> = {};
      if (raw.wrist.palm !== undefined) { if (raw.wrist.palm === 'forward' || raw.wrist.palm === 'down') wrist.palm = raw.wrist.palm; else warn(`${path}.wrist.palm must be "forward" or "down"`); }
      if (raw.wrist.roll !== undefined) { const r = num(raw.wrist.roll); if (r === undefined) warn(`${path}.wrist.roll must be a number (degrees)`); else wrist.roll = r; }
      out.wrist = wrist;
    }
  }
  return out;
}

function parsePose(raw: unknown, path: string, warn: Warn): PoseDef | undefined {
  if (!isObj(raw)) { warn(`${path} must be an object`); return undefined; }
  const out: PoseDef = {};
  if (typeof raw.label === 'string') out.label = raw.label;
  if (typeof raw.description === 'string') out.description = raw.description;
  if (raw.blend !== undefined) { const b = num(raw.blend); if (b === undefined || b <= 0 || b > 1) warn(`${path}.blend must be a number in (0, 1]`); else out.blend = b; }
  if (typeof raw.clampToTrackingLimits === 'boolean') out.clampToTrackingLimits = raw.clampToTrackingLimits;
  for (const side of ['Left', 'Right'] as const) { const s = parseSide(raw[side], `${path}.${side}`, warn); if (s) out[side] = s; }
  return out;
}

function parseJoint(raw: unknown, path: string, warn: Warn): JointDef | undefined {
  if (!isObj(raw) || typeof raw.bone !== 'string' || !isObj(raw.dofs)) { warn(`${path} needs a "bone" string and a "dofs" object`); return undefined; }
  const dofs: Record<string, DofDef> = {};
  for (const [name, d] of Object.entries(raw.dofs)) {
    if (!isObj(d) || !['x', 'y', 'z'].includes(d.axis as string) || (d.sign !== 1 && d.sign !== -1)) { warn(`${path}.dofs.${name} needs axis "x"|"y"|"z" and sign 1|-1`); continue; }
    const def: DofDef = { axis: d.axis as Axis, sign: d.sign };
    if (d.limits !== undefined) {
      const l = d.limits;
      if (Array.isArray(l) && l.length === 2 && l.every((n) => num(n) !== undefined) && l[0] <= l[1]) def.limits = [l[0], l[1]]; else warn(`${path}.dofs.${name}.limits must be [min, max] in degrees`);
    }
    dofs[name] = def;
  }
  return { bone: raw.bone, dofs };
}

function parseLayer(raw: unknown, path: string, warn: Warn): RigLayer {
  const out: RigLayer = {};
  if (!isObj(raw)) { warn(`${path} must be an object`); return out; }
  if (typeof raw.runtimeRest === 'string') out.runtimeRest = raw.runtimeRest;
  if (raw.calibration !== undefined) {
    const c = raw.calibration;
    if (!isObj(c)) warn(`${path}.calibration must be an object`);
    else {
      out.calibration = {};
      if (c.rotationFlip !== undefined) { if (c.rotationFlip === 'auto' || c.rotationFlip === 1 || c.rotationFlip === -1) out.calibration.rotationFlip = c.rotationFlip; else warn(`${path}.calibration.rotationFlip must be "auto", 1 or -1`); }
      if (c.palmForwardRoll !== undefined) {
        if (!isObj(c.palmForwardRoll)) warn(`${path}.calibration.palmForwardRoll must be { Left, Right } in degrees`);
        else {
          out.calibration.palmForwardRoll = {};
          for (const side of ['Left', 'Right'] as const) {
            const v = c.palmForwardRoll[side];
            if (v === undefined) continue;
            if (num(v) === undefined) warn(`${path}.calibration.palmForwardRoll.${side} must be a number (degrees)`); else out.calibration.palmForwardRoll[side] = v as number;
          }
        }
      }
    }
  }
  if (raw.frontConstraint !== undefined) {
    const f = raw.frontConstraint;
    if (!isObj(f)) warn(`${path}.frontConstraint must be an object`);
    else {
      const fc: Partial<FrontConstraint> = {};
      if (f.enabled !== undefined) { if (typeof f.enabled === 'boolean') fc.enabled = f.enabled; else warn(`${path}.frontConstraint.enabled must be true or false`); }
      const ranges: Array<[keyof FrontConstraint, number, number]> = [['bendPlane', 0, 90], ['upperArmMinForward', -90, 90], ['forearmMinForward', -90, 90], ['keepPalmOrientation', 0, 1]];
      for (const [key, lo, hi] of ranges) {
        if (f[key] === undefined) continue;
        const v = num(f[key]);
        if (v === undefined || v < lo || v > hi) warn(`${path}.frontConstraint.${key} must be a number in [${lo}, ${hi}]`); else (fc as Record<string, number>)[key] = v;
      }
      out.frontConstraint = fc;
    }
  }
  if (raw.joints !== undefined) {
    if (!isObj(raw.joints)) warn(`${path}.joints must be an object`);
    else { out.joints = {}; for (const [id, j] of Object.entries(raw.joints)) { const parsed = parseJoint(j, `${path}.joints["${id}"]`, warn); if (parsed) out.joints[id] = parsed; } }
  }
  if (raw.poses !== undefined) {
    if (!isObj(raw.poses)) warn(`${path}.poses must be an object`);
    else { out.poses = {}; for (const [name, p] of Object.entries(raw.poses)) { const parsed = parsePose(p, `${path}.poses.${name}`, warn); if (parsed) out.poses[name] = parsed; } }
  }
  return out;
}

export function parseRigFile(raw: unknown, warn: Warn = (m) => console.warn(`avatar-rig.json: ${m}`)): RigFile {
  const out: RigFile = parseLayer(raw, '$', warn);
  if (isObj(raw)) {
    if (num(raw.version) !== undefined) out.version = raw.version as number;
    if (raw.avatars !== undefined) {
      if (!isObj(raw.avatars)) warn('$.avatars must be an object keyed by .vrm file name');
      else { out.avatars = {}; for (const [key, layer] of Object.entries(raw.avatars)) out.avatars[key] = parseLayer(layer, `$.avatars["${key}"]`, warn); }
    }
  }
  return out;
}

// ---------------------------------------------------------------- merging

const mergeJointValues = <T extends object>(a?: T, b?: T): T | undefined => (a || b ? { ...a, ...b } as T : undefined);
function mergeSide(a?: SidePose, b?: SidePose): SidePose | undefined {
  if (!a && !b) return undefined;
  const out: SidePose = {};
  const upperArm = mergeJointValues(a?.upperArm, b?.upperArm), elbow = mergeJointValues(a?.elbow, b?.elbow), wrist = mergeJointValues(a?.wrist, b?.wrist);
  if (upperArm) out.upperArm = upperArm; if (elbow) out.elbow = elbow; if (wrist) out.wrist = wrist;
  return out;
}
export function mergePose(a: PoseDef | undefined, b: PoseDef | undefined): PoseDef {
  const out: PoseDef = { ...a, ...b };
  const left = mergeSide(a?.Left, b?.Left), right = mergeSide(a?.Right, b?.Right);
  if (left) out.Left = left; if (right) out.Right = right;
  return out;
}

function applyLayer(target: ResolvedRig, layer: RigLayer | undefined) {
  if (!layer) return;
  if (layer.runtimeRest) target.runtimeRest = layer.runtimeRest;
  if (layer.frontConstraint) target.frontConstraint = { ...target.frontConstraint, ...layer.frontConstraint };
  if (layer.calibration?.rotationFlip !== undefined) target.calibration.rotationFlip = layer.calibration.rotationFlip;
  if (layer.calibration?.palmForwardRoll) target.calibration.palmForwardRoll = { ...target.calibration.palmForwardRoll, ...layer.calibration.palmForwardRoll };
  for (const [id, joint] of Object.entries(layer.joints ?? {})) target.joints[id] = joint;
  for (const [name, pose] of Object.entries(layer.poses ?? {})) target.poses[name] = mergePose(target.poses[name], pose);
}

const mergeLayer = (a: RigLayer | undefined, b: RigLayer | undefined): RigLayer => {
  const out: RigLayer = { ...a, ...b };
  if (a?.frontConstraint || b?.frontConstraint) out.frontConstraint = { ...a?.frontConstraint, ...b?.frontConstraint };
  if (a?.calibration || b?.calibration) out.calibration = { ...a?.calibration, ...b?.calibration, palmForwardRoll: { ...a?.calibration?.palmForwardRoll, ...b?.calibration?.palmForwardRoll } };
  if (a?.joints || b?.joints) out.joints = { ...a?.joints, ...b?.joints };
  if (a?.poses || b?.poses) {
    out.poses = { ...a?.poses };
    for (const [name, pose] of Object.entries(b?.poses ?? {})) out.poses[name] = mergePose(out.poses[name], pose);
  }
  return out;
};
/** Overlay `patch` (e.g. the rig editor's saved edits) on `base` (avatar-rig.json). Both may be undefined. */
export function mergeRigFiles(base: RigFile | undefined, patch: RigFile | undefined): RigFile | undefined {
  if (!base && !patch) return undefined;
  const out: RigFile = { ...mergeLayer(base, patch), version: base?.version ?? patch?.version ?? 1 };
  const keys = new Set([...Object.keys(base?.avatars ?? {}), ...Object.keys(patch?.avatars ?? {})]);
  if (keys.size) { out.avatars = {}; for (const k of keys) out.avatars[k] = mergeLayer(base?.avatars?.[k], patch?.avatars?.[k]); }
  return out;
}

/** defaults < file-level settings < settings for this avatar's .vrm file name. */
export function resolveRig(file: RigFile | undefined, avatarKey: string | undefined): ResolvedRig {
  const resolved: ResolvedRig = {
    frontConstraint: { ...DEFAULT_FRONT_CONSTRAINT },
    calibration: { rotationFlip: 'auto', palmForwardRoll: { ...DEFAULT_PALM_FORWARD_ROLL } },
    joints: defaultJoints(),
    poses: Object.fromEntries(Object.entries(DEFAULT_POSES).map(([k, v]) => [k, mergePose(undefined, v)])),
  };
  applyLayer(resolved, file);
  if (file && avatarKey) applyLayer(resolved, file.avatars?.[avatarKey]);
  return resolved;
}

export async function loadRigFile(url: string): Promise<RigFile | undefined> {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${url}`);
    const contentType = response.headers.get('content-type') ?? 'unknown content type';
    const text = await response.text();
    if (!contentType.toLowerCase().includes('json') || !/^[\s]*[{]/.test(text)) throw new Error(`Expected JSON at ${url}, received ${contentType}.`);
    const parsed = parseRigFile(JSON.parse(text) as unknown);
    console.info('Avatar rig config loaded', { poses: Object.keys(parsed.poses ?? {}), avatars: Object.keys(parsed.avatars ?? {}) });
    return parsed;
  } catch (error) {
    console.info('Using built-in avatar rig defaults:', error);
    return undefined;
  }
}
