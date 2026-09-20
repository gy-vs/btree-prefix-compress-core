// 公开 API
export { BTree } from './legacy.js';

export { PagedBTree } from './tree.js';
export type { ValueCodec, PagedBTreeOptions } from './tree.js';

export { MemoryPageStore } from './store.js';
export type { PageStore } from './store.js';

export {
  encodeLeaf,
  decodeLeaf,
  searchLeaf,
  leafEncodedSize,
  leafEntryOffset,
  LEAF_HEADER_SIZE,
  LEAF_MAGIC,
  DEFAULT_RESTART_INTERVAL,
} from './leaf.js';
export type { LeafEntry, ParsedLeaf } from './leaf.js';

export {
  encodeInternal,
  parseInternal,
  routeInternal,
  internalEncodedSize,
  INTERNAL_HEADER_SIZE,
} from './internal.js';
export type { InternalCell, ParsedInternal } from './internal.js';

export {
  bytesEqual,
  bytesToText,
  compareBytes,
  concatBytes,
  crc32,
  crc32Chunks,
  KeyTooLargeError,
  PageCorruptError,
  toBytes,
} from './coding.js';
