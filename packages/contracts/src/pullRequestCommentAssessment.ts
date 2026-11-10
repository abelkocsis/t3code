import * as Schema from "effect/Schema";
import { PullRequestRef } from "./pullRequest.ts";
import { ModelSelection } from "./modelSelection.ts";

export const PullRequestCommentAssessment = Schema.Struct({
  summary: Schema.String,
  issues: Schema.Array(
    Schema.Struct({
      commentId: Schema.String,
      title: Schema.String,
      status: Schema.Literals(["open", "resolved", "uncertain"]),
      evidence: Schema.String,
    }),
  ),
});
export type PullRequestCommentAssessment = typeof PullRequestCommentAssessment.Type;

export const PullRequestCommentAssessmentInput = Schema.Struct({
  ...PullRequestRef.fields,
  modelSelection: ModelSelection,
  includeIssues: Schema.Boolean,
});

export type PullRequestCommentAssessmentInput = typeof PullRequestCommentAssessmentInput.Type;
