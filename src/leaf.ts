// 叶页格式（固定页大小 pageSize，默认 4096；头部长度字段为 u16，页最大 65535）
//
//  ┌──────────────────────────────────────────── 固定头 16 字节 ────────────────────────────────────────────┐
//  │ 0  magic   u16 = 0x4C50 ('LP')                                                                       │
//  │ 2  version u8  = 1                                                                                   │
//  │ 3  type    u8  = 1（叶页；内部页为 2）                                                                │
//  │ 4  count   u16 条目数                                                                                │
//  │ 6  restartCount u16 重启点数（空页也有 1 个“哨兵重启点”）                                              │
//  │ 8  restartInterval u16 编码时使用的重启间隔（≥1，默认 16）                                            │
//  │ 10 usedBytes u16 entries 区结束偏移（= 重启表起始），便于快速判断“编码后是否放得下”                     │
//  │ 12 checksum u32 CRC32，覆盖：头部 [0,12) + entries [HEADER, usedBytes) + 重启表 [usedBytes, tableEnd) │
//  └───────────────────────────────────────────────────────────────────────────────────────────────────────┘
//  ┌─ entries 区（前缀压缩，自 HEADER=16 起顺序排布） ┐   空闲间隙（不参与校验）   ┌─ 重启点表（u16，页尾向前增长）─┐
//
// 重启点表：restartCount 个条目偏移，外加 1 个哨兵 = entries 区结束偏移（usedBytes）。
//   - 表本身按偏移升序存储，可直接二分；
//   - 哨兵让“第 i 个重启区间的结束边界”不需要特判；
//   - 偏移相对于页起始（u16），因此页容量上限 65535。
//
// 条目编码（相对前一个逻辑键做前缀压缩）：
//   restart 条目: varint(0) varint(keyLen) keyBytes valueBytes
//   普通条目   : varint(shared) varint(unsharedLen) unsharedKeyBytes valueBytes
//   值          : varint(valueLen) valueBytes
// 重启点处 shared 必为 0，完整键就地存储，因此从任意重启点即可独立解码。

import {
  compareBytes,
  concatBytes,
  Cursor,
  crc32Chunks,
  PageCorruptError,
  writeVarint,
  Writer,
} from './coding.js';

export const LEAF_MAGIC = 0x4c50;
export const LEAF_VERSION = 1;
export const LEAF_TYPE = 1;
export const LEAF_HEADER_SIZE = 16;
export const DEFAULT_RESTART_INTERVAL = 16;
/** 单页条目数上限：每个条目至少占 shared+unshared+value 三个 varint = 3 字节 */
const MAX_COUNT = (65535 - LEAF_HEADER_SIZE) / 3;

export interface LeafEntry {
  key: Uint8Array;
  value: Uint8Array;
}

/**
 * 编码叶页。返回固定 pageSize 大小的 Uint8Array；
 * 若重启表 + 条目 + 头部超出 pageSize，返回 null（调用方据此分裂，按“编码后大小”决策）。
 */
export function encodeLeaf(
  entries: LeafEntry[],
  pageSize: number,
  restartInterval = DEFAULT_RESTART_INTERVAL,
  checksum = true,
): Uint8Array | null {
  if (restartInterval < 1) throw new Error('restartInterval must be >= 1');
  if (pageSize > 65535 || pageSize < LEAF_HEADER_SIZE + 4) {
    throw new Error(`pageSize ${pageSize} out of [${LEAF_HEADER_SIZE + 4}, 65535]`);
  }
  if (entries.length > 0xffff) throw new Error('too many entries for one leaf page');

  const w = new Writer(pageSize);
  w.bytes = new Uint8Array(pageSize); // 直接在整页缓冲内顺序写 entries
  w.length = LEAF_HEADER_SIZE;

  const restartOffsets: number[] = [];
  let prevKey: Uint8Array = new Uint8Array(0);

  for (let i = 0; i < entries.length; i++) {
    const { key, value } = entries[i];
    if (i % restartInterval === 0) {
      restartOffsets.push(w.length);
      writeVarint(w, 0); // 重启点：显式 shared=0
      writeVarint(w, key.length);
      w.raw(key);
    } else {
      const shared = commonPrefix(prevKey, key);
      writeVarint(w, shared);
      writeVarint(w, key.length - shared);
      w.raw(key.subarray(shared));
    }
    writeVarint(w, value.length);
    w.raw(value);
    prevKey = key;
  }

  // 空页也记录哨兵（entries 区结束）
  const entriesEnd = w.length;
  restartOffsets.push(entriesEnd);

  const tableStart = entriesEnd;
  for (const off of restartOffsets) w.u16(off);
  const tableEnd = w.length;

  if (tableEnd > pageSize) return null;

  const page = w.bytes.subarray(0, pageSize); // pageSize 长度，间隙为零字节
  // 头部
  w.length = 0;
  w.u16(LEAF_MAGIC);
  w.u8(LEAF_VERSION);
  w.u8(LEAF_TYPE);
  w.u16(entries.length);
  w.u16(restartOffsets.length - 1); // 不含哨兵
  w.u16(restartInterval);
  w.u16(entriesEnd);
  // 校验范围刻意不含间隙（间隙允许是任意字节）
  const crc = crc32Chunks(page, [
    [0, 12],
    [LEAF_HEADER_SIZE, tableEnd],
  ]);
  w.u32(checksum ? crc : 0);

  return page.slice();
}

