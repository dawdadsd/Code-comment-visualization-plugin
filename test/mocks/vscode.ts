/**
 * vscode.ts - jest 单元测试的 vscode mock（moduleNameMapper 映射）
 *
 * 解析链路依赖 vscode API（DocumentSymbol / SymbolKind / commands 等）。
 * 注意：executeDocumentSymbolProvider 返回 []（模拟无 Language Server），
 * 使 parse() 走 tree-sitter AST 兜底链路，同时验证 AST 成员提取。
 * 如需模拟 LSP 符号树，可在测试内覆盖 mock 的 commands。
 */

export const SymbolKind = {
  File: 0,
  Module: 1,
  Namespace: 2,
  Package: 3,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  String: 14,
  Number: 15,
  Boolean: 16,
  Array: 17,
  Object: 18,
  Key: 19,
  Null: 20,
  EnumMember: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
} as const;

export class Position {
  constructor(
    public line: number,
    public character: number,
  ) {}
}

export class Range {
  constructor(
    public start: Position,
    public end: Position,
  ) {}
}

export class Location {
  constructor(
    public uri: unknown,
    public range: Range,
  ) {}
}

export class DocumentSymbol {
  name: string;
  detail: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children: DocumentSymbol[];

  constructor(
    name: string,
    detail: string,
    kind: number,
    range: Range,
    selectionRange: Range,
  ) {
    this.name = name;
    this.detail = detail;
    this.kind = kind;
    this.range = range;
    this.selectionRange = selectionRange;
    this.children = [];
  }
}

export const Uri = {
  file: (p: string) => ({
    fsPath: p,
    toString: () => "file:///" + p.replace(/\\/g, "/"),
  }),
};

export const commands = {
  executeCommand: async (name: string): Promise<unknown> => {
    if (name === "vscode.executeDocumentSymbolProvider") {
      // 模拟无 Language Server：符号为空，走 tree-sitter AST 兜底
      return [];
    }
    return null;
  },
};

export const window = {
  activeTextEditor: undefined,
};

export const workspace = {
  textDocuments: [],
  workspaceFolders: [],
  getConfiguration: () => ({ get: () => false }),
};
