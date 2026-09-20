import { describe, expect, it } from 'vitest';
import {
  MemoryPageStore,
  PagedBTree,
  parseInternal,
  decodeLeaf,
  compareBytes,
} from '../src/index.js';

/** 校验整棵树：所有页可解码、内部键严格递增且与相邻叶孩子边界一致、无页环 */
function validateTree(store: MemoryPageStore, rootId: number, pageSize: number) {
  const seen = new Set<number>();
  let leafCount = 0;
  let entryCount = 0;

  const walk = (id: number, depth: number): { min: Uint8Array | null; max: Uint8Array | null } => {
    if (seen.has(id)) throw new Error('page ' + id + ' visited twice');
    seen.add(id);
    const p = store.read(id);
    if (p[3] === 1) {
      leafCount++;
      const entries = decodeLeaf(p, id, true);
      let prev: Uint8Array | null = null;
      for (const e of entries) {
        if (prev !== null && compareBytes(prev, e.key) >= 0) {
          throw new Error('leaf keys not increasing on page ' + id);
        }
        prev = e.key;
      }
      entryCount += entries.length;
      return {
        min: entries.length ? entries[0].key : null,
        max: entries.length ? entries[entries.length - 1].key : null,
      };
    }
    const parsed = parseInternal(p, id, true);
    // 重建指针序列并递归
    const childIds: number[] = parsed.cells.map((c) => c.child);
    childIds.push(parsed.rightChild);
    const seps = parsed.cells.map((c) => c.key);
    let globalMin: Uint8Array | null = null;
    let globalMax: Uint8Array | null = null;
    for (let i = 0; i < childIds.length; i++) {
      const r = walk(childIds[i], depth + 1);
      if (i === 0) globalMin = r.min;
      globalMax = r.max;
    }
    // 校验每个分隔键位于相邻**直接叶孩子**的边界之间；
    // 相邻内部孩子的边界由其下层叶子上的同样检查递归保证。
    const bounds = childIds.map((cid) => {
      const cp = store.read(cid);
      if (cp[3] === 1) {
        const es = decodeLeaf(cp, cid, false);
        return {
          min: es.length ? es[0].key : null,
          max: es.length ? es[es.length - 1].key : null,
        };
      }
      return { min: null as Uint8Array | null, max: null as Uint8Array | null };
    });
    for (let i = 0; i + 1 < childIds.length; i++) {
      const sep = seps[i];
      const lm = bounds[i].max;
      const rmin = bounds[i + 1].min;
      if (lm !== null && compareBytes(lm, sep) >= 0) {
        throw new Error('separator not above left subtree max on page ' + id);
      }
      if (rmin !== null && compareBytes(sep, rmin) > 0) {
        throw new Error('separator above right subtree min on page ' + id);
      }
    }
    return { min: globalMin, max: globalMax };
  };

  walk(rootId, 0);
  return { leafCount, entryCount, reachable: seen.size };
}

