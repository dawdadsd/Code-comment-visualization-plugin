/**
 * helpers.ts - 解析器测试公共工具
 *
 * 集中管理 TextDocument mock 构造与 fixture 加载，避免各测试文件重复。
 * 使用方式：
 * - parseFixture(lang, file)：读取 test/fixtures/<lang>/<file> 并解析
 * - parseText(lang, fileName, text)：直接解析给定文本（边界情形）
 * - names(items)：提取成员名称列表（保持源码顺序）
 */

import * as fs from "fs";
import * as path from "path";
import { DocCommentParser } from "../src/parser/DocCommentParser";
import type { ClassDoc } from "../src/types";
import type { TextDocument } from "vscode";
import { Uri } from "./mocks/vscode";

/** 解析器单例：内部按语言缓存 WASM grammar，全测试复用以节省时间 */
export const parser = new DocCommentParser();

const FIXTURES_ROOT = path.join(__dirname, "fixtures");

/** 构造 TextDocument mock */
export function makeDoc(
  languageId: string,
  filePath: string,
  text: string,
): TextDocument {
  return {
    uri: Uri.file(filePath),
    languageId,
    getText: () => text,
  } as TextDocument;
}

/** 读取 fixture 文件并解析（fixture 驱动测试主入口） */
export async function parseFixture(
  languageId: string,
  file: string,
): Promise<ClassDoc> {
  const filePath = path.join(FIXTURES_ROOT, languageId, file);
  const text = fs.readFileSync(filePath, "utf8");
  return parser.parse(makeDoc(languageId, filePath, text));
}

/** 直接解析给定源码文本（边界情形 / 内联代码） */
export async function parseText(
  languageId: string,
  fileName: string,
  text: string,
): Promise<ClassDoc> {
  const filePath = path.join(FIXTURES_ROOT, "__inline__", fileName);
  return parser.parse(makeDoc(languageId, filePath, text));
}

/** 提取成员名称列表（保持源码顺序） */
export function names(items: readonly { name: string }[]): string[] {
  return items.map((i) => i.name);
}
