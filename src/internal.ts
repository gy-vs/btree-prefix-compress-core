// 内部页（暂不做前缀压缩：分隔键完整存储）
//
// 头部与叶页同构（16 字节）：
//   magic 0x4950 ('IP'), version=1, type=2,
//   count = 分隔键数（子页数 = count+1），restart 字段未使用（置 0），
//   usedBytes = 键/子指针区结束偏移，checksum = CRC32。
// 主体（自偏移 16 起）：count 个单元顺序排列
//   varint(keyLen) keyBytes u32(childPageId)
// 末尾再跟一个 u32（最右子指针）。
// 路由规则：child(i) 是第一个满足 key_i > target 的键左侧指针；
// 即 child(i) 中的键都 < key_i，右子树容纳 >= 最后一个分隔键的键。

import {
  compareBytes,
  Cursor,
  crc32Chunks,
  PageCorruptError,
  writeVarint,
  Writer,
} from './coding.js';

export const INTERNAL_MAGIC = 0x4950;
export const INTERNAL_VERSION = 1;
export const INTERNAL_TYPE = 2;
export const INTERNAL_HEADER_SIZE = 16;

export interface InternalCell {
  /** 分隔键：来自右子树的最小逻辑键 */
  key: Uint8Array;
  child: number;
}

export interface ParsedInternal {
  pageId: number;
  cells: InternalCell[];
  rightChild: number;
}

export function encodeInternal(
  cells: InternalCell[],
  rightChild: number,
  pageSize: number,
  checksum = true,
): Uint8Array | null {
  if (cells.length > 0xffff) return null;
  const w = new Writer(pageSize);
  w.bytes = new Uint8Array(pageSize);
  w.length = INTERNAL_HEADER_SIZE;

  for (const c of cells) {
    writeVarint(w, c.key.length);
    w.raw(c.key);
    w.u32(c.child >>> 0);
  }
  w.u32(rightChild >>> 0);
  const usedEnd = w.length;
  if (usedEnd > pageSize) return null;

  const page = w.bytes.subarray(0, pageSize);
  w.length = 0;
  w.u16(INTERNAL_MAGIC);
  w.u8(INTERNAL_VERSION);
  w.u8(INTERNAL_TYPE);
  w.u16(cells.length);
  w.u16(0); // restartCount 未使用
  w.u16(0); // restartInterval 未使用
  w.u16(usedEnd);
  const crc = crc32Chunks(page, [
    [0, 12],
    [INTERNAL_HEADER_SIZE, usedEnd],
  ]);
  w.u32(checksum ? crc : 0);
  return page.slice();
}

export function parseInternal(
  page: Uint8Array,
  pageId = 0,
  verifyChecksum = true,
): ParsedInternal {
  if (page.length < INTERNAL_HEADER_SIZE) {
    throw new PageCorruptError('page shorter than header', pageId);
  }
  const magic = page[0] | (page[1] << 8);
  if (magic !== INTERNAL_MAGIC) throw new PageCorruptError('bad internal magic', pageId);
  if (page[2] !== INTERNAL_VERSION) throw new PageCorruptError('unsupported version', pageId);
  if (page[3] !== INTERNAL_TYPE) throw new PageCorruptError('not an internal page', pageId);

  const count = page[4] | (page[5] << 8);
  const usedEnd = page[10] | (page[11] << 8);
  const storedChecksum =
    (page[12] | (page[13] << 8) | (page[14] << 16) | (page[15] << 24)) >>> 0;

  if (usedEnd < INTERNAL_HEADER_SIZE + 4 || usedEnd > page.length) {
    throw new PageCorruptError('usedBytes out of range', pageId);
  }
  if (verifyChecksum && storedChecksum !== 0) {
    const want = crc32Chunks(page, [
      [0, 12],
      [INTERNAL_HEADER_SIZE, usedEnd],
    ]);
    if (want !== storedChecksum) throw new PageCorruptError('checksum mismatch', pageId);
  }

  const cur = new Cursor(page, INTERNAL_HEADER_SIZE, usedEnd, pageId);
  const cells: InternalCell[] = [];
  let prevKey: Uint8Array | null = null;
  for (let i = 0; i < count; i++) {
    const keyLen = cur.varint();
    const key = cur.raw(keyLen);
    const child = cur.u32();
    if (prevKey !== null && compareBytes(prevKey, key) >= 0) {
      throw new PageCorruptError('internal keys not strictly increasing', pageId);
    }
    cells.push({ key, child });
    prevKey = key;
  }
  const rightChild = cur.u32();
  if (cur.pos !== usedEnd) throw new PageCorruptError('trailing bytes in internal page', pageId);
  return { pageId, cells, rightChild };
}

/** 返回 child pageId 与插入位置（用于递归插入/删除） */
export function routeInternal(page: Uint8Array, target: Uint8Array, pageId = 0): {
  child: number;
  index: number;
  parsed: ParsedInternal;
} {
  const parsed = parseInternal(page, pageId);
  // 收缩中的根：0 个分隔键、仅余最右子指针
  if (parsed.cells.length === 0) {
    return { child: parsed.rightChild, index: 0, parsed };
  }
  // lower_bound：第一个 key >= target
  let lo = 0;
  let hi = parsed.cells.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareBytes(parsed.cells[mid].key, target) < 0) lo = mid + 1;
    else hi = mid;
  }
  // lo==0 -> 最左（cells[0] 的 child）；否则上一个单元的 child
  const child = lo === 0 ? parsed.cells[0].child : parsed.cells[lo - 1].child;
  return { child, index: lo, parsed };
}

export function internalEncodedSize(cells: InternalCell[]): number {
  let bytes = INTERNAL_HEADER_SIZE + 4; // 头部 + 最右指针
  for (const c of cells) {
    let len = c.key.length;
    let vl = 1;
    while (len >= 0x80) {
      len = Math.floor(len / 128);
      vl++;
    }
    bytes += vl + c.key.length + 4;
  }
  return bytes;
}
