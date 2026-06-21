import { memoryStateLabel, type ReviewHistoryEntry, type ReviewState } from './scheduler';

export type ReviewRangeLevel = 0 | 1 | 2 | 3;

export type ReviewStatusGroupId =
	| 'all'
	| 'overdue'
	| 'today'
	| 'future'
	| 'new'
	| 'learning'
	| 'review'
	| 'relearning'
	| 'archived';

export type LeaderboardPeriod = 'week' | 'month' | 'year';

export interface ReviewTargetLike {
	title: string;
	excerpt: string;
	anchorLine: number;
	anchorHeading: string;
	level: ReviewRangeLevel;
}

export interface ReviewItemLike {
	id: string;
	title: string;
	sourcePath: string;
	excerpt: string;
	createdAt?: string;
	anchorLine: number;
	anchorHeading: string;
	anchorLevel?: ReviewRangeLevel;
	sourceBasename?: string;
	sourceFileCtime?: number;
	sourceFileSize?: number;
	status: 'active' | 'archived';
	dueAt: string;
	lastReviewedAt: string | null;
	reviewCount: number;
	memoryState: ReviewState;
	reviewHistory: ReviewHistoryEntry[];
}

export interface DuplicateReviewResult<T extends ReviewTargetLike> {
	acceptedTargets: T[];
	exactDuplicates: T[];
	archivedDuplicates: T[];
	sameNoteDifferentTargets: T[];
}

export interface StatusGroupSummary {
	id: ReviewStatusGroupId;
	label: string;
	count: number;
}

export interface LeaderboardEntry {
	itemId: string;
	title: string;
	sourcePath: string;
	anchorHeading: string;
	count: number;
	lastReviewedAt: string;
}

export interface ReviewFileCandidate {
	path: string;
	basename: string;
	ctime?: number;
	size?: number;
	content?: string;
}

export interface ScoredReviewFileCandidate extends ReviewFileCandidate {
	score: number;
	reasons: string[];
}

export const REVIEW_STATUS_GROUPS: ReadonlyArray<{ id: ReviewStatusGroupId; label: string }> = [
	{ id: 'all', label: '全部' },
	{ id: 'overdue', label: '已逾期' },
	{ id: 'today', label: '今天到期' },
	{ id: 'future', label: '未来到期' },
	{ id: 'new', label: '新卡' },
	{ id: 'learning', label: '学习中' },
	{ id: 'review', label: '长期复习' },
	{ id: 'relearning', label: '重新学习' },
	{ id: 'archived', label: '已归档' },
];

export function basenameFromPath(path: string): string {
	const filename = path.split('/').pop() || path;
	return filename.replace(/\.md$/i, '');
}

