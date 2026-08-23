/**
 * parser.test.ts - 跨语言源码片段解析测试（fixture 驱动）
 *
 * 结构：test/fixtures/<language>/<file>
 * 每个文件是一个独立语言的源码片段，测试用对应的 languageId 调用
 * DocCommentParser.parse()，断言 typeGroups / methods / fields /
 * enumConstants 的结构与注释。
 *
 * 环境说明：
 * - vscode mock 的 executeDocumentSymbolProvider 返回 []（模拟无 Language
 *   Server），解析走 tree-sitter AST 兜底链路，同时验证 AST 成员提取。
 * - 成员列表按源码行号排序，与侧边栏展示顺序一致。
 * - 超时 / 日志静音等全局设置在 jest.config.js 与 test/setup.ts 中统一配置。
 */

import { parseFixture, parseText, names } from "./helpers";

describe("Java (fixtures/java/UserService.java)", () => {
  it("类型组：UserService + 内部类 UserHelper", async () => {
    const doc = await parseFixture("java", "UserService.java");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "UserService",
      "UserService.UserHelper",
    ]);
    // 类注释位于文件开头，被识别为文件头（去重后类型卡片不重复展示），
    // 文件级注释 classComment 保留描述
    expect(doc.classComment).toContain("用户服务类");
    expect(doc.typeGroups[1]?.comment).toContain("用户助手类");
  });

  it("字段与方法按源码顺序", async () => {
    const doc = await parseFixture("java", "UserService.java");
    expect(names(doc.fields)).toEqual(["cache"]);
    expect(names(doc.methods)).toEqual(["findById", "save", "buildName"]);
  });

  it("findById：@param/@return/@throws 标签解析", async () => {
    const doc = await parseFixture("java", "UserService.java");
    const m = doc.methods.find((x) => x.name === "findById");
    expect(m?.hasComment).toBe(true);
    expect(m?.description).toContain("根据 ID 查询用户");
    expect(m?.tags.params).toHaveLength(1);
    expect(m?.tags.params[0]).toMatchObject({
      name: "id",
      type: "Long",
      description: "用户ID",
    });
    expect(m?.tags.returns?.description).toContain("用户对象");
    expect(m?.tags.throws[0]?.type).toBe("IllegalArgumentException");
  });

  it("内部类方法归属 UserService.UserHelper", async () => {
    const doc = await parseFixture("java", "UserService.java");
    const m = doc.methods.find((x) => x.name === "buildName");
    expect(m?.belongsTo).toBe("UserService.UserHelper");
    expect(m?.hasComment).toBe(true);
  });

  it("接口常量提取为字段并解析类型", async () => {
    const doc = await parseText(
      "java",
      "Iface.java",
      `/** 接口 */
public interface IUser {
    /** 最大数量 */
    int MAX_COUNT = 10;
}
`,
    );
    expect(doc.fields[0]?.name).toBe("MAX_COUNT");
    expect(doc.fields[0]?.type).toBe("int");
  });
});

describe("TypeScript (fixtures/typescript/User.ts)", () => {
  it("类型组：User / Gender / IUser", async () => {
    const doc = await parseFixture("typescript", "User.ts");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "User",
      "Gender",
      "IUser",
    ]);
  });

  it("类 User：字段与方法注释", async () => {
    const doc = await parseFixture("typescript", "User.ts");
    expect(names(doc.fields)).toEqual(["id", "name", "id"]);
    const getId = doc.methods.find((m) => m.name === "getId");
    expect(getId?.hasComment).toBe(true);
    expect(getId?.description).toContain("获取 ID");
    expect(getId?.returnType).toBe("number");
  });

  it("枚举：MALE / FEMALE 提取为枚举常量", async () => {
    const doc = await parseFixture("typescript", "User.ts");
    expect(names(doc.enumConstants)).toEqual(["MALE", "FEMALE"]);
  });

  it("顶层箭头函数识别为方法", async () => {
    const doc = await parseFixture("typescript", "User.ts");
    const createUser = doc.methods.find((m) => m.name === "createUser");
    expect(createUser).toBeDefined();
    expect(createUser?.hasComment).toBe(true);
    expect(createUser?.description).toContain("创建用户工厂");
  });

  it("接口字段类型：简单与含冒号的嵌套类型", async () => {
    const doc = await parseText(
      "typescript",
      "iface.ts",
      `/** 接口 */
export interface IUser {
  /** ID */
  id: number;
  /** 配置 */
  config: { a: number; b: string };
  /** 映射 */
  map: Map<string, number>;
  /** 回调 */
  cb: (x: number) => void;
}
`,
    );
    const byName = (n: string) => doc.fields.find((f) => f.name === n);
    expect(byName("id")?.type).toBe("number");
    expect(byName("config")?.type).toBe("{ a: number; b: string }");
    expect(byName("map")?.type).toBe("Map<string, number>");
    expect(byName("cb")?.type).toBe("(x: number) => void");
  });

  it("抽象类抽象属性提取为字段并解析类型", async () => {
    const doc = await parseText(
      "typescript",
      "abstract.ts",
      `export abstract class Base {
  /** 抽象 ID */
  abstract id: number;
  /** 普通字段 */
  name: string;
}
`,
    );
    const byName = (n: string) => doc.fields.find((f) => f.name === n);
    expect(byName("id")?.type).toBe("number");
    expect(byName("name")?.type).toBe("string");
  });
});

