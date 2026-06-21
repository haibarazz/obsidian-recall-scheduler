import {
	createInitialMemoryProgress,
	type ReviewFeedback,
	type ReviewHistoryEntry,
	type ReviewState,
} from '../src/scheduler';
import {
	findDuplicateReviewTargets,
	filterReviewItemsByStatus,
	getReviewLeaderboard,
	searchReviewItems,
	scoreReviewFileCandidate,
	selectUniqueBestFileCandidate,
	summarizeStatusGroups,
	type ReviewItemLike,
	type ReviewRangeLevel,
	type ReviewTargetLike,
} from '../src/review-helpers';

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

function makeHistory(reviewedAt: string, feedback: ReviewFeedback = 'remembered'): ReviewHistoryEntry {
	return {
		reviewedAt,
		feedback,
		previousState: 'review',
		nextState: 'review',
		previousDueAt: '2026-06-01T00:00:00.000Z',
		nextDueAt: '2026-06-02T00:00:00.000Z',
		elapsedDays: 1,
		retentionBefore: 0.9,
		previousStability: 2,
		nextStability: 3,
		previousDifficulty: 5,
		nextDifficulty: 4.8,
		intervalDays: 1,
		algorithmVersion: 'test',
	};
}

function makeItem(overrides: Partial<ReviewItemLike> = {}): ReviewItemLike {
	const nowIso = '2026-06-10T00:00:00.000Z';
	return {
		...createInitialMemoryProgress(nowIso),
		id: overrides.id ?? 'item-1',
		title: overrides.title ?? '工程细节',
		sourcePath: overrides.sourcePath ?? 'Notes/Agent.md',
		excerpt: overrides.excerpt ?? '工程细节',
		createdAt: nowIso,
		anchorLine: overrides.anchorLine ?? 10,
		anchorHeading: overrides.anchorHeading ?? '工程细节',
		anchorLevel: overrides.anchorLevel ?? 2,
		sourceBasename: overrides.sourceBasename ?? 'Agent',
		sourceFileCtime: overrides.sourceFileCtime,
		sourceFileSize: overrides.sourceFileSize,
		status: overrides.status ?? 'active',
		dueAt: overrides.dueAt ?? '2026-06-10T12:00:00.000Z',
		lastReviewedAt: overrides.lastReviewedAt ?? null,
		reviewCount: overrides.reviewCount ?? 0,
		memoryState: overrides.memoryState ?? 'new',
		reviewHistory: overrides.reviewHistory ?? [],
	};
}

function makeTarget(
	title: string,
	anchorHeading: string,
	level: ReviewRangeLevel,
	anchorLine: number,
): ReviewTargetLike {
	return {
		title,
		excerpt: title,
		anchorHeading,
		level,
		anchorLine,
	};
}

{
	const existing = makeItem();
	const duplicate = makeTarget('工程细节', '工程细节', 2, 10);
	const differentHeading = makeTarget('Buffer', 'Buffer', 2, 20);
	const result = findDuplicateReviewTargets([existing], 'Notes/Agent.md', [duplicate, differentHeading]);
	assertEqual(result.exactDuplicates.length, 1, 'exact duplicate is skipped');
	assertEqual(result.acceptedTargets.length, 1, 'different heading in same note is accepted');
	assertEqual(result.sameNoteDifferentTargets.length, 1, 'same note different heading is reported');
	assertEqual(result.acceptedTargets[0]?.title, 'Buffer', 'accepted target is the different heading');
}

{
	const archived = makeItem({ status: 'archived' });
	const duplicate = makeTarget('工程细节', '工程细节', 2, 10);
	const result = findDuplicateReviewTargets([archived], 'Notes/Agent.md', [duplicate]);
	assertEqual(result.archivedDuplicates.length, 1, 'archived duplicate is reported separately');
	assertEqual(result.acceptedTargets.length, 0, 'archived duplicate is also skipped');
}

