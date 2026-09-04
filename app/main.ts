const args = process.argv;

let inputLine: string = "";

// ---- Argument parsing (early, so we know whether to read a file) --------
const oFlag = args.includes("-o");
const eIndex = args.lastIndexOf("-E");
if (eIndex === -1) {
  console.log("Expected '-E' argument");
  process.exit(1);
}
const patternStr = args[eIndex + 1];

const rFlag = args.includes("-r");

// Collect file arguments: everything after the pattern that doesn't start with '-'.
const fileArgs: string[] = [];
for (let fi = eIndex + 2; fi < args.length; fi++) {
  if (args[fi].startsWith("-")) continue;
  fileArgs.push(args[fi]);
}

// Load input lines: from files (with optional prefix) or stdin.
interface InputEntry { prefix: string; text: string; }
const inputs: InputEntry[] = [];

if (rFlag && fileArgs.length > 0) {
  // Recursive directory search: collect all files under each directory argument.
  const pathMod = await import("path");
  const fsMod = await import("fs/promises");
  for (const dir of fileArgs) {
    const entries = await fsMod.readdir(dir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = pathMod.join(entry.parentPath ?? entry.path, entry.name);
      const relPath = pathMod.join(dir, pathMod.relative(dir, fullPath));
      const text = await Bun.file(fullPath).text();
      inputs.push({ prefix: relPath + ":", text });
    }
  }
} else if (fileArgs.length > 0) {
  const multiFile = fileArgs.length > 1;
  for (const f of fileArgs) {
    inputs.push({ prefix: multiFile ? f + ":" : "", text: await Bun.file(f).text() });
  }
} else {
  inputs.push({ prefix: "", text: await Bun.stdin.text() });
}

type Token =
  | { type: "literal"; char: string; plus?: boolean; opt?: boolean; star?: boolean }
  | { type: "digit"; plus?: boolean; opt?: boolean; star?: boolean }
  | { type: "word"; plus?: boolean; opt?: boolean; star?: boolean }
  | { type: "anyChar"; plus?: boolean; opt?: boolean; star?: boolean }
  | { type: "charGroup"; chars: string; negate: boolean; plus?: boolean; opt?: boolean; star?: boolean };

function parsePattern(pattern: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < pattern.length) {
    let tok: Token;
    if (pattern[i] === "\\") {
      const next = pattern[i + 1];
      if (next === "d") {
        tok = { type: "digit" };
        i += 2;
      } else if (next === "w") {
        tok = { type: "word" };
        i += 2;
      } else {
        tok = { type: "literal", char: next };
        i += 2;
      }
    } else if (pattern[i] === "[" && i + 1 < pattern.length && pattern[i + 1] === "^") {
      const close = pattern.indexOf("]", i + 2);
      const chars = pattern.slice(i + 2, close);
      tok = { type: "charGroup", chars, negate: true };
      i = close + 1;
    } else if (pattern[i] === "[") {
      const close = pattern.indexOf("]", i + 1);
      const chars = pattern.slice(i + 1, close);
      tok = { type: "charGroup", chars, negate: false };
      i = close + 1;
    } else if (pattern[i] === ".") {
      tok = { type: "anyChar" };
      i++;
    } else {
      tok = { type: "literal", char: pattern[i] };
      i++;
    }
    if (pattern[i] === "{") {
      // {n} quantifier: expand into n copies of the preceding token.
      const closeBrace = pattern.indexOf("}", i + 1);
      if (closeBrace !== -1) {
        const count = parseInt(pattern.slice(i + 1, closeBrace), 10);
        if (!isNaN(count) && count >= 0) {
          for (let c = 0; c < count; c++) {
            tokens.push({ ...tok });
          }
          i = closeBrace + 1;
          continue; // skip the default push below
        }
      }
      // Not a valid {n} — treat '{' as part of the token (fall through).
    }
    if (pattern[i] === "+") {
      tok.plus = true;
      i++;
    } else if (pattern[i] === "?") {
      tok.opt = true;
      i++;
    } else if (pattern[i] === "*") {
      tok.star = true;
      i++;
    }
    tokens.push(tok);
  }
  return tokens;
}

function matchesToken(token: Token, ch: string): boolean {
  if (token.type === "literal") {
    return ch === token.char;
  } else if (token.type === "digit") {
    return ch >= "0" && ch <= "9";
  } else if (token.type === "anyChar") {
    return ch !== "\n";
  } else if (token.type === "word") {
    return (
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "_"
    );
  } else {
    const inGroup = token.chars.includes(ch);
    return token.negate ? !inGroup : inGroup;
  }
}

