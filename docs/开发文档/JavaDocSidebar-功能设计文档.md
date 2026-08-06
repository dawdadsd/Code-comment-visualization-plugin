# JavaDoc Sidebar - VS Code 扩展功能设计文档

> **版本**: v1.0
> **创建日期**: 2026-02-04
> **文档性质**: 理论设计 + 逻辑实现方案（不含代码实现）
> **目标**: 为 Java 开发者提供侧边栏实时文档浏览，支持双向联动导航

---

## 目录

1. [项目概述](#1-项目概述)
2. [系统架构设计](#2-系统架构设计)
3. [核心模块设计](#3-核心模块设计)
4. [解析器与数据结构设计](#4-解析器与数据结构设计)
5. [Webview UI 与交互设计](#5-webview-ui-与交互设计)
6. [容错与边界处理](#6-容错与边界处理)
7. [性能优化策略](#7-性能优化策略)
8. [开发规划与里程碑](#8-开发规划与里程碑)
9. [附录：知识库 FAQ](#9-附录知识库-faq)

---

## 1. 项目概述

### 1.1 问题背景

在大型 Java 项目中，开发者频繁需要查看方法注释来理解业务逻辑。当前的体验存在以下痛点：

| 痛点 | 描述 |
|------|------|
| **注释分散** | Javadoc 散落在代码各处，需要反复滚动查找 |
| **上下文中断** | 跳转查看注释后，需要手动回到原来的编辑位置 |
| **全局视角缺失** | 无法一次性纵览一个类的所有方法文档 |
| **Javadoc 可读性差** | 原始 `@param`、`@return` 标签在代码中不够直观 |

### 1.2 解决方案

开发一个 VS Code 侧边栏扩展 **JavaDoc Sidebar**，将当前打开的 Java 文件中的类注释和方法注释，以结构化、可交互的方式展示在侧边栏中。

### 1.3 核心特性

| 特性 | 说明 |
|------|------|
| **实时文档侧边栏** | 自动解析当前 Java 文件，侧边栏展示类和方法的 Javadoc |
| **Javadoc 表格化渲染** | `@param`、`@return`、`@throws` 标签以表格形式展示 |
| **正向跳转** | 点击侧边栏条目 → 代码编辑器跳转到对应方法 |
| **反向联动** | 代码中移动光标 → 侧边栏自动高亮并滚动到对应方法 |
| **扁平化结构** | 内部类的方法与外部类方法统一平铺展示，不做嵌套 |
| **无注释标识** | 没有 Javadoc 的方法以灰色样式标记"无注释" |

### 1.4 技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 扩展宿主 | TypeScript + VS Code Extension API | 扩展开发唯一可选语言 |
| 前端渲染 | HTML + CSS + 原生 JavaScript | Webview 内运行，无需框架 |
| Javadoc 解析 | 正则表达式 + `DocumentSymbolProvider` | 轻量级，无外部 AST 依赖 |
| Markdown 转 HTML | markdown-it 库 | 处理 Javadoc 中的 Markdown 格式文本 |
| 安全防护 | Content-Security-Policy + DOMPurify | 防止 XSS 注入 |

### 1.5 项目结构（独立仓库）

```
java-doc-sidebar/
├── .vscode/
│   └── launch.json               # 扩展调试配置
├── src/
│   ├── extension.ts              # 扩展入口，注册 Provider 和事件
│   ├── SidebarProvider.ts        # WebviewViewProvider 实现
│   ├── parser/
│   │   ├── JavaDocParser.ts      # Javadoc 解析核心逻辑
│   │   ├── SymbolResolver.ts     # DocumentSymbol 获取与处理
│   │   └── TagParser.ts          # @param/@return/@throws 标签解析
│   ├── types.ts                  # 所有 TypeScript 接口定义
│   └── utils/
│       ├── debounce.ts           # 防抖工具
│       └── binarySearch.ts       # 二分查找（光标定位方法）
├── media/
│   ├── sidebar.html              # Webview HTML 模板
│   ├── sidebar.css               # 侧边栏样式
│   └── sidebar.js                # Webview 前端交互逻辑
├── test/
│   ├── parser.test.ts            # 解析器单元测试
│   └── fixtures/                 # 测试用 Java 文件
│       ├── SimpleClass.java
│       ├── OverloadedMethods.java
│       └── NoComments.java
├── package.json                  # 扩展清单（contributes, activationEvents）
├── tsconfig.json
├── .eslintrc.json
└── README.md
```

---

## 2. 系统架构设计

### 2.1 整体架构

扩展由两个运行环境组成，通过消息机制通信：

```mermaid
flowchart TB
    subgraph Host["VS Code 宿主进程"]
        subgraph EH["Extension Host"]
            L1["事件监听层<br/>onSave / onSelect / onActivate"]
            L2["解析器层<br/>Symbol解析 / Javadoc提取 / 标签解析"]
            L3["数据组装层<br/>JSON序列化 / ID生成"]
            L1 --> L2 --> L3
        end
        subgraph WV["Webview (侧边栏)"]
            R1["渲染引擎<br/>列表渲染 / 表格渲染 / 高亮控制"]
            R2["交互控制层<br/>点击跳转 / 滚动联动 / 折叠·展开"]
            R1 --- R2
        end
        L2 <-->|"消息通道"| R2
        L3 -->|"postMessage"| WV
    end
```

### 2.2 消息协议设计

Extension Host 与 Webview 之间通过 `postMessage` 通信。需要定义明确的消息类型：

**Extension → Webview（下行消息）：**

| 消息类型 | 触发时机 | 携带数据 | 作用 |
|---------|---------|---------|------|
| `updateView` | 文件保存 / 切换文件 | 完整的 `ClassDoc` JSON | 全量刷新侧边栏内容 |
| `highlightMethod` | 光标移动（防抖后） | `{ id: string }` | 高亮并滚动到指定方法条目 |
| `clearView` | 关闭编辑器 / 切换到非 Java 文件 | 无 | 清空侧边栏，显示占位提示 |

**Webview → Extension（上行消息）：**

| 消息类型 | 触发时机 | 携带数据 | 作用 |
|---------|---------|---------|------|
| `jumpToLine` | 用户点击方法条目 | `{ line: number }` | 代码编辑器跳转到目标行 |
| `webviewReady` | Webview DOM 加载完成 | 无 | 通知 Extension 可以发送数据 |

### 2.3 事件驱动模型

```mermaid
flowchart LR
    E1["onDidSaveTextDocument"] --> P1["重新解析文档<br/>(仅 .java 文件)"] --> O1["发送 updateView"]

    E2["onDidChangeActiveTextEditor"] --> P2{"是否为 Java 文件?"}
    P2 -->|是| O2a["解析并发送 updateView"]
    P2 -->|否| O2b["发送 clearView"]

    E3["onDidChangeTextEditorSelection"] --> P3["防抖(300ms)<br/>二分查找当前方法<br/>与上次对比"]
    P3 -->|不同| O3a["发送 highlightMethod"]
    P3 -->|相同| O3b["忽略"]

    E4["Webview click"] --> P4["接收 jumpToLine<br/>editor.revealRange 居中显示"] --> O4["跳转到目标行"]
```

---

## 3. 核心模块设计

### 3.1 模块职责划分

| 模块文件 | 职责 | 输入 | 输出 |
|---------|------|------|------|
| `extension.ts` | 扩展生命周期管理，注册 Provider 和事件监听器 | VS Code 激活上下文 | 注册完成的 Disposable |
| `SidebarProvider.ts` | 管理 Webview 生命周期，协调解析器和 Webview 通信 | TextDocument | 消息发送/接收 |
| `JavaDocParser.ts` | 从文档文本中提取 Javadoc 注释块 | 文件文本 + Symbol 列表 | `MethodDoc[]` |
| `SymbolResolver.ts` | 调用 VS Code Symbol API 获取类和方法结构 | TextDocument URI | `DocumentSymbol[]` |
| `TagParser.ts` | 解析 `@param`、`@return`、`@throws` 等标签 | Javadoc 原始文本 | `TagTable` 结构化数据 |

### 3.2 模块协作时序

一次完整的「文件保存 → 侧边栏刷新」流程：

```mermaid
sequenceDiagram
    participant U as 用户
    participant E as extension.ts
    participant S as SidebarProvider
    participant SR as SymbolResolver
    participant JD as JavaDocParser
    participant TP as TagParser
    participant W as Webview

    U->>E: 保存文件
    E->>E: 检查 languageId === 'java'
    E->>S: refresh(document)
    par
        S->>SR: resolve(document.uri)
        SR->>SR: 调用 vscode.executeDocumentSymbolProvider
        SR-->>JD: 返回 DocumentSymbol[]
    and
        JD->>JD: 等待 Symbol 结果
    end
    loop 遍历每个 Symbol
        JD->>JD: 读取 Symbol 上方文本
        JD->>JD: 正则匹配 /** ... */
        JD->>TP: 解析标签
        TP-->>JD: TagTable
        JD->>JD: 组装 MethodDoc 对象
    end
    JD-->>S: 返回 ClassDoc (含所有方法)
    S->>W: postMessage({ type:'updateView', data: classDoc })
    W->>W: 接收并渲染
```

### 3.3 Extension.ts — 入口模块设计

**职责**：扩展的 `activate` 函数，负责三件事。

#### 3.3.1 注册 WebviewViewProvider

- 调用 `vscode.window.registerWebviewViewProvider`
- ViewId 为 `javaDocSidebar`（需在 `package.json` 的 `contributes.views` 中声明）
- 容器位置：`explorer`（资源管理器侧边栏）或独立的 Activity Bar 图标

#### 3.3.2 注册文件事件监听

需要注册三个监听器：

| 事件 | 处理逻辑 | 备注 |
|------|---------|------|
| `onDidSaveTextDocument` | 若为 `.java` 文件，触发解析器重新解析并刷新 Webview | 主要刷新触发点 |
| `onDidChangeActiveTextEditor` | 切换编辑器标签时，若新文件是 Java 则刷新，否则清空侧边栏 | 处理文件切换场景 |
| `onDidChangeTextEditorSelection` | 光标移动时，防抖 300ms 后计算当前方法并通知 Webview 高亮 | 反向联动核心 |

#### 3.3.3 注册命令

| 命令 ID | 功能 | 触发方式 |
|---------|------|---------|
| `javaDocSidebar.refresh` | 手动强制刷新侧边栏 | 命令面板 / 侧边栏按钮 |
| `javaDocSidebar.toggleAutoSync` | 开关反向联动功能 | 命令面板 |

### 3.4 SidebarProvider — Webview 管理模块设计

**职责**：实现 `WebviewViewProvider` 接口，管理 Webview 的生命周期和消息路由。

#### 3.4.1 核心状态

| 状态字段 | 类型 | 用途 |
|---------|------|------|
| `_view` | `WebviewView \| undefined` | 当前 Webview 实例引用 |
| `_currentMethods` | `MethodDoc[]` | 当前解析结果缓存（用于反向联动的二分查找） |
| `_lastHighlightId` | `string \| null` | 上次高亮的方法 ID（避免重复发消息） |

#### 3.4.2 关键方法

| 方法 | 逻辑 |
|------|------|
| `resolveWebviewView()` | 创建 Webview，设置 `retainContextWhenHidden: true`，加载 HTML 模板，注册上行消息监听 |
| `refresh(document)` | 调用解析器，获取 `ClassDoc`，序列化为 JSON，通过 `postMessage` 发送给 Webview |
| `findMethodByLine(line)` | 在 `_currentMethods` 上执行二分查找，返回匹配的方法 ID |
| `handleJumpToLine(line)` | 接收 Webview 的跳转请求，构建 `Range`，调用 `editor.revealRange(..., InCenter)` |

#### 3.4.3 Webview 配置

```
Webview 选项:
├─ enableScripts: true            # 允许执行 JavaScript
├─ retainContextWhenHidden: true  # 切换标签不销毁状态
└─ localResourceRoots: [media/]   # 限制资源访问范围
```

### 3.5 Package.json 关键配置设计

扩展需要在 `package.json` 中声明以下配置：

#### 3.5.1 激活事件

```
activationEvents:
  - onLanguage:java               # 打开 Java 文件时激活
```

#### 3.5.2 视图容器贡献

```
contributes:
  viewsContainers:
    activitybar:
      - id: javaDocExplorer
        title: "JavaDoc"
        icon: media/icon.svg       # 侧边栏 Activity Bar 图标

  views:
    javaDocExplorer:
      - id: javaDocSidebar
        type: webview
        name: "方法文档"
```

#### 3.5.3 扩展依赖

```
extensionDependencies:
  - redhat.java                    # 依赖 Java 语言扩展提供 Symbol 能力
```

> **注意**：若用户未安装 `redhat.java`，`executeDocumentSymbolProvider` 将返回空数组。此时需要降级到纯正则解析（见第 6 节容错设计）。

---

## 4. 解析器与数据结构设计

### 4.1 数据结构定义

以下是解析器产出的核心数据结构，从 Extension Host 传递给 Webview：

#### 4.1.1 顶层结构 — ClassDoc

```
ClassDoc {
    className: string          // 类名，如 "UserService"
    classComment: string       // 类注释的纯文本描述（已去除标签）
    packageName: string        // 包名，如 "com.example.service"
    filePath: string           // 文件路径（用于标题展示）
    methods: MethodDoc[]       // 方法列表（扁平化，含内部类的方法）
}
```

#### 4.1.2 方法文档 — MethodDoc

```
MethodDoc {
    id: string                 // 唯一标识，格式: "方法名_行号"，如 "findById_45"
    name: string               // 方法名，如 "findById"
    signature: string          // 完整签名，如 "public User findById(Long id)"
    startLine: number          // 方法起始行号（用于跳转和反向定位）
    endLine: number            // 方法结束行号（用于判断光标是否在方法内）
    hasComment: boolean        // 是否有 Javadoc 注释
    description: string        // Javadoc 的描述部分（第一段文本，不含标签）
    tags: TagTable             // 结构化标签数据（表格渲染用）
    belongsTo: string          // 所属类名（扁平化时标识来源），如 "UserService.InnerHelper"
    accessModifier: string     // 访问修饰符: "public" | "protected" | "private" | "default"
}
```

#### 4.1.3 标签表格 — TagTable

这是 Javadoc 标签结构化后的核心数据，直接用于前端表格渲染。

```
TagTable {
    params: ParamTag[]         // @param 标签列表
    returns: ReturnTag | null  // @return 标签（可能不存在）
    throws: ThrowsTag[]        // @throws / @exception 标签列表
    since: string | null       // @since 标签
    author: string | null      // @author 标签
    deprecated: string | null  // @deprecated 标签
    see: string[]              // @see 标签列表
}

ParamTag {
    name: string               // 参数名，如 "id"
    type: string               // 参数类型，如 "Long"（从方法签名中提取）
    description: string        // 参数描述，如 "用户的唯一标识"
}

ReturnTag {
    type: string               // 返回类型，如 "User"（从方法签名中提取）
    description: string        // 返回值描述，如 "匹配的用户对象，不存在则返回 null"
}

ThrowsTag {
    type: string               // 异常类型，如 "IllegalArgumentException"
    description: string        // 异常描述，如 "当 id 为 null 时抛出"
}
```

### 4.2 解析器流程设计

#### 4.2.1 整体解析流水线

```mermaid
flowchart TB
    In["输入: TextDocument (Java 文件)"]
    S1["步骤1: 获取 Symbol 树<br/>调用 executeDocumentSymbolProvider<br/>获取类、方法的名称和行号范围"]
    S2["步骤2: 扁平化 Symbol 列表<br/>递归遍历 Symbol 树<br/>提取所有 SymbolKind.Method<br/>忽略 SymbolKind.Field / Property"]
    S3["步骤3: 提取 Javadoc 块<br/>读取 Symbol.range.start.line 上方文本<br/>正则匹配 /\/\*\*[\s\S]*?\*\//"]
    S4["步骤4: 解析标签<br/>描述部分（第一个 @tag 之前的文本）<br/>标签部分（@param, @return 等）"]
    S5["步骤5: 组装数据<br/>填充 MethodDoc 对象<br/>生成唯一 ID: 方法名_行号<br/>标记 hasComment"]
    Out["输出: ClassDoc (JSON-ready)"]
    In --> S1 --> S2 --> S3 --> S4 --> S5 --> Out
```

#### 4.2.2 Javadoc 块提取逻辑

**目标**：给定一个方法的起始行号，向上搜索找到最近的 `/** ... */` 注释块。

**搜索规则**：

1. 从方法定义行向上逐行扫描
2. 跳过空行和单行注解（`@Override`、`@Transactional` 等）
3. 遇到 `*/` 标记开始捕获
4. 遇到 `/**` 标记结束捕获
5. 如果遇到非注释、非注解、非空行的内容（如上一个方法的 `}`），则判定该方法无注释

**需要跳过的行模式**：

| 模式 | 示例 | 处理 |
|------|------|------|
| 空行 | ` ` | 跳过，继续向上 |
| Java 注解 | `@Override` / `@Transactional(readOnly = true)` | 跳过，继续向上 |
| 多行注解 | `@RequestMapping(\n value = "/api"\n)` | 跳过，继续向上 |
| 单行注释 | `// some comment` | 停止搜索，标记无 Javadoc |
| 代码行 | `}` / `return x;` | 停止搜索，标记无 Javadoc |

#### 4.2.3 TagParser — 标签解析逻辑

**输入**：Javadoc 注释的纯文本（已去除 `/**` 和 `*/` 以及每行开头的 ` * `）

**解析步骤**：

```
步骤 A: 清洗原始文本
  - 移除首尾的 /** 和 */
  - 移除每行开头的 " * " 前缀
  - 保留换行符用于后续分割

步骤 B: 分离描述和标签
  - 扫描文本，找到第一个 "@" 符号的位置（行首位置）
  - 该位置之前的所有文本 → description
  - 该位置之后的所有文本 → rawTags

步骤 C: 逐个解析标签
  - 使用正则按 @tag 分割: /@(param|return|returns|throws|exception|since|author|deprecated|see)\s+/
  - 每段文本对应一个标签实例

步骤 D: @param 特殊处理
  - 格式: "@param paramName 描述文字"
  - 提取参数名（第一个单词）和描述（剩余文字）
  - 参数类型从方法签名中交叉匹配获取（不在 Javadoc 中）

步骤 E: @return 特殊处理
  - 格式: "@return 描述文字"
  - 返回类型从方法签名中提取

步骤 F: @throws 特殊处理
  - 格式: "@throws ExceptionType 描述文字"
  - 提取异常类型（第一个单词）和描述（剩余文字）
```

#### 4.2.4 方法签名解析（提取类型信息）

TagParser 需要从方法签名中提取参数类型和返回类型，以补充 Javadoc 标签中缺失的类型信息。

**方法签名模式**：

```
[修饰符] [泛型] 返回类型 方法名(参数类型1 参数名1, 参数类型2 参数名2, ...) [throws ...]
```

**典型示例与提取结果**：

| 方法签名 | 提取的返回类型 | 提取的参数表 |
|---------|--------------|------------|
| `public User findById(Long id)` | `User` | `[{name:"id", type:"Long"}]` |
| `public List<User> findAll()` | `List<User>` | `[]` |
| `public void save(User user, boolean force)` | `void` | `[{name:"user", type:"User"}, {name:"force", type:"boolean"}]` |
| `public <T> T convert(Object source, Class<T> target)` | `T` | `[{name:"source", type:"Object"}, {name:"target", type:"Class<T>"}]` |

**泛型处理策略**：使用栈计数 `<` 和 `>` 来正确处理嵌套泛型（如 `Map<String, List<User>>`），避免将 `>` 之后的内容误判为新参数。

### 4.3 扁平化策略

#### 4.3.1 问题描述

Java 文件中可能存在内部类：

```
public class OuterService {
    public void outerMethod() { ... }

    private static class InnerHelper {
        public void innerMethod() { ... }
    }

    public enum Status {
        // 枚举不含需要展示的方法
    }
}
```

#### 4.3.2 扁平化规则

| 规则 | 描述 |
|------|------|
| **平铺展示** | 不区分内部类层级，所有方法统一排列 |
| **来源标识** | `MethodDoc.belongsTo` 标记方法所属类名，如 `"InnerHelper"` |
| **排序规则** | 按方法在文件中的行号从小到大排列（保持代码阅读顺序） |
| **分隔标识** | 当 `belongsTo` 值发生变化时，前端渲染一条分隔线 + 类名标题 |
| **过滤规则** | 跳过枚举常量、字段声明、静态初始化块 |

#### 4.3.3 Symbol 树递归遍历逻辑

```
函数 flattenSymbols(symbols, parentName = ""):
    结果列表 = []

    对于每个 symbol in symbols:
        如果 symbol.kind == Class 或 Interface:
            // 记录类名，用于标记 belongsTo
            currentClass = parentName ? parentName + "." + symbol.name : symbol.name

            // 递归处理子 Symbol
            结果列表.push(...flattenSymbols(symbol.children, currentClass))

        如果 symbol.kind == Method 或 Constructor:
            // 这是我们要提取的目标
            结果列表.push({
                symbol: symbol,
                belongsTo: parentName || 文件主类名
            })

        // 忽略: Field, Property, Enum, EnumMember, Variable

    返回 结果列表（按 startLine 排序）
```

### 4.4 唯一 ID 生成策略

**格式**: `{方法名}_{起始行号}`

| 场景 | 方法签名 | 行号 | 生成 ID |
|------|---------|------|---------|
| 普通方法 | `findById(Long id)` | 45 | `findById_45` |
| 重载方法 A | `save(User user)` | 78 | `save_78` |
| 重载方法 B | `save(User user, boolean force)` | 92 | `save_92` |
| 构造函数 | `UserService()` | 12 | `UserService_12` |
| 内部类方法 | `InnerHelper.process()` | 130 | `process_130` |

**为何选择行号而非参数签名**：
- 行号天然唯一（同一文件中不可能有两个方法在同一行开始）
- 无需处理泛型参数导致的 ID 过长问题
- 每次刷新都会重新解析，行号变化不影响一致性

### 4.5 完整数据示例

给定以下 Java 代码：

```java
package com.example.service;

/**
 * 用户服务类，提供用户相关的核心业务操作。
 * @author zhangsan
 * @since 1.0
 */
public class UserService {

    /**
     * 根据ID查找用户。
     *
     * @param id 用户的唯一标识
     * @return 匹配的用户对象，不存在则返回 null
     * @throws IllegalArgumentException 当 id 为 null 时抛出
     */
    public User findById(Long id) { ... }

    // 这个方法没有 Javadoc
    public void deleteById(Long id) { ... }
}
```

解析器输出的 JSON 数据结构：

```json
{
    "className": "UserService",
    "classComment": "用户服务类，提供用户相关的核心业务操作。",
    "packageName": "com.example.service",
    "methods": [
        {
            "id": "findById_17",
            "name": "findById",
            "signature": "public User findById(Long id)",
            "startLine": 17,
            "endLine": 19,
            "hasComment": true,
            "description": "根据ID查找用户。",
            "tags": {
                "params": [
                    { "name": "id", "type": "Long", "description": "用户的唯一标识" }
                ],
                "returns": {
                    "type": "User",
                    "description": "匹配的用户对象，不存在则返回 null"
                },
                "throws": [
                    { "type": "IllegalArgumentException", "description": "当 id 为 null 时抛出" }
                ],
                "since": null,
                "author": null,
                "deprecated": null,
                "see": []
            },
            "belongsTo": "UserService",
            "accessModifier": "public"
        },
        {
            "id": "deleteById_22",
            "name": "deleteById",
            "signature": "public void deleteById(Long id)",
            "startLine": 22,
            "endLine": 24,
            "hasComment": false,
            "description": "",
            "tags": {
                "params": [],
                "returns": null,
                "throws": [],
                "since": null,
                "author": null,
                "deprecated": null,
                "see": []
            },
            "belongsTo": "UserService",
            "accessModifier": "public"
        }
    ]
}
```

---

## 5. Webview UI 与交互设计

### 5.1 页面整体布局

侧边栏 Webview 的 UI 分为三个区域：

```
┌─────────────────────────────┐
│  顶部栏                     │
│  ┌──────────────────────┐   │
│  │  UserService        │   │
│  │ com.example.service  │   │
│  │ [刷新按钮]           │   │
│  └──────────────────────┘   │
├─────────────────────────────┤
│  类注释区域                 │
│  ┌──────────────────────┐   │
│  │ 用户服务类，提供用户 │   │
│  │ 相关的核心业务操作。 │   │
│  └──────────────────────┘   │
├─────────────────────────────┤
│  方法列表区域（可滚动）     │
│                             │
│  ┌───────────────────────┐  │
│  │ ▶ findById            │  │  ← 可折叠/展开
│  │   public User ...     │  │
│  │                       │  │
│  │   描述: 根据ID查找..  │  │
│  │                       │  │
│  │   ┌────────────────┐  │  │
│  │   │ 参数表格       │  │  │  ← @param 表格
│  │   │ 名称  │ 类型   │  │  │
│  │   │ id    │ Long   │  │  │
│  │   └────────────────┘  │  │
│  │                       │  │
│  │   ┌────────────────┐  │  │
│  │   │ 返回值表格     │  │  │  ← @return 表格
│  │   └────────────────┘  │  │
│  │                       │  │
│  │   ┌────────────────┐  │  │
│  │   │ 异常表格       │  │  │  ← @throws 表格
│  │   └────────────────┘  │  │
│  └───────────────────────┘  │
│                             │
│  ┌───────────────────────┐  │
│  │ ▶ deleteById          │  │  ← 灰色样式（无注释）
│  │   public void ...     │  │
│  │   ⚠ 无注释            │  │
│  └───────────────────────┘  │
│                             │
│  ── InnerHelper ──────────  │  ← 类分隔线
│                             │
│  ┌───────────────────────┐  │
│  │ ▶ process             │  │
│  │   ...                 │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
```

### 5.2 Javadoc 标签表格渲染规范

这是核心 UI 需求。每个标签类型渲染为独立的表格。

#### 5.2.1 @param 表格

**表头**: 参数 (Parameters)

| 列名 | 数据来源 | 宽度比例 | 对齐 |
|------|---------|---------|------|
| 参数名 | `ParamTag.name` | 25% | 左对齐 |
| 类型 | `ParamTag.type`（从签名提取） | 25% | 左对齐，代码字体 |
| 描述 | `ParamTag.description` | 50% | 左对齐 |

**渲染示例**:

```
参数 (Parameters)
┌──────────┬────────────────┬──────────────────────┐
│ 参数名   │ 类型           │ 描述                 │
├──────────┼────────────────┼──────────────────────┤
│ id       │ Long           │ 用户的唯一标识       │
│ force    │ boolean        │ 是否强制覆盖         │
└──────────┴────────────────┴──────────────────────┘
```

#### 5.2.2 @return 表格

**表头**: 返回值 (Returns)

| 列名 | 数据来源 | 宽度比例 |
|------|---------|---------|
| 类型 | `ReturnTag.type`（从签名提取） | 30% |
| 描述 | `ReturnTag.description` | 70% |

**渲染示例**:

```
返回值 (Returns)
┌────────────────┬────────────────────────────────────┐
│ 类型           │ 描述                               │
├────────────────┼────────────────────────────────────┤
│ User           │ 匹配的用户对象，不存在则返回 null  │
└────────────────┴────────────────────────────────────┘
```

**特殊情况**: 当返回类型为 `void` 时，不渲染此表格。

#### 5.2.3 @throws 表格

**表头**: 异常 (Throws)

| 列名 | 数据来源 | 宽度比例 |
|------|---------|---------|
| 异常类型 | `ThrowsTag.type` | 40% |
| 触发条件 | `ThrowsTag.description` | 60% |

**渲染示例**:

```
异常 (Throws)
┌──────────────────────────┬──────────────────────────┐
│ 异常类型                 │ 触发条件                 │
├──────────────────────────┼──────────────────────────┤
│ IllegalArgumentException │ 当 id 为 null 时抛出     │
│ EntityNotFoundException  │ 当用户不存在时抛出       │
└──────────────────────────┴──────────────────────────┘
```

#### 5.2.4 其他标签渲染

非表格类标签以键值对形式渲染：

```
┌──────────────────────────────────┐
│ @since    1.0                    │
│ @author   zhangsan               │
│ @see      UserRepository         │
│ @deprecated 请使用 findUserById  │
└──────────────────────────────────┘
```

`@deprecated` 标签需要特殊样式：添加黄色警告背景和删除线。

### 5.3 样式设计规范

#### 5.3.1 颜色体系（适配 VS Code 主题）

侧边栏必须适配用户的 VS Code 主题（亮色/暗色）。使用 VS Code CSS 变量：

| 用途 | CSS 变量 | 说明 |
|------|---------|------|
| 背景色 | `var(--vscode-sideBar-background)` | 侧边栏背景 |
| 前景色 | `var(--vscode-sideBar-foreground)` | 主要文字颜色 |
| 方法名 | `var(--vscode-textLink-foreground)` | 可点击的方法名 |
| 表格边框 | `var(--vscode-widget-border)` | 表格线条 |
| 表头背景 | `var(--vscode-editor-lineHighlightBackground)` | 表格标题行 |
| 高亮背景 | `var(--vscode-list-activeSelectionBackground)` | 反向联动高亮 |
| 无注释文字 | `var(--vscode-disabledForeground)` | 灰色文字 |
| 代码字体 | `var(--vscode-editor-font-family)` | 类型列的等宽字体 |

#### 5.3.2 方法条目状态样式

| 状态 | 视觉表现 |
|------|---------|
| **默认** | 白色/深色背景，正常文字 |
| **悬停 (hover)** | 轻微背景色变化，光标变为 pointer |
| **高亮 (active)** | 左侧蓝色边框（3px），浅蓝/深蓝背景色 |
| **无注释** | 整体灰色调，方法名用斜体，显示 "⚠ 无注释" 占位 |
| **@deprecated** | 方法名添加删除线，描述区域黄色警告底色 |

#### 5.3.3 折叠/展开交互

- 每个方法条目默认**展开**显示
- 点击方法名左侧的三角形图标可**折叠**（仅显示方法名和签名，隐藏表格）
- 折叠状态在 Webview 生命周期内保持（切换文件时重置）
- 提供全局"全部折叠/展开"按钮（在顶部栏）

### 5.4 交互行为设计

#### 5.4.1 正向跳转（点击方法名 → 跳转代码）

**触发**: 用户点击侧边栏中的方法名文字

**处理流程**:

```
1. 前端捕获 click 事件
2. 从 DOM 元素的 data-line 属性读取行号
3. 发送消息: { command: 'jumpToLine', line: 45 }
4. Extension 接收消息
5. 获取 activeTextEditor
6. 构建 Range 对象: new Range(line, 0, line, 0)
7. 调用 editor.revealRange(range, TextEditorRevealType.InCenter)
8. 同时设置光标位置: editor.selection = new Selection(range.start, range.start)
```

**注意**: 步骤 7 和 8 必须同时执行——仅 `revealRange` 会滚动但不移动光标，用户体验不完整。

#### 5.4.2 反向联动（光标移动 → 侧边栏高亮）

**触发**: 用户在代码编辑器中移动光标

**处理流程**:

```
1. onDidChangeTextEditorSelection 触发
2. 检查: languageId === 'java' ? 否 → 忽略
3. 防抖: 清除上次计时器，设置 300ms 延迟
4. 延迟到期后执行:
   a. 获取光标行号: event.selections[0].active.line
   b. 二分查找: 在 _currentMethods 中找到 startLine <= cursorLine <= endLine 的方法
   c. 比较: 找到的方法 ID === _lastHighlightId ?
      - 相同 → 忽略（避免重复通信）
      - 不同 → 更新 _lastHighlightId，发送 highlightMethod 消息
5. Webview 接收消息:
   a. 移除所有 .active 类
   b. 给目标元素添加 .active 类
   c. scrollIntoView({ behavior: 'smooth', block: 'center' })
```

**二分查找算法**:

```
输入: methods[] (按 startLine 升序), cursorLine
输出: 匹配的 MethodDoc 或 null

lo = 0, hi = methods.length - 1
result = null

循环 (lo <= hi):
    mid = (lo + hi) / 2 取整
    如果 methods[mid].startLine <= cursorLine:
        result = methods[mid]    // 候选结果（可能还有更靠后的）
        lo = mid + 1             // 继续向右搜索
    否则:
        hi = mid - 1             // 目标在左侧

返回: result 且 result.endLine >= cursorLine ? result : null
```

#### 5.4.3 空状态与占位显示

| 场景 | 侧边栏显示 |
|------|---------|
| 未打开任何文件 | 居中图标 + "打开 Java 文件以查看文档" |
| 打开的是非 Java 文件 | 居中图标 + "仅支持 Java 文件" |
| Java 文件无任何方法 | 类信息正常显示 + "该类没有方法定义" |
| 解析器出错 | 错误图标 + "解析失败，点击重试" + 重试按钮 |

### 5.5 Content-Security-Policy 配置

Webview 必须设置 CSP 头以防止 XSS：

```
策略规则:
  default-src  'none'                           # 默认禁止所有
  style-src    ${webview.cspSource} 'unsafe-inline'  # 允许内联样式（VS Code 主题变量需要）
  script-src   'nonce-${nonce}'                  # 仅允许带指定 nonce 的脚本
  font-src     ${webview.cspSource}              # 允许加载字体
  img-src      ${webview.cspSource}              # 允许加载图片
```

**nonce 机制**: 每次 Webview 创建时生成随机 nonce 值，注入到 `<script nonce="xxx">` 标签中。未携带 nonce 的脚本将被浏览器拒绝执行。

---

## 6. 容错与边界处理

### 6.1 容错场景总览

| 编号 | 场景 | 风险等级 | 处理策略 |
|------|------|---------|---------|
| E1 | 用户未安装 Java 语言扩展 | 高 | 降级到纯正则解析 |
| E2 | Java 文件语法错误导致 Symbol 解析失败 | 中 | 捕获异常，使用上次缓存结果 |
| E3 | 超大文件（>5000 行） | 中 | 限制解析方法数量，显示截断提示 |
| E4 | Javadoc 格式不规范 | 低 | 尽力解析，未识别内容原样展示 |
| E5 | Webview 被用户关闭后又打开 | 低 | 重新触发解析，恢复视图 |
| E6 | 文件编码非 UTF-8 | 低 | VS Code 已处理编码转换，无需额外处理 |
| E7 | 多个编辑器同时打开 Java 文件 | 低 | 始终跟随 activeTextEditor |

### 6.2 E1 — 无 Java 语言扩展的降级方案

当 `executeDocumentSymbolProvider` 返回空数组或 `undefined` 时，启用纯正则解析模式。

**降级解析器逻辑**：

```
步骤 1: 用正则识别类声明
  模式: /(?:public|private|protected)?\s*(?:abstract|final)?\s*(?:class|interface|enum)\s+(\w+)/
  提取: 类名

步骤 2: 用正则识别方法声明
  模式: /(?:public|private|protected|static|final|abstract|synchronized|\s)*
         (?:<[\w\s,?]+>\s+)?          # 可选泛型
         ([\w<>\[\],\s?]+)\s+         # 返回类型
         (\w+)\s*                      # 方法名
         \(([^)]*)\)                   # 参数列表
         (?:\s*throws\s+[\w\s,]+)?    # 可选 throws
         \s*\{/                        # 方法体开始

  限制: 此正则无法准确获取方法的 endLine（需要花括号配对计数）

步骤 3: 花括号配对计算方法结束行
  从方法声明行开始，维护计数器:
    遇到 '{' → 计数器 +1
    遇到 '}' → 计数器 -1
    计数器归零 → 当前行即为 endLine

  注意: 需要排除字符串字面量和注释中的花括号
```

**降级模式的限制**：

| 能力 | Symbol 模式 | 降级模式 |
|------|------------|---------|
| 方法名和行号 | 精确 | 精确 |
| 方法结束行 | 精确 | 近似（花括号配对） |
| 内部类识别 | 精确 | 有限（仅一层嵌套） |
| 枚举/注解过滤 | 精确 | 可能误判 |
| 构造函数识别 | 精确 | 需要额外规则 |

**用户提示**: 降级模式下，在侧边栏顶部显示提示条："安装 'Language Support for Java' 扩展可获得更精确的解析结果"。

### 6.3 E2 — 语法错误时的缓存策略

```mermaid
flowchart TB
    Start["尝试解析当前文档"]
    Start --> Check{成功?}
    Check -->|成功| Update["更新缓存<br/>刷新 Webview"]
    Check -->|失败/空结果| Cache{"缓存存在?"}
    Cache -->|是| Keep["保持当前 Webview 不变<br/>顶部提示: 文件存在语法错误，显示上次解析结果"]
    Cache -->|否| Error["显示错误状态页面"]
```

**缓存结构**：以文件 URI 为 key，存储 `ClassDoc` 对象。仅保存当前编辑器打开的文件缓存（最多 10 个），避免内存膨胀。

### 6.4 E3 — 超大文件处理

**阈值设置**：

| 指标 | 阈值 | 处理 |
|------|------|------|
| 文件行数 | > 5000 行 | 显示警告，正常解析 |
| 方法数量 | > 200 个 | 仅展示前 200 个，显示截断提示 |
| 单个 Javadoc 块 | > 100 行 | 截断显示，保留前 50 行 + "..." |

### 6.5 E4 — 不规范 Javadoc 的兼容处理

| 不规范情况 | 示例 | 处理方式 |
|-----------|------|---------|
| 缺少 `@param` 描述 | `@param id` | description 设为空字符串，表格中该单元格显示 "-" |
| `@param` 参数名拼错 | `@param idx` (实际是 `id`) | 按原样展示，不做交叉验证 |
| 混用 `@throws` 和 `@exception` | `@exception IOException` | 统一归入 `throws` 数组 |
| 使用 HTML 标签 | `<b>重要</b>` | 通过 DOMPurify 清洗后保留安全标签 |
| 使用 `{@code}` 内联标签 | `{@code null}` | 转换为 `<code>null</code>` |
| 使用 `{@link}` 内联标签 | `{@link User}` | 转换为纯文本 `User`（不做跳转） |
| 多行 `@param` 描述 | 描述跨越多行 | 合并为单行，保留换行前的空格 |

---

## 7. 性能优化策略

### 7.1 性能瓶颈分析

| 操作 | 耗时来源 | 频率 | 优化优先级 |
|------|---------|------|-----------|
| Symbol 解析 | VS Code API 调用 | 每次保存 | 中 |
| Javadoc 正则匹配 | 文件文本扫描 | 每次保存 | 低 |
| Webview 渲染 | DOM 操作 | 每次刷新 | 中 |
| 反向联动计算 | 光标事件处理 | 极高频 | **高** |
| 消息通信 | postMessage 序列化 | 中频 | 低 |

### 7.2 优化措施

#### 7.2.1 反向联动防抖 + 去重

```mermaid
flowchart TB
    E["光标移动事件触发"]
    E --> C1["清除上次定时器"]
    C1 --> T["设置新定时器 (300ms)"]
    T --> D["定时器到期"]
    D --> BS["二分查找当前方法 → 获得 methodId"]
    BS --> Null{"methodId 为 null?<br/>(光标不在任何方法内)"}
    Null -->|是| Clear["发送 clearHighlight<br/>(取消高亮)"]
    Null -->|否| Same{"methodId === lastMethodId?"}
    Same -->|是| Skip["直接返回<br/>(不发消息)"]
    Same -->|否| Send["更新 lastMethodId<br/>发送 highlightMethod"]
```

**效果**: 在连续快速移动光标时（如按住方向键），300ms 内的所有事件只触发一次计算。相同方法内的移动完全不产生消息通信。

#### 7.2.2 Webview 增量更新

全量刷新（`updateView`）时重建整个 DOM 是必要的（文件结构可能完全变化）。但高亮联动（`highlightMethod`）只需操作 CSS 类，不应触发 DOM 重建。

```
消息处理策略:

updateView  → innerHTML 全量替换（不可避免）
highlight   → classList 操作（极轻量，O(1)）
```

#### 7.2.3 解析结果缓存

```
缓存策略:

Key: 文件 URI + 文件版本号 (TextDocument.version)
Value: ClassDoc 对象

判断逻辑:
  如果 缓存中存在相同 URI 且 version 匹配 → 直接使用缓存
  否则 → 重新解析并更新缓存
```

**version 属性**: VS Code 的 `TextDocument.version` 在每次编辑后自增。保存时如果内容未变，version 不变。这能避免"保存未修改文件"时的无效解析。

#### 7.2.4 延迟初始化

```
扩展激活策略:

activationEvents: onLanguage:java

激活后:
  - 立即注册 WebviewViewProvider（轻量操作）
  - 立即注册事件监听器（轻量操作）
  - 延迟首次解析到 Webview 实际可见时 (resolveWebviewView 回调中触发)
```

### 7.3 性能指标目标

| 指标 | 目标值 | 测量方法 |
|------|-------|---------|
| 文件保存到侧边栏刷新 | < 500ms | 从 onSave 到 Webview 渲染完成 |
| 光标移动到高亮响应 | < 400ms（含 300ms 防抖） | 从光标停止到高亮可见 |
| 点击条目到代码跳转 | < 100ms | 从 click 到编辑器滚动完成 |
| 内存占用 | < 10MB | 扩展进程内存增量 |
| 1000 行文件解析 | < 200ms | Symbol + Javadoc 解析总耗时 |

---

## 8. 开发规划与里程碑

### 8.1 阶段划分

#### Phase 1 — 基础骨架

**目标**: 完成最小可用版本，能展示方法列表和 Javadoc 纯文本。

| 任务 | 描述 |
|------|------|
| 项目初始化 | 使用 `yo code` 脚手架生成扩展项目结构 |
| WebviewViewProvider | 实现基础 Provider，能在侧边栏加载 HTML |
| SymbolResolver | 调用 `executeDocumentSymbolProvider` 获取方法列表 |
| 基础解析器 | 提取方法名、行号、Javadoc 纯文本（不解析标签） |
| 基础渲染 | Webview 展示方法名列表 + 纯文本注释 |
| 文件保存刷新 | 注册 `onDidSaveTextDocument` 触发重新解析 |

**交付物**: 保存 Java 文件后，侧边栏显示方法名和原始 Javadoc 文本。

#### Phase 2 — 核心交互

**目标**: 实现双向联动和正向跳转。

| 任务 | 描述 |
|------|------|
| 正向跳转 | 点击方法名 → 编辑器跳转到对应行并居中 |
| 反向联动 | 光标移动 → 侧边栏高亮对应方法（含防抖和去重） |
| 文件切换处理 | `onDidChangeActiveTextEditor` 切换文件时刷新或清空 |
| 二分查找 | 实现高效的光标-方法定位算法 |
| 状态样式 | hover、active、无注释等视觉状态 |

**交付物**: 编辑器和侧边栏双向联动顺畅。

#### Phase 3 — 表格渲染

**目标**: 实现 Javadoc 标签的表格化展示。

| 任务 | 描述 |
|------|------|
| TagParser | 实现 `@param`、`@return`、`@throws` 标签解析 |
| 签名解析 | 从方法签名提取参数类型和返回类型 |
| 表格 UI | 实现三种标签表格的 HTML/CSS 渲染 |
| 折叠/展开 | 每个方法条目支持折叠，隐藏/显示表格细节 |
| 内联标签 | 处理 `{@code}`、`{@link}` 等内联标签 |
| 主题适配 | 使用 VS Code CSS 变量适配亮色/暗色主题 |

**交付物**: Javadoc 标签以格式化表格展示，视觉效果完整。

#### Phase 4 — 健壮性

**目标**: 处理各种边界情况和容错逻辑。

| 任务 | 描述 |
|------|------|
| 降级解析器 | 无 Java 语言扩展时的纯正则解析方案 |
| 缓存机制 | 基于文件 URI + version 的解析结果缓存 |
| 语法错误容错 | 文件有语法错误时保持上次解析结果 |
| 超大文件处理 | 方法数量截断和 Javadoc 长度限制 |
| 不规范 Javadoc | 兼容各种非标准写法 |
| CSP 安全 | 配置 Content-Security-Policy，DOMPurify 集成 |
| 重载方法 ID | 使用行号后缀确保唯一性 |

**交付物**: 在各种异常情况下扩展保持稳定运行。

#### Phase 5 — 打磨发布

**目标**: 优化体验，准备发布到 VS Code Marketplace。

| 任务 | 描述 |
|------|------|
| 性能调优 | 验证性能指标，优化瓶颈 |
| 手动刷新 | 添加刷新按钮和全部折叠/展开按钮 |
| 配置项 | 用户可配置：防抖时间、最大方法数、是否启用反向联动 |
| 扩展图标 | 设计 Activity Bar 图标和 Marketplace 图标 |
| README | 编写使用说明和 GIF 演示 |
| 打包发布 | 使用 `vsce package` 打包，发布到 Marketplace |
| 单元测试 | 解析器和工具函数的测试覆盖 |

### 8.2 package.json 配置规划

```
配置项 (contributes.configuration):

javaDocSidebar.enableAutoHighlight
    类型: boolean
    默认: true
    描述: 是否启用光标移动时的反向联动高亮

javaDocSidebar.debounceDelay
    类型: number
    默认: 300
    范围: 100 - 1000
    描述: 反向联动的防抖延迟（毫秒）

javaDocSidebar.maxMethods
    类型: number
    默认: 200
    描述: 侧边栏最多展示的方法数量

javaDocSidebar.defaultCollapsed
    类型: boolean
    默认: false
    描述: 方法条目是否默认折叠
```

---

## 9. 附录：知识库 FAQ

### Q1: 为什么不使用 Tree-sitter 或 ANTLR 等 AST 解析库？

**A**: 权衡了复杂度和收益。

| 方案 | 优势 | 劣势 |
|------|------|------|
| Symbol Provider + 正则 | 零额外依赖，包体积小，VS Code 原生支持 | 降级模式下解析精度有限 |
| Tree-sitter | 精确的 AST，无需语言扩展 | 需要 WASM 加载，包体积增大约 2MB |
| ANTLR | 完整的 Java 语法解析 | 运行时庞大，冷启动慢 |

当前选择 Symbol Provider 是最佳起步方案。如果后续降级模式需求增多，可以引入 Tree-sitter 的 Java grammar 作为可选依赖。

### Q2: retainContextWhenHidden 会增加多少内存？

**A**: Webview 的 DOM 和 JavaScript 上下文会保留在内存中。对于本扩展（单页面，DOM 节点通常 < 500 个），额外内存约 2-5MB，可接受。如果不设置此选项，用户每次切换回侧边栏都会触发完整的重新解析和渲染，体验更差。

### Q3: 如何处理多 Root Workspace（多文件夹工作区）？

**A**: 扩展始终跟随 `activeTextEditor`，与工作区结构无关。无论用户打开的是哪个 workspace folder 中的 Java 文件，解析逻辑都是基于单个 `TextDocument` 的，不需要感知 workspace 结构。

### Q4: 是否需要支持 Kotlin / Scala 等 JVM 语言？

**A**: 初版仅支持 Java。Kotlin 使用 KDoc（`/** ... */` 语法相同但标签不同，如 `@property`），Scala 使用 ScalaDoc。如果要扩展，需要为每种语言编写独立的 TagParser，但 SidebarProvider 和 Webview 层可以复用。

### Q5: 如何调试 Webview 内的 JavaScript？

**A**: 在 VS Code 中按 `Ctrl+Shift+P` → "Developer: Open Webview Developer Tools"。这会打开类似 Chrome DevTools 的调试面板，可以查看 Webview 的 DOM、Console 和 Network。

### Q6: 发布到 Marketplace 需要什么条件？

**A**: 需要以下准备：

1. 注册 Azure DevOps 账号，获取 Personal Access Token (PAT)
2. 安装 `vsce` CLI 工具 (`npm install -g @vscode/vsce`)
3. 创建 Publisher（`vsce create-publisher <name>`）
4. `package.json` 中填写 `publisher`、`repository`、`icon` 等字段
5. 执行 `vsce publish` 即可上传

### Q7: 反向联动在 Vim 插件环境下是否正常工作？

**A**: 是的。`onDidChangeTextEditorSelection` 监听的是 VS Code 编辑器层的光标变化，与 Vim 扩展（如 vscodevim）兼容。Vim 的 Normal/Insert 模式切换和光标移动都会正确触发此事件。

---

> **文档维护说明**: 本文档为理论设计阶段产出，代码实现阶段应以此文档为蓝图，实现过程中如需调整方案，同步更新本文档对应章节。
