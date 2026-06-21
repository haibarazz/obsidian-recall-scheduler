export type ReviewFeedback = 'forgotten' | 'difficult' | 'remembered' | 'easy';

export type ReviewState = 'new' | 'learning' | 'review' | 'relearning' | 'archived';

export interface MemorySchedulerSettings {
	targetRetention: number;
	learningStepsMinutes: number[];
	relearningStepsMinutes: number[];
	minimumReviewIntervalDays: number;
	maximumReviewIntervalDays: number;
}

export interface ReviewHistoryEntry {
	reviewedAt: string;
	feedback: ReviewFeedback;
	previousState: ReviewState;
	nextState: ReviewState;
	previousDueAt: string;
	nextDueAt: string;
	elapsedDays: number;
	retentionBefore: number;
	previousStability: number;
	nextStability: number;
	previousDifficulty: number;
	nextDifficulty: number;
	intervalDays: number;
	algorithmVersion: string;
}

export interface MemoryProgress {
	dueAt: string;
	lastReviewedAt: string | null;
	intervalDays: number;
	stability: number;
	difficulty: number;
	reviewCount: number;
	memoryState: ReviewState;
	learningStep: number;
	relearningStep: number;
	reviewHistory: ReviewHistoryEntry[];
}

export interface SchedulableReviewItem extends MemoryProgress {
	status: 'active' | 'archived';
}