{
	const items = [
		makeItem({ id: 'a', title: 'LLM Agent', sourcePath: 'A.md', excerpt: 'Function calling' }),
		makeItem({ id: 'b', title: '强化学习', sourcePath: 'B.md', anchorHeading: 'PPO' }),
	];
	assertEqual(searchReviewItems(items, 'function').length, 1, 'search matches excerpt');
	assertEqual(searchReviewItems(items, 'PPO')[0]?.id, 'b', 'search matches anchor heading');
	assertEqual(searchReviewItems(items, '').length, 2, 'empty search returns all items');
}

{
	const now = new Date('2026-06-10T12:00:00.000Z');
	const items = [
		makeItem({ id: 'overdue', dueAt: '2026-06-09T23:00:00.000Z' }),
		makeItem({ id: 'today', dueAt: '2026-06-10T18:00:00.000Z' }),
		makeItem({ id: 'future', dueAt: '2026-06-12T00:00:00.000Z' }),
		makeItem({ id: 'review', dueAt: '2026-06-12T01:00:00.000Z', memoryState: 'review' as ReviewState }),
		makeItem({ id: 'archived', dueAt: '2026-06-12T02:00:00.000Z', status: 'archived' }),
	];
	assertEqual(filterReviewItemsByStatus(items, 'overdue', now).length, 1, 'overdue group filters by due date');
	assertEqual(filterReviewItemsByStatus(items, 'today', now).length, 1, 'today group filters same-day due items');
	assertEqual(filterReviewItemsByStatus(items, 'future', now).length, 2, 'future group filters future due items');
	assertEqual(filterReviewItemsByStatus(items, 'archived', now).length, 1, 'archived group filters archived items');
	const groups = summarizeStatusGroups(items, now);
	assertEqual(groups.find((group) => group.id === 'all')?.count, 5, 'all status group counts all current items');
}

{
	const now = new Date('2026-06-20T12:00:00.000Z');
	const items = [
		makeItem({
			id: 'a',
			title: '本周第一',
			reviewHistory: [
				makeHistory('2026-06-18T00:00:00.000Z'),
				makeHistory('2026-06-19T00:00:00.000Z'),
			],
		}),
		makeItem({
			id: 'b',
			title: '本周第二',
			reviewHistory: [makeHistory('2026-06-18T00:00:00.000Z')],
		}),
		makeItem({
			id: 'old',
			title: '上月项目',
			reviewHistory: [makeHistory('2026-05-20T00:00:00.000Z')],
		}),
	];
	const week = getReviewLeaderboard(items, 'week', now);
	const month = getReviewLeaderboard(items, 'month', now);
	assertEqual(week[0]?.itemId, 'a', 'leaderboard ranks by item review count');
	assertEqual(week.length, 2, 'weekly leaderboard excludes old entries');
	assertEqual(month.length, 2, 'monthly leaderboard includes current month entries');
}

{
	const item = makeItem({
		sourcePath: 'Old/Agent.md',
		sourceBasename: 'Agent',
		sourceFileCtime: 1234,
		sourceFileSize: 888,
		anchorHeading: '工程细节',
		excerpt: 'Function calling 是工具调用能力',
	});
	const scored = [
		scoreReviewFileCandidate(item, {
			path: 'New/Agent.md',
			basename: 'Agent',
			ctime: 1234,
			size: 888,
			content: '# 工程细节\nFunction calling 是工具调用能力',
		}),
		scoreReviewFileCandidate(item, {
			path: 'Other/Agent.md',
			basename: 'Agent',
			content: 'unrelated',
		}),
	];
	const best = selectUniqueBestFileCandidate(scored);
	assertEqual(best?.path, 'New/Agent.md', 'file fallback selects the unique high-confidence candidate');
	assertOk((best?.score ?? 0) > scored[1]!.score, 'best candidate has a higher score');
}
