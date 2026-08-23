/**
 * tagParser.test.ts - TagParser 标签解析单元测试（跨语言 Javadoc/JSDoc 语法）
 *
 * 覆盖：
 * - @param / @return / @throws / @since / @author / @deprecated 标签
 * - JSDoc {type} 语法
 * - 参数类型提取（Java / TypeScript / C 指针与数组 / 泛型）
 * - 返回类型提取（C++ 指针 / 多 token 类型）
 */

import { parseTagTable } from "../src/parser/TagParser";

/** 便捷构造：解析标签块 */
function tags(rawTags: string, signature = "") {
  return parseTagTable(rawTags, signature);
}

describe("TagParser 标签解析", () => {
  it("解析完整 Javadoc 标签（Java）", () => {
    const result = tags(
      `@param id 用户ID
@return 用户对象
@throws IllegalArgumentException id 为空时抛出
@since 1.1
@author xiaowu
@deprecated 请使用 findById 替代`,
      "User findById(Long id)",
    );

    expect(result.params).toHaveLength(1);
    expect(result.params[0]?.name).toBe("id");
    expect(result.params[0]?.type).toBe("Long");
    expect(result.params[0]?.description).toBe("用户ID");
    expect(result.returns?.type).toBe("User");
    expect(result.returns?.description).toBe("用户对象");
    expect(result.throws[0]?.type).toBe("IllegalArgumentException");
    expect(result.since).toBe("1.1");
    expect(result.author).toBe("xiaowu");
    expect(result.deprecated).toBe("请使用 findById 替代");
  });

  it("支持 JSDoc {type} 语法", () => {
    const result = tags(
      `@param {string} name 名称
@param {Array<number>} items 列表
@returns {Promise<void>} 完成`,
    );
    expect(result.params[0]?.type).toBe("string");
    expect(result.params[1]?.type).toBe("Array<number>");
    expect(result.returns?.type).toBe("Promise<void>");
  });

  it("JSDoc {type} 优先于签名推断", () => {
    const result = tags("@param {string} id 覆盖推断", "User findById(Long id)");
    expect(result.params[0]?.type).toBe("string");
  });

  it("解析 TypeScript 签名参数（name: type 风格）", () => {
    const result = tags(
      "@param name 名称\n@param options 选项",
      "function greet(name: string, options: { verbose: boolean })",
    );
    expect(result.params[0]?.type).toBe("string");
  });

  it("JSDoc 函数类型参数 @param {() => void}", () => {
    const result = tags(
      `@param {() => void} listener 监听回调
@returns {() => void} 取消订阅函数`,
    );
    // listener 为参数名，{() => void} 为参数类型，监听回调为描述
    expect(result.params[0]).toMatchObject({
      name: "listener",
      type: "() => void",
      description: "监听回调",
    });
    expect(result.returns?.type).toBe("() => void");
    expect(result.returns?.description).toBe("取消订阅函数");
  });

  it("@param {*} 通配类型与 @returns {*}", () => {
    const result = tags(
      `@param {*} v 输入值
@returns {*} 原样返回`,
    );
    expect(result.params[0]).toMatchObject({
      name: "v",
      type: "*",
      description: "输入值",
    });
    expect(result.returns?.type).toBe("*");
  });

  it("无类型注解的 JS 函数签名：@returns 不推断为 function", () => {
    const result = tags(
      "@returns 取消订阅函数",
      "function subscribeToAnimChanges(listener)",
    );
    // 签名无显式返回类型（仅 function 关键字），不生成空的返回类型标签
    expect(result.returns).toBeNull();
  });

  it("解构对象参数：点分路径与可选参数", () => {
    const result = tags(
      `@param {Object} props 组件属性
@param {React.RefObject<HTMLElement>} props.containerRef 监听的容器 ref
@param {'vertical'|'horizontal'} [props.orientation='vertical'] 方向`,
    );
    // 点分路径保留完整参数名，{type} 优先于签名推断
    expect(result.params[0]).toMatchObject({
      name: "props",
      type: "Object",
      description: "组件属性",
    });
    expect(result.params[1]).toMatchObject({
      name: "props.containerRef",
      type: "React.RefObject<HTMLElement>",
      description: "监听的容器 ref",
    });
    // 可选参数 [name=default]：去掉方括号与默认值，保留点分路径
    expect(result.params[2]).toMatchObject({
      name: "props.orientation",
      type: "'vertical'|'horizontal'",
      description: "方向",
    });
  });
});

