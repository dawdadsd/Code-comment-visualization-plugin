[中文](./README.md) | [English](./README.en.md)

# Doc Sidebar

Display code documentation in real time in the VS Code sidebar.
Currently supports Java / TypeScript / JavaScript with two-way synchronized navigation.

## Features

- Click a method/function in the sidebar -> jump to the corresponding code location
- Move the cursor in code -> automatically highlight the current method/function in the sidebar
- Compact mode: quickly browse member lists
- Detailed mode: show complete documentation details
- Return types and parameter types are highlighted
- `@param`, `@return`, `@throws`, and other tags are displayed in table format
- Optionally show Git author and last modified time (based on `git blame` / `git log`)

## Demo Video

- [I built a VS Code plugin: a Doc plugin for different programming languages](https://www.bilibili.com/video/BV1ZYFHzgERT?vd_source=5cc5b352bbecf64c204775d57aa91764)

## Environment Requirements (Git Author Info)

To get author and last-modified information, this extension directly calls system `git` commands (such as `git blame` / `git log`) and does not depend on any additional VS Code Git extension.

- macOS: Git is usually preinstalled or already available, so author info can be displayed normally.
- Windows: Install **Git for Windows** and make sure `git` is in PATH. Also ensure the current file is inside a valid Git repository (with available `.git` history).

## Usage

1. Open any Java / TypeScript / JavaScript file
2. Click the Doc Sidebar icon in the Activity Bar
3. View method/function documentation in the sidebar
4. Click a method/function name to jump to its code location

## Configuration

| Setting                              | Type    | Default | Description                                              |
| ------------------------------------ | ------- | ------- | -------------------------------------------------------- |
| `javaDocSidebar.enableAutoHighlight` | boolean | true    | Enable reverse highlight sync when the cursor moves      |
| `javaDocSidebar.debounceDelay`       | number  | 300     | Debounce delay for reverse sync highlighting (ms)        |
| `javaDocSidebar.maxMethods`          | number  | 200     | Maximum number of methods/functions shown in the sidebar |

## Requirements

- VS Code 1.95.0 or higher
- For Java parsing, installing a Java language support extension is recommended (for better symbol resolution)

## License

This project is released under the MIT License. See [LICENSE](https://github.com/dawdadsd/Code-comment-visualization-plugin/blob/main/LICENSE) for details.
