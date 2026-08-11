// Deliberately dependency-free, deliberately approximate token accounting.
//
// A real tokenizer (tiktoken WASM, provider SDKs) is not worth its weight for a
// privacy-first local CLI, and shipping one invites the reader to treat the
// number as exact. Every count produced here is a bytes/4 estimate and every
// surfaced figure is labelled with the estimator so it can never be mistaken
// for a billed token count.

export const TOKEN_ESTIMATOR = "bytes-div-4" as const;

export interface ArtifactSize {
  bytes: number;
  estimatedTokens: number;
  estimator: typeof TOKEN_ESTIMATOR;
}

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text) / 4);
}

export function sizeOf(text: string): ArtifactSize {
  const bytes = Buffer.byteLength(text);
  return {
    bytes,
    estimatedTokens: Math.ceil(bytes / 4),
    estimator: TOKEN_ESTIMATOR
  };
}

/** Whole-number percentage reduction from `from` to `to` (0 when from is 0). */
export function reductionPercent(from: number, to: number): number {
  if (from <= 0) return 0;
  return Math.max(0, Math.round(((from - to) / from) * 100));
}