function commonPrefix(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

export interface ParsedLeaf {
  pageId: number;
  count: number;
  restartInterval: number;
  restartOffsets: number[]; // 不含哨兵
  entriesEnd: number;
  tableEnd: number;
  storedChecksum: number;
}

function parseLeafHeader(page: Uint8Array, pageId: number, verifyChecksum: boolean): ParsedLeaf {
  if (page.length < LEAF_HEADER_SIZE) throw new PageCorruptError('page shorter than header', pageId);
  const magic = page[0] | (page[1] << 8);
  if (magic !== LEAF_MAGIC) throw new PageCorruptError('bad leaf magic', pageId);
  if (page[2] !== LEAF_VERSION) throw new PageCorruptError('unsupported leaf version', pageId);
  if (page[3] !== LEAF_TYPE) throw new PageCorruptError('not a leaf page', pageId);

  const count = page[4] | (page[5] << 8);
  const restartCount = page[6] | (page[7] << 8);
  const restartInterval = page[8] | (page[9] << 8);
  const entriesEnd = page[10] | (page[11] << 8);
  const storedChecksum =
    (page[12] | (page[13] << 8) | (page[14] << 16) | (page[15] << 24)) >>> 0;

  if (restartInterval < 1) throw new PageCorruptError('restartInterval must be >= 1', pageId);
  if (count > MAX_COUNT) throw new PageCorruptError('entry count implausible', pageId);

  // 期望重启点数：count===0 时为 0 个真实重启点（表中只有哨兵）
  const expectedRestarts = count === 0 ? 0 : Math.floor((count - 1) / restartInterval) + 1;
  if (restartCount !== expectedRestarts) {
    throw new PageCorruptError('restart point count mismatch', pageId);
  }
  if (entriesEnd < LEAF_HEADER_SIZE) throw new PageCorruptError('usedBytes below header', pageId);

  const tableBytes = (restartCount + 1) * 2;
  const tableEnd = entriesEnd + tableBytes;
  if (tableEnd > page.length) throw new PageCorruptError('restart table outside page', pageId);

  if (verifyChecksum && storedChecksum !== 0) {
    const want = crc32Chunks(page, [
      [0, 12],
      [LEAF_HEADER_SIZE, tableEnd],
    ]);
    if (want !== storedChecksum) throw new PageCorruptError('checksum mismatch', pageId);
  }

  const restartOffsets: number[] = [];
  let prev = -1;
  for (let i = 0; i < restartCount; i++) {
    const off = page[entriesEnd + i * 2] | (page[entriesEnd + i * 2 + 1] << 8);
    if (off < LEAF_HEADER_SIZE || off >= entriesEnd) {
      throw new PageCorruptError('restart offset out of entries area', pageId);
    }
    if (off <= prev) throw new PageCorruptError('restart offsets not strictly increasing', pageId);
    restartOffsets.push(off);
    prev = off;
  }
  // 哨兵必须等于 entriesEnd
  const sentinel =
    page[entriesEnd + restartCount * 2] | (page[entriesEnd + restartCount * 2 + 1] << 8);
  if (sentinel !== entriesEnd) throw new PageCorruptError('restart table sentinel mismatch', pageId);

  return {
    pageId,
    count,
    restartInterval,
    restartOffsets,
    entriesEnd,
    tableEnd,
    storedChecksum,
  };
}

/** 解码一个重启条目（shared 必须为 0，得到完整键），返回后游标停在值之前 */
function readRestartEntry(
  page: Uint8Array,
  pos: number,
  bound: number,
  pageId: number,
): { key: Uint8Array; cur: Cursor } {
  const cur = new Cursor(page, pos, bound, pageId);
  const shared = cur.varint();
  if (shared !== 0) throw new PageCorruptError('restart entry has nonzero shared', pageId);
  const keyLen = cur.varint();
  const key = cur.raw(keyLen);
  return { key, cur };
}

/**
 * 完整解码整页（用于范围扫描 / 页重写）。
 * 逐条目重建完整逻辑键，任何长度字段异常都会在定界游标内抛 PageCorruptError。
 */
export function decodeLeaf(
  page: Uint8Array,
  pageId = 0,
  verifyChecksum = true,
): LeafEntry[] {
  const h = parseLeafHeader(page, pageId, verifyChecksum);
  if (h.count === 0) {
    if (h.entriesEnd !== LEAF_HEADER_SIZE) {
      throw new PageCorruptError('empty leaf claims used bytes', pageId);
    }
    return [];
  }

  const entries: LeafEntry[] = [];
  // 每个重启区间 [restart[i], restart[i+1])，最后一个区间以 entriesEnd（哨兵）为界
  const intervalEnds = [...h.restartOffsets.slice(1), h.entriesEnd];
  let prevKey: Uint8Array = new Uint8Array(0);

  for (let r = 0; r < h.restartOffsets.length; r++) {
    const cur = new Cursor(page, h.restartOffsets[r], intervalEnds[r], pageId);
    const entriesInInterval = Math.min(
      h.restartInterval,
      h.count - r * h.restartInterval,
    );
    for (let j = 0; j < entriesInInterval; j++) {
      const shared = cur.varint();
      const unsharedLen = cur.varint();
      if (j === 0) {
        if (shared !== 0) throw new PageCorruptError('restart entry has nonzero shared', pageId);
      } else if (shared > prevKey.length) {
        // 损坏的前缀长度：绝不能据此去读上一个键之外的字节
        throw new PageCorruptError('shared prefix longer than previous key', pageId);
      }
      const suffix = cur.raw(unsharedLen);
      const valueLen = cur.varint();
      const value = cur.raw(valueLen);

      const key = j === 0 || shared === 0
        ? suffix
        : concatBytes(prevKey.subarray(0, shared), suffix);

      // 顺序性校验：键必须严格递增（损坏检测，防止错乱页被当作合法数据）
      if (entries.length > 0 && compareBytes(entries[entries.length - 1].key, key) >= 0) {
        throw new PageCorruptError('leaf keys not strictly increasing', pageId);
      }
      entries.push({ key, value });
      prevKey = key;
    }
    if (cur.pos !== cur.end) {
      throw new PageCorruptError('trailing bytes in restart interval', pageId);
    }
  }

  if (entries.length !== h.count) {
    throw new PageCorruptError('decoded entry count mismatch', pageId);
  }
  return entries;
}

/**
 * 不解码整页，在单个重启区间内查找。
 * 返回区间起点下标（相对于整页条目）以及解码出的区间条目。
 */
function decodeInterval(
  page: Uint8Array,
  h: ParsedLeaf,
  intervalIndex: number,
): LeafEntry[] {
  const starts = h.restartOffsets;
  const start = starts[intervalIndex];
  const end = intervalIndex + 1 < starts.length ? starts[intervalIndex + 1] : h.entriesEnd;
  const cur = new Cursor(page, start, end, h.pageId);
  const out: LeafEntry[] = [];
  const limit = Math.min(h.restartInterval, h.count - intervalIndex * h.restartInterval);
  let prevKey: Uint8Array = new Uint8Array(0);

  for (let j = 0; j < limit; j++) {
    const shared = cur.varint();
    const unsharedLen = cur.varint();
    if (j === 0) {
      if (shared !== 0) throw new PageCorruptError('restart entry has nonzero shared', h.pageId);
    } else if (shared > prevKey.length) {
      throw new PageCorruptError('shared prefix longer than previous key', h.pageId);
    }
    const suffix = cur.raw(unsharedLen);
    const valueLen = cur.varint();
    const value = cur.raw(valueLen);
    const key = j === 0 || shared === 0 ? suffix : concatBytes(prevKey.subarray(0, shared), suffix);
    if (out.length > 0 && compareBytes(out[out.length - 1].key, key) >= 0) {
      throw new PageCorruptError('leaf keys not strictly increasing', h.pageId);
    }
    out.push({ key, value });
    prevKey = key;
  }
  if (cur.pos !== cur.end) throw new PageCorruptError('trailing bytes in restart interval', h.pageId);
  return out;
}

/**
 * 叶页查找：先二分重启点表定位区间（只需解码每个重启点的完整键），
 * 再在该区间内顺序解码至多 restartInterval 个条目。
 * 比较一律使用重建后的完整逻辑键。
 */
export function searchLeaf(
  page: Uint8Array,
  target: Uint8Array,
  pageId = 0,
  verifyChecksum = true,
): { found: boolean; index: number; entry?: LeafEntry } {
  const h = parseLeafHeader(page, pageId, verifyChecksum);
  if (h.count === 0) return { found: false, index: 0 };

  // 二分：找最后一个首键 <= target 的重启区间（upper_bound - 1）
  let lo = 0;
  let hi = h.restartOffsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const bound = mid + 1 < h.restartOffsets.length
      ? h.restartOffsets[mid + 1]
      : h.entriesEnd;
    const { key } = readRestartEntry(page, h.restartOffsets[mid], bound, h.pageId);
    if (compareBytes(key, target) <= 0) lo = mid + 1;
    else hi = mid;
  }
  const interval = lo - 1; // target 不可能小于首个重启键（否则 lo=0）
  if (interval < 0) {
    // target 小于页内第一个键
    return { found: false, index: 0 };
  }

  const slice = decodeInterval(page, h, interval);
  const base = interval * h.restartInterval;
  for (let j = 0; j < slice.length; j++) {
    const cmp = compareBytes(slice[j].key, target);
    if (cmp === 0) return { found: true, index: base + j, entry: slice[j] };
    if (cmp > 0) return { found: false, index: base + j };
  }
  return { found: false, index: base + slice.length };
}

