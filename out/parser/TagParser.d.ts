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
import type { TagTable } from "../types.js";
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
export declare function parseTagTable(rawTags: string, signature: string): TagTable;
