# Apple Design System — ssh-ops-desktop UI Redesign

> 本文件定义了 ssh-ops-desktop 在 Apple 风格下的视觉与交互规范。所有后续设计、开发与重构都应以此文档为准。
> 本规范基于 Apple Human Interface Guidelines 与 WWDC 设计讲座（Designing Fluid Interfaces、The Details of UI Typography 等）提炼，并针对 Web 平台落地。

---

## 1. 设计原则（Design Principles）

我们遵循 Apple 的三大界面精神与八大设计原则。

### 1.1 三大核心精神
- **清晰 Clarity**：文字可读、图标精确、层级明确。
- **尊重 Deference**：内容优先，界面不抢夺注意力。
- **深度 Depth**：通过半透明材质、空间层级与动效建立真实感。

### 1.2 Apple 八大设计原则
1. **Purpose 目的**：每个功能都应有明确意图，决定不做什么和做什么同样重要。
2. **Agency 掌控**：让用户始终可控，提供撤销与选择， destructive 操作才用确认。
3. **Responsibility 责任**：以用户利益为先，隐私、安全、AI 输出都需审慎。
4. **Familiarity 熟悉**：沿用用户已知隐喻与平台习惯，改变需有证据。
5. **Flexibility 灵活**：适配设备、场景与能力差异，支持个性化。
6. **Simplicity 简洁（非极简）**：剥除不必要的干扰，让核心目的最突出。
7. **Craft 匠心**：每一处间距、颜色、动效都应是 deliberate choice。
8. **Delight 愉悦**：是前七项的结果，而非额外装饰。

---

## 2. 视觉语言（Visual Language）

### 2.1 材质与背景
- **主背景**：System Background，随 Light/Dark Mode 自动切换。
- **次级背景**：Secondary / Tertiary System Background，用于卡片、分组、输入框。
- **毛玻璃材质**：使用 `backdrop-filter: blur(20px) saturate(180%)` + 半透明填充模拟 Apple Material。
  - 浅色近似：`rgba(255, 255, 255, 0.72)`
  - 深色近似：`rgba(30, 30, 30, 0.72)`
- **半透明导航栏/侧边栏**：让下方内容隐约透出，增强层级，内容在其下方滚动。
- **Material 层级**： heavier material 用于结构性区域（侧边栏），lighter material 用于浮层按钮；不要将轻材质叠在另一轻材质上。

### 2.2 形状与圆角
| 元素 | 圆角 |
|------|------|
| 小按钮、输入框、标签 | 8px |
| 卡片 | 12px |
| 浮层面板、模态 | 16px – 20px |
| 全屏 Sheet | 20px（顶部） |

### 2.3 阴影
- 小控件：无阴影或 1px 极淡阴影。
- 浮层/弹窗：`0 10px 30px rgba(0,0,0,0.12)`。
- Dark Mode 下显著降低或取消阴影。

### 2.4 间距系统（8pt Grid）
| 令牌 | 值 | 用途 |
|------|-----|------|
| `space-xs` | 4px | 图标与文字紧耦合 |
| `space-sm` | 8px | 组件内部间距 |
| `space-md` | 16px | 卡片内边距、表单间距 |
| `space-lg` | 24px | 区块间距 |
| `space-xl` | 32px | 页面级边距 |
| `space-2xl` | 48px | 大区块分隔 |

---

## 3. 色彩系统（Color System）

### 3.1 系统语义色
| 名称 | Light | Dark | 说明 |
|------|-------|------|------|
| `system-background` | #FFFFFF | #000000 | 主背景 |
| `secondary-background` | #F2F2F7 | #1C1C1E | 次级背景 |
| `tertiary-background` | #FFFFFF | #2C2C2E | 浮层/输入背景 |
| `label-primary` | #000000 | #FFFFFF | 主标题/正文 |
| `label-secondary` | rgba(60,60,67,0.6) | rgba(235,235,245,0.6) | 次要文字 |
| `label-tertiary` | rgba(60,60,67,0.3) | rgba(235,235,245,0.3) | 占位/禁用 |
| `separator` | rgba(198,198,200,0.36) | #38383A | 分割线 |
| `accent` | #007AFF | #0A84FF | 品牌强调色 |
| `success` | #34C759 | #30D158 | 成功 |
| `warning` | #FF9500 | #FF9F0A | 警告 |
| `error` | #FF3B30 | #FF453A | 错误 |

