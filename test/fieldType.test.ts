/**
 * fieldType.test.ts - 字段类型提取单元测试
 *
 * 覆盖 DocCommentParser 的两条提取链路：
 * - extractFieldType：从源码行文本提取（JS let/const、C 指针、多 token 类型）
 * - cleanFieldTypeDetail：从 LSP symbol.detail 提取（TS 冒号、C++ detail）
 */

import { DocCommentParser } from "../src/parser/DocCommentParser";

const parser = new DocCommentParser();
// 私有方法在测试中经 any 访问（编译后为普通方法）
const parserAny = parser as unknown as {
  extractFieldType: (line: string, symbolName?: string) => string;
  cleanFieldTypeDetail: (detail: string, symbolName: string) => string;
};

describe("extractFieldType（源码行文本）", () => {
  it("JS: let x = 5 不把 let 当类型", () => {
    expect(parserAny.extractFieldType("let x = 5", "x")).toBe("unknown");
  });

  it("JS: const count = 10 不把 const 当类型", () => {
    expect(parserAny.extractFieldType("const count = 10", "count")).toBe(
      "unknown",
    );
  });

  it("JS: const arr = [1, 2] 无类型注解", () => {
    expect(parserAny.extractFieldType("const arr = [1, 2]", "arr")).toBe(
      "unknown",
    );
  });

  it("JS: const _animListeners = new Set() 取构造器名 Set", () => {
    expect(
      parserAny.extractFieldType(
        "const _animListeners = new Set();",
        "_animListeners",
      ),
    ).toBe("Set");
  });

  it("JS: new 构造器带泛型参数保留类型参数", () => {
    expect(
      parserAny.extractFieldType(
        "const m = new Map<string, number>();",
        "m",
      ),
    ).toBe("Map<string, number>");
  });

  it("JS: new 关键字不作为类型泄漏（let x = 5）", () => {
    expect(parserAny.extractFieldType("let x = 5", "x")).toBe("unknown");
  });

  it("TS: let x: number = 5 冒号语法交给 detail 链路", () => {
    expect(parserAny.extractFieldType("let x: number = 5", "x")).toBe(
      "unknown",
    );
  });

  it("C: int *ptr 指针保留", () => {
    expect(parserAny.extractFieldType("int *ptr = 0", "ptr")).toBe("int *");
  });

  it("C: char **pp 双指针保留", () => {
    expect(parserAny.extractFieldType("char **pp = 0", "pp")).toBe("char **");
  });

  it('C: char *name = "x"', () => {
    expect(parserAny.extractFieldType('char *name = "x"', "name")).toBe(
      "char *",
    );
  });

  it("C: unsigned int count 多 token 类型", () => {
    expect(parserAny.extractFieldType("unsigned int count = 0", "count")).toBe(
      "unsigned int",
    );
  });

  it("C: int arr[10] 数组（[ 视为分隔符）", () => {
    expect(parserAny.extractFieldType("int arr[10]", "arr")).toBe("int");
  });

  it("泛型 List<string> names = []", () => {
    expect(parserAny.extractFieldType("List<string> names = []", "names")).toBe(
      "List<string>",
    );
  });

  it("无初始化器 int x", () => {
    expect(parserAny.extractFieldType("int x", "x")).toBe("int");
  });

  it("C: int *a, b 指针变量 a 的类型带指针", () => {
    expect(parserAny.extractFieldType("int *a, b", "a")).toBe("int *");
  });

  it("C: int *a, b 普通变量 b 的类型不带指针", () => {
    expect(parserAny.extractFieldType("int *a, b", "b")).toBe("int");
  });

  it("C: const int *p, q 指针变量 p 保留 const 与指针", () => {
    expect(parserAny.extractFieldType("const int *p, q", "p")).toBe(
      "const int *",
    );
  });

  it("C: const int *p, q 普通变量 q 保留 const 修饰", () => {
    expect(parserAny.extractFieldType("const int *p, q", "q")).toBe("const int");
  });

  it("C++: int &ref, value 引用变量 ref 保留引用符", () => {
    expect(parserAny.extractFieldType("int &ref, value", "ref")).toBe("int &");
  });

  it("C++: int &ref, value 普通变量 value 不带引用符", () => {
    expect(parserAny.extractFieldType("int &ref, value", "value")).toBe("int");
  });
});

describe("cleanFieldTypeDetail（LSP detail）", () => {
  it("JS: let x 无类型返回空", () => {
    expect(parserAny.cleanFieldTypeDetail("let x", "x")).toBe("");
  });

  it("TS: const x: number 冒号语法", () => {
    expect(parserAny.cleanFieldTypeDetail("const x: number", "x")).toBe(
      "number",
    );
  });

  it("JS: const arr = [1, 2] 无类型返回空", () => {
    expect(parserAny.cleanFieldTypeDetail("const arr = [1, 2]", "arr")).toBe("");
  });

  it("C++: num S 去掉变量名", () => {
    expect(parserAny.cleanFieldTypeDetail("num S", "S")).toBe("num");
  });

  it("C: char *x 指针保留", () => {
    expect(parserAny.cleanFieldTypeDetail("char *x", "x")).toBe("char *");
  });

  it("纯类型 detail", () => {
    expect(parserAny.cleanFieldTypeDetail("int", "x")).toBe("int");
  });
});
