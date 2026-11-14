// Rule-based constraint layer for the Motion Studio retargeter.
// Limits come from constraints.json (extracted offline from the KSL recordings);
// DEFAULT_CONSTRAINTS approximates the previous hand-tuned numbers so the app
// still works when that file is missing.
//
// Unit convention (must match the Colab extraction):
//   x = fraction of image width, y = (fraction of image height) / (width / height),
//   so x and y share one unit. Distances are divided by the shoulder span, which
//   makes them independent of camera distance and of the video's aspect ratio.

export type Range = [number, number];
export type Side = 'Left' | 'Right';
export type ArmLimits = {
  upperRotation: Range;          // rad, same definition as drivePose()
  elbowFlex: Range;              // rad, |forearm angle - upper-arm angle|
  wristX: Range;                 // (wrist.x - centerX) / shoulderSpan
  wristY: Range;                 // (wrist.y - shouldersY) / shoulderSpan, down is positive
  elbowX: Range;
  elbowY: Range;
  maxRate: { upper: number; elbow: number }; // rad/s, spike rejection
  elbowGivenUpper?: { edges: number[]; ranges: Range[] }; // coupling buckets
};
export type JointLimit = { x: Range; y: Range; z: Range };
export type Constraints = {
  version: number;
  meta: Record<string, unknown>;
  outwardAngle: number;
  arms: Record<Side, ArmLimits>;
  head: { roll: Range };
  torsoTilt: Range;
  neutral: { enabled: boolean; Left: { upperRotation: number; elbowFlex: number }; Right: { upperRotation: number; elbowFlex: number } };
  handAssign: { maxDistSpan: number };
  fingers?: Record<string, JointLimit>; // keyed like Kalidokit output, e.g. LeftIndexProximal
};

const defaultArm = (): ArmLimits => ({
  upperRotation: [-0.95, 1.2], elbowFlex: [0, 2.15],
  wristX: [-1.05, 1.05], wristY: [0.05, 2.0],
  elbowX: [-1.2, 1.2], elbowY: [0.2, 2.0],
  maxRate: { upper: 40, elbow: 60 },
});

export const DEFAULT_CONSTRAINTS: Constraints = {
  version: 1,
  meta: { source: 'built-in defaults' },
  outwardAngle: 0.78,
  arms: { Left: defaultArm(), Right: defaultArm() },
  head: { roll: [-0.6, 0.6] },
  torsoTilt: [-0.08, 0.08],
  neutral: { enabled: false, Left: { upperRotation: 0.4, elbowFlex: 0.3 }, Right: { upperRotation: 0.4, elbowFlex: 0.3 } },
  handAssign: { maxDistSpan: 1.5 },
};

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const clampRange = (v: number, r: Range) => clamp(v, r[0], r[1]);
export const inRange = (v: number, r: Range) => v >= r[0] && v <= r[1];

const isRange = (v: unknown): v is Range =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) && (v as number[])[0] <= (v as number[])[1];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Overlay `over` on `base`; anything malformed in `over` keeps the default.
function merge<T>(base: T, over: unknown): T {
  if (isRange(base)) return (isRange(over) ? over : base) as T;
  if (typeof base === 'number') return (typeof over === 'number' && Number.isFinite(over) ? over : base) as T;
  if (typeof base === 'boolean') return (typeof over === 'boolean' ? over : base) as T;
  if (isObj(base) && isObj(over)) {
    const out: Record<string, unknown> = { ...base };
    for (const k of Object.keys(base)) if (k in over) out[k] = merge((base as Record<string, unknown>)[k], over[k]);
    for (const k of Object.keys(over)) if (!(k in base)) out[k] = over[k]; // optional blocks: elbowGivenUpper, fingers, meta
    return out as T;
  }
  return base;
}

export async function loadConstraints(url: string): Promise<Constraints> {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${url}`);
    const contentType = response.headers.get('content-type') ?? 'unknown content type';
    const text = await response.text();
    if (!contentType.toLowerCase().includes('json') || !/^[\s]*[\[{]/.test(text)) {
      throw new Error(`Expected JSON at ${url}, received ${contentType}. Keep the file at public/constraints.json.`);
    }
    const merged = merge(DEFAULT_CONSTRAINTS, JSON.parse(text) as unknown);
    console.info('Constraints loaded', merged.meta);
    return merged;
  } catch (error) {
    console.info('Using built-in constraint defaults:', error);
    return DEFAULT_CONSTRAINTS;
  }
}

/** Elbow range for the current upper-arm angle (coupling buckets), else the global range. */
export function elbowRangeFor(arm: ArmLimits, upper: number): Range {
  const g = arm.elbowGivenUpper;
  if (!g || g.ranges.length !== g.edges.length + 1) return arm.elbowFlex;
  let i = 0;
  while (i < g.edges.length && upper > g.edges[i]) i++;
  const r = g.ranges[i];
  return isRange(r) ? r : arm.elbowFlex;
}

const lastValue = new Map<string, number>();
/** Limit how fast a joint angle may change (rad/s). Rejects single-frame landmark glitches. */
export function rateLimit(key: string, target: number, maxRate: number, dt: number): number {
  const prev = lastValue.get(key);
  let next = target;
  if (prev !== undefined && Number.isFinite(maxRate) && dt > 0) {
    const step = maxRate * dt;
    next = clamp(target, prev - step, prev + step);
  }
  lastValue.set(key, next);
  return next;
}
export const resetRateLimits = () => lastValue.clear();
