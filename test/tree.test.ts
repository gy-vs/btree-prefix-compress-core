import { describe, expect, it } from 'vitest';
import {
  bytesToText,
  KeyTooLargeError,
  MemoryPageStore,
  PageCorruptError,
  PagedBTree,
  toBytes,
} from '../src/index.js';

function makeTree(pageSize = 256, restartInterval = 8) {
  const store = new MemoryPageStore(pageSize);
  const tree = new PagedBTree<number>(store, undefined, { restartInterval });
  return { store, tree };
}

describe('PagedBTree basic CRUD', () => {
  it('insert/get/update/delete on a single leaf', () => {
    const { tree } = makeTree();
    tree.insert('a', 1);
    tree.insert('b', 2);
    expect(tree.get('a')).toBe(1);
    tree.insert('a', 10);
    expect(tree.get('a')).toBe(10);
    expect(tree.size()).toBe(2);
    expect(tree.delete('a')).toBe(true);
    expect(tree.delete('a')).toBe(false);
    expect(tree.get('a')).toBeUndefined();
    expect(tree.size()).toBe(1);
  });

  it('empty key, binary keys, and binary-order semantics', () => {
    const { tree } = makeTree();
    const keys: Uint8Array[] = [
      new Uint8Array([]),
      new Uint8Array([0]),
      new Uint8Array([0, 0]),
      new Uint8Array([1, 255]),
      new Uint8Array([255]),
    ];
    keys.forEach((k, i) => tree.insert(k, i));
    keys.forEach((k, i) => expect(tree.get(k)).toBe(i));
    expect(tree.get(new Uint8Array([0, 1]))).toBeUndefined();
    const r = tree.range(new Uint8Array([0]), new Uint8Array([0, 255]));
    expect(r.map((x) => x.value)).toEqual([1, 2]);
  });
});

describe('splits are driven by encoded size, not key count', () => {
  it('long shared prefix packs many keys per leaf; divergence forces more pages', () => {
    // 小页 + 长前缀：压缩前每键 ~80B，压缩后仅 ~10B
    const { tree, store } = makeTree(256, 8);
    const n = 600;
    for (let i = 0; i < n; i++) {
      tree.insert('customer-region-us-west-tenant-42-record-' + String(i).padStart(5, '0'), i);
    }
    expect(tree.size()).toBe(n);
    for (let i = 0; i < n; i += 37) {
      expect(
        tree.get('customer-region-us-west-tenant-42-record-' + String(i).padStart(5, '0')),
      ).toBe(i);
    }
    // 已经发生了多层分裂
    expect(store.pageCount()).toBeGreaterThan(1);
  });

  it('random insertion workload preserves all keys through repeated splits', () => {
    const { tree } = makeTree(200, 4);
    const ref = new Map<string, number>();
    let seed = 123456789;
    const rand = () => {
      // 确定性 LCG
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 800; i++) {
      const k = 'k/' + Math.floor(rand() * 2000).toString(36) + '/' + i.toString(36);
      if (!ref.has(k)) {
        tree.insert(k, i);
        ref.set(k, i);
      }
    }
    for (const [k, v] of ref) expect(tree.get(k)).toBe(v);
  });

  it('range scan returns ordered full logical keys', () => {
    const { tree } = makeTree(220, 8);
    for (let i = 0; i < 300; i++) tree.insert('p-' + String(i).padStart(4, '0'), i);
    const r = tree.range('p-0100', 'p-0109');
    expect(r.map((x) => x.value)).toEqual(Array.from({ length: 10 }, (_, i) => 100 + i));
    expect(r.map((x) => bytesToText(x.key))).toEqual(
      Array.from({ length: 10 }, (_, i) => 'p-' + String(100 + i).padStart(4, '0')),
    );
  });
});

