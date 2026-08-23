/**
 * 用户实体
 */
export class User {
  /** 用户ID */
  private id: number;

  /** 用户名 */
  public name = "guest";

  constructor(id: number) {
    this.id = id;
  }

  /** 获取 ID */
  getId(): number {
    return this.id;
  }

  /** 创建用户 */
  static create(name: string): User {
    return new User(0);
  }
}

/** 性别枚举 */
export enum Gender {
  MALE = "M",
  FEMALE = "F",
}

/** 用户接口 */
export interface IUser {
  /** 接口 ID */
  id: number;

  /** 获取名称 */
  getName(): string;
}

/** 创建用户工厂 */
export const createUser = (id: number): User => new User(id);
