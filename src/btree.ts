import {
  chooseInternalSplit,
  chooseLeafSplit,
  commonPrefixLength,
  compareBytes,
  decodeInternal,
  decodeLeaf,
  encodeInternal,
  encodeLeaf,
  findLeafValue,
  internalEncodedLength,
  INTERNAL_TYPE,
  leafEncodedLength,
  LEAF_TYPE,
  PageCorruptionError,
  PageOverflowError,
  readHeader,
  type LeafEntry,
} from './page.js';

export {
  compareBytes,
  commonPrefixLength,
  computePageChecksum,
  decodeInternal,
  decodeLeaf,
  encodeInternal,
  encodeLeaf,
  findLeafValue,
  leafEncodedLength,
  readHeader,
  internalEncodedLength,
  PageCorruptionError,
  PageFormatError,
  PageOverflowError,
  chooseLeafSplit,
} from './page.js';

export interface ValueCodec<T> {
  encode(value: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}

export const binaryValueCodec: ValueCodec<Uint8Array> = {
  encode(value) {
    if (!(value instanceof Uint8Array)) throw new TypeError('binary value must be Uint8Array');
    return value;
  },
  decode(value) {
    return value;
  },
};

export const jsonValueCodec: ValueCodec<unknown> = {
  encode(value) {
    return new TextEncoder().encode(JSON.stringify(value));
  },
  decode(value) {
    return JSON.parse(new TextDecoder().decode(value));
  },
};

export interface BTreeOptions<T> {
  /** Total serialized page size, including the 20-byte header and checksum. */
  pageSize?: number;
  restartInterval?: number;
  codec?: ValueCodec<T>;
}

type KeyInput = string | Uint8Array;

export interface RangeOptions {
  start?: string | Uint8Array;
  end?: string | Uint8Array;
  includeStart?: boolean;
  includeEnd?: boolean;
}

export interface RangeResult<T> {
  key: string;
  keyBytes: Uint8Array;
  value: T;
}

interface LeafNode {
  type: typeof LEAF_TYPE;
  id: number;
  entries: LeafEntry[];
}

interface InternalNode {
  type: typeof INTERNAL_TYPE;
  id: number;
  keys: Uint8Array[];
  children: number[];
}

type Node = LeafNode | InternalNode;

interface SplitResult {
  promotedKey: Uint8Array;
  rightId: number;
}

const textEncoder = new TextEncoder();

export class Pager {
  #pages = new Map<number, Uint8Array>();
  #nextId = 1;

  alloc(page: Uint8Array): number {
    const id = this.#nextId++;
    this.#pages.set(id, page);
    return id;
  }

  get(id: number): Uint8Array {
    const page = this.#pages.get(id);
    if (page === undefined) throw new PageCorruptionError(`missing page ${id}`);
    return page;
  }

  put(id: number, page: Uint8Array): void {
    if (!this.#pages.has(id)) throw new PageCorruptionError(`cannot update missing page ${id}`);
    this.#pages.set(id, page);
  }

  delete(id: number): void {
    this.#pages.delete(id);
  }

  get pageCount(): number {
    return this.#pages.size;
  }
}

function toKey(key: KeyInput): Uint8Array {
  if (typeof key === 'string') return textEncoder.encode(key);
  if (key instanceof Uint8Array) return key;
  throw new TypeError('key must be a string or Uint8Array');
}

export class BTree<T = unknown> {
  readonly #pager: Pager;
  readonly #pageSize: number;
  readonly #restartInterval: number;
  readonly #codec: ValueCodec<T>;
  #rootId: number;

  constructor(options: BTreeOptions<T> & { pager?: Pager } = {}) {
    const pageSize = options.pageSize ?? 16 * 1024;
    const restartInterval = options.restartInterval ?? 16;

    if (!Number.isInteger(pageSize) || pageSize < 128) {
      throw new RangeError('pageSize must be an integer no smaller than 128');
    }
    if (!Number.isInteger(restartInterval) || restartInterval < 1 || restartInterval > 0xffff) {
      throw new RangeError('restartInterval must be an integer from 1 through 65535');
    }

    this.#pager = options.pager ?? new Pager();
    this.#pageSize = pageSize;
    this.#restartInterval = restartInterval;
    this.#codec = options.codec ?? (jsonValueCodec as ValueCodec<T>);

    const root = encodeLeaf([], restartInterval);
    this.#rootId = this.#pager.alloc(root);
  }

