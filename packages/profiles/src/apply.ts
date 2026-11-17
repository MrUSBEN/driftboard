import { randomInt } from 'node:crypto';
import type { Graph, Manifest, Profile, Slot } from './manifest.ts';

export interface SlotValues { [slotId: string]: unknown }
/** Name ComfyUI knows an uploaded asset by (what goes in a LoadImage "image" input). */
export type ImageName = string;

export interface Applied { graph: Graph; values: SlotValues; outputs: Manifest['outputs'] }

export class SlotError extends Error {}

const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));
const isLink = (v: unknown): v is [string, number] => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string';

/**
 * Turn user values into a ready-to-submit API graph. Pure: no network.
 * Image slots take ComfyUI file names (the caller uploads first).
 * Missing seed gets a random one (returned in `values` so it can be recorded).
 */
export function applySlots(profile: Profile, input: SlotValues): Applied {
  const g = clone(profile.workflow);
  const values: SlotValues = {};
  const unknown = Object.keys(input).filter((k) => k !== 'custom_width' && k !== 'custom_height' && !k.startsWith('__') && !profile.manifest.slots.some((s) => s.id === k));   // __ keys are notes kept with the job (how the prompt was made), never sent
  if (unknown.length) throw new SlotError(`Unknown slot(s): ${unknown.join(', ')}`);
  const removed = applyCustomSize(g, profile, input, values);

  for (const s of profile.manifest.slots) {
    if (removed && 'bind' in s && s.bind && s.bind.length && s.bind.every((b) => b.node === removed)) continue;   // aspect/megapixels of the size node we replaced
    const v = input[s.id];
    switch (s.type) {
      case 'text': {
        const val = v ?? s.default;
        if (val === undefined || val === null) { if (s.required) throw new SlotError(`${s.id} is required`); break; }
        if (typeof val !== 'string') throw new SlotError(`${s.id} must be text`);
        if (s.required && !val.trim()) throw new SlotError(`${s.id} is required`);
        values[s.id] = val; bind(g, s.bind, val); break;
      }
      case 'number': {
        let val = v ?? s.default;
        if (val === undefined || val === null) {
          if (s.role !== 'seed') break;   // leave the workflow's own value
          val = randomInt(0, 2 ** 47);
        }
        if (typeof val !== 'number' || !Number.isFinite(val)) throw new SlotError(`${s.id} must be a number`);
        if ((s.integer || s.role === 'seed') && !Number.isInteger(val)) throw new SlotError(`${s.id} must be a whole number`);
        if (s.min !== undefined && val < s.min) throw new SlotError(`${s.id} must be at least ${s.min}`);
        if (s.max !== undefined && val > s.max) throw new SlotError(`${s.id} must be at most ${s.max}`);
        values[s.id] = val; bind(g, s.bind, val); bind(g, s.bindNegative ?? [], -val); break;
      }
      case 'enum': {
        const val = v ?? s.default;
        if (val === undefined || val === null) break;
        if (typeof val !== 'string') throw new SlotError(`${s.id} must be one of the listed options`);
        if (s.options && !s.options.includes(val)) throw new SlotError(`${s.id}: "${val}" is not one of ${s.options.join(', ')}`);
        values[s.id] = val; bind(g, s.bind, val); break;
      }
      case 'boolean': {
        const val = (v ?? s.default) as unknown;
        if (typeof val !== 'boolean') throw new SlotError(`${s.id} must be true or false`);
        values[s.id] = val;
        for (const b of (val ? s.on : s.off)?.bypass ?? []) bypass(g, b.node, b.input);
        for (const id of (val ? s.on : s.off)?.remove ?? []) removeNode(g, id);
        for (const u of (val ? s.on : s.off)?.unset ?? []) if (g[u.node]) delete g[u.node]!.inputs[u.input];
        break;
      }
      case 'image': {
        if (v === undefined || v === null) {
          if (s.required) throw new SlotError(`${s.id} is required`);
          for (const b of s.whenAbsent?.bypass ?? []) bypass(g, b.node, b.input);
          for (const id of s.whenAbsent?.remove ?? []) removeNode(g, id);
          break;
        }
        if (typeof v !== 'string') throw new SlotError(`${s.id} must be an uploaded image name`);
        values[s.id] = v;
        if (s.bind) bind(g, s.bind, v);
        else if (s.addNode) {
          const id = freeId(g, `m_${s.id}`);
          g[id] = { class_type: s.addNode.class_type, inputs: { ...(s.addNode.fixed ?? {}), [s.addNode.input]: v }, _meta: { title: `Driftboard ${s.id}` } };
          g[s.addNode.linkTo.node]!.inputs[s.addNode.linkTo.input] = [id, 0];
        }
        break;
      }
      case 'image_list': {
        const list = v === undefined || v === null ? [] : v;
        if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) throw new SlotError(`${s.id} must be a list of uploaded image names`);
        if (list.length < s.min) throw new SlotError(`${s.id} needs at least ${s.min} image(s)`);
        if (list.length > s.max) throw new SlotError(`${s.id} accepts at most ${s.max} image(s)`);
        values[s.id] = list; autogrow(g, s, list as string[]); break;
      }
      case 'video': {
        if (v === undefined || v === null || v === '') {
          if (s.required) throw new SlotError(`${s.id} is required`);
          for (const b of s.whenAbsent?.bypass ?? []) bypass(g, b.node, b.input);
          for (const id of s.whenAbsent?.remove ?? []) removeNode(g, id);
          break;
        }
        if (typeof v !== 'string') throw new SlotError(`${s.id} must be an uploaded clip name`);
        values[s.id] = v; bind(g, s.bind, v); break;
      }
      case 'video_list':
      case 'audio_list': {
        const list = v === undefined || v === null ? [] : v;
        if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) throw new SlotError(`${s.id} must be a list of uploaded file names`);
        if (list.length < s.min) throw new SlotError(`${s.id} needs at least ${s.min} file(s)`);
        if (list.length > s.max) throw new SlotError(`${s.id} accepts at most ${s.max} file(s)`);
        values[s.id] = list; autogrow(g, s as Extract<Slot, { type: 'image_list' | 'video_list' | 'audio_list' }>, list as string[]); break;
      }
    }
  }

  const outputs = profile.manifest.outputs.filter((o) => g[o.node]);
  if (!outputs.length) throw new SlotError('No output node left in the workflow');
  dropDangling(g);
  return { graph: g, values, outputs };
}