export function normalizeSourcePath(path: string): string {
	return path.trim().replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

export function normalizeReviewText(value: string): string {
	return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function inferReviewRangeLevel(item: {
	anchorLevel?: ReviewRangeLevel;
	anchorHeading: string;
	anchorLine: number;
}): ReviewRangeLevel {
	if (item.anchorLevel === 0 || item.anchorLevel === 1 || item.anchorLevel === 2 || item.anchorLevel === 3) {
		return item.anchorLevel;
	}
	if (!item.anchorHeading.trim() && item.anchorLine < 0) {
		return 0;
	}
	return 1;
}

export function makeReviewSignature(input: {
	sourcePath: string;
	anchorHeading: string;
	anchorLine: number;
	level?: ReviewRangeLevel;
	anchorLevel?: ReviewRangeLevel;
}): string {
	const sourceKey = normalizeSourcePath(input.sourcePath);
	const level = input.level ?? inferReviewRangeLevel({
		anchorLevel: input.anchorLevel,
		anchorHeading: input.anchorHeading,
		anchorLine: input.anchorLine,
	});
	if (level === 0) {
		return `${sourceKey}|0|whole`;
	}
	const headingKey = normalizeReviewText(input.anchorHeading);
	if (headingKey) {
		return `${sourceKey}|${level}|heading:${headingKey}`;
	}
	return `${sourceKey}|${level}|line:${input.anchorLine}`;
}

export function getReviewItemSignature(item: ReviewItemLike): string {
	return makeReviewSignature({
		sourcePath: item.sourcePath,
		anchorHeading: item.anchorHeading,
		anchorLine: item.anchorLine,
		anchorLevel: item.anchorLevel,
	});
}

export function getReviewTargetSignature(sourcePath: string, target: ReviewTargetLike): string {
	return makeReviewSignature({
		sourcePath,
		anchorHeading: target.anchorHeading,
		anchorLine: target.anchorLine,
		level: target.level,
	});
}

export function findDuplicateReviewTargets<T extends ReviewTargetLike>(
	items: ReviewItemLike[],
	sourcePath: string,
	targets: T[],
): DuplicateReviewResult<T> {
	const acceptedTargets: T[] = [];
	const exactDuplicates: T[] = [];
	const archivedDuplicates: T[] = [];
	const sameNoteDifferentTargets: T[] = [];
	const normalizedSource = normalizeSourcePath(sourcePath);
	const existingSignatures = new Map<string, ReviewItemLike[]>();
	const sameSourceItems = items.filter((item) => normalizeSourcePath(item.sourcePath) === normalizedSource);

	for (const item of items) {
		const signature = getReviewItemSignature(item);
		const bucket = existingSignatures.get(signature) ?? [];
		bucket.push(item);
		existingSignatures.set(signature, bucket);
	}

	for (const target of targets) {
		const duplicateItems = existingSignatures.get(getReviewTargetSignature(sourcePath, target)) ?? [];
		if (duplicateItems.some((item) => item.status === 'active')) {
			exactDuplicates.push(target);
			continue;
		}
		if (duplicateItems.some((item) => item.status === 'archived')) {
			archivedDuplicates.push(target);
			continue;
		}
		if (sameSourceItems.length > 0) {
			sameNoteDifferentTargets.push(target);
		}
		acceptedTargets.push(target);
	}

	return {
		acceptedTargets,
		exactDuplicates,
		archivedDuplicates,
		sameNoteDifferentTargets,
	};
}

export function searchReviewItems<T extends ReviewItemLike>(items: T[], query: string): T[] {
	const normalizedQuery = normalizeReviewText(query);
	if (!normalizedQuery) return items;
	return items.filter((item) => {
		const fields = [
			item.title,
			item.sourcePath,
			item.sourceBasename ?? '',
			item.anchorHeading,
			item.excerpt,
			memoryStateLabel(item.status === 'archived' ? 'archived' : item.memoryState),
		];
		return fields.some((field) => normalizeReviewText(field).includes(normalizedQuery));
	});
}

export function filterReviewItemsByStatus<T extends ReviewItemLike>(
	items: T[],
	groupId: ReviewStatusGroupId,
	now: Date,
): T[] {
	if (groupId === 'all') return items;
	return items.filter((item) => isReviewItemInStatusGroup(item, groupId, now));
}

export function summarizeStatusGroups(
	items: ReviewItemLike[],
	now: Date,
): StatusGroupSummary[] {
	return REVIEW_STATUS_GROUPS.map((group) => ({
		...group,
		count: filterReviewItemsByStatus(items, group.id, now).length,
	}));
}

export function isReviewItemInStatusGroup(
	item: ReviewItemLike,
	groupId: ReviewStatusGroupId,
	now: Date,
): boolean {
	if (groupId === 'all') return true;
	if (groupId === 'archived') return item.status === 'archived';
	if (item.status === 'archived') return false;
	if (groupId === 'new' || groupId === 'learning' || groupId === 'review' || groupId === 'relearning') {
		return item.memoryState === groupId;
	}

	const dueAt = Date.parse(item.dueAt);
	if (!Number.isFinite(dueAt)) return false;
	const start = startOfLocalDay(now).getTime();
	const end = endOfLocalDay(now).getTime();
	if (groupId === 'overdue') return dueAt < start;
	if (groupId === 'today') return dueAt >= start && dueAt <= end;
	if (groupId === 'future') return dueAt > end;
	return false;
}

export function getReviewLeaderboard(
	items: ReviewItemLike[],
	period: LeaderboardPeriod,
	now: Date,
	limit = 3,
): LeaderboardEntry[] {
	const start = getLeaderboardPeriodStart(period, now).getTime();
	const end = now.getTime();
	const entries = items
		.map((item) => {
			const reviewedAtValues = item.reviewHistory
				.map((entry) => entry.reviewedAt)
				.filter((reviewedAt) => {
					const timestamp = Date.parse(reviewedAt);
					return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
				})
				.sort();
			const lastReviewedAt = reviewedAtValues[reviewedAtValues.length - 1] ?? '';
			return {
				itemId: item.id,
				title: item.title,
				sourcePath: item.sourcePath,
				anchorHeading: item.anchorHeading,
				count: reviewedAtValues.length,
				lastReviewedAt,
			};
		})
		.filter((entry) => entry.count > 0)
		.sort((a, b) => {
			if (b.count !== a.count) return b.count - a.count;
			return b.lastReviewedAt.localeCompare(a.lastReviewedAt);
		});
	return entries.slice(0, Math.max(0, limit));
}

export function getLeaderboardPeriodStart(period: LeaderboardPeriod, now: Date): Date {
	if (period === 'year') {
		return new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
	}
	if (period === 'month') {
		return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
	}
	const start = startOfLocalDay(now);
	const day = start.getDay();
	const diffToMonday = day === 0 ? -6 : 1 - day;
	start.setDate(start.getDate() + diffToMonday);
	return start;
}

export function scoreReviewFileCandidate(
	item: ReviewItemLike,
	candidate: ReviewFileCandidate,
): ScoredReviewFileCandidate {
	let score = 0;
	const reasons: string[] = [];
	const itemBasename = normalizeReviewText(item.sourceBasename || basenameFromPath(item.sourcePath));
	const candidateBasename = normalizeReviewText(candidate.basename);
	const candidateContent = candidate.content ?? '';

	if (item.sourceFileCtime !== undefined && candidate.ctime === item.sourceFileCtime) {
		score += 60;
		reasons.push('ctime');
	}
	if (item.sourceFileSize !== undefined && candidate.size === item.sourceFileSize) {
		score += 20;
		reasons.push('size');
	}
	if (itemBasename && candidateBasename === itemBasename) {
		score += 35;
		reasons.push('basename');
	}
	if (normalizeReviewText(candidate.path).endsWith(normalizeReviewText(`${basenameFromPath(item.sourcePath)}.md`))) {
		score += 12;
		reasons.push('filename');
	}
	if (item.anchorHeading.trim() && includesNormalized(candidateContent, item.anchorHeading)) {
		score += 30;
		reasons.push('heading');
	}
	if (item.excerpt.trim().length >= 6 && includesNormalized(candidateContent, item.excerpt)) {
		score += 20;
		reasons.push('excerpt');
	}
	if (item.title.trim() && (candidateBasename === normalizeReviewText(item.title) || includesNormalized(candidateContent, item.title))) {
		score += 10;
		reasons.push('title');
	}

	return {
		...candidate,
		score,
		reasons,
	};
}

export function selectUniqueBestFileCandidate(
	candidates: ScoredReviewFileCandidate[],
	minScore = 45,
	minGap = 12,
): ScoredReviewFileCandidate | null {
	const sorted = candidates.slice().sort((a, b) => b.score - a.score);
	const best = sorted[0];
	if (!best || best.score < minScore) return null;
	const second = sorted[1];
	if (second && best.score - second.score < minGap) return null;
	return best;
}

function includesNormalized(haystack: string, needle: string): boolean {
	const normalizedNeedle = normalizeReviewText(needle);
	if (!normalizedNeedle) return false;
	return normalizeReviewText(haystack).includes(normalizedNeedle);
}

function startOfLocalDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfLocalDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}