  get pageSize(): number {
    return this.#pageSize;
  }

  get restartInterval(): number {
    return this.#restartInterval;
  }

  get rootId(): number {
    return this.#rootId;
  }

  #load(id: number): Node {
    const page = this.#pager.get(id);
    const header = readHeader(page);
    if (header.type === LEAF_TYPE) return { type: LEAF_TYPE, id, entries: decodeLeaf(page).entries };
    const internal = decodeInternal(page);
    return { type: INTERNAL_TYPE, id, keys: internal.keys, children: internal.children };
  }

  #saveLeaf(node: LeafNode): void {
    const page = encodeLeaf(node.entries, this.#restartInterval);
    if (page.length > this.#pageSize) {
      throw new PageOverflowError('leaf page exceeds configured page size');
    }
    this.#pager.put(node.id, page);
  }

  #saveInternal(node: InternalNode): void {
    const page = encodeInternal(node.keys, node.children);
    if (page.length > this.#pageSize) {
      throw new PageOverflowError('internal page exceeds configured page size');
    }
    this.#pager.put(node.id, page);
  }

  #assertKeyFits(key: Uint8Array): void {
    // A leaf must store one restart entry; an internal parent must later store
    // the same key plus one child pointer.
    const minLeafSize = leafEncodedLength([{ key, value: new Uint8Array(0) }], this.#restartInterval);
    const minInternalSize = internalEncodedLength([key], [0, 0]);
    if (minLeafSize > this.#pageSize || minInternalSize > this.#pageSize) {
      throw new PageOverflowError('key is too large to fit in a page');
    }
  }

