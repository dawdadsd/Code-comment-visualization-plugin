/**
 * TagParser.ts - Javadoc 标签解析器
 *
 * 【Javadoc 标签格式】
 * @param paramName 参数描述
 * @return 返回值描述
 * @throws ExceptionType 异常描述
 * @since 1.0
 * @author xiaowu
 *
 * 本模块负责将原始文本解析成结构化的 TagTable
 */

import type { TagTable, ParamTag, ReturnTag, ThrowsTag } from "../types.js";
import { EMPTY_TAG_TABLE } from "../types.js";

/**
 * 解析 Javadoc 标签
 *
 * @param rawTags - 原始标签文本（从第一个 @tag 开始）
 * @param signature - 方法签名（用于提取类型信息）
 * @returns 结构化的标签表格
 *
 * @example
 * const raw = '@param id 用户ID\n@return 用户对象';
 * const sig = 'public User findById(Long id)';
 * parseTagTable(raw, sig);
 * // 返回: { params: [{name:'id', type:'Long', description:'用户ID'}], ... }
 */
export function parseTagTable(rawTags: string, signature: string): TagTable {
  if (!rawTags.trim()) {
    return EMPTY_TAG_TABLE;
  }

  const paramTypes = parseSignatureParams(signature);
  const returnType = parseReturnType(signature);

  const params: ParamTag[] = [];
  const throws: ThrowsTag[] = [];
  const see: string[] = [];
  let returns: ReturnTag | null = null;
  let since: string | null = null;
  let author: string | null = null;
  let deprecated: string | null = null;

  const tagPattern =
    /@(param|return|returns|throws|exception|since|author|deprecated|see)\s+/g;
  const segments = rawTags.split(tagPattern);

  for (let i = 1; i < segments.length; i += 2) {
    const tagName = segments[i];
    const content = segments[i + 1]?.trim() ?? "";

    switch (tagName) {
      case "param": {
        const param = parseParamTag(content, paramTypes);
        if (param) {
          params.push(param);
        }
        break;
      }

      case "return":
      case "returns": {
        if (returnType !== "void") {
          returns = { type: returnType, description: content };
        }
        break;
      }

      case "throws":
      case "exception": {
        const throwsTag = parseThrowsTag(content);
        if (throwsTag) {
          throws.push(throwsTag);
        }
        break;
      }

      case "since":
        since = content;
        break;

      case "author":
        author = content;
        break;

      case "deprecated":
        deprecated = content;
        break;

      case "see":
        see.push(content);
        break;
    }
  }

  return { params, returns, throws, since, author, deprecated, see };
}

// ========== 标签内容解析 ==========

/**
 * 解析单个 @param 标签
 */
function parseParamTag(
  content: string,
  paramTypes: Map<string, string>,
): ParamTag | null {
  const match = /^(\w+)\s*(.*)$/s.exec(content);
  if (!match) {
    return null;
  }

  const name = match[1] ?? "";
  const description = match[2]?.trim() ?? "";
  const type = paramTypes.get(name) ?? "unknown";

  return { name, type, description };
}

/**
 * 解析单个 @throws 标签
 */
function parseThrowsTag(content: string): ThrowsTag | null {
  const match = /^([\w.]+)\s*(.*)$/s.exec(content);
  if (!match) {
    return null;
  }

  return {
    type: match[1] ?? "",
    description: match[2]?.trim() ?? "",
  };
}

/**
 * Java 参数修饰符和关键字
 * 出现在参数类型之前，需要在提取类型时剥离
 *
 * 例如: "final @NotNull @Valid String name"
 *       需要提取出 "String"，而不是 "final @NotNull @Valid String"
 */
const PARAM_MODIFIERS = new Set(["final"]);

/**
 * 从方法签名中提取参数类型映射
 *
 * 【改进点】
 * 1. 使用括号深度匹配提取参数列表，正确处理泛型中的 `>)`
 * 2. 剥离参数注解（@NotNull, @RequestBody 等）和修饰符（final）
 *
 * @example
 * parseSignatureParams('public void save(@NotNull Long id, @Valid final String name)')
 * // 返回: Map { 'id' => 'Long', 'name' => 'String' }
 *
 * parseSignatureParams('public void process(Map<String, List<User>> data)')
 * // 返回: Map { 'data' => 'Map<String, List<User>>' }
 */