describe('randomized differential stress test', () => {
  it('matches a reference Map across inserts/updates/deletes with tiny pages', () => {    for (const [pageSize, interval] of [
      [128, 4],
      [160, 8],
      [220, 3],
      [300, 16],
    ] as const) {
      const store = new MemoryPageStore(pageSize);
      const tree = new PagedBTree<number>(store, undefined, {
        restartInterval: interval,
        verifyChecksums: true,
      });
      const ref = new Map<string, number>();

      let seed = 0x9e3779b9;
      const rand = () => {
        seed = (Math.imul(seed ^ (seed >>> 15), 0x85ebca6b)) >>> 0;
        seed = (Math.imul(seed ^ (seed >>> 13), 0xc2b2ae35)) >>> 0;
        seed = (seed ^ (seed >>> 16)) >>> 0;
        return seed / 0x100000000;
      };
      const N = 1500;
      const OP = 2500;
      const keys: string[] = [];
      for (let i = 0; i < N; i++) {
        // 制造长短不一、带公共前缀的键
        const family = Math.floor(rand() * 6);
        const pre = ['usr/', 'usr/local/', 'cfg//', 'log/2026/', 'a', 'zzz/'][family];
        keys.push(pre + Math.floor(rand() * 400).toString(36) + '/' + i.toString(36));
      }

      const check = (tag: string) => {
        const stats = validateTree(store, tree.rootId, pageSize);
        if (stats.entryCount !== ref.size) {
          throw new Error(`[${tag}] entry count ${stats.entryCount} != ref ${ref.size}`);
        }
        if (tree.size() !== ref.size) {
          throw new Error(`[${tag}] tree.size ${tree.size()} != ref ${ref.size}`);
        }
      };

      for (let op = 0; op < OP; op++) {
        const k = keys[Math.floor(rand() * keys.length)];
        const r = rand();
        if (r < 0.55) {
          const v = Math.floor(rand() * 1e6);
          tree.insert(k, v);
          ref.set(k, v);
        } else if (r < 0.8) {
          const got = tree.get(k);
          const want = ref.get(k);
          expect(got, `mismatch at op ${op} key ${k}`).toBe(want);
        } else {
          const d1 = tree.delete(k);
          const had = ref.delete(k);
          expect(d1).toBe(had);
        }
        if (op % 250 === 0) check('op' + op);
      }
      check('final');

      // 全量逐键比对
      for (const [k, v] of ref) {
        expect(tree.get(k)).toBe(v);
      }
      // 范围扫描与引用顺序一致
      const all = [...ref.entries()].sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      );
      const scanned = tree.range('', '￿').map((x) => [
        new TextDecoder().decode(x.key),
        x.value,
      ]);
      expect(scanned.length).toBe(all.length);
      for (let i = 0; i < all.length; i++) {
        expect(scanned[i][0]).toBe(all[i][0]);
        expect(scanned[i][1]).toBe(all[i][1]);
      }
    }
  }, 30000);

  it('binary-key workload: insert/delete byte-order keys stays consistent', () => {
    const store = new MemoryPageStore(140);
    const tree = new PagedBTree<number>(store, undefined, { restartInterval: 4 });
    const ref = new Map<string, number>();
    const hex = (b: Uint8Array) =>
      Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

    const rawKeys: Uint8Array[] = [];
    for (let i = 0; i < 400; i++) {
      const b: number[] = [];
      let x = i;
      while (x > 0) {
        b.push(x & 0xff);
        x = x >>> 8;
      }
      b.reverse();
      rawKeys.push(new Uint8Array(b.length ? b : [0]));
    }
    // 乱序插入
    const order = rawKeys.map((_, i) => i).sort(() => Math.random() - 0.5);
    for (const i of order) {
      tree.insert(rawKeys[i], i);
      ref.set(hex(rawKeys[i]), i);
    }
    for (const k of rawKeys) expect(tree.get(k)).toBe(ref.get(hex(k)));
    // 随机删除
    let s = 7;
    const rand = () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < rawKeys.length; i++) {
      if (rand() < 0.5) {
        tree.delete(rawKeys[i]);
        ref.delete(hex(rawKeys[i]));
      }
    }
    for (const k of rawKeys) {
      expect(tree.get(k)).toBe(ref.get(hex(k)));
    }
  });

  it('sustained delete down to empty then rebuild on same tree (merge cascade)', () => {
    for (let trial = 0; trial < 3; trial++) {
      const store = new MemoryPageStore(128 + trial * 40);
      const tree = new PagedBTree<number>(store, undefined, { restartInterval: 4 });
      const n = 1200;
      for (let i = 0; i < n; i++) tree.insert('k' + String(i).padStart(5, '0'), i);
      // 随机顺序删除
      const perm = Array.from({ length: n }, (_, i) => i);
      let seed = trial + 1;
      for (let i = n - 1; i > 0; i--) {
        seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
        const j = seed % (i + 1);
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }
      for (const i of perm) tree.delete('k' + String(i).padStart(5, '0'));
      expect(tree.size()).toBe(0);
      for (let i = 0; i < n; i++) expect(tree.get('k' + String(i).padStart(5, '0'))).toBeUndefined();
      // 复用空树
      for (let i = 0; i < 300; i++) tree.insert('new/' + i, i);
      for (let i = 0; i < 300; i++) expect(tree.get('new/' + i)).toBe(i);
      validateTree(store, tree.rootId, store.pageSize);
    }
  });
});
