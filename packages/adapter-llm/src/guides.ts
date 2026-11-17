import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * A guide is the instruction text for one kind of LLM task (a model's prompt format, the bible writer, the chat
 * assistant...). It is a plain markdown file, so users can read and edit it. An optional header between `---` lines
 * holds `key: value` lines:  title, durationLine.
 */
export interface Guide {
  id: string; title: string; body: string;
  /** If set (e.g. "recommended_duration"), the answer must end with a "<name>: N seconds" line, which the app writes itself. */
  durationLine?: string;
  /** where it was read from, and whether it replaced a bundled one */
  file?: string; custom?: boolean;
}

export function parseGuide(id: string, text: string): Guide {
  const t = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const g: Guide = { id, title: id, body: t.trim() };
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(t);
  if (m) {
    g.body = t.slice(m[0].length).trim();
    for (const line of m[1]!.split('\n')) {
      const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      if (kv[1] === 'title') g.title = kv[2]!;
      if (kv[1] === 'durationLine') g.durationLine = kv[2]!;
    }
  }
  return g;
}

/** Read every .md in each folder. Later folders win, so a user folder can override a bundled guide by id. */
export async function loadGuides(dirs: string[]): Promise<Map<string, Guide>> {
  const out = new Map<string, Guide>();
  for (const [i, dir] of dirs.entries()) {
    let names: string[] = [];
    try { names = await fs.readdir(dir); } catch { continue; }
    for (const n of names.filter((x) => x.toLowerCase().endsWith('.md')).sort()) {
      const id = n.slice(0, -3);
      const file = path.join(dir, n);
      const g = parseGuide(id, await fs.readFile(file, 'utf8'));
      out.set(id, { ...g, file, custom: i > 0 });
    }
  }
  return out;
}

/** Replace {{name}} with values; unknown names become empty. */
export const fill = (s: string, vars: Record<string, string | number | undefined>) => s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? ''));
