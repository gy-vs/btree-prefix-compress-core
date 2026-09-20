// 页存储抽象与内存实现。页以固定 pageSize 的 Uint8Array 存储。
export interface PageStore {
  readonly pageSize: number;
  read(id: number): Uint8Array;
  write(id: number, page: Uint8Array): void;
  alloc(): number;
  free(id: number): void;
}

export class MemoryPageStore implements PageStore {
  readonly #pages = new Map<number, Uint8Array>();
  readonly #freeIds: number[] = [];
  #next = 1; // 0 预留给初始根叶页

  constructor(readonly pageSize = 4096) {
    if (pageSize < 64) throw new Error('pageSize too small');
  }

  read(id: number): Uint8Array {
    const p = this.#pages.get(id >>> 0);
    if (!p) throw new Error(`page ${id} does not exist`);
    return p;
  }

  write(id: number, page: Uint8Array): void {
    if (page.length !== this.pageSize) {
      throw new Error(`page must be exactly ${this.pageSize} bytes, got ${page.length}`);
    }
    this.#pages.set(id >>> 0, page.slice());
  }

  alloc(): number {
    const reused = this.#freeIds.pop();
    if (reused !== undefined) return reused;
    return this.#next++;
  }

  free(id: number): void {
    const key = id >>> 0;
    // 页号 0 是初始根的保留页号：即使内容已迁走也不回收，
    // 避免树高回落（内部根塌缩回叶）时与新分配页冲突。
    if (key === 0) return;
    if (this.#pages.delete(key)) this.#freeIds.push(key);
  }

  pageCount(): number {
    return this.#pages.size;
  }
}