describe("JavaScript (fixtures/javascript/Utils.js)", () => {
  it("类 Utils：静态字段与方法", async () => {
    const doc = await parseFixture("javascript", "Utils.js");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Utils"]);
    expect(names(doc.fields)).toEqual(["count"]);
    // Utils 是构造函数（按 LSP 约定以类名命名）
    expect(names(doc.methods)).toEqual(["Utils", "increment", "decrement", "sum"]);
    expect(doc.methods[0]?.kind).toBe("constructor");
    const increment = doc.methods.find((m) => m.name === "increment");
    expect(increment?.hasComment).toBe(true);
    expect(increment?.description).toContain("增加计数");
  });
});

describe("C (fixtures/c/Shape.c)", () => {
  it("结构体 Shape：字段与方法", async () => {
    const doc = await parseFixture("c", "Shape.c");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Shape"]);
    expect(names(doc.fields)).toEqual(["width", "height"]);
    expect(names(doc.methods)).toEqual(["area"]);
    expect(doc.methods[0]?.hasComment).toBe(true);
  });
});

describe("Python (fixtures/python/Calculator.py)", () => {
  it("类 Calculator：方法与注解字段", async () => {
    const doc = await parseFixture("python", "Calculator.py");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Calculator"]);
    expect(names(doc.methods)).toEqual(["add", "sub"]);
    expect(names(doc.fields)).toEqual(["count"]);
  });
});

describe("Go (fixtures/go/Order.go)", () => {
  it("结构体 Order：字段与方法（// 行注释作为文档）", async () => {
    const doc = await parseFixture("go", "Order.go");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Order"]);
    expect(names(doc.fields)).toEqual(["ID", "Amount"]);
    expect(names(doc.methods)).toEqual(["NewOrder", "Total"]);
    const newOrder = doc.methods.find((m) => m.name === "NewOrder");
    expect(newOrder?.hasComment).toBe(true);
    expect(newOrder?.description).toContain("创建订单");
  });
});

describe("Rust (fixtures/rust/Parser.rs)", () => {
  it("结构体 Parser：字段与方法（/// 行注释作为文档）", async () => {
    const doc = await parseFixture("rust", "Parser.rs");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Parser"]);
    expect(names(doc.fields)).toEqual(["line"]);
    expect(names(doc.methods)).toEqual(["new", "advance"]);
    expect(doc.methods[0]?.description).toContain("创建解析器");
  });
});

// ========== 扩展语言：更多文件类型与语法情形 ==========

describe("C++ (fixtures/cpp/Shape.cpp)", () => {
  it("类 Shape + 枚举 Color：字段/方法/枚举成员", async () => {
    const doc = await parseFixture("cpp", "Shape.cpp");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Shape", "Color"]);
    expect(names(doc.fields)).toEqual(["width", "height"]);
    // C++ grammar 将构造函数/析构函数统一表示为 function_definition，
    // 构造函数与析构函数均以类名 Shape 命名
    expect(names(doc.methods)).toEqual(["Shape", "area", "Shape"]);
    expect(names(doc.enumConstants)).toEqual(["RED", "GREEN", "BLUE"]);
  });

  it("构造函数与 area 方法注释提取", async () => {
    const doc = await parseFixture("cpp", "Shape.cpp");
    const area = doc.methods.find((m) => m.name === "area");
    expect(area?.hasComment).toBe(true);
    expect(area?.description).toContain("计算面积");
    const ctor = doc.methods[0];
    expect(ctor?.hasComment).toBe(true);
    expect(ctor?.description).toContain("构造函数");
  });
});

describe("C# (fixtures/csharp/User.cs)", () => {
  it("类 User + 接口 IUser + 枚举 UserType", async () => {
    const doc = await parseFixture("csharp", "User.cs");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "User",
      "IUser",
      "UserType",
    ]);
    expect(names(doc.methods)).toEqual(["User", "GetId", "GetName"]);
    expect(doc.methods[0]?.kind).toBe("constructor");
    expect(names(doc.fields)).toEqual(["Id", "Name"]);
    expect(names(doc.enumConstants)).toEqual(["ADMIN", "NORMAL"]);
  });

  it("属性 Name 与 GetId 方法注释", async () => {
    const doc = await parseFixture("csharp", "User.cs");
    const nameField = doc.fields.find((f) => f.name === "Name");
    expect(nameField?.hasComment).toBe(true);
    expect(nameField?.description).toContain("用户名");
    expect(nameField?.type).toBe("string");
    const getter = doc.methods.find((m) => m.name === "GetId");
    expect(getter?.hasComment).toBe(true);
    expect(getter?.description).toContain("获取 ID");
  });
});

