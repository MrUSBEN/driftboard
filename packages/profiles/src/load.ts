import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Manifest, type Graph, type Profile } from './manifest.ts';

/** Check a manifest against its workflow: every bound node/input must exist. Returns problems. */
export function checkManifest(m: Manifest, g: Graph): string[] {
  const bad: string[] = [];
  const node = (id: string, where: string) => { if (!g[id]) bad.push(`${where}: node ${id} not in workflow`); return g[id]; };
  for (const s of m.slots) {
    if (s.type === 'text' || s.type === 'number' || s.type === 'enum')
      for (const b of [...s.bind, ...(s.type === 'number' ? s.bindNegative ?? [] : [])]) { const n = node(b.node, `slot ${s.id}`); if (n && !(b.input in n.inputs)) bad.push(`slot ${s.id}: node ${b.node} has no input "${b.input}"`); }
    if (s.type === 'image') {
      for (const b of s.bind ?? []) { const n = node(b.node, `slot ${s.id}`); if (n && !(b.input in n.inputs)) bad.push(`slot ${s.id}: node ${b.node} has no input "${b.input}"`); }
      if (s.addNode) node(s.addNode.linkTo.node, `slot ${s.id}`);
      for (const b of s.whenAbsent?.bypass ?? []) node(b.node, `slot ${s.id}`);
      for (const id of s.whenAbsent?.remove ?? []) node(id, `slot ${s.id}`);
      if (!s.bind && !s.addNode) bad.push(`slot ${s.id}: image slot needs bind or addNode`);
    }
    if (s.type === 'image_list' || s.type === 'video_list' || s.type === 'audio_list') node(s.autogrow.node, `slot ${s.id}`);
    if (s.type === 'video') {
      for (const b of s.bind) { const n = node(b.node, `slot ${s.id}`); if (n && !(b.input in n.inputs)) bad.push(`slot ${s.id}: node ${b.node} has no input "${b.input}"`); }
      for (const b of s.whenAbsent?.bypass ?? []) { const n = node(b.node, `slot ${s.id}`); if (n && !(b.input in n.inputs)) bad.push(`slot ${s.id}: bypass node ${b.node} has no input "${b.input}"`); }
      for (const id of s.whenAbsent?.remove ?? []) node(id, `slot ${s.id}`);
    }
    if (s.type === 'boolean') {
      for (const id of [...(s.off?.remove ?? []), ...(s.on?.remove ?? [])]) node(id, `slot ${s.id}`);
      for (const b of [...(s.off?.bypass ?? []), ...(s.on?.bypass ?? [])]) { const n = node(b.node, `slot ${s.id}`); if (n && !(b.input in n.inputs)) bad.push(`slot ${s.id}: bypass node ${b.node} has no input "${b.input}"`); }
    }
  }
  for (const o of m.outputs) if (!o.optional) node(o.node, `output ${o.id}`);
  const ids = new Set<string>();
  for (const s of m.slots) { if (ids.has(s.id)) bad.push(`duplicate slot id ${s.id}`); ids.add(s.id); }
  return bad;
}

export async function loadProfile(dir: string): Promise<Profile> {
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const manifest = Manifest.parse(raw);
  const workflow = JSON.parse(await fs.readFile(path.join(dir, manifest.workflow), 'utf8')) as Graph;
  const problems = checkManifest(manifest, workflow);
  if (problems.length) throw new Error(`Profile ${manifest.id}: ${problems.join('; ')}`);
  let guide = '';
  const slot = manifest.slots.find((x) => x.type === 'text' && x.role === 'prompt') as { promptGuide?: string } | undefined;
  if (manifest.director?.guideFile) guide = await fs.readFile(path.join(dir, manifest.director.guideFile), 'utf8').catch(() => '');
  if (!guide.trim()) guide = slot?.promptGuide ?? '';
  return { manifest, workflow, dir, guide };
}

/**
 * Load the bundled profiles and the user's own folder. A user profile with the same id replaces the bundled one;
 * a broken profile is skipped and reported, never fatal (one bad folder must not stop the app).
 */
export async function loadProfileSet(roots: { dir: string; source: 'bundled' | 'user' }[]): Promise<{ profiles: Profile[]; errors: string[] }> {
  const byId = new Map<string, Profile>(), errors: string[] = [];
  for (const r of roots) {
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await fs.readdir(r.dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(r.dir, e.name);
      if (!(await fs.access(path.join(dir, 'manifest.json')).then(() => true, () => false))) continue;
      try { const p = await loadProfile(dir); byId.set(p.manifest.id, { ...p, source: r.source }); }
      catch (err) { errors.push(`${r.source === 'user' ? 'Your' : 'Bundled'} profile "${e.name}": ${(err as Error).message}`); }
    }
  }
  return { profiles: [...byId.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id)), errors };
}

/** Load every subfolder of `root` that has a manifest.json. */
export async function loadProfiles(root: string): Promise<Profile[]> {
  const out: Profile[] = [];
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    if (e.isDirectory() && (await fs.access(path.join(root, e.name, 'manifest.json')).then(() => true, () => false)))
      out.push(await loadProfile(path.join(root, e.name)));
  }
  return out.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}
