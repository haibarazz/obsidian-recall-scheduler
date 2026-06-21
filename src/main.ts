import {
	App,
	TAbstractFile,
	ItemView,
	WorkspaceLeaf,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
} from 'obsidian';
import {
	DEFAULT_MEMORY_SCHEDULER_SETTINGS,
	DAYS_MS,
	estimateRetention,
	formatMinuteSteps,
	memoryStateLabel,
	normalizeMemoryProgress,
	normalizeMemorySchedulerSettings,
	parseMinuteSteps,
	scheduleNextReview,
	type MemoryProgress,
	type MemorySchedulerSettings,
	type ReviewFeedback,
} from './scheduler';
import {
	basenameFromPath,
	filterReviewItemsByStatus,
	findDuplicateReviewTargets,
	getReviewLeaderboard,
	scoreReviewFileCandidate,
	searchReviewItems,
	selectUniqueBestFileCandidate,
	summarizeStatusGroups,
	type LeaderboardPeriod,
	type ReviewRangeLevel,
	type ReviewStatusGroupId,
	type ReviewTargetLike,
} from './review-helpers';

interface RecallReviewItem extends MemoryProgress {
	id: string;
	title: string;
	sourcePath: string;
	excerpt: string;
	createdAt: string;
	anchorLine: number;
	anchorHeading: string;
	anchorLevel: ReviewRangeLevel;
	sourceBasename: string;
	sourceFileCtime?: number;
	sourceFileSize?: number;
	status: 'active' | 'archived';
}

interface RecallReviewItemEditorValues {
	title: string;
	sourcePath: string;
	excerpt: string;
	dueAt: string;
	anchorLine: string;
	anchorHeading: string;
	targets?: RecallReviewTarget[];
}

interface RecallReviewTarget {
	label: string;
	title: string;
	excerpt: string;
	anchorLine: number;
	anchorHeading: string;
	level: ReviewRangeLevel;
}

const RECALL_APPEARANCE_THEMES = [
	{ id: 'ceramic', label: '陶瓷卡片' },
	{ id: 'mint', label: '清爽文档绿' },
	{ id: 'pixel', label: '像素游戏机' },
	{ id: 'dark', label: '暗色精密' },
] as const;

type RecallAppearanceTheme = (typeof RECALL_APPEARANCE_THEMES)[number]['id'];

interface RecallSchedulerSettings {
	reminderIntervalMinutes: number;
	defaultFolder: string;
	enableStartupNotice: boolean;
	enableDesktopNotification: boolean;
	maxItemsInNotice: number;
	appearanceTheme: RecallAppearanceTheme;
	memoryScheduler: MemorySchedulerSettings;
}

interface RecallSchedulerData {
	version: number;
	settings: RecallSchedulerSettings;
	reviewItems: RecallReviewItem[];
}

const DATA_VERSION = 4;
const MINUTES_MS = 60 * 1000;
const RECALL_SIDEBAR_VIEW_TYPE = 'recall-scheduler-sidebar';

const DEFAULT_SETTINGS: RecallSchedulerSettings = {
	reminderIntervalMinutes: 10,
	defaultFolder: '',
	enableStartupNotice: true,
	enableDesktopNotification: false,
	maxItemsInNotice: 5,
	appearanceTheme: 'pixel',
	memoryScheduler: DEFAULT_MEMORY_SCHEDULER_SETTINGS,
};

function isRecallAppearanceTheme(value: unknown): value is RecallAppearanceTheme {
	return typeof value === 'string' && RECALL_APPEARANCE_THEMES.some((theme) => theme.id === value);
}

function getRecallAppearanceThemeLabel(themeId: RecallAppearanceTheme): string {
	return RECALL_APPEARANCE_THEMES.find((theme) => theme.id === themeId)?.label || '像素游戏机';
}

function applyRecallAppearanceTheme(modalEl: HTMLElement, themeId: RecallAppearanceTheme) {
	for (const theme of RECALL_APPEARANCE_THEMES) {
		modalEl.removeClass(`recall-theme-${theme.id}`);
	}
	modalEl.addClass(`recall-theme-${themeId}`);
	modalEl.setAttr('data-recall-theme', themeId);
}

export default class RecallSchedulerPlugin extends Plugin {
	settings: RecallSchedulerSettings = { ...DEFAULT_SETTINGS };
	private reviewItems: RecallReviewItem[] = [];
	private reminderIntervalId: number | null = null;
	private reminderAlarmModal: ReminderAlarmModal | null = null;

	async onload() {
		await this.loadAllData();

		this.registerView(RECALL_SIDEBAR_VIEW_TYPE, (leaf) => new RecallSchedulerSidebarView(leaf));
		this.registerFileRenameTracking();
		this.addCommands();
		this.addSettingTab(new RecallSchedulerSettingTab(this.app, this));

		this.addRibbonIcon('clock', '打开复习弹窗', () => {
			this.openReviewQueueModal();
		});
		this.app.workspace.onLayoutReady(() => {
			this.detachSidebarViews();
		});

		this.startReminderTicker();

		if (this.settings.enableStartupNotice) {
			await this.checkAndNotifyDueReviews();
		}
	}

	onunload() {
		this.stopReminderTicker();
		this.detachSidebarViews();
		this.dismissReminderAlarmModal();
	}

	private dismissReminderAlarmModal() {
		if (this.reminderAlarmModal) {
			this.reminderAlarmModal.close();
			this.reminderAlarmModal = null;
		}
	}

	private openReminderAlarmModal(dueItems: RecallReviewItem[]) {
		if (!dueItems.length) return;
		if (this.reminderAlarmModal) return;

		this.reminderAlarmModal = new ReminderAlarmModal(this.app, this, dueItems, () => {
			this.reminderAlarmModal = null;
		});
		this.reminderAlarmModal.open();
	}

	private addCommands() {
		this.addCommand({
			id: 'add-current-note-to-review-queue',
			name: '添加当前笔记到复习队列',
			checkCallback: (checking: boolean) => {
				const canRun = Boolean(this.getActiveMarkdownFile());
				if (!checking) {
					if (!canRun) {
						new Notice('请先打开并激活一个 Markdown 文件');
						return false;
					}
					void this.addCurrentNoteToReviewQueue();
				}
				return canRun;
			},
		});

		this.addCommand({
			id: 'open-review-queue',
			name: '打开复习弹窗',
			callback: () => {
				this.openReviewQueueModal();
			},
		});
	}

	private openReviewQueueModal() {
		this.detachSidebarViews();
		new ReviewQueueModal(this.app, this).open();
	}

