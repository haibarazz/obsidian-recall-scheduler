import {
	DEFAULT_MEMORY_SCHEDULER_SETTINGS,
	createInitialMemoryProgress,
	scheduleNextReview,
	type SchedulableReviewItem,
} from '../src/scheduler';

function assertEqual<T>(actual: T, expected: T, message: string) {
	if (!Object.is(actual, expected)) {
		throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
	}
}

function assertOk(value: unknown, message: string) {
	if (!value) {
		throw new Error(message);
	}
}

function makeItem(nowIso: string): SchedulableReviewItem {
	return {
		...createInitialMemoryProgress(nowIso),
		status: 'active',
	};
}

const now = new Date('2026-05-31T00:00:00.000Z');

{
	const item = makeItem(now.toISOString());
	const result = scheduleNextReview(item, 'forgotten', DEFAULT_MEMORY_SCHEDULER_SETTINGS, now);
	assertEqual(result.item.memoryState, 'learning', 'forgotten new cards enter learning');
	assertEqual(result.item.reviewCount, 1, 'review count increments');
	assertEqual(result.item.reviewHistory.length, 1, 'review history is recorded');
	assertEqual(result.item.intervalDays, 0.007, 'first learning step is ten minutes');
}

{
	const item = makeItem(now.toISOString());
	const result = scheduleNextReview(item, 'easy', DEFAULT_MEMORY_SCHEDULER_SETTINGS, now);
	assertEqual(result.item.memoryState, 'review', 'easy new cards graduate to review');
	assertOk(result.item.intervalDays >= 7, 'easy new cards schedule a long interval');
	assertOk(result.item.difficulty < item.difficulty, 'easy feedback lowers difficulty');
}

{
	const first = scheduleNextReview(makeItem(now.toISOString()), 'remembered', DEFAULT_MEMORY_SCHEDULER_SETTINGS, now).item;
	const second = scheduleNextReview(
		first,
		'forgotten',
		DEFAULT_MEMORY_SCHEDULER_SETTINGS,
		new Date('2026-06-03T00:00:00.000Z'),
	);
	assertEqual(second.item.memoryState, 'relearning', 'forgotten review cards enter relearning');
	assertEqual(second.item.intervalDays, 0.007, 'relearning starts with ten minutes');
	assertEqual(second.historyEntry.previousState, 'review', 'history captures previous state');
	assertEqual(second.historyEntry.nextState, 'relearning', 'history captures next state');
}

{
	const learning = scheduleNextReview(makeItem(now.toISOString()), 'forgotten', DEFAULT_MEMORY_SCHEDULER_SETTINGS, now).item;
	const advanced = scheduleNextReview(
		learning,
		'remembered',
		DEFAULT_MEMORY_SCHEDULER_SETTINGS,
		new Date('2026-05-31T00:10:00.000Z'),
	).item;
	assertEqual(advanced.memoryState, 'learning', 'remembered learning cards stay in learning until final step');
	assertEqual(advanced.learningStep, 1, 'remembered learning cards advance one step');
}
