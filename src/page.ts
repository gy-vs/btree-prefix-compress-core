export const LEAF_TYPE = 0;
export const INTERNAL_TYPE = 1;

export const HEADER_LEN = 20;
const CHECKSUM_OFFSET = 16;
const PAYLOAD_START = HEADER_LEN;
const LEAF_ENTRY_HEADER_LEN = 12;

const MAGIC = 0x4650; // "PF"
const VERSION = 1;

export class PageFormatError extends Error {}
export class PageCorruptionError extends PageFormatError {}
export class PageOverflowError extends Error {}

export interface LeafEntry {
  key: Uint8Array;
  value: Uint8Array;
}

export interface LeafPageData {
  type: typeof LEAF_TYPE;
  entries: LeafEntry[];
}

export interface InternalPageData {
  type: typeof INTERNAL_TYPE;
  keys: Uint8Array[];
  children: number[];
}

export interface PageHeader {
  type: number;
  payloadLength: number;
  itemCount: number;
  restartInterval: number;
  restartCount: number;
}

function dv(page: Uint8Array): DataView {
  return new DataView(page.buffer, page.byteOffset, page.byteLength);
}

function requirePage(condition: boolean, message: string): asserts condition {
  if (!condition) throw new PageCorruptionError(message);
}

function u8(page: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 1 > page.length) {
    throw new PageCorruptionError('read outside page');
  }
  return dv(page).getUint8(offset);
}

function u16(page: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > page.length) {
    throw new PageCorruptionError('read outside page');
  }
  return dv(page).getUint16(offset, true);
}

function u32(page: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > page.length) {
    throw new PageCorruptionError('read outside page');
  }
  return dv(page).getUint32(offset, true);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function updateCrc(crc: number, bytes: Uint8Array, start: number, end: number): number {
  let c = crc;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return c >>> 0;
}

