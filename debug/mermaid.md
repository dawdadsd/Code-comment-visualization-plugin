针对深色模式，某些东西是黑色的

```mermaid
stateDiagram-v2
    [*] --> 活动对象: createObject / beginMol
    活动对象 --> 静态图: endMol 闭合 / commitObjects
    静态图 --> 活动对象: addActiveObjects（choose / modify 提取）
    静态图 --> 非活动层成员: pickup 随活动对象一并纳入 AOM
    非活动层成员 --> 静态图: commitObjects
    静态图 --> trash: deleteObjects（delete-object 记录）
    trash --> 静态图: 撤销删除（按 chunks 层位边回图）
    活动对象 --> 静态图: abortMol / discard（无效果落回）
```
箭头

```mermaid
sequenceDiagram
    participant A as 本端 BoardCore
    participant R as relay
    participant B as 对端 BoardCore

    A->>R: 本地 commit → 操作记录广播
    R->>B: 转发记录
    B->>B: 500ms 延迟容忍窗内接入 applyRemoteOperations
    A->>R: 30s 周期 digest（{logSize, head, objects, stateHash, openMols}）
    R->>B: 转发 digest
    B->>B: stateHash 比对
    alt 分歧
        B->>B: repairStateFromLog 效果层自愈
    end
```
箭头三角形，指针

```mermaid
flowchart TB
    NEW["白板外新对象"] -->|"add（新建顶层活动层）"| L3
    subgraph static["静态图"]
        S["ChunkObjectManager.staticGraph<br/>（逐区块，稳定层叠关系）"]
    end
    subgraph dynamic["动态图（layerOrder 自下而上）"]
        direction TB
        L1["Layer 1（inactive）<br/>activeObjects + inactiveGraph"] --> L2["Layer 2（active）<br/>activeObjects + inactiveGraph"]
        L2 --> L3["Layer n（active）<br/>activeObjects + inactiveGraph"]
    end
    S -->|"choose（pickup 提取子图）"| L2
    L2 -->|"apply（提交回静态图）"| S
    L1 -.->|"discard（放弃更改，tidyup 写回）"| S
    L2 -.->|"remove（彻底删除）"| T["trash"]
```
框外文字

```mermaid
stateDiagram-v2
    [*] --> Unloaded
    Unloaded --> TempLoaded: REQUEST_LOAD（TEMP 策略）chunk.loadTemp()
    Unloaded --> FullLoaded: REQUEST_LOAD（FULL 策略）chunk.loadFull() + syncChunkObjectEntries()
    TempLoaded --> FullLoaded: 同一 loader 升级（不重复加载）
    FullLoaded --> TempLoaded: REQUEST_UNLOAD（降级）
    TempLoaded --> Unloaded: REQUEST_UNLOAD（彻底卸载）
    note right of TempLoaded
        所有加载出口（FULL、已 FullLoaded、TEMP）
        均发射 LOAD_COMPLETE 事件
    end note
```
箭头

/Users/frank/Code/HoundTek/hound-whiteboard/src/kernel/board/docs/tier-graph-document.md
会导致插件崩溃

```mermaid
graph BT
  B --> A

  style C fill:#ff9999,stroke:#ff3333,color:#fff
  style E fill:#ff9999,stroke:#ff3333,color:#fff
  style H fill:#ff9999,stroke:#ff3333,color:#fff

  subgraph "layer: 2 active"
    subgraph "inactive: 2"
      B
      A
    end
    subgraph "active: 2"
      C
    end
  end

  subgraph "layer: 1 active"
    subgraph "inactive: 1"
      F
    end
    subgraph "active: 1"
      H
      E
    end
  end
```

```mermaid
graph BT
  B --> A

  style C fill:#ff9999,stroke:#ff3333,color:#fff
  style E fill:#ff9999,stroke:#ff3333,color:#fff
  style H fill:#ff9999,stroke:#ff3333,color:#fff

  subgraph "layer: 2 active"
    subgraph "inactive: 2"
      B
      A
    end
    subgraph "active: 2"
      C
    end
  end

  subgraph "layer: 1 active"
    subgraph "inactive: 1"
      F
    end
    subgraph "active: 1"
      H
      E
    end
  end
```

