[中文](./README.md) | [English](./README.en.md)

# Doc Sidebar for VS Code

Display code documentation in real time in the VS Code sidebar.
Currently supports Java / TypeScript / JavaScript / Markdown, with bidirectional synchronized navigation.

Marketplace: `comment sidebar`
Author: [dawdadsd](https://github.com/dawdadsd)

## Features

- Click a method/function in the sidebar -> jump to the corresponding location in code
- Move the cursor in code -> the sidebar automatically highlights the current method/function
- Compact mode: quickly browse the member list
- Detailed mode: show complete documentation details
- Return types and parameter types are highlighted
- Tags such as `@param`, `@return`, `@throws` are shown in table format
- Can display Git author and last modified time (based on `git blame` / `git log`)

## Demo Video

- [I developed a VS Code plugin: a Doc plugin for different programming languages](https://www.bilibili.com/video/BV1ZYFHzgERT?vd_source=5cc5b352bbecf64c204775d57aa91764)

## Demo Images

Demo for Markdown docs
![alt text](docs/images/images-1.png)

Demo for Java code:
![alt text](docs/images/images-2.png)
![alt text](docs/images/images-3.png)

showLock: true
![alt text](docs/images/image.png-1772677694890.png)The same applies to TS and JS code.

## Environment Requirements (Git Author Info)

When retrieving author/last modified information, this extension directly calls system `git` commands (such as `git blame` / `git log`) and does not rely on any extra VS Code Git extension.

- macOS: Git is usually preinstalled or already available, so author info can be displayed normally.
- Windows: You need to install **Git for Windows** and ensure `git` is in PATH.
  Also, the current file must be inside a valid Git repository (with available `.git` history).

## Usage

1. Open any Java / TypeScript / JavaScript file
2. Click the Doc Sidebar icon in the left activity bar
3. View method/function documentation in the sidebar
4. Click a method/function name to jump to its code location

## Configuration

| Setting                              | Type    | Default | Description                                          |
| ------------------------------------ | ------- | ------- | ---------------------------------------------------- |
| `javaDocSidebar.enableAutoHighlight` | boolean | true    | Enable reverse highlight when moving the code cursor |
| `javaDocSidebar.debounceDelay`       | number  | 300     | Debounce delay for reverse highlight (milliseconds)  |
| `javaDocSidebar.maxMethods`          | number  | 200     | Maximum number of methods shown in the sidebar       |

## System Requirements

- VS Code 1.95.0 or later
- When parsing Java files, installing a Java language support extension is recommended (for better Symbol parsing)

## License

This project is released under the MIT License. See [LICENSE](https://github.com/dawdadsd/Code-comment-visualization-plugin/blob/main/LICENSE) for details.