/**
 * Custom size: the workflow's size node (ResolutionSelector: outputs width, height) only knows a fixed list of ratios.
 * With custom_width and custom_height we cut it out and feed the numbers straight to whatever used its outputs.
 * The numbers snap to the node's own "multiple" (what the model needs), never below one multiple.
 */
function applyCustomSize(g: Graph, profile: Profile, input: SlotValues, values: SlotValues): string | undefined {
  const w = input.custom_width, h = input.custom_height;
  if (w === undefined && h === undefined) return undefined;
  const slot = profile.manifest.slots.find((s) => s.type === 'enum' && s.customSize);
  if (!slot || slot.type !== 'enum' || !slot.customSize) throw new SlotError('This model does not take a custom size.');
  if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h) || w < 16 || h < 16 || w > 8192 || h > 8192) throw new SlotError('Custom size needs a width and a height between 16 and 8192.');
  const nodeId = slot.customSize.node, node = g[nodeId];
  if (!node) throw new SlotError(`Size node ${nodeId} is missing from the workflow`);
  const mult = typeof node.inputs.multiple === 'number' && node.inputs.multiple > 0 ? node.inputs.multiple : 8;
  const snap = (n: number) => Math.max(mult, Math.round(n / mult) * mult);
  const W = snap(w), H = snap(h);
  for (const n of Object.values(g)) for (const [k, v] of Object.entries(n.inputs)) if (isLink(v) && v[0] === nodeId) n.inputs[k] = v[1] === 0 ? W : v[1] === 1 ? H : v;
  delete g[nodeId];
  values.custom_width = W; values.custom_height = H;
  return nodeId;
}

