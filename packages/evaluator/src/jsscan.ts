// Dependency-free JavaScript/TypeScript surface scanner.
//
// The extractor relies on regular expressions. Run naively they match route-,
// test-, and assertion-like text that lives inside comments, strings, or regex
// literals, producing false positives (e.g. a commented-out `app.get(...)`).
//
// This module provides a single left-to-right state machine that classifies
// every character as "code" or "not code" (comment / string body / regex
// literal / template-literal text), while treating `${...}` interpolations as
// code. Two views are exposed:
//
//   computeCodeMask(text) -> Uint8Array  (1 = code position, 0 = otherwise)
//   maskNonCode(text)     -> string      (non-code chars replaced by spaces,
//                                          newlines preserved so line numbers
//                                          and offsets are unchanged)
//
// Usage patterns:
//   * Keep running existing regexes on the ORIGINAL text so string captures
//     (route paths, test titles) still work, and use isCodeIndex() to reject a
//     match whose start sits in a comment or string.
//   * Run token searches (assertion detection) on maskNonCode() output so that
//     matches inside strings/comments are ignored.

const CODE = 1;
const NON_CODE = 0;

// Characters that, as the previous significant code token, put a following `/`
// in expression position (regex literal) rather than division.
const REGEX_PRECEDING = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "~",
  "^",
  "<",
  ">"
]);

const KEYWORDS_BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
  "case"
]);

export function computeCodeMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length).fill(CODE);
  let i = 0;
  // Stack of template-literal states so nested `${`...`}` works.
  const templateStack: number[] = [];
  // Track the previous significant code character (and identifier word) for
  // regex-vs-division disambiguation.
  let prevSignificant = "";
  let prevWord = "";

  const markRange = (from: number, to: number): void => {
    for (let k = from; k < to && k < text.length; k += 1) {
      if (text[k] !== "\n") mask[k] = NON_CODE;
    }
  };

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    // Line comment.
    if (ch === "/" && next === "/") {
      let j = i + 2;
      while (j < text.length && text[j] !== "\n") j += 1;
      markRange(i, j);
      i = j;
      continue;
    }

    // Block comment.
    if (ch === "/" && next === "*") {
      let j = i + 2;
      while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) {
        j += 1;
      }
      j = Math.min(text.length, j + 2);
      markRange(i, j);
      i = j;
      continue;
    }

    // String literal (single or double quote).
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === quote || text[j] === "\n") break;
        j += 1;
      }
      const end = text[j] === quote ? j + 1 : j;
      // Mark the interior (and delimiters) as non-code.
      markRange(i, end);
      i = end;
      prevSignificant = quote;
      prevWord = "";
      continue;
    }

    // Template literal.
    if (ch === "`") {
      let j = i + 1;
      mask[i] = NON_CODE;
      while (j < text.length) {
        if (text[j] === "\\") {
          markRange(j, j + 2);
          j += 2;
          continue;
        }
        if (text[j] === "`") {
          mask[j] = NON_CODE;
          j += 1;
          break;
        }
        if (text[j] === "$" && text[j + 1] === "{") {
          // Enter interpolation: characters remain code. Delimiters non-code.
          mask[j] = NON_CODE;
          mask[j + 1] = NON_CODE;
          templateStack.push(1);
          j += 2;
          // Process interpolation with the main loop by breaking out.
          break;
        }
        if (text[j] !== "\n") mask[j] = NON_CODE;
        j += 1;
      }
      i = j;
      prevSignificant = "`";
      prevWord = "";
      continue;
    }

    // Closing an interpolation returns to template text.
    if (ch === "}" && templateStack.length > 0) {
      mask[i] = NON_CODE;
      templateStack.pop();
      i += 1;
      // Resume template literal text until next `${` or closing backtick.
      let j = i;
      while (j < text.length) {
        if (text[j] === "\\") {
          markRange(j, j + 2);
          j += 2;
          continue;
        }
        if (text[j] === "`") {
          mask[j] = NON_CODE;
          j += 1;
          break;
        }
        if (text[j] === "$" && text[j + 1] === "{") {
          mask[j] = NON_CODE;
          mask[j + 1] = NON_CODE;
          templateStack.push(1);
          j += 2;
          break;
        }
        if (text[j] !== "\n") mask[j] = NON_CODE;
        j += 1;
      }
      i = j;
      prevSignificant = "`";
      prevWord = "";
      continue;
    }

    // Regex literal.
    if (ch === "/") {
      const usePrev =
        prevWord && KEYWORDS_BEFORE_REGEX.has(prevWord)
          ? true
          : prevSignificant === "" || REGEX_PRECEDING.has(prevSignificant);
      if (usePrev) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < text.length) {
          const c = text[j];
          if (c === "\\") {
            j += 2;
            continue;
          }
          if (c === "\n") break;
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) {
            closed = true;
            j += 1;
            break;
          }
          j += 1;
        }
        if (closed) {
          // Consume trailing flags.
          while (j < text.length && /[a-z]/i.test(text[j])) j += 1;
          markRange(i, j);
          i = j;
          prevSignificant = "/";
          prevWord = "";
          continue;
        }
        // Not actually a regex; fall through as division.
      }
    }

    // Ordinary code character. Update the previous-significant trackers.
    if (!/\s/.test(ch)) {
      prevSignificant = ch;
      if (/[A-Za-z0-9_$]/.test(ch)) {
        prevWord += ch;
      } else {
        prevWord = "";
      }
    }
    i += 1;
  }

  return mask;
}