	private registerFileRenameTracking() {
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			void this.handleVaultRename(file, oldPath);
		}));
	}

	private async handleVaultRename(file: TAbstractFile, oldPath: string) {
		if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') return;
		let changed = false;
		const sourceMetadata = this.getSourceMetadata(file);
		this.reviewItems = this.reviewItems.map((item) => {
			if (item.sourcePath !== oldPath) return item;
			changed = true;
			return {
				...item,
				sourcePath: file.path,
				...sourceMetadata,
			};
		});
		if (!changed) return;
		await this.saveAllData();
		this.refreshSidebarViews();
	}

	private async loadAllData() {
		const loaded = (await this.loadData()) as Partial<RecallSchedulerData> | null;

		this.settings = this.normalizeSettings(loaded?.settings);

		const persistedItems = Array.isArray(loaded?.reviewItems)
			? loaded?.reviewItems
			: [];
		this.reviewItems = persistedItems
			.filter((item): item is RecallReviewItem => this.isValidReviewItem(item))
			.map((item) => this.normalizeReviewItem(item));
	}

	private async saveAllData() {
		await this.saveData({
			version: DATA_VERSION,
			settings: this.settings,
			reviewItems: this.reviewItems,
		});
	}

	private normalizeSettings(
		rawSettings: Partial<RecallSchedulerSettings> | undefined,
	): RecallSchedulerSettings {
		return {
			reminderIntervalMinutes: this.normalizePositiveInteger(
				rawSettings?.reminderIntervalMinutes,
				DEFAULT_SETTINGS.reminderIntervalMinutes,
				1,
			),
			defaultFolder:
				typeof rawSettings?.defaultFolder === 'string'
					? rawSettings?.defaultFolder
					: DEFAULT_SETTINGS.defaultFolder,
			enableStartupNotice:
					typeof rawSettings?.enableStartupNotice === 'boolean'
						? rawSettings.enableStartupNotice
						: DEFAULT_SETTINGS.enableStartupNotice,
			enableDesktopNotification:
					typeof rawSettings?.enableDesktopNotification === 'boolean'
						? rawSettings.enableDesktopNotification
						: DEFAULT_SETTINGS.enableDesktopNotification,
			maxItemsInNotice: this.normalizePositiveInteger(
				rawSettings?.maxItemsInNotice,
				DEFAULT_SETTINGS.maxItemsInNotice,
				1,
			),
			appearanceTheme: isRecallAppearanceTheme(rawSettings?.appearanceTheme)
				? rawSettings.appearanceTheme
				: DEFAULT_SETTINGS.appearanceTheme,
			memoryScheduler: normalizeMemorySchedulerSettings(rawSettings?.memoryScheduler),
		};
	}

	private normalizePositiveInteger(
		value: unknown,
		fallback: number,
		minimum: number,
	): number {
		const parsed =
			typeof value === 'number'
				? value
				: typeof value === 'string'
					? Number.parseInt(value, 10)
					: NaN;
		if (!Number.isFinite(parsed)) {
			return fallback;
		}
		const rounded = Math.floor(parsed);
		return rounded >= minimum ? rounded : minimum;
	}

	private isValidReviewItem(item: unknown): item is RecallReviewItem {
		return (
			typeof item === 'object' &&
			item !== null &&
			typeof (item as { id?: unknown }).id === 'string' &&
			typeof (item as { title?: unknown }).title === 'string' &&
			typeof (item as { sourcePath?: unknown }).sourcePath === 'string' &&
			typeof (item as { excerpt?: unknown }).excerpt === 'string' &&
			typeof (item as { createdAt?: unknown }).createdAt === 'string' &&
			typeof (item as { dueAt?: unknown }).dueAt === 'string' &&
			(typeof (item as { lastReviewedAt?: unknown }).lastReviewedAt === 'string' ||
				(item as { lastReviewedAt?: unknown }).lastReviewedAt === null) &&
			((item as { intervalDays?: unknown }).intervalDays === undefined ||
				typeof (item as { intervalDays?: unknown }).intervalDays === 'number') &&
			((item as { reviewCount?: unknown }).reviewCount === undefined ||
				typeof (item as { reviewCount?: unknown }).reviewCount === 'number') &&
			((item as { stability?: unknown }).stability === undefined ||
				typeof (item as { stability?: unknown }).stability === 'number') &&
			((item as { difficulty?: unknown }).difficulty === undefined ||
				typeof (item as { difficulty?: unknown }).difficulty === 'number') &&
			((item as { memoryState?: unknown }).memoryState === undefined ||
				typeof (item as { memoryState?: unknown }).memoryState === 'string') &&
			((item as { learningStep?: unknown }).learningStep === undefined ||
				typeof (item as { learningStep?: unknown }).learningStep === 'number') &&
			((item as { relearningStep?: unknown }).relearningStep === undefined ||
				typeof (item as { relearningStep?: unknown }).relearningStep === 'number') &&
			((item as { reviewHistory?: unknown }).reviewHistory === undefined ||
				Array.isArray((item as { reviewHistory?: unknown }).reviewHistory)) &&
			((item as { anchorLine?: unknown }).anchorLine === undefined ||
				typeof (item as { anchorLine?: unknown }).anchorLine === 'number') &&
			((item as { anchorHeading?: unknown }).anchorHeading === undefined ||
				typeof (item as { anchorHeading?: unknown }).anchorHeading === 'string') &&
			((item as { anchorLevel?: unknown }).anchorLevel === undefined ||
				typeof (item as { anchorLevel?: unknown }).anchorLevel === 'number') &&
			((item as { sourceBasename?: unknown }).sourceBasename === undefined ||
				typeof (item as { sourceBasename?: unknown }).sourceBasename === 'string') &&
			((item as { sourceFileCtime?: unknown }).sourceFileCtime === undefined ||
				typeof (item as { sourceFileCtime?: unknown }).sourceFileCtime === 'number') &&
			((item as { sourceFileSize?: unknown }).sourceFileSize === undefined ||
				typeof (item as { sourceFileSize?: unknown }).sourceFileSize === 'number') &&
			((item as { status?: unknown }).status === 'active' ||
				(item as { status?: unknown }).status === 'archived')
		);
	}

	private normalizeReviewItem(item: RecallReviewItem): RecallReviewItem {
		const memoryProgress = normalizeMemoryProgress(item, this.nowString());
		return {
			...memoryProgress,
			id: String(item.id),
			title: item.title || '未命名复习项',
			sourcePath: item.sourcePath || '',
			excerpt: item.excerpt || '',
			createdAt: item.createdAt || this.nowString(),
			anchorLine: this.normalizeAnchorLine((item as { anchorLine?: unknown }).anchorLine),
			anchorHeading:
				typeof (item as { anchorHeading?: unknown }).anchorHeading === 'string'
					? (item as { anchorHeading?: string }).anchorHeading || ''
					: '',
			anchorLevel: this.normalizeAnchorLevel(
				(item as { anchorLevel?: unknown }).anchorLevel,
				(item as { anchorHeading?: string }).anchorHeading || '',
				(item as { anchorLine?: unknown }).anchorLine,
			),
			sourceBasename:
				typeof (item as { sourceBasename?: unknown }).sourceBasename === 'string'
					? (item as { sourceBasename?: string }).sourceBasename || basenameFromPath(item.sourcePath)
					: basenameFromPath(item.sourcePath),
			sourceFileCtime: this.normalizeOptionalNumber((item as { sourceFileCtime?: unknown }).sourceFileCtime),
			sourceFileSize: this.normalizeOptionalNumber((item as { sourceFileSize?: unknown }).sourceFileSize),
			status: item.status === 'archived' ? 'archived' : 'active',
		};
	}

	private normalizeAnchorLine(value: unknown): number {
		const parsed =
			typeof value === 'number'
				? Math.floor(value)
				: typeof value === 'string'
					? Number.parseInt(value, 10)
					: -1;
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : -1;
	}

	private normalizeAnchorLevel(
		value: unknown,
		anchorHeading: string,
		anchorLine: unknown,
	): ReviewRangeLevel {
		if (value === 0 || value === 1 || value === 2 || value === 3) {
			return value;
		}
		const normalizedAnchorLine = this.normalizeAnchorLine(anchorLine);
		return anchorHeading.trim() || normalizedAnchorLine >= 0 ? 1 : 0;
	}

	private normalizeOptionalNumber(value: unknown): number | undefined {
		return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
	}

	private getSourceMetadata(fileOrPath: TFile | string): {
		sourceBasename: string;
		sourceFileCtime?: number;
		sourceFileSize?: number;
	} {
		if (fileOrPath instanceof TFile) {
			return {
				sourceBasename: fileOrPath.basename,
				sourceFileCtime: fileOrPath.stat.ctime,
				sourceFileSize: fileOrPath.stat.size,
			};
		}
		const file = this.app.vault.getAbstractFileByPath(fileOrPath);
		if (file instanceof TFile) {
			return this.getSourceMetadata(file);
		}
		return {
			sourceBasename: basenameFromPath(fileOrPath),
		};
	}

	private createReviewItemFromTarget(
		sourcePath: string,
		target: ReviewTargetLike,
		dueAt: string,
		now: string,
		excerptOverride = '',
	): RecallReviewItem {
		return {
			...normalizeMemoryProgress(undefined, now),
			id: this.generateId(),
			title: target.title,
			sourcePath,
			excerpt: excerptOverride.trim().length > 0 ? excerptOverride.trim() : target.excerpt,
			createdAt: now,
			dueAt,
			anchorLine: target.anchorLine,
			anchorHeading: target.anchorHeading,
			anchorLevel: target.level,
			...this.getSourceMetadata(sourcePath),
			status: 'active',
		};
	}

	private async addReviewTargetsToQueue(
		sourcePath: string,
		targets: ReviewTargetLike[],
		dueAt: string,
		excerptOverride = '',
	): Promise<number> {
		const duplicateResult = findDuplicateReviewTargets(this.reviewItems, sourcePath, targets);
		const skippedCount = duplicateResult.exactDuplicates.length + duplicateResult.archivedDuplicates.length;
		if (duplicateResult.sameNoteDifferentTargets.length > 0) {
			new Notice('这个笔记已经有复习项了；不同标题会继续添加。');
		}
		if (duplicateResult.exactDuplicates.length > 0) {
			new Notice(`已跳过 ${duplicateResult.exactDuplicates.length} 个完全重复的复习项。`);
		}
		if (duplicateResult.archivedDuplicates.length > 0) {
			new Notice(`已跳过 ${duplicateResult.archivedDuplicates.length} 个已在归档中的重复项。`);
		}
		if (duplicateResult.acceptedTargets.length === 0) {
			new Notice(skippedCount > 0 ? '没有新增复习项。' : '请选择至少一个复习范围。');
			return 0;
		}

		const now = this.nowString();
		for (const target of duplicateResult.acceptedTargets) {
			this.reviewItems.unshift(this.createReviewItemFromTarget(sourcePath, target, dueAt, now, excerptOverride));
		}
		await this.saveAllData();
		this.refreshSidebarViews();
		new Notice(`已新增 ${duplicateResult.acceptedTargets.length} 个复习项。`);
		return duplicateResult.acceptedTargets.length;
	}

	private getActiveMarkdownFile() {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension.toLowerCase() !== 'md') return null;
		return file;
	}

	public async addCurrentNoteToReviewQueue(onAdded?: () => void) {
		const activeFile = this.getActiveMarkdownFile();
		if (!activeFile) {
			new Notice('未检测到当前文件，无法添加复习项');
			return;
		}

		const selectedText = this.getActiveSelectionText().trim();
		const targets = await this.getReviewTargetsForActiveFile(activeFile);
		new ReviewTargetPickerModal(this.app, targets, (selectedTargets) => {
			void this.addReviewTargetsToQueue(
				activeFile.path,
				selectedTargets,
				this.nowString(),
				selectedText,
			).then((createdCount) => {
				if (createdCount > 0) onAdded?.();
			});
		}, this.settings.appearanceTheme).open();
	}

	private getReviewItemFromActiveEditor(): RecallReviewItemEditorValues | null {
		const activeFile = this.getActiveMarkdownFile();
		if (!activeFile) return null;

		const anchor = this.getReviewAnchor();
		const selectedText = this.getActiveSelectionText().trim();
		return {
			title: activeFile.basename,
			sourcePath: activeFile.path,
			excerpt: selectedText.length > 0 ? selectedText : activeFile.basename,
			dueAt: this.toInputDateTimeValue(this.nowString()),
			anchorLine: String(anchor.anchorLine >= 0 ? anchor.anchorLine : -1),
			anchorHeading: anchor.anchorHeading,
		};
	}

	public async openItemEditor(item?: RecallReviewItem) {
		let defaults: RecallReviewItemEditorValues;
		if (item) {
			defaults = {
				title: item.title,
				sourcePath: item.sourcePath,
				excerpt: item.excerpt,
				dueAt: this.toInputDateTimeValue(item.dueAt),
				anchorLine: String(item.anchorLine),
				anchorHeading: item.anchorHeading,
			};
		} else {
			const activeDefaults = this.getReviewItemFromActiveEditor();
			if (activeDefaults) {
				defaults = activeDefaults;
			} else {
				defaults = {
					title: '',
					sourcePath: '',
					excerpt: '',
					dueAt: this.toInputDateTimeValue(this.nowString()),
					anchorLine: '-1',
					anchorHeading: '',
				};
			}
		}

		new RecallItemEditorModal(this.app, this, item, defaults).open();
	}

	public async saveReviewItemFromForm(
		values: RecallReviewItemEditorValues,
		existingItem?: RecallReviewItem,
	) {
		const dueAt = this.parseDueAt(values.dueAt);
		const title = values.title.trim() || '未命名复习项';
		const sourcePath = values.sourcePath.trim();
		if (!sourcePath) {
			new Notice('源文件路径不能为空');
			return;
		}
		const anchorLine = Number.parseInt(values.anchorLine, 10);
		const normalizedAnchorLine = Number.isFinite(anchorLine) ? Math.max(-1, anchorLine) : -1;
		const selectedTargets = values.targets ?? [];
		const selectedTarget = selectedTargets.length === 1 ? selectedTargets[0] : undefined;

		if (existingItem) {
			const index = this.reviewItems.findIndex((item) => item.id === existingItem.id);
			if (index === -1) {
				new Notice('未找到要编辑的复习项');
				return;
			}
			const oldItem = this.reviewItems[index];
			if (!oldItem) {
				new Notice('未找到要编辑的复习项');
				return;
			}
			this.reviewItems[index] = {
				...oldItem,
				title,
				sourcePath,
				excerpt: values.excerpt,
				dueAt,
				anchorLine: normalizedAnchorLine,
				anchorHeading: values.anchorHeading.trim(),
				anchorLevel: selectedTarget?.level ?? this.normalizeAnchorLevel(
					oldItem.anchorLevel,
					values.anchorHeading.trim(),
					normalizedAnchorLine,
				),
				...this.getSourceMetadata(sourcePath),
			};
			await this.saveAllData();
			this.refreshSidebarViews();
			new Notice('复习项已更新');
			return;
		}

		const targetsToCreate: ReviewTargetLike[] = selectedTargets.length > 1
			? selectedTargets
			: [{
				title,
				excerpt: values.excerpt,
				anchorLine: normalizedAnchorLine,
				anchorHeading: values.anchorHeading.trim(),
				level: selectedTarget?.level ?? this.normalizeAnchorLevel(
					undefined,
					values.anchorHeading.trim(),
					normalizedAnchorLine,
				),
			}];
		await this.addReviewTargetsToQueue(sourcePath, targetsToCreate, dueAt);
	}

	getDueReviewItems() {
		const now = Date.now();
		return this.reviewItems
			.filter((item) => item.status === 'active' && this.isDueNow(item, now))
			.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
	}

	getTodayReviewItems() {
		const endOfToday = new Date();
		endOfToday.setHours(23, 59, 59, 999);
		return this.reviewItems
			.filter((item) => {
				if (item.status !== 'active') return false;
				const dueAt = Date.parse(item.dueAt);
				return Number.isFinite(dueAt) && dueAt <= endOfToday.getTime();
			})
			.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
	}

	public getSidebarItems(showArchived: boolean) {
		const items = this.reviewItems.filter((item) =>
			showArchived ? item.status === 'archived' : item.status === 'active',
		);
		return items.sort((a, b) => {
			const aTs = Date.parse(a.dueAt);
			const bTs = Date.parse(b.dueAt);
			const aSafe = Number.isFinite(aTs) ? aTs : 0;
			const bSafe = Number.isFinite(bTs) ? bTs : 0;
			return showArchived ? bSafe - aSafe : aSafe - bSafe;
		});
	}

	public getAllReviewItems() {
		return this.reviewItems.slice();
	}

	public getMemorySummary(item: RecallReviewItem): string {
		const lastReviewedAt = typeof item.lastReviewedAt === 'string' ? Date.parse(item.lastReviewedAt) : NaN;
		const elapsedDays = Number.isFinite(lastReviewedAt)
			? Math.max(0, (Date.now() - lastReviewedAt) / DAYS_MS)
			: 0;
		const retention = estimateRetention(item.stability, elapsedDays);
		const state = item.status === 'archived' ? 'archived' : item.memoryState;
		return `状态：${memoryStateLabel(state)} · 稳定度：${item.stability.toFixed(1)}天 · 难度：${item.difficulty.toFixed(1)}/10 · 保留率：${Math.round(retention * 100)}%`;
	}

	public async archiveReviewItem(itemId: string) {
		const index = this.reviewItems.findIndex((item) => item.id === itemId);
		if (index === -1) {
			new Notice('未找到复习项');
			return;
		}
		const existingItem = this.reviewItems[index];
		if (!existingItem) {
			new Notice('未找到复习项');
			return;
		}
		if (existingItem.status === 'archived') {
			new Notice('该复习项已归档');
			return;
		}

		this.reviewItems[index] = {
			...existingItem,
			status: 'archived',
		};
		await this.saveAllData();
		this.refreshSidebarViews();
		new Notice('复习项已归档，可恢复');
	}

	public async restoreReviewItem(itemId: string) {
		const index = this.reviewItems.findIndex((item) => item.id === itemId);
		if (index === -1) {
			new Notice('未找到复习项');
			return;
		}
		const existingItem = this.reviewItems[index];
		if (!existingItem) {
			new Notice('未找到复习项');
			return;
		}
		if (existingItem.status === 'active') {
			new Notice('该复习项未归档');
			return;
		}

		this.reviewItems[index] = {
			...existingItem,
			status: 'active',
		};
		await this.saveAllData();
		this.refreshSidebarViews();
		new Notice('复习项已恢复');
	}

	public async deleteArchivedReviewItem(itemId: string) {
		const index = this.reviewItems.findIndex((item) => item.id === itemId && item.status === 'archived');
		if (index === -1) {
			new Notice('未找到归档项');
			return;
		}
		this.reviewItems.splice(index, 1);
		await this.saveAllData();
		this.refreshSidebarViews();
		new Notice('已删除归档复习项（不可恢复）');
	}

	public async applyReviewFeedback(itemId: string, feedback: ReviewFeedback) {
		const itemIndex = this.reviewItems.findIndex(
			(item) => item.id === itemId && item.status === 'active',
		);
		if (itemIndex === -1) {
			new Notice('未找到该复习项');
			return;
		}

		const now = new Date();
		const currentItem = this.reviewItems[itemIndex];
		if (!currentItem) {
			new Notice('未找到该复习项');
			return;
		}
		const result = scheduleNextReview(
			{
				...currentItem,
				reviewHistory: [...currentItem.reviewHistory],
			},
			feedback,
			this.settings.memoryScheduler,
			now,
		);

		this.reviewItems[itemIndex] = result.item;
		await this.saveAllData();
		this.refreshSidebarViews();
		new Notice(`复习项已更新：${result.item.title}，${result.summary}`);
	}

	private isDueNow(item: RecallReviewItem, nowTimestamp: number): boolean {
		const dueAt = Date.parse(item.dueAt);
		if (!Number.isFinite(dueAt)) return false;
		return dueAt <= nowTimestamp;
	}

	private getActiveSelectionText(): string {
		const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		return markdownView?.editor ? markdownView.editor.getSelection() : '';
	}

	private async getReviewTargetsForActiveFile(file: TFile): Promise<RecallReviewTarget[]> {
		const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (markdownView?.file?.path === file.path && markdownView.editor) {
			return this.buildReviewTargets(file.basename, markdownView.editor.getValue());
		}
		return this.getReviewTargetsForSourcePath(file.path);
	}

	public async getReviewTargetsForSourcePath(sourcePath: string): Promise<RecallReviewTarget[]> {
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile)) {
			return [this.createWholeNoteTarget(this.getBasenameFromPath(sourcePath) || '全部笔记')];
		}
		const content = await this.app.vault.cachedRead(file);
		return this.buildReviewTargets(file.basename, content);
	}

	private buildReviewTargets(noteTitle: string, content: string): RecallReviewTarget[] {
		const targets: RecallReviewTarget[] = [this.createWholeNoteTarget(noteTitle)];
		const lines = content.split(/\r?\n/);
		for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
			const lineText = lines[lineIndex] || '';
			const headingMatch = lineText.match(/^(#{1,3})\s+(.+)$/);
			if (!headingMatch) continue;
			const level = (headingMatch[1]?.length || 1) as 1 | 2 | 3;
			const heading = this.cleanHeadingText(headingMatch[2] || '');
			if (!heading) continue;
			targets.push({
				label: `${'#'.repeat(level)} ${heading}`,
				title: heading,
				excerpt: heading,
				anchorLine: lineIndex,
				anchorHeading: heading,
				level,
			});
		}
		return targets;
	}

	private createWholeNoteTarget(noteTitle: string): RecallReviewTarget {
		return {
			label: '全部笔记',
			title: noteTitle || '全部笔记',
			excerpt: noteTitle || '全部笔记',
			anchorLine: -1,
			anchorHeading: '',
			level: 0,
		};
	}

	private cleanHeadingText(value: string): string {
		return value.replace(/\s+#+\s*$/, '').trim();
	}

	private getBasenameFromPath(sourcePath: string): string {
		const filename = sourcePath.split('/').pop() || sourcePath;
		return filename.replace(/\.md$/i, '');
	}

	private getReviewAnchor(): { anchorLine: number; anchorHeading: string } {
		const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = markdownView?.editor;
		if (!editor) {
			return { anchorLine: -1, anchorHeading: '' };
		}

		const cursor = editor.getCursor('from');
		const currentLine = editor.getLine(cursor.line) || '';
		const blockIdMatch = currentLine.match(/\^([A-Za-z0-9_-]+)\s*$/);
		if (blockIdMatch) {
			const blockId = blockIdMatch[1] || '';
			return {
				anchorLine: cursor.line,
				anchorHeading: blockId,
			};
		}

		for (let line = cursor.line; line >= 0; line -= 1) {
			const lineText = editor.getLine(line) || '';
			const headingMatch = lineText.match(/^(#{1,6})\s+(.+)$/);
			if (headingMatch) {
				const heading = headingMatch[2] || '';
				return {
					anchorLine: line,
					anchorHeading: heading.trim(),
				};
			}
		}

		return {
			anchorLine: cursor.line,
			anchorHeading: '',
		};
	}

	openReviewItemSource = async (item: RecallReviewItem) => {
		let file = this.app.vault.getAbstractFileByPath(item.sourcePath);
		if (!(file instanceof TFile)) {
			file = await this.findMovedSourceFile(item);
			if (file instanceof TFile) {
				await this.updateReviewItemSource(item.id, file);
			}
		}
		if (!(file instanceof TFile)) {
			new Notice(`未找到源笔记：${item.sourcePath}。请编辑复习项重新选择文件。`);
			return;
		}
		await this.openFileAtAnchor(file, item.anchorLine, item.anchorHeading);
	};

	openSourceNote = async (sourcePath: string, anchorLine = -1, anchorHeading = '') => {
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile)) {
			new Notice(`未找到源笔记：${sourcePath}`);
			return;
		}
		await this.openFileAtAnchor(file, anchorLine, anchorHeading);
	};

	private async openFileAtAnchor(file: TFile, anchorLine = -1, anchorHeading = '') {
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);

		const markdownView = leaf.view instanceof MarkdownView ? leaf.view : null;
		if (!markdownView?.editor) return;

		const headingLine = this.findHeadingLine(markdownView, anchorHeading);
		if (headingLine >= 0) {
			this.revealEditorLine(markdownView, headingLine);
			return;
		}
		if (anchorLine < 0) return;
		this.revealEditorLine(markdownView, anchorLine);
	}

	private revealEditorLine(markdownView: MarkdownView, line: number) {
		const lastLine = markdownView.editor.lastLine();
		const targetLine = Math.max(0, Math.min(line, lastLine));
		markdownView.editor.setCursor(targetLine, 0);
		markdownView.editor.scrollIntoView(
			{ from: { line: targetLine, ch: 0 }, to: { line: targetLine, ch: 0 } },
			true,
		);
	}

	private findHeadingLine(markdownView: MarkdownView, anchorHeading: string): number {
		const normalizedHeading = this.cleanHeadingText(anchorHeading);
		if (!normalizedHeading || !markdownView.editor) return -1;
		for (let line = 0; line <= markdownView.editor.lastLine(); line += 1) {
			const lineText = markdownView.editor.getLine(line) || '';
			const headingMatch = lineText.match(/^(#{1,6})\s+(.+)$/);
			if (!headingMatch) continue;
			const heading = this.cleanHeadingText(headingMatch[2] || '');
			if (heading === normalizedHeading) return line;
		}
		return -1;
	}

	private async findMovedSourceFile(item: RecallReviewItem): Promise<TFile | null> {
		const candidates = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const quickScore = scoreReviewFileCandidate(item, {
				path: file.path,
				basename: file.basename,
				ctime: file.stat.ctime,
				size: file.stat.size,
			});
			const shouldReadContent =
				quickScore.score > 0 ||
				Boolean(item.anchorHeading.trim()) ||
				Boolean(item.excerpt.trim()) ||
				Boolean(item.title.trim());
			const content = shouldReadContent ? await this.app.vault.cachedRead(file) : '';
			candidates.push(scoreReviewFileCandidate(item, {
				path: file.path,
				basename: file.basename,
				ctime: file.stat.ctime,
				size: file.stat.size,
				content,
			}));
		}
		const best = selectUniqueBestFileCandidate(candidates);
		if (!best) return null;
		const file = this.app.vault.getAbstractFileByPath(best.path);
		return file instanceof TFile ? file : null;
	}

	private async updateReviewItemSource(itemId: string, file: TFile) {
		const index = this.reviewItems.findIndex((item) => item.id === itemId);
		if (index === -1) return;
		const existingItem = this.reviewItems[index];
		if (!existingItem) return;
		this.reviewItems[index] = {
			...existingItem,
			sourcePath: file.path,
			...this.getSourceMetadata(file),
		};
		await this.saveAllData();
		this.refreshSidebarViews();
		new Notice(`已修复复习项来源路径：${file.path}`);
	}

		private parseDueAt(dueAtInputValue: string): string {
			const date = new Date(dueAtInputValue);
			if (Number.isNaN(date.getTime())) {
				return this.nowString();
			}
			return date.toISOString();
		}

		public formatCountdown(dueAt: string): string {
		const due = Date.parse(dueAt);
		if (!Number.isFinite(due)) {
			return '时间无效';
		}
		const diff = due - Date.now();
		const abs = Math.abs(diff);
		const prefix = diff <= 0 ? '已逾期 ' : '剩余 ';

		const totalSeconds = Math.floor(abs / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);
		if (days > 0) {
			const remainHours = hours % 24;
			const remainMinutes = minutes % 60;
			return `${prefix}${days}天${remainHours}小时${remainMinutes}分`;
		}
		if (hours > 0) {
			const remainMinutes = minutes % 60;
			return `${prefix}${hours}小时${remainMinutes}分`;
		}
			if (minutes > 0) {
				return `${prefix}${minutes}分`;
			}
			const seconds = Math.max(0, totalSeconds);
			return `${prefix}${seconds}秒`;
		}

		public getCountdownVisualState(dueAt: string): {
			label: string;
			state: 'safe' | 'normal' | 'soon' | 'urgent' | 'overdue' | 'invalid';
			iconType: 'hourglass' | 'clock';
			progress: number;
			heatColor: string;
		} {
			const due = Date.parse(dueAt);
			if (!Number.isFinite(due)) {
				return {
					label: '时间无效',
					state: 'invalid',
					iconType: 'hourglass',
					progress: 0,
					heatColor: 'hsl(120, 78%, 48%)',
				};
			}

			const now = Date.now();
			const diffMs = due - now;
			const absMs = Math.abs(diffMs);
			let state: 'safe' | 'normal' | 'soon' | 'urgent' | 'overdue' = 'safe';
			let iconType: 'hourglass' | 'clock' = 'hourglass';

			if (diffMs <= 0) {
				state = 'overdue';
				iconType = 'clock';
			} else if (absMs <= 0.5 * 60 * 60 * 1000) {
				state = 'urgent';
				iconType = 'clock';
			} else if (absMs <= 3 * 60 * 60 * 1000) {
				state = 'soon';
			} else if (absMs <= 24 * 60 * 60 * 1000) {
				state = 'normal';
			}

			const progress = this.calculateCountdownProgress(due, now);
			return {
				label: this.formatCountdown(dueAt),
				state,
				iconType,
				progress,
				heatColor: this.getHeatColor(progress),
			};
		}

		private calculateCountdownProgress(dueMs: number, now: number): number {
			if (dueMs <= now) return 1;
			const remainingMs = dueMs - now;
			const progressWindowMs = 24 * 60 * 60 * 1000;
			const ratio = 1 - remainingMs / progressWindowMs;
			return Math.max(0, Math.min(1, ratio));
		}

		private getHeatColor(progress: number): string {
			const clamped = Math.max(0, Math.min(1, progress));
			const hue = 120 - clamped * 120;
			const lightness = 48 - clamped * 10;
			return `hsl(${hue}, 78%, ${lightness}%)`;
		}

	private toInputDateTimeValue(isoValue: string): string {
		const date = new Date(isoValue);
		if (Number.isNaN(date.getTime())) {
			return this.nowString().slice(0, 16);
		}
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		const hour = String(date.getHours()).padStart(2, '0');
		const minute = String(date.getMinutes()).padStart(2, '0');
		return `${year}-${month}-${day}T${hour}:${minute}`;
	}

	private nowString() {
		return new Date().toISOString();
	}

	private generateId() {
		if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
			return crypto.randomUUID();
		}
		return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
	}

	private async checkAndNotifyDueReviews() {
		const dueItems = this.getDueReviewItems();
		if (dueItems.length === 0) return;

		const count = dueItems.length;
		new Notice(`你有 ${count} 个知识点需要复习`);
		this.openReminderAlarmModal(dueItems);

		if (!this.settings.enableDesktopNotification) return;
		if (typeof Notification === 'undefined') return;
		if (Notification.permission === 'default') {
			const permission = await Notification.requestPermission();
			if (permission !== 'granted') return;
		}
		if (Notification.permission !== 'granted') return;

		const maxItems = Math.max(1, this.settings.maxItemsInNotice || 0);
		const detail = dueItems
			.slice(0, maxItems)
			.map((item) => `${item.title}`)
			.join('\n');
		new Notification('复习提醒', {
			body: `你有 ${count} 个知识点需要复习${detail ? `\n${detail}` : ''}`,
		});
	}

	private startReminderTicker() {
		this.stopReminderTicker();
		const intervalMinutes = Math.max(1, Math.floor(this.settings.reminderIntervalMinutes));
		const intervalMs = intervalMinutes * MINUTES_MS;
		this.reminderIntervalId = window.setInterval(() => {
			this.checkAndNotifyDueReviews().catch((error) => {
				console.error('复习提醒任务执行失败', error);
			});
		}, intervalMs);
		this.registerInterval(this.reminderIntervalId);
	}

	private stopReminderTicker() {
		if (this.reminderIntervalId !== null) {
			window.clearInterval(this.reminderIntervalId);
			this.reminderIntervalId = null;
		}
	}

	private refreshSidebarViews() {
		const leaves = this.app.workspace.getLeavesOfType(RECALL_SIDEBAR_VIEW_TYPE);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof RecallSchedulerSidebarView) {
				view.refresh();
			}
		}
	}

	private detachSidebarViews() {
		const leaves = this.app.workspace.getLeavesOfType(RECALL_SIDEBAR_VIEW_TYPE);
		for (const leaf of leaves) {
			leaf.detach();
		}
	}

	updateSettings(newSettings: RecallSchedulerSettings) {
		this.settings = this.normalizeSettings(newSettings);
		void this.saveAllData();
		this.startReminderTicker();
	}
}

