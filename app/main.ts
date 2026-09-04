const args = process.argv;
const pattern = args[3];

const inputLine: string = await Bun.stdin.text();

type Token =
  | { type: "literal"; char: string; plus?: boolean; opt?: boolean }
  | { type: "digit"; plus?: boolean; opt?: boolean }
  | { type: "word"; plus?: boolean; opt?: boolean }
  | { type: "anyChar"; plus?: boolean; opt?: boolean }
  | { type: "charGroup"; chars: string; negate: boolean; plus?: boolean; opt?: boolean };

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
    if (pattern[i] === "+") {
      tok.plus = true;
      i++;
    } else if (pattern[i] === "?") {
      tok.opt = true;
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

if (args[2] !== "-E") {
  console.log("Expected first argument to be '-E'");
  process.exit(1);
}

if (matchPattern(inputLine, pattern)) {
  console.log(inputLine.replace(/\n$/, ""));
  process.exit(0);
} else {
  process.exit(1);
}
