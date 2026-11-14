// Run: node --experimental-strip-types scripts/test-arm-ik.mjs
import * as THREE from 'three';
import { solveArm3D, bindDirection, palmWorldRotation, localHand, fingerSpread, spreadToYRotation } from '../src/avatar/ArmIK3D.ts';
const DEG = Math.PI / 180, ang = (a, b) => Math.acos(Math.min(1, Math.max(-1, a.clone().normalize().dot(b.clone().normalize())))) / DEG;
let fails = 0; const check = (ok, msg) => { if (!ok) { fails++; console.log('FAIL', msg); } };
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

let worstDir = 0, worstFlex = 0, n = 0;
for (const flip of [-1, 1]) for (const side of ['left', 'right']) for (let i = 0; i < 400; i++) {
  const b = bindDirection(side, flip);
  const dir = new THREE.Vector3(rnd() - .5, rnd() - .9, (rnd() - .2) * flip * -1).normalize(); // arm pointing down/forward-ish
  const swing = new THREE.Quaternion().setFromUnitVectors(b, dir);
  const twist = (rnd() - .5) * 2 * 100 * DEG;                    // true twist within +-100deg
  const upper = swing.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), twist));
  const hingeSign = side === 'left' ? -1 : 1;                      // same as defaultJoints
  const flex = (20 + rnd() * 120) * DEG;                           // semantic flexion, positive
  const lower = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), flex * flip * hingeSign);
  const shoulder = new THREE.Vector3(0, 0, 0);
  const elbow = b.clone().applyQuaternion(upper).multiplyScalar(.3);
  const wrist = elbow.clone().add(b.clone().applyQuaternion(upper.clone().multiply(lower)).multiplyScalar(.28));
  const sol = solveArm3D(shoulder, elbow, wrist, { side, flip, hingeSign, hingeRange: [0, 170], fallbackTwistDeg: 70 });
  check(!!sol, 'no solution'); if (!sol) continue;
  const e1 = ang(b.clone().applyQuaternion(sol.upper), elbow);
  const e2 = ang(b.clone().applyQuaternion(sol.upper.clone().multiply(sol.lower)), wrist.clone().sub(elbow));
  worstDir = Math.max(worstDir, e1, e2); worstFlex = Math.max(worstFlex, Math.abs(sol.flexionDeg - flex / DEG)); n++;
  check(e1 < .5 && e2 < .5, `direction mismatch flip=${flip} ${side}: ${e1.toFixed(2)} ${e2.toFixed(2)}`);
  check(sol.flexionDeg >= -1e-6, 'negative flexion');
}
console.log(`arm FK round-trip: ${n} cases, worst direction error ${worstDir.toFixed(3)} deg, worst flexion error ${worstFlex.toFixed(3)} deg`);

// Straight / near-straight arm must stay finite and use the fallback bend plane.
for (const flip of [-1, 1]) {
  const b = bindDirection('left', flip);
  const s = solveArm3D(new THREE.Vector3(), b.clone().multiplyScalar(.3), b.clone().multiplyScalar(.58), { side: 'left', flip, hingeSign: -1, hingeRange: [0, 149], fallbackTwistDeg: 70 });
  check(s && Number.isFinite(s.flexionDeg) && s.flexionDeg < 1, 'straight arm');
}

// Palm frame round trip
let worstPalm = 0;
for (const flip of [-1, 1]) for (const side of ['left', 'right']) for (let i = 0; i < 200; i++) {
  const bf = bindDirection(side, flip), bp = new THREE.Vector3(0, 0, flip);
  const Q = new THREE.Quaternion(rnd() - .5, rnd() - .5, rnd() - .5, rnd() - .5).normalize();
  const P = (v) => v.clone().applyQuaternion(Q);
  const wrist = new THREE.Vector3(.1, .2, .3);
  const mid = wrist.clone().add(P(bf.clone().multiplyScalar(.09)));
  const idx = wrist.clone().add(P(bf.clone().multiplyScalar(.085).addScaledVector(bp, -.02)));
  const pk = wrist.clone().add(P(bf.clone().multiplyScalar(.07).addScaledVector(bp, .035)));
  const got = palmWorldRotation(wrist, idx, mid, pk, { side, flip });
  const e = got.angleTo(Q) / DEG; worstPalm = Math.max(worstPalm, e);
  check(e < .01, `palm round trip ${e}`);
  const id = new THREE.Quaternion();
  const local = localHand(got, id, id); check(local.angleTo(got) < 1e-6, 'localHand identity chain');
}
console.log(`palm frame round-trip worst error ${worstPalm.toExponential(2)} deg`);

// Finger spread sign + y-rotation direction (both sides, both conventions)
for (const flip of [-1, 1]) for (const side of ['left', 'right']) {
  const bf = bindDirection(side, flip), bp = new THREE.Vector3(0, 0, flip);
  const wrist = new THREE.Vector3(), mid = bf.clone().multiplyScalar(.09), idx = bf.clone().multiplyScalar(.09).addScaledVector(bp, -.02), pk = bf.clone().multiplyScalar(.08).addScaledVector(bp, .04);
  for (const sigma of [-25 * DEG, 0, 18 * DEG]) {
    const mcp = bf.clone().multiplyScalar(.09).addScaledVector(bp, -.02);
    const pip = mcp.clone().add(bf.clone().multiplyScalar(Math.cos(sigma) * .04).addScaledVector(bp, Math.sin(sigma) * .04));
    const got = fingerSpread(mcp, pip, wrist, mid, idx, pk);
    check(Math.abs(got - sigma) < 1e-6, `spread ${got / DEG} vs ${sigma / DEG}`);
    const rotated = bf.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), spreadToYRotation(sigma, side));
    const towardPinky = rotated.dot(bp);
    check(Math.sign(Math.round(towardPinky * 1e6)) === Math.sign(sigma), `y-rotation direction flip=${flip} ${side} sigma=${sigma / DEG}: ${towardPinky}`);
  }
}
console.log(fails ? `${fails} FAILURES` : 'ALL ARM-IK TESTS PASSED');
process.exit(fails ? 1 : 0);