describe("TypeScript React (fixtures/typescriptreact/Component.tsx)", () => {
  it("接口 IProps + 类 Button + 顶层箭头函数 App", async () => {
    const doc = await parseFixture("typescriptreact", "Component.tsx");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["IProps", "Button"]);
    // interface 方法签名 onClick + 类方法 render + 顶层箭头函数 App
    expect(names(doc.methods)).toEqual(["onClick", "render", "App"]);
    // interface 属性 title + 静态字段 displayName
    expect(names(doc.fields)).toEqual(["title", "displayName"]);
  });

  it("箭头函数组件 App 的注释", async () => {
    const doc = await parseFixture("typescriptreact", "Component.tsx");
    const app = doc.methods.find((m) => m.name === "App");
    expect(app?.hasComment).toBe(true);
    expect(app?.description).toContain("纯函数组件");
  });
});

describe("JavaScript React (fixtures/javascriptreact/App.jsx)", () => {
  it("类 App + 顶层函数组件 Header", async () => {
    const doc = await parseFixture("javascriptreact", "App.jsx");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["App"]);
    expect(names(doc.methods)).toEqual(["increment", "decrement", "Header"]);
    expect(names(doc.fields)).toEqual(["state"]);
  });

  it("类方法 increment 注释", async () => {
    const doc = await parseFixture("javascriptreact", "App.jsx");
    const inc = doc.methods.find((m) => m.name === "increment");
    expect(inc?.hasComment).toBe(true);
    expect(inc?.description).toContain("增加计数");
  });
});

describe("PHP (fixtures/php/User.php)", () => {
  it("类 User + 接口 IUser + 枚举 Role", async () => {
    const doc = await parseFixture("php", "User.php");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "User",
      "IUser",
      "Role",
    ]);
    expect(names(doc.methods)).toEqual(["__construct", "getId", "getName"]);
    expect(names(doc.fields)).toEqual(["$id"]);
    expect(names(doc.enumConstants)).toEqual(["ADMIN", "USER"]);
  });

  it("字段 $id 与方法 getId 注释", async () => {
    const doc = await parseFixture("php", "User.php");
    const idField = doc.fields[0];
    expect(idField?.hasComment).toBe(true);
    expect(idField?.description).toContain("用户ID");
    const getter = doc.methods.find((m) => m.name === "getId");
    expect(getter?.hasComment).toBe(true);
    expect(getter?.description).toContain("获取 ID");
  });
});

describe("Kotlin (fixtures/kotlin/User.kt)", () => {
  it("类 User + 接口 IUser + 枚举 Role", async () => {
    const doc = await parseFixture("kotlin", "User.kt");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "User",
      "IUser",
      "Role",
    ]);
    expect(names(doc.methods)).toEqual(["User", "getId", "empty", "getName"]);
    expect(doc.methods[0]?.kind).toBe("constructor");
    // type_identifier 降级修复：字段名为 name 而非类型 String
    expect(names(doc.fields)).toEqual(["name"]);
    expect(names(doc.enumConstants)).toEqual(["ADMIN", "USER"]);
  });

  it("companion object 方法 empty 与字段注释", async () => {
    const doc = await parseFixture("kotlin", "User.kt");
    const empty = doc.methods.find((m) => m.name === "empty");
    expect(empty?.hasComment).toBe(true);
    expect(empty?.description).toContain("创建空用户");
    expect(doc.fields[0]?.description).toContain("用户名");
  });

  it("接口属性提取为字段并解析类型", async () => {
    const doc = await parseText(
      "kotlin",
      "Iface.kt",
      `interface IUser {
    /** ID */
    val id: Int
}
`,
    );
    expect(doc.fields[0]?.name).toBe("id");
    expect(doc.fields[0]?.type).toBe("Int");
  });
});

describe("Swift (fixtures/swift/User.swift)", () => {
  it("类 User + 协议 Describable + 枚举 Color", async () => {
    const doc = await parseFixture("swift", "User.swift");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "User",
      "Describable",
      "Color",
    ]);
    expect(names(doc.methods)).toEqual(["User", "description", "describe"]);
    expect(doc.methods[0]?.kind).toBe("constructor");
    expect(names(doc.fields)).toEqual(["id", "name"]);
    expect(names(doc.enumConstants)).toEqual(["red", "green"]);
  });

  it("init 构造器与 description 方法注释", async () => {
    const doc = await parseFixture("swift", "User.swift");
    const desc = doc.methods.find((m) => m.name === "description");
    expect(desc?.hasComment).toBe(true);
    expect(desc?.description).toContain("获取描述");
  });
});