/**
 * 仅计算编码后所需字节数（含头部与重启表），分裂/合并按此大小决策，不依赖页大小。
 *
 * 重要：调用方传入的 entries 必须以“重启点条目”起头，即 entries[0] 按 shared=0 编码。
 * 全局重启间隔 interval 决定其后每隔多少条目再落一个完整键。
 */
export function leafEncodedSize(
  entries: LeafEntry[],
  restartInterval = DEFAULT_RESTART_INTERVAL,
): number {
  let bytes = LEAF_HEADER_SIZE;
  let prevKey: Uint8Array = new Uint8Array(0);
  let restartCount = 0;
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i].key;
    const shared = i % restartInterval === 0 ? 0 : commonPrefix(prevKey, key);
    const unshared = key.length - shared;
    if (i % restartInterval === 0) restartCount++;
    bytes += varintLen(shared) + varintLen(unshared) + unshared;
    bytes += varintLen(entries[i].value.length) + entries[i].value.length;
    prevKey = key;
  }
  return bytes + (restartCount + 1) * 2; // 重启表 + 哨兵
}

/**
 * 计算“已在更大序列中排好序、从 offset 起的一个切片”的编码大小。
 * 切片自身的首条目必须成为重启点（shared=0），因此按
 * (indexWithinSlice) % interval 计算压缩，而不是沿用全局下标。
 */
