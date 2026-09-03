// Adapted from ninehills/claude-agent-ui (MIT). Parses JSON that is still
// streaming in, so a tool card can show its input before the block closes.

export function parsePartialJson<T = unknown>(jsonString: string): T | null {
  if (!jsonString || jsonString.trim() === '') return null;
  try {
    return JSON.parse(jsonString) as T;
  } catch {
    // fall through to the incremental strategies
  }

  const state = analyze(jsonString);
  try {
    return JSON.parse(state.completed) as T;
  } catch {
    // continue
  }

  if (
    typeof state.prefixEnd === 'number' &&
    state.prefixEnd > 0 &&
    (!state.structuralError || state.lastTopLevelCommaIndex === -1)
  ) {
    const prefix = jsonString.slice(0, state.prefixEnd).trimEnd();
    if (prefix) {
      try {
        return JSON.parse(analyze(prefix).completed) as T;
      } catch {
        try {
          return JSON.parse(prefix) as T;
        } catch {
          // continue
        }
      }
    }
  }
  return parseUpToLastComma<T>(jsonString);
}

type State = {
  completed: string;
  prefixEnd: number | null;
  structuralError: boolean;
  lastTopLevelCommaIndex: number;
};

function analyze(s: string): State {
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  let lastBalanced = -1;
  let firstGarbage: number | null = null;
  let structuralError = false;
  let lastTopLevelComma = -1;

  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (!inString && stack.length === 0 && lastBalanced !== -1) {
      if (/\s/.test(c)) {
        lastBalanced = i + 1;
        continue;
      }
      firstGarbage = i;
      break;
    }
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      if (!inString && stack.length === 0) lastBalanced = i + 1;
      continue;
    }
    if (inString) continue;
    if (c === ',') {
      if (stack.length === 1) lastTopLevelComma = i;
      continue;
    }
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack.length === 0 || stack[stack.length - 1] !== c) {
        structuralError = true;
        firstGarbage = i;
        break;
      }
      stack.pop();
      if (stack.length === 0) lastBalanced = i + 1;
    }
  }

  let completed = s;
  if (inString) completed += '"';
  while (stack.length) completed += stack.pop();
  const prefixEnd = firstGarbage !== null ? firstGarbage : lastBalanced;
  return {
    completed,
    prefixEnd: typeof prefixEnd === 'number' ? prefixEnd : null,
    structuralError,
    lastTopLevelCommaIndex: lastTopLevelComma,
  };
}

function parseUpToLastComma<T>(s: string): T | null {
  const idx = s.lastIndexOf(',');
  if (idx === -1) return null;
  let truncated = s.slice(0, idx);
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (const c of truncated) {
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  if (inString) truncated += '"';
  while (stack.length) truncated += stack.pop();
  try {
    return JSON.parse(truncated) as T;
  } catch {
    return null;
  }
}