function parseSignatureParams(signature: string): Map<string, string> {
  const map = new Map<string, string>();

  // 用深度匹配提取括号内容（正确处理泛型中的嵌套括号）
  const paramsStr = extractParenContent(signature);
  if (!paramsStr) {
    return map;
  }

  // 按逗号分割（泛型感知）
  const params = splitByTopLevelComma(paramsStr);

  for (const param of params) {
    const trimmed = param.trim();
    if (!trimmed) continue;

    // 剥离注解和修饰符，提取纯粹的 "Type name"
    const cleaned = stripAnnotationsAndModifiers(trimmed);

    // 最后一个空格分隔类型和名称
    // "Map<String, List<User>> data" → type="Map<String, List<User>>", name="data"
    const lastSpace = cleaned.lastIndexOf(" ");
    if (lastSpace === -1) continue;

    const type = cleaned.slice(0, lastSpace).trim();
    const name = cleaned.slice(lastSpace + 1).trim();

    // 可变参数处理: "String... args" → type="String...", name="args"
    if (name && type) {
      map.set(name, type);
    }
  }

  return map;
}

/**
 * 使用深度匹配提取第一对顶层圆括号的内容
 *
 * @example
 * extractParenContent('public void save(Map<K, V> m, int n)') → 'Map<K, V> m, int n'
 * extractParenContent('no parens here') → null
 */
function extractParenContent(signature: string): string | null {
  const openIndex = signature.indexOf("(");
  if (openIndex === -1) return null;

  let depth = 0;
  for (let i = openIndex; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        const content = signature.slice(openIndex + 1, i);
        return content.trim() || null;
      }
    }
  }

  // 括号未闭合（签名被截断），返回已有内容
  const content = signature.slice(openIndex + 1);
  return content.trim() || null;
}

/**
 * 剥离参数声明中的注解和修饰符，只保留 "Type name"
 *
 * Java 参数声明完整格式:
 *   [@Annotation]* [final] Type [<Generic>] [... ] name
 *
 * @example
 *   "@NotNull final String name"           → "String name"
 *   "@RequestBody @Valid User user"        → "User user"
 *   "final Map<String, List<User>> data"   → "Map<String, List<User>> data"
 *   "String... args"                       → "String... args"
 */
function stripAnnotationsAndModifiers(paramDecl: string): string {
  // 逐个 token 处理，跳过注解和修饰符
  // 难点在于泛型 token 内部有空格（不能简单 split）
  // 策略：从左到右扫描，跳过 @xxx 和 final，剩余部分即 "Type name"

  let remaining = paramDecl;

  // 循环剥离开头的注解和修饰符
  while (remaining.length > 0) {
    const trimmed = remaining.trimStart();

    // 跳过注解：@Xxx 或 @Xxx(...)
    if (trimmed.startsWith("@")) {
      remaining = stripLeadingAnnotation(trimmed);
      continue;
    }

    // 跳过修饰符关键字
    let skipped = false;
    for (const modifier of PARAM_MODIFIERS) {
      if (
        trimmed.startsWith(modifier) &&
        (trimmed.length === modifier.length ||
          /\s/.test(trimmed[modifier.length] ?? ""))
      ) {
        remaining = trimmed.slice(modifier.length);
        skipped = true;
        break;
      }
    }

    if (!skipped) {
      return trimmed;
    }
  }

  return remaining;
}

/**
 * 跳过一个注解，返回剩余文本
 *
 * 处理两种形式：
 *   @NotNull                → 跳到下一个空白
 *   @RequestParam(value="x") → 跳到括号闭合
 */
function stripLeadingAnnotation(text: string): string {
  // 跳过 @AnnotationName
  let i = 1; // skip '@'
  while (i < text.length && /[\w.]/.test(text[i] ?? "")) {
    i++;
  }

  // 检查是否有括号参数 @Annotation(...)
  if (text[i] === "(") {
    let depth = 0;
    while (i < text.length) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
  }

  return text.slice(i);
}

