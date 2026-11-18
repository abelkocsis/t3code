import type { PullRequestCommentAssessment } from "@t3tools/contracts";
import type {
  BranchNamingOptions,
  ChatAttachment,
  ModelSelection,
  PullRequestReviewGuide,
  TextGenerationError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { TextGenerationPolicy } from "./textGenerationPolicy.ts";
import type { ThreadTitleForkSource } from "./textGenerationPrompts.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  threadContext?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  naming?: BranchNamingOptions | undefined;
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  previousTitle?: string | undefined;
  forkSource?: ThreadTitleForkSource | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  instructions?: string | undefined;
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
  needsRefinement?: boolean | undefined;
}

export interface ReviewGuideStackLayer {
  readonly number: number;
  readonly title: string | null;
  readonly headSha: string | null;
  readonly state: "open" | "closed" | "merged";
}

export interface ReviewGuideGenerationInput {
  cwd: string;
  number: number;
  title: string;
  description: string;
  baseBranch: string;
  baseCommit: string;
  settledReview: string;
  instructions?: string | undefined;
  stack?: ReadonlyArray<ReviewGuideStackLayer> | undefined;
  modelSelection: ModelSelection;
}

export type ReviewGuideGenerationResult = Omit<
  PullRequestReviewGuide,
  "headSha" | "generatedAt" | "modelSelection"
>;

export interface DailySummaryGenerationInput {
  /**
   * Where the provider CLI runs. The prompt carries every fact already, so any
   * readable directory works; a project root keeps provider config sane.
   */
  cwd: string;
  /** The day being summarised, as `YYYY-MM-DD` in the user's zone. */
  day: string;
  /** The evidence block the collectors assembled. */
  facts: string;
  /** Bullets the user kept from an earlier run of the same day. */
  keptItems: ReadonlyArray<string>;
  /** Bullets the user removed from the same day. */
  excludedItems: ReadonlyArray<string>;
  /** The user's rules for the summary, from settings. */
  instructions: string;
  /** Rules the user taught later. */
  learnings?: ReadonlyArray<string> | undefined;
  modelSelection: ModelSelection;
}

export interface DailySummaryInstructInput {
  cwd: string;
  day: string;
  facts: string;
  instructions: string;
  learnings?: ReadonlyArray<string> | undefined;
  items: ReadonlyArray<{
    readonly itemId: string;
    readonly text: string;
    readonly excluded: boolean;
  }>;
  instruction: string;
  modelSelection: ModelSelection;
}

export interface DailySummaryInstructItem {
  /** Empty for an item the model wrote new. */
  itemId: string;
  text: string;
  source: string;
  excluded: boolean;
}

export interface DailySummaryInstructResult {
  reply: string;
  /** Absent when the message was a question. */
  items?: ReadonlyArray<DailySummaryInstructItem> | undefined;
  suggestedRule?: string | undefined;
}

export interface DailySummaryLearnInput {
  cwd: string;
  day: string;
  instructions: string;
  learnings: ReadonlyArray<string>;
  edited: ReadonlyArray<{ readonly before: string; readonly after: string }>;
  removed: ReadonlyArray<string>;
  added: ReadonlyArray<string>;
  finalOrder: ReadonlyArray<string>;
  modelSelection: ModelSelection;
}

export interface DailySummaryLearnResult {
  rules: ReadonlyArray<{ readonly text: string; readonly basis: string }>;
}

export interface DailySummaryGenerationItem {
  text: string;
  source: string;
}

export interface DailySummaryGenerationResult {
  items: ReadonlyArray<DailySummaryGenerationItem>;
}

export interface TranscriptionPostProcessingInput {
  cwd: string;
  prompt: string;
  modelSelection: ModelSelection;
}

export interface TranscriptionPostProcessingResult {
  transcription: string;
}

export interface ProviderTextGeneration {
  readonly assessPullRequestComments?: (input: {
    cwd: string;
    evidence: string;
    includeIssues: boolean;
    modelSelection: ModelSelection;
  }) => Effect.Effect<PullRequestCommentAssessment, TextGenerationError>;
  readonly generateTranscriptionPostProcessing: (
    input: TranscriptionPostProcessingInput,
  ) => Effect.Effect<TranscriptionPostProcessingResult, TextGenerationError>;

  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  readonly generateReviewGuide: (
    input: ReviewGuideGenerationInput,
  ) => Effect.Effect<ReviewGuideGenerationResult, TextGenerationError>;

  /** One day of work written as standup bullets, from evidence the server collected. */
  readonly generateDailySummary: (
    input: DailySummaryGenerationInput,
  ) => Effect.Effect<DailySummaryGenerationResult, TextGenerationError>;

  /** A question or an instruction about one day's bullets. */
  readonly instructDailySummary: (
    input: DailySummaryInstructInput,
  ) => Effect.Effect<DailySummaryInstructResult, TextGenerationError>;

  /** The lasting rules one day's edits show. */
  readonly learnDailySummary: (
    input: DailySummaryLearnInput,
  ) => Effect.Effect<DailySummaryLearnResult, TextGenerationError>;
}
