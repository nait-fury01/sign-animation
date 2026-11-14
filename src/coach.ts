// Live "setup coach": turns tracking measurements into plain-language advice (distance, lighting, framing, speed).
// A tip appears only after its condition has held for HOLD_MS, and disappears after it has been clear for CLEAR_MS,
// so the panel does not flicker. Pure logic: no DOM access here.

type Pt = { x: number; y: number; z?: number; visibility?: number };
export type CoachInput = {
  running: boolean; videoWidth: number; videoHeight: number;
  pose?: Pt[]; hands: Pt[][]; faceFound: boolean;
  luma: number;        // mean brightness of the camera image, 0-255
  backlight: number;   // background-corner brightness minus face-area brightness (positive = backlit)
  renderFps: number; detectHz: number; delegate: 'GPU' | 'CPU' | 'unknown';
  arms: { Left: string; Right: string };
};
export type Tip = { id: string; level: 'warn' | 'info'; title: string; detail: string };

const HOLD_MS = 1500, CLEAR_MS = 2500;
const state = new Map<string, { since: number; clearSince?: number; shown: boolean }>();

function candidates(i: CoachInput): Tip[] {
  const out: Tip[] = [];
  const vis = (p?: Pt, t = 0.5) => Boolean(p && (p.visibility === undefined || p.visibility >= t));
  const sh = i.pose && vis(i.pose[11], 0.4) && vis(i.pose[12], 0.4) ? [i.pose[11], i.pose[12]] : undefined;
  const span = sh ? Math.abs(sh[0].x - sh[1].x) : undefined;
  const shY = sh ? (sh[0].y + sh[1].y) / 2 : undefined;

  if (i.luma < 70) out.push({ id: 'dark', level: 'warn', title: 'Too dark', detail: 'Face a window or put a lamp behind the camera. Dim light makes hands blur and tracking jitter.' });
  else if (i.backlight > 45) out.push({ id: 'backlit', level: 'warn', title: 'Light is behind you', detail: 'Turn so the window or lamp is in front of you, not behind. A backlit face and hands lose detail.' });
  if (!i.faceFound) out.push({ id: 'noface', level: 'info', title: 'Face not found', detail: 'Face the camera and keep your head fully in view.' });

  if (span !== undefined && span > 0.5) out.push({ id: 'close', level: 'warn', title: 'Move further back', detail: 'Your shoulders fill the frame, so elbows and hands fall off the edges. Step back about an arm\u2019s length more.' });
  else if (span !== undefined && span < 0.14) out.push({ id: 'far', level: 'info', title: 'Move a little closer', detail: 'You are very small in the frame; finger detail gets lost.' });
  if (shY !== undefined && shY > 0.8) out.push({ id: 'low', level: 'warn', title: 'Shoulders at the bottom edge', detail: 'Raise the camera to about chest height or tilt it up, so shoulders sit in the lower third and elbows stay visible.' });
  if (sh && i.pose && (!vis(i.pose[13], 0.5) || !vis(i.pose[14], 0.5))) out.push({ id: 'elbows', level: 'warn', title: 'Elbows not visible', detail: 'The avatar has to guess elbow positions. Step back or lift the camera until both elbows are in frame.' });
  if (!sh && i.running && i.faceFound) out.push({ id: 'shoulders', level: 'warn', title: 'Shoulders not visible', detail: 'Show both shoulders and your upper arms so the arms can be tracked.' });

  const edge = i.hands.some((h) => h.some((p) => p.x < 0.015 || p.x > 0.985 || p.y < 0.015));
  if (edge) out.push({ id: 'edge', level: 'warn', title: 'A hand is leaving the frame', detail: 'Keep signs inside the picture. Moving back or using a wider camera view gives your hands more room.' });

  if (i.arms.Left === 'NEUTRAL' || i.arms.Right === 'NEUTRAL') out.push({ id: 'neutral', level: 'info', title: 'An arm dropped to the rest pose', detail: 'That arm is out of view or unreadable. Bring it back in front of your body, between waist and eye level.' });

  if (i.videoWidth > 0 && i.videoWidth < 1000) out.push({ id: 'res', level: 'info', title: 'Low camera resolution', detail: `The camera is delivering ${i.videoWidth}\u00d7${i.videoHeight}. Try another USB port/camera, close other apps using it, or better light (cameras drop resolution in the dark).` });
  if (i.delegate === 'CPU') out.push({ id: 'cpu', level: 'warn', title: 'Running on the CPU', detail: 'GPU acceleration was not available, so tracking is slow. Enable hardware acceleration in the browser settings and update graphics drivers.' });
  if (i.renderFps > 0 && i.renderFps < 20) out.push({ id: 'slow', level: 'warn', title: 'Low frame rate', detail: 'Close other tabs/apps, plug in the laptop, or reload with ?pose=lite for a lighter pose model.' });
  else if (i.detectHz > 0 && i.detectHz < 15) out.push({ id: 'slowdet', level: 'info', title: 'Tracking is updating slowly', detail: 'Fast signs may look delayed. Close other tabs/apps or reload with ?pose=lite.' });
  return out;
}

export function updateCoach(i: CoachInput, now = performance.now()): Tip[] {
  if (!i.running) { state.clear(); return []; }
  const active = new Map(candidates(i).map((t) => [t.id, t]));
  const shown: Tip[] = [];
  for (const [id, tip] of active) {
    const s = state.get(id) ?? { since: now, shown: false };
    s.clearSince = undefined;
    if (!s.shown && now - s.since >= HOLD_MS) s.shown = true;
    state.set(id, s);
    if (s.shown) shown.push(tip);
  }
  for (const [id, s] of [...state]) {
    if (active.has(id)) continue;
    s.clearSince ??= now;
    if (!s.shown || now - s.clearSince >= CLEAR_MS) state.delete(id);
  }
  return shown.sort((a, b) => (a.level === b.level ? 0 : a.level === 'warn' ? -1 : 1)).slice(0, 3);
}