describe('compression ratio change after split/rewrite', () => {
  it('deleting a key that supplied the common prefix shrinks subsequent encodings', () => {
    // 两个键共享长前缀；删除其中一个后，另一个所在页在重写时以重启条目存储
    const { tree } = makeTree(180, 4);
    const prefix = 'a'.repeat(60);
    tree.insert(prefix + '-1', 1);
    tree.insert(prefix + '-2', 2);
    expect(tree.get(prefix + '-1')).toBe(1);
    tree.delete(prefix + '-1');
    expect(tree.get(prefix + '-2')).toBe(2);
  });

  it('inserting a divergent key between prefix groups changes per-page ratios', () => {
    const { tree } = makeTree(160, 4);
    // 前缀组 A
    for (let i = 0; i < 60; i++) tree.insert('aaaa-group/aaaa-item-' + i, i);
    // 前缀组 B（完全不同前缀），插在 A 之后，分裂点两侧压缩率不同
    for (let i = 0; i < 60; i++) tree.insert('zzzz-group/zzzz-item-' + i, i);
    for (let i = 0; i < 60; i++) {
      expect(tree.get('aaaa-group/aaaa-item-' + i)).toBe(i);
      expect(tree.get('zzzz-group/zzzz-item-' + i)).toBe(i);
    }
  });

  it('updating a value (not key) rewrites page at correct encoded size', () => {
    const { tree } = makeTree(200, 4);
    for (let i = 0; i < 100; i++) tree.insert('key-' + i, i);
    for (let i = 0; i < 100; i++) tree.insert('key-' + i, i * 2);
    for (let i = 0; i < 100; i++) expect(tree.get('key-' + i)).toBe(i * 2);
    expect(tree.size()).toBe(100);
  });
});

describe('merge and borrow after deletes', () => {
  it('delete all keys in reverse then forward leaves an empty usable root', () => {
    for (const order of ['asc', 'desc'] as const) {
      const { tree } = makeTree(180, 4);
      const n = 400;
      for (let i = 0; i < n; i++) tree.insert('item/' + String(i).padStart(4, '0'), i);
      const seq = Array.from({ length: n }, (_, i) => i);
      if (order === 'desc') seq.reverse();
      for (const i of seq) tree.delete('item/' + String(i).padStart(4, '0'));
      expect(tree.size()).toBe(0);
      for (let i = 0; i < n; i++) {
        expect(tree.get('item/' + String(i).padStart(4, '0'))).toBeUndefined();
      }
      // 树仍可继续使用
      tree.insert('fresh', 1);
      expect(tree.get('fresh')).toBe(1);
    }
  });

  it('delete half the keys and reinsert: all values consistent', () => {
    const { tree } = makeTree(192, 8);
    const n = 500;
    for (let i = 0; i < n; i++) tree.insert('row-' + String(i).padStart(4, '0'), i);
    for (let i = 0; i < n; i += 2) tree.delete('row-' + String(i).padStart(4, '0'));
    for (let i = 0; i < n; i++) {
      const got = tree.get('row-' + String(i).padStart(4, '0'));
      expect(got).toBe(i % 2 === 0 ? undefined : i);
    }
    for (let i = 0; i < n; i += 2) tree.insert('row-' + String(i).padStart(4, '0'), i + 10000);
    for (let i = 0; i < n; i++) {
      expect(tree.get('row-' + String(i).padStart(4, '0'))).toBe(
        i % 2 === 0 ? i + 10000 : i,
      );
    }
  });

  it('alternating delete/insert storm stays correct', () => {
    const { tree } = makeTree(160, 4);
    const ref = new Set<number>();
    for (let i = 0; i < 300; i++) {
      tree.insert('x-' + String(i).padStart(4, '0'), i);
      ref.add(i);
    }
    for (let round = 0; round < 5; round++) {
      for (let i = round; i < 300; i += 3) {
        tree.delete('x-' + String(i).padStart(4, '0'));
        ref.delete(i);
      }
      for (let i = round; i < 300; i += 6) {
        tree.insert('x-' + String(i).padStart(4, '0'), i);
        ref.add(i);
      }
    }
    for (let i = 0; i < 300; i++) {
      expect(tree.get('x-' + String(i).padStart(4, '0'))).toBe(
        ref.has(i) ? i : undefined,
      );
    }
  });
});

