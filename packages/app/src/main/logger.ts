import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type Level = 'info' | 'warn' | 'error';
export interface LogEntry { id: number; ts: number; level: Level; source: string; msg: string }

/**
 * One log for the whole app: kept in memory (last 3000 lines, shown in the Log tab) and appended to a file in the user folder
 * (rolled over at 4 MB) so a crash or a bug report has the story behind it. Never throws.
 */
class Logger {
  private buf: LogEntry[] = [];
  private seq = 0;
  private file: string | null = null;
  private pending = '';
  private writing = false;
  private onEntry: (e: LogEntry) => void = () => {};

  init(dir: string, onEntry: (e: LogEntry) => void) {
    this.file = path.join(dir, 'driftboard.log'); this.onEntry = onEntry;
    void fs.mkdir(dir, { recursive: true }).then(() => fs.stat(this.file!)).then((s) => { if (s.size > 4_000_000) return fs.rename(this.file!, this.file! + '.1'); }).catch(() => {});
  }
  get path() { return this.file; }

  add(level: Level, source: string, msg: string) {
    const e: LogEntry = { id: ++this.seq, ts: Date.now(), level, source, msg: String(msg).slice(0, 4000) };
    this.buf.push(e); if (this.buf.length > 3000) this.buf.splice(0, this.buf.length - 3000);
    try { this.onEntry(e); } catch { /* window gone */ }
    if (this.file) { this.pending += `${new Date(e.ts).toISOString()} ${level.toUpperCase().padEnd(5)} [${source}] ${e.msg.replace(/\r?\n/g, ' ⏎ ')}\n`; void this.flush(); }
    return e;
  }
  private async flush() {
    if (this.writing || !this.file) return;
    this.writing = true;
    try { while (this.pending) { const chunk = this.pending; this.pending = ''; await fs.appendFile(this.file, chunk); } } catch { /* disk full or locked: keep going */ }
    this.writing = false;
  }
  list(): LogEntry[] { return this.buf.slice(); }
  clear() { this.buf = []; }
}

export const logger = new Logger();
export const log = {
  info: (source: string, msg: string) => logger.add('info', source, msg),
  warn: (source: string, msg: string) => logger.add('warn', source, msg),
  error: (source: string, msg: string) => logger.add('error', source, msg),
};