describe("TagParser 参数类型（C 系指针/数组）", () => {
  it("int *ptr → 指针归类型", () => {
    const result = tags("@param ptr 指针", "void foo(int *ptr)");
    expect(result.params[0]?.type).toBe("int *");
    expect(result.params[0]?.name).toBe("ptr");
  });

  it("int* ptr（紧凑写法）", () => {
    const result = tags("@param ptr 指针", "void foo(int* ptr)");
    expect(result.params[0]?.type).toBe("int*");
  });

  it("const char *name", () => {
    const result = tags("@param name 名称", "void foo(const char *name)");
    expect(result.params[0]?.type).toBe("const char *");
  });

  it("unsigned long x（多 token 类型）", () => {
    const result = tags("@param x 值", "void foo(unsigned long x)");
    expect(result.params[0]?.type).toBe("unsigned long");
  });

  it("int arr[]（数组参数）", () => {
    const result = tags("@param arr 数组", "void foo(int arr[])");
    expect(result.params[0]?.type).toBe("int []");
    expect(result.params[0]?.name).toBe("arr");
  });

  it("泛型参数 Map<String, List<Integer>>", () => {
    const result = tags(
      "@param map 映射",
      "void m(Map<String, List<Integer>> map)",
    );
    expect(result.params[0]?.type).toBe("Map<String, List<Integer>>");
  });
});

describe("TagParser 返回类型", () => {
  it("C++ 紧凑指针 int* foo()", () => {
    const result = tags("@return 指针", "int* foo()");
    expect(result.returns?.type).toBe("int*");
  });

  it("C 空格指针 int *foo()", () => {
    const result = tags("@return 指针", "int *foo()");
    expect(result.returns?.type).toBe("int *");
  });

  it("const char *get()", () => {
    const result = tags("@return 字符串", "const char *get()");
    expect(result.returns?.type).toBe("const char *");
  });

  it("void 不生成 @return 标签", () => {
    const result = tags("@return 无", "void foo()");
    expect(result.returns).toBeNull();
  });

  it("泛型 List<String> getItems()", () => {
    const result = tags("@return 列表", "List<String> getItems()");
    expect(result.returns?.type).toBe("List<String>");
  });

  it("修饰符前缀 public static int compute()", () => {
    const result = tags("@return 结果", "public static int compute()");
    expect(result.returns?.type).toBe("int");
  });

  it("泛型方法 <T> T convert()", () => {
    const result = tags("@return 转换", "public <T> T convert()");
    expect(result.returns?.type).toBe("T");
  });
});

describe("SPDX 许可标识 / @license 标签", () => {
  it("SPDX-License-Identifier 行不被并入 @author 描述", () => {
    const result = tags(
      `@author Zhou Chenyu
SPDX-License-Identifier: MIT`,
    );
    expect(result.author).toBe("Zhou Chenyu");
    expect(result.license).toBe("MIT");
  });

  it("SPDX 行独立存在时也能解析", () => {
    const result = tags("SPDX-License-Identifier: Apache-2.0");
    expect(result.license).toBe("Apache-2.0");
    expect(result.author).toBeNull();
  });

  it("支持 @license 标签形式", () => {
    const result = tags("@license MIT");
    expect(result.license).toBe("MIT");
  });

  it("未知 @module 标签不再污染 @description 标签", () => {
    const result = tags(
      `@description 管理活动对象的层级、筛选与运行时状态。
@module kernel/board/active-object-manager
@author Zhou Chenyu`,
    );
    expect(result.description).toBe("管理活动对象的层级、筛选与运行时状态。");
    expect(result.author).toBe("Zhou Chenyu");
  });
});

describe("@property / @prop 标签解析", () => {
  it("@property {type} name - description 解析", () => {
    const result = tags("@property {string} name 用户名称");
    expect(result.properties).toHaveLength(1);
    expect(result.properties[0]).toMatchObject({
      name: "name",
      type: "string",
      description: "用户名称",
    });
  });

  it("@prop 是 @property 的 JSDoc 别名，归入同一 properties 数组", () => {
    const result = tags(
      `@property {string} name 名称
@prop {number} size 大小`,
    );
    expect(result.properties).toHaveLength(2);
    expect(result.properties[0]).toMatchObject({ name: "name", type: "string" });
    expect(result.properties[1]).toMatchObject({ name: "size", type: "number" });
  });
});
