import {
	MemoryProgress,
	MemorySchedulerSettings,
	ReviewFeedback,
	ReviewHistoryEntry,
	ReviewState,
	SchedulableReviewItem,
} from './types';

export const MEMORY_ALGORITHM_VERSION = 'ebbinghaus-fsrs-v1';
export const MINUTES_MS = 60 * 1000;
export const DAYS_MS = 24 * 60 * 60 * 1000;

const MIN_STABILITY_DAYS = 0.05;
const MAX_STABILITY_DAYS = 3650;
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 10;

export const DEFAULT_MEMORY_SCHEDULER_SETTINGS: MemorySchedulerSettings = {
	targetRetention: 0.9,
	learningStepsMinutes: [10, 1440],
	relearningStepsMinutes: [10, 1440],
	minimumReviewIntervalDays: 1,
	maximumReviewIntervalDays: 3650,
};

export interface ScheduleResult<T extends SchedulableReviewItem> {
	item: T;
	historyEntry: ReviewHistoryEntry;
	summary: string;
}

export function createInitialMemoryProgress(nowIso: string): MemoryProgress {
	return {
		dueAt: nowIso,
		lastReviewedAt: null,
		intervalDays: 0,
		stability: 1,
		difficulty: 5,
		reviewCount: 0,
		memoryState: 'new',
		learningStep: 0,
		relearningStep: 0,
		reviewHistory: [],
	};
}

export function normalizeMemorySchedulerSettings(
	settings: Partial<MemorySchedulerSettings> | undefined,
): MemorySchedulerSettings {
	const defaults = DEFAULT_MEMORY_SCHEDULER_SETTINGS;
	return {
		targetRetention: clampNumber(settings?.targetRetention, defaults.targetRetention, 0.7, 0.98),
		learningStepsMinutes: normalizeSteps(settings?.learningStepsMinutes, defaults.learningStepsMinutes),
		relearningStepsMinutes: normalizeSteps(settings?.relearningStepsMinutes, defaults.relearningStepsMinutes),
		minimumReviewIntervalDays: clampNumber(
			settings?.minimumReviewIntervalDays,
			defaults.minimumReviewIntervalDays,
			0.02,
			30,
		),
		maximumReviewIntervalDays: clampNumber(
			settings?.maximumReviewIntervalDays,
			defaults.maximumReviewIntervalDays,
			1,
			MAX_STABILITY_DAYS,
		),
	};
}

export function normalizeMemoryProgress(
	item: Partial<MemoryProgress> | undefined,
	nowIso: string,
): MemoryProgress {
	const initial = createInitialMemoryProgress(nowIso);
	return {
		dueAt: typeof item?.dueAt === 'string' ? item.dueAt : initial.dueAt,
		lastReviewedAt: typeof item?.lastReviewedAt === 'string' ? item.lastReviewedAt : null,
		intervalDays: clampNumber(item?.intervalDays, initial.intervalDays, 0, MAX_STABILITY_DAYS),
		stability: clampNumber(item?.stability, initial.stability, MIN_STABILITY_DAYS, MAX_STABILITY_DAYS),
		difficulty: clampNumber(item?.difficulty, initial.difficulty, MIN_DIFFICULTY, MAX_DIFFICULTY),
		reviewCount: Math.max(0, Math.floor(toFiniteNumber(item?.reviewCount, initial.reviewCount))),
		memoryState: normalizeReviewState(item?.memoryState),
		learningStep: Math.max(0, Math.floor(toFiniteNumber(item?.learningStep, initial.learningStep))),
		relearningStep: Math.max(0, Math.floor(toFiniteNumber(item?.relearningStep, initial.relearningStep))),
		reviewHistory: Array.isArray(item?.reviewHistory) ? item.reviewHistory : [],
	};
}