```mermaid
graph BT
  B --> A

  style C fill:#ff9999,stroke:#ff3333,color:#fff
  style E fill:#ff9999,stroke:#ff3333,color:#fff
  style H fill:#ff9999,stroke:#ff3333,color:#fff
  style G fill:#bbbbff,stroke:#5555ff,color:#000

  subgraph "layer: 3 active"
    subgraph "active: 3"
      G
    end
  end

  subgraph "layer: 2 active"
    subgraph "inactive: 2"
      B
      A
    end
    subgraph "active: 2"
      C
    end
  end

  subgraph "layer: 1 active"
    subgraph "inactive: 1"
      F
    end
    subgraph "active: 1"
      H
      E
    end
  end
```

```mermaid
graph BT
  B --> A

  style C fill:#ff9999,stroke:#ff3333,color:#fff
  style E fill:#ff9999,stroke:#ff3333,color:#fff
  style H fill:#ff9999,stroke:#ff3333,color:#fff

  subgraph "layer: 3 inactive"
    subgraph "active: 3"
      G
    end
  end

  subgraph "layer: 2 active"
    subgraph "inactive: 2"
      B
      A
    end
    subgraph "active: 2"
      C
    end
  end

  subgraph "layer: 1 active"
    subgraph "inactive: 1"
      F
    end
    subgraph "active: 1"
      H
      E
    end
  end
```


```mermaid
graph BT
  B --> A

  style C fill:#ff9999,stroke:#ff3333,color:#fff

  subgraph "layer: 1 active"
    subgraph "inactive: 1"
      A
      B
    end
    subgraph "active: 1"
      C
    end
  end
```

```mermaid
graph BT
  style C fill:#ff9999,stroke:#ff3333,color:#fff
  style B fill:#bbbbff,stroke:#5555ff,color:#000

  subgraph "layer: 2 active"
    subgraph "inactive: 2"
      A
    end
    subgraph "active: 2"
      B
    end
  end

  subgraph "layer: 1 active"
    subgraph "active: 1"
      C
    end
  end
```

```mermaid
graph BT
  style B fill:#bbbbff,stroke:#5555ff,color:#000

  subgraph "layer: 1 active"
    subgraph "inactive: 1"
      A
    end
    subgraph "active: 1"
      B
    end
  end
```

```mermaid
graph BT
  B --> A

  style C fill:#ff9999,stroke:#ff3333,color:#fff
  style E fill:#ff9999,stroke:#ff3333,color:#fff
  style H fill:#ff9999,stroke:#ff3333,color:#fff

  subgraph "layer: 2 active"
    subgraph "inactive: 2"
      B
      A
    end
    subgraph "active: 2"
      C
    end
  end

  subgraph "layer: 1 active"
    subgraph "inactive: 1"
      F
    end
    subgraph "active: 1"
      H
      E
    end
  end
```

```mermaid
graph BT
  B --> A

  style C fill:#ff9999,stroke:#ff3333,color:#fff
  style E fill:#ff9999,stroke:#ff3333,color:#fff
  style H fill:#ff9999,stroke:#ff3333,color:#fff
  style D fill:#bbbbff,stroke:#5555ff,color:#000

  subgraph "layer: 3 active"
    subgraph "inactive: 3"
      B
      A
    end
    subgraph "active: 3"
      C
    end
  end

  subgraph "layer: 2 active"
    subgraph "inactive: 2"
      F
    end
    subgraph "active: 2"
      H
      E
    end
  end

  subgraph "layer: 1 active"
    subgraph "active: 1"
      D
    end
  end
```
箭头和框外文字

```mermaid
flowchart LR
    subgraph supra["超分子操作"]
        direction TB
        m1["分子操作"] --> m2["分子操作"] --> m3["分子操作"]
    end
    atom["原子操作 × N<br/>"] -- "endMol 凝聚" --> m1
```
框外文字

```mermaid
sequenceDiagram
    participant T as 调用方（工具）
    participant H as HitCommitter
    participant L as 操作日志 / hit 树
    T->>H: beginMol（分配 molId）
    loop 手势帧 × N
        T->>H: amendMol（原子帧增量）
        Note over H: amend 走 volatile 通道<br/>只画不存、永不落盘
    end
    alt 正常结束
        T->>H: endMol
        H->>L: 物化分子记录上链（每对象一条、同 molId）
    else 取消
        T->>H: abortMol（丢弃 amend 流，不留痕）
    end
```
alt 框文字

