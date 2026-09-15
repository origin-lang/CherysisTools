# Change Log

All notable changes to the "cherysis-tools" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### 0.0.8

- 打包链路固化：`pnpm run package` 一键打包带全量生产依赖的 vsix；pnpm-workspace.yaml 固化 vsce-pnpm 与 lazystream 补丁，修复扩展无法激活。
- UI：工具入口从 webview 顶部导航迁移到活动栏目录树（「系统管理」/「小工具」两组，CMake Tools 风格）。
- 小工具切换保留页面数据：填写内容、Excel 规则行、九宫格构图在切走再切回时不丢失。
- 商品店铺管理：图片列支持粘贴 / 拖入图片（剪贴板去重、自动落盘命名、拖入需按住 Shift，VS Code webview 限制）。