export function scheduleNextReview<T extends SchedulableReviewItem>(
	item: T,
	feedback: ReviewFeedback,
	settings: MemorySchedulerSettings,
	now: Date,
): ScheduleResult<T> {
	const reviewedAt = now.toISOString();
	const previousState = item.status === 'archived' ? 'archived' : item.memoryState;
	const elapsedDays = getElapsedDays(item.lastReviewedAt, now);
	const retentionBefore = estimateRetention(item.stability, elapsedDays);
	const previousDueAt = item.dueAt;
	const previousStability = item.stability;
	const previousDifficulty = item.difficulty;
	const nextDifficulty = nextDifficultyForFeedback(previousDifficulty, feedback);
	const nextStability = nextStabilityForFeedback(
		previousStability,
		previousDifficulty,
		feedback,
		retentionBefore,
		previousState,
		settings,
	);
	const transition = getTransition(item, feedback, nextStability, settings);
	const nextDueAt = new Date(now.getTime() + transition.delayMs).toISOString();
	const intervalDays = roundDays(transition.delayMs / DAYS_MS);
	const historyEntry: ReviewHistoryEntry = {
		reviewedAt,
		feedback,
		previousState,
		nextState: transition.nextState,
		previousDueAt,
		nextDueAt,
		elapsedDays: roundDays(elapsedDays),
		retentionBefore: roundRatio(retentionBefore),
		previousStability: roundDays(previousStability),
		nextStability: roundDays(nextStability),
		previousDifficulty: roundDifficulty(previousDifficulty),
		nextDifficulty: roundDifficulty(nextDifficulty),
		intervalDays,
		algorithmVersion: MEMORY_ALGORITHM_VERSION,
	};
	const updated = {
		...item,
		dueAt: nextDueAt,
		lastReviewedAt: reviewedAt,
		intervalDays,
		stability: nextStability,
		difficulty: nextDifficulty,
		reviewCount: item.reviewCount + 1,
		memoryState: transition.nextState,
		learningStep: transition.learningStep,
		relearningStep: transition.relearningStep,
		reviewHistory: [...item.reviewHistory, historyEntry],
	} as T;

	return {
		item: updated,
		historyEntry,
		summary: buildSummary(feedback, transition.nextState, intervalDays, retentionBefore),
	};
}

export function estimateRetention(stability: number, elapsedDays: number): number {
	const safeStability = clampNumber(stability, 1, MIN_STABILITY_DAYS, MAX_STABILITY_DAYS);
	const safeElapsedDays = Math.max(0, elapsedDays);
	return Math.exp(-safeElapsedDays / safeStability);
}

export function getElapsedDays(lastReviewedAt: string | null | undefined, now: Date): number {
	const last = typeof lastReviewedAt === 'string' ? Date.parse(lastReviewedAt) : NaN;
	if (!Number.isFinite(last)) {
		return 0;
	}
	const elapsedMs = now.getTime() - last;
	return Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs / DAYS_MS : 0;
}

export function parseMinuteSteps(value: string, fallback: number[]): number[] {
	const steps = value
		.split(',')
		.map((part) => Number.parseInt(part.trim(), 10))
		.filter((value) => Number.isFinite(value) && value > 0);
	return steps.length > 0 ? steps : fallback;
}

export function formatMinuteSteps(steps: number[]): string {
	return steps.join(', ');
}

export function memoryStateLabel(state: ReviewState): string {
	switch (state) {
		case 'new':
			return '新卡';
		case 'learning':
			return '学习中';
		case 'review':
			return '长期复习';
		case 'relearning':
			return '重新学习';
		case 'archived':
			return '已归档';
		default:
			return '未知';
	}
}

function getTransition(
	item: SchedulableReviewItem,
	feedback: ReviewFeedback,
	stability: number,
	settings: MemorySchedulerSettings,
): {
	nextState: ReviewState;
	delayMs: number;
	learningStep: number;
	relearningStep: number;
} {
	const state = item.status === 'archived' ? 'archived' : item.memoryState;
	if (state === 'archived') {
		return {
			nextState: 'archived',
			delayMs: 0,
			learningStep: item.learningStep,
			relearningStep: item.relearningStep,
		};
	}
	if (state === 'new') {
		return transitionFromNew(feedback, stability, settings);
	}
	if (state === 'learning') {
		return transitionThroughSteps(
			'learning',
			item.learningStep,
			feedback,
			settings.learningStepsMinutes,
			stability,
			settings,
		);
	}
	if (state === 'relearning') {
		return transitionThroughSteps(
			'relearning',
			item.relearningStep,
			feedback,
			settings.relearningStepsMinutes,
			stability,
			settings,
		);
	}
	if (feedback === 'forgotten') {
		return {
			nextState: 'relearning',
			delayMs: minutesToMs(settings.relearningStepsMinutes[0] ?? 10),
			learningStep: 0,
			relearningStep: 0,
		};
	}
	return {
		nextState: 'review',
		delayMs: daysToMs(intervalFromStability(stability, feedback, settings)),
		learningStep: 0,
		relearningStep: 0,
	};
}