### 3.2 色彩规则
- 同一界面强调色统一，不超过 2 种主色。
- 错误/警告仅在需要用户注意时使用，避免大面积红色。
- 文字与背景对比度满足 WCAG 4.5:1。
- 在毛玻璃材质上使用更高对比度、略粗字重、微增字距，保证 legibility。

---

## 4. 字体与排版（Typography）

### 4.1 字体栈
- 首选：`"SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`
- 代码/终端等宽：`SF Mono, Menlo, Monaco, Consolas, monospace`
- 回退到系统字体，优先利用其光学尺寸与字距优化。

### 4.2 字号与字重
| 样式 | 字号 | 字重 | 行高 | 字距 | 用途 |
|------|------|------|------|------|------|
| `large-title` | 34px | 700 | 41px | -0.02em | 页面大标题 |
| `title-1` | 28px | 700 | 34px | -0.015em | 页面标题 |
| `title-2` | 22px | 700 | 28px | -0.01em | 区块标题 |
| `title-3` | 20px | 600 | 25px | -0.005em | 卡片标题 |
| `headline` | 17px | 600 | 22px | 0 | 列表标题 |
| `body` | 16px | 400 | 22px | 0 | 正文 |
| `callout` | 15px | 400 | 20px | 0 | 说明文字 |
| `subhead` | 14px | 400 | 18px | 0 | 小标题 |
| `footnote` | 13px | 400 | 18px | 0.01em | 脚注/元信息 |
| `caption` | 12px | 400 | 16px | 0.02em | 标签/时间戳 |

### 4.3 排版规则
- 字距与行高必须随字号变化：大字收紧，小字略松。
- 标题用 weight 建立层级，不依赖颜色或下划线。
- 正文行高至少 1.375。
- 使用 `font-optical-sizing: auto` 让系统字体自动调整字形。
- 响应式缩放通过 `clamp()` 或断点模拟 Dynamic Type，避免固定 px 破坏布局。

---

## 5. 图标（Iconography）

- 使用 **SF Symbols** 或等价的线性图标库（Heroicons、Phosphor）。
- 风格：2px 描边、圆角端点、填充版用于选中态。
- 尺寸：导航/工具栏 20px，列表前缀 16px，空状态 40-48px。
- 图标继承当前文字色（`currentColor`），与文字间距 8px。
- 避免 emoji 作为功能图标。

---

## 6. 组件规范（Components）

### 6.1 按钮（Buttons）
| 类型 | 背景 | 文字 | 圆角 | 高度 | Hover | Active |
|------|------|------|------|------|-------|--------|
| Primary | accent | white | 8px | 36px | 亮度+5%/+8% | scale(0.97) |
| Secondary | secondary-background | label-primary | 8px | 36px | 背景变化 | scale(0.97) |
| Ghost | transparent | accent | 8px | 36px | 极淡强调背景 | scale(0.97) |
| Toolbar | transparent | label-secondary | 9999px | 28px | 圆形浅灰背景 | scale(0.95) |

- 禁用态：opacity 0.4，cursor not-allowed。
- 反馈发生在 pointer-down，而不是 click/up。

### 6.2 输入框（Inputs）
- 背景：tertiary-background
- 边框：默认无，聚焦时 2px accent 边框或外发光
- 圆角 8px，高度 36px，内边距 12px
- 占位符：label-tertiary
- 错误态：error 色 + 简短文案

### 6.3 卡片（Cards）
- 背景：secondary/tertiary-background，圆角 12px
- 内边距 16-20px，间距 12px
- 阴影在 Light 下极淡，Dark 下基本无
- Hover：背景色变化或轻微 scale(1.005)

### 6.4 列表（Lists）
- 行高 44px，分隔线 separator 色 1px
- 选中态：浅灰背景（Light）/ 深蓝灰背景（Dark）
- 图标 20px，右侧 Chevron 16px

### 6.5 标签/徽章（Tags/Badges）
- 背景：强调色 12% 透明度
- 文字：accent，圆角 9999px
- 内边距 4px 10px，字号 caption

### 6.6 模态弹窗（Modals）
- 遮罩：`rgba(0,0,0,0.4)` + backdrop-blur
- 弹窗背景：system-background，圆角 16px
- 阴影：`0 20px 40px rgba(0,0,0,0.2)`
- 最大宽度 480px / 720px，内边距 24px
- 动画：遮罩淡入 + 内容从下方 12px 滑入，200ms，ease-out

### 6.7 Toast / 通知
- 毛玻璃背景，圆角 12px
- 顶部居中或右上角，持续 3-5 秒
- 动画：滑入 + 淡出

---

## 7. 布局（Layout）