class RecallSchedulerSidebarView extends ItemView {
	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return RECALL_SIDEBAR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return '复习弹窗';
	}

	getViewData(): string {
		return '';
	}

	setViewData(): void {}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		void this.leaf.detach();
	}

	async onClose(): Promise<void> {
		return;
	}

	refresh() {
		void this.leaf.detach();
	}
}

class ReviewTargetPickerModal extends Modal {
	private readonly targets: RecallReviewTarget[];
	private readonly onChoose: (targets: RecallReviewTarget[]) => void;
	private readonly appearanceTheme: RecallAppearanceTheme;

	constructor(
		app: App,
		targets: RecallReviewTarget[],
		onChoose: (targets: RecallReviewTarget[]) => void,
		appearanceTheme: RecallAppearanceTheme,
	) {
		super(app);
		this.targets = targets.length > 0 ? targets : [{
			label: '全部笔记',
			title: '全部笔记',
			excerpt: '全部笔记',
			anchorLine: -1,
			anchorHeading: '',
			level: 0,
		}];
		this.onChoose = onChoose;
		this.appearanceTheme = appearanceTheme;
	}

	onOpen() {
		this.modalEl.addClass('recall-scheduler-popup-shell');
		applyRecallAppearanceTheme(this.modalEl, this.appearanceTheme);
		this.render();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('recall-scheduler-editor-modal');

		const bodyEl = contentEl.createDiv({ cls: 'recall-scheduler-panel-body recall-scheduler-editor-body' });
		bodyEl.createEl('h3', { text: '选择复习范围' });
		bodyEl.createEl('p', {
			text: '可以一次选择多个范围，每个范围会分别创建一个记忆项。',
			cls: 'recall-scheduler-modal-subtitle',
		});

		const form = bodyEl.createEl('div', { cls: 'recall-scheduler-editor-form' });
		const selectedIndexes = new Set<number>([0]);
		const bulkActions = form.createDiv({ cls: 'recall-scheduler-target-bulk-actions' });
		const optionsEl = form.createDiv({ cls: 'recall-scheduler-target-option-list' });
		let addBtn: HTMLButtonElement | null = null;
		const getSelectedTargets = () =>
			[...selectedIndexes]
				.sort((a, b) => a - b)
				.map((index) => this.targets[index])
				.filter((target): target is RecallReviewTarget => Boolean(target));
		const updateAddButton = () => {
			if (!addBtn) return;
			const count = selectedIndexes.size;
			addBtn.setText(count > 0 ? `添加 ${count} 项` : '请选择范围');
			addBtn.disabled = count === 0;
		};
		const selectByLevel = (level: 0 | 1 | 2 | 3 | 'all') => {
			selectedIndexes.clear();
			for (let index = 0; index < this.targets.length; index += 1) {
				const target = this.targets[index];
				if (!target) continue;
				if (level === 'all' || target.level === level) {
					selectedIndexes.add(index);
				}
			}
			renderOptions();
			updateAddButton();
		};
		const createBulkButton = (text: string, level: 0 | 1 | 2 | 3 | 'all') => {
			const button = bulkActions.createEl('button', {
				text,
				cls: 'recall-scheduler-sidebar-btn recall-scheduler-target-bulk-btn',
			});
			button.type = 'button';
			button.onclick = () => {
				selectByLevel(level);
			};
		};
		createBulkButton('全选', 'all');
		createBulkButton('一级标题', 1);
		createBulkButton('二级标题', 2);
		createBulkButton('三级标题', 3);
		const renderOptions = () => {
			optionsEl.empty();
			for (let index = 0; index < this.targets.length; index += 1) {
				const target = this.targets[index];
				const option = optionsEl.createEl('button', {
					text: target?.label || '全部笔记',
					cls: `recall-scheduler-target-option${selectedIndexes.has(index) ? ' is-selected' : ''}`,
				});
				option.type = 'button';
				option.onclick = () => {
					if (selectedIndexes.has(index)) {
						selectedIndexes.delete(index);
					} else {
						selectedIndexes.add(index);
					}
					renderOptions();
					updateAddButton();
				};
			}
		};
		renderOptions();

		const actions = bodyEl.createDiv({ cls: 'recall-scheduler-editor-actions' });
		addBtn = actions.createEl('button', {
			text: '添加 1 项',
			cls: 'recall-scheduler-sidebar-btn mod-cta',
		});
		addBtn.onclick = () => {
			const selectedTargets = getSelectedTargets();
			if (selectedTargets.length === 0) {
				new Notice('请至少选择一个复习范围');
				return;
			}
			this.onChoose(selectedTargets);
			this.close();
		};
		updateAddButton();

		const cancelBtn = actions.createEl('button', {
			text: '取消',
			cls: 'recall-scheduler-sidebar-btn',
		});
		cancelBtn.onclick = () => {
			this.close();
		};
	}
}

