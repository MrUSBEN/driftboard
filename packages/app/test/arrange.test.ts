import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrangeLinear, arrangeLineage } from '../src/renderer/CanvasMenu.tsx';

const b = (id: string, x = 0, y = 0) => ({ id, x, y, w: 180, h: 130 });

test('arrangeLinear: row, column and grid keep order and never overlap', () => {
  const boxes = ['a', 'b', 'c', 'd', 'e'].map((id, i) => b(id, 500 + i, 300 - i));
  const row = arrangeLinear(boxes, 'row'); assert.ok(new Set(row.map((m) => m.y)).size === 1); assert.ok(row[1]!.x > row[0]!.x + 180);
  const col = arrangeLinear(boxes, 'column'); assert.ok(new Set(col.map((m) => m.x)).size === 1); assert.ok(col[1]!.y > col[0]!.y + 130);
  const grid = arrangeLinear(boxes, 'grid');
  for (const p of grid) for (const q of grid) if (p !== q) assert.ok(Math.abs(p.x - q.x) >= 180 || Math.abs(p.y - q.y) >= 130, 'overlap');
});

test('arrangeLineage: children sit right of parents, families stack, loose boxes go below, cycles do not hang', () => {
  const boxes = ['img', 'v1', 'v2', 'f', 'v3', 'solo', 'x', 'y'].map((id) => b(id));
  const m = new Map(arrangeLineage(boxes, [{ from: 'img', to: 'v1' }, { from: 'img', to: 'v2' }, { from: 'v1', to: 'f' }, { from: 'f', to: 'v3' }, { from: 'x', to: 'y' }, { from: 'y', to: 'x' }]).map((p) => [p.id, p]));
  assert.equal(m.size, 8);
  assert.ok(m.get('v1')!.x > m.get('img')!.x && m.get('f')!.x > m.get('v1')!.x && m.get('v3')!.x > m.get('f')!.x);
  assert.ok(m.get('v1')!.y !== m.get('v2')!.y);                       // siblings stack
  assert.ok(m.get('solo')!.y > m.get('v3')!.y);                      // loose box below the families
});
