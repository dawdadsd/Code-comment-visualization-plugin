/**
 * parserEdge.test.ts - 解析器健壮性测试（编码边缘情景）
 *
 * 不依赖 fixture，直接构造源码文本，覆盖：
 * - 空文件 / 无注释成员 / 单行紧凑代码
 * - 文件头混合注释（// 行注释 + /* 块注释）
 * - 重载方法 / 纯脚本无类型文件
 *
 * 超时 / 日志静音等全局设置在 jest.config.js 与 test/setup.ts 中统一配置。
 */

import { parseText, names } from "./helpers";

describe("解析器健壮性：边界输入", () => {
  it("空文件：返回空结构且不抛异常", async () => {
    const doc = await parseText("java", "Empty.java", "");
    expect(doc.typeGroups).toHaveLength(0);
    expect(doc.methods).toHaveLength(0);
    expect(doc.fields).toHaveLength(0);
    expect(doc.enumConstants).toHaveLength(0);
  });

  it("只有注释没有代码", async () => {
    const doc = await parseText("java", "OnlyComment.java", "/** 孤立注释 */");
    expect(doc.methods).toHaveLength(0);
    expect(doc.fields).toHaveLength(0);
  });

  it("无注释成员：hasComment 为 false", async () => {
    const doc = await parseText(
      "java",
      "NoComment.java",
      `class Foo {
  int count;
  void bar() {}
}`,
    );
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Foo"]);
    expect(names(doc.fields)).toEqual(["count"]);
    expect(doc.fields[0]?.hasComment).toBe(false);
    expect(names(doc.methods)).toEqual(["bar"]);
    expect(doc.methods[0]?.hasComment).toBe(false);
  });

  it("单行紧凑代码也能提取成员", async () => {
    const doc = await parseText(
      "java",
      "OneLine.java",
      "class Foo { void bar() { return; } }",
    );
    expect(names(doc.methods)).toEqual(["bar"]);
  });

  it("重载方法同名共存", async () => {
    const doc = await parseText(
      "java",
      "Overload.java",
      `class Foo {
  void set(int a) {}
  void set(String s) {}
}`,
    );
    expect(names(doc.methods)).toEqual(["set", "set"]);
  });
});

describe("解析器健壮性：注释形态", () => {
  it("文件头混合注释：// 行注释 + /* 块注释合并为文件级注释", async () => {
    const doc = await parseText(
      "java",
      "MixedHeader.java",
      `// 工具模块
// 第二行
/**
 * 模块说明
 *
 * @author xiaowu
 */
class Foo {}
`,
    );
    expect(doc.classComment).toContain("工具模块");
    expect(doc.classComment).toContain("第二行");
    expect(doc.classComment).toContain("模块说明");
    expect(doc.docAuthor).toBe("xiaowu");
  });

  it("方法注释带 @param 标签且跨行", async () => {
    const doc = await parseText(
      "java",
      "Param.java",
      `class Foo {
  /**
   * 带参数方法
   *
   * @param a 参数A
   * @param b 参数B
   */
  void add(int a, int b) {}
}`,
    );
    const m = doc.methods.find((x) => x.name === "add");
    expect(m?.hasComment).toBe(true);
    expect(m?.tags.params).toHaveLength(2);
    expect(m?.tags.params[1]?.name).toBe("b");
  });

  it("行注释作为文档的语言（Go）：// 注释保留", async () => {
    const doc = await parseText(
      "go",
      "LineDoc.go",
      `package main

// Total 总量
var Total int

// Add 累加
func Add(a int) int {
	return a
}
`,
    );
    const add = doc.methods.find((m) => m.name === "Add");
    expect(add?.hasComment).toBe(true);
    expect(add?.description).toContain("累加");
  });
});

