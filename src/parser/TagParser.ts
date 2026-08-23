/**
 * TagParser.ts - Javadoc 标签解析器
 *
 * 将原始 Javadoc 标签文本解析为结构化的 TagTable。
 *
 * 设计原因：
 * - UI 渲染需要稳定的类型化数据，而非原始文本。
 * - 当描述中包含 "@xxx" 文本时，基于行的分词比正则切分更安全。
 *
 * @author xiaowu
 * @since 2026/02/04
 */

import type {
  ParamTag,
  ReturnTag,
  TagTable,
  ThrowsTag,
  TypeTag,
  TypeDefTag,
  PropertyTag,
  YieldsTag,
  EventTag,
} from "../types.js";
import type { SupportedTag } from "./tagConstants.js";
import { TAG_LINE_PATTERN, SUPPORTED_TAG_SET } from "./tagConstants.js";

interface ParsedTagBlock {
  readonly tag: SupportedTag;
  readonly content: string;
}

/**
 * 匹配 SPDX 许可标识行的正则（无 @ 前缀的标准形式）。
 *
 * 文件头中的 `SPDX-License-Identifier: MIT` 是许可证标识的事实标准写法，
 * 需归一化为 license 标签处理；否则它不匹配 TAG_LINE_PATTERN，会被当作
 * 前一个标签（如 @author）的多行延续内容吞并，导致作者信息被污染。
 */
const SPDX_LICENSE_PATTERN = /^SPDX-License-Identifier:\s*(.+)$/i;

/**
 * 匹配未知 @标签行的正则（行首 @word 形态，但不在受支持标签列表内）。
 *
 * 受支持列表之外的 @xxx（如 @module、@file）是元数据行而非正文延续，
 * 若被当作前一个标签的多行延续吞并，会污染 @description/@author 等
 * 标签内容（例：`@description ...\n@module xxx` 会把 @module 并入描述）。
 */
const UNKNOWN_TAG_PATTERN = /^@\w+/;

/**
 * 参数前可忽略的修饰符集合
 */
const PARAM_MODIFIERS: ReadonlySet<string> = new Set(["final"]);

const JAVA_METHOD_MODIFIER_PREFIX =
  /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|default|native|strictfp|function|export|async)\s+)*/;

/**
 * 将 Javadoc 标签段解析为 TagTable。
 *
 * 设计原因：让下游渲染逻辑保持简单且类型安全。
 *
 * @param rawTags - 原始标签文本（从第一个 @tag 行开始）。
 * @param signature - 方法/构造函数签名，用于类型推断。
 * @returns 结构化的 TagTable。
 */