```mermaid
graph LR
    subgraph before["撤销前"]
        R1[root] --> P1[P 父节点] --> D1[D 撤销目标] --> X1[X] --> H1["HEAD"]
    end
    subgraph after["撤销后（分叉改挂 + 截断）"]
        R2[root] --> P2[P 分叉点] --> D2[D 原位置保留]
        D2 -.->|"不晚于撤销的节点截断保留"| X2["X 晚于撤销<br/>只存在于撤销分支"]
        P2 --> X3["X' 改挂副本<br/>与 X 共享 share id"] --> H2["HEAD 移到新末端"]
    end
```
框外文字

```mermaid
classDiagram
  class Board {
    +DevicesDAG devicesDAG
  }
  class Viewport {
    +InputScope inputScope
    +UiRenderer uiRenderer
    +startWorkerSync()
    +convertCanvasSignalsToWorld()
  }
  class InputScope {
    +mountDevice()
    +mountWorkflow()
    +addEdge()
    +removeEdge()
    +unmountWorkflow()
  }
  class DevicesDAG {
    +mountSubDAG()
    +mountWorkflow()
    +addEdge()
  }

  Viewport --> Board : board
  Viewport --> InputScope : inputScope
  InputScope --> DevicesDAG : dag
  InputScope --> Board : board
  InputScope --> Viewport : viewport (for unmount context)
```
箭头

```mermaid
flowchart LR
  subgraph SubDAGDefinition
    direction LR
    RP["rootPath: /keyboard"]
    RN["rootNodeId: 0"]
    ND["nodes: Map\n{localId → nodeDef}"]
    ED["edges: [{name,\nfromNodeId, toNodeId}]"]
  end

  ND -->|0| ND0["nodeDef 0\nhandler:\nrootHandler\nsemantics: {}"]
  ND -->|1| ND1["nodeDef 1\nhandler: null\ndefaultRoute: default"]
  ND -->|N| NDN["nodeDef N\nhandler: toolHandler\nsemantics: {tool: true}"]

  ED -->|0| E0["{name: event,\nfromNodeId: 0, toNodeId: 1}"]
```
箭头

```mermaid
classDiagram
    class ObjectChooserTool {
      +process(signalPacket, context)*
      #updateSelectionRegion(position, context)*
      #hasSelectionRegion(context)*
      #clearSelectionRegion(context)*
      #getSelectionRegion(context)*
      #submitSelection(context)
      #replaceSelection(context, objects)
    }
    class RectangleObjectChooserTool {
      #updateSelectionRegion(position, context)
      #hasSelectionRegion(context)
      #clearSelectionRegion(context)
      #getSelectionRegion(context)
      +collectUiOverlayEntries(overlayContext)
    }
    class LassoChooserTool {
      #updateSelectionRegion(position, context)
      #hasSelectionRegion(context)
      #clearSelectionRegion(context)
      #getSelectionRegion(context)
    }
    ObjectChooserTool <|-- RectangleObjectChooserTool
    ObjectChooserTool <|-- LassoChooserTool
```
箭头

```mermaid
sequenceDiagram
    participant Gesture as GestureTool.process()
    participant Chooser as ObjectChooserTool
    participant Board as boardApi

    Gesture->>+Chooser: _onEnd(interaction)
    Chooser->>Chooser: completeAction(context)
    Chooser->>Board: submitSelection(context)
    Board-->>Chooser: Promise<ObjectSummary[]>
    Note over Chooser: Promise resolved
    Chooser->>Chooser: _applySelection
    Chooser->>Board: discardActiveObjects(previousIds)
    Chooser->>Board: addActiveObjects(nextIds)
    Chooser->>Chooser: afterChoose / confirmSelection
    Chooser->>Chooser: afterAction → action:complete
```
箭头

```mermaid
flowchart LR
    subgraph 父类调度
        P[process]
        F[_finalizeSelection]
        A[_applySelection]
    end

    subgraph 子类 hook
        U[updateSelectionRegion]
        H[hasSelectionRegion]
        C[clearSelectionRegion]
        G[getSelectionRegion]
        O[collectUiOverlayEntries]
    end

    P -->|position| U
    P -->|end + H| F
    F -->|submitSelection →| G
    F --> A
    A --> C
```
框外文字