/** CRC-32C over all page bytes except the four checksum bytes. */
export function computePageChecksum(page: Uint8Array): number {
  let crc = 0xffffffff;
  crc = updateCrc(crc, page, 0, CHECKSUM_OFFSET);
  crc = updateCrc(crc, page, CHECKSUM_OFFSET + 4, page.length);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeChecksum(page: Uint8Array): void {
  dv(page).setUint32(CHECKSUM_OFFSET, computePageChecksum(page), true);
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export function commonPrefixLength(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  let n = 0;
  while (n < shared && a[n] === b[n]) n++;
  return n;
}

function assertRestartInterval(restartInterval: number): void {
  if (!Number.isInteger(restartInterval) || restartInterval < 1 || restartInterval > 0xffff) {
    throw new RangeError('restartInterval must be an integer from 1 through 65535');
  }
}

export function encodeLeaf(entries: readonly LeafEntry[], restartInterval = 16): Uint8Array {
  assertRestartInterval(restartInterval);

  let payloadLength = 0;
  for (let i = 0; i < entries.length; i++) {
    const { key, value } = entries[i];
    const restart = i % restartInterval === 0;
    const prefixLength = restart ? 0 : commonPrefixLength(entries[i - 1].key, key);
    payloadLength += LEAF_ENTRY_HEADER_LEN + key.length - prefixLength + value.length;
  }

  const restartCount = entries.length === 0 ? 0 : Math.ceil(entries.length / restartInterval);
  const page = new Uint8Array(HEADER_LEN + payloadLength + restartCount * 4);
  const view = dv(page);
  view.setUint16(0, MAGIC, true);
  view.setUint8(2, VERSION);
  view.setUint8(3, LEAF_TYPE);
  view.setUint32(4, payloadLength, true);
  view.setUint32(8, entries.length, true);
  view.setUint16(12, restartInterval, true);
  view.setUint16(14, restartCount, true);

  const restartOffsets: number[] = [];
  let pos = PAYLOAD_START;

  for (let i = 0; i < entries.length; i++) {
    const { key, value } = entries[i];
    const restart = i % restartInterval === 0;
    const prefixLength = restart ? 0 : commonPrefixLength(entries[i - 1].key, key);
    const suffix = key.subarray(prefixLength);

    if (restart) restartOffsets.push(pos - PAYLOAD_START);

    view.setUint32(pos, prefixLength, true);
    view.setUint32(pos + 4, suffix.length, true);
    view.setUint32(pos + 8, value.length, true);
    page.set(suffix, pos + LEAF_ENTRY_HEADER_LEN);
    page.set(value, pos + LEAF_ENTRY_HEADER_LEN + suffix.length);
    pos += LEAF_ENTRY_HEADER_LEN + suffix.length + value.length;
  }

  const trailerStart = HEADER_LEN + payloadLength;
  for (let i = 0; i < restartOffsets.length; i++) {
    view.setUint32(trailerStart + i * 4, restartOffsets[i], true);
  }

  writeChecksum(page);
  return page;
}

export function encodeInternal(keys: readonly Uint8Array[], children: readonly number[]): Uint8Array {
  if (children.length !== keys.length + 1) {
    throw new PageFormatError('internal page must have one more child than separator key');
  }

  let payloadLength = 4;
  for (const key of keys) payloadLength += 8 + key.length;

  const page = new Uint8Array(HEADER_LEN + payloadLength);
  const view = dv(page);
  view.setUint16(0, MAGIC, true);
  view.setUint8(2, VERSION);
  view.setUint8(3, INTERNAL_TYPE);
  view.setUint32(4, payloadLength, true);
  view.setUint32(8, keys.length, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0, true);

  let pos = PAYLOAD_START;
  view.setUint32(pos, children[0], true);
  pos += 4;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    view.setUint32(pos, key.length, true);
    page.set(key, pos + 4);
    view.setUint32(pos + 4 + key.length, children[i + 1], true);
    pos += 8 + key.length;
  }

  writeChecksum(page);
  return page;
}

export function readHeader(page: Uint8Array): PageHeader {
  if (page.length < HEADER_LEN) throw new PageCorruptionError('page is shorter than header');

  const payloadLength = u32(page, 4);
  const itemCount = u32(page, 8);
  const restartInterval = u16(page, 12);
  const restartCount = u16(page, 14);

  const expectedLength = HEADER_LEN + payloadLength + restartCount * 4;
  requirePage(Number.isSafeInteger(expectedLength), 'page length overflow');
  requirePage(expectedLength === page.length, 'page length does not match header');
  requirePage(payloadLength <= page.length - HEADER_LEN, 'payload length exceeds page');
  requirePage(restartCount * 4 <= page.length - HEADER_LEN - payloadLength, 'restart table exceeds page');
  requirePage(Number.isSafeInteger(itemCount), 'invalid item count');

  const storedChecksum = u32(page, CHECKSUM_OFFSET);
  requirePage(computePageChecksum(page) === storedChecksum, 'page checksum mismatch');

  requirePage(u16(page, 0) === MAGIC, 'bad page magic');
  requirePage(u8(page, 2) === VERSION, 'unsupported page version');
  const type = u8(page, 3);
  requirePage(type === LEAF_TYPE || type === INTERNAL_TYPE, 'bad page type');
  requirePage((u8(page, 3) & 0xfe) === 0, 'reserved flags are nonzero');

  if (type === LEAF_TYPE) {
    assertRestartInterval(restartInterval);
    const expectedRestarts = itemCount === 0 ? 0 : Math.ceil(itemCount / restartInterval);
    requirePage(restartCount === expectedRestarts, 'bad restart point count');
  } else {
    requirePage(restartInterval === 0 && restartCount === 0, 'internal pages have no restart table');
  }

  return { type, payloadLength, itemCount, restartInterval, restartCount };
}

export function readRestartOffsets(page: Uint8Array, header: PageHeader): number[] {
  const trailerStart = HEADER_LEN + header.payloadLength;
  const offsets: number[] = [];

  for (let i = 0; i < header.restartCount; i++) {
    const offset = u32(page, trailerStart + i * 4);
    if (i === 0) {
      requirePage(offset === 0, 'first restart point must be zero');
    } else {
      requirePage(offset > offsets[i - 1], 'restart points must be strictly increasing');
    }
    requirePage(
      offset + LEAF_ENTRY_HEADER_LEN <= header.payloadLength,
      'restart point outside payload',
    );
    offsets.push(offset);
  }

  return offsets;
}

interface EntryParts {
  prefixLength: number;
  suffix: Uint8Array;
  value: Uint8Array;
  end: number;
}

function u32p(page: Uint8Array, payloadOffset: number): number {
  return u32(page, PAYLOAD_START + payloadOffset);
}

function readEntryParts(page: Uint8Array, payloadPos: number, end: number): EntryParts {
  requirePage(payloadPos + LEAF_ENTRY_HEADER_LEN <= end, 'entry header outside page');

  const prefixLength = u32p(page, payloadPos);
  const suffixLength = u32p(page, payloadPos + 4);
  const valueLength = u32p(page, payloadPos + 8);
  const entryEnd = payloadPos + LEAF_ENTRY_HEADER_LEN + suffixLength + valueLength;

  requirePage(Number.isSafeInteger(entryEnd), 'entry length overflow');
  requirePage(entryEnd <= end, 'entry body outside page');

  const suffixStart = PAYLOAD_START + payloadPos + LEAF_ENTRY_HEADER_LEN;
  return {
    prefixLength,
    suffix: page.subarray(suffixStart, suffixStart + suffixLength),
    value: page.slice(suffixStart + suffixLength, PAYLOAD_START + entryEnd),
    end: entryEnd,
  };
}

function rebuildKey(previous: Uint8Array | null, prefixLength: number, suffix: Uint8Array): Uint8Array {
  if (previous === null) {
    requirePage(prefixLength === 0, 'restart key cannot use a prefix');
    previous = new Uint8Array(0);
  } else {
    requirePage(prefixLength <= previous.length, 'prefix length is outside previous key');
  }

  const key = new Uint8Array(prefixLength + suffix.length);
  key.set(previous.subarray(0, prefixLength), 0);
  key.set(suffix, prefixLength);
  return key;
}

function validateCanonicalKey(
  key: Uint8Array,
  previous: Uint8Array | null,
  prefixLength: number,
  restart: boolean,
): void {
  if (restart) {
    requirePage(prefixLength === 0, 'restart entry must store the complete key');
  } else {
    requirePage(previous !== null, 'prefix entry without previous key');
    requirePage(commonPrefixLength(previous!, key) === prefixLength, 'non-canonical prefix length');
    requirePage(compareBytes(previous!, key) < 0, 'keys are not strictly ordered');
  }
}

export function decodeLeaf(page: Uint8Array): LeafPageData {
  const header = readHeader(page);
  requirePage(header.type === LEAF_TYPE, 'page is not a leaf');

  if (header.itemCount === 0) {
    requirePage(header.payloadLength === 0, 'empty leaf has nonzero payload');
    return { type: LEAF_TYPE, entries: [] };
  }

  const restartOffsets = readRestartOffsets(page, header);
  const entries: LeafEntry[] = [];
  let previous: Uint8Array | null = null;
  let payloadPos = 0;
  let groupEnd = header.payloadLength;

  for (let i = 0; i < header.itemCount; i++) {
    const restart = i % header.restartInterval === 0;
    if (restart) {
      const ordinal = i / header.restartInterval;
      requirePage(payloadPos === restartOffsets[ordinal], 'restart offset does not point at an entry');
      groupEnd = ordinal + 1 < restartOffsets.length
        ? restartOffsets[ordinal + 1]
        : header.payloadLength;
    }

    const parts = readEntryParts(page, payloadPos, groupEnd);
    const key = rebuildKey(previous, parts.prefixLength, parts.suffix);
    validateCanonicalKey(key, previous, parts.prefixLength, restart);

    entries.push({ key, value: parts.value });
    previous = key;
    payloadPos = parts.end;

    const lastInGroup = (i + 1) % header.restartInterval === 0 || i + 1 === header.itemCount;
    if (lastInGroup) requirePage(payloadPos === groupEnd, 'entry does not end at restart boundary');
  }

  requirePage(payloadPos === header.payloadLength, 'unused leaf payload');
  return { type: LEAF_TYPE, entries };
}

function decodeRestartEntry(
  page: Uint8Array,
  header: PageHeader,
  offset: number,
  nextOffset: number,
): { key: Uint8Array; parts: EntryParts } {
  const end = nextOffset;
  const parts = readEntryParts(page, offset, end);
  requirePage(parts.prefixLength === 0, 'restart entry cannot use a prefix');
  const key = new Uint8Array(parts.suffix.length);
  key.set(parts.suffix);
  return { key, parts };
}

/**
 * Locate a key by binary searching restart keys, then decoding at most
 * restartInterval - 1 prefix-compressed entries sequentially.
 */
export function findLeafValue(page: Uint8Array, logicalKey: Uint8Array): Uint8Array | undefined {
  const header = readHeader(page);
  requirePage(header.type === LEAF_TYPE, 'page is not a leaf');
  if (header.itemCount === 0) return undefined;

  const offsets = readRestartOffsets(page, header);
  const restartKeys: Uint8Array[] = [];

  for (let i = 0; i < offsets.length; i++) {
    const next = i + 1 < offsets.length ? offsets[i + 1] : header.payloadLength;
    const { key } = decodeRestartEntry(page, header, offsets[i], next);
    if (i > 0) requirePage(compareBytes(restartKeys[i - 1], key) < 0, 'restart keys are not ordered');
    restartKeys.push(key);
  }

  let low = 0;
  let high = offsets.length;
  while (high - low > 1) {
    const mid = (low + high) >>> 1;
    if (compareBytes(restartKeys[mid], logicalKey) <= 0) low = mid;
    else high = mid;
  }

  if (compareBytes(restartKeys[low], logicalKey) > 0) return undefined;

  const groupEnd = low + 1 < offsets.length ? offsets[low + 1] : header.payloadLength;
  let payloadPos = offsets[low];
  let previous: Uint8Array | null = null;

  for (let local = 0; payloadPos < groupEnd; local++) {
    const restart = local % header.restartInterval === 0;
    const parts = readEntryParts(page, payloadPos, groupEnd);
    const key = rebuildKey(previous, parts.prefixLength, parts.suffix);
    validateCanonicalKey(key, previous, parts.prefixLength, restart);

    const cmp = compareBytes(key, logicalKey);
    if (cmp === 0) return parts.value;
    if (cmp > 0) return undefined;

    previous = key;
    payloadPos = parts.end;
  }

  requirePage(payloadPos === groupEnd, 'restart interval is truncated');
  return undefined;
}

export function decodeInternal(page: Uint8Array): InternalPageData {
  const header = readHeader(page);
  requirePage(header.type === INTERNAL_TYPE, 'page is not internal');

  const keys: Uint8Array[] = [];
  const children: number[] = [];
  let pos = 0;

  requirePage(pos + 4 <= header.payloadLength, 'missing first child pointer');
  children.push(u32(page, PAYLOAD_START));
  pos += 4;

  let previousKey: Uint8Array | null = null;
  while (pos < header.payloadLength) {
    requirePage(pos + 8 <= header.payloadLength, 'truncated internal entry');
    const keyLength = u32(page, PAYLOAD_START + pos);
    requirePage(pos + 8 + keyLength <= header.payloadLength, 'internal key outside payload');

    const key = page.slice(PAYLOAD_START + pos + 4, PAYLOAD_START + pos + 4 + keyLength);
    if (previousKey !== null) {
      requirePage(compareBytes(previousKey, key) < 0, 'internal keys are not ordered');
    }
    keys.push(key);
    previousKey = key;

    const child = u32(page, PAYLOAD_START + pos + 4 + keyLength);
    children.push(child);
    pos += 8 + keyLength;
  }

  requirePage(pos === header.payloadLength, 'unused internal payload');
  requirePage(children.length === keys.length + 1, 'internal child/key count mismatch');
  return { type: INTERNAL_TYPE, keys, children };
}

export function leafEncodedLength(entries: readonly LeafEntry[], restartInterval = 16): number {
  assertRestartInterval(restartInterval);
  let payload = 0;

  for (let i = 0; i < entries.length; i++) {
    const restart = i % restartInterval === 0;
    const prefixLength = restart ? 0 : commonPrefixLength(entries[i - 1].key, entries[i].key);
    payload += LEAF_ENTRY_HEADER_LEN + entries[i].key.length - prefixLength + entries[i].value.length;
  }

  const restarts = entries.length === 0 ? 0 : Math.ceil(entries.length / restartInterval);
  return HEADER_LEN + payload + restarts * 4;
}

function leafRangeLength(
  entries: readonly LeafEntry[],
  start: number,
  end: number,
  restartInterval: number,
): number {
  let payload = 0;
  for (let i = start; i < end; i++) {
    const restart = i === start || (i - start) % restartInterval === 0;
    const prefixLength = restart ? 0 : commonPrefixLength(entries[i - 1].key, entries[i].key);
    payload += LEAF_ENTRY_HEADER_LEN + entries[i].key.length - prefixLength + entries[i].value.length;
  }

  const count = end - start;
  const restarts = count === 0 ? 0 : Math.ceil(count / restartInterval);
  return HEADER_LEN + payload + restarts * 4;
}

export function internalEncodedLength(keys: readonly Uint8Array[], children: readonly number[]): number {
  if (children.length !== keys.length + 1) {
    throw new PageFormatError('internal page must have one more child than separator key');
  }
  let payload = 4;
  for (const key of keys) payload += 8 + key.length;
  return HEADER_LEN + payload;
}

/**
 * Choose a leaf split using post-encoding byte cost. The right side restarts
 * its prefix compression at the split, so every candidate is measured with the
 * restart table it will actually use.
 */
export function chooseLeafSplit(
  entries: readonly LeafEntry[],
  restartInterval: number,
  pageSize: number,
): number {
  let best = -1;
  let bestImbalance = Number.POSITIVE_INFINITY;

  for (let split = 1; split < entries.length; split++) {
    const leftSize = leafRangeLength(entries, 0, split, restartInterval);
    const rightSize = leafRangeLength(entries, split, entries.length, restartInterval);
    if (leftSize > pageSize || rightSize > pageSize) continue;

    const imbalance = Math.abs(leftSize - rightSize);
    if (imbalance < bestImbalance) {
      best = split;
      bestImbalance = imbalance;
    }
  }

  return best;
}

export function chooseInternalSplit(
  keys: readonly Uint8Array[],
  children: readonly number[],
  pageSize: number,
): number {
  let best = -1;
  let bestImbalance = Number.POSITIVE_INFINITY;

  for (let split = 0; split < keys.length; split++) {
    const leftKeys = keys.slice(0, split);
    const rightKeys = keys.slice(split + 1);
    const leftChildren = children.slice(0, split + 1);
    const rightChildren = children.slice(split + 1);

    const leftSize = internalEncodedLength(leftKeys, leftChildren);
    const rightSize = internalEncodedLength(rightKeys, rightChildren);
    if (leftSize > pageSize || rightSize > pageSize) continue;

    const imbalance = Math.abs(leftSize - rightSize);
    if (imbalance < bestImbalance) {
      best = split;
      bestImbalance = imbalance;
    }
  }

  return best;
}
