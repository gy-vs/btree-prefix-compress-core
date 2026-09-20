import { describe, expect, it } from 'vitest';
import {
  BTree,
  binaryValueCodec,
  chooseLeafSplit,
  compareBytes,
  computePageChecksum,
  decodeInternal,
  decodeLeaf,
  encodeLeaf,
  findLeafValue,
  leafEncodedLength,
  PageCorruptionError,
  PageOverflowError,
  Pager,
} from '../src/index.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);
const ascii = (char: string, length: number): Uint8Array =>
  new Uint8Array(length).fill(char.charCodeAt(0));

function recalcChecksum(page: Uint8Array): Uint8Array {
  const copy = page.slice();
  new DataView(copy.buffer).setUint32(16, computePageChecksum(copy), true);
  return copy;
}

function entry(key: string | Uint8Array, value: string | Uint8Array = '') {
  return {
    key: typeof key === 'string' ? bytes(key) : key,
    value: typeof value === 'string' ? bytes(value) : value,
  };
}

describe('leaf prefix encoding', () => {
  it('round-trips keys with no common prefix byte-for-byte', () => {
    const entries = [entry('alpha', '1'), entry('beta', '2'), entry('gamma', '3')];
    const page = encodeLeaf(entries, 4);
    const decoded = decodeLeaf(page).entries;

    expect(decoded).toHaveLength(3);
    expect(decoded.map(x => decoder.decode(x.key))).toEqual(['alpha', 'beta', 'gamma']);
    expect(decoded.map(x => decoder.decode(x.value))).toEqual(['1', '2', '3']);
    expect(encodeLeaf(decoded, 4)).toEqual(page);
  });

  it('compresses a long common prefix and restarts at the configured interval', () => {
    const prefix = 'x'.repeat(100);
    const entries = [
      entry(`${prefix}aaaa`, 'v'),
      entry(`${prefix}aaab`, 'v'),
      entry(`${prefix}aaac`, 'v'),
      entry(`${prefix}baaa`, 'v'),
    ];
    const page = encodeLeaf(entries, 2);
    const view = new DataView(page.buffer);
    const payloadLength = view.getUint32(4, true);
    const restartCount = view.getUint16(14, true);
    const trailer = 20 + payloadLength;

    expect(restartCount).toBe(2);
    expect(view.getUint32(trailer, true)).toBe(0);
    expect(view.getUint32(trailer + 4, true)).toBeGreaterThan(0);
    expect(page.length).toBeLessThan(20 + entries.length * (12 + 104 + 1));
    expect(decodeLeaf(page).entries.map(x => decoder.decode(x.key))).toEqual(
      entries.map(x => decoder.decode(x.key)),
    );
  });

  it('supports empty keys, binary keys, and interval 1', () => {
    const entries = [
      entry(new Uint8Array([]), new Uint8Array([0])),
      entry(new Uint8Array([0]), new Uint8Array([1])),
      entry(new Uint8Array([0, 0]), new Uint8Array([2])),
      entry(new Uint8Array([0, 255]), new Uint8Array([3])),
      entry(new Uint8Array([1]), new Uint8Array([4])),
    ];
    const page = encodeLeaf(entries, 1);
    const decoded = decodeLeaf(page).entries;

    expect(new DataView(page.buffer).getUint16(14, true)).toBe(5);
    expect(decoded).toEqual(entries);
    expect(encodeLeaf(decoded, 1)).toEqual(page);
  });

  it('compares complete logical keys, not stored suffixes', () => {
    const entries = [
      entry('shared-apple'),
      entry('shared-apricot'),
      entry('shared-banana'),
    ];
    const page = encodeLeaf(entries, 16);

    expect(findLeafValue(page, bytes('shared-apricot'))).toBeDefined();
    expect(findLeafValue(page, bytes('shared-ap'))).toBeUndefined();
    expect(findLeafValue(page, bytes('shared-apricots'))).toBeUndefined();
  });

  it('handles restart interval boundaries', () => {
    const entries = Array.from({ length: 33 }, (_, i) => entry(`root:${i.toString().padStart(2, '0')}`));
    const page = encodeLeaf(entries, 16);
    expect(new DataView(page.buffer).getUint16(14, true)).toBe(3);
    expect(decodeLeaf(page).entries.map(x => decoder.decode(x.key))).toEqual(
      entries.map(x => decoder.decode(x.key)),
    );
    expect(findLeafValue(page, bytes('root:32'))).toBeDefined();
    expect(findLeafValue(page, bytes('root:15'))).toBeDefined();
    expect(findLeafValue(page, bytes('root:16'))).toBeDefined();
  });
});

