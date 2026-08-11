import { describe, expect, it } from "vitest";
import {
  bodySpanOf,
  callArgs,
  computeCodeMask,
  countTopLevelStatements,
  isCodeIndex,
  matchBracket,
  maskNonCode
} from "./jsscan.js";

function codeAt(text: string, needle: string): boolean {
  const mask = computeCodeMask(text);
  return isCodeIndex(mask, text.indexOf(needle));
}

describe("computeCodeMask / maskNonCode", () => {
  it("preserves length and newlines", () => {
    const text = 'const a = "x";\n// note\nconst b = 1;';
    const masked = maskNonCode(text);
    expect(masked.length).toBe(text.length);
    expect(masked.split("\n").length).toBe(text.split("\n").length);
  });

  it("marks line-comment content as non-code", () => {
    const text = 'app.get("/a", h); // app.get("/dead", h)';
    expect(codeAt(text, "app.get")).toBe(true);
    // The commented occurrence is non-code.
    const mask = computeCodeMask(text);
    expect(isCodeIndex(mask, text.lastIndexOf("app.get"))).toBe(false);
  });

  it("marks block-comment content as non-code", () => {
    const text = '/* app.get("/dead", h) */ real();';
    expect(codeAt(text, "app.get")).toBe(false);
    expect(codeAt(text, "real")).toBe(true);
  });

  it("marks string interiors as non-code but keeps surrounding code", () => {
    const text = 'const s = "router.get(\\"/x\\")"; router.get("/y", h);';
    // The identifier inside the string literal is non-code...
    const mask = computeCodeMask(text);
    expect(isCodeIndex(mask, text.indexOf("router.get"))).toBe(false);
    // ...but the real call afterwards is code.
    expect(isCodeIndex(mask, text.lastIndexOf("router.get"))).toBe(true);
  });

  it("treats template interpolation as code but template text as non-code", () => {
    const text = "const u = `/api/${resource}/list`;";
    expect(codeAt(text, "resource")).toBe(true);
    const mask = computeCodeMask(text);
    // literal path text is non-code
    expect(isCodeIndex(mask, text.indexOf("/api/"))).toBe(false);
  });

  it("does not treat division as a regex", () => {
    const text = "const ratio = width / height; const r = /ab+c/;";
    // The real regex body is non-code.
    const mask = computeCodeMask(text);
    expect(isCodeIndex(mask, text.indexOf("ab+c"))).toBe(false);
    // Division operands stay code.
    expect(isCodeIndex(mask, text.indexOf("height"))).toBe(true);
  });

  it("keeps an assertion token inside a string from counting", () => {
    const body = 'const msg = "expect(x)"; doThing();';
    const masked = maskNonCode(body);
    expect(masked.includes("expect(")).toBe(false);
    expect(masked.includes("doThing(")).toBe(true);
  });
});

describe("matchBracket / callArgs", () => {
  it("finds the matching close bracket", () => {
    const s = "f(a, g(b, c), d)";
    const masked = maskNonCode(s);
    expect(matchBracket(masked, s.indexOf("("))).toBe(s.length - 1);
  });

  it("splits top-level arguments only", () => {
    const s = 'it("a, b", () => { x(1, 2); })';
    const masked = maskNonCode(s);
    const open = s.indexOf("(");
    const args = callArgs(masked, open);
    expect(args.length).toBe(2);
    // The comma inside the string title must not split the first argument.
    const first = s.slice(args[0][0], args[0][1]);
    expect(first.trim().startsWith('"')).toBe(true);
  });
});

describe("bodySpanOf / countTopLevelStatements", () => {
  function testBody(src: string): number {
    const masked = maskNonCode(src);
    const open = masked.indexOf("(");
    const args = callArgs(masked, open);
    const callback = args[args.length - 1];
    const span = bodySpanOf(masked, callback[0], callback[1]);
    if (!span) return 0;
    return countTopLevelStatements(masked, span.start, span.end);
  }

  it("counts an empty arrow body as zero statements", () => {
    expect(testBody('it("x", () => {})')).toBe(0);
  });

  it("counts a one-statement body as one", () => {
    expect(testBody('it("x", () => { expect(y).toBe(1); })')).toBe(1);
  });

  it("counts multiple statements", () => {
    expect(testBody('it("x", () => { a(); b(); c(); })')).toBe(3);
  });

  it("handles function-expression callbacks", () => {
    expect(testBody('it("x", function () { expect(1).toBe(1); })')).toBe(1);
  });
});