class RecallItemEditorModal extends Modal {
	private readonly plugin: RecallSchedulerPlugin;
	private readonly existingItem?: RecallReviewItem;
	private readonly defaults: RecallReviewItemEditorValues;

	constructor(
		app: App,
		plugin: RecallSchedulerPlugin,
		existingItem: RecallReviewItem | undefined,
		defaults: RecallReviewItemEditorValues,
	) {
		super(app);
		this.plugin = plugin;
		this.existingItem = existingItem;
		this.defaults = defaults;
	}

	onOpen() {
		this.modalEl.addClass('recall-scheduler-popup-shell');
		applyRecallAppearanceTheme(this.modalEl, this.plugin.settings.appearanceTheme);
		this.render();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('recall-scheduler-editor-modal');

		const bodyEl = contentEl.createDiv({ cls: 'recall-scheduler-panel-body recall-scheduler-editor-body' });
		bodyEl.createEl('h3', {
			text: this.existingItem ? '编辑复习项' : '新增复习项',
		});

		const form = bodyEl.createEl('div', { cls: 'recall-scheduler-editor-form' });

		const titleInput = form.createEl('input', {
			type: 'text',
			value: this.defaults.title,
			placeholder: '标题',
		});
		titleInput.addClass('recall-scheduler-input');

		const sourceRow = form.createDiv({ cls: 'recall-scheduler-editor-source-row' });
		const sourceInput = sourceRow.createEl('input', {
			type: 'text',
			value: this.defaults.sourcePath,
			placeholder: '文件路径（如 笔记文件夹/笔记.md）',
		});
		sourceInput.addClass('recall-scheduler-input');
		const chooseSourceBtn = sourceRow.createEl('button', {
			text: '浏览文件',
			cls: 'recall-scheduler-sidebar-btn',
		});
		chooseSourceBtn.type = 'button';
		chooseSourceBtn.onclick = () => {
			new NoteFilePickerModal(this.app, (path) => {
				sourceInput.value = path;
				void loadTargets(true);
			}, this.plugin.settings.appearanceTheme).open();
		};

		const targetRow = form.createDiv({ cls: 'recall-scheduler-editor-target-row' });
		targetRow.createEl('label', {
			text: '复习范围',
			cls: 'recall-scheduler-editor-field-label',
		});
		const targetPicker = targetRow.createDiv({ cls: 'recall-scheduler-target-picker' });
		const targetTrigger = targetPicker.createEl('button', {
			text: '全部笔记',
			cls: 'recall-scheduler-target-trigger',
		});
		targetTrigger.type = 'button';
		const targetMenu = targetPicker.createDiv({ cls: 'recall-scheduler-target-menu' });

		const excerptInput = form.createEl('textarea');
		excerptInput.placeholder = '摘要';
		excerptInput.value = this.defaults.excerpt;
		excerptInput.rows = 4;
		excerptInput.cols = 40;
		excerptInput.addClass('recall-scheduler-textarea');

		const dueInput = form.createEl('input', {
			type: 'datetime-local',
			value: this.defaults.dueAt,
		});
		dueInput.addClass('recall-scheduler-input');

		const anchorLineInput = form.createEl('input', {
			type: 'hidden',
			value: this.defaults.anchorLine,
			placeholder: '锚点行号',
		});
		anchorLineInput.addClass('recall-scheduler-input');

		const anchorHeadingInput = form.createEl('input', {
			type: 'hidden',
			value: this.defaults.anchorHeading,
			placeholder: '锚点标题（可选）',
		});
		anchorHeadingInput.addClass('recall-scheduler-input');

		const bulkActions = targetRow.createDiv({ cls: 'recall-scheduler-target-bulk-actions' });
		let targetOptions: RecallReviewTarget[] = [];
		let selectedTargetIndexes = new Set<number>([0]);
		let isTargetMenuOpen = false;
		const fallbackTarget = (): RecallReviewTarget => ({
			label: '全部笔记',
			title: titleInput.value.trim() || this.defaults.title || '全部笔记',
			excerpt: excerptInput.value.trim() || titleInput.value.trim() || this.defaults.excerpt || '全部笔记',
			anchorLine: -1,
			anchorHeading: '',
			level: 0,
		});
		const findSelectedTargetIndex = (targets: RecallReviewTarget[]) => {
			const anchorLine = Number.parseInt(anchorLineInput.value, 10);
			const anchorHeading = anchorHeadingInput.value.trim();
			const byLine = targets.findIndex((target) => target.anchorLine === anchorLine);
			if (byLine >= 0) return byLine;
			if (anchorHeading) {
				const byHeading = targets.findIndex((target) => target.anchorHeading === anchorHeading);
				if (byHeading >= 0) return byHeading;
			}
			return 0;
		};
		const getSelectedTargets = () =>
			[...selectedTargetIndexes]
				.sort((a, b) => a - b)
				.map((index) => targetOptions[index])
				.filter((target): target is RecallReviewTarget => Boolean(target));
		const setTargetMenuOpen = (open: boolean) => {
			isTargetMenuOpen = open;
			if (isTargetMenuOpen) {
				targetPicker.addClass('is-open');
			} else {
				targetPicker.removeClass('is-open');
			}
		};
		const updateTargetTrigger = () => {
			const selectedTargets = getSelectedTargets();
			if (selectedTargets.length === 0) {
				targetTrigger.setText('请选择复习范围');
			} else if (selectedTargets.length === 1) {
				targetTrigger.setText(selectedTargets[0]?.label || '全部笔记');
			} else {
				targetTrigger.setText(`已选择 ${selectedTargets.length} 个范围`);
			}
		};
		const applySelectedTargetsToForm = () => {
			const selectedTargets = getSelectedTargets();
			if (selectedTargets.length === 1) {
				applyTarget(selectedTargets[0]);
				return;
			}
			if (selectedTargets.length > 1) {
				anchorLineInput.value = '-1';
				anchorHeadingInput.value = '';
				titleInput.value = `已选择 ${selectedTargets.length} 个范围`;
				excerptInput.value = '保存后会为每个选中的范围分别创建记忆项';
			}
		};
		const renderBulkActions = () => {
			bulkActions.empty();
			const createBulkButton = (text: string, level: 0 | 1 | 2 | 3 | 'all') => {
				const button = bulkActions.createEl('button', {
					text,
					cls: 'recall-scheduler-sidebar-btn recall-scheduler-target-bulk-btn',
				});
				button.type = 'button';
				button.onclick = () => {
					selectedTargetIndexes = new Set(
						targetOptions
							.map((target, index) => ({ target, index }))
							.filter(({ target }) => level === 'all' || target.level === level)
							.map(({ index }) => index),
					);
					renderTargetOptions(targetOptions);
					applySelectedTargetsToForm();
					setTargetMenuOpen(false);
				};
			};
			createBulkButton('全选', 'all');
			createBulkButton('一级标题', 1);
			createBulkButton('二级标题', 2);
			createBulkButton('三级标题', 3);
		};
		const renderTargetOptions = (targets: RecallReviewTarget[]) => {
			targetOptions = targets.length > 0 ? targets : [fallbackTarget()];
			if (selectedTargetIndexes.size === 0) {
				selectedTargetIndexes = new Set([findSelectedTargetIndex(targetOptions)]);
			} else {
				selectedTargetIndexes = new Set(
					[...selectedTargetIndexes].filter((index) => index >= 0 && index < targetOptions.length),
				);
				if (selectedTargetIndexes.size === 0) {
					selectedTargetIndexes.add(findSelectedTargetIndex(targetOptions));
				}
			}
			targetMenu.empty();
			for (let index = 0; index < targetOptions.length; index += 1) {
				const target = targetOptions[index];
				const option = targetMenu.createEl('button', {
					text: target?.label || '全部笔记',
					cls: `recall-scheduler-target-option${selectedTargetIndexes.has(index) ? ' is-selected' : ''}`,
				});
				option.type = 'button';
				option.onclick = () => {
					if (selectedTargetIndexes.has(index)) {
						selectedTargetIndexes.delete(index);
					} else {
						selectedTargetIndexes.add(index);
					}
					renderTargetOptions(targetOptions);
					applySelectedTargetsToForm();
				};
			}
			renderBulkActions();
			updateTargetTrigger();
		};
		const applyTarget = (target: RecallReviewTarget | undefined) => {
			if (!target) return;
			anchorLineInput.value = String(target.anchorLine);
			anchorHeadingInput.value = target.anchorHeading;
			titleInput.value = target.title;
			excerptInput.value = target.excerpt;
		};
		const loadTargets = async (applyFirstTarget: boolean) => {
			const sourcePath = sourceInput.value.trim();
			const targets = sourcePath
				? await this.plugin.getReviewTargetsForSourcePath(sourcePath)
				: [fallbackTarget()];
			renderTargetOptions(targets);
			if (applyFirstTarget) {
				applySelectedTargetsToForm();
			}
		};
		targetTrigger.onclick = () => {
			setTargetMenuOpen(!isTargetMenuOpen);
		};
		sourceInput.onblur = () => {
			void loadTargets(true);
		};
		sourceInput.onchange = () => {
			void loadTargets(true);
		};
		void loadTargets(false);

		const actions = bodyEl.createDiv({ cls: 'recall-scheduler-editor-actions' });
		const saveBtn = actions.createEl('button', {
			text: '保存',
			cls: 'recall-scheduler-sidebar-btn mod-cta',
		});
		saveBtn.onclick = async () => {
			const selectedTargets = getSelectedTargets();
			if (!this.existingItem && selectedTargets.length === 0) {
				new Notice('请至少选择一个复习范围');
				return;
			}
			await this.plugin.saveReviewItemFromForm(
				{
					title: titleInput.value,
					sourcePath: sourceInput.value,
					excerpt: excerptInput.value,
					dueAt: dueInput.value,
					anchorLine: anchorLineInput.value,
					anchorHeading: anchorHeadingInput.value,
					targets: selectedTargets,
				},
				this.existingItem,
			);
			this.close();
		};

		const cancelBtn = actions.createEl('button', {
			text: '取消',
			cls: 'recall-scheduler-sidebar-btn',
		});
		cancelBtn.onclick = () => {
			this.close();
		};
	}
}