  insert(keyInput: KeyInput, value: T): void {
    const key = toKey(keyInput);
    const storedValue = this.#codec.encode(value);
    this.#assertKeyFits(key);
    const split = this.#insert(this.#rootId, key, storedValue);
    if (split !== undefined) {
      const newRoot = encodeInternal([split.promotedKey], [this.#rootId, split.rightId]);
      this.#rootId = this.#pager.alloc(newRoot);
    }
  }

  #insert(id: number, key: Uint8Array, value: Uint8Array): SplitResult | undefined {
    const node = this.#load(id);

    if (node.type === LEAF_TYPE) {
      let at = 0;
      while (at < node.entries.length && compareBytes(node.entries[at].key, key) < 0) at++;

      if (at < node.entries.length && compareBytes(node.entries[at].key, key) === 0) {
        node.entries[at] = { key, value };
        this.#saveLeaf(node);
        return undefined;
      }

      node.entries.splice(at, 0, { key, value });
      if (leafEncodedLength(node.entries, this.#restartInterval) <= this.#pageSize) {
        this.#saveLeaf(node);
        return undefined;
      }

      return this.#splitLeaf(node);
    }

    const childIndex = this.#findChildIndex(node.keys, key);
    const split = this.#insert(node.children[childIndex], key, value);
    if (split === undefined) return undefined;

    node.keys.splice(childIndex, 0, split.promotedKey);
    node.children.splice(childIndex + 1, 0, split.rightId);

    if (internalEncodedLength(node.keys, node.children) <= this.#pageSize) {
      this.#saveInternal(node);
      return undefined;
    }

    return this.#splitInternal(node);
  }

  #splitLeaf(node: LeafNode): SplitResult {
    const split = chooseLeafSplit(node.entries, this.#restartInterval, this.#pageSize);
    if (split < 0) throw new PageOverflowError('leaf cannot be split into two valid pages');

    const rightEntries = node.entries.slice(split);
    const leftEntries = node.entries.slice(0, split);
    node.entries = leftEntries;

    this.#saveLeaf(node);
    const rightId = this.#pager.alloc(encodeLeaf(rightEntries, this.#restartInterval));
    return { promotedKey: rightEntries[0].key.slice(), rightId };
  }

  #splitInternal(node: InternalNode): SplitResult {
    const split = chooseInternalSplit(node.keys, node.children, this.#pageSize);
    if (split < 0) throw new PageOverflowError('internal page cannot be split into two valid pages');

    const promotedKey = node.keys[split].slice();
    const rightKeys = node.keys.slice(split + 1);
    const rightChildren = node.children.slice(split + 1);
    node.keys = node.keys.slice(0, split);
    node.children = node.children.slice(0, split + 1);

    this.#saveInternal(node);
    const rightId = this.#pager.alloc(encodeInternal(rightKeys, rightChildren));
    return { promotedKey, rightId };
  }

  #findChildIndex(keys: Uint8Array[], key: Uint8Array): number {
    let at = 0;
    while (at < keys.length && compareBytes(keys[at], key) <= 0) at++;
    return at;
  }

  get(keyInput: KeyInput): T | undefined {
    const key = toKey(keyInput);
    let id = this.#rootId;

    for (;;) {
      const page = this.#pager.get(id);
      const header = readHeader(page);
      if (header.type === LEAF_TYPE) {
        const value = findLeafValue(page, key);
        return value === undefined ? undefined : this.#codec.decode(value);
      }

      const internal = decodeInternal(page);
      id = internal.children[this.#findChildIndex(internal.keys, key)];
    }
  }

  delete(keyInput: KeyInput): boolean {
    const key = toKey(keyInput);
    if (!this.#containsLeaf(this.#rootId, key)) return false;

    this.#deleteAt(this.#rootId, key);
    this.#persistAfterDelete(this.#load(this.#rootId));
    this.#collapseRootIfNeeded();
    return true;
  }

  #containsLeaf(id: number, key: Uint8Array): boolean {
    for (;;) {
      const page = this.#pager.get(id);
      const header = readHeader(page);
      if (header.type === LEAF_TYPE) return findLeafValue(page, key) !== undefined;

      const internal = decodeInternal(page);
      id = internal.children[this.#findChildIndex(internal.keys, key)];
    }
  }

  #deleteAt(id: number, key: Uint8Array): void {
    const node = this.#load(id);
    if (node.type === LEAF_TYPE) {
      const at = node.entries.findIndex(entry => compareBytes(entry.key, key) === 0);
      node.entries.splice(at, 1);
      this.#saveLeaf(node);
      return;
    }

    const childIndex = this.#findChildIndex(node.keys, key);
    this.#deleteAt(node.children[childIndex], key);
  }

  /** Bottom-up persist; merge adjacent children that fit within one page. */
  #persistAfterDelete(node: Node): void {
    if (node.type === LEAF_TYPE) {
      this.#saveLeaf(node);
      return;
    }

    let i = 0;
    while (i < node.children.length) {
      this.#persistAfterDelete(this.#load(node.children[i]));
      const merged = this.#rebalanceChild(node, i);
      if (!merged) i++;
    }
    this.#saveInternal(node);
  }

  #collapseRootIfNeeded(): void {
    const root = this.#load(this.#rootId);
    if (root.type !== INTERNAL_TYPE || root.children.length !== 1) return;

    const onlyChild = root.children[0];
    this.#pager.delete(root.id);
    this.#rootId = onlyChild;
  }

  #nodePageLength(node: Node): number {
    return node.type === LEAF_TYPE
      ? leafEncodedLength(node.entries, this.#restartInterval)
      : internalEncodedLength(node.keys, node.children);
  }

  #rebalanceChild(parent: InternalNode, childIndex: number): boolean {
    const child = this.#load(parent.children[childIndex]);

    if (this.#nodePageLength(child) >= Math.floor(this.#pageSize / 2)) {
      this.#saveNode(child);
      return false;
    }

    if (childIndex > 0) {
      const left = this.#load(parent.children[childIndex - 1]);
      if (this.#canMerge(left, child, parent.keys[childIndex - 1])) {
        this.#mergeChildren(parent, childIndex - 1);
        return true;
      }
    } else if (childIndex + 1 < parent.children.length) {
      const right = this.#load(parent.children[childIndex + 1]);
      if (this.#canMerge(child, right, parent.keys[childIndex])) {
        this.#mergeChildren(parent, childIndex);
        return true;
      }
    }