/**
 * Recursive matcher.
 *
 * @param tokens     parsed pattern tokens
 * @param ti         current token index
 * @param input      the input string
 * @param pi         current position in input
 * @param mustFinish if true, the match must consume the ENTIRE remaining input
 */
function matchRecur(
  tokens: Token[],
  ti: number,
  input: string,
  pi: number,
  mustFinish: boolean
): boolean {
  if (ti >= tokens.length) {
    return mustFinish ? pi === input.length : true;
  }

  const token = tokens[ti];

  if (token.plus) {
    // Consume one-or-more occurrences greedily, then backtrack shorter lengths.
    let k = pi;
    while (k < input.length && matchesToken(token, input[k])) k++;
    for (let n = k; n > pi; n--) {
      if (matchRecur(tokens, ti + 1, input, n, mustFinish)) return true;
    }
    return false;
  }

  if (token.star) {
    // Zero-or-more: try consuming as many as possible greedily, then backtrack.
    let k = pi;
    while (k < input.length && matchesToken(token, input[k])) k++;
    for (let n = k; n >= pi; n--) {
      if (matchRecur(tokens, ti + 1, input, n, mustFinish)) return true;
    }
    return false;
  }

  if (token.opt) {
    // Zero-or-one: try skipping the token first, then try consuming it.
    if (matchRecur(tokens, ti + 1, input, pi, mustFinish)) return true;
    if (pi < input.length && matchesToken(token, input[pi])) {
      return matchRecur(tokens, ti + 1, input, pi + 1, mustFinish);
    }
    return false;
  }

  if (pi >= input.length) return false;
  if (!matchesToken(token, input[pi])) return false;
  return matchRecur(tokens, ti + 1, input, pi + 1, mustFinish);
}

/**
 * Expand a pattern containing parenthesised alternation groups like
 * `(cat|dog)` into an array of flat pattern strings (Cartesian product),
 * leaving ordinary metacharacters (\d, \w, [], ., *, ?, +, ^, $) untouched.
 */
function expandGroups(pattern: string): string[] {
  let idx = 0;
  let curPrefix = "";

  while (idx < pattern.length) {
    const ch = pattern[idx];
    if (ch === "\\") {
      curPrefix += pattern.substr(idx, 2);
      idx += 2;
      continue;
    }
    if (ch === "(") {
      // Find matching closing paren accounting for escapes.
      let depth = 1;
      let j = idx + 1;
      while (j < pattern.length && depth > 0) {
        if (pattern[j] === "\\") {
          j += 2;
          continue;
        }
        if (pattern[j] === "(") depth++;
        else if (pattern[j] === ")") depth--;
        if (depth > 0) j++;
      }
      const inner = pattern.substring(idx + 1, j);
      const closedIdx = j;
      // Alternatives inside this group (split on top-level | ).
      const alts = splitTopLevelPipe(inner);
      // Suffix after the group gets processed recursively.
      const suffixes = expandGroups(pattern.substring(closedIdx + 1));
      const products: string[] = [];
      for (const alt of alts) {
        const expAlt = expandSingleSegment(alt);
        for (const ea of expAlt) {
          for (const suf of suffixes) {
            products.push(curPrefix + ea + suf);
          }
        }
      }
      return products;
    }
    curPrefix += ch;
    idx++;
  }

  // No groups found: emit the segment as-is.
  return [curPrefix];
}

/** Split a group-body string on top-level `|` (respecting nests/escapes). */
function splitTopLevelPipe(s: string): string[] {
  const segs: string[] = [];
  let depth = 0;
  let buf = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      buf += s.substr(i, 2);
      i += 2;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === "|" && depth === 0) {
      segs.push(buf);
      buf = "";
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  segs.push(buf);
  return segs;
}

/** Expand a single alternative (which may itself contain nested groups). */
function expandSingleSegment(seg: string): string[] {
  return expandGroups(seg);
}

function matchPattern(inputLine: string, pattern: string): boolean {
  const candidates = expandGroups(pattern);
  for (const cand of candidates) {
    if (matchFlat(cand)(inputLine)) return true;
  }
  return false;
}

function matchFlat(pattern: string): (inputLine: string) => boolean {
  return (inputLine: string) => {
    let anchoredStart = false;
    let pat = pattern;
    if (pat.startsWith("^")) {
      anchoredStart = true;
      pat = pat.slice(1);
    }
    let anchoredEnd = false;
    if (pat.endsWith("$")) {
      anchoredEnd = true;
      pat = pat.slice(0, -1);
    }
    const tokens = parsePattern(pat);

    if (anchoredStart && anchoredEnd) {
      return matchRecur(tokens, 0, inputLine, 0, true);
    }
    if (anchoredStart) {
      return matchRecur(tokens, 0, inputLine, 0, false);
    }
    if (anchoredEnd) {
      for (let i = 0; i <= inputLine.length; i++) {
        if (matchRecur(tokens, 0, inputLine, i, true)) return true;
      }
      return false;
    }
    for (let i = 0; i <= inputLine.length; i++) {
      if (matchRecur(tokens, 0, inputLine, i, false)) return true;
    }
    return false;
  };
}