type SourceFileTreeNode = {
	folders: Map<string, SourceFileTreeNode>;
	files: TFile[];
};

class NoteFilePickerModal extends Modal {
	private readonly onSelect: (filePath: string) => void;
	private readonly appearanceTheme: RecallAppearanceTheme;

	constructor(
		app: App,
		onSelect: (filePath: string) => void,
		appearanceTheme: RecallAppearanceTheme,
	) {
		super(app);
		this.onSelect = onSelect;
		this.appearanceTheme = appearanceTheme;
	}

	onOpen() {
		this.modalEl.addClass('recall-scheduler-popup-shell');
		applyRecallAppearanceTheme(this.modalEl, this.appearanceTheme);
		this.render();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('recall-scheduler-file-picker-modal');

		const header = contentEl.createDiv({ cls: 'recall-scheduler-modal-header' });
		header.createSpan({
			cls: 'recall-scheduler-pixel-icon recall-scheduler-pixel-folder',
			attr: { 'aria-hidden': 'true' },
		});
		const titleWrap = header.createDiv({ cls: 'recall-scheduler-modal-title-wrap' });
		titleWrap.createEl('h3', { text: '选择来源文件' });
		titleWrap.createEl('p', { text: '点击文件名后自动填入', cls: 'recall-scheduler-modal-subtitle' });

		const treeContainer = contentEl.createDiv({ cls: 'recall-scheduler-file-tree' });
		const markdownFiles = this.app.vault.getMarkdownFiles().slice().sort((a, b) => a.path.localeCompare(b.path));
		if (markdownFiles.length === 0) {
			treeContainer.createEl('p', { text: '当前库里还没有 Markdown 文件。', cls: 'recall-scheduler-empty-state' });
			return;
		}

		const tree = this.buildTree(markdownFiles);
		this.renderTree(treeContainer, tree);

		const footer = contentEl.createDiv({ cls: 'recall-scheduler-editor-actions' });
		const closeBtn = footer.createEl('button', {
			text: '关闭',
			cls: 'recall-scheduler-sidebar-btn',
		});
		closeBtn.onclick = () => {
			this.close();
		};
	}