function transitionFromNew(
	feedback: ReviewFeedback,
	stability: number,
	settings: MemorySchedulerSettings,
) {
	if (feedback === 'forgotten') {
		return {
			nextState: 'learning' as const,
			delayMs: minutesToMs(settings.learningStepsMinutes[0] ?? 10),
			learningStep: 0,
			relearningStep: 0,
		};
	}
	if (feedback === 'difficult') {
		const step = Math.min(1, settings.learningStepsMinutes.length - 1);
		return {
			nextState: 'learning' as const,
			delayMs: minutesToMs(settings.learningStepsMinutes[step] ?? 1440),
			learningStep: step,
			relearningStep: 0,
		};
	}
	return {
		nextState: 'review' as const,
		delayMs: daysToMs(intervalFromStability(stability, feedback, settings)),
		learningStep: 0,
		relearningStep: 0,
	};
}

function transitionThroughSteps(
	state: 'learning' | 'relearning',
	currentStep: number,
	feedback: ReviewFeedback,
	steps: number[],
	stability: number,
	settings: MemorySchedulerSettings,
) {
	if (feedback === 'forgotten') {
		return {
			nextState: state,
			delayMs: minutesToMs(steps[0] ?? 10),
			learningStep: state === 'learning' ? 0 : 0,
			relearningStep: state === 'relearning' ? 0 : 0,
		};
	}
	if (feedback === 'easy') {
		return {
			nextState: 'review' as const,
			delayMs: daysToMs(intervalFromStability(stability, feedback, settings)),
			learningStep: 0,
			relearningStep: 0,
		};
	}

	const nextStep = Math.min(currentStep + 1, Math.max(0, steps.length - 1));
	const graduates = currentStep >= steps.length - 1 || steps.length === 0;
	if (graduates && feedback === 'remembered') {
		return {
			nextState: 'review' as const,
			delayMs: daysToMs(intervalFromStability(stability, feedback, settings)),
			learningStep: 0,
			relearningStep: 0,
		};
	}
	return {
		nextState: state,
		delayMs: minutesToMs(steps[nextStep] ?? 1440),
		learningStep: state === 'learning' ? nextStep : 0,
		relearningStep: state === 'relearning' ? nextStep : 0,
	};
}

function nextStabilityForFeedback(
	currentStability: number,
	currentDifficulty: number,
	feedback: ReviewFeedback,
	retention: number,
	state: ReviewState,
	settings: MemorySchedulerSettings,
): number {
	if (state === 'new') {
		return initialStability(feedback, settings);
	}
	const safeStability = clampNumber(currentStability, 1, MIN_STABILITY_DAYS, MAX_STABILITY_DAYS);
	const difficultyDrag = 1 - (currentDifficulty - MIN_DIFFICULTY) / (MAX_DIFFICULTY - MIN_DIFFICULTY);
	const surprise = Math.max(0.05, 1 - retention);
	let next: number;
	switch (feedback) {
		case 'forgotten':
			next = safeStability * (0.35 + surprise * 0.18);
			break;
		case 'difficult':
			next = safeStability * (0.82 + difficultyDrag * 0.2);
			break;
		case 'remembered':
			next = safeStability * (1.18 + difficultyDrag * 0.34 + surprise * 0.24);
			break;
		case 'easy':
		default:
			next = safeStability * (1.65 + difficultyDrag * 0.48 + surprise * 0.34);
			break;
	}
	return roundDays(clampNumber(next, MIN_STABILITY_DAYS, MIN_STABILITY_DAYS, MAX_STABILITY_DAYS));
}