export function parseTagTable(rawTags: string, signature: string): TagTable {
  // 避免共享引用污染
  if (!rawTags.trim()) {
    return createEmptyTagTable();
  }

  const blocks = tokenizeTagBlocks(rawTags);
  if (blocks.length === 0) {
    return createEmptyTagTable();
  }

  const paramTypes = parseSignatureParams(signature);
  const returnType = parseReturnType(signature);

  const params: ParamTag[] = [];
  const throwsTags: ThrowsTag[] = [];
  const seeTags: string[] = [];
  const properties: PropertyTag[] = [];
  const templateTags: string[] = [];
  const todoTags: string[] = [];
  const emitsTags: EventTag[] = [];
  const listensTags: EventTag[] = [];
  const modifiers: string[] = [];

  let returnTag: ReturnTag | null = null;
  let since: string | null = null;
  let author: string | null = null;
  let license: string | null = null;
  let deprecated: string | null = null;
  let doc: string | null = null;
  let example: string | null = null;
  let typeTag: TypeTag | null = null;
  let typedefTag: TypeDefTag | null = null;
  let yieldsTag: YieldsTag | null = null;
  let summary: string | null = null;
  let descriptionTag: string | null = null;

  for (const block of blocks) {
    const content = block.content.trim();

    switch (block.tag) {
      case "param": {
        const parsed = parseParamTag(content, paramTypes);
        if (parsed) {
          params.push(parsed);
        }
        break;
      }

      case "return":
      case "returns": {
        // JSDoc {type} 语法优先
        const jsdocType = extractJSDocType(content);
        if (jsdocType) {
          returnTag = {
            type: jsdocType.type,
            description: jsdocType.rest,
          };
        } else if (returnType && returnType !== "void") {
          // 签名能推断出具体返回类型时才生成 @return 标签；
          // 无类型注解的 JS 函数（如 "function foo()"）推断为空，不生成空类型标签
          returnTag = {
            type: returnType,
            description: content,
          };
        }
        break;
      }

      case "throws":
      case "exception": {
        const parsed = parseThrowsTag(content);
        if (parsed) {
          throwsTags.push(parsed);
        }
        break;
      }

      case "since":
        since = content || null;
        break;

      case "author":
        author = content || null;
        break;

      case "license":
        license = content || null;
        break;

      case "deprecated":
        deprecated = content || null;
        break;

      case "see":
        if (content) {
          seeTags.push(content);
        }
        break;

      case "doc":
        doc = content || null;
        break;

      case "example":
        example = content || null;
        break;

      // ---- JSDoc 扩展标签 ----

      case "type": {
        const jsdocType = extractJSDocType(content);
        typeTag = {
          type: jsdocType?.type ?? content,
          description: jsdocType?.rest ?? "",
        };
        break;
      }

      case "typedef": {
        // @typedef {Object} Name description
        const jsdocType = extractJSDocType(content);
        const rest = jsdocType?.rest ?? content;
        const nameMatch = /^(\S+)\s*(.*)$/.exec(rest);
        typedefTag = {
          name: nameMatch?.[1] ?? "",
          type: jsdocType?.type ?? "",
          description: nameMatch?.[2]?.trim() ?? "",
        };
        break;
      }

      case "property":
      case "prop": {
        // @property {string} name - description
        const jsdocType = extractJSDocType(content);
        const rest = jsdocType?.rest ?? content;
        const propMatch = /^(\S+)\s*(?:-\s*)?(.*)$/.exec(rest);
        if (propMatch) {
          properties.push({
            name: propMatch[1] ?? "",
            type: jsdocType?.type ?? "unknown",
            description: propMatch[2]?.trim() ?? "",
          });
        }
        break;
      }

      case "template": {
        // @template T, U
        const names = content.split(/[,,\s]+/).filter((s) => s.length > 0);
        templateTags.push(...names);
        break;
      }

      case "yields":
      case "yield": {
        const jsdocType = extractJSDocType(content);
        yieldsTag = {
          type: jsdocType?.type ?? "unknown",
          description: jsdocType?.rest ?? content,
        };
        break;
      }

      case "summary":
        summary = content || null;
        break;

      case "description":
      case "desc":
        descriptionTag = content || null;
        break;

      case "todo":
        if (content) {
          todoTags.push(content);
        }
        break;

      case "emits":
      case "fires": {
        // @emits EventName description
        const match = /^(\S+)\s*(.*)$/.exec(content);
        if (match) {
          emitsTags.push({
            name: match[1] ?? "",
            description: match[2]?.trim() ?? "",
          });
        }
        break;
      }

      case "listens": {
        const match = /^(\S+)\s*(.*)$/.exec(content);
        if (match) {
          listensTags.push({
            name: match[1] ?? "",
            description: match[2]?.trim() ?? "",
          });
        }
        break;
      }

      case "readonly":
        modifiers.push("readonly");
        break;

      case "async":
        modifiers.push("async");
        break;

      case "override":
        modifiers.push("override");
        break;
    }
  }

  return {
    params,
    returns: returnTag,
    throws: throwsTags,
    since,
    author,
    license,
    deprecated,
    see: seeTags,
    doc,
    example,
    // JSDoc 扩展
    type: typeTag,
    typedef: typedefTag,
    properties,
    template: templateTags,
    yields: yieldsTag,
    summary,
    description: descriptionTag,
    todo: todoTags,
    emits: emitsTags,
    listens: listensTags,
    modifiers,
  };
}

/**
 * 构建一个全新的空 TagTable。
 * 设计原因：避免共享可变数组引用。
 */
export function createEmptyTagTable(): TagTable {
  return {
    params: [],
    returns: null,
    throws: [],
    since: null,
    author: null,
    license: null,
    deprecated: null,
    see: [],
    doc: null,
    example: null,
    // JSDoc 扩展
    type: null,
    typedef: null,
    properties: [],
    template: [],
    yields: null,
    summary: null,
    description: null,
    todo: [],
    emits: [],
    listens: [],
    modifiers: [],
  };
}