describe("Scala (fixtures/scala/User.scala)", () => {
  it("类 User + 特质 IUser + 对象 UserFactory", async () => {
    const doc = await parseFixture("scala", "User.scala");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "User",
      "IUser",
      "UserFactory",
    ]);
    expect(names(doc.methods)).toEqual(["getId", "create"]);
    expect(names(doc.fields)).toEqual(["name"]);
  });

  it("工厂方法 create 注释", async () => {
    const doc = await parseFixture("scala", "User.scala");
    const create = doc.methods.find((m) => m.name === "create");
    expect(create?.hasComment).toBe(true);
    expect(create?.description).toContain("创建用户");
  });
});

describe("Objective-C (fixtures/objective-c/User.h)", () => {
  it("@protocol IUser + @interface User", async () => {
    const doc = await parseFixture("objective-c", "User.h");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["IUser", "User"]);
    expect(names(doc.methods)).toEqual(["getName", "getUserId"]);
    expect(names(doc.fields)).toEqual(["userId"]);
  });

  it("方法 getUserId 与属性 userId 注释", async () => {
    const doc = await parseFixture("objective-c", "User.h");
    const getter = doc.methods.find((m) => m.name === "getUserId");
    expect(getter?.hasComment).toBe(true);
    expect(getter?.description).toContain("获取 ID");
    expect(doc.fields[0]?.description).toContain("用户ID");
  });
});

describe("Ruby (fixtures/ruby/user.rb)", () => {
  it("已知限制：tree-sitter-ruby grammar 与 web-tree-sitter 0.20.8 不兼容", async () => {
    // grammar 解析抛错被 parse 内部捕获，返回空结构而非崩溃；
    // 该 console.error 是预期错误，局部静音避免污染全量输出
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const doc = await parseFixture("ruby", "user.rb");
      expect(doc.typeGroups).toHaveLength(0);
      expect(doc.methods).toHaveLength(0);
      expect(doc.fields).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ========== 既有语言补充情形 ==========

describe("Java 带值枚举 (fixtures/java/OrderStatus.java)", () => {
  it("带构造参数枚举 + getter 方法", async () => {
    const doc = await parseFixture("java", "OrderStatus.java");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["OrderStatus"]);
    expect(names(doc.methods)).toEqual(["OrderStatus", "getCode"]);
    expect(doc.methods[0]?.kind).toBe("constructor");
    expect(names(doc.fields)).toEqual(["code", "value"]);
    expect(names(doc.enumConstants)).toEqual(["PENDING", "PAID", "CANCELLED"]);
  });

  it("枚举常量 PENDING 注释与归属", async () => {
    const doc = await parseFixture("java", "OrderStatus.java");
    const pending = doc.enumConstants.find((e) => e.name === "PENDING");
    expect(pending?.hasComment).toBe(true);
    expect(pending?.description).toContain("待支付");
    expect(pending?.belongsTo).toBe("OrderStatus");
  });
});

describe("TypeScript 泛型 (fixtures/typescript/Generic.ts)", () => {
  it("泛型约束不泄漏为字段（type_parameters 跳过）", async () => {
    const doc = await parseFixture("typescript", "Generic.ts");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "Repository",
      "UserType",
    ]);
    expect(names(doc.methods)).toEqual(["save", "findById"]);
    // items 属于 Repository；id/name 属于 UserType 接口
    expect(names(doc.fields)).toEqual(["items", "id", "name"]);
  });

  it("泛型方法 save 注释", async () => {
    const doc = await parseFixture("typescript", "Generic.ts");
    const save = doc.methods.find((m) => m.name === "save");
    expect(save?.hasComment).toBe(true);
    expect(save?.description).toContain("保存项目");
  });
});

describe("C 枚举 + 联合 (fixtures/c/Color.c)", () => {
  it("枚举 Color 与联合 Value", async () => {
    const doc = await parseFixture("c", "Color.c");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Color", "Value"]);
    expect(names(doc.enumConstants)).toEqual(["RED", "GREEN", "BLUE"]);
    expect(names(doc.fields)).toEqual(["i", "f"]);
    expect(doc.typeGroups[1]?.comment).toContain("联合体");
  });
});

describe("Python 继承 (fixtures/python/shapes.py)", () => {
  it("类 Shape 与子类 Circle：方法重写 + 注解字段", async () => {
    const doc = await parseFixture("python", "shapes.py");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Shape", "Circle"]);
    expect(names(doc.methods)).toEqual(["area", "area"]);
    expect(names(doc.fields)).toEqual(["radius"]);
  });

  it("已知限制：docstring 位于类/函数体内，插件不识别为注释", async () => {
    // Python 文档字符串是声明后的第一个表达式（类体/函数体内），
    // 而插件按「声明上方注释」向上搜索，故 hasComment 为 false。
    // 与 Calculator.py（python/fixtures 既有 fixture）行为一致。
    const doc = await parseFixture("python", "shapes.py");
    expect(doc.methods.every((m) => !m.hasComment)).toBe(true);
    expect(doc.typeGroups.every((g) => !g.comment)).toBe(true);
  });
});

describe("Go 接口 (fixtures/go/api.go)", () => {
  it("接口 Reader 与结构体 FileReader 实现方法", async () => {
    const doc = await parseFixture("go", "api.go");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "Reader",
      "FileReader",
    ]);
    expect(names(doc.methods)).toEqual(["Read"]);
    expect(names(doc.fields)).toEqual(["Path"]);
    const read = doc.methods[0];
    expect(read?.hasComment).toBe(true);
    expect(read?.description).toContain("读取文件内容");
  });
});