### 7.1 页面结构
- **侧边栏**：220-260px，毛玻璃背景，固定左侧。
- **内容区**：自适应，最大宽度 1200px。
- **顶部工具栏**：48-52px，与侧边栏同材质。
- **底部状态栏**：28px，仅关键状态。

### 7.2 响应式断点
| 断点 | 范围 | 边距 |
|------|------|------|
| 桌面 | >= 1280px | 32px |
| 平板 | 768px – 1279px | 24px |
| 手机 | < 768px | 16px |

### 7.3 Z-Index 层级
| 层级 | 元素 |
|------|------|
| 1000 | 模态遮罩/弹窗 |
| 900 | Toast / 通知 |
| 800 | 下拉菜单 / Popover |
| 700 | 固定导航/侧边栏 |
| 100 | 浮动操作按钮 |
| 0-10 | 普通内容 |

---

## 8. 动效与交互（Motion & Interaction）

### 8.1 核心原则（来自 Designing Fluid Interfaces）
- **Response 响应**：在 pointer-down 瞬间给出反馈，消除延迟。
- **Direct manipulation 直接操控**：拖拽内容必须 1:1 跟随手指/指针，尊重 grab offset。
- **Interruptibility 可打断**：每个动画都能随时被反向、被抓取，必须从当前**呈现值**而非目标值开始新的动画。
- **Behavior over animation**：使用弹簧（spring）而非固定时长动画，让运动能响应新输入。
- **Velocity handoff 速度交接**：手势释放时，动画应继承手指的瞬时速度。
- **Spatial consistency 空间一致性**：进入与退出走同一路径，popover 从触发元素处展开。

### 8.2 弹簧参数
| 交互 | Damping | Response | 说明 |
|------|---------|----------|------|
| 默认 UI 动画 | 1.0 | 0.3-0.4s | 临界阻尼，无回弹 |
| 有动量的交互（滑动释放） | 0.8 | 0.3-0.4s | 轻微回弹 |
| 拖拽/平移 | 1.0 | 0.4s | 平滑 settle |

> Web 映射：Framer Motion / Motion 的 `type: 'spring', bounce, duration` 与 Apple 的 damping + response 接近。

### 8.3 标准时长
| 类型 | 时长 | Easing |
|------|------|--------|
| 微交互（按钮/切换） | 150ms | ease-in-out |
| 弹窗/面板出现 | 200ms | cubic-bezier(0.16, 1, 0.3, 1) |
| 页面转场 | 250ms | ease-out |
| 列表项插入/删除 | 200ms | ease-in-out |

### 8.4 具体反馈
- **按钮按下**：scale(0.97)，100-150ms，从 pointer-down 开始。
- **页面切换**：淡入 + 轻微位移，路径一致。
- **列表加载**：逐行淡入，每项延迟 30ms。
- **Hover**：背景色过渡 150ms。
- **模态出现**：遮罩淡入 + 内容从下方 12px 滑入。
- **拖拽边界**：使用 rubber-banding，渐进式阻力，不硬停。
- **玻璃材质出现**：同时动画 blur radius 与 scale，让材质「到来」而非单纯淡入。

### 8.5 手势与弹簧实现提示
```js
import { animate } from 'motion';

// 默认无回弹
animate(el, { y: 0 }, { type: 'spring', bounce: 0, duration: 0.4 });

// 动量释放，轻微回弹
animate(el, { y: target }, { type: 'spring', bounce: 0.2, duration: 0.4 });
```

- 使用 Pointer Events + `setPointerCapture` 保证拖拽超出元素边界仍能跟踪。
- 记录最近几次 pointermove 的速度，释放时作为 spring 初始速度。
- 用速度符号（sign）决定是回退还是提交，而非仅看位置。
- 临界阻尼为默认；回弹只留给真正带有动量的交互。

---

## 9. 主题（Light / Dark Mode）

- 所有颜色通过 CSS 变量定义。
- 通过 `prefers-color-scheme` 自动切换，并提供手动开关持久化。
- Dark Mode：真正深色背景、带透明度的白色层级文字、减少阴影、图片适度降低饱和度。

---

## 10. 可访问性（Accessibility）

- 对比度 ≥ 4.5:1（正文），≥ 3:1（大标题/图标）。
- 键盘可访问，可见 focus 状态：2px accent 外框或外发光。
- 图标按钮提供 `aria-label`，表单与 `<label>` 关联。
- 支持浏览器字号缩放至 200% 不崩坏。
- 尊重 `prefers-reduced-motion`：用淡入淡出替代滑动/弹簧，关闭回弹。
- 尊重 `prefers-reduced-transparency`：提高背景不透明度、取消 blur。
- 避免全屏移动背景、慢速循环振荡、亮度骤变。