function initialStability(feedback: ReviewFeedback, settings: MemorySchedulerSettings): number {
	const desiredIntervalDays =
		feedback === 'easy' ? 7 : feedback === 'remembered' ? 3 : feedback === 'difficult' ? 1 : 0.5;
	return roundDays(desiredIntervalDays / retentionDecay(settings.targetRetention));
}

function nextDifficultyForFeedback(currentDifficulty: number, feedback: ReviewFeedback): number {
	const current = clampNumber(currentDifficulty, 5, MIN_DIFFICULTY, MAX_DIFFICULTY);
	const deltaByFeedback: Record<ReviewFeedback, number> = {
		forgotten: 1.4,
		difficult: 0.55,
		remembered: -0.2,
		easy: -0.65,
	};
	return roundDifficulty(clampNumber(current + deltaByFeedback[feedback], current, MIN_DIFFICULTY, MAX_DIFFICULTY));
}

function intervalFromStability(
	stability: number,
	feedback: ReviewFeedback,
	settings: MemorySchedulerSettings,
): number {
	const baseInterval = stability * retentionDecay(settings.targetRetention);
	const feedbackFactor: Record<ReviewFeedback, number> = {
		forgotten: 0.2,
		difficult: 0.65,
		remembered: 1,
		easy: 1.6,
	};
	return roundDays(
		clampNumber(
			baseInterval * feedbackFactor[feedback],
			settings.minimumReviewIntervalDays,
			settings.minimumReviewIntervalDays,
			settings.maximumReviewIntervalDays,
		),
	);
}

function retentionDecay(targetRetention: number): number {
	return -Math.log(clampNumber(targetRetention, 0.9, 0.7, 0.98));
}

function normalizeSteps(value: unknown, fallback: number[]): number[] {
	if (!Array.isArray(value)) {
		return fallback;
	}
	const steps = value
		.map((step) => Math.floor(toFiniteNumber(step, NaN)))
		.filter((step) => Number.isFinite(step) && step > 0);
	return steps.length > 0 ? steps : fallback;
}

function normalizeReviewState(value: unknown): ReviewState {
	if (
		value === 'new' ||
		value === 'learning' ||
		value === 'review' ||
		value === 'relearning' ||
		value === 'archived'
	) {
		return value;
	}
	return 'new';
}

function buildSummary(
	feedback: ReviewFeedback,
	nextState: ReviewState,
	intervalDays: number,
	retentionBefore: number,
): string {
	const feedbackLabel: Record<ReviewFeedback, string> = {
		forgotten: '忘了',
		difficult: '困难',
		remembered: '记得',
		easy: '简单',
	};
	return `${feedbackLabel[feedback]}：${memoryStateLabel(nextState)}，下次 ${formatInterval(intervalDays)} 后，复习前保留率约 ${Math.round(retentionBefore * 100)}%`;
}

function formatInterval(intervalDays: number): string {
	if (intervalDays < 1 / 24) {
		return `${Math.max(1, Math.round(intervalDays * 24 * 60))} 分钟`;
	}
	if (intervalDays < 1) {
		return `${Math.round(intervalDays * 24)} 小时`;
	}
	return `${Number.parseFloat(intervalDays.toFixed(1))} 天`;
}

function minutesToMs(minutes: number): number {
	return Math.max(1, minutes) * MINUTES_MS;
}

function daysToMs(days: number): number {
	return Math.max(0, days) * DAYS_MS;
}

function clampNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
	const numberValue = toFiniteNumber(value, fallback);
	return Math.min(maximum, Math.max(minimum, numberValue));
}

function toFiniteNumber(value: unknown, fallback: number): number {
	const parsed =
		typeof value === 'number'
			? value
			: typeof value === 'string'
				? Number.parseFloat(value)
				: NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
}

function roundDays(value: number): number {
	return Number.parseFloat(value.toFixed(3));
}

function roundRatio(value: number): number {
	return Number.parseFloat(value.toFixed(4));
}

function roundDifficulty(value: number): number {
	return Number.parseFloat(value.toFixed(2));
}