describe("Rust 枚举 payload + impl (fixtures/rust/linked.rs)", () => {
  it("带数据枚举 Node 与泛型实现 LinkedList", async () => {
    const doc = await parseFixture("rust", "linked.rs");
    // Node / LinkedList 为类型声明，第三个 LinkedList 为 impl 块（无注释）
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "Node",
      "LinkedList",
      "LinkedList",
    ]);
    expect(names(doc.enumConstants)).toEqual(["Nil", "Cons"]);
    expect(names(doc.fields)).toEqual(["head"]);
    expect(names(doc.methods)).toEqual(["new"]);
    const newMethod = doc.methods[0];
    expect(newMethod?.hasComment).toBe(true);
    expect(newMethod?.description).toContain("创建空链表");
  });
});

// ========== 进阶语法情形：泛型 / 抽象类 / record / trait / 装饰器 ==========

describe("Java 进阶 (fixtures/java/Advanced.java)", () => {
  it("record / 泛型类 / 接口默认方法 / 可变参数", async () => {
    const doc = await parseFixture("java", "Advanced.java");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "Point",
      "Box",
      "Processor",
    ]);
    expect(names(doc.methods)).toEqual([
      "distance",
      "setValue",
      "getValue",
      "sum",
      "process",
    ]);
    expect(names(doc.fields)).toEqual(["value"]);
  });

  it("record 方法 distance 与可变参数 sum 注释", async () => {
    const doc = await parseFixture("java", "Advanced.java");
    const distance = doc.methods.find((m) => m.name === "distance");
    expect(distance?.hasComment).toBe(true);
    expect(distance?.description).toContain("计算距离");
    const sum = doc.methods.find((m) => m.name === "sum");
    expect(sum?.hasComment).toBe(true);
    expect(sum?.description).toContain("可变参数求和");
    // 接口默认方法 process 也被提取
    expect(doc.methods.some((m) => m.name === "process" && m.hasComment)).toBe(
      true,
    );
  });
});

describe("TypeScript 进阶 (fixtures/typescript/Advanced.ts)", () => {
  it("带值枚举 / 抽象类 getter-setter / namespace", async () => {
    const doc = await parseFixture("typescript", "Advanced.ts");
    // type alias UserId 与 namespace Helpers 不生成类型卡片（非类/接口/枚举）
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "Status",
      "AbstractRepository",
    ]);
    // 抽象方法 findById + getter/setter（同名 size）+ namespace 内 format
    expect(names(doc.methods)).toEqual(["findById", "size", "size", "format"]);
    expect(names(doc.fields)).toEqual(["cache"]);
    expect(names(doc.enumConstants)).toEqual(["ACTIVE", "DISABLED"]);
  });

  it("抽象方法 findById 与枚举注释", async () => {
    const doc = await parseFixture("typescript", "Advanced.ts");
    const findById = doc.methods.find((m) => m.name === "findById");
    expect(findById?.hasComment).toBe(true);
    expect(findById?.description).toContain("抽象查找");
    const active = doc.enumConstants.find((e) => e.name === "ACTIVE");
    expect(active?.hasComment).toBe(true);
    expect(active?.description).toContain("活跃");
  });
});

describe("Python 进阶 (fixtures/python/Advanced.py)", () => {
  it("classmethod / staticmethod / property / async 方法提取", async () => {
    const doc = await parseFixture("python", "Advanced.py");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Mixin", "Counter"]);
    expect(names(doc.methods)).toEqual([
      "extra",
      "create",
      "clamp",
      "count",
      "fetch",
    ]);
    expect(names(doc.fields)).toEqual(["_count"]);
  });
});