---

## 11. 实现建议（Implementation Stack）

| 层级 | 推荐方案 |
|------|----------|
| 框架 | React / Vue / 现有框架 |
| CSS | Tailwind CSS + 自定义主题令牌 |
| 图标 | SF Symbols / Heroicons / Phosphor |
| 组件 | Headless UI / Radix / 自研 |
| 弹簧动画 | Framer Motion / Motion |
| 毛玻璃 | `backdrop-filter: blur(20px) saturate(180%)` |

### 11.1 Tailwind 主题扩展示例
```js
// tailwind.config.js 节选
module.exports = {
  theme: {
    extend: {
      colors: {
        'system-background': 'var(--system-background)',
        'secondary-background': 'var(--secondary-background)',
        'tertiary-background': 'var(--tertiary-background)',
        'label-primary': 'var(--label-primary)',
        'label-secondary': 'var(--label-secondary)',
        'label-tertiary': 'var(--label-tertiary)',
        'separator': 'var(--separator)',
        'accent': 'var(--accent)',
        'success': 'var(--success)',
        'warning': 'var(--warning)',
        'error': 'var(--error)',
      },
      fontFamily: {
        sans: ['"SF Pro Text"', '"SF Pro Display"', '-apple-system', 'BlinkMacSystemFont', '"PingFang SC"', 'sans-serif'],
        mono: ['"SF Mono"', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      borderRadius: {
        'apple': '10px',
        'apple-lg': '16px',
      },
      boxShadow: {
        'float': '0 10px 30px rgba(0,0,0,0.12)',
        'modal': '0 20px 40px rgba(0,0,0,0.2)',
      }
    }
  }
}
```

### 11.2 CSS 变量
```css
:root {
  --system-background: #FFFFFF;
  --secondary-background: #F2F2F7;
  --tertiary-background: #FFFFFF;
  --label-primary: rgba(0, 0, 0, 0.95);
  --label-secondary: rgba(60, 60, 67, 0.60);
  --label-tertiary: rgba(60, 60, 67, 0.30);
  --separator: rgba(198, 198, 200, 0.36);
  --accent: #007AFF;
  --success: #34C759;
  --warning: #FF9500;
  --error: #FF3B30;
}

@media (prefers-color-scheme: dark) {
  :root {
    --system-background: #000000;
    --secondary-background: #1C1C1E;
    --tertiary-background: #2C2C2E;
    --label-primary: #FFFFFF;
    --label-secondary: rgba(235, 235, 245, 0.60);
    --label-tertiary: rgba(235, 235, 245, 0.30);
    --separator: rgba(56, 56, 58, 1);
    --accent: #0A84FF;
    --success: #30D158;
    --warning: #FF9F0A;
    --error: #FF453A;
  }
}
```

---

## 12. 设计审查清单（Design Review Checklist）

- [ ] 是否使用系统语义色并支持 Dark Mode？
- [ ] 字号、字重、字距、行高是否符合排版规范？
- [ ] 关键操作是否一眼可识别（强调色）？
- [ ] 界面是否有足够留白？
- [ ] 所有交互元素是否有 Hover / Active / Focus 状态？
- [ ] 按钮反馈是否从 pointer-down 开始？
- [ ] 动画是否自然、可打断、从当前呈现值开始？
- [ ] 弹簧参数是否合理（默认无回弹，动量交互轻微回弹）？
- [ ] 是否满足基础可访问性（对比度、键盘、aria-label、reduce-motion）？
- [ ] 图标风格是否统一、表意清晰？
- [ ] 玻璃材质文字是否 legible？
- [ ] 移动端布局是否经过验证？

---

## 13. 参考资源

- [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines)
- [SF Symbols](https://developer.apple.com/sf-symbols/)
- [San Francisco Fonts](https://developer.apple.com/fonts/)
- [Designing Fluid Interfaces (WWDC 2018)](https://developer.apple.com/videos/play/wwdc2018/803/)
- [The Details of UI Typography (WWDC 2020)](https://developer.apple.com/videos/play/wwdc2020/110/)
- [Tailwind CSS](https://tailwindcss.com/)
- [Motion — Web springs](https://motion.dev/)
- [WCAG 2.1 对比度要求](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum)

---

*文档版本：v1.0*  
*维护者：设计 & 前端团队*  
*最后更新：2025 年*
