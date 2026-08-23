/**
 * tagConstants.ts - Javadoc/JSDoc 受支持标签的单一事实来源
 *
 * 背景：标签词表曾分散在 DocCommentParser.METADATA_TAG_PATTERN 与
 * TagParser 的 SupportedTag / TAG_LINE_PATTERN / isSupportedTag 四处，
 * 因不同步导致 @license / @prop 被吞进描述文本。此处收敛为一份共享常量，
 * 正则与类型判断均由此派生，杜绝再次漂移。
 */

/** 受支持的 Javadoc/JSDoc 标签全量词表（含别名；全部为小写字母，可直接嵌入正则） */
export const SUPPORTED_TAGS = [
  "param",
  "return",
  "returns",
  "throws",
  "exception",
  "since",
  "author",
  "license",
  "deprecated",
  "see",
  "doc",
  "example",
  "type",
  "typedef",
  "property",
  "prop",
  "template",
  "yields",
  "yield",
  "summary",
  "description",
  "desc",
  "todo",
  "emits",
  "fires",
  "listens",
  "readonly",
  "async",
  "override",
] as const;

export type SupportedTag = (typeof SUPPORTED_TAGS)[number];

/** O(1) 成员判断（替代手写 switch，杜绝枚举漂移） */
export const SUPPORTED_TAG_SET: ReadonlySet<string> = new Set(SUPPORTED_TAGS);

// 词表均为小写字母，直接 join 即可安全嵌入正则（无需转义）
const TAG_ALTERNATION = SUPPORTED_TAGS.join("|");

/**
 * 行首锚定的元数据标签切分点（DocCommentParser 用）。
 *
 * 仅这些标签会终止 description 的提取，其他 @xxx（如 @file、@module）
 * 会被视为描述文本的一部分。
 *
 * 行首锚定（^ + m 标志）：JSDoc 规范要求 @tag 出现在行首才算标签，
 * 散文中提到的 @tag（如"数据来自 @param"）不应被误判为标签。
 * 区分大小写（与历史行为一致）。
 */
export const METADATA_TAG_PATTERN = new RegExp(`^@(?:${TAG_ALTERNATION})\\b`, "m");

/** 行首 @标签行解析（TagParser 用）：忽略大小写 + 捕获标签名与内容 */
export const TAG_LINE_PATTERN = new RegExp(
  `^\\s*\\*?\\s*@(?<tag>${TAG_ALTERNATION})\\b\\s*(?<content>.*)$`,
  "i",
);
