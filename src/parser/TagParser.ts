/**
 * TagParser.ts - Javadoc tag parser
 *
 * Purpose:
 * - Parse raw Javadoc tag text into a structured TagTable.
 *
 * Why:
 * - UI rendering needs stable typed data instead of raw text.
 * - Line-based tokenization is safer than regex split when descriptions contain "@xxx" text.
 */

import type { ParamTag, ReturnTag, TagTable, ThrowsTag } from "../types.js";

type SupportedTag =
  | "param"
  | "return"
  | "returns"
  | "throws"
  | "exception"
  | "since"
  | "author"
  | "deprecated"
  | "see"
  | "doc"
  | "example";

interface ParsedTagBlock {
  readonly tag: SupportedTag;
  readonly content: string;
}

/**
 * Regex pattern to identify Javadoc tag lines.
 */
const TAG_LINE_PATTERN =
  /^\s*\*?\s*@(?<tag>param|return|returns|throws|exception|since|author|deprecated|see|doc|example)\b\s*(?<content>.*)$/i;

/**
 * 参数前可忽略的修饰符集合
 */
const PARAM_MODIFIERS: ReadonlySet<string> = new Set(["final"]);

const JAVA_METHOD_MODIFIER_PREFIX =
  /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|default|native|strictfp)\s+)*/;

/**
 * Purpose: Parse Javadoc tag section into TagTable.
 * Why: Keep downstream rendering logic simple and type-safe.
 * @param rawTags - Raw tag text (starting at first @tag line).
 * @param signature - Method/constructor signature, used for type inference.
 * @returns Structured TagTable.
 * Side effects: None.
 */
export function parseTagTable(rawTags: string, signature: string): TagTable {
  //Avoid shared reference contamination
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

  let returnTag: ReturnTag | null = null;
  let since: string | null = null;
  let author: string | null = null;
  let deprecated: string | null = null;
  let doc: string | null = null;
  let example: string | null = null;

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
        // Constructors resolve to "void" in this parser, so @return is ignored there.
        if (returnType !== "void") {
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
    }
  }

  return {
    params,
    returns: returnTag,
    throws: throwsTags,
    since,
    author,
    deprecated,
    see: seeTags,
    doc,
    example,
  };
}

/**
 * Purpose: Build a fresh empty TagTable.
 * Why: Avoid sharing mutable array references.
 */
export function createEmptyTagTable(): TagTable {
  return {
    params: [],
    returns: null,
    throws: [],
    since: null,
    author: null,
    deprecated: null,
    see: [],
    doc: null,
    example: null,
  };
}

/**
 * Purpose: Tokenize raw tag text by lines into stable blocks.
 * Why: Regex split can break when descriptions include "@tag" as plain text.
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
    if (activeTag) {
      buffer.push(line.trim());
    }
  }
  flush();
  return blocks;
}

/**
 * Purpose: Normalize one Javadoc line before parsing.
 * Why: Input may still contain leading '*' from original comment lines.
 */
function normalizeJavadocLine(line: string): string {
  return line.replace(/^\s*\*\s?/, "");
}

function isSupportedTag(value: string): value is SupportedTag {
  switch (value) {
    case "param":
    case "return":
    case "returns":
    case "throws":
    case "exception":
    case "since":
    case "author":
    case "deprecated":
    case "see":
    case "doc":
    case "example":
      return true;
    default:
      return false;
  }
}

/**
 * Purpose: Parse one @param block.
 * Why: Supports both regular parameters and generic type parameters (@param <T> ...).
 */
function parseParamTag(
  content: string,
  paramTypes: ReadonlyMap<string, string>,
): ParamTag | null {
  const match = /^(<\s*[A-Za-z_$][\w$]*\s*>|[A-Za-z_$][\w$]*)\s*(.*)$/s.exec(
    content,
  );
  if (!match) {
    return null;
  }

  const rawName = (match[1] ?? "").replace(/\s+/g, "");
  const description = (match[2] ?? "").trim();

  const isTypeParameter = rawName.startsWith("<") && rawName.endsWith(">");
  const type = isTypeParameter
    ? "type-parameter"
    : (paramTypes.get(rawName) ?? "unknown");

  return {
    name: rawName,
    type,
    description,
  };
}

