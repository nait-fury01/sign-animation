// Run: node --experimental-strip-types scripts/test-constraints.mjs
import fs from 'node:fs';
import { loadConstraints, DEFAULT_CONSTRAINTS } from '../src/constraints.ts';
let fails = 0; const check = (ok, msg) => { if (!ok) { fails++; console.log('FAIL', msg); } };
const serve = (text) => { globalThis.fetch = async () => ({ ok: true, headers: { get: () => 'application/json' }, text: async () => text }); };
const origWarn = console.warn, origInfo = console.info; let warned = 0; console.warn = () => { warned++; }; console.info = () => {};

// 1. The shipped file: every arm range must have real width (a collapsed [0,0] pinned the Left elbow to the sternum).
const shipped = fs.readFileSync('public/constraints.json', 'utf8');
serve(shipped);
const C = await loadConstraints('/constraints.json');
for (const side of ['Left', 'Right']) for (const k of ['upperRotation', 'elbowFlex', 'wristX', 'wristY', 'elbowX', 'elbowY'])
  check(C.arms[side][k][1] - C.arms[side][k][0] > 0.05, `${side}.${k} is collapsed: ${C.arms[side][k]}`);
check(warned === 0, 'shipped constraints.json produced warnings');
// Left/Right should be roughly mirror images in x: Left elbow right of centre, Right elbow left of centre.
check(C.arms.Left.elbowX[0] > 0 && C.arms.Right.elbowX[1] < 0, 'elbowX sides are not mirrored');
check(C.soft && C.soft.hardMargin > C.soft.workspaceMargin, 'soft settings missing');

// 2. A collapsed range in a user file is rejected, falling back to the built-in default instead of breaking an arm.
const bad = JSON.parse(shipped); bad.arms.Left.elbowX = [0, 0];
serve(JSON.stringify(bad)); warned = 0;
const C2 = await loadConstraints('/constraints.json');
check(warned >= 1, 'collapsed range did not warn');
check(C2.arms.Left.elbowX[1] - C2.arms.Left.elbowX[0] > 0.5, 'collapsed range was not replaced by the default');

console.warn = origWarn; console.info = origInfo;
console.log(fails ? `${fails} FAILURES` : 'ALL CONSTRAINT TESTS PASSED');
process.exit(fails ? 1 : 0);