/**
 * 按行将原始标签文本分词为稳定的数据块。
 * 设计原因：当描述中包含作为纯文本的 "@tag" 时，正则切分会出错。
 */
function tokenizeTagBlocks(rawTags: string): readonly ParsedTagBlock[] {
  const blocks: ParsedTagBlock[] = [];
  const lines = rawTags.split(/\r?\n/);

  let activeTag: SupportedTag | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (!activeTag) {
      return;
    }
    blocks.push({
      tag: activeTag,
      content: buffer.join("\n").trim(),
    });
    activeTag = null;
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = normalizeJavadocLine(rawLine);
    // SPDX 许可标识行：归一化为 license 标签块（先于 @tag 匹配，
    // 避免被并入前一个标签的延续内容）
    const spdxMatch = SPDX_LICENSE_PATTERN.exec(line);
    if (spdxMatch?.[1]) {
      flush();
      activeTag = "license";
      buffer.push(spdxMatch[1].trim());
      continue;
    }
    const match = TAG_LINE_PATTERN.exec(line);
    if (match?.groups) {
      flush();
      const tagText = (match.groups["tag"] ?? "").toLowerCase();
      if (isSupportedTag(tagText)) {
        activeTag = tagText;
        buffer.push((match.groups["content"] ?? "").trim());
      }
      continue;
    }
    // 未知 @标签行：结束当前标签块，不作为延续文本（元数据而非正文）
    if (UNKNOWN_TAG_PATTERN.test(line)) {
      flush();
      continue;
    }
    if (activeTag) {
      buffer.push(line.trim());
    }
  }
  flush();
  return blocks;
}

/**
 * 解析前规范化单行 Javadoc。
 * 设计原因：输入可能仍保留原始注释行的前导 '*'。
 */
function normalizeJavadocLine(line: string): string {
  return line.replace(/^\s*\*\s?/, "");
}

function isSupportedTag(value: string): value is SupportedTag {
  return SUPPORTED_TAG_SET.has(value);
}

/**
 * 解析单个 @param 块。
 * 设计原因：同时支持普通参数和泛型类型参数（@param <T> ...）。
 */
/**
 * 从 JSDoc 标签内容中提取 {type} 语法
 *
 * @example
 *   "{string} name - desc" → { type: "string", rest: "name - desc" }
 *   "{Array<number>} items" → { type: "Array<number>", rest: "items" }
 *   "name - desc" → null (无 JSDoc 类型语法)
 */
function extractJSDocType(
  content: string,
): { type: string; rest: string } | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;

  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const type = trimmed.substring(1, i).trim();
        const rest = trimmed.substring(i + 1).trim();
        return type ? { type, rest } : null;
      }
    }
  }
  return null;
}

function parseParamTag(
  content: string,
  paramTypes: ReadonlyMap<string, string>,
): ParamTag | null {
  // JSDoc {type} 语法优先：@param {string} name - description
  const jsdocType = extractJSDocType(content);
  const effectiveContent = jsdocType?.rest ?? content;
  const jsdocTypeStr = jsdocType?.type;

  // 支持：普通名（name）/ 泛型参数（<T>）/ 点分路径（props.containerRef）/
  // 可选参数（[props.orientation='vertical']，去括号与默认值）
  const match =
    /^(<\s*[A-Za-z_$][\w$]*\s*>|\[?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:=[^\]]*)?\]?)\s*(.*)$/s.exec(
      effectiveContent,
    );
  if (!match) {
    return null;
  }

  let rawName = (match[1] ?? "").replace(/\s+/g, "");
  const isTypeParameter = rawName.startsWith("<") && rawName.endsWith(">");
  if (!isTypeParameter && rawName.startsWith("[")) {
    // 可选参数 [name=default]：去括号与默认值，保留点分路径
    rawName = rawName.slice(1, rawName.endsWith("]") ? -1 : undefined);
    const eqIdx = rawName.indexOf("=");
    if (eqIdx >= 0) {
      rawName = rawName.slice(0, eqIdx);
    }
  }
  // 去掉 JSDoc 描述前导连字符：name - description → description
  const description = (match[2] ?? "").replace(/^\s*-\s*/, "").trim();

  const type = isTypeParameter
    ? "type-parameter"
    : (jsdocTypeStr ?? paramTypes.get(rawName) ?? "unknown");

  return {
    name: rawName,
    type,
    description,
  };
}

