// Pure helpers for editing the block tree. A path is [i] for a top level block, or [i, column, j] for
// a block inside a columns block (one level deep). The footer is always the last top level block.
import { defaultBlock, newId } from './render.js';

const clone = (v) => structuredClone(v);
const isColumns = (b) => b?.type === 'columns';

export const ensureFooter = (blocks) => {
  const rest = blocks.filter((b) => b.type !== 'footer');
  return [...rest, blocks.find((b) => b.type === 'footer') || defaultBlock('footer')];
};

export function getAt(blocks, path) {
  if (!path || !path.length) return null;
  const top = blocks[path[0]];
  if (path.length === 1) return top || null;
  return top?.props?.cols?.[path[1]]?.[path[2]] || null;
}

const listFor = (blocks, path) => (path.length === 1 ? blocks : blocks[path[0]].props.cols[path[1]]);

export function insert(blocks, path, block) {
  if (block.type === 'footer') return { blocks, path: null };
  if (path.length === 3 && isColumns(block)) return { blocks, path: null }; // columns never nest
  const next = clone(blocks);
  const target = [...path];
  if (path.length === 1) target[0] = Math.max(0, Math.min(path[0], next.length - 1)); // keeps it above the footer
  else if (!isColumns(next[path[0]]) || !next[path[0]].props.cols[path[1]]) return { blocks, path: null };
  const list = listFor(next, target);
  const at = Math.max(0, Math.min(target[target.length - 1], list.length));
  list.splice(at, 0, block);
  target[target.length - 1] = at;
  return { blocks: next, path: target };
}

export function remove(blocks, path) {
  const b = getAt(blocks, path);
  if (!b || b.type === 'footer') return blocks;
  const next = clone(blocks);
  listFor(next, path).splice(path[path.length - 1], 1);
  return next;
}

export function move(blocks, from, to) {
  const b = getAt(blocks, from);
  if (!b || b.type === 'footer') return blocks;
  if (isColumns(b) && to.length === 3) return blocks;
  if (to.length === 3 && !isColumns(blocks[to[0]])) return blocks; // the target must be a real column
  const t = [...to];
  // Taking a block out shifts the numbering of later positions in the same list.
  if (from.length === 1 && from[0] < t[0]) t[0] -= 1;
  else if (from.length === 3 && t.length === 3 && from[0] === t[0] && from[1] === t[1] && from[2] < t[2]) t[2] -= 1;
  const res = insert(remove(blocks, from), t, clone(b));
  return res.path ? res.blocks : blocks;
}

const freshIds = (b) => { b.id = newId(); (b.props?.cols || []).forEach((col) => col.forEach(freshIds)); return b; };

export function duplicate(blocks, path) {
  const b = getAt(blocks, path);
  if (!b || b.type === 'footer') return { blocks, path: null };
  const to = [...path]; to[to.length - 1] += 1;
  return insert(blocks, to, freshIds(clone(b)));
}

export function update(blocks, path, patch) {
  const next = clone(blocks);
  const b = getAt(next, path);
  if (b) b.props = { ...b.props, ...patch };
  return next;
}

export const samePath = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

// Moves a block one place up or down within its own list. Returns { blocks, path } or null.
export function nudge(blocks, path, delta) {
  const list = path.length === 1 ? blocks : getAt(blocks, [path[0]]).props.cols[path[1]];
  const i = path[path.length - 1];
  const j = i + delta;
  const limit = path.length === 1 ? list.length - 1 : list.length; // the footer stays last
  if (j < 0 || j >= limit || getAt(blocks, path)?.type === 'footer') return null;
  const next = clone(blocks);
  const l = path.length === 1 ? next : next[path[0]].props.cols[path[1]];
  [l[i], l[j]] = [l[j], l[i]];
  const np = [...path]; np[np.length - 1] = j;
  return { blocks: next, path: np };
}
