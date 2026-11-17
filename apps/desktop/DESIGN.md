# Design

<!-- impeccable:design-schema 1 -->

**Product truth:** `apps/desktop/PRODUCT.md`

**Reference:** `design/harbor-calibrated-panel.html` — 1440×900 首屏参考稿；它固定布局、密度与配色，不替代响应式、状态与后续页面。

## Direction

**Calibrated Panel** — 把运维台做成一台校准过的仪器。世界来自 Braun / Dieter Rams 工业设计：暖灰表面、炭黑文字、单一信号橙、镌刻式标签、等宽数字、1px 发丝线。世界只贡献四件事：字体、配色、密度、一个签名动作。

**Signature move:** 校准刻度。CPU / 内存 / 磁盘以带刻度的水平标尺呈现，而不是圆环图；服务器行是完整铭牌（名称、主机、状态、一条最近事实）；工作区左缘有一条常驻"书脊"，始终显示当前服务器与连接状态。

## Palette

| Token | Value | Use |
|---|---|---|
| `shell` | `#E9E6DF` | 应用外壳、侧栏 |
| `paper` | `#FAF9F6` | 输入框、悬浮表面 |
| `ink` | `#1B1A17` | 主文字、选中填充 |
| `muted` | `#6F6B62` | 次级文字、标签 |
| `hairline` | `#CFCAC0` | 1px 分隔线、边框 |
| `accent` | `#E85D04` | 唯一强调色：选中刻度、favorite、焦点 |
| `screen` | `#141311` | 终端/日志屏幕底 |
| `screen-text` | `#EDEAE2` | 终端正文 |
| `success` | `#4F7A55` | 健康状态 |
| `warning` | `#C07A1E` | 降级/待处理 |
| `danger` | `#B23A2A` | 故障/危险操作 |

状态色只在承载语义时出现；界面默认不依赖颜色单独传达状态（同时有文字或形状）。

## Typography

- UI：**Inter Tight** 400 / 500 / 600。
- 数据与终端：**IBM Plex Mono** 400 / 500。
- 字号：10（tracked 标签）/ 11（元信息）/ 12（正文小）/ 13（正文）/ 14（强调）/ 20（面板标题）/ 22（页面标题）/ 28（关键数字）。
- 标签使用 `letter-spacing: 0.14em–0.22em` 与大写；数字使用 tabular figures。

## Layout

- 左栏固定 300px：品牌、搜索、分组服务器列表、底部操作。
- 工作区左缘 30px 书脊，竖排显示当前服务器与连接状态；宽度 < 1280px 时隐藏。
- 顶栏 96px：服务器名称/元信息 + 三个校准标尺。
- Tab 条：32px 高，激活项整块炭黑填充（不使用下划线）。
- 内容区最小高度 0，可滚动；应用最小宽度 1024px。

## Components

- **Button primary**：炭黑填充、纸白文字、32px 高、无圆角。
- **Button secondary**：透明底、1px 发丝线、炭黑文字。
- **Icon button**：28×28，hover 出现纸白底与发丝线。
- **Input**：32px 高、纸白底、1px 发丝线；focus 使用 1px 橙色描边。
- **Tab**：激活项炭黑填充，非激活项仅文字；键盘焦点用橙色外框。
- **Server row**：44px 高，8px 状态方块 + 名称/主机 + 一条事实；选中项整块炭黑填充。
- **Gauge**：10px 标签 + 12px 等宽数字 + 10px 刻度标尺 + 橙色指针。
- **Panel**：发丝线边框、纸白或 shell 底、无阴影。

## States

- hover：纸白底或轻微加深；不使用位移与缩放。
- selected：整块炭黑填充、纸白文字。
- focus-visible：1px 橙色外框 + 1px 偏移。
- disabled：40% 透明度，保留文字。
- empty：一句说明 + 一个主操作，不使用插画。
- loading：细横线进度或数字占位，不用旋转大图标。

## Motion

- 120–160ms ease-out；只用于 hover、面板出现、Tab 切换。
- 不做弹跳、不做视差；终端光标使用 xterm 默认闪烁。

## Rules

- 不出现圆角卡片、渐变、玻璃拟态、阴影堆叠。
- 不使用多种强调色；橙色只标记"当前/值得注意"。
- 不用图标代替文字标签；图标只做辅助。
- 终端区域保持深色屏幕，与暖灰外壳形成仪器面板式的对比。
- 所有核心操作都有键盘路径（⌘K 命令面板、Tab 切换、Enter 连接）。