```mermaid
sequenceDiagram
    participant F as _finalizeSelection
    participant S as submitSelection<br/>（父类默认）
    participant B as boardApi

    F->>S: getSelectionRegion(ctx)
    S->>B: hitTest(worldRect, "intersect")
    B-->>S: objectIds[]
    S->>B: queryObjects(objectIds)
    B-->>S: ObjectSummary[]
    S-->>F: summaries
```
箭头

```mermaid
classDiagram
    class ObjectChooserTool {
      #process(signalPacket, context)
      #_finalizeSelection(context)
      #_applySelection(context, objects)
      #replaceSelection(context, objects)
      #submitSelection(context)
      #updateSelectionRegion(position, context)*
      #hasSelectionRegion(context)*
      #clearSelectionRegion(context)*
      #getSelectionRegion(context)*
    }
    class RectangleObjectChooserTool {
      +createSelectionWorldRect(start, end)
      -resolveSelectionDragState(context)
      -writeSelectionDragState(context, state)
      -clearSelectionDragState(context)
      #updateSelectionRegion(position, context)
      #hasSelectionRegion(context)
      #clearSelectionRegion(context)
      #getSelectionRegion(context)
      +collectUiOverlayEntries(overlayContext)
    }
    ObjectChooserTool <|-- RectangleObjectChooserTool
```
箭头

```mermaid
classDiagram
    class Tool {
        +process(signalPacket, context)
        +on(hookName, listener)
        +umount(context)
        +reset()
    }

    class GestureTool {
        +isGestureActive: boolean
        +autoActionOnGestureEnd: boolean
        +beginGesture(interaction)
        +updateGesture(interaction)
        +completeGesture(interaction)
        +cancelGesture(interaction)
        +beforeAction(context)
        +performAction(context)
        +afterAction(context, result)
        +completeAction(context)
        +discardAction(context)
        +buildInteraction(signalPacket, context)
    }

    class MultiGestureTool {
        +_onEnd(interaction)
        +_onCancel(interaction)
        +_onObjectEnd(interaction)
        +_onObjectCancel(interaction)
    }

    class ObjectCreatorTool {
        +beginGesture(interaction)
        +updateGesture(interaction)
        +completeGesture(interaction)
        +completeAction(context)
    }

    class ObjectChooserTool {
        +beginGesture(interaction)
        +updateGesture(interaction)
        +cancelGesture(interaction)
    }

    class ObjectModifierTool {
        +beforeAction(context)
        +performAction(context)
        +afterAction(context, result)
    }

    Tool <|-- GestureTool
    GestureTool <|-- MultiGestureTool
    GestureTool <|-- ObjectCreatorTool
    GestureTool <|-- ObjectChooserTool
    GestureTool <|-- ObjectModifierTool
```
箭头

```mermaid
classDiagram
    class GestureTool {
        +beginGesture(interaction)
        +updateGesture(interaction)
        +completeGesture(interaction)
        +performAction(context)
    }

    class ObjectEraserTool {
        +eraserSize: number
        #_lastTrailPoint: Vector
        +applyTrailSegment(from, to, interaction)*
    }

    class DataObjectEraserTool {
        +applyTrailSegment(from, to, interaction)
    }

    class TraitObjectEraserTool {
        +applyTrailSegment(from, to, interaction)
    }

    class CompositeObjectEraserTool {
        +applyTrailSegment(from, to, interaction)
    }

    GestureTool <|-- ObjectEraserTool
    ObjectEraserTool <|-- DataObjectEraserTool
    ObjectEraserTool <|-- TraitObjectEraserTool
    ObjectEraserTool <|-- CompositeObjectEraserTool
```
箭头

```mermaid
sequenceDiagram
    participant App as 应用代码
    participant Logger as Logger
    participant LogBus as LogBus
    participant CP as ConsolePrinter
    participant RB as RingBuffer
    participant TB as ThrottledBus

    App->>Logger: .info("started")
    Note over Logger: 级别过滤

    Logger->>LogBus: emit("INFO", entry)
    Note over LogBus: 同步分发

    par 消费者
        LogBus->>CP: handler(entry)
        CP-->>CP: console.log(...)
    and
        LogBus->>RB: push(entry)
        Note over RB: buffer[head] = entry
    and
        LogBus->>TB: write(entry)
        Note over TB: 未满 → 攒批
    end

    Note over TB: 500ms 后或满额
    TB-->>TB: flush()
    TB->>TB: onFlush(batch)
```
箭头和 alt 框文字
