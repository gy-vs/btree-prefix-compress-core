// 带前缀压缩叶页的页式 B+树。
// - 叶页：前缀压缩 + 重启点（见 leaf.ts）
// - 内部页：完整分隔键（见 internal.ts）
// - 所有重写/分裂/合并都以“编码后字节数”为准，绝不以条目数对半。
//
// 内部页在内存中统一表示为“指针槽序列”：
//   slot0={key:null,      child:P0}
//   slot i={key:K_i,      child:P_i}   (i>=1，K_i 是进入 P_i 子树的下界)
// 落盘编码（见 internal.ts）：cell j = (K(j+1), P_j)，最右指针 P_n 单独存。
// 路由：slot = 满足 K_i <= target 的分隔键数量（upper_bound）。

import {
  bytesEqual,
  compareBytes,
  KeyTooLargeError,
  toBytes,
} from './coding.js';
import {
  DEFAULT_RESTART_INTERVAL,
  decodeLeaf,
  encodeLeaf,
  leafEncodedSize,
  LeafEntry,
  searchLeaf,
} from './leaf.js';
import {
  encodeInternal,
  InternalCell,
  internalEncodedSize,
  parseInternal,
} from './internal.js';
import { PageStore } from './store.js';

export interface ValueCodec<V> {
  encode(value: V): Uint8Array;
  decode(raw: Uint8Array): V;
}

const JSON_CODEC: ValueCodec<unknown> = {
  encode: (v) => new TextEncoder().encode(JSON.stringify(v) ?? 'null'),
  decode: (raw) => JSON.parse(new TextDecoder().decode(raw)),
};

export interface PagedBTreeOptions {
  restartInterval?: number;
  verifyChecksums?: boolean;
}

interface Slot {
  /** null 仅出现在序列首位；其余为进入该子树的分隔键（完整逻辑键） */
  key: Uint8Array | null;
  child: number;
}

/** 子节点分裂结果：用一串槽位替换父节点中的单个槽位（首槽复用原页号） */
interface SplitResult {
  kind: 'split';
  slots: Slot[];
}
type InsertResult = { kind: 'ok' } | SplitResult;

const LEAF_TYPE = 1;
const INTERNAL_TYPE = 2;

export class PagedBTree<V = unknown> {
  readonly #store: PageStore;
  readonly #restartInterval: number;
  readonly #verify: boolean;
  readonly #codec: ValueCodec<V>;
  #root: number;
  #size = 0;

  constructor(store: PageStore, codec?: ValueCodec<V>, options: PagedBTreeOptions = {}) {
    this.#store = store;
    this.#restartInterval = options.restartInterval ?? DEFAULT_RESTART_INTERVAL;
    this.#verify = options.verifyChecksums ?? true;
    this.#codec = codec ?? (JSON_CODEC as ValueCodec<V>);
    // 根初始化为空叶页，占用保留页号 0
    this.#root = 0;
    this.#store.write(0, this.#encodeLeafPage([]));
  }

  get pageSize(): number {
    return this.#store.pageSize;
  }

  get rootId(): number {
    return this.#root;
  }

  size(): number {
    return this.#size;
  }

  // ---------- 落盘辅助 ----------

  #encodeLeafPage(entries: LeafEntry[]): Uint8Array {
    const p = encodeLeaf(entries, this.#store.pageSize, this.#restartInterval, true);
    if (!p) throw new Error('leaf entries exceed page capacity');
    return p;
  }

  #encodeInternalPage(slots: Slot[]): Uint8Array {
    const cells: InternalCell[] = [];
    for (let i = 1; i < slots.length; i++) {
      // cell(i-1) = (K_i, P_(i-1))
      cells.push({ key: slots[i].key!, child: slots[i - 1].child });
    }
    const p = encodeInternal(cells, slots[slots.length - 1].child, this.#store.pageSize, true);
    if (!p) throw new Error('internal slots exceed page capacity');
    return p;
  }

  #readSlots(pageId: number): Slot[] {
    const parsed = parseInternal(this.#store.read(pageId), pageId, this.#verify);
    const slots: Slot[] = [];
    if (parsed.cells.length === 0) {
      slots.push({ key: null, child: parsed.rightChild });
      return slots;
    }
    for (let i = 0; i < parsed.cells.length; i++) {
      slots.push({
        key: i === 0 ? null : parsed.cells[i - 1].key,
        child: parsed.cells[i].child,
      });
    }
    slots.push({
      key: parsed.cells[parsed.cells.length - 1].key,
      child: parsed.rightChild,
    });
    return slots;
  }