export function maskNonCode(text: string): string {
  const mask = computeCodeMask(text);
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    out += mask[i] === CODE ? text[i] : text[i] === "\n" ? "\n" : " ";
  }
  return out;
}

/** True when the character at `index` is a code position (not string/comment). */
export function isCodeIndex(mask: Uint8Array, index: number): boolean {
  return index >= 0 && index < mask.length && mask[index] === CODE;
}

const OPEN_TO_CLOSE: Record<string, string> = { "(": ")", "{": "}", "[": "]" };

/**
 * Given the index of an opening bracket in `masked` (a maskNonCode() string, so
 * brackets inside strings/comments are already spaces and ignored), return the
 * index of its matching close bracket, or null if unbalanced.
 */
export function matchBracket(masked: string, openIndex: number): number | null {
  const open = masked[openIndex];
  const close = OPEN_TO_CLOSE[open];
  if (!close) return null;
  let depth = 0;
  for (let i = openIndex; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * Given `masked` and the index of the `(` that opens a call's argument list,
 * return the top-level argument spans [start, end) (end exclusive), split on
 * commas that are not nested inside brackets.
 */
export function callArgs(
  masked: string,
  openParenIndex: number
): Array<[number, number]> {
  const close = matchBracket(masked, openParenIndex);
  if (close === null) return [];
  const args: Array<[number, number]> = [];
  let depth = 0;
  let start = openParenIndex + 1;
  for (let i = openParenIndex + 1; i < close; i += 1) {
    const ch = masked[i];
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      args.push([start, i]);
      start = i + 1;
    }
  }
  if (start < close || args.length > 0) args.push([start, close]);
  // Keep positional arguments even when their masked text is all spaces (a
  // string literal title masks to spaces but is still a real argument). Only
  // drop a trailing empty argument, e.g. `f()` or a trailing comma.
  return args.filter(([a, b], index) => {
    if (masked.slice(a, b).trim().length > 0) return true;
    return index < args.length - 1;
  });
}

/**
 * Given a masked string and the span of a function-argument that is expected to
 * be a callback, return the [start, end) span of its `{...}` body (exclusive of
 * braces), or null for a concise arrow body / non-block argument.
 */
export function bodySpanOf(
  masked: string,
  argStart: number,
  argEnd: number
): { start: number; end: number } | null {
  // The body brace is the first `{` at bracket-depth 0 within the argument.
  // This works for both `() => { ... }` and `function () { ... }` because the
  // parameter list `(...)` is consumed as depth before the body brace appears,
  // and it naturally rejects concise arrow bodies (`() => x`) and object-return
  // arrows (`() => ({...})`, where the brace is nested in parens).
  let depth = 0;
  let brace = -1;
  for (let i = argStart; i < argEnd; i += 1) {
    const ch = masked[i];
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === "{" && depth === 0) {
      brace = i;
      break;
    }
  }
  if (brace < 0) return null;
  const close = matchBracket(masked, brace);
  if (close === null || close > argEnd) return null;
  return { start: brace + 1, end: close };
}

/**
 * Count top-level statements in a masked body span by counting `;` and top-level
 * `}` block terminators that are not nested. This is a heuristic used only to
 * distinguish an empty body ({}) from a non-empty one, so precision at the
 * boundary is unimportant.
 */
export function countTopLevelStatements(
  masked: string,
  start: number,
  end: number
): number {
  const body = masked.slice(start, end).trim();
  if (body.length === 0) return 0;
  let depth = 0;
  let statements = 0;
  let sawContent = false;
  for (let i = start; i < end; i += 1) {
    const ch = masked[i];
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
    else if (ch === ";" && depth === 0) statements += 1;
    if (!/\s/.test(ch)) sawContent = true;
  }
  // A body with content but no top-level semicolon (e.g. a single call or an
  // expression) still counts as one statement.
  if (statements === 0 && sawContent) return 1;
  return statements;
}
