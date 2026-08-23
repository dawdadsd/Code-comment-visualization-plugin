/**
 * operationEffectKind.test.ts - 操作类型 → 作用类别映射表单元测试
 *
 * 复刻业务常量 EFFECT_KIND_OF_TYPE 的核心特征（命名/结构可微调，特征不变）：
 * - Object.freeze 冻结只读映射（运行时不可变）
 * - Readonly<Record<OperationType, OperationEffectKind>> 类型标注（编译期只读）
 * - computed key 关联枚举成员
 *
 * 覆盖：映射完整性、取值合法性、逐项语义、不可变性（扩展/修改/删除被拒）。
 */

// ---- 被测对象（特征复刻）----

enum OperationType {
  ADD_OBJECT = "ADD_OBJECT",
  MODIFY_OBJECT = "MODIFY_OBJECT",
  DELETE_OBJECT = "DELETE_OBJECT",
  CHOOSE_OBJECT = "CHOOSE_OBJECT",
  UNCHOOSE_OBJECT = "UNCHOOSE_OBJECT",
  MOVE_HEAD = "MOVE_HEAD",
  UNDO = "UNDO",
  REDO = "REDO",
}

enum OperationEffectKind {
  APPEND_NODE = "APPEND_NODE",
  MOVE_HEAD = "MOVE_HEAD",
  REATTACH = "REATTACH",
}

const EFFECT_KIND_OF_TYPE: Readonly<Record<OperationType, OperationEffectKind>> =
  Object.freeze({
    [OperationType.ADD_OBJECT]: OperationEffectKind.APPEND_NODE,
    [OperationType.MODIFY_OBJECT]: OperationEffectKind.APPEND_NODE,
    [OperationType.DELETE_OBJECT]: OperationEffectKind.APPEND_NODE,
    [OperationType.CHOOSE_OBJECT]: OperationEffectKind.APPEND_NODE,
    [OperationType.UNCHOOSE_OBJECT]: OperationEffectKind.APPEND_NODE,
    [OperationType.MOVE_HEAD]: OperationEffectKind.MOVE_HEAD,
    [OperationType.UNDO]: OperationEffectKind.REATTACH,
    [OperationType.REDO]: OperationEffectKind.MOVE_HEAD,
  });

// 枚举全集（用于完整性比对）
const allOperationTypes = Object.values(OperationType) as OperationType[];
const allEffectKinds = new Set<OperationEffectKind>(Object.values(OperationEffectKind));

describe("EFFECT_KIND_OF_TYPE（映射完整性）", () => {
  it("键集合与操作类型枚举完全一致（无缺失、无多余）", () => {
    const keys = Object.keys(EFFECT_KIND_OF_TYPE).sort();
    const expected = allOperationTypes.map((t) => t as string).sort();
    expect(keys).toEqual(expected);
  });

  it("每个操作类型都映射到一个合法的作用类别", () => {
    for (const op of allOperationTypes) {
      expect(allEffectKinds.has(EFFECT_KIND_OF_TYPE[op])).toBe(true);
    }
  });
});

describe("EFFECT_KIND_OF_TYPE（映射语义）", () => {
  it("新增/修改/删除/选择/取消选择 → 追加节点", () => {
    const appenders = [
      OperationType.ADD_OBJECT,
      OperationType.MODIFY_OBJECT,
      OperationType.DELETE_OBJECT,
      OperationType.CHOOSE_OBJECT,
      OperationType.UNCHOOSE_OBJECT,
    ];
    for (const op of appenders) {
      expect(EFFECT_KIND_OF_TYPE[op]).toBe(OperationEffectKind.APPEND_NODE);
    }
  });

  it("移动头指针 / 重做 → 移动头", () => {
    expect(EFFECT_KIND_OF_TYPE[OperationType.MOVE_HEAD]).toBe(
      OperationEffectKind.MOVE_HEAD,
    );
    expect(EFFECT_KIND_OF_TYPE[OperationType.REDO]).toBe(
      OperationEffectKind.MOVE_HEAD,
    );
  });

  it("撤销 → 重挂", () => {
    expect(EFFECT_KIND_OF_TYPE[OperationType.UNDO]).toBe(
      OperationEffectKind.REATTACH,
    );
  });
});

describe("EFFECT_KIND_OF_TYPE（不可变性）", () => {
  it("已被 Object.freeze 冻结，且不可扩展", () => {
    expect(Object.isFrozen(EFFECT_KIND_OF_TYPE)).toBe(true);
    expect(Object.isExtensible(EFFECT_KIND_OF_TYPE)).toBe(false);
  });

  it("新增键被拒绝（严格模式抛 TypeError，值不写入）", () => {
    const map = EFFECT_KIND_OF_TYPE as Record<string, unknown>;
    expect(() => {
      map["EXTRA_OPERATION"] = OperationEffectKind.APPEND_NODE;
    }).toThrow(TypeError);
    expect(map["EXTRA_OPERATION"]).toBeUndefined();
  });

  it("修改既有映射被拒绝，原映射保持不变", () => {
    const map = EFFECT_KIND_OF_TYPE as Record<string, unknown>;
    expect(() => {
      map[OperationType.UNDO] = OperationEffectKind.MOVE_HEAD;
    }).toThrow(TypeError);
    expect(EFFECT_KIND_OF_TYPE[OperationType.UNDO]).toBe(
      OperationEffectKind.REATTACH,
    );
  });

  it("删除属性被拒绝，原条目保持不变", () => {
    const map = EFFECT_KIND_OF_TYPE as Record<string, unknown>;
    expect(() => {
      delete map[OperationType.ADD_OBJECT];
    }).toThrow(TypeError);
    expect(EFFECT_KIND_OF_TYPE[OperationType.ADD_OBJECT]).toBe(
      OperationEffectKind.APPEND_NODE,
    );
  });
});
