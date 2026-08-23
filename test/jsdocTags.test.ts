/**
 * jsdocTags.test.ts - JSDoc 扩展标签（@emits / @fires / @listens / @typedef）解析集成测试
 *
 * 覆盖：
 * - @emits / @fires（别名）归入 emits，@listens 归入 listens
 * - @typedef {Type} Name description 解析
 * - 行内 @tag（散文）不被误判为标签（METADATA_TAG_PATTERN 行首锚定回归）
 */

import { parseText } from "./helpers";

describe("JSDoc 扩展标签解析", () => {
  it("@emits / @fires 归入 emits，@listens 归入 listens", async () => {
    const doc = await parseText(
      "typescript",
      "Events.ts",
      `class Emitter {
  /**
   * 触发并监听事件
   * @emits click 用户点击事件
   * @fires change 数据变更事件
   * @listens ready 初始化就绪
   */
  emit(): void {}
}
`,
    );
    const m = doc.methods.find((x) => x.name === "emit");
    expect(m?.hasComment).toBe(true);
    expect(m?.tags.emits).toHaveLength(2);
    expect(m?.tags.emits[0]).toMatchObject({ name: "click", description: "用户点击事件" });
    // @fires 是 @emits 的 JSDoc 别名，应归入同一 emits 数组
    expect(m?.tags.emits[1]).toMatchObject({ name: "change", description: "数据变更事件" });
    expect(m?.tags.listens).toHaveLength(1);
    expect(m?.tags.listens[0]).toMatchObject({ name: "ready", description: "初始化就绪" });
  });

  it("@typedef {Object} Name description 解析为类型定义标签", async () => {
    const doc = await parseText(
      "typescript",
      "TypeDef.ts",
      `/**
 * 文件级描述
 */

/**
 * @typedef {Object} UserName 用户名称类型
 */
interface TypeDef {}
`,
    );
    expect(doc.typeGroups[0]?.tags.typedef).toMatchObject({
      name: "UserName",
      type: "Object",
      description: "用户名称类型",
    });
  });

  it("行内 @tag（散文）不被误判为标签", async () => {
    const doc = await parseText(
      "typescript",
      "Prose.ts",
      `class Service {
  /**
   * 处理事件：该方法会 @emits 一个 click 事件，并 @listens ready。
   * 另见 @param 风格的说明。
   */
  handle(): void {}
}
`,
    );
    const m = doc.methods.find((x) => x.name === "handle");
    expect(m?.hasComment).toBe(true);
    // 行内 @emits / @listens / @param 均非行首，不应被解析为标签
    expect(m?.tags.emits).toHaveLength(0);
    expect(m?.tags.listens).toHaveLength(0);
    expect(m?.tags.params).toHaveLength(0);
    // 描述应保留原文（@tag 作为普通文本留在描述里）
    expect(m?.description).toContain("@emits");
    expect(m?.description).toContain("@listens");
  });
});
