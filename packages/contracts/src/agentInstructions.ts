/**
 * Agent instructions contract.
 *
 * Each provider reads its own instructions file: one in the repository and one in the
 * provider's home directory. The repository file goes through the ordinary project file
 * RPCs, because it lives inside a known workspace. The global file lives outside every
 * workspace, so the server resolves its path itself and the client never sends one.
 *
 * @module agentInstructions
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * The file name each provider reads, in the repository root and in its home directory.
 * A driver missing here has no instructions file T3 Code knows how to edit.
 */
const AGENT_INSTRUCTIONS_FILE_NAMES: Readonly<Record<string, string>> = {
  claudeAgent: "CLAUDE.md",
  codex: "AGENTS.md",
};

export function agentInstructionsFileName(driver: string): string | null {
  return AGENT_INSTRUCTIONS_FILE_NAMES[driver] ?? null;
}

export const AgentInstructionsGlobalInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type AgentInstructionsGlobalInput = typeof AgentInstructionsGlobalInput.Type;

/** The provider's global instructions file. `exists` is false until the first save. */
export const AgentInstructionsGlobalFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  contents: Schema.String,
  exists: Schema.Boolean,
});
export type AgentInstructionsGlobalFile = typeof AgentInstructionsGlobalFile.Type;

export const AgentInstructionsGlobalWriteInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  contents: Schema.String,
});
export type AgentInstructionsGlobalWriteInput = typeof AgentInstructionsGlobalWriteInput.Type;

export class AgentInstructionsError extends Schema.TaggedError<AgentInstructionsError>()(
  "AgentInstructionsError",
  {
    reason: Schema.Literals(["unsupportedProvider", "readFailed", "writeFailed"]),
    /** Stable, bounded description. The underlying failure travels in `cause`. */
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Agent instructions failed (${this.reason}): ${this.detail}`;
  }
}