/**
 * 解析单个 @throws/@exception 块。
 */
function parseThrowsTag(content: string): ThrowsTag | null {
  const match = /^([\w.]+)\s*(.*)$/s.exec(content);
  if (!match) {
    return null;
  }

  return {
    type: match[1] ?? "",
    description: (match[2] ?? "").trim(),
  };
}

/**
 * 从方法签名解析参数名 → 类型映射。
 * 设计原因：用具体参数类型丰富 @param 标签。
 */
function parseSignatureParams(signature: string): Map<string, string> {
  // 结果映射：name -> type
  const result = new Map<string, string>();
  const paramsText = extractParenContent(signature);

  if (!paramsText) {
    return result;
  }

  const declarations = splitByTopLevelComma(paramsText);
  for (const declaration of declarations) {
    const trimmed = declaration.trim();
    if (!trimmed) {
      continue;
    }

    const cleaned = stripAnnotationsAndModifiers(trimmed);

    const lastSpace = cleaned.lastIndexOf(" ");
    if (lastSpace < 0) {
      continue;
    }

    let type = cleaned.slice(0, lastSpace).trim();
    let name = cleaned.slice(lastSpace + 1).trim();

    // TS 风格 "name: type"：lastSpace 分割会把 "name:" 当类型、"string" 当名字，
    // 冒号前才是参数名（C++ 作用域符 "::" 不以单冒号结尾，不受影响）
    const tsColonType = /^([A-Za-z_$][\w$]*)\s*:\s*$/.exec(type);
    if (tsColonType && name) {
      const realName = tsColonType[1] ?? "";
      const realType = name; // lastSpace 分割出的后半段才是类型
      name = realName;
      type = realType;
    }

    // C 系指针/引用：`int *ptr` → 星号属于类型而非变量名
    const ptrMatch = /^[*&]+/.exec(name);
    if (ptrMatch) {
      type = `${type} ${ptrMatch[0]}`.trim();
      name = name.slice(ptrMatch[0].length).trim();
    }
    // C 系数组：`int arr[10]` → 下标属于类型
    const bracketIdx = name.indexOf("[");
    if (bracketIdx > 0) {
      type = `${type} ${name.slice(bracketIdx)}`.trim();
      name = name.slice(0, bracketIdx).trim();
    }

    if (!name || !type) {
      continue;
    }

    result.set(name, type);
  }

  return result;
}

/**
 * 提取第一个顶层 (...) 配对内的内容。
 * @example "public void foo(int x, String y)" -> "int x, String y"
 */
function extractParenContent(signature: string): string | null {
  const openParen = signature.indexOf("(");
  if (openParen < 0) {
    return null;
  }

  const closeParen = findMatchingIndex(signature, openParen, "(", ")");
  if (closeParen < 0) {
    // 对截断的签名做优雅回退。
    const tail = signature.slice(openParen + 1).trim();
    return tail || null;
  }

  const content = signature.slice(openParen + 1, closeParen).trim();
  return content || null;
}

/**
 * 移除单个参数声明前的注解/修饰符。
 * @example "@NotNull final String name" -> "String name"
 */
function stripAnnotationsAndModifiers(paramDecl: string): string {
  let remaining = paramDecl;

  while (remaining.length > 0) {
    const trimmed = remaining.trimStart();

    if (trimmed.startsWith("@")) {
      remaining = stripLeadingAnnotation(trimmed);
      continue;
    }

    let strippedModifier = false;
    for (const modifier of PARAM_MODIFIERS) {
      const followedBySpace =
        trimmed.length === modifier.length ||
        /\s/.test(trimmed[modifier.length] ?? "");
      if (trimmed.startsWith(modifier) && followedBySpace) {
        remaining = trimmed.slice(modifier.length);
        strippedModifier = true;
        break;
      }
    }

    if (!strippedModifier) {
      return trimmed;
    }
  }

  return remaining;
}

/**
 * 移除一个前导注解 token。
 * 支持：
 * - @NotNull
 * - @RequestParam("id")
 */