/** Strip leading ^ and trailing $ from a raw pattern. */
function stripAnchors(p: string): string {
  let q = p;
  if (q.startsWith("^")) q = q.slice(1);
  if (q.endsWith("$")) q = q.slice(0, -1);
  return q;
}

/** True iff the FULL input is consumed by the (already-flattened) pattern. */
function fullMatchFlattened(flattened: string, input: string): boolean {
  const tokens = parsePattern(flattened);
  return matchRecur(tokens, 0, input, 0, true);
}

interface RawSpec {
  anchoredStart: boolean;
  anchoredEnd: boolean;
  candidates: string[];
}

function preparePattern(rawPattern: string): RawSpec {
  return {
    anchoredStart: rawPattern.startsWith("^"),
    anchoredEnd: rawPattern.endsWith("$"),
    candidates: expandGroups(stripAnchors(rawPattern)),
  };
}

/**
 * Find the leftmost match occurring AT OR AFTER `from`, honoring anchors.
 * Among alternatives tied at the same start, the first-declared wins
 * (real grep prefers the leftmost match overall). Within a winning
 * alternative, the longest text is chosen. Returns { start, text } or null.
 */
function findNextMatch(spec: RawSpec, text: string, from: number): { start: number; text: string } | null {
  const startMin = spec.anchoredStart ? Math.max(Math.min(0, text.length), from) : from;
  const startMax = spec.anchoredStart ? Math.min(0, text.length) : text.length;

  for (let s = startMin; s <= startMax; s++) {
    for (const cand of spec.candidates) {
      let best: string | null = null;
      // Length bounds: with $-anchor the match must reach the end of text.
      const lo = spec.anchoredEnd ? text.length - s : 1;
      const hi = text.length - s;
      for (let l = lo; l <= hi; l++) {
        const sub = text.slice(s, s + l);
        if (fullMatchFlattened(cand, sub)) best = sub;
      }
      if (best !== null) return { start: s, text: best };
    }
  }
  return null;
}

/** Collect all non-overlapping match intervals ([start, end)). */
function collectIntervals(rawPattern: string, text: string): Array<[number, number]> {
  const spec = preparePattern(rawPattern);
  const results: Array<[number, number]> = [];
  let pos = 0;
  while (pos <= text.length) {
    const m = findNextMatch(spec, text, pos);
    if (m === null) break;
    results.push([m.start, m.start + m.text.length]);
    // Advance past this match (non-zero width guaranteed since l>=1).
    pos = m.start + m.text.length;
  }
  return results;
}

/** Collect all non-overlapping matched substrings. */
function extractAll(rawPattern: string, text: string): string[] {
  return collectIntervals(rawPattern, text).map(([s, e]) => text.slice(s, e));
}

/** Wrap every matched interval in the bold-red ANSI highlight. */
function highlightLine(rawPattern: string, text: string): string {
  const OPEN = "\u001b[01;31m";
  const CLOSE = "\u001b[m";
  const ivs = collectIntervals(rawPattern, text);
  if (ivs.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const [s, e] of ivs) {
    out += text.slice(cursor, s);
    out += OPEN + text.slice(s, e) + CLOSE;
    cursor = e;
  }
  out += text.slice(cursor);
  return out;
}

// Decide whether to highlight based on --color=<mode>.
// "always" -> yes; "auto" -> yes only when stdout is a TTY; "never"/absent -> no.
const colorOpt = args.find((a) => a.startsWith("--color="));
const colorVal = colorOpt ? colorOpt.slice("--color=".length) : undefined;
const useColor =
  colorVal === "always" ||
  (colorVal === "auto" &&
    typeof process.stdout.isTTY === "boolean" &&
    process.stdout.isTTY === true);

let anyMatch = false;
for (const entry of inputs) {
  const linesArr = entry.text.split("\n");
  for (const line of linesArr) {
    if (oFlag) {
      const matches = extractAll(patternStr, line);
      for (const mtxt of matches) {
        console.log(entry.prefix + mtxt);
        anyMatch = true;
      }
    } else if (useColor) {
      if (matchPattern(line, patternStr)) {
        console.log(entry.prefix + highlightLine(patternStr, line));
        anyMatch = true;
      }
    } else {
      if (matchPattern(line, patternStr)) {
        console.log(entry.prefix + line);
        anyMatch = true;
      }
    }
  }
}

process.exit(anyMatch ? 0 : 1);