	private buildTree(files: TFile[]): SourceFileTreeNode {
		const root: SourceFileTreeNode = {
			folders: new Map(),
			files: [],
		};

		for (const file of files) {
			const parts = file.path.split('/');
			let cursor = root;
			for (let i = 0; i < parts.length - 1; i++) {
				const folder = parts[i] || '';
				if (!cursor.folders.has(folder)) {
					cursor.folders.set(folder, {
						folders: new Map(),
						files: [],
					});
				}
				cursor = cursor.folders.get(folder)!;
			}
			cursor.files.push(file);
		}

		return root;
	}

	private renderTree(container: HTMLElement, node: SourceFileTreeNode) {
		const folderEntries = [...node.folders.entries()]
			.filter((entry) => entry[0].trim().length > 0)
			.sort(([a], [b]) => a.localeCompare(b));
		for (const [folderName, child] of folderEntries) {
			const folderEl = container.createEl('details', { cls: 'recall-scheduler-file-tree-folder' });
			const summary = folderEl.createEl('summary');
			summary.createSpan({
				cls: 'recall-scheduler-pixel-icon recall-scheduler-pixel-folder',
				attr: { 'aria-hidden': 'true' },
			});
			summary.createSpan({ text: folderName, cls: 'recall-scheduler-file-tree-name' });

			const childContainer = folderEl.createDiv({ cls: 'recall-scheduler-file-tree-children' });
			this.renderTree(childContainer, child);
		}

		const rootlessFiles = node.files
			.slice()
			.sort((a, b) => a.path.localeCompare(b.path));
		for (const file of rootlessFiles) {
			const item = container.createEl('button', {
				cls: 'recall-scheduler-file-tree-item',
			});
			item.createSpan({
				cls: 'recall-scheduler-pixel-icon recall-scheduler-pixel-note',
				attr: { 'aria-hidden': 'true' },
			});
			item.createSpan({ text: file.name, cls: 'recall-scheduler-file-tree-name' });
			item.title = file.path;
			item.onclick = () => {
				this.onSelect(file.path);
				this.close();
			};
		}
	}
}

class ReminderAlarmModal extends Modal {
	private readonly plugin: RecallSchedulerPlugin;
	private readonly dueItems: RecallReviewItem[];
	private readonly onAcknowledge: () => void;

	constructor(
		app: App,
		plugin: RecallSchedulerPlugin,
		dueItems: RecallReviewItem[],
		onAcknowledge: () => void,
	) {
		super(app);
		this.plugin = plugin;
		this.dueItems = dueItems.slice();
		this.onAcknowledge = onAcknowledge;
	}

	onOpen() {
		this.modalEl.addClass('recall-scheduler-popup-shell');
		applyRecallAppearanceTheme(this.modalEl, this.plugin.settings.appearanceTheme);
		this.render();
	}

	onClose() {
		this.onAcknowledge();
		return super.onClose();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('recall-scheduler-alarm-modal');

		const bodyEl = contentEl.createDiv({ cls: 'recall-scheduler-panel-body recall-scheduler-alarm-body' });
		const header = bodyEl.createDiv({ cls: 'recall-scheduler-modal-header recall-scheduler-alarm-header' });
		const pulse = header.createDiv({ cls: 'recall-scheduler-alarm-icon-wrap' });
		pulse.createSpan({ text: '', cls: 'recall-scheduler-alarm-icon' });
		const titleWrap = header.createDiv({ cls: 'recall-scheduler-modal-title-wrap' });
		titleWrap.createEl('h2', { text: '复习提醒' });
		titleWrap.createEl('p', { text: '这些知识点已经到期', cls: 'recall-scheduler-modal-subtitle' });

		const count = this.dueItems.length;
		bodyEl.createEl('p', {
			text: `你有 ${count} 个知识点到期。可以现在打开复习列表，也可以先关闭提醒。`,
			cls: 'recall-scheduler-alarm-summary',
		});

		const list = bodyEl.createDiv({ cls: 'recall-scheduler-alarm-list' });
		const maxPreview = Math.max(1, this.plugin.settings.maxItemsInNotice);
		for (const item of this.dueItems.slice(0, maxPreview)) {
			const row = list.createDiv({ cls: 'recall-scheduler-alarm-item' });
			const title = row.createSpan({ text: item.title, cls: 'recall-scheduler-alarm-item-title' });
			title.setAttr('title', item.title);
			row.createSpan({
				text: ` · ${this.plugin.formatCountdown(item.dueAt)}`,
				cls: 'recall-scheduler-alarm-item-time',
			});
		}

		if (this.dueItems.length > maxPreview) {
			list.createEl('p', {
				text: `另外还有 ${this.dueItems.length - maxPreview} 项未显示`,
				cls: 'recall-scheduler-alarm-more',
			});
		}

		const actions = bodyEl.createDiv({ cls: 'recall-scheduler-alarm-actions' });
		const openQueueBtn = actions.createEl('button', {
			text: '查看复习列表',
			cls: 'recall-scheduler-sidebar-btn',
		});
		openQueueBtn.onclick = () => {
			new ReviewQueueModal(this.app, this.plugin).open();
			this.close();
		};
		const closeBtn = actions.createEl('button', {
			text: '我知道了',
			cls: 'recall-scheduler-sidebar-btn mod-cta',
		});
		closeBtn.onclick = () => {
			this.close();
		};
	}
}

class ConfirmDeleteModal extends Modal {
	private readonly itemTitle: string;
	private readonly onConfirm: () => void;
	private readonly appearanceTheme: RecallAppearanceTheme;

	constructor(
		app: App,
		itemTitle: string,
		onConfirm: () => void,
		appearanceTheme: RecallAppearanceTheme,
	) {
		super(app);
		this.itemTitle = itemTitle;
		this.onConfirm = onConfirm;
		this.appearanceTheme = appearanceTheme;
	}

	onOpen() {
		this.modalEl.addClass('recall-scheduler-popup-shell');
		applyRecallAppearanceTheme(this.modalEl, this.appearanceTheme);
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('recall-scheduler-alarm-modal');

		const bodyEl = contentEl.createDiv({ cls: 'recall-scheduler-panel-body recall-scheduler-alarm-body' });
		const header = bodyEl.createDiv({ cls: 'recall-scheduler-modal-header' });
		header.createSpan({
			cls: 'recall-scheduler-pixel-icon recall-scheduler-pixel-note',
			attr: { 'aria-hidden': 'true' },
		});
		const titleWrap = header.createDiv({ cls: 'recall-scheduler-modal-title-wrap' });
		titleWrap.createEl('h2', { text: '删除归档项' });
		titleWrap.createEl('p', {
			text: '删除后不可恢复',
			cls: 'recall-scheduler-modal-subtitle',
		});

		bodyEl.createEl('p', {
			text: `确定要彻底删除“${this.itemTitle}”吗？`,
			cls: 'recall-scheduler-alarm-summary',
		});

		const actions = bodyEl.createDiv({ cls: 'recall-scheduler-alarm-actions' });
		const cancelBtn = actions.createEl('button', {
			text: '取消',
			cls: 'recall-scheduler-sidebar-btn',
		});
		cancelBtn.onclick = () => {
			this.close();
		};
		const confirmBtn = actions.createEl('button', {
			text: '确认删除',
			cls: 'recall-scheduler-sidebar-btn mod-warning',
		});
		confirmBtn.onclick = () => {
			this.onConfirm();
			this.close();
		};
	}
}

class RecallSchedulerSettingTab extends PluginSettingTab {
	plugin: RecallSchedulerPlugin;