describe("Go 进阶 (fixtures/go/Advanced.go)", () => {
  it("泛型栈与嵌入结构体", async () => {
    const doc = await parseFixture("go", "Advanced.go");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "Stack",
      "Base",
      "Derived",
    ]);
    expect(names(doc.methods)).toEqual(["Push", "Pop"]);
    // Base 为嵌入结构体字段（字段名即类型名）
    expect(names(doc.fields)).toEqual(["items", "Name", "Base", "Lookup"]);
    const push = doc.methods.find((m) => m.name === "Push");
    expect(push?.hasComment).toBe(true);
    expect(push?.description).toContain("入栈");
  });
});

describe("Rust 进阶 (fixtures/rust/Advanced.rs)", () => {
  it("trait 声明与 impl 实现的方法分别提取", async () => {
    const doc = await parseFixture("rust", "Advanced.rs");
    // trait / struct / impl trait 块 / struct / impl 块
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "Shape",
      "Circle",
      "Shape",
      "Container",
      "Container",
    ]);
    // trait 内签名 area + impl 内实现 area + impl 方法 get
    expect(names(doc.methods)).toEqual(["area", "area", "get"]);
    expect(names(doc.fields)).toEqual(["radius", "value"]);
  });

  it("trait 方法签名与 impl 实现的注释", async () => {
    const doc = await parseFixture("rust", "Advanced.rs");
    const [traitArea, implArea] = doc.methods;
    expect(traitArea?.hasComment).toBe(true);
    expect(traitArea?.description).toContain("计算面积");
    expect(implArea?.description).toContain("面积实现");
  });
});

describe("Kotlin 进阶 (fixtures/kotlin/Advanced.kt)", () => {
  it("data class 主构造 / 泛型类 / 扩展函数", async () => {
    const doc = await parseFixture("kotlin", "Advanced.kt");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["UserInfo", "Repo"]);
    expect(names(doc.methods)).toEqual(["UserInfo", "save", "shout"]);
    expect(doc.methods[0]?.kind).toBe("constructor");
    // data class 主构造参数不生成字段；lateinit items 提取为字段
    expect(names(doc.fields)).toEqual(["items"]);
  });

  it("扩展函数 shout 注释", async () => {
    const doc = await parseFixture("kotlin", "Advanced.kt");
    const shout = doc.methods.find((m) => m.name === "shout");
    expect(shout?.hasComment).toBe(true);
    expect(shout?.description).toContain("字符串扩展");
  });
});

describe("C++ 进阶 (fixtures/cpp/Advanced.cpp)", () => {
  it("模板类 / 纯虚函数 / 静态字段", async () => {
    const doc = await parseFixture("cpp", "Advanced.cpp");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Stack", "IShape"]);
    expect(names(doc.methods)).toEqual(["push", "pop"]);
    // 纯虚函数 area 被 C++ grammar 解析为 field_declaration（带 = 0 初始化器），
    // 故出现在字段列表——已知的 grammar 行为
    expect(names(doc.fields)).toEqual(["count", "data", "area"]);
    const push = doc.methods.find((m) => m.name === "push");
    expect(push?.hasComment).toBe(true);
    expect(push?.description).toContain("入栈");
  });
});