  #slotsEncodedSize(slots: Slot[]): number {
    const cells: InternalCell[] = [];
    for (let i = 1; i < slots.length; i++) {
      cells.push({ key: slots[i].key!, child: slots[i - 1].child });
    }
    return internalEncodedSize(cells); // 已含头部与最右指针
  }

  /** upper_bound：返回满足 slot.key <= target 的分隔键数量，即应进入的槽位号 */
  static #routeSlot(slots: Slot[], target: Uint8Array): number {
    let lo = 1;
    let hi = slots.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareBytes(slots[mid].key!, target) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  // ---------- 插入 ----------

  insert(keyInput: string | Uint8Array, value: V): void {
    const key = toBytes(keyInput);
    const valueBytes = this.#codec.encode(value);
    // 单条目按“无公共前缀的重启条目”最坏体积预检，与邻居无关
    if (leafEncodedSize([{ key, value: valueBytes }], this.#restartInterval) >
      this.#store.pageSize) {
      throw new KeyTooLargeError(key.length + valueBytes.length, this.#store.pageSize);
    }
    const existed = this.get(keyInput) !== undefined;
    const entry: LeafEntry = { key, value: valueBytes };

    const result = this.#insertInto(this.#root, entry);
    if (result.kind === 'split') {
      const rootId = this.#store.alloc();
      this.#store.write(rootId, this.#encodeInternalPage(result.slots));
      this.#root = rootId;
    }
    if (!existed) this.#size++;
  }

  #insertInto(pageId: number, entry: LeafEntry): InsertResult {
    const page = this.#store.read(pageId);

    if (page[3] === LEAF_TYPE) {
      const entries = decodeLeaf(page, pageId, this.#verify);
      const pos = lowerBoundEntries(entries, entry.key);
      if (pos < entries.length && bytesEqual(entries[pos].key, entry.key)) {
        entries[pos] = entry; // 更新值；键不变
      } else {
        entries.splice(pos, 0, entry);
      }

      if (leafEncodedSize(entries, this.#restartInterval) <= this.#store.pageSize) {
        this.#store.write(pageId, this.#encodeLeafPage(entries));
        return { kind: 'ok' };
      }

      // 分裂：按编码后大小贪心分页，首组复用原页号，其余分配新页
      const groups = this.#groupLeafEntries(entries);
      const slots: Slot[] = [];
      groups.forEach((g, i) => {
        const id = i === 0 ? pageId : this.#store.alloc();
        this.#store.write(id, this.#encodeLeafPage(g));
        slots.push({ key: i === 0 ? null : g[0].key, child: id });
      });
      return { kind: 'split', slots };
    }

    // 内部页
    const slots = this.#readSlots(pageId);
    const slot = PagedBTree.#routeSlot(slots, entry.key);
    const result = this.#insertInto(slots[slot].child, entry);
    if (result.kind === 'ok') return result;

    // 用子节点返回的槽位链替换该槽位；保留父节点原有的进入键
    const incomingKey = slots[slot].key;
    const replacement = result.slots.map((s, i) =>
      i === 0 ? { key: incomingKey, child: s.child } : s,
    );
    slots.splice(slot, 1, ...replacement);

    if (this.#slotsEncodedSize(slots) <= this.#store.pageSize) {
      this.#store.write(pageId, this.#encodeInternalPage(slots));
      return { kind: 'ok' };
    }

    // 内部分裂：沿指针序列按编码大小切多页。
    // 每片右页在父级的进入分隔键 = 该片首个槽位自身的进入键（即该子树最小键），
    // 切开后该片首槽键被本地置 null（它是该页的最左指针）。
    const pieces = this.#splitSlots(slots);
    const outSlots: Slot[] = [];
    pieces.forEach((piece, i) => {
      const id = i === 0 ? pageId : this.#store.alloc();
      this.#store.write(id, this.#encodeInternalPage(piece.slots));
      outSlots.push({ key: i === 0 ? null : piece.promoted, child: id });
    });
    return { kind: 'split', slots: outSlots };
  }

  /** 贪心把叶条目切成多页，每首条天然是重启点（编码时 shared=0） */
  #groupLeafEntries(entries: LeafEntry[]): LeafEntry[][] {
    const groups: LeafEntry[][] = [];
    let start = 0;
    while (start < entries.length) {
      let end = start + 1;
      while (
        end < entries.length &&
        leafEncodedSize(entries.slice(start, end + 1), this.#restartInterval) <=
          this.#store.pageSize
      ) {
        end++;
      }
      groups.push(entries.slice(start, end));
      start = end;
    }
    return groups;
  }

  #splitSlots(slots: Slot[]): { slots: Slot[]; promoted: Uint8Array | null }[] {
    // 自左向右切分。promoted 是“该片在父级中的进入分隔键”：
    //   首片为 null（由调用方替换成原子树槽位的进入键，或作为新根最左指针）；
    //   每在 best 处切开，右片首槽原始键 rest[best].key 即该片的进入键。
    const pieces: { slots: Slot[]; promoted: Uint8Array | null }[] = [];
    let rest = slots;
    let pendingSep: Uint8Array | null = null;

    while (this.#slotsEncodedSize(rest) > this.#store.pageSize) {
      // 找最大的 best：左片 rest[0..best-1] 放得下，且右片至少保留 2 个指针
      let best = -1;
      for (let cand = rest.length - 1; cand >= 1; cand--) {
        if (rest.length - cand < 2) continue;
        if (this.#slotsEncodedSize(rest.slice(0, cand)) <= this.#store.pageSize) {
          best = cand;
          break;
        }
      }
      if (best < 1) throw new Error('internal page cannot hold separator keys');
      const sepForNext = rest[best].key!; // 右片首槽键，非空（rest[0].key 已规范化为 null）
      pieces.push({ slots: rest.slice(0, best), promoted: pendingSep });
      rest = rest.slice(best).map((s, i) =>
        i === 0 ? { key: null, child: s.child } : s,
      );
      pendingSep = sepForNext;
    }
    pieces.push({ slots: rest, promoted: pendingSep });
    return pieces;
  }

  // ---------- 查询 ----------

  get(keyInput: string | Uint8Array): V | undefined {
    const key = toBytes(keyInput);
    let pageId = this.#root;
    for (;;) {
      const page = this.#store.read(pageId);
      if (page[3] === LEAF_TYPE) {
        const r = searchLeaf(page, key, pageId, this.#verify);
        return r.found && r.entry ? this.#codec.decode(r.entry.value) : undefined;
      }
      const slots = this.#readSlots(pageId);
      pageId = slots[PagedBTree.#routeSlot(slots, key)].child;
    }
  }

  has(keyInput: string | Uint8Array): boolean {
    return this.get(keyInput) !== undefined;
  }

  range(
    startInput: string | Uint8Array,
    endInput: string | Uint8Array,
  ): { key: Uint8Array; value: V }[] {
    const start = toBytes(startInput);
    const end = toBytes(endInput);
    const out: { key: Uint8Array; value: V }[] = [];
    this.#scanRange(this.#root, start, end, out);
    return out;
  }

  #scanRange(
    pageId: number,
    start: Uint8Array,
    end: Uint8Array,
    out: { key: Uint8Array; value: V }[],
  ): void {
    const page = this.#store.read(pageId);
    if (page[3] === LEAF_TYPE) {
      // 叶内顺序解码，比较一律用完整逻辑键
      for (const e of decodeLeaf(page, pageId, this.#verify)) {
        if (compareBytes(e.key, start) < 0) continue;
        if (compareBytes(e.key, end) > 0) return;
        out.push({ key: e.key, value: this.#codec.decode(e.value) });
      }
      return;
    }
    const slots = this.#readSlots(pageId);
    for (const s of slots) {
      // s.key 是该子树最小键下界；下界已超过 end 即可剪枝
      if (s.key !== null && compareBytes(s.key, end) > 0) return;
      this.#scanRange(s.child, start, end, out);
    }
  }

  // ---------- 删除 ----------

  delete(keyInput: string | Uint8Array): boolean {
    const key = toBytes(keyInput);
    const before = this.#size;
    this.#deleteFrom(this.#root, key, true);
    return this.#size !== before;
  }

  /**
   * 删除递归返回：
   *  - {kind:'ok'}        本页无需父级处理（含已自行塌缩的根）
   *  - {kind:'underflow'} 非根页低于半满，请求父级合并/重分布
   *  - SplitResult        级联合并/重分布使本页溢出，已分裂为多个槽位（首槽复用本页号）
   */
  #deleteFrom(pageId: number, key: Uint8Array, isRoot: boolean):
    | { kind: 'ok' }
    | { kind: 'underflow' }
    | SplitResult {
    const page = this.#store.read(pageId);

    if (page[3] === LEAF_TYPE) {
      const entries = decodeLeaf(page, pageId, this.#verify);
      const pos = lowerBoundEntries(entries, key);
      if (pos >= entries.length || !bytesEqual(entries[pos].key, key)) return { kind: 'ok' };
      entries.splice(pos, 1);
      this.#size--;

      // 删除会改变后续键相对重启点的位置，前缀压缩率可能下降，
      // 因此“删掉一条”也可能让编码后体积反而变大而溢出。按编码后大小判断，
      // 溢出时与插入路径一样按编码大小贪心分裂（首组复用本页号）。
      if (leafEncodedSize(entries, this.#restartInterval) > this.#store.pageSize) {
        const groups = this.#groupLeafEntries(entries);
        const splitSlots: Slot[] = [];
        groups.forEach((g, i) => {
          const id = i === 0 ? pageId : this.#store.alloc();
          this.#store.write(id, this.#encodeLeafPage(g));
          splitSlots.push({ key: i === 0 ? null : g[0].key, child: id });
        });
        return { kind: 'split', slots: splitSlots };
      }

      this.#store.write(pageId, this.#encodeLeafPage(entries));
      if (isRoot) return { kind: 'ok' };
      return leafEncodedSize(entries, this.#restartInterval) <
        Math.ceil(this.#store.pageSize / 2)
        ? { kind: 'underflow' }
        : { kind: 'ok' };
    }

    const slots = this.#readSlots(pageId);
    const slot = PagedBTree.#routeSlot(slots, key);
    const result = this.#deleteFrom(slots[slot].child, key, false);
    if (result.kind === 'ok') return { kind: 'ok' };

    // 子节点因级联处理而分裂：用返回的槽位链替换原子槽（同插入路径）
    if (result.kind === 'split') {
      const incomingKey = slots[slot].key;
      const replacement = result.slots.map((s, i) =>
        i === 0 ? { key: incomingKey, child: s.child } : s,
      );
      slots.splice(slot, 1, ...replacement);
    } else {
      // underflow：就地合并/重分布
      let at = slot;
      // 合并可能级联；与左邻居合并后槽位下标左移
      while (slots.length > 1 && this.#isUnderfull(slots[at].child)) {
        if (at > 0 && this.#tryMerge(slots, at - 1)) {
          at -= 1;
          continue;
        }
        if (at + 1 < slots.length && this.#tryMerge(slots, at)) {
          continue;
        }
        this.#redistributeEvenly(slots, at);
        break;
      }
    }

    if (slots.length === 1) {
      if (isRoot) {
        this.#store.free(pageId);
        this.#root = slots[0].child;
        return { kind: 'ok' };
      }
      // 非根瞬态单指针页：先落盘（清掉已释放指针），再交父级合并
      this.#store.write(pageId, this.#encodeInternalPage(slots));
      return { kind: 'underflow' };
    }

    // 防御性归一化：级联合并后本页可能超出页容量，按编码大小重新分裂
    if (this.#slotsEncodedSize(slots) > this.#store.pageSize) {
      const pieces = this.#splitSlots(slots);
      const outSlots: Slot[] = [];
      pieces.forEach((piece, i) => {
        const id = i === 0 ? pageId : this.#store.alloc();
        this.#store.write(id, this.#encodeInternalPage(piece.slots));
        outSlots.push({ key: i === 0 ? null : piece.promoted, child: id });
      });
      if (isRoot) {
        const rootId = this.#store.alloc();
        this.#store.write(rootId, this.#encodeInternalPage(outSlots));
        this.#root = rootId;
        return { kind: 'ok' };
      }
      return { kind: 'split', slots: outSlots };
    }

    this.#store.write(pageId, this.#encodeInternalPage(slots));
    if (isRoot) return { kind: 'ok' };
    return this.#slotsEncodedSize(slots) < Math.ceil(this.#store.pageSize / 2)
      ? { kind: 'underflow' }
      : { kind: 'ok' };
  }

  #isUnderfull(childId: number): boolean {
    const p = this.#store.read(childId);
    const half = Math.ceil(this.#store.pageSize / 2);
    if (p[3] === LEAF_TYPE) {
      return leafEncodedSize(decodeLeaf(p, childId, false), this.#restartInterval) < half;
    }
    return this.#slotsEncodedSize(this.#readSlots(childId)) < half;
  }

  /** 合并槽位 a 与 a+1（分隔键为 slots[a+1].key），成功返回 true。按编码后大小判断。 */
  #tryMerge(slots: Slot[], a: number): boolean {
    const leftId = slots[a].child;
    const rightId = slots[a + 1].child;
    const sep = slots[a + 1].key!;
    const pageL = this.#store.read(leftId);
    const pageR = this.#store.read(rightId);

    if (pageL[3] === LEAF_TYPE && pageR[3] === LEAF_TYPE) {
      const merged = [
        ...decodeLeaf(pageL, leftId, this.#verify),
        ...decodeLeaf(pageR, rightId, this.#verify),
      ];
      if (leafEncodedSize(merged, this.#restartInterval) > this.#store.pageSize) {
        return false;
      }
      this.#store.write(leftId, this.#encodeLeafPage(merged));
      this.#store.free(rightId);
      slots.splice(a + 1, 1); // 同时移除右指针与它的进入键
      return true;
    }

    if (pageL[3] === INTERNAL_TYPE && pageR[3] === INTERNAL_TYPE) {
      const l = this.#readSlots(leftId);
      const r = this.#readSlots(rightId);
      // 左指针链 + 下沉分隔键（作为右页首指针的进入键）+ 右指针链
      const merged: Slot[] = [...l, { key: sep, child: r[0].child }, ...r.slice(1)];
      if (this.#slotsEncodedSize(merged) > this.#store.pageSize) return false;
      this.#store.write(leftId, this.#encodeInternalPage(merged));
      this.#store.free(rightId);
      slots.splice(a + 1, 1);
      return true;
    }

    throw new Error('sibling page type mismatch');
  }

  /**
   * 合并放不下时的平衡重分布：把“邻居 + 自身”的完整条目/指针视为一个有序序列，
   * 枚举切点，选一个让两侧都是合法页、且接收方尽量达到半满的切法。
   * 这同时处理了“压缩率随切点变化”：可行性按各自编码后大小独立判定，
   * 绝不把任何一侧切空，也不假设条目数对半。
   */
  #redistributeEvenly(slots: Slot[], at: number): void {
    const recvId = slots[at].child;
    const page = this.#store.read(recvId);
    const half = Math.ceil(this.#store.pageSize / 2);

    // 选择较大的邻居作为共同切分对象
    const hasLeft = at > 0;
    const hasRight = at + 1 < slots.length;
    const sizeOf = (id: number) => {
      const p = this.#store.read(id);
      return p[3] === LEAF_TYPE
        ? leafEncodedSize(decodeLeaf(p, id, false), this.#restartInterval)
        : this.#slotsEncodedSize(this.#readSlots(id));
    };
    let fromLeft: boolean;
    if (!hasLeft) fromLeft = false;
    else if (!hasRight) fromLeft = true;
    else fromLeft = sizeOf(slots[at - 1].child) >= sizeOf(slots[at + 1].child);

    if (page[3] === LEAF_TYPE) {
      const neighborId = fromLeft ? slots[at - 1].child : slots[at + 1].child;
      const own = decodeLeaf(page, recvId, this.#verify);
      const neighbor = decodeLeaf(this.#store.read(neighborId), neighborId, this.#verify);
      const combined = fromLeft ? [...neighbor, ...own] : [...own, ...neighbor];

      const cut = this.#findLeafCut(combined, half, fromLeft);
      const leftPart = combined.slice(0, cut);
      const rightPart = combined.slice(cut);
      const leftId = fromLeft ? neighborId : recvId;
      const rightId = fromLeft ? recvId : neighborId;
      this.#store.write(leftId, this.#encodeLeafPage(leftPart));
      this.#store.write(rightId, this.#encodeLeafPage(rightPart));

      // 父级分隔键 = 右侧页首键
      if (fromLeft) slots[at].key = rightPart[0].key;
      else slots[at + 1].key = rightPart[0].key;
      return;
    }

    // 内部页：组合指针链后在指针边界处切分
    const neighborId = fromLeft ? slots[at - 1].child : slots[at + 1].child;
    const sep = fromLeft ? slots[at].key! : slots[at + 1].key!;
    const ownS = this.#readSlots(recvId);
    const nbS = this.#readSlots(neighborId);
    const combined: Slot[] = fromLeft
      ? [...nbS, { key: sep, child: ownS[0].child }, ...ownS.slice(1)]
      : [...ownS, { key: sep, child: nbS[0].child }, ...nbS.slice(1)];

    const cut = this.#findSlotCut(combined, half, fromLeft);
    const leftPart = combined.slice(0, cut);
    const rightPart = combined.slice(cut).map((s, i) =>
      i === 0 ? { key: null, child: s.child } : s,
    );
    const leftId = fromLeft ? neighborId : recvId;
    const rightId = fromLeft ? recvId : neighborId;
    this.#store.write(leftId, this.#encodeInternalPage(leftPart));
    this.#store.write(rightId, this.#encodeInternalPage(rightPart));

    // 上提/更新父级分隔键为右片首指针的进入键（= combined[cut].key，非空）
    if (fromLeft) slots[at].key = combined[cut].key!;
    else slots[at + 1].key = combined[cut].key!;
  }

  /**
   * 在有序叶条目中找切点 t（1 <= t < len），两侧编码后都放得下。
   * receiverIsLeft=true 时左侧是接收方：优先让左侧达到半满（取可行的最大 t）；
   * 否则右侧是接收方：优先让右侧达到半满（取可行的最小 t）。
   */
  #findLeafCut(combined: LeafEntry[], half: number, receiverIsLeft: boolean): number {
    const fits = (slice: LeafEntry[]) =>
      leafEncodedSize(slice, this.#restartInterval) <= this.#store.pageSize;
    const feasible: number[] = [];
    for (let t = 1; t < combined.length; t++) {
      if (fits(combined.slice(0, t)) && fits(combined.slice(t))) feasible.push(t);
    }
    if (feasible.length === 0) {
      throw new Error('leaf redistribution: no valid cut (single entry overflow?)');
    }
    const meetsHalf = (t: number) =>
      leafEncodedSize(
        receiverIsLeft ? combined.slice(0, t) : combined.slice(t),
        this.#restartInterval,
      ) >= half;
    const ok = feasible.filter(meetsHalf);
    if (ok.length === 0) return feasible[Math.floor(feasible.length / 2)];
    return receiverIsLeft ? ok[ok.length - 1] : ok[0];
  }

  /** 内部指针链版本的切点选择：t 为左片指针数（1 <= t < len） */
  #findSlotCut(combined: Slot[], half: number, receiverIsLeft: boolean): number {
    const fits = (piece: Slot[]) => this.#slotsEncodedSize(piece) <= this.#store.pageSize;
    const feasible: number[] = [];
    for (let t = 1; t < combined.length; t++) {
      const left = combined.slice(0, t);
      const right = combined.slice(t).map((s, i) =>
        i === 0 ? { key: null as Uint8Array | null, child: s.child } : s,
      );
      // 切点右侧必须有真实进入键（不能落在唯一指针前）
      if (combined[t].key === null) continue;
      if (fits(left) && fits(right)) feasible.push(t);
    }
    if (feasible.length === 0) {
      throw new Error('internal redistribution: no valid cut');
    }
    const meetsHalf = (t: number) =>
      this.#slotsEncodedSize(receiverIsLeft ? combined.slice(0, t) : combined.slice(t)) >= half;
    const ok = feasible.filter(meetsHalf);
    if (ok.length === 0) return feasible[Math.floor(feasible.length / 2)];
    return receiverIsLeft ? ok[ok.length - 1] : ok[0];
  }
}

function lowerBoundEntries(entries: LeafEntry[], key: Uint8Array): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareBytes(entries[mid].key, key) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
