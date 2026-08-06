# JavaDoc Sidebar v0.3.0 - 技术实现文档

> **版本**: v0.3.0
> **更新日期**: 2026-02-04
> **文档性质**: 实现原理 + 架构设计 + TypeScript 概念解析

---

## 目录

1. [功能清单](#1-功能清单)
2. [系统架构](#2-系统架构)
3. [核心模块实现原理](#3-核心模块实现原理)
4. [TypeScript 高级特性解析](#4-typescript-高级特性解析)
5. [VS Code Extension API 详解](#5-vscode-extension-api-详解)
6. [数据流与消息协议](#6-数据流与消息协议)
7. [Git 集成原理](#7-git-集成原理)
8. [性能优化机制](#8-性能优化机制)
9. [文件结构说明](#9-文件结构说明)

---

## 1. 功能清单

### 1.1 已实现功能

| 功能模块 | 功能点 | 实现状态 |
|---------|--------|---------|
| **文档解析** | Javadoc 注释提取 | ✅ |
| | @param/@return/@throws 标签解析 | ✅ |
| | 方法签名类型提取 | ✅ |
| | 内部类扁平化处理 | ✅ |
| | 多行方法签名支持 | ✅ |
| **双向联动** | 点击方法名跳转代码 | ✅ |
| | 光标移动高亮侧边栏 | ✅ |
| | 防抖机制 | ✅ |
| | 二分查找定位 | ✅ |
| **视图模式** | 简洁模式（列表） | ✅ |
| | 详细模式（卡片+表格） | ✅ |
| | 视图切换按钮 | ✅ |
| **Git 集成** | @author 标签解析 | ✅ |
| | @since 标签解析 | ✅ |
| | Git Blame 作者获取 | ✅ |
| | 最后修改者显示 | ✅ |
| **多位置支持** | 左侧活动栏 | ✅ |
| | 底部面板 | ✅ |
| | 右侧辅助栏（拖拽） | ✅ |
| **UI/UX** | VS Code 主题适配 | ✅ |
| | SVG 图标系统 | ✅ |
| | 无注释方法标识 | ✅ |
| | 折叠/展开控制 | ✅ |

### 1.2 版本演进

| 版本 | 核心变更 |
|------|---------|
| v0.1.0 | 基础解析、双向联动、Webview 渲染 |
| v0.2.0 | 视图模式切换、参数类型修复、多位置支持 |
| v0.3.0 | Git 作者集成、@author/@since 解析、UI 优化 |

---

## 2. 系统架构

### 2.1 整体架构图

```mermaid
flowchart TB
    subgraph Host["VS Code 宿主进程"]
        subgraph EH["Extension Host"]
            EXT["extension.ts<br/>生命周期管理 / 事件注册 / Provider 注册"]
            SP["SidebarProvider.ts<br/>Webview 生命周期 / 消息路由 / 状态缓存"]
            P["Parser 层<br/>JavaDocParser / SymbolResolver / TagParser"]
            GS["Services 层<br/>GitService: blame 查询 / 缓存管理"]
            U["Utils 层<br/>debounce / binarySearch"]
            EXT --> SP --> P --> GS
            SP -.-> U
        end
        subgraph WV["Webview (侧边栏)"]
            SJ["sidebar.js<br/>渲染引擎 / 交互处理 / 状态管理"]
            PM["postMessage 消息通道"]
            SC["sidebar.css<br/>主题变量 / 响应式布局"]
            SJ --- PM
        end
        SP <-->|"postMessage"| PM
    end
```

### 2.2 模块依赖关系

```mermaid
flowchart TB
    EXT[extension.ts]
    SP[SidebarProvider.ts]
    JDP[JavaDocParser.ts]
    SR["SymbolResolver.ts<br/>(VS Code API)"]
    TP[TagParser.ts]
    GS[GitService.ts]
    D[debounce.ts]
    BS[binarySearch.ts]
    TY["types.ts<br/>(所有模块共享)"]
    EXT --> SP
    SP --> JDP
    JDP --> SR
    JDP --> TP
    JDP --> GS
    SP --> D
    SP --> BS
    TY -.- EXT
    TY -.- SP
    TY -.- JDP
    TY -.- SR
    TY -.- TP
    TY -.- GS
```

---

## 3. 核心模块实现原理

### 3.1 extension.ts — 扩展入口

**职责**: 扩展的生命周期管理，只做三件事：

1. **注册 WebviewViewProvider**
   - 告诉 VS Code：当用户打开指定 viewId 的视图时，使用哪个 Provider 来创建内容
   - 支持两个位置：`javaDocSidebar`（左侧）和 `javaDocSidebarPanel`（底部面板）

2. **注册事件监听器**
   - `onDidSaveTextDocument`: 文件保存时重新解析
   - `onDidChangeActiveTextEditor`: 切换编辑器时刷新或清空
   - `onDidChangeTextEditorSelection`: 光标移动时触发反向联动

3. **注册命令**
   - `javaDocSidebar.refresh`: 手动刷新命令

**设计原则**: 入口模块不包含任何业务逻辑，所有逻辑委托给 SidebarProvider。

### 3.2 SidebarProvider.ts — Webview 管理器

**职责**: 实现 `WebviewViewProvider` 接口，管理 Webview 的完整生命周期。

**核心状态**:

| 状态 | 类型 | 用途 |
|------|------|------|
| `_view` | `WebviewView \| undefined` | 当前 Webview 实例引用 |
| `_currentMethods` | `MethodDoc[]` | 解析结果缓存，用于反向联动的二分查找 |
| `_lastHighlightId` | `MethodId \| null` | 上次高亮的方法 ID，避免重复发送消息 |
| `_debouncedHighlight` | `Function` | 防抖后的高亮处理函数 |

**关键方法**:

| 方法 | 触发时机 | 核心逻辑 |
|------|---------|---------|
| `resolveWebviewView()` | Webview 首次可见 | 创建 Webview、设置 HTML、注册消息监听 |
| `refresh()` | 文件保存/切换 | 调用解析器 → 序列化 JSON → postMessage |
| `handleSelectionChange()` | 光标移动 | 防抖 → 二分查找 → 去重 → 发送高亮消息 |
| `clearView()` | 切换到非 Java 文件 | 发送清空消息，显示占位提示 |

**Webview 配置**:

```
enableScripts: true           // 允许执行 JavaScript
retainContextWhenHidden: true // 切换标签时保留状态（重要！）
localResourceRoots: [media/]  // 限制资源访问范围（安全）
```

### 3.3 JavaDocParser.ts — Javadoc 主解析器

**职责**: 从 Java 文件中提取所有方法的文档信息。

**解析流水线**:

```mermaid
flowchart TB
    In["TextDocument"]
    S1["步骤1: Symbol 解析<br/>调用 VS Code DocumentSymbolProvider<br/>获取类、方法的名称和行号范围"]
    S2["步骤2: Symbol 扁平化<br/>递归遍历 Symbol 树<br/>提取所有 Method/Constructor<br/>记录 belongsTo（所属类名）"]
    S3["步骤3: Javadoc 提取<br/>从方法定义行向上搜索<br/>跳过空行和注解（@Override 等）<br/>匹配 /** ... */ 注释块"]
    S4["步骤4: 标签解析<br/>分离描述和标签部分<br/>调用 TagParser 解析 @param/@return 等<br/>从方法签名提取参数类型"]
    S5["步骤5: Git 信息获取<br/>检查是否为 Git 仓库<br/>调用 git blame 获取作者信息<br/>解析 @author/@since 标签"]
    Out["ClassDoc (JSON-ready)"]
    In --> S1 --> S2 --> S3 --> S4 --> S5 --> Out
```

**方法签名提取算法**:

多行方法签名的处理是一个难点。算法使用括号计数：

```
思路:
1. 从方法声明行开始逐字符扫描
2. 遇到 '(' 时 parenDepth++
3. 遇到 ')' 时 parenDepth--
4. 当 parenDepth 归零时，说明找到了完整的参数列表
5. 将收集的内容规范化（去除换行、压缩空格）
```

### 3.4 TagParser.ts — 标签解析器

**职责**: 将 Javadoc 原始文本解析为结构化的 `TagTable`。

**解析策略**:

1. **清洗原始文本**: 移除 `/**`、`*/`、每行开头的 ` * `
2. **分离描述和标签**: 找到第一个 `@tag`，之前是描述，之后是标签
3. **按标签分割**: 使用正则 `/@(param|return|throws|...)\s+/` 分割
4. **逐标签解析**: 根据标签类型调用不同的解析函数

**参数类型提取**:

`@param` 标签只包含参数名和描述，没有类型。类型需要从方法签名中提取：

```mermaid
flowchart TB
    A["方法签名<br/>public void save(Long id, String name)"]
    B["parseSignatureParams()"]
    C["Map { id => Long, name => String }"]
    D["与 @param 标签的参数名匹配"]
    A --> B --> C --> D
```

**泛型处理**:

泛型参数包含逗号（如 `Map<String, List<User>>`），不能简单按逗号分割。算法使用尖括号计数：

```
思路:
1. 遍历参数列表字符串
2. 遇到 '<' 时 depth++
3. 遇到 '>' 时 depth--
4. 只有当 depth == 0 时，遇到的逗号才是参数分隔符
```

### 3.5 SymbolResolver.ts — Symbol 解析器

**职责**: 封装 VS Code 的 DocumentSymbol API。

**核心原理**:

VS Code 通过 Language Server Protocol (LSP) 与 Java 语言服务器（如 Eclipse JDT）通信。当我们调用 `executeDocumentSymbolProvider` 时：

```mermaid
flowchart TB
    A["我们的扩展"]
    B["vscode.commands.executeCommand<br/>('vscode.executeDocumentSymbolProvider', uri)"]
    C["VS Code 核心"]
    D["Java Language Server (redhat.java)"]
    E["返回 DocumentSymbol[] 树形结构"]
    A --> B --> C --> D --> E
```

**Symbol 过滤**:

| SymbolKind | 是否保留 | 说明 |
|------------|---------|------|
| Class | 递归处理子节点 | 记录类名用于 belongsTo |
| Interface | 递归处理子节点 | 同上 |
| Method | ✅ 保留 | 目标数据 |
| Constructor | ✅ 保留 | 视为方法 |
| Field | ❌ 忽略 | 不展示字段 |
| Enum | 递归处理子节点 | 可能有方法 |
| EnumMember | ❌ 忽略 | 枚举常量 |

### 3.6 GitService.ts — Git 信息服务

**职责**: 获取文件的 Git 作者和修改历史。

**实现方式**: 通过 Node.js 的 `child_process` 执行 Git 命令。

**核心命令**:

| 命令 | 用途 | 输出格式 |
|------|------|---------|
| `git blame -L n,n --porcelain file` | 获取指定行的作者 | 机器可读的详细信息 |
| `git log --follow --diff-filter=A` | 获取文件首次提交作者 | 提交历史 |
| `git rev-parse --git-dir` | 检查是否为 Git 仓库 | 成功/失败 |

**Porcelain 格式解析**:

```
git blame --porcelain 输出示例:
─────────────────────────────────
abc123def456... 1 1 1
author Zhang San
author-mail <zhangsan@example.com>
author-time 1706889600
author-tz +0800
...
─────────────────────────────────

解析提取:
- commitHash: abc123def456...
- author: Zhang San
- email: zhangsan@example.com
- date: 从 author-time 时间戳转换
```

**缓存机制**:

```
缓存结构: Map<"filePath:lineNumber", GitBlameInfo>
缓存有效期: 60秒
清理方式: setTimeout 自动删除
```

---

## 4. TypeScript 高级特性解析

### 4.1 Branded Types（品牌类型）

**问题**: TypeScript 中 `number` 和 `number` 是相同类型，无法区分"行号"和"年龄"。

```typescript
// 危险：两者都是 number，编译器不会报错
function jumpToLine(line: number) { ... }
function setAge(age: number) { ... }

const age = 25;
jumpToLine(age); // 逻辑错误，但 TypeScript 不报错！
```

**解决方案**: 使用 Branded Types 为类型添加"品牌"标识。

```typescript
// 定义品牌符号
declare const _brand: unique symbol;

// 品牌类型构造器
type Brand<T, B> = T & { readonly [_brand]: B };

// 具体类型
type LineNumber = Brand<number, "LineNumber">;
type MethodId = Brand<string, "MethodId">;
```

**原理**:

- `unique symbol` 是 TypeScript 的特殊类型，每个声明都是独一无二的
- 通过交叉类型 `&` 将品牌"附加"到基础类型上
- 品牌属性 `[_brand]` 只存在于类型层面，运行时不存在
- 不同品牌的类型互不兼容

**构造函数**:

```typescript
// 类型断言函数，将普通值转为品牌类型
export const LineNumber = (n: number): LineNumber => n as LineNumber;
export const MethodId = (id: string): MethodId => id as MethodId;
```

### 4.2 Discriminated Unions（可辨识联合）

**问题**: 消息类型需要在运行时能够区分。

**解决方案**: 使用 `type` 字段作为判别标签。

```typescript
export type DownstreamMessage =
  | { readonly type: 'updateView'; readonly payload: ClassDoc }
  | { readonly type: 'highlightMethod'; readonly payload: { id: MethodId } }
  | { readonly type: 'clearView' };
```

**原理**:

- 每个联合成员都有一个共同的字面量类型属性（`type`）
- TypeScript 可以通过检查 `type` 的值来收窄类型
- `switch` 语句可以获得完整的类型推断

```typescript
function handleMessage(msg: DownstreamMessage) {
  switch (msg.type) {
    case 'updateView':
      // 这里 msg.payload 的类型是 ClassDoc
      break;
    case 'highlightMethod':
      // 这里 msg.payload 的类型是 { id: MethodId }
      break;
    case 'clearView':
      // 这里 msg 没有 payload
      break;
  }
}
```

### 4.3 Type Guards（类型守卫）

**问题**: `postMessage` 接收的数据类型是 `unknown`，需要验证。

**解决方案**: 自定义类型守卫函数。

```typescript
export function isUpstreamMessage(value: unknown): value is UpstreamMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  if (obj.type === 'jumpToLine') {
    return typeof obj.payload === 'object'
           && obj.payload !== null
           && typeof (obj.payload as Record<string, unknown>).line === 'number';
  }

  if (obj.type === 'webviewReady') {
    return true;
  }

  return false;
}
```

**原理**:

- 返回类型 `value is UpstreamMessage` 是类型谓词
- 当函数返回 `true` 时，TypeScript 会将参数类型收窄为 `UpstreamMessage`
- 这是连接运行时检查和编译时类型的桥梁

### 4.4 Readonly 和 Immutability

**设计原则**: 数据结构一旦创建就不应被修改。

```typescript
export interface ClassDoc {
  readonly className: string;
  readonly methods: readonly MethodDoc[];  // 双重 readonly
  // ...
}
```

**两层 readonly**:

1. `readonly className`: 不能重新赋值 `doc.className = "new"`
2. `readonly MethodDoc[]`: 数组本身不能被替换，元素也不能被修改

**`as const` 断言**:

```typescript
export const EMPTY_TAG_TABLE: TagTable = {
  params: [],
  returns: null,
  // ...
} as const satisfies TagTable;
```

- `as const` 将所有属性推断为字面量类型和 readonly
- `satisfies TagTable` 确保对象符合接口定义

### 4.5 Optional Properties 与 exactOptionalPropertyTypes

**问题**: 可选属性 `?` 的两种含义：

1. 属性可以不存在
2. 属性值可以是 `undefined`

**tsconfig.json 配置**:

```json
{
  "compilerOptions": {
    "exactOptionalPropertyTypes": true
  }
}
```

**效果**:

```typescript
interface ClassDoc {
  gitInfo?: GitAuthorInfo;  // 只意味着属性可以不存在
}

// 错误！undefined 不能赋给 GitAuthorInfo
const doc: ClassDoc = { gitInfo: undefined };

// 正确写法
interface ClassDoc {
  gitInfo?: GitAuthorInfo | undefined;  // 明确允许 undefined
}
```

---

## 5. VS Code Extension API 详解

### 5.1 WebviewViewProvider 接口

**作用**: 定义如何为侧边栏/面板中的 Webview 提供内容。

```typescript
interface WebviewViewProvider {
  resolveWebviewView(
    webviewView: WebviewView,
    context: WebviewViewResolveContext,
    token: CancellationToken
  ): void | Thenable<void>;
}
```

**关键参数**:

| 参数 | 说明 |
|------|------|
| `webviewView` | Webview 视图对象，包含 webview 实例 |
| `webviewView.webview` | 实际的 Webview，用于设置 HTML 和通信 |
| `context.state` | 之前保存的状态（如果有） |
| `token` | 取消令牌，用于检测操作是否被取消 |

**注册方式**:

```typescript
vscode.window.registerWebviewViewProvider(
  'javaDocSidebar',  // viewId，必须与 package.json 中的 views.id 匹配
  provider,
  {
    webviewOptions: {
      retainContextWhenHidden: true  // 切换标签时保留状态
    }
  }
);
```

### 5.2 DocumentSymbol 与 executeDocumentSymbolProvider

**作用**: 获取文档的结构信息（类、方法、字段等）。

```typescript
const symbols = await vscode.commands.executeCommand<DocumentSymbol[]>(
  'vscode.executeDocumentSymbolProvider',
  document.uri
);
```

**DocumentSymbol 结构**:

| 属性 | 类型 | 说明 |
|------|------|------|
| `name` | string | 符号名称 |
| `detail` | string | 详细信息（如方法签名） |
| `kind` | SymbolKind | 符号类型（Class/Method/...） |
| `range` | Range | 符号的完整范围（含方法体） |
| `selectionRange` | Range | 符号名称的范围（仅方法名） |
| `children` | DocumentSymbol[] | 子符号（嵌套结构） |

**range vs selectionRange**:

```java
public void save(Long id) {  // <- selectionRange 指向 "save"
    // method body           // <- range 包含整个方法体
}                            // <- range.end 在这里
```

### 5.3 事件监听 API

**onDidSaveTextDocument**:

```typescript
vscode.workspace.onDidSaveTextDocument((document: TextDocument) => {
  // document.languageId: 语言标识符 ("java")
  // document.uri: 文件 URI
  // document.getText(): 文件内容
});
```

**onDidChangeActiveTextEditor**:

```typescript
vscode.window.onDidChangeActiveTextEditor((editor: TextEditor | undefined) => {
  // editor 可能为 undefined（所有编辑器都关闭）
  // editor.document: 当前文档
  // editor.selection: 当前选区
});
```

**onDidChangeTextEditorSelection**:

```typescript
vscode.window.onDidChangeTextEditorSelection((event: TextEditorSelectionChangeEvent) => {
  // event.textEditor: 发生变化的编辑器
  // event.selections: 所有选区（支持多光标）
  // event.selections[0].active: 主光标位置
  // event.kind: 变化原因（键盘/鼠标/命令）
});
```

### 5.4 编辑器导航 API

**revealRange — 滚动到指定位置**:

```typescript
editor.revealRange(
  range,                              // 目标范围
  TextEditorRevealType.InCenter       // 在视图中央显示
);
```

**RevealType 选项**:

| 值 | 效果 |
|---|------|
| `Default` | 最小滚动使范围可见 |
| `InCenter` | 滚动使范围在视图中央 |
| `InCenterIfOutsideViewport` | 仅当不可见时居中 |
| `AtTop` | 滚动使范围在视图顶部 |

**设置光标位置**:

```typescript
editor.selection = new Selection(position, position);
```

### 5.5 Webview 消息通信

**Extension → Webview**:

```typescript
this._view.webview.postMessage({
  type: 'updateView',
  payload: classDoc
});
```

**Webview → Extension**:

```javascript
// 在 sidebar.js 中
const vscode = acquireVsCodeApi();
vscode.postMessage({ type: 'jumpToLine', payload: { line: 45 } });
```

**Extension 接收**:

```typescript
webviewView.webview.onDidReceiveMessage((message: unknown) => {
  if (isUpstreamMessage(message)) {
    // 类型安全的处理
  }
});
```

### 5.6 Disposable 模式

**概念**: VS Code 中所有需要清理的资源都实现 `Disposable` 接口。

```typescript
interface Disposable {
  dispose(): void;
}
```

**使用方式**:

```typescript
// 注册到 subscriptions，扩展停用时自动清理
context.subscriptions.push(
  viewProviderDisposable,
  saveListener,
  editorChangeListener
);
```

**自定义 Disposable**:

```typescript
class SidebarProvider implements WebviewViewProvider, Disposable {
  private _disposables: Disposable[] = [];

  dispose() {
    this._disposables.forEach(d => d.dispose());
  }
}
```

---

## 6. 数据流与消息协议

### 6.1 数据结构总览

```
ClassDoc                          // 类文档（顶层）
├── className: string             // 类名
├── classComment: string          // 类注释
├── packageName: string           // 包名
├── filePath: FilePath            // 文件路径
├── methods: MethodDoc[]          // 方法列表
├── gitInfo?: GitAuthorInfo       // Git 信息
├── javadocAuthor?: string        // @author 标签
└── javadocSince?: string         // @since 标签

MethodDoc                         // 方法文档
├── id: MethodId                  // 唯一标识 "方法名_行号"
├── name: string                  // 方法名
├── signature: string             // 方法签名
├── startLine: LineNumber         // 起始行
├── endLine: LineNumber           // 结束行
├── hasComment: boolean           // 是否有注释
├── description: string           // 描述文本
├── tags: TagTable                // 结构化标签
├── belongsTo: string             // 所属类名
├── accessModifier: AccessModifier // 访问修饰符
└── gitInfo?: GitAuthorInfo       // Git 信息（预留）

TagTable                          // 标签表格
├── params: ParamTag[]            // @param 列表
├── returns: ReturnTag | null     // @return
├── throws: ThrowsTag[]           // @throws 列表
├── since: string | null          // @since
├── author: string | null         // @author
├── deprecated: string | null     // @deprecated
└── see: string[]                 // @see 列表

GitAuthorInfo                     // Git 作者信息
├── author: string                // 原始作者
├── lastModifier: string          // 最后修改者
└── lastModifyDate: string        // 修改日期
```

### 6.2 消息协议

**下行消息（Extension → Webview）**:

| type | payload | 触发时机 |
|------|---------|---------|
| `updateView` | ClassDoc | 文件保存/切换 |
| `highlightMethod` | { id: MethodId } | 光标移动 |
| `clearView` | - | 切换到非 Java 文件 |

**上行消息（Webview → Extension）**:

| type | payload | 触发时机 |
|------|---------|---------|
| `jumpToLine` | { line: LineNumber } | 点击方法名 |
| `webviewReady` | - | Webview 加载完成 |

### 6.3 完整数据流示例

**场景: 用户保存 Java 文件**

```mermaid
sequenceDiagram
    participant U as 用户
    participant VS as VS Code
    participant E as extension.ts
    participant SP as SidebarProvider
    participant SR as SymbolResolver
    participant JDP as JavaDocParser
    participant TP as TagParser
    participant GS as GitService
    participant W as sidebar.js

    U->>VS: 按 Cmd+S
    VS->>E: onDidSaveTextDocument
    E->>E: 检查 languageId === 'java'
    E->>SP: refresh(document)
    par
        SP->>SR: resolve()
        SR->>VS: Symbol API
        VS-->>SR: DocumentSymbol[]
        SR-->>JDP: DocumentSymbol[]
    and
        JDP->>JDP: 等待
    end
    JDP->>JDP: 遍历 Symbol，提取 Javadoc
    JDP->>TP: parseTagTable()
    TP-->>JDP: TagTable
    JDP->>GS: getClassGitInfo()
    GS-->>JDP: GitAuthorInfo
    JDP-->>SP: 组装 ClassDoc
    SP->>SP: JSON.stringify(classDoc)
    SP->>W: postMessage({ type:'updateView', payload })
    W->>W: renderClassDoc(classDoc)
    W-->>U: DOM 更新完成，看到新内容
```

---

## 7. Git 集成原理

### 7.1 信息来源优先级

```mermaid
flowchart TB
    A{"1. Javadoc @author 标签<br/>(最可信，开发者主动声明)"}
    B{"2. Git 首次提交作者<br/>(文件原始创建者)"}
    C{"3. Git Blame 当前行作者<br/>(最后修改者)"}
    D["4. 显示 Unknown"]
    A -->|不存在| B
    B -->|不存在| C
    C -->|不存在| D
```

### 7.2 Git 命令详解

**git blame --porcelain**:

```bash
git blame -L 45,45 --porcelain "UserService.java"
```

- `-L 45,45`: 只查询第 45 行
- `--porcelain`: 输出机器可读的格式

**输出解析**:

```
abc123...                    # 提交哈希
author Zhang San             # 作者名
author-mail <zhang@x.com>    # 作者邮箱
author-time 1706889600       # Unix 时间戳
author-tz +0800              # 时区
committer Li Si              # 提交者（可能不同于作者）
...
	actual line content      # 行内容（以 tab 开头）
```

**git log --follow --diff-filter=A**:

```bash
git log --follow --diff-filter=A --format="%an|%ad" --date=short -- "file.java"
```

- `--follow`: 跟踪文件重命名
- `--diff-filter=A`: 只显示文件被添加（Add）的提交
- `--format`: 自定义输出格式

### 7.3 错误处理

| 场景 | 处理方式 |
|------|---------|
| 不是 Git 仓库 | 返回 undefined，不显示 Git 信息 |
| 文件未被 Git 跟踪 | 返回 undefined |
| Git 命令超时 | 5 秒超时，返回 undefined |
| Git 未安装 | 捕获异常，返回 undefined |

---

## 8. 性能优化机制

### 8.1 防抖（Debounce）

**问题**: 光标移动事件触发频率极高（每移动一格触发一次）。

**解决方案**: 防抖函数，延迟执行，期间的新调用会重置计时器。

```
原理图:

事件流: ─●─●─●─●─────●─●─●──────────────
                     │         │
防抖:   ─────────────┼─────────┼──────●
                     │         │      │
                  300ms      300ms   执行
```

**实现要点**:

- 使用 `setTimeout` 延迟执行
- 每次新调用先 `clearTimeout`
- 返回 Disposable 以便清理

### 8.2 二分查找

**问题**: 给定光标行号，找到光标所在的方法。

**数据特点**: 方法按 `startLine` 升序排列。

**算法**:

```
输入: methods[] (按 startLine 升序), cursorLine
输出: 包含光标的方法，或 null

lo = 0, hi = length - 1
result = null

while lo <= hi:
    mid = (lo + hi) / 2
    if methods[mid].startLine <= cursorLine:
        result = methods[mid]  // 候选
        lo = mid + 1           // 继续找更靠后的
    else:
        hi = mid - 1

// 验证 endLine
if result && result.endLine >= cursorLine:
    return result
else:
    return null
```

**时间复杂度**: O(log n)

### 8.3 去重优化

**问题**: 在同一方法内移动光标会重复发送高亮消息。

**解决方案**: 记录上次高亮的 ID，相同则跳过。

```
_lastHighlightId = null

handleSelectionChange(line):
    methodId = binarySearch(line)
    if methodId === _lastHighlightId:
        return  // 跳过，不发消息
    _lastHighlightId = methodId
    postMessage(highlight)
```

### 8.4 Webview 状态保留

**问题**: 切换标签页后 Webview 会被销毁重建。

**解决方案**: 设置 `retainContextWhenHidden: true`

**效果**:
- Webview 的 DOM 和 JavaScript 上下文保留在内存中
- 切换回来时无需重新渲染
- 代价是约 2-5MB 额外内存占用

---

## 9. 文件结构说明

```
javadoc-sidebar/
│
├── src/                          # TypeScript 源码
│   ├── extension.ts              # 扩展入口
│   ├── SidebarProvider.ts        # Webview 管理器
│   ├── types.ts                  # 类型定义
│   │
│   ├── parser/                   # 解析器模块
│   │   ├── JavaDocParser.ts      # Javadoc 主解析器
│   │   ├── SymbolResolver.ts     # Symbol API 封装
│   │   └── TagParser.ts          # 标签解析器
│   │
│   ├── services/                 # 服务模块
│   │   └── GitService.ts         # Git 信息服务
│   │
│   └── utils/                    # 工具函数
│       ├── debounce.ts           # 防抖
│       └── binarySearch.ts       # 二分查找
│
├── media/                        # 前端资源
│   ├── icon.svg                  # Activity Bar 图标
│   ├── sidebar.css               # 样式
│   └── sidebar.js                # 前端逻辑
│
├── out/                          # 编译输出（git ignore）
│
├── package.json                  # 扩展清单
├── tsconfig.json                 # TypeScript 配置
├── .vscodeignore                 # 打包排除列表
└── README.md                     # 使用说明
```

---

## 附录：关键配置参考

### package.json 核心配置

```json
{
  "activationEvents": ["onLanguage:java"],

  "contributes": {
    "viewsContainers": {
      "activitybar": [{ "id": "javaDocExplorer", "title": "JavaDoc" }],
      "panel": [{ "id": "javaDocPanel", "title": "JavaDoc" }]
    },
    "views": {
      "javaDocExplorer": [{ "type": "webview", "id": "javaDocSidebar" }],
      "javaDocPanel": [{ "type": "webview", "id": "javaDocSidebarPanel" }]
    },
    "configuration": {
      "properties": {
        "javaDocSidebar.enableAutoHighlight": { "type": "boolean", "default": true },
        "javaDocSidebar.debounceDelay": { "type": "number", "default": 300 }
      }
    }
  }
}
```

### tsconfig.json 关键配置

```json
{
  "compilerOptions": {
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "module": "Node16",
    "moduleResolution": "Node16"
  }
}
```

---

> **文档维护**: 此文档应随代码更新同步维护。重大架构变更时需要更新对应章节。