export function leafSliceEncodedSize(
  all: LeafEntry[],
  start: number,
  endExclusive: number,
  restartInterval = DEFAULT_RESTART_INTERVAL,
): number {
  const slice: LeafEntry[] = new Array(endExclusive - start);
  for (let i = 0; i < slice.length; i++) slice[i] = all[start + i];
  return leafEncodedSize(slice, restartInterval);
}

function varintLen(n: number): number {
  let l = 1;
  while (n >= 0x80) {
    n = Math.floor(n / 128);
    l++;
  }
  return l;
}

/** 测试辅助：定位第 i 个条目首字节的偏移（用于构造损坏用例） */
export function leafEntryOffset(page: Uint8Array, index: number, pageId = 0): number {
  const h = parseLeafHeader(page, pageId, false);
  if (index < 0 || index >= h.count) throw new Error('entry index out of range');
  const r = Math.floor(index / h.restartInterval);
  const cur = new Cursor(
    page,
    h.restartOffsets[r],
    r + 1 < h.restartOffsets.length ? h.restartOffsets[r + 1] : h.entriesEnd,
    pageId,
  );
  const within = index - r * h.restartInterval;
  for (let j = 0; j < within; j++) {
    cur.varint(); // shared
    const unshared = cur.varint();
    cur.pos += unshared; // 后缀
    const vlen = cur.varint();
    cur.pos += vlen; // 值
  }
  return cur.pos;
}