	constructor(app: App, plugin: RecallSchedulerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName('记忆复习设置').setHeading();

		new Setting(containerEl)
			.setName('默认外观')
			.setDesc(`复习弹窗打开时使用的外观。当前：${getRecallAppearanceThemeLabel(this.plugin.settings.appearanceTheme)}。`)
			.addDropdown((dropdown) => {
				for (const theme of RECALL_APPEARANCE_THEMES) {
					dropdown.addOption(theme.id, theme.label);
				}
				dropdown
					.setValue(this.plugin.settings.appearanceTheme)
					.onChange(async (value) => {
						if (!isRecallAppearanceTheme(value)) return;
						this.plugin.settings.appearanceTheme = value;
						this.plugin.updateSettings(this.plugin.settings);
						this.display();
					});
			});

		new Setting(containerEl)
			.setName('提醒间隔（分钟）')
			.setDesc('每隔多少分钟检查一次到期复习项。')
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.reminderIntervalMinutes))
					.setPlaceholder('10')
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						const intervalMinutes = Number.isFinite(parsed)
							? Math.max(1, parsed)
							: DEFAULT_SETTINGS.reminderIntervalMinutes;
						this.plugin.settings.reminderIntervalMinutes = intervalMinutes;
						this.plugin.updateSettings(this.plugin.settings);
					}),
			);

		new Setting(containerEl)
			.setName('默认目录')
			.setDesc('可选。后续功能可用于保存复习内容的默认目录。')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.defaultFolder)
					.setPlaceholder('')
					.onChange(async (value) => {
						this.plugin.settings.defaultFolder = value.trim();
						this.plugin.updateSettings(this.plugin.settings);
					}),
			);

		new Setting(containerEl)
			.setName('启动时提醒')
			.setDesc('插件启动时如果有到期项，立即显示一次提醒。')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableStartupNotice)
					.onChange(async (value) => {
						this.plugin.settings.enableStartupNotice = value;
						this.plugin.updateSettings(this.plugin.settings);
					}),
			);

		new Setting(containerEl)
			.setName('显示系统通知')
			.setDesc('显示系统桌面通知。')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableDesktopNotification)
					.onChange(async (value) => {
						this.plugin.settings.enableDesktopNotification = value;
						this.plugin.updateSettings(this.plugin.settings);
					}),
			);

		new Setting(containerEl)
			.setName('通知显示最大条数')
			.setDesc('桌面通知中显示的最大事项标题条数。')
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.maxItemsInNotice))
					.setPlaceholder('5')
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						const maxItems = Number.isFinite(parsed)
							? Math.max(1, parsed)
							: DEFAULT_SETTINGS.maxItemsInNotice;
						this.plugin.settings.maxItemsInNotice = maxItems;
						this.plugin.updateSettings(this.plugin.settings);
					}),
			);

		new Setting(containerEl)
			.setName('目标保留率（%）')
			.setDesc('遗忘曲线的目标保留率。默认 90，越高复习越频繁。')
			.addText((text) =>
				text
					.setValue(String(Math.round(this.plugin.settings.memoryScheduler.targetRetention * 100)))
					.setPlaceholder('90')
					.onChange(async (value) => {
						const parsed = Number.parseFloat(value);
						const targetRetention = Number.isFinite(parsed)
							? parsed / 100
							: DEFAULT_MEMORY_SCHEDULER_SETTINGS.targetRetention;
						this.plugin.settings.memoryScheduler = normalizeMemorySchedulerSettings({
							...this.plugin.settings.memoryScheduler,
							targetRetention,
						});
						this.plugin.updateSettings(this.plugin.settings);
					}),
			);

		new Setting(containerEl)
			.setName('新卡学习步进（分钟）')
			.setDesc('逗号分隔。例如 10, 1440 表示先 10 分钟后复习，再 1 天后复习。')
			.addText((text) =>
				text
					.setValue(formatMinuteSteps(this.plugin.settings.memoryScheduler.learningStepsMinutes))
					.setPlaceholder('10, 1440')
					.onChange(async (value) => {
						this.plugin.settings.memoryScheduler = normalizeMemorySchedulerSettings({
							...this.plugin.settings.memoryScheduler,
							learningStepsMinutes: parseMinuteSteps(
								value,
								DEFAULT_MEMORY_SCHEDULER_SETTINGS.learningStepsMinutes,
							),
						});
						this.plugin.updateSettings(this.plugin.settings);
					}),
			);

		new Setting(containerEl)
			.setName('忘记后重学步进（分钟）')
			.setDesc('长期复习中点“忘了”后进入重新学习阶段。')
			.addText((text) =>
				text
					.setValue(formatMinuteSteps(this.plugin.settings.memoryScheduler.relearningStepsMinutes))
					.setPlaceholder('10, 1440')
					.onChange(async (value) => {
						this.plugin.settings.memoryScheduler = normalizeMemorySchedulerSettings({
							...this.plugin.settings.memoryScheduler,
							relearningStepsMinutes: parseMinuteSteps(
								value,
								DEFAULT_MEMORY_SCHEDULER_SETTINGS.relearningStepsMinutes,
							),
						});
						this.plugin.updateSettings(this.plugin.settings);
					}),
			);

		new Setting(containerEl)
			.setName('最短长期复习间隔（天）')
			.setDesc('进入长期复习阶段后，下次提醒不会短于这个天数。')
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.memoryScheduler.minimumReviewIntervalDays))
					.setPlaceholder('1')
					.onChange(async (value) => {
						const minimumReviewIntervalDays = Number.parseFloat(value);
						this.plugin.settings.memoryScheduler = normalizeMemorySchedulerSettings({
							...this.plugin.settings.memoryScheduler,
							minimumReviewIntervalDays,
						});
						this.plugin.updateSettings(this.plugin.settings);
					}),
			);

		new Setting(containerEl)
			.setName('最长长期复习间隔（天）')
			.setDesc('防止间隔无限增长。默认 3650 天。')
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.memoryScheduler.maximumReviewIntervalDays))
					.setPlaceholder('3650')
					.onChange(async (value) => {
						const maximumReviewIntervalDays = Number.parseFloat(value);
						this.plugin.settings.memoryScheduler = normalizeMemorySchedulerSettings({
							...this.plugin.settings.memoryScheduler,
							maximumReviewIntervalDays,
						});
						this.plugin.updateSettings(this.plugin.settings);
					}),
			);
	}
}

class ReviewQueueModal extends Modal {
	private readonly plugin: RecallSchedulerPlugin;
	private listMode: 'today' | 'active' | 'archived' = 'today';
	private searchQuery = '';
	private selectedStatusGroup: ReviewStatusGroupId = 'all';
	private leaderboardPeriod: LeaderboardPeriod = 'week';
	private focusSearchOnRender = false;
	private isComposingSearch = false;
	private searchRenderTimer: number | null = null;

	constructor(app: App, plugin: RecallSchedulerPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		this.modalEl.addClass('recall-scheduler-popup-shell');
		applyRecallAppearanceTheme(this.modalEl, this.plugin.settings.appearanceTheme);
		this.render();
	}

	onClose() {
		if (this.searchRenderTimer !== null) {
			window.clearTimeout(this.searchRenderTimer);
			this.searchRenderTimer = null;
		}
		return super.onClose();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('recall-scheduler-modal');

		const baseItems = this.getModeItems();
		const searchedItems = searchReviewItems(baseItems, this.searchQuery);
		const now = new Date();
		const statusGroups = summarizeStatusGroups(searchedItems, now);
		const selectedGroup = statusGroups.some((group) => group.id === this.selectedStatusGroup)
			? this.selectedStatusGroup
			: 'all';
		const items = filterReviewItemsByStatus(searchedItems, selectedGroup, now);
		const bodyEl = contentEl.createDiv({ cls: 'recall-scheduler-panel-body' });
		const header = bodyEl.createDiv({ cls: 'recall-scheduler-modal-header' });
		header.createSpan({
			cls: 'recall-scheduler-pixel-icon recall-scheduler-pixel-note',
			attr: { 'aria-hidden': 'true' },
		});
		const titleWrap = header.createDiv({ cls: 'recall-scheduler-modal-title-wrap' });
		const titleRow = titleWrap.createDiv({ cls: 'recall-scheduler-title-row' });
		titleRow.createEl('h2', { text: this.getTitle() });
		titleRow.createSpan({
			text: `v${this.plugin.manifest.version}`,
			cls: 'recall-scheduler-version-badge',
		});
		titleWrap.createEl('p', { text: '添加、复习、归档都在这里完成', cls: 'recall-scheduler-modal-subtitle' });
		const headerControls = header.createDiv({ cls: 'recall-scheduler-header-controls' });
		this.renderThemeSelector(headerControls);
		headerControls.createSpan({ text: `${items.length}`, cls: 'recall-scheduler-modal-count' });

		const toolbar = bodyEl.createDiv({ cls: 'recall-scheduler-modal-toolbar' });
		this.createToolbarButton(toolbar, '添加当前笔记', () => {
			void this.plugin.addCurrentNoteToReviewQueue(() => {
				this.listMode = 'today';
				this.render();
			});
		}, 'recall-scheduler-toolbar-add-current');
		this.createToolbarButton(toolbar, '手动新增', () => {
			this.close();
			void this.plugin.openItemEditor();
		}, 'recall-scheduler-toolbar-manual-add');
		this.createModeButton(toolbar, '今日', 'today');
		this.createModeButton(toolbar, '全部', 'active');
		this.createModeButton(toolbar, '归档', 'archived');

		this.renderSearch(bodyEl);
		if (this.listMode === 'today') {
			this.renderLeaderboard(bodyEl);
		}

		const contentLayout = bodyEl.createDiv({ cls: 'recall-scheduler-content-layout' });
		this.renderStatusNav(contentLayout, statusGroups);
		const listWrap = contentLayout.createDiv({ cls: 'recall-scheduler-list-wrap' });

		if (items.length === 0) {
			listWrap.createEl('p', { text: this.getEmptyText(baseItems.length, searchedItems.length), cls: 'recall-scheduler-empty-state' });
			return;
		}

		const listEl = listWrap.createDiv({ cls: 'recall-scheduler-queue-list' });
		for (const item of items) {
			const cardIconId = this.getCardIconId(item);
			const itemEl = listEl.createDiv({ cls: `recall-scheduler-item recall-scheduler-card-${cardIconId}` });
			const headEl = itemEl.createDiv({ cls: 'recall-scheduler-card-head' });
			const titleGroup = headEl.createDiv({ cls: 'recall-scheduler-card-title-group' });
			titleGroup.createSpan({
				cls: `recall-scheduler-visual-icon recall-scheduler-card-icon recall-scheduler-icon-${cardIconId}`,
				attr: { 'aria-hidden': 'true' },
			});
			titleGroup.createEl('div', {
				text: item.title,
				cls: 'recall-scheduler-item-title',
			});
			if (this.listMode !== 'archived') {
				this.renderCountdown(headEl, item);
				this.renderCountdownTrack(itemEl, item);
			}
			itemEl.createEl('div', {
				text: item.excerpt,
				cls: 'recall-scheduler-item-excerpt',
			});
			const metaEl = itemEl.createDiv({ cls: 'recall-scheduler-item-meta' });
			const sourceLink = metaEl.createEl('a', {
				href: '#',
				text: item.sourcePath,
				cls: 'recall-scheduler-source',
			});
			sourceLink.onclick = (event) => {
				event.preventDefault();
				void this.plugin.openReviewItemSource(item);
			};
			metaEl.createSpan({ text: ` · 到期时间：${this.formatDate(item.dueAt)}` });
			metaEl.createSpan({ text: ` · 上次复习：${this.formatLastReviewed(item)}` });
			metaEl.createSpan({ text: ` · 复习次数：${item.reviewCount}` });
			metaEl.createSpan({ text: ` · ${this.plugin.getMemorySummary(item)}` });
			if (item.anchorHeading) {
				metaEl.createSpan({ text: ` · 锚点：${item.anchorHeading}` });
			}

			const actionsEl = itemEl.createDiv({ cls: 'recall-scheduler-item-actions' });
			this.createActionButton(actionsEl, '打开', () => {
				void this.plugin.openReviewItemSource(item);
				this.close();
			});
			this.createActionButton(actionsEl, '编辑', () => {
				this.close();
				void this.plugin.openItemEditor(item);
			});
			if (this.listMode === 'archived') {
				this.createActionButton(actionsEl, '恢复', () => {
					void this.plugin.restoreReviewItem(item.id).then(() => this.render());
				});
				this.createActionButton(actionsEl, '删除', () => {
					new ConfirmDeleteModal(this.app, item.title, () => {
						void this.plugin.deleteArchivedReviewItem(item.id).then(() => this.render());
					}, this.plugin.settings.appearanceTheme).open();
				});
			} else {
				this.createActionButton(actionsEl, '归档', () => {
					void this.plugin.archiveReviewItem(item.id).then(() => this.render());
				});
				this.createFeedbackButton(actionsEl, '忘了', 'forgotten', item.id);
				this.createFeedbackButton(actionsEl, '困难', 'difficult', item.id);
				this.createFeedbackButton(actionsEl, '记得', 'remembered', item.id);
				this.createFeedbackButton(actionsEl, '简单', 'easy', item.id);
			}
		}
	}

	private getModeItems() {
		if (this.listMode === 'archived') {
			return this.plugin.getSidebarItems(true);
		}
		if (this.listMode === 'active') {
			return this.plugin.getSidebarItems(false);
		}
		return this.plugin.getTodayReviewItems();
	}

