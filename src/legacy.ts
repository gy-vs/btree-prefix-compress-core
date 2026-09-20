// 旧的内存数组实现（保留向后兼容，非分页、无压缩）
export class BTree<V> {
  #entries: { key: string; value: V }[] = [];

  insert(key: string, value: V): void {
    const at = this.#entries.findIndex((item) => item.key >= key);
    this.#entries.splice(at < 0 ? this.#entries.length : at, 0, { key, value });
  }

  get(key: string): V | undefined {
    return this.#entries.find((item) => item.key === key)?.value;
  }

  delete(key: string): void {
    const at = this.#entries.findIndex((item) => item.key === key);
    if (at >= 0) this.#entries.splice(at, 1);
  }

  range(start: string, end: string): { key: string; value: V }[] {
    return this.#entries
      .filter((item) => item.key >= start && item.key <= end)
      .map((item) => ({ ...item }));
  }

  size(): number {
    return this.#entries.length;
  }
}
