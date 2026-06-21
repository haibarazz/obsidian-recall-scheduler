# 复习弹窗 UI 留白规范

这份规范记录本插件弹窗 UI 的稳定设计方向。以后调整复习弹窗、新增/编辑弹窗、提醒弹窗时，优先按这里处理，避免再次走偏。

## 目标风格

- 弹窗是小型 popup，不做侧边面板。
- 视觉方向是卡片式、像素卡通细节、柔和 clay/neumorphic 质感。
- 外层边框大小基本稳定，内容在面板内部有呼吸感。
- 不靠放大整体组件解决拥挤问题。

## 不要做

- 不要通过改大 `width`、`max-width`、`height`、`min-height` 来解决贴边。
- 不要使用 `zoom` 或 `transform: scale(...)` 放大整个弹窗。
- 不要增大 `font-size` 来制造视觉重量。
- 不要只改 card 内部文字 padding，却让顶部按钮区和卡片外框仍然贴近外层边框。
- 不要依赖 Obsidian 默认 `mod-cta` / `mod-warning` 颜色，浅背景上会出现白字看不清。

## 正确做法

### 1. 用统一内容容器内缩

主复习弹窗应让 header、筛选按钮、empty state、review list 共用同一个内容容器：

```ts
const bodyEl = contentEl.createDiv({ cls: 'recall-scheduler-panel-body' });
```

然后把这些区域挂在 `bodyEl` 下，而不是直接挂在 `contentEl` 下。

```ts
const header = bodyEl.createDiv({ cls: 'recall-scheduler-modal-header' });
const toolbar = bodyEl.createDiv({ cls: 'recall-scheduler-modal-toolbar' });
const listEl = bodyEl.createDiv({ cls: 'recall-scheduler-queue-list' });
```

编辑弹窗、提醒弹窗、确认删除弹窗也应该复用这个 wrapper：

```ts
contentEl.createDiv({ cls: 'recall-scheduler-panel-body recall-scheduler-editor-body' });
contentEl.createDiv({ cls: 'recall-scheduler-panel-body recall-scheduler-alarm-body' });
```

### 2. 内容整体向内收

优先改 wrapper 的左右 padding，让顶部按钮区和卡片外边框一起对齐：

```css
.recall-scheduler-panel-body {
	box-sizing: border-box;
	padding-left: 40px;
	padding-right: 40px;
	padding-top: 18px;
	padding-bottom: 24px;
}
```

如果左右仍然贴边，先调 `.recall-scheduler-panel-body`，不要先调 `.recall-scheduler-item`。

### 3. 外层面板尺寸保持稳定

外层面板可以有 `box-sizing: border-box`，但不要为了留白继续放大宽度：

```css
.recall-scheduler-modal {
	width: min(590px, calc(100vw - 64px));
	max-width: 640px;
	box-sizing: border-box;
	padding-inline: 0;
}
```

这里的 `padding-inline: 0` 是为了让真正的左右内缩由 `.recall-scheduler-panel-body` 统一控制。

### 4. 卡片不要顶满错误层级

复习卡片应在 list/container 内自然布局：

```css
.recall-scheduler-item {
	box-sizing: border-box;
	width: auto;
	margin-left: 0;
	margin-right: 0;
}
```

不要用 `width: 100%` 配合负 margin，也不要 `position: absolute; left: 0`。

### 5. 纵向呼吸感用 gap 和 margin

上下拥挤时，改这些位置：

```css
.recall-scheduler-modal-header {
	margin-bottom: 34px;
}

.recall-scheduler-modal-toolbar {
	margin: 10px 0 46px;
}

.recall-scheduler-item {
	gap: 24px;
	padding-block: 34px 32px;
	margin-bottom: 28px;
}
```

不要用整体高度或 scale 解决上下拥挤。

### 6. 表单和提醒弹窗也要统一留白

新增/编辑表单：

```css
.recall-scheduler-editor-form {
	gap: 16px;
	margin-top: 24px;
}

.recall-scheduler-editor-actions {
	margin-top: 24px;
}
```

提醒/确认弹窗：

```css
.recall-scheduler-alarm-summary {
	margin: 0 0 22px;
	line-height: 1.62;
}

.recall-scheduler-alarm-list {
	margin: 0 0 24px;
	padding: 16px 20px;
}
```

### 7. 按钮文字必须可读

所有复习弹窗内按钮都应强制使用深色文字：

```css
.recall-scheduler-modal button,
.recall-scheduler-editor-modal button,
.recall-scheduler-file-picker-modal button,
.recall-scheduler-alarm-modal button {
	color: var(--recall-ink) !important;
	text-shadow: none;
}
```

`mod-warning` 用深红文字，不要白字：

```css
.recall-scheduler-sidebar-btn.mod-warning {
	color: #5f241f !important;
}
```

## 调整前检查清单

- 顶部按钮区是否和复习卡片左边缘对齐？
- 卡片外边框距离外层面板左右边框是否至少有 32-40px？
- 页面上下是否有足够留白，尤其 header 到按钮、按钮到列表之间？
- 是否误改了外层 `width/max-width/height/font-size/scale`？
- 所有按钮文字在浅背景上是否清楚可读？
- 编辑弹窗、提醒弹窗、确认删除弹窗是否也套了 `recall-scheduler-panel-body`？
