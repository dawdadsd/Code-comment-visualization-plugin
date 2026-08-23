/**
 * languageFeatures.test.ts - 语言特征配置表（LanguageFeature）单元测试
 *
 * 守护 TreeSitterService 的「一套通用遍历逻辑 + 一张表」设计目标：
 * - 契约完整：每个语言的配置必须提供全部四类节点类型数组，
 *   否则 extractMembers 遍历时该分类会静默缺失。
 * - 节点类型合法：非空、符合 tree-sitter 节点命名规范（snake_case），
 *   防止配置中混入空格/驼峰等非法类型名导致永不对应任何 AST 节点。
 * - 分类互斥：同一节点类型不得同时出现在多个分类中，
 *   否则 walkMembers 的分支（method > enum > field）会产生歧义。
 * - 配置覆盖可解析：特征表中的每个语言都必须有对应的 WASM grammar，
 *   避免出现「有配置但无法解析」的死配置。
 *   （lua/dart/vue 等只有 grammar 没有特征配置的语言，属有意为之，
 *   不参与 AST 提取、由 LSP 符号主链路兜底，故不作反向断言。）
 */

import {
  LANGUAGE_FEATURES,
  LANGUAGE_WASM_MAP,
} from "../src/services/TreeSitterService";
import type { LanguageFeature } from "../src/services/TreeSitterService";

const CATEGORIES: readonly (keyof LanguageFeature)[] = [
  "typeNodeTypes",
  "methodNodeTypes",
  "fieldNodeTypes",
  "enumMemberNodeTypes",
];

/** jest 30 移除了 expect(value, message) 双参形式，统一用带上下文的断言辅助 */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

describe("LanguageFeature 契约：每个语言配置四类节点齐全", () => {
  it("语言特征表非空，且每个语言都提供全部四个分类", () => {
    const languages = Object.keys(LANGUAGE_FEATURES);
    expect(languages.length).toBeGreaterThan(0);

    for (const [language, feature] of Object.entries(LANGUAGE_FEATURES)) {
      for (const category of CATEGORIES) {
        assert(
          Array.isArray(feature[category]),
          `${language}.${category} 应为数组`,
        );
      }
    }
  });

  it("节点类型字符串合法：非空且符合 snake_case 节点命名规范", () => {
    for (const [language, feature] of Object.entries(LANGUAGE_FEATURES)) {
      for (const category of CATEGORIES) {
        for (const nodeType of feature[category]) {
          assert(
            /^[a-z_][a-z0-9_]*$/.test(nodeType),
            `${language}.${category} 存在非法节点类型: "${nodeType}"`,
          );
        }
      }
    }
  });

  it("分类互斥：同一节点类型不跨分类重复（避免遍历分支歧义）", () => {
    for (const [language, feature] of Object.entries(LANGUAGE_FEATURES)) {
      const all = CATEGORIES.flatMap((category) => feature[category]);
      assert(
        new Set(all).size === all.length,
        `${language} 存在跨分类重复的节点类型`,
      );
    }
  });
});

describe("LanguageFeature 覆盖：配置语言均可被解析", () => {
  it("特征表中每个语言都有对应的 WASM grammar（无死配置）", () => {
    expect(Object.keys(LANGUAGE_FEATURES).length).toBeGreaterThan(0);

    for (const language of Object.keys(LANGUAGE_FEATURES)) {
      assert(
        Object.prototype.hasOwnProperty.call(LANGUAGE_WASM_MAP, language),
        `${language} 缺少 WASM grammar 映射`,
      );
    }
  });
});
