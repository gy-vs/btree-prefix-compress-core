// 基础编码工具：二进制键、无符号 LEB128 varint、CRC32
// 所有多字节整数使用小端序。键按无符号字节序比较（memcmp 语义）。

export class PageCorruptError extends Error {
  constructor(
    message: string,
    readonly pageId?: number,
  ) {
    super(pageId === undefined ? message : `page ${pageId}: ${message}`);
    this.name = 'PageCorruptError';
  }
}

export class KeyTooLargeError extends Error {
  constructor(
    readonly keyLength: number,
    readonly capacity: number,
  ) {
    super(`entry of ${keyLength} bytes (plus header) cannot fit in a ${capacity}-byte page`);
    this.name = 'KeyTooLargeError';
  }
}

/** 字符串键使用 UTF-8 编码后参与字节序排序与存储 */
export function toBytes(key: string | Uint8Array): Uint8Array {
  if (key instanceof Uint8Array) return key.slice();
  return new TextEncoder().encode(key);
}

/** 零长度键（保证底层为 ArrayBuffer，规避 TS 的 Uint8Array 泛型差异） */
export function emptyBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new ArrayBuffer(0));
}

export function bytesToText(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 无符号字节序比较：a < b => -1，相等 => 0，a > b => 1 */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** 可增长字节缓冲，用于先编码再判断是否放得进固定页 */
export class Writer {
  bytes: Uint8Array;
  length = 0;

  constructor(capacity = 64) {
    this.bytes = new Uint8Array(capacity);
  }

  #ensure(extra: number): void {
    const need = this.length + extra;
    if (need <= this.bytes.length) return;
    let cap = this.bytes.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.bytes);
    this.bytes = next;
  }

  u8(v: number): void {
    this.#ensure(1);
    this.bytes[this.length++] = v;
  }

  u16(v: number): void {
    this.#ensure(2);
    const b = this.bytes;
    b[this.length++] = v & 0xff;
    b[this.length++] = (v >>> 8) & 0xff;
  }

  u32(v: number): void {
    this.#ensure(4);
    const b = this.bytes;
    b[this.length++] = v & 0xff;
    b[this.length++] = (v >>> 8) & 0xff;
    b[this.length++] = (v >>> 16) & 0xff;
    b[this.length++] = (v >>> 24) & 0xff;
  }

  raw(data: Uint8Array): void {
    this.#ensure(data.length);
    this.bytes.set(data, this.length);
    this.length += data.length;
  }

  toBytes(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

/** 无符号 LEB128。页内长度字段都受页大小限制，天然不会失控 */
export function writeVarint(w: Writer, n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`invalid varint: ${n}`);
  }
  while (n >= 0x80) {
    w.u8((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  w.u8(n);
}

/** 定界读取游标：任何越过 end 的读取都抛 PageCorruptError，绝不越界访问页 */
export class Cursor {
  pos: number;
  constructor(
    readonly page: Uint8Array,
    pos: number,
    readonly end: number,
    readonly pageId?: number,
  ) {
    if (pos < 0 || end > page.length || pos > end) {
      throw new PageCorruptError('cursor outside page bounds', pageId);
    }
    this.pos = pos;
  }

  require(n: number): void {
    if (this.pos + n > this.end || this.pos + n < this.pos) {
      throw new PageCorruptError('truncated record', this.pageId);
    }
  }

  u8(): number {
    this.require(1);
    return this.page[this.pos++];
  }

  u16(): number {
    this.require(2);
    const v = this.page[this.pos] | (this.page[this.pos + 1] << 8);
    this.pos += 2;
    return v >>> 0;
  }

  u32(): number {
    this.require(4);
    const p = this.page;
    const v =
      (p[this.pos] |
        (p[this.pos + 1] << 8) |
        (p[this.pos + 2] << 16) |
        (p[this.pos + 3] << 24)) >>> 0;
    this.pos += 4;
    return v;
  }

  varint(): number {
    let result = 0;
    let shift = 1;
    for (let i = 0; i < 10; i++) {
      this.require(1);
      const b = this.page[this.pos++];
      if (i === 9 && b > 1) throw new PageCorruptError('varint overflow', this.pageId);
      result += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) return result;
      shift *= 128;
      if (shift > Number.MAX_SAFE_INTEGER) {
        throw new PageCorruptError('varint overflow', this.pageId);
      }
    }
    throw new PageCorruptError('varint too long', this.pageId);
  }

  raw(n: number): Uint8Array {
    this.require(n);
    // 总是拷贝，避免调用方持有整页引用
    const out = this.page.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

// CRC32（zlib 多项式 0xEDB88320）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** 原始 CRC 更新（不带首尾异或），便于跨不连续区间链式计算 */
export function crc32Update(
  data: Uint8Array,
  start: number,
  end: number,
  crc: number,
): number {
  let c = crc >>> 0;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return c >>> 0;
}

export function crc32(
  data: Uint8Array,
  start = 0,
  end: number = data.length,
  crc = 0xffffffff,
): number {
  return (crc32Update(data, start, end, crc) ^ 0xffffffff) >>> 0;
}

/** 对若干不连续区间做流式 CRC（用于跳过页内空闲间隙） */
export function crc32Chunks(page: Uint8Array, ranges: Array<[number, number]>): number {
  let crc = 0xffffffff;
  for (const [s, e] of ranges) crc = crc32Update(page, s, e, crc);
  return (crc ^ 0xffffffff) >>> 0;
}
