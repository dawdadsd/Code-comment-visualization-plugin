# JavaDoc Sidebar

在 VS Code 侧边栏实时展示 Java 文件的 Javadoc 文档，支持双向联动导航。

## 功能特性

- 点击侧边栏方法 → 跳转到代码对应位置
- 移动代码光标 → 侧边栏自动高亮当前方法
- 简洁模式：快速浏览方法列表
- 详细模式：展示完整文档信息
- 返回类型和参数类型高亮显示
- @param、@return、@throws 等标签以表格形式展示

## 环境要求（Git 作者信息）

本扩展获取作者/修改时间信息时，会直接调用系统的 `git` 命令（例如 `git blame` / `git log`），不依赖额外的 VS Code Git 插件。

- macOS：通常系统自带或已安装 Git，因此可正常显示作者信息。
- Windows：需要安装 **Git for Windows** 并确保 `git` 在 PATH 中；同时要求当前文件位于一个有效的 Git 仓库中（存在可用的 `.git` 历史）。

## 使用方法

1. 打开任意 Java 文件
2. 点击左侧活动栏的 JavaDoc 图标
3. 在侧边栏查看方法文档
4. 点击方法名跳转到代码位置

## 配置项

| 配置项                               | 类型    | 默认值 | 说明                             |
| ------------------------------------ | ------- | ------ | -------------------------------- |
| `javaDocSidebar.enableAutoHighlight` | boolean | true   | 是否启用光标移动时的反向联动高亮 |
| `javaDocSidebar.debounceDelay`       | number  | 300    | 反向联动的防抖延迟（毫秒）       |
| `javaDocSidebar.maxMethods`          | number  | 200    | 侧边栏最多展示的方法数量         |

## 系统要求

- VS Code 1.95.0 或更高版本
- 需要安装 Java 语言支持扩展（用于 Symbol 解析）

## 许可证

MIT