/**
 * 按顶层逗号分割参数列表（泛型感知）
 *
 * 追踪 `<>` 和 `()` 的嵌套深度，只在最外层逗号处分割
 *
 * @example
 * splitByTopLevelComma('Map<String, Integer> map, int count')
 * // ['Map<String, Integer> map', ' int count']
 */
function splitByTopLevelComma(paramsStr: string): string[] {
  const result: string[] = [];
  let current = "";
  let angleBracketDepth = 0;
  let parenDepth = 0;

  for (const char of paramsStr) {
    if (char === "<") {
      angleBracketDepth++;
      current += char;
    } else if (char === ">") {
      angleBracketDepth--;
      current += char;
    } else if (char === "(") {
      parenDepth++;
      current += char;
    } else if (char === ")") {
      parenDepth--;
      current += char;
    } else if (char === "," && angleBracketDepth === 0 && parenDepth === 0) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    result.push(current);
  }

  return result;
}

// ========== 返回类型解析 ==========

/**
 * 从方法签名中提取返回类型
 *
 * @example
 * parseReturnType('public User findById(Long id)')      // 'User'
 * parseReturnType('public List<User> findAll()')        // 'List<User>'
 * parseReturnType('public void save(User user)')        // 'void'
 * parseReturnType('public <T> T convert(Object o)')     // 'T'
 */
function parseReturnType(signature: string): string {
  // 移除方法体部分
  const cleanSig = signature.replace(/\{.*$/, "").trim();

  // 移除方法级泛型声明 <T, U>（在返回类型之前）
  // 需要深度匹配以正确处理嵌套泛型：<T extends Comparable<T>>
  const withoutGenericDecl = removeMethodGenericDecl(cleanSig);

  // 尝试匹配：修饰符... 返回类型 方法名(
  const match =
    /(?:public|private|protected|static|final|abstract|synchronized|default|native|\s)*\s*([\w<>\[\],\s?]+?)\s+\w+\s*\(/.exec(
      withoutGenericDecl,
    );

  if (match?.[1]) {
    return match[1].trim();
  }

  // 备用方案：提取括号前的最后一个类型标识
  const fallbackMatch = /([\w<>\[\]]+)\s+\w+\s*\(/.exec(withoutGenericDecl);
  return fallbackMatch?.[1]?.trim() ?? "void";
}

/**
 * 移除方法级泛型声明
 *
 * 方法级泛型声明位于修饰符和返回类型之间：
 *   public <T extends Comparable<T>> T findMax(List<T> list)
 *          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 *          这部分需要移除
 *
 * 不能用简单正则 /<[^>]+>/ 因为泛型可能嵌套
 */
function removeMethodGenericDecl(signature: string): string {
  // 方法级泛型声明的特征：< 出现在方法名和 ( 之前
  // 策略：找到第一个 <，用深度匹配找到对应的 >，
  // 检查 > 之后是否紧跟 "Type methodName("，如果是则移除

  const openAngle = signature.indexOf("<");
  const openParen = signature.indexOf("(");

  // 没有泛型或泛型在参数列表内（不是方法级声明）
  if (openAngle === -1 || openParen === -1 || openAngle > openParen) {
    return signature;
  }

  // 深度匹配找到对应的 >
  let depth = 0;
  let closeAngle = -1;
  for (let i = openAngle; i < signature.length; i++) {
    if (signature[i] === "<") depth++;
    else if (signature[i] === ">") {
      depth--;
      if (depth === 0) {
        closeAngle = i;
        break;
      }
    }
  }

  if (closeAngle === -1) return signature;

  // 检查 > 后面是否跟着 "Type methodName(" 模式
  // 如果是，说明这是方法级泛型声明
  const afterGeneric = signature.slice(closeAngle + 1).trimStart();
  if (/^\w+\s+\w+\s*\(/.test(afterGeneric)) {
    // 是方法级泛型声明，移除它
    return signature.slice(0, openAngle) + afterGeneric;
  }

  // 不是方法级声明（可能是返回类型的泛型），保留
  return signature;
}