describe("解析器健壮性：无类型脚本", () => {
  it("JavaScript 纯脚本：顶层函数与箭头函数作为方法", async () => {
    const doc = await parseText(
      "javascript",
      "Script.js",
      `/** 问候 */
function greet(name) {
  return "hi " + name;
}

/** 求和箭头函数 */
const add = (a, b) => a + b;
`,
    );
    expect(names(doc.methods)).toContain("greet");
    expect(names(doc.methods)).toContain("add");
    const greet = doc.methods.find((m) => m.name === "greet");
    expect(greet?.hasComment).toBe(true);
    expect(greet?.description).toContain("问候");
  });

  it("无 JSDoc 的 JS 函数：返回类型不推断为 function", async () => {
    const doc = await parseText(
      "javascript",
      "NoDocFn.js",
      `function add(a, b) {
  return a + b;
}
`,
    );
    const add = doc.methods.find((m) => m.name === "add");
    expect(add).toBeDefined();
    // 无类型注解的 function 声明，返回类型应为空而非关键字 "function"
    expect(add?.returnType).toBe("");
  });

  it("JSDoc 函数类型参数/返回（{() => void} 与 {*}）", async () => {
    const doc = await parseText(
      "javascript",
      "FnDoc.js",
      `/**
 * 订阅动画状态变化（开始/结束计数变化时触发）
 * @param {() => void} listener 监听回调
 * @returns {() => void} 取消订阅函数
 */
function subscribeToAnimChanges(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 包装值
 * @param {*} v 输入值
 * @returns {*} 原样返回
 */
function identity(v) {
  return v;
}
`,
    );
    const sub = doc.methods.find((m) => m.name === "subscribeToAnimChanges");
    expect(sub?.tags.params[0]).toMatchObject({
      name: "listener",
      type: "() => void",
      description: "监听回调",
    });
    expect(sub?.tags.returns?.type).toBe("() => void");
    expect(sub?.tags.returns?.description).toBe("取消订阅函数");

    const identity = doc.methods.find((m) => m.name === "identity");
    expect(identity?.tags.params[0]).toMatchObject({
      name: "v",
      type: "*",
      description: "输入值",
    });
    expect(identity?.tags.returns?.type).toBe("*");
  });

  it("行尾 \\ 续行标记合并为逻辑行（markdown 写法）", async () => {
    const doc = await parseText(
      "javascript",
      "LineContinuation.js",
      `/**
 * 沿父链向外查找可拖拽的 handle 边
 * - 与边平行的层：该层边可能与边重合——命中 \\
 *   前一个兄弟的 handle（start 侧），即为可拖拽边； \\
 *   首/末位时与该层 start/end 边重合，继续向外
 *
 * @param {BoxBuilder} box 边所属 box
 * @returns {string|null} handle 边 id；不可拖拽返回 null
 */
function getDraggableEdgeId(box) {
  return null;
}
`,
    );
    const m = doc.methods.find((x) => x.name === "getDraggableEdgeId");
    // 行尾 \ 续行标记：\ 与换行及续行缩进被删除，逻辑行拼接为一整行
    expect(m?.description).toContain(
      "该层边可能与边重合——命中前一个兄弟的 handle（start 侧），即为可拖拽边；首/末位时与该层 start/end 边重合，继续向外",
    );
    // 描述中不应残留行尾的反斜杠
    for (const line of m?.description.split("\n") ?? []) {
      expect(line.trimEnd().endsWith("\\")).toBe(false);
    }
    expect(m?.tags.params[0]).toMatchObject({
      name: "box",
      type: "BoxBuilder",
      description: "边所属 box",
    });
    expect(m?.tags.returns?.type).toBe("string|null");
  });

  it("解构箭头函数：点分路径与可选 @param 参数", async () => {
    const doc = await parseText(
      "javascript",
      "FloatingScrollbar.jsx",
      `/**
 * 浮动滚动条组件。按容器悬停/滚动中状态显示，支持滑块拖拽与轨道点击跳转
 * @param {Object} props 组件属性
 * @param {React.RefObject<HTMLElement>} props.containerRef 监听的容器 ref
 * @param {'vertical'|'horizontal'} [props.orientation='vertical'] 方向
 * @returns {JSX.Element} 滚动条元素
 */
const FloatingScrollbar = ({ containerRef, orientation = 'vertical' }) => {
  return <div>{orientation}</div>;
};
`,
    );
    const m = doc.methods.find((x) => x.name === "FloatingScrollbar");
    expect(m?.tags.params).toHaveLength(3);
    expect(m?.tags.params[0]).toMatchObject({
      name: "props",
      type: "Object",
      description: "组件属性",
    });
    expect(m?.tags.params[1]).toMatchObject({
      name: "props.containerRef",
      type: "React.RefObject<HTMLElement>",
      description: "监听的容器 ref",
    });
    expect(m?.tags.params[2]).toMatchObject({
      name: "props.orientation",
      type: "'vertical'|'horizontal'",
      description: "方向",
    });
    expect(m?.tags.returns).toMatchObject({
      type: "JSX.Element",
      description: "滚动条元素",
    });
  });

  it("Rust 模块级 //! 注释不污染成员描述", async () => {
    const doc = await parseText(
      "rust",
      "Module.rs",
      `//! 模块级文档
//! 第二行

/// 结构体
pub struct Thing {
    /// 数值
    pub value: i32,
}

impl Thing {
    /// 创建
    pub fn new(v: i32) -> Thing {
        Thing { value: v }
    }
}
`,
    );
    expect(doc.typeGroups.map((g) => g.typeName)).toEqual(["Thing", "Thing"]);
    const newMethod = doc.methods.find((m) => m.name === "new");
    expect(newMethod?.hasComment).toBe(true);
    // 描述以内容开头，不含残留的 / 前缀（cleanComment 修复）
    expect(newMethod?.description).toBe("创建");
  });
});