	private renderSearch(container: HTMLElement) {
		const searchRow = container.createDiv({ cls: 'recall-scheduler-search-row' });
		const searchInput = searchRow.createEl('input', {
			type: 'search',
			value: this.searchQuery,
			placeholder: '搜索标题、路径、锚点、摘要或状态...',
		});
		searchInput.addClass('recall-scheduler-search-input');
		const scheduleSearchRender = () => {
			if (this.searchRenderTimer !== null) {
				window.clearTimeout(this.searchRenderTimer);
			}
			this.searchRenderTimer = window.setTimeout(() => {
				this.searchRenderTimer = null;
				this.focusSearchOnRender = true;
				this.render();
			}, 180);
		};
		searchInput.addEventListener('compositionstart', () => {
			this.isComposingSearch = true;
		});
		searchInput.addEventListener('compositionend', () => {
			this.isComposingSearch = false;
			this.searchQuery = searchInput.value;
			this.selectedStatusGroup = 'all';
			scheduleSearchRender();
		});
		searchInput.oninput = () => {
			this.searchQuery = searchInput.value;
			this.selectedStatusGroup = 'all';
			if (!this.isComposingSearch) {
				scheduleSearchRender();
			}
		};
		if (this.searchQuery) {
			const clearBtn = searchRow.createEl('button', {
				text: '清除',
				cls: 'recall-scheduler-sidebar-btn recall-scheduler-search-clear',
			});
			clearBtn.type = 'button';
			clearBtn.onclick = () => {
				if (this.searchRenderTimer !== null) {
					window.clearTimeout(this.searchRenderTimer);
					this.searchRenderTimer = null;
				}
				this.searchQuery = '';
				this.selectedStatusGroup = 'all';
				this.focusSearchOnRender = true;
				this.render();
			};
		}
		if (this.focusSearchOnRender) {
			this.focusSearchOnRender = false;
			window.setTimeout(() => {
				searchInput.focus();
				const valueLength = searchInput.value.length;
				searchInput.setSelectionRange(valueLength, valueLength);
			}, 0);
		}
	}

	private renderLeaderboard(container: HTMLElement) {
		const board = container.createDiv({ cls: 'recall-scheduler-leaderboard' });
		const head = board.createDiv({ cls: 'recall-scheduler-leaderboard-head' });
		const titleWrap = head.createDiv();
		titleWrap.createEl('div', { text: '复习排行榜', cls: 'recall-scheduler-leaderboard-title' });
		titleWrap.createEl('div', { text: '按单个记忆项统计前三', cls: 'recall-scheduler-leaderboard-subtitle' });
		const tabs = head.createDiv({ cls: 'recall-scheduler-leaderboard-tabs' });
		this.createLeaderboardPeriodButton(tabs, '本周', 'week');
		this.createLeaderboardPeriodButton(tabs, '本月', 'month');
		this.createLeaderboardPeriodButton(tabs, '本年', 'year');

		const entries = getReviewLeaderboard(this.plugin.getAllReviewItems(), this.leaderboardPeriod, new Date(), 3);
		if (entries.length === 0) {
			board.createEl('p', { text: '这个周期还没有复习记录。', cls: 'recall-scheduler-leaderboard-empty' });
			return;
		}

		const list = board.createDiv({ cls: 'recall-scheduler-leaderboard-list' });
		for (let index = 0; index < entries.length; index += 1) {
			const entry = entries[index];
			if (!entry) continue;
			const row = list.createEl('button', { cls: 'recall-scheduler-leaderboard-item' });
			row.type = 'button';
			row.onclick = () => {
				this.searchQuery = entry.title;
				this.selectedStatusGroup = 'all';
				this.render();
			};
			row.createSpan({ text: `${index + 1}`, cls: 'recall-scheduler-leaderboard-rank' });
			row.createSpan({
				cls: `recall-scheduler-leaderboard-avatar recall-scheduler-avatar-${(index % 3) + 1}`,
				attr: { 'aria-hidden': 'true' },
			});
			const textWrap = row.createSpan({ cls: 'recall-scheduler-leaderboard-item-text' });
			textWrap.createSpan({ text: entry.title, cls: 'recall-scheduler-leaderboard-item-title' });
			textWrap.createSpan({
				text: entry.anchorHeading ? `${entry.sourcePath} · ${entry.anchorHeading}` : entry.sourcePath,
				cls: 'recall-scheduler-leaderboard-item-meta',
			});
			row.createSpan({ text: `${entry.count}次`, cls: 'recall-scheduler-leaderboard-count' });
		}
	}

	private createLeaderboardPeriodButton(
		container: HTMLElement,
		text: string,
		period: LeaderboardPeriod,
	) {
		const button = container.createEl('button', {
			text,
			cls: `recall-scheduler-sidebar-btn recall-scheduler-leaderboard-tab${this.leaderboardPeriod === period ? ' is-active' : ''}`,
		});
		button.type = 'button';
		button.onclick = () => {
			this.leaderboardPeriod = period;
			this.render();
		};
	}

	private renderStatusNav(container: HTMLElement, groups: ReturnType<typeof summarizeStatusGroups>) {
		const nav = container.createDiv({ cls: 'recall-scheduler-status-nav' });
		nav.createEl('div', { text: '状态导航', cls: 'recall-scheduler-status-nav-title' });
		for (const group of groups) {
			const button = nav.createEl('button', {
				cls: `recall-scheduler-status-nav-item${this.selectedStatusGroup === group.id ? ' is-active' : ''}`,
			});
			button.type = 'button';
			button.disabled = group.count === 0 && group.id !== 'all';
			button.onclick = () => {
				this.selectedStatusGroup = group.id;
				this.render();
			};
			button.createSpan({
				cls: `recall-scheduler-visual-icon recall-scheduler-status-icon recall-scheduler-icon-${group.id}`,
				attr: { 'aria-hidden': 'true' },
			});
			button.createSpan({ text: group.label, cls: 'recall-scheduler-status-nav-label' });
			button.createSpan({ text: String(group.count), cls: 'recall-scheduler-status-nav-count' });
		}
	}

	private getCardIconId(item: { status: 'active' | 'archived'; memoryState: string }) {
		if (item.status === 'archived') return 'archived';
		if (
			item.memoryState === 'new' ||
			item.memoryState === 'learning' ||
			item.memoryState === 'review' ||
			item.memoryState === 'relearning'
		) {
			return item.memoryState;
		}
		return 'all';
	}

	private getTitle() {
		if (this.listMode === 'archived') return '已归档';
		if (this.listMode === 'active') return '全部复习项';
		return '今日面板';
	}

	private getEmptyText(baseCount: number, searchedCount: number) {
		if (baseCount > 0 && searchedCount === 0) return '没有匹配搜索条件的复习项。';
		if (searchedCount > 0) return '当前状态分组下没有复习项。';
		if (this.listMode === 'archived') return '当前没有已归档的复习项。';
		if (this.listMode === 'active') return '当前没有复习项。可以添加当前笔记或手动新增。';
		return '今天没有需要复习的内容。可以从上方添加新的复习项。';
	}

	private renderThemeSelector(container: HTMLElement) {
		const wrap = container.createEl('label', { cls: 'recall-scheduler-theme-switcher' });
		wrap.createSpan({
			text: '外观',
			cls: 'recall-scheduler-theme-label',
		});
		const select = wrap.createEl('select', {
			cls: 'recall-scheduler-theme-select',
			attr: {
				'aria-label': '切换复习弹窗外观',
			},
		});
		for (const theme of RECALL_APPEARANCE_THEMES) {
			select.createEl('option', {
				text: theme.label,
				value: theme.id,
			});
		}
		select.value = this.plugin.settings.appearanceTheme;
		select.onchange = () => {
			if (!isRecallAppearanceTheme(select.value)) return;
			this.plugin.updateSettings({
				...this.plugin.settings,
				appearanceTheme: select.value,
			});
			applyRecallAppearanceTheme(this.modalEl, select.value);
		};
	}

	private createToolbarButton(
		container: HTMLElement,
		text: string,
		action: () => void,
		extraClass = '',
	) {
		const button = container.createEl('button', {
			text,
			cls: `recall-scheduler-sidebar-btn recall-scheduler-toolbar-btn ${extraClass}`.trim(),
		});
		button.onclick = action;
	}

	private createModeButton(
		container: HTMLElement,
		text: string,
		mode: 'today' | 'active' | 'archived',
	) {
		const isActive = this.listMode === mode;
		const button = container.createEl('button', {
			text,
			cls: `recall-scheduler-sidebar-btn recall-scheduler-mode-btn recall-scheduler-mode-${mode}${isActive ? ' is-active' : ''}`,
		});
		button.onclick = () => {
			this.listMode = mode;
			this.selectedStatusGroup = 'all';
			this.render();
		};
	}

	private createActionButton(container: HTMLElement, text: string, action: () => void) {
		const button = container.createEl('button', {
			text,
			cls: 'recall-scheduler-feedback-btn',
		});
		button.onclick = action;
	}

	private renderCountdown(container: HTMLElement, item: RecallReviewItem) {
		const countdownVisual = this.plugin.getCountdownVisualState(item.dueAt);
		const countdownWrap = container.createDiv({ cls: 'recall-scheduler-countdown-wrap' });
		countdownWrap.createSpan({
			text: '',
			cls: `recall-scheduler-countdown-icon recall-scheduler-icon-${countdownVisual.iconType} recall-scheduler-countdown-${countdownVisual.state}`,
		});
		countdownWrap.createSpan({
			text: countdownVisual.label,
			cls: 'recall-scheduler-countdown',
		});
	}

	private renderCountdownTrack(container: HTMLElement, item: RecallReviewItem) {
		const countdownVisual = this.plugin.getCountdownVisualState(item.dueAt);
		const heatPercent = Math.round(countdownVisual.progress * 100);
		const trackWrap = container.createDiv({ cls: 'recall-scheduler-countdown-track-wrap' });
		const trackBar = trackWrap.createDiv({ cls: 'recall-scheduler-countdown-track' });
		const trackFill = trackBar.createDiv({ cls: 'recall-scheduler-countdown-track-fill' });
		trackFill.style.width = `${heatPercent}%`;
		trackFill.style.backgroundColor = countdownVisual.heatColor;
		trackFill.title = `到期紧张度 ${heatPercent}%`;
	}

	private createFeedbackButton(
		container: HTMLElement,
		text: string,
		feedback: ReviewFeedback,
		itemId: string,
	) {
		const button = container.createEl('button', {
			text,
			cls: `recall-scheduler-feedback-btn recall-scheduler-feedback-${feedback}`,
		});
		button.onclick = async () => {
			await this.plugin.applyReviewFeedback(itemId, feedback);
			this.render();
		};
	}

	private formatDate(isoValue: string) {
		const date = new Date(isoValue);
		return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString();
	}

	private formatLastReviewed(item: RecallReviewItem) {
		return item.lastReviewedAt ? this.formatDate(item.lastReviewedAt) : '未复习';
	}
}