describe('corrupt pages', () => {
  const entries = Array.from({ length: 20 }, (_, i) => entry(`prefix:${i.toString().padStart(2, '0')}`));

  it('rejects a checksum mismatch before decoding lengths', () => {
    const page = encodeLeaf(entries, 16).slice();
    page[20] ^= 1;
    expect(() => decodeLeaf(page)).toThrow(PageCorruptionError);
    expect(() => findLeafValue(page, bytes('prefix:10'))).toThrow(PageCorruptionError);
  });

  it('does not read outside the page for a corrupt prefix length', () => {
    const page = encodeLeaf(entries, 16);
    const payloadLength = new DataView(page.buffer).getUint32(4, true);
    const secondEntryOffset = new DataView(page.buffer).getUint32(20 + payloadLength + 4, true);
    const corrupt = page.slice();
    new DataView(corrupt.buffer).setUint32(20 + secondEntryOffset, 0xffffffff, true);

    expect(() => decodeLeaf(recalcChecksum(corrupt))).toThrow(PageCorruptionError);
    expect(() => findLeafValue(recalcChecksum(corrupt), bytes('prefix:19'))).toThrow(PageCorruptionError);
  });

  it('rejects corrupt suffix lengths and restart offsets without bounds reads', () => {
    const page = encodeLeaf(entries, 16);
    const corruptLength = page.slice();
    new DataView(corruptLength.buffer).setUint32(24, 0xffffffff, true);
    expect(() => decodeLeaf(recalcChecksum(corruptLength))).toThrow(PageCorruptionError);

    const corruptRestart = page.slice();
    const payloadLength = new DataView(corruptRestart.buffer).getUint32(4, true);
    new DataView(corruptRestart.buffer).setUint32(20 + payloadLength + 4, 0xfffffffe, true);
    expect(() => decodeLeaf(recalcChecksum(corruptRestart))).toThrow(PageCorruptionError);
  });
});

describe('byte-size split and merge', () => {
  it('chooses a split according to encoded size after restart compression', () => {
    const giant = ascii('g', 244);
    const common = ascii('p', 80);
    const entries = [
      entry(giant, new Uint8Array([1, 2])),
      ...Array.from({ length: 10 }, (_, i) => {
        const key = new Uint8Array(82);
        key.set(common, 0);
        key[80] = 0x30;
        key[81] = i;
        return entry(key, new Uint8Array([1, i]));
      }),
    ];

    // The count-based midpoint puts the oversized entry and four others together.
    expect(leafEncodedLength(entries.slice(0, 5), 16)).toBeGreaterThan(400);
    const split = chooseLeafSplit(entries, 16, 400);
    expect(split).not.toBe(5);
    expect(leafEncodedLength(entries.slice(0, split), 16)).toBeLessThanOrEqual(400);
    expect(leafEncodedLength(entries.slice(split), 16)).toBeLessThanOrEqual(400);
  });

  it('splits, preserves full internal separator keys, and queries every entry', () => {
    const pager = new Pager();
    const tree = new BTree<number>({ pager, pageSize: 512, restartInterval: 4 });
    const prefix = 'long-common-prefix/'.repeat(6);

    for (let i = 0; i < 60; i++) tree.insert(`${prefix}/${i.toString().padStart(3, '0')}`, i);

    expect(pager.pageCount).toBeGreaterThan(2);
    for (let i = 0; i < 60; i++) expect(tree.get(`${prefix}/${i.toString().padStart(3, '0')}`)).toBe(i);

    const root = decodeInternal(pager.get(tree.rootId));
    expect(root.keys.every(key => compareBytes(key, bytes(prefix)) > 0)).toBe(true);
  });

  it('rewrites pages after prefix-changing updates and merges after deletion', () => {
    const pager = new Pager();
    const tree = new BTree<number>({ pager, pageSize: 256, restartInterval: 4 });

    for (let i = 0; i < 20; i++) tree.insert(`shared-prefix/${i.toString().padStart(2, '0')}`, i);
    expect(pager.pageCount).toBeGreaterThan(1);

    tree.insert('shared-prefix/00', 1000);
    expect(tree.get('shared-prefix/00')).toBe(1000);

    for (let i = 0; i < 14; i++) {
      expect(tree.delete(`shared-prefix/${i.toString().padStart(2, '0')}`)).toBe(true);
    }
    expect(pager.pageCount).toBe(1);
    expect(tree.size()).toBe(6);
    for (let i = 14; i < 20; i++) {
      expect(tree.get(`shared-prefix/${i.toString().padStart(2, '0')}`)).toBe(i);
    }
  });

  it('rejects a single key that cannot fit a page', () => {
    const tree = new BTree<number>({ pageSize: 128 });
    expect(() => tree.insert('x'.repeat(200), 1)).toThrow(PageOverflowError);
    expect(tree.size()).toBe(0);
  });
});

describe('binary-safe BTree', () => {
  it('orders unsigned byte keys through splits', () => {
    const tree = new BTree<Uint8Array>({
      codec: binaryValueCodec,
      pageSize: 256,
      restartInterval: 4,
    });
    const keys = [
      new Uint8Array([0]),
      new Uint8Array([0, 0]),
      new Uint8Array([255]),
      new Uint8Array([1]),
      new Uint8Array([0, 255]),
    ];

    for (const key of keys) tree.insert(key, key);
    const ordered = tree
      .range({ start: new Uint8Array([0]), end: new Uint8Array([255]) })
      .map(row => Array.from(row.keyBytes));

    expect(ordered).toEqual([[0], [0, 0], [0, 255], [1], [255]]);
    expect(tree.get(new Uint8Array([0, 255]))).toEqual(new Uint8Array([0, 255]));
  });
});