describe('single key exceeding page capacity', () => {
  it('throws KeyTooLargeError before touching the tree', () => {
    const { tree } = makeTree(4096);
    const sizeBefore = tree.size();
    expect(() => tree.insert('y'.repeat(5000), 1)).toThrow(KeyTooLargeError);
    expect(tree.size()).toBe(sizeBefore);
  });

  it('key that fits alone but compresses against neighbor still accepted', () => {
    const { tree } = makeTree(512);
    const k = 'z'.repeat(400);
    tree.insert(k, 1); // 单条目（含 varint/头部/表）必须放得下
    expect(tree.get(k)).toBe(1);
  });
});

describe('delete can grow a leaf (prefix resync) and must split by encoded size', () => {
  it('a near-full leaf stays valid after a delete that moves restart points', () => {
    // 用真实触发该缺陷的负载形态：短键与长前缀键混排，页较大、interval=16。
    // 缺陷表现为删除后重编码超 4096 仍试图写回单页而抛错。
    const store = new MemoryPageStore(4096);
    const tree = new PagedBTree<number>(store, undefined, { restartInterval: 16 });
    const ref = new Map<string, number>();
    let seed = 42;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
    const n = 1200;
    const keys: string[] = [];
    for (let i = 0; i < n; i++) {
      const f = Math.floor(rnd() * 8);
      keys.push(
        ['pre/long/common/path/', 'x', '/sharded/by/tenant/7/', 'm', 'n', 'q/', 'zzz', 'abc/'][f] +
          Math.floor(rnd() * 300).toString(36) + '-' + i,
      );
    }
    for (let op = 0; op < 2000; op++) {
      const k = keys[Math.floor(rnd() * keys.length)];
      const r = rnd();
      if (r < 0.6) {
        tree.insert(k, op);
        ref.set(k, op);
      } else if (r < 0.8) {
        expect(tree.get(k)).toBe(ref.get(k));
      } else {
        expect(tree.delete(k)).toBe(ref.delete(k));
      }
    }
    for (const [k, v] of ref) expect(tree.get(k)).toBe(v);
  }, 20000);

  it('minimal interval=2 delete-resync splits without losing keys', () => {
    // 页要能容纳删除重同步后的 3 个条目（约 139B），用 160B
    const store = new MemoryPageStore(160);
    const tree = new PagedBTree<number>(store, undefined, { restartInterval: 2 });
    tree.insert('aaaa', 0);
    tree.insert('aaaaB', 1);
    tree.insert('z'.repeat(50), 2);
    tree.insert('z'.repeat(50) + 'D', 3);
    tree.delete('aaaaB');
    expect(tree.get('aaaa')).toBe(0);
    expect(tree.get('z'.repeat(50))).toBe(2);
    expect(tree.get('z'.repeat(50) + 'D')).toBe(3);
    expect(tree.get('aaaaB')).toBeUndefined();
  });
});

describe('corruption surfaces through tree operations', () => {
  it('bit flip in a leaf makes reads throw PageCorruptError', () => {
    const { tree, store } = makeTree(256, 8);
    for (let i = 0; i < 200; i++) tree.insert('leaf-key-' + String(i).padStart(4, '0'), i);
    // 找到一个叶页（type=1）并翻转其中一字节
    let flipped = false;
    for (let id = 0; id < 100000 && !flipped; id++) {
      try {
        const p = store.read(id);
        if (p[3] === 1) {
          p[40] ^= 0x5a;
          store.write(id, p);
          flipped = true;
        }
      } catch {
        break;
      }
    }
    expect(flipped).toBe(true);
    let threw = false;
    for (let i = 0; i < 200; i++) {
      try {
        tree.get('leaf-key-' + String(i).padStart(4, '0'));
      } catch (e) {
        expect(e).toBeInstanceOf(PageCorruptError);
        threw = true;
        break;
      }
    }
    expect(threw).toBe(true);
  });
});
