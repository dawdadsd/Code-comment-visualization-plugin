/**
 * JavaDocParser.ts - Javadoc 主解析器
 *
 * 【职责】
 * 1. 调用 SymbolResolver 获取代码结构
 * 2. 从源代码中提取 Javadoc 注释
 * 3. 调用 TagParser 解析标签
 * 4. 组装成 ClassDoc 数据结构
 * 5. 获取 Git 作者信息
 *
 * 【解析流程】
 * TextDocument → Symbol树 → 扁平化符号列表 → 按类别分别解析 → ClassDoc
 *
 * 【符号分类】
 * Symbol 树中的符号被分为四类：
 *   Container（类/接口/枚举）→ 递归展开子符号
 *   Method / Constructor     → parseMethod（通过 kind 字段区分）
 *   Field / Constant         → parseField
 *   EnumMember               → parseEnumConstant（独立解析路径）
 */
import type { TextDocument } from "vscode";
import type { ClassDoc } from "../types.js";
/**
 * Javadoc 解析器
 */
export declare class JavaDocParser {
    private readonly javadocPattern;
    private readonly annotationPattern;
    private readonly topLevelTypePattern;
    /**
     * 解析 Java 文档
     *
     * @param document - VS Code 的文档对象
     * @returns 解析后的类文档结构
     */
    parse(document: TextDocument): Promise<ClassDoc>;
    /**
     * 递归扁平化 Symbol 树
     *
     * 遇到容器（类/接口/枚举）→ 递归处理其子符号，记录完整类名
     * 遇到方法/字段/枚举常量     → 收集到结果中
     */
    private flattenSymbols;
    /**
     * 解析单个方法（包括构造函数）
     *
     * 构造函数与普通方法走同一解析路径，
     * 仅在最终赋值 kind 时通过 isConstructorSymbol 区分
     */
    private parseMethod;
    /**
     * 解析单个字段（普通字段 / static final 常量）
     */
    private parseField;
    /**
     * 解析单个枚举常量
     *
     * 枚举常量的语法与普通字段完全不同：
     *   SUCCESS(200, "OK"),       ← 有构造参数
     *   PENDING,                  ← 无构造参数
     *   UNKNOWN;                  ← 最后一个用分号
     *
     * 因此不复用 parseField，而是独立解析
     */
    private parseEnumConstant;
    /**
     * 提取枚举常量的构造参数
     *
     * 使用括号深度匹配，正确处理嵌套括号
     *
     * @example
     *   "SUCCESS(200, \"OK\")" → "(200, \"OK\")"
     *   "PENDING,"             → ""
     *   "UNKNOWN;"             → ""
     */
    private extractEnumArguments;
    /**
     * 提取成员的 Javadoc 注释（带类注释去重保护）
     *
     * 【为什么需要这个方法？】
     * Lombok 等注解处理器会生成虚拟符号（如 @Slf4j → log 字段），
     * Language Server 将这些符号的位置报告在类声明附近。
     * extractComment 向上搜索时会错误地找到类 Javadoc。
     *
     * 此方法在 extractComment 的基础上增加一层校验：
     * 如果提取到的注释与类注释完全相同，说明是误关联，返回空字符串。
     */
    private extractMemberComment;
    /**
     * 解析 Javadoc 注释内容
     */
    private parseJavadoc;
    /**
     * 解析类注释中的 @author 和 @since
     */
    private parseClassJavadoc;
    /**
     * 清理 Javadoc 注释格式
     */
    private cleanComment;
    /**
     * 提取完整的方法签名（处理跨行声明）
     *
     * Spring Controller 方法带多个注解参数时，签名可能跨越 8-10 行，例如：
     *   public ResponseEntity<User> updateUser(
     *       @PathVariable Long id,
     *       @RequestBody @Valid UserUpdateDTO dto,
     *       @RequestParam(required = false) String reason,
     *       @AuthenticationPrincipal UserDetails principal
     *   ) {
     *
     * 上限设为 15 行，覆盖绝大多数实际方法签名
     */
    private static readonly MAX_SIGNATURE_LINES;
    private extractFullSignature;
    /**
     * 提取目标行上方最近的 Javadoc 注释块
     */
    private extractComment;
    /**
     * 判断一段代码是否仅由空行或注解（含多行注解参数）构成
     */
    private onlyBlankOrAnnotations;
    private extractAccessModifierFromLine;
    /**
     * 从代码行中提取方法签名
     */
    private extractSignatureFromLine;
    /**
     * 从 Symbol 列表中找到类符号
     */
    private findClassSymbol;
    /**
     * 从文本中提取类名（Symbol 解析失败时的降级方案）
     */
    private extractClassNameFromText;
    /**
     * 当符号解析失败时，从源码文本中提取“主类型”(top-level)信息
     *
     * - 只识别 braceDepth===0 的类型声明，避免误选内部类
     * - 优先选择与文件名同名的类型（常见 Java 约定）
     */
    private extractPrimaryTypeInfoFromText;
    /**
     * 用于顶层扫描时剔除注释/字符串，避免 braceDepth 计算误差
     */
    private parseLineForStructure;
    /**
     * 从字段声明行提取类型
     * 例如: "private static final int MAX_SIZE = 100;" → "int"
     */
    private extractFieldType;
    private extractPackageName;
    private getGitInfo;
}
