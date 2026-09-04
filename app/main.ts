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

function matchPattern(inputLine: string, pattern: string): boolean {
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
}

if (args[2] !== "-E") {
  console.log("Expected first argument to be '-E'");
  process.exit(1);
}

// You can use print statements as follows for debugging, they'll be visible when running tests.
console.error("Logs from your program will appear here!");

// TODO: Uncomment the code below to pass the first stage
if (matchPattern(inputLine, pattern)) {
  process.exit(0);
} else {
  process.exit(1);
}