/**
 * Purpose: Parse one @throws/@exception block.
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
 * Purpose: Parse parameter name -> type mapping from method signature.
 * Why: Enrich @param tags with concrete parameter types.
 */
function parseSignatureParams(signature: string): Map<string, string> {
  //result map : name -> type
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

    const type = cleaned.slice(0, lastSpace).trim();
    const name = cleaned.slice(lastSpace + 1).trim();

    if (!name || !type) {
      continue;
    }

    result.set(name, type);
  }

  return result;
}

/**
 * Purpose: Extract content inside the first top-level (...) pair.
 * @example : "public void foo(int x, String y)" -> "int x, String y"
 */
function extractParenContent(signature: string): string | null {
  const openParen = signature.indexOf("(");
  if (openParen < 0) {
    return null;
  }

  const closeParen = findMatchingIndex(signature, openParen, "(", ")");
  if (closeParen < 0) {
    // Graceful fallback for truncated signatures.
    const tail = signature.slice(openParen + 1).trim();
    return tail || null;
  }

  const content = signature.slice(openParen + 1, closeParen).trim();
  return content || null;
}

/**
 * Purpose: Remove leading annotations/modifiers from one parameter declaration.
 * Example: "@NotNull final String name" -> "String name"
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
 * Purpose: Remove one leading annotation token.
 * Supports:
 * - @NotNull
 * - @RequestParam("id")
 */
function stripLeadingAnnotation(text: string): string {
  // 1) Skip "@AnnotationName" (including package path).
  let index = 1; // skip '@'
  while (index < text.length && /[\w.]/.test(text[index] ?? "")) {
    index++;
  }

  // 2) Optional spaces between annotation name and '('.
  while (index < text.length && /\s/.test(text[index] ?? "")) {
    index++;
  }

  // 3) Skip optional annotation arguments "(...)"
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
 * Purpose: Split by commas only at top level.
 * Why: Generic arguments can contain commas.
 * @example: "Map<String, List<Integer>>, int[]" -> ["Map<String, List<Integer>>", "int[]"]
 */
function splitByTopLevelComma(paramsText: string): string[] {
  const result: string[] = [];
  let current = "";
  let angleDepth = 0;
  let parenDepth = 0;

  for (const ch of paramsText) {
    //enter the generic layer
    if (ch === "<") {
      angleDepth++;
      current += ch;
      continue;
    }
    //exit the generic layer
    if (ch === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
      current += ch;
      continue;
    }
    //enter parentheses level
    if (ch === "(") {
      parenDepth++;
      current += ch;
      continue;
    }
    //exit parentheses level
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
    //accumulate of ordinary character
    current += ch;
  }

  if (current.trim()) {
    result.push(current);
  }

  return result;
}

/**
 * Purpose: Parse return type from method signature.
 * Why: @return tag should include concrete return type for UI display.
 *
 * Note:
 * - Constructor-like signatures fallback to "void".
 * @example : "public List<String> getItems()" -> "List<String>"
 */
function parseReturnType(signature: string): string {
  const cleanSignature = signature.replace(/\{[\s\S]*$/, "").trim();
  const withoutGenericDecl = removeMethodGenericDecl(cleanSignature);
  const withoutModifiers = withoutGenericDecl.replace(
    JAVA_METHOD_MODIFIER_PREFIX,
    "",
  );

  // Expected: "<ReturnType> <methodName>(...)"
  const match = /^([A-Za-z_$][\w$<>\[\].?,\s]*?)\s+[A-Za-z_$][\w$]*\s*\(/.exec(
    withoutModifiers,
  );

  if (match?.[1]) {
    return match[1].trim();
  }

  return "void";
}

/**
 * Purpose: Remove method-level generic declaration.
 * Example: "public <T> T convert(...)" -> "public T convert(...)"
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

  // Heuristic: after generic must start with "Type methodName("
  if (
    /^[A-Za-z_$][\w$<>\[\].?,\s]*\s+[A-Za-z_$][\w$]*\s*\(/.test(afterGeneric)
  ) {
    return signature.slice(0, openAngle) + afterGeneric;
  }

  return signature;
}

/**
 * Purpose: Find matching close token for an opening token at startIndex.
 * @returns Matched close index, or -1 if unmatched.
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