    this.#saveInternal(parent);
    return false;
  }

  #saveNode(node: Node): void {
    if (node.type === LEAF_TYPE) this.#saveLeaf(node);
    else this.#saveInternal(node);
  }

  #canMerge(left: Node, right: Node, separator: Uint8Array): boolean {
    if (left.type === LEAF_TYPE && right.type === LEAF_TYPE) {
      return leafEncodedLength([...left.entries, ...right.entries], this.#restartInterval) <= this.#pageSize;
    }

    if (left.type === INTERNAL_TYPE && right.type === INTERNAL_TYPE) {
      return internalEncodedLength(
        [...left.keys, separator.slice(), ...right.keys],
        [...left.children, ...right.children],
      ) <= this.#pageSize;
    }

    return false;
  }

  #mergeChildren(parent: InternalNode, leftIndex: number): void {
    const left = this.#load(parent.children[leftIndex]);
    const right = this.#load(parent.children[leftIndex + 1]);

    if (left.type === LEAF_TYPE && right.type === LEAF_TYPE) {
      left.entries = [...left.entries, ...right.entries];
    } else if (left.type === INTERNAL_TYPE && right.type === INTERNAL_TYPE) {
      left.keys = [...left.keys, parent.keys[leftIndex].slice(), ...right.keys];
      left.children = [...left.children, ...right.children];
    } else {
      throw new PageCorruptionError('sibling node types do not match');
    }

    parent.keys.splice(leftIndex, 1);
    parent.children.splice(leftIndex + 1, 1);
    this.#pager.delete(right.id);
    this.#saveNode(left);
    this.#saveInternal(parent);
  }

  range(options?: RangeOptions): RangeResult<T>[];
  range(start: KeyInput, end: KeyInput): RangeResult<T>[];
  range(startOrOptions: KeyInput | RangeOptions = {}, endInput?: KeyInput): RangeResult<T>[] {
    let start: Uint8Array | undefined;
    let end: Uint8Array | undefined;
    let includeStart = true;
    let includeEnd = true;

    if (typeof startOrOptions === 'object' && !(startOrOptions instanceof Uint8Array)) {
      const options = startOrOptions;
      start = options.start === undefined ? undefined : toKey(options.start);
      end = options.end === undefined ? undefined : toKey(options.end);
      includeStart = options.includeStart ?? true;
      includeEnd = options.includeEnd ?? true;
    } else {
      start = startOrOptions === undefined ? undefined : toKey(startOrOptions);
      end = endInput === undefined ? undefined : toKey(endInput);
    }

    const result: RangeResult<T>[] = [];
    this.#collectRange(this.#rootId, start, end, includeStart, includeEnd, result);
    return result;
  }

  #collectRange(
    id: number,
    start: Uint8Array | undefined,
    end: Uint8Array | undefined,
    includeStart: boolean,
    includeEnd: boolean,
    result: RangeResult<T>[],
  ): void {
    const node = this.#load(id);

    if (node.type === INTERNAL_TYPE) {
      let first = 0;
      if (start !== undefined) {
        first = includeStart ? this.#findChildIndex(node.keys, start) : this.#findChildIndex(node.keys, start);
      }

      for (let i = first; i < node.children.length; i++) {
        if (end !== undefined && i > 0) {
          const lower = node.keys[i - 1];
          const cmp = compareBytes(lower, end);
          if (cmp > 0 || (!includeEnd && cmp === 0)) break;
        }
        this.#collectRange(node.children[i], start, end, includeStart, includeEnd, result);
      }
      return;
    }

    for (const entry of node.entries) {
      if (start !== undefined) {
        const cmp = compareBytes(entry.key, start);
        if (cmp < 0 || (!includeStart && cmp === 0)) continue;
      }
      if (end !== undefined) {
        const cmp = compareBytes(entry.key, end);
        if (cmp > 0 || (!includeEnd && cmp === 0)) continue;
      }
      result.push({
        key: new TextDecoder().decode(entry.key),
        keyBytes: entry.key.slice(),
        value: this.#codec.decode(entry.value),
      });
    }
  }

  size(): number {
    return this.#count(this.#rootId);
  }

  #count(id: number): number {
    const node = this.#load(id);
    if (node.type === LEAF_TYPE) return node.entries.length;
    return node.children.reduce((sum, childId) => sum + this.#count(childId), 0);
  }
}
