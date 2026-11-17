# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

交付形态是 Tauri 2 桌面应用（macOS 优先，Windows 同步支持），渲染层仍是 WebView 中的 React 应用；这里按 impeccable 的 `web` 平台记录视觉与交互基线，不表示产品以浏览器网站分发。

## Users

个人开发者（单人），日常维护 5–20 台 Linux 服务器（个人 VPS、个人项目、少量生产环境）。使用场景：坐在 Mac 前，打开桌面应用，快速连接、看状态、传文件、重启容器，然后离开。不是团队协作场景，没有多角色、权限、审批链。

## Product Purpose

Harbor 是一款本地优先的纯 SSH 运维台：以服务器列表为入口，围绕单台服务器提供终端、SFTP 文件、系统监控、Docker 四个核心能力。成功标准：用户每天愿意主动打开它；连接、开终端、传文件、重启容器等高频动作在 5 秒内完成；不再需要另开 Termius / Transmit 等工具。

## Positioning

把"服务器"当作唯一一等公民的运维台：左侧选服务器，右侧在同一上下文里完成终端、文件、监控、Docker 四件事。没有团队协作，也没有与单机运维无关的功能——所有设计预算集中在单台服务器的高频操作上。

## Operating Context

- macOS 优先的 Tauri 桌面窗口；主要全屏使用，也需在约 1100px 宽的并排窗口下可用。
- 打开即连：默认进入终端 Tab，SSH 自动建立连接。
- 键盘优先：Cmd+K 命令面板、服务器/Tab 切换快捷键；鼠标操作完整可用。
- 中文界面（v1 仅中文）。
- 服务器凭据只存系统 Keychain；支持从 `~/.ssh/config` 批量导入。

## Capabilities and Constraints

- 五个核心能力：服务器列表（分组 / 搜索 / favorite）、多标签 SSH 终端、SFTP 文件管理（浏览 / 上传 / 下载 / 新建 / 重命名 / 删除 / Monaco 在线编辑）、系统监控（五卡 / 近 5 分钟曲线 / Top 10）、Docker 容器管理（列出 / 日志 / start / stop / restart / exec）。
- 单服务器聚焦：同一时刻只有一个 Workspace 激活；切换服务器时终端会话保活。
- 四个 Tab 始终挂载：切换 Tab 不销毁终端、文件草稿或监控采样；后台采样与迟到响应按服务器/连接隔离。
- 每个 Workspace 最多 8 个并发终端 Session。
- 监控数据只保留最近 5 分钟在内存中，不落盘。
- 术语以仓库根目录 `GLOSSARY.md` 为准（Server / Group / Workspace / Tab / Session / Favorite / Command History / Remote Path）。

## Brand Commitments

- 产品名：Harbor（港湾——服务器停靠的地方）。
- 定位：纯 SSH 运维工具，只做单机远程操作。
- 旧 OpsPilot UI 是**反参考**，不作为视觉继承；只保留其中被验证过的功能事实。

## Evidence on Hand

- 无真实用户数据、客户案例或品牌资产；演示内容必须使用明确标注的合成数据（服务器名、主机名、容器名等）。
- 现有代码只提供功能事实，不提供视觉权威。

## Product Principles

1. 服务器即上下文：所有操作都从"选中一台服务器"开始，没有全局功能岛。
2. 高频动作零阻力：连接、开终端、传文件、重启容器的交互层级尽量浅。
3. 信息密集但可扫读：面向专家，不隐藏必要信息，但层级必须一眼可辨。
4. 克制：与 SSH 运维无关的功能不做，装饰性噱头不做。
5. 可信：凭据只在 Keychain；危险操作有确认；断线、失败、超时都有明确状态。

## Accessibility & Inclusion

- 所有核心操作都有键盘路径。
- 正文与控件满足 WCAG AA 对比度；终端区域按终端可读性优先。
- 不依赖颜色单独传达状态（同时使用文字/图标）。