describe("C++ Rebirth (fixtures/cpp/Rebirth.cpp)", () => {
  it("类型组：模板与普通结构体", async () => {
    const doc = await parseFixture("cpp", "Rebirth.cpp");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "SegTree",
      "ModPrime",
      "rebirth_seg",
      "rebirth_tag",
    ]);
  });

  it("同一行声明多个变量：size_t l, r, mid; 与 num MUL, ADD; 全部提取", async () => {
    const doc = await parseFixture("cpp", "Rebirth.cpp");
    expect(names(doc.fields)).toEqual([
      "seg",
      "tag",
      "l",
      "r",
      "mid",
      "ls",
      "rs",
      "val",
      "S",
      "L",
      "LSS",
      "RSS",
      "LSSS",
      "RSSS",
      "SS",
      "SSS",
      "pa",
      "pb",
      "cpa",
      "cpb",
      "iref",
      "ival",
      "pp1",
      "pp2",
      "MUL",
      "ADD",
    ]);
    const typeOf = (name: string) =>
      doc.fields.find((f) => f.name === name)?.type;
    expect(typeOf("l")).toBe("size_t");
    expect(typeOf("r")).toBe("size_t");
    expect(typeOf("mid")).toBe("size_t");
    expect(typeOf("MUL")).toBe("num");
    expect(typeOf("ADD")).toBe("num");
  });

  it("指针与非指针同语句声明：int *pa, pb; 类型精确归属", async () => {
    const doc = await parseFixture("cpp", "Rebirth.cpp");
    const typeOf = (name: string) =>
      doc.fields.find((f) => f.name === name)?.type;
    expect(typeOf("pa")).toBe("int *");
    expect(typeOf("pb")).toBe("int");
  });

  it("const 修饰混合声明：const int *cpa, cpb; 修饰符保留", async () => {
    const doc = await parseFixture("cpp", "Rebirth.cpp");
    const typeOf = (name: string) =>
      doc.fields.find((f) => f.name === name)?.type;
    expect(typeOf("cpa")).toBe("const int *");
    expect(typeOf("cpb")).toBe("const int");
  });

  it("引用混合声明：int &iref, ival; 引用符保留", async () => {
    const doc = await parseFixture("cpp", "Rebirth.cpp");
    const typeOf = (name: string) =>
      doc.fields.find((f) => f.name === name)?.type;
    expect(typeOf("iref")).toBe("int &");
    expect(typeOf("ival")).toBe("int");
  });

  it("双指针混合声明：int *pp1, *pp2; 各自保留指针", async () => {
    const doc = await parseFixture("cpp", "Rebirth.cpp");
    const typeOf = (name: string) =>
      doc.fields.find((f) => f.name === name)?.type;
    expect(typeOf("pp1")).toBe("int *");
    expect(typeOf("pp2")).toBe("int *");
  });

  it("同行多语句声明（Seg seg; Tag tag;）类型归属正确", async () => {
    const doc = await parseFixture("cpp", "Rebirth.cpp");
    const seg = doc.fields.find((f) => f.name === "seg");
    const tag = doc.fields.find((f) => f.name === "tag");
    expect(seg?.type).toBe("Seg");
    expect(tag?.type).toBe("Tag");
  });

  it("裸指针：SegTree *ls, *rs; 类型保留指针", async () => {
    const doc = await parseFixture("cpp", "Rebirth.cpp");
    const ls = doc.fields.find((f) => f.name === "ls");
    const rs = doc.fields.find((f) => f.name === "rs");
    expect(ls?.type).toBe("SegTree *");
    expect(rs?.type).toBe("SegTree *");
  });

  it("构造函数：识别为 constructor（初始化列表 / 默认参数）", async () => {
    const doc = await parseFixture("cpp", "Rebirth.cpp");
    const ctors = doc.methods.filter((m) => m.kind === "constructor");
    expect(names(ctors)).toEqual(["SegTree", "ModPrime", "rebirth_tag"]);
    expect(ctors[0]?.params).toContain("const function<Seg, size_t> &c");
    expect(ctors[1]?.params).toBe("long long v = 0");
  });

  it("重载运算符：成员 4 个 + 全局模板 8 个均识别为 operator 名称", async () => {
    const doc = await parseFixture("cpp", "Rebirth.cpp");
    const ops = doc.methods.filter((m) => m.name.startsWith("operator"));
    expect(ops).toHaveLength(12);
    expect(names(ops)).toEqual([
      "operator+",
      "operator-",
      "operator*",
      "operator/",
      "operator+",
      "operator-",
      "operator*",
      "operator/",
      "operator+",
      "operator-",
      "operator*",
      "operator/",
    ]);
    // 成员运算符返回自身类型
    expect(ops[0]?.returnType).toBe("ModPrime");
    // 全局模板运算符：参数为 lhs/rhs，名称仍为 operator 前缀（不再误取参数名）
    expect(ops[4]?.params).toContain("lhs");
    expect(ops[4]?.returnType).toBe("ModPrime<prime>");
  });

  it("函数修饰：constexpr / const / static 保留在签名与返回类型中", async () => {
    const doc = await parseFixture("cpp", "Rebirth.cpp");
    const release = doc.methods.find((m) => m.name === "release");
    const query = doc.methods.find((m) => m.name === "query");
    const mod = doc.methods.find((m) => m.name === "mod");
    const inverse = doc.methods.find((m) => m.name === "inverse");
    expect(release?.signature).toMatch(/^constexpr void release\(\)/);
    expect(query?.signature).toMatch(
      /^Seg query\(size_t s, size_t e, const Tag &t\) const/,
    );
    expect(mod?.signature).toMatch(/^static constexpr long long mod\(\)/);
    expect(inverse?.signature).toMatch(
      /^constexpr ModPrime inverse\(\) const/,
    );
    expect(mod?.returnType).toBe("long long");
    expect(query?.returnType).toBe("Seg");
  });

  it("多行 Javadoc 注释提取（merge / apply）与源码顺序", async () => {
    const doc = await parseFixture("cpp", "Rebirth.cpp");
    const merge1 = doc.methods.find((m) => m.name === "merge");
    expect(merge1?.hasComment).toBe(true);
    expect(merge1?.description).toContain("Merges two segments");
    const apply = doc.methods.find((m) => m.name === "apply");
    expect(apply?.hasComment).toBe(true);
    expect(apply?.description).toContain("Applies a tag");
    // 方法按源码行号排序：首为 SegTree 构造函数，末为 main
    expect(doc.methods[0]?.name).toBe("SegTree");
    expect(doc.methods[doc.methods.length - 1]?.name).toBe("main");
  });
});

