# Change Log

All notable changes to the "cherysis-tools" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- 商品管理·列表：编号列筛选支持范围表达式——`A1~A33`（含两端）、`1~33`（两端不写字母按 A 段）、逗号多段 `A1~A33,L1~L22` 取**并集**、范围符两侧空格可忽略（`~ ～ - — 到 至`）；**单个带字母的编号按精确匹配**（`L1`→L001、`A7`→A007），**纯数字/文本仍走子串**（`007`/`7`/`A` 行为不变）。字母只写一边、区间写反、两侧字母冲突、超 4 位数字等写法会把筛选框标红并悬停说明原因，不再静默出空表。编号排序与筛选共用同一套编号解析口径。
- 商品管理·列表：右键菜单顺序调整——「复制整行」上移到「复制完整名称」之前。

### 0.0.8

- 打包链路固化：`pnpm run package` 一键打包带全量生产依赖的 vsix；pnpm-workspace.yaml 固化 vsce-pnpm 与 lazystream 补丁，修复扩展无法激活。
- UI：工具入口从 webview 顶部导航迁移到活动栏目录树（「系统管理」/「小工具」两组，CMake Tools 风格）。
- 小工具切换保留页面数据：填写内容、Excel 规则行、九宫格构图在切走再切回时不丢失。
- 商品店铺管理：图片列支持粘贴 / 拖入图片（剪贴板去重、自动落盘命名、拖入需按住 Shift，VS Code webview 限制）。