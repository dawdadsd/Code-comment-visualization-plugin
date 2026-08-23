/**
 * 带值枚举
 */
export enum Status {
  /** 活跃 */
  ACTIVE = 1,
  /** 停用 */
  DISABLED = 0,
}

/**
 * 用户标识类型
 */
export type UserId = string;

/**
 * 抽象仓库
 */
export abstract class AbstractRepository<T> {
  /** 缓存 */
  protected cache = new Map<string, T>();

  /** 抽象查找 */
  abstract findById(id: string): T | undefined;

  /** 缓存大小 */
  get size(): number {
    return this.cache.size;
  }

  /** 重置缓存 */
  set size(n: number) {
    console.log(n);
  }
}

/**
 * 工具命名空间
 */
export namespace Helpers {
  /** 格式化函数 */
  export function format(s: string): string {
    return s;
  }
}
