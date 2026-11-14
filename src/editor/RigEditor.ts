// Phase 5: in-app rig editor. Everything here goes through AvatarRig.edit(), so changes are layered on top of
// public/avatar-rig.json, saved in this browser, and can be exported back to the JSON file.
import type { AvatarRig } from '../avatar/AvatarRig';
import { parseRigFile, type FrontConstraint, type Side } from '../avatar/rigConfig';

const DEG = Math.PI / 180;
type Props = Record<string, unknown>;
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (v !== undefined && v !== false) el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

export type EditorHooks = {
  rig: AvatarRig;
  toast: (message: string) => void;
  /** Called after any edit so main.ts can redraw the held pose. */
  changed: () => void;
};

export function mountRigEditor({ rig, toast, changed }: EditorHooks) {
  const sidebar = document.querySelector<HTMLElement>('.sidebar')!;
  const button = document.querySelector<HTMLButtonElement>('#editor-button')!;
  const panel = h('aside', { class: 'rig-editor', hidden: true, 'aria-label': 'Avatar rig editor' });
  const sidebarContent = [...sidebar.childNodes];
  const editorHost = h('div', { class: 'sidebar-editor-host', hidden: true });
  sidebar.append(editorHost);
  editorHost.append(panel);
  let scope: 'avatar' | 'all' = 'avatar';
  let lastAvatar = rig.avatar;

  const setHold = (mode: 'off' | 'rest' | 'free') => { rig.editHold = mode; syncModeButtons(); };
  const restName = () => rig.poses.restName();
  const apply = () => { changed(); };

  // ---- small widgets ---------------------------------------------------------------------------------
  const slider = (label: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void, unit = '°') => {
    const out = h('output', {}, `${round(value)}${unit}`);
    const input = h('input', { type: 'range', min, max, step, value });
    input.addEventListener('input', () => { const v = Number(input.value); out.textContent = `${round(v)}${unit}`; onInput(v); });
    return h('label', { class: 're-row' }, h('span', {}, label), input, out);
  };
  const check = (label: string, value: boolean, onChange: (v: boolean) => void) => {
    const input = h('input', { type: 'checkbox' }); input.checked = value;
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 're-check' }, input, h('span', {}, label));
  };
  const select = (label: string, options: Array<[string, string]>, value: string, onChange: (v: string) => void) => {
    const el = h('select', {}, ...options.map(([v, t]) => { const o = h('option', { value: v }, t); if (v === value) o.selected = true; return o; }));
    el.addEventListener('change', () => onChange(el.value));
    return h('label', { class: 're-row' }, h('span', {}, label), el);
  };
  const btn = (label: string, onClick: () => void, cls = '') => h('button', { type: 'button', class: `re-btn ${cls}`, onClick }, label);
  const section = (title: string, hint: string | undefined, ...body: Child[]) =>
    h('details', { class: 're-section', open: true }, h('summary', {}, title), hint ? h('p', { class: 're-hint' }, hint) : null, ...body);
  const round = (v: number) => Math.round(v * 10) / 10;

  // ---- edit helpers ------------------------------------------------------------------------------------
  const editFront = (key: keyof FrontConstraint, value: number | boolean) => {
    rig.edit(scope, (l) => { l.frontConstraint = { ...l.frontConstraint, [key]: value }; });
    apply();
  };
  const editRest = (side: Side, part: 'upperArm' | 'elbow' | 'wrist', key: string, value: number | string) => {
    const name = restName();
    rig.edit(scope, (l) => {
      l.poses ??= {}; const pose = (l.poses[name] ??= {}); const sp = ((pose[side] ??= {}) as Record<string, Record<string, unknown>>);
      (sp[part] ??= {})[key] = value;
    });
    if (rig.editHold === 'off') setHold('rest');
    apply();
  };
  const editElbowLimit = (min: number, max: number) => {
    rig.edit(scope, (l) => {
      l.joints ??= {};
      for (const id of ['left.elbow', 'right.elbow']) {
        const cur = rig.config.joints[id]; if (!cur) continue;
        l.joints[id] = { bone: cur.bone, dofs: { ...cur.dofs, flexion: { ...cur.dofs.flexion, limits: [min, max] } } };
      }
    });
    apply();
  };

  // ---- panel -------------------------------------------------------------------------------------------
  const modeButtons: Record<string, HTMLButtonElement> = {};
  const syncModeButtons = () => { for (const [k, b] of Object.entries(modeButtons)) b.classList.toggle('on', k === 'live' ? rig.editHold === 'off' : rig.editHold !== 'off' && k === 'edit'); };

  function render() {
    lastAvatar = rig.avatar;
    const cfg = rig.config, fc = cfg.frontConstraint, name = restName(), pose = rig.poses.get(name) ?? {};
    const elbowLimits = rig.joint('left.elbow').getLimits('flexion') ?? [0, 170];
    const sections: Child[] = [];

    modeButtons.live = btn('Live tracking', () => setHold('off'));
    modeButtons.edit = btn('Edit (hold rest pose)', () => { setHold('rest'); apply(); });
    sections.push(
      h('header', {}, h('b', {}, 'Rig editor'), btn('✕', () => toggle(false), 're-close')),
      h('p', { class: 're-hint' }, `Avatar: ${rig.avatar ?? '—'}. Edits are saved in this browser; use Export to write them into avatar-rig.json.`),
      h('div', { class: 're-seg' }, modeButtons.live, modeButtons.edit),
      select('Apply edits to', [['avatar', 'this avatar only'], ['all', 'all avatars']], scope, (v) => { scope = v as 'avatar' | 'all'; }),
    );

    sections.push(section('1 · Keep arms in front of the body',
      'Hands beside the head or arms behind the back? Turn this on and raise “Elbow bends forward”.',
      check('Front-of-body constraint', fc.enabled, (v) => editFront('enabled', v)),
      slider('Elbow bends forward', 0, 90, 1, fc.bendPlane, (v) => editFront('bendPlane', v)),
      slider('Upper arm lifted forward ≥', -30, 45, 1, fc.upperArmMinForward, (v) => editFront('upperArmMinForward', v)),
      slider('Forearm in front ≥', -30, 45, 1, fc.forearmMinForward, (v) => editFront('forearmMinForward', v)),
      slider('Keep palm orientation', 0, 1, 0.05, fc.keepPalmOrientation, (v) => editFront('keepPalmOrientation', v), ''),
      h('div', { class: 're-actions' },
        btn('Test: hands up', () => { setHold('free'); rig.poses.apply('test-hands-up', { alpha: 1 }); }),
        btn('Test: arms out', () => { setHold('free'); rig.poses.apply('test-arms-out', { alpha: 1 }); })),
    ));

    const restRows = (side: Side) => {
      const sp = pose[side] ?? {};
      return [
        h('h4', {}, `${side} arm`),
        slider('Arm lowering', -40, 120, 0.5, sp.upperArm?.lowering ?? 0, (v) => editRest(side, 'upperArm', 'lowering', v)),
        slider('Elbow flexion', 0, 170, 0.5, sp.elbow?.flexion ?? 0, (v) => editRest(side, 'elbow', 'flexion', v)),
        select('Palm faces', [['forward', 'forward'], ['down', 'down']], sp.wrist?.palm ?? 'forward', (v) => editRest(side, 'wrist', 'palm', v)),
        slider('Wrist roll', -180, 180, 1, sp.wrist?.roll ?? 0, (v) => editRest(side, 'wrist', 'roll', v)),
      ];
    };
    sections.push(section(`2 · Rest pose “${pose.label ?? name}”`, 'The pose shown before the camera starts and whenever tracking drops.',
      ...restRows('Left'), ...restRows('Right'),
      check('Clamp to tracked range (as before)', pose.clampToTrackingLimits ?? false, (v) => {
        rig.edit(scope, (l) => { l.poses ??= {}; (l.poses[name] ??= {}).clampToTrackingLimits = v; }); if (rig.editHold === 'off') setHold('rest'); apply();
      }),
      h('div', { class: 're-actions' }, btn('Mirror Left → Right', () => {
        const l = pose.Left; if (!l) return;
        rig.edit(scope, (layer) => { layer.poses ??= {}; (layer.poses[name] ??= {}).Right = JSON.parse(JSON.stringify(l)); });
        setHold('rest'); apply(); render();
      })),
    ));

    sections.push(section('3 · Joint limits', 'Hinge limit enforced on live tracking and on poses. Illustrative anatomical values, not validated.',
      slider('Elbow flexion max', 90, 200, 1, elbowLimits[1], (v) => editElbowLimit(elbowLimits[0], v)),
    ));

    sections.push(section('4 · Avatar calibration', 'Facts about this skeleton. Per-avatar values are exported under "avatars" in the JSON.',
      select('Rotation flip', [['auto', `auto (now ${rig.adapter.flip})`], ['1', '1 (VRM 0)'], ['-1', '-1 (VRM 1)']], String(cfg.calibration.rotationFlip), (v) => {
        rig.edit(scope, (l) => { l.calibration = { ...l.calibration, rotationFlip: v === 'auto' ? 'auto' : (Number(v) as 1 | -1) }; }); apply();
      }),
      ...(['Left', 'Right'] as const).map((side) => slider(`Palm-forward roll ${side}`, -180, 180, 1, cfg.calibration.palmForwardRoll[side], (v) => {
        rig.edit(scope, (l) => { l.calibration = { ...l.calibration, palmForwardRoll: { ...l.calibration?.palmForwardRoll, [side]: v } }; }); apply();
      })),
    ));

    const jointSelect = h('select', {}, ...rig.jointIds().filter((id) => !id.includes('.thumb') && !/\.(index|middle|ring|pinky)/.test(id)).map((id) => h('option', { value: id }, id)));
    const probeValues = [0, 0, 0];
    const probe = (axis: number) => (v: number) => { probeValues[axis] = v; setHold('free'); rig.joint(jointSelect.value).drive(probeValues[0] * DEG, probeValues[1] * DEG, probeValues[2] * DEG, 1); };
    sections.push(section('5 · Joint probe', 'Measure a joint\'s raw axes (to add new movements in the "joints" block). Values are raw tracking-domain degrees.',
      h('label', { class: 're-row' }, h('span', {}, 'Joint'), jointSelect),
      slider('raw X', -180, 180, 1, 0, probe(0)), slider('raw Y', -180, 180, 1, 0, probe(1)), slider('raw Z', -180, 180, 1, 0, probe(2)),
    ));

    const nameInput = h('input', { type: 'text', placeholder: 'pose name, e.g. greeting', class: 're-text' });
    const asRest = h('input', { type: 'checkbox' });
    const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0]; if (!f) return;
      try { rig.userPatch = parseRigFile(JSON.parse(await f.text())); rig.persist(); rig.reload(); toast('Rig file imported.'); setHold('rest'); apply(); render(); }
      catch (e) { toast(`Could not import: ${e instanceof Error ? e.message : String(e)}`); }
    });
    sections.push(section('6 · Poses and files', undefined,
      h('div', { class: 're-actions' }, nameInput),
      h('label', { class: 're-check' }, asRest, h('span', {}, 'use it as the rest pose')),
      h('div', { class: 're-actions' },
        btn('Capture current pose', () => {
          const n = nameInput.value.trim(); if (!n) { toast('Give the pose a name first.'); return; }
          const captured = rig.poses.save(n);
          rig.edit(scope, (l) => { l.poses ??= {}; l.poses[n] = captured; if (asRest.checked) l.runtimeRest = n; });
          toast(`Pose “${n}” saved${asRest.checked ? ' and set as rest pose' : ''}.`); render();
        }),
        btn('Export JSON', () => {
          const blob = new Blob([JSON.stringify(rig.file ?? {}, null, 2)], { type: 'application/json' });
          const a = h('a', { href: URL.createObjectURL(blob), download: 'avatar-rig.json' }); a.click(); URL.revokeObjectURL(a.href);
        }),
        btn('Copy JSON', () => { void navigator.clipboard?.writeText(JSON.stringify(rig.file ?? {}, null, 2)).then(() => toast('avatar-rig.json copied.')); }),
        btn('Import…', () => fileInput.click()),
        btn('Reset all edits', () => { if (confirm('Discard every edit saved in this browser?')) { rig.resetEdits(); setHold('rest'); apply(); render(); } }, 're-danger'),
      ), fileInput,
    ));

    panel.replaceChildren(...(sections.filter(Boolean) as Node[]));
    syncModeButtons();
  }

  function toggle(open: boolean = Boolean(panel.hidden)) {
    panel.hidden = false;
    editorHost.hidden = !open;
    for (const node of sidebar.children) if (node !== editorHost) (node as HTMLElement).hidden = open;
    button.classList.toggle('active', open);
    if (open) { render(); if (rig.editHold === 'off' && !document.querySelector('#camera-state.on')) setHold('rest'); apply(); }
    else setHold('off');
  }
  button.addEventListener('click', () => toggle());
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (e.key.toLowerCase() === 'e' && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|SELECT|TEXTAREA)$/.test(t?.tagName ?? '')) toggle();
  });
  window.setInterval(() => { if (!panel.hidden && rig.avatar !== lastAvatar) { render(); apply(); } }, 600); // avatar switched
}