/** Set the bound inputs. A node an optional slot already cut out of the graph is skipped on purpose (checkManifest proved it exists). */
function bind(g: Graph, targets: { node: string; input: string }[], value: unknown) {
  for (const t of targets) if (g[t.node]) g[t.node]!.inputs[t.input] = value;
}

/** Cut a pass-through node out: whatever read its output 0 now reads the node's own `input`, then the node is deleted. */
function bypass(g: Graph, id: string, input: string) {
  const node = g[id]; if (!node) return;
  const src = node.inputs[input];
  if (!isLink(src)) throw new SlotError(`Node ${id} input "${input}" is not a link, so it cannot be bypassed`);
  for (const n of Object.values(g)) for (const [k, v] of Object.entries(n.inputs)) if (isLink(v) && v[0] === id && v[1] === 0) n.inputs[k] = src;
  delete g[id];
}

function removeNode(g: Graph, id: string) { delete g[id]; }

function freeId(g: Graph, base: string): string {
  let i = 0; while (g[`${base}_${i}`]) i++; return `${base}_${i}`;
}

/** Replace the numbered inputs of a node with one loader per image; delete loaders that become unused. */
function autogrow(g: Graph, s: Extract<Slot, { type: 'image_list' | 'video_list' | 'audio_list' }>, names: string[]) {
  const target = g[s.autogrow.node]!;
  const { inputPrefix, loaderTemplate: lt } = s.autogrow;
  const old: string[] = [];
  for (const k of Object.keys(target.inputs)) {
    if (!k.startsWith(inputPrefix)) continue;
    const link = target.inputs[k];
    if (isLink(link)) old.push(link[0]);
    delete target.inputs[k];
  }
  // The workflow's own loader is the best template: it already carries every required input (resize, keep_proportion, ...).
  const base = old.map((id) => g[id]).find((n) => n && n.class_type === lt.class_type);
  const baseInputs = base ? clone(base.inputs) : {};
  names.forEach((name, i) => {
    const id = freeId(g, `m_${s.id}`);
    g[id] = { class_type: lt.class_type, inputs: { ...baseInputs, ...(lt.fixed ?? {}), [lt.input]: name }, _meta: { title: `Driftboard ${s.id} ${i + 1}` } };
    let last = id;
    for (const [j, t] of (lt.then ?? []).entries()) {
      const tid = `${id}_${j + 1}`;
      g[tid] = { class_type: t.class_type, inputs: { ...(t.fixed ?? {}), [t.input]: [last, 0] }, _meta: { title: `Driftboard ${s.id} ${i + 1} (${t.class_type})` } };
      last = tid;
    }
    target.inputs[`${inputPrefix}${i}`] = [last, lt.output ?? 0];
    const ap = 'audioPrefix' in s.autogrow ? s.autogrow.audioPrefix : undefined;
    if (ap) target.inputs[`${ap}${i}`] = [last, ('audioOutput' in s.autogrow ? s.autogrow.audioOutput : undefined) ?? 2];
  });
  // The workflow's own example loaders are now unused: delete them and whatever fed only them (a resize step, a split), after the new ones are linked so shared helpers survive.
  const prune = (id: string) => {
    const n = g[id];
    if (!n || referenced(g, id)) return;
    delete g[id];
    for (const v of Object.values(n.inputs)) if (isLink(v)) prune(v[0]);
  };
  for (const id of old) prune(id);
}

const referenced = (g: Graph, id: string) =>
  Object.values(g).some((n) => Object.values(n.inputs).some((v) => isLink(v) && v[0] === id));

/** Nodes that reference a removed node would make ComfyUI reject the graph: fail early with a clear message. */
function dropDangling(g: Graph) {
  for (const [id, n] of Object.entries(g))
    for (const [k, v] of Object.entries(n.inputs))
      if (isLink(v) && !g[v[0]]) throw new SlotError(`Node ${id} input "${k}" points at removed node ${v[0]}; check the profile's off/on lists`);
}
