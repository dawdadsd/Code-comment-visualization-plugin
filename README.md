[中文](./README.md) | [English](./README.en.md)

# Doc Sidebar for vscode

在 VS Code 侧边栏实时展示代码文档，当前支持 Java / TypeScript / JavaScript / Markdown，支持双向联动导航。
插件市场 : comment sidebar
author: [dawdadsd](https://github.com/dawdadsd)
contributors: [xiaowuDev](https://github.com/xiaowuDev), [Frank Steven](https://github.com/Frank-Steven)

## 功能特性

- 点击侧边栏方法/函数 -> 跳转到代码对应位置
- 移动代码光标 -> 侧边栏自动高亮当前方法/函数
- 简洁模式：快速浏览成员列表
- 详细模式：展示完整文档信息
- 返回类型和参数类型高亮显示
- `@param`、`@return`、`@throws` 等标签以表格形式展示
- 可显示 Git 作者和最后修改时间（基于 `git blame` / `git log`）

## 设置

| 设置项 | 说明 | 可选值 | 默认值 |
|---|---|---|---|
| `commentSidebar.codePreviewTheme.dark` | 编辑器为深色主题时，代码预览（Markdown 代码块/注释代码）的代码高亮主题 | `vs2015`、`catppuccin-frappe`、`catppuccin-macchiato`、`catppuccin-mocha` | `vs2015` |
| `commentSidebar.codePreviewTheme.light` | 编辑器为浅色主题时，代码预览的代码高亮主题 | `github`、`catppuccin-latte` | `github` |

内置了 [Catppuccin](https://github.com/catppuccin/highlightjs) 全部四种风味（Latte / Frappé / Macchiato / Mocha），按编辑器明暗分别配置默认主题，切换设置即时生效。

## 演示图片



## 环境要求（Git 作者信息）

本扩展获取作者/修改时间信息时，会直接调用系统的 `git` 命令（例如 `git blame` / `git log`），不依赖额外的 VS Code Git 插件。

- macOS：通常系统自带或已安装 Git，因此可正常显示作者信息。
- Windows：需要安装 **Git for Windows** 并确保 `git` 在 PATH 中；同时要求当前文件位于一个有效的 Git 仓库中（存在可用的 `.git` 历史）。

## 使用方法

1. 打开任意支持的文件
2. 打开 Doc Sidebar 面板
3. 查看方法/函数文档
4. 点击方法名/函数名跳转到代码位置

## 系统要求

- VS Code 1.95.0 或更高版本
- 解析支持的文件时，建议安装对应的语言支持扩展（用于 Symbol 解析能力增强）

## 许可证

本项目基于 MIT License 发布，详见 [LICENSE](https://github.com/dawdadsd/Code-comment-visualization-plugin/blob/main/LICENSE)。