function stripLeadingAnnotation(text: string): string {
  // 1) 跳过 "@AnnotationName"（含包路径）。
  let index = 1; // 跳过 '@'
  while (index < text.length && /[\w.]/.test(text[index] ?? "")) {
    index++;
  }

  // 2) 注解名和 '(' 之间可能有空格。
  while (index < text.length && /\s/.test(text[index] ?? "")) {
    index++;
  }

  // 3) 跳过可选的注解参数 "(...)"
  if (text[index] === "(") {
    const closeParen = findMatchingIndex(text, index, "(", ")");
    if (closeParen < 0) {
      return "";
    }
    return text.slice(closeParen + 1);
  }

  return text.slice(index);
}

/**
 * 仅在顶层按逗号分割。
 * 设计原因：泛型参数中可能包含逗号。
 * @example "Map<String, List<Integer>>, int[]" -> ["Map<String, List<Integer>>", "int[]"]
 */
function splitByTopLevelComma(paramsText: string): string[] {
  const result: string[] = [];
  let current = "";
  let angleDepth = 0;
  let parenDepth = 0;

  for (const ch of paramsText) {
    // 进入泛型层
    if (ch === "<") {
      angleDepth++;
      current += ch;
      continue;
    }
    // 退出泛型层
    if (ch === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
      current += ch;
      continue;
    }
    // 进入括号层
    if (ch === "(") {
      parenDepth++;
      current += ch;
      continue;
    }
    // 退出括号层
    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      current += ch;
      continue;
    }
    if (ch === "," && angleDepth === 0 && parenDepth === 0) {
      result.push(current);
      current = "";
      continue;
    }
    // 累积普通字符
    current += ch;
  }

  if (current.trim()) {
    result.push(current);
  }

  return result;
}

/**
 * 从方法签名解析返回类型。
 * 设计原因：@return 标签应包含具体返回类型供 UI 展示。
 *
 * 注意：
 * - 类构造函数式签名回退为 "void"。
 * @example "public List<String> getItems()" -> "List<String>"
 */
function parseReturnType(signature: string): string {
  const cleanSignature = signature.replace(/\{[\s\S]*$/, "").trim();
  const withoutGenericDecl = removeMethodGenericDecl(cleanSignature);
  const withoutModifiers = withoutGenericDecl.replace(
    JAVA_METHOD_MODIFIER_PREFIX,
    "",
  );

  // 取 '(' 前的内容，去掉末尾的方法名，剩余即返回类型。
  // 比正则匹配更稳健：类型可含空格（如 "int *"、"const char *"）
  const openParen = withoutModifiers.indexOf("(");
  if (openParen < 0) {
    return "void";
  }
  let beforeParen = withoutModifiers.substring(0, openParen).trim();
  const nameMatch = /([A-Za-z_$][\w$]*)\s*$/.exec(beforeParen);
  if (nameMatch) {
    beforeParen = beforeParen.slice(0, nameMatch.index).trim();
  }
  return beforeParen || "void";
}

/**
 * 移除方法级的泛型声明。
 * @example "public <T> T convert(...)" -> "public T convert(...)"
 */
function removeMethodGenericDecl(signature: string): string {
  const openAngle = signature.indexOf("<");
  const openParen = signature.indexOf("(");

  if (openAngle < 0 || openParen < 0 || openAngle > openParen) {
    return signature;
  }

  const closeAngle = findMatchingIndex(signature, openAngle, "<", ">");
  if (closeAngle < 0) {
    return signature;
  }

  const afterGeneric = signature.slice(closeAngle + 1).trimStart();

  // 启发式判断：泛型后必须以 "Type methodName(" 开头
  if (
    /^[A-Za-z_$][\w$<>\[\].?,\s]*\s+[A-Za-z_$][\w$]*\s*\(/.test(afterGeneric)
  ) {
    return signature.slice(0, openAngle) + afterGeneric;
  }

  return signature;
}

/**
 * 查找 startIndex 处开 token 的匹配闭 token。
 * @returns 匹配的闭 token 索引，未匹配返回 -1。
 */
function findMatchingIndex(
  text: string,
  startIndex: number,
  openToken: string,
  closeToken: string,
): number {
  let depth = 0;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === openToken) {
      depth++;
    } else if (ch === closeToken) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}
