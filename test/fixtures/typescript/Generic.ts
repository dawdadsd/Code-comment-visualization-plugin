/**
 * 泛型仓库
 */
export class Repository<T extends { id: string }> {
  /** 内部存储 */
  private items: Map<string, T> = new Map();

  /** 保存项目 */
  save(item: T): void {
    this.items.set(item.id, item);
  }

  /** 按 ID 查找 */
  findById(id: string): T | undefined {
    return this.items.get(id);
  }
}

/** 用户类型 */
export interface UserType {
  id: string;
  name?: string;
}
