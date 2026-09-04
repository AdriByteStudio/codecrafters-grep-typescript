const args = process.argv;
const pattern = args[3];

const inputLine: string = await Bun.stdin.text();

type Token =
  | { type: "literal"; char: string }
  | { type: "digit" }
  | { type: "word" }
  | { type: "charGroup"; chars: string; negate: boolean };

function parsePattern(pattern: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "\\") {
      const next = pattern[i + 1];
      if (next === "d") {
        tokens.push({ type: "digit" });
        i += 2;
      } else if (next === "w") {
        tokens.push({ type: "word" });
        i += 2;
      } else {
        tokens.push({ type: "literal", char: next });
        i += 2;
      }
    } else if (pattern[i] === "[" && i + 1 < pattern.length && pattern[i + 1] === "^") {
      const close = pattern.indexOf("]", i + 2);
      const chars = pattern.slice(i + 2, close);
      tokens.push({ type: "charGroup", chars, negate: true });
      i = close + 1;
    } else if (pattern[i] === "[") {
      const close = pattern.indexOf("]", i + 1);
      const chars = pattern.slice(i + 1, close);
      tokens.push({ type: "charGroup", chars, negate: false });
      i = close + 1;
    } else {
      tokens.push({ type: "literal", char: pattern[i] });
      i++;
    }
  }
  return tokens;
}

function matchAt(tokens: Token[], input: string, pos: number): boolean {
  for (const token of tokens) {
    if (pos >= input.length) return false;
    const ch = input[pos];
    if (token.type === "literal") {
      if (ch !== token.char) return false;
    } else if (token.type === "digit") {
      if (!(ch >= "0" && ch <= "9")) return false;
    } else if (token.type === "word") {
      if (
        !(
          (ch >= "a" && ch <= "z") ||
          (ch >= "A" && ch <= "Z") ||
          (ch >= "0" && ch <= "9") ||
          ch === "_"
        )
      )
        return false;
    } else if (token.type === "charGroup") {
      const inGroup = token.chars.includes(ch);
      if (token.negate ? inGroup : !inGroup) return false;
    }
    pos++;
  }
  return true;
}

function matchPattern(inputLine: string, pattern: string): boolean {
  let anchored = false;
  let pat = pattern;
  if (pat.startsWith("^")) {
    anchored = true;
    pat = pat.slice(1);
  }
  const tokens = parsePattern(pat);
  if (anchored) {
    return matchAt(tokens, inputLine, 0);
  }
  for (let i = 0; i <= inputLine.length - tokens.length; i++) {
    if (matchAt(tokens, inputLine, i)) return true;
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
