/**
 * symbolClassification.test.ts - JS/TS 变量「持有函数 vs 值绑定」分类单元测试
 *
 * 覆盖两条链路的成员分类：
 * - LSP 链路（覆盖 mock 的 executeDocumentSymbolProvider 注入符号）：
 *   变量持有对象/数组字面量（detail 为空 + 属性子符号，如
 *   `const x = Object.freeze({...})`）必须归为字段，不得被
 *   isFunctionVariableSymbol 的「children 非空」启发式误判为方法。
 * - tree-sitter 链路（LSP 为空时的 AST 兜底）：
 *   模块级 const/let/var 变量作为散落字段提取；持有箭头函数时按方法收集；
 *   for 循环等语句内的局部变量不得误收集。
 */

import * as vscodeMock from "./mocks/vscode";
import { DocCommentParser } from "../src/parser/DocCommentParser";
import { clearAllSymbolCache } from "../src/parser/SymbolResolver";
import { makeDoc, names } from "./helpers";

const parser = new DocCommentParser();
const originalExecuteCommand = vscodeMock.commands.executeCommand;

afterEach(() => {
  vscodeMock.commands.executeCommand = originalExecuteCommand;
});

function varSymbol(
  name: string,
  startLine: number,
  endLine: number,
  detail: string,
  children: vscodeMock.DocumentSymbol[],
): vscodeMock.DocumentSymbol {
  const s = new vscodeMock.DocumentSymbol(
    name,
    detail,
    vscodeMock.SymbolKind.Variable,
    new vscodeMock.Range(
      new vscodeMock.Position(startLine, 0),
      new vscodeMock.Position(endLine, 0),
    ),
    new vscodeMock.Range(
      new vscodeMock.Position(startLine, 6),
      new vscodeMock.Position(startLine, 6 + name.length),
    ),
  );
  s.children = children;
  return s;
}

function propSymbol(name: string, line: number): vscodeMock.DocumentSymbol {
  return new vscodeMock.DocumentSymbol(
    name,
    "",
    vscodeMock.SymbolKind.Property,
    new vscodeMock.Range(
      new vscodeMock.Position(line, 2),
      new vscodeMock.Position(line, 20),
    ),
    new vscodeMock.Range(
      new vscodeMock.Position(line, 2),
      new vscodeMock.Position(line, 20),
    ),
  );
}

describe("LSP 链路：变量持有值 vs 持有函数", () => {
  it("对象字面量变量（detail 空 + 属性子符号）识别为字段，不误判为方法", async () => {
    const text =
      "const EFFECT_KIND_OF_TYPE = Object.freeze({\n" +
      "  [OperationType.ADD_OBJECT]: OperationEffectKind.APPEND_NODE,\n" +
      "});";
    vscodeMock.commands.executeCommand = async (name: string) => {
      if (name === "vscode.executeDocumentSymbolProvider") {
        return [
          varSymbol("EFFECT_KIND_OF_TYPE", 0, 2, "", [
            propSymbol("ADD_OBJECT", 1),
          ]),
        ];
      }
      return null;
    };
    clearAllSymbolCache();
    const doc = await parser.parse(makeDoc("javascript", "op.js", text));
    expect(names(doc.fields)).toContain("EFFECT_KIND_OF_TYPE");
    expect(names(doc.methods)).not.toContain("EFFECT_KIND_OF_TYPE");
  });

  it("变量持有箭头函数（detail 空 + 源码含 =>）识别为方法", async () => {
    const text = "const makeEdgeId = (a, b) => {\n  return a + b;\n};";
    vscodeMock.commands.executeCommand = async (name: string) => {
      if (name === "vscode.executeDocumentSymbolProvider") {
        // 模拟 JS LSP：detail 空 + 函数体产生子符号（局部变量声明）
        return [
          varSymbol("makeEdgeId", 0, 2, "", [
            new vscodeMock.DocumentSymbol(
              "a",
              "",
              vscodeMock.SymbolKind.Variable,
              new vscodeMock.Range(
                new vscodeMock.Position(1, 2),
                new vscodeMock.Position(1, 3),
              ),
              new vscodeMock.Range(
                new vscodeMock.Position(1, 2),
                new vscodeMock.Position(1, 3),
              ),
            ),
          ]),
        ];
      }
      return null;
    };
    clearAllSymbolCache();
    const doc = await parser.parse(makeDoc("javascript", "fn.js", text));
    expect(names(doc.methods)).toContain("makeEdgeId");
    expect(names(doc.fields)).not.toContain("makeEdgeId");
  });
});

describe("tree-sitter 链路：模块级变量（LSP 为空兜底）", () => {
  it("const Object.freeze 对象字面量提取为字段", async () => {
    clearAllSymbolCache();
    const text =
      "const EFFECT_KIND_OF_TYPE = Object.freeze({\n" +
      "  [OperationType.ADD_OBJECT]: OperationEffectKind.APPEND_NODE,\n" +
      "  [OperationType.UNDO]: OperationEffectKind.REATTACH,\n" +
      "});";
    const doc = await parser.parse(makeDoc("javascript", "op2.js", text));
    expect(names(doc.fields)).toContain("EFFECT_KIND_OF_TYPE");
    expect(names(doc.methods)).not.toContain("EFFECT_KIND_OF_TYPE");
  });

  it("const 箭头函数提取为方法而非字段", async () => {
    clearAllSymbolCache();
    const text = "const makeEdgeId = (a, b) => {\n  return a + b;\n};";
    const doc = await parser.parse(makeDoc("javascript", "fn2.js", text));
    expect(names(doc.methods)).toContain("makeEdgeId");
    expect(names(doc.fields)).not.toContain("makeEdgeId");
  });

  it("for 循环局部变量不被误收集为字段", async () => {
    clearAllSymbolCache();
    const text =
      "const items = [1, 2, 3];\n" +
      "for (let i = 0; i < items.length; i++) {\n" +
      "  console.log(items[i]);\n" +
      "}\n" +
      "const total = items.length;";
    const doc = await parser.parse(makeDoc("javascript", "loop.js", text));
    expect(names(doc.fields)).toContain("items");
    expect(names(doc.fields)).toContain("total");
    expect(names(doc.fields)).not.toContain("i");
  });
});