describe("Swift 进阶 (fixtures/swift/Advanced.swift)", () => {
  it("泛型类 / 计算属性 / extension", async () => {
    const doc = await parseFixture("swift", "Advanced.swift");
    // extension String 作为独立类型卡片
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "Queue",
      "Temperature",
      "String",
    ]);
    expect(names(doc.methods)).toEqual(["enqueue", "dequeue", "reversed2"]);
    // 计算属性 fahrenheit 与存储属性一样提取为字段
    expect(names(doc.fields)).toEqual(["items", "celsius", "fahrenheit"]);
    const dequeue = doc.methods.find((m) => m.name === "dequeue");
    expect(dequeue?.hasComment).toBe(true);
    expect(dequeue?.description).toContain("出队");
  });
});

describe("C# 进阶 (fixtures/csharp/Advanced.cs)", () => {
  it("泛型类 / record / 静态类", async () => {
    const doc = await parseFixture("csharp", "Advanced.cs");
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual([
      "ListBox",
      "Point",
      "Calculator",
    ]);
    // ListBox.Add 与 Calculator.Add 同名共存
    expect(names(doc.methods)).toEqual(["Add", "Remove", "Add"]);
    expect(names(doc.fields)).toEqual(["_items", "Total"]);
    const remove = doc.methods.find((m) => m.name === "Remove");
    expect(remove?.hasComment).toBe(true);
    expect(remove?.description).toContain("移除元素");
    expect(doc.methods[2]?.description).toContain("累加方法");
  });
});

describe("文件头 SPDX 许可标识 (typescript)", () => {
  it("SPDX 行提取为 license，不并入 @author；@module 不污染 @description", async () => {
    const doc = await parseText(
      "typescript",
      "spdx-header.ts",
      `/**
 * @file 全局活动对象管理器
 * @description 管理活动对象的层级、筛选与运行时状态。
 * @module kernel/board/active-object-manager
 * @author Zhou Chenyu
 * SPDX-License-Identifier: MIT
 */
export class ActiveObjectManager {
  activate(): void {}
}
`,
    );
    // 描述 = @file 内容（首个元数据标签 @description 之前的文本）
    expect(doc.classComment).toBe("全局活动对象管理器");
    // @description 标签不再携带 @module 行
    expect(doc.classTags.description).toBe(
      "管理活动对象的层级、筛选与运行时状态。",
    );
    // author 不再携带 SPDX 行
    expect(doc.docAuthor).toBe("Zhou Chenyu");
    // SPDX 行提取为 license
    expect(doc.docLicense).toBe("MIT");
  });

  it("仅含 @file + SPDX 的文件头也能提取 license", async () => {
    const doc = await parseText(
      "typescript",
      "spdx-only.ts",
      `/**
 * @file 工具库
 * SPDX-License-Identifier: Apache-2.0
 */
export function util(): void {}
`,
    );
    expect(doc.docLicense).toBe("Apache-2.0");
    // SPDX 行不再混入描述文本
    expect(doc.classComment).toBe("工具库");
  });
});

describe("文件头 @license / @property / @prop 标签切分 (typescript)", () => {
  it("仅含 @license 的文件头提取为 license，不吞进描述", async () => {
    const doc = await parseText(
      "typescript",
      "license-tag-only.ts",
      `/**
 * @license MIT
 */
export class LicenseHolder {}
`,
    );
    expect(doc.docLicense).toBe("MIT");
    // @license 不再混入描述文本
    expect(doc.classComment).not.toContain("@license");
  });

  it("@file 描述 + @license 文件头：license 提取、描述不吞标签", async () => {
    const doc = await parseText(
      "typescript",
      "license-tag-with-file.ts",
      `/**
 * @file 工具库
 * @license MIT
 */
export function util(): void {}
`,
    );
    expect(doc.docLicense).toBe("MIT");
    expect(doc.classComment).toBe("工具库");
    expect(doc.classComment).not.toContain("@license");
  });

  it("字段注释中的 @property / @prop 解析进 properties，不吞进描述", async () => {
    const doc = await parseText(
      "typescript",
      "prop-tags-field.ts",
      `/** 文件头描述 */
interface Config {
  /**
   * @property {string} name 名称
   * @prop {number} size 大小
   */
  size: number;
}
`,
    );
    const f = doc.fields.find((x) => x.name === "size");
    expect(f?.hasComment).toBe(true);
    expect(f?.tags.properties).toHaveLength(2);
    expect(f?.tags.properties[0]).toMatchObject({
      name: "name",
      type: "string",
      description: "名称",
    });
    expect(f?.tags.properties[1]).toMatchObject({
      name: "size",
      type: "number",
      description: "大小",
    });
    // @property / @prop 行不再混入字段描述
    expect(f?.description).not.toContain("@property");
    expect(f?.description).not.toContain("@prop");
  });
});
