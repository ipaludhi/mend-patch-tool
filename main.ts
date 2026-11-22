// main.ts is mend, the CLI SPEC.md specifies (MIT starter + this implementation).
// It does all of SPEC.md: the command line, output and exit codes, safe paths,
// format detection, the four formats (unified, SEARCH/REPLACE, V4A, JSON), line
// matching at three tiers, and the all-or-nothing write. Node 22, stdlib alone;
// run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  registerMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files as lines (SPEC.md section 3) and matching (section 5)
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function serializeFile(f: FileState): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

const lead = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const normLine = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? rtrimST(s) : trimST(s));

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; only 0 when strict) with an occurrence, or null. */
function findTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from: number,
  eofOnly: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let occ = occurrences(lines, o, t, from);
    if (eofOnly) occ = occ.filter((i) => i + o.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of O or N: context lines are shared with the file, the rest are new. */
interface LineItem {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Build O/N items from hunk/chunk body lines (the `\` lines are not lines). */
function buildItems(body: string[]): { o: LineItem[]; n: LineItem[] } {
  const o: LineItem[] = [];
  const n: LineItem[] = [];
  for (const ln of body) {
    if (ln.startsWith('\\')) continue;
    if (ln === '' || ln[0] === ' ') {
      const text = ln === '' ? '' : ln.slice(1);
      const oIdx = o.length;
      o.push({ text, ctx: true, oIdx });
      n.push({ text, ctx: true, oIdx });
    } else if (ln[0] === '-') {
      o.push({ text: ln.slice(1), ctx: false, oIdx: -1 });
    } else if (ln[0] === '+') {
      n.push({ text: ln.slice(1), ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

/** True when a `\` line follows the body's last context or `+` line. */
function noNewlineAfterLast(body: string[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    const ln = body[i]!;
    if (ln === '' || ln[0] === ' ' || ln[0] === '+') last = i;
  }
  return last >= 0 && last + 1 < body.length && body[last + 1]!.startsWith('\\');
}

/** Replace the k matched lines at pos by N (section 5: context from the file, tier-2 re-indent). */
function replaceLines(fileLines: string[], pos: number, o: LineItem[], n: LineItem[], tier: number): string[] {
  const f = o.length > 0 ? lead(fileLines[pos]!) : '';
  const p = o.length > 0 ? lead(o[0]!.text) : '';
  const out = n.map((it) => {
    if (it.ctx) return fileLines[pos + it.oIdx]!;
    let s = it.text;
    if (tier === 2 && s !== '' && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
    return s;
  });
  return [...fileLines.slice(0, pos), ...out, ...fileLines.slice(pos + o.length)];
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9) — as the starter had them
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: string[];
}
interface Section {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function parseUnifiedPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hOld: string | null = null;
  let hNew: string | null = null;
  let hPair = false;
  let hRenameFrom: string | null = null;
  let hRenameTo: string | null = null;
  let hNewFile = false;
  let hDelFile = false;
  let hDiffX: string | null = null;
  let hDiffY: string | null = null;
  let inHeader = false;
  const close = (): void => {
    if (cur !== null) {
      cur.oldPath = hPair ? hOld : hRenameFrom ?? hDiffX;
      cur.newPath = hPair ? hNew : hRenameTo ?? hDiffY;
      cur.newFile = hNewFile;
      cur.delFile = hDelFile;
      sections.push(cur);
    }
    cur = null;
  };
  const open = (diffX: string | null, diffY: string | null): void => {
    close();
    cur = { oldPath: null, newPath: null, newFile: false, delFile: false, hunks: [] };
    hOld = null;
    hNew = null;
    hPair = false;
    hRenameFrom = null;
    hRenameTo = null;
    hNewFile = false;
    hDelFile = false;
    hDiffX = diffX;
    hDiffY = diffY;
    inHeader = true;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const diff = DIFF_RE.exec(line);
    if (diff !== null) {
      open(diff[1]!, diff[2]!);
      i += 1;
      continue;
    }
    if (line.startsWith('diff --git ')) throw new Exit2(`error: parse ${i + 1}`);
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) open(null, null);
      hOld = parseUnifiedPath(lines[i]!.slice(4));
      hNew = parseUnifiedPath(lines[i + 1]!.slice(4));
      hPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) hRenameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) hRenameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) hNewFile = true;
      else if (line.startsWith('deleted file mode')) hDelFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  close();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = oldP === null || sec.newFile;
    const isDelete = !isCreate && (newP === null || sec.delFile);
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    const path = isCreate ? newP : oldP;
    if (isMove) {
      if (oldP === null || !safe(oldP)) throw new Fail('unsafe', oldP ?? '');
      if (newP === null || !safe(newP)) throw new Fail('unsafe', newP ?? '');
    } else if (path === null || !safe(path)) {
      throw new Fail('unsafe', path ?? '');
    }
    if (isCreate) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastNoNl = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k += 1) {
          const ln = h.body[k]!;
          if (ln[0] === '+') {
            plus.push(ln.slice(1));
            lastNoNl = k + 1 < h.body.length && h.body[k + 1]!.startsWith('\\');
          }
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (lastNoNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = oldP!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP!;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (isMove) {
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
    }
    const state = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const { o, n } = buildItems(h.body);
      const noNl = noNewlineAfterLast(h.body);
      if (o.length === 0) {
        const ins = Math.min(h.a + d, state.lines.length);
        const atEnd = ins === state.lines.length;
        state.lines.splice(ins, 0, ...n.map((it) => it.text));
        if (atEnd) state.final = !noNl;
        d += n.length;
      } else {
        const found = findTier(state.lines, o.map((x) => x.text), strict, 0, false);
        if (found === null) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let pick = found.occ[0]!;
        let best = Math.abs(pick - target);
        for (const cand of found.occ) {
          const dist = Math.abs(cand - target);
          if (dist < best) {
            best = dist;
            pick = cand;
          }
        }
        const atEnd = pick + o.length === state.lines.length;
        state.lines = replaceLines(state.lines, pick, o, n, found.tier);
        if (atEnd) state.final = !noNl;
        d += n.length - o.length;
      }
    }
    const text = serializeFile(state);
    if (isMove) {
      const np = newP!;
      tree.now.set(op, null);
      tree.now.set(np, text);
      tree.registerMove(op, np);
    } else {
      tree.now.set(op, text);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  for (;;) {
    let sIdx = -1;
    for (let j = searchFrom; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        sIdx = j;
        break;
      }
    }
    if (sIdx < 0) break;
    let eqIdx = -1;
    for (let j = sIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eqIdx = j;
        break;
      }
    }
    let repIdx = -1;
    if (eqIdx >= 0) {
      for (let j = eqIdx + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          repIdx = j;
          break;
        }
      }
    }
    if (eqIdx < 0 || repIdx < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let path: string | null = null;
    for (let j = sIdx - 1; j >= searchFrom; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(sIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    searchFrom = repIdx + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const state = parseFile(before);
    const found = findTier(state.lines, oldLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const o = oldLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const n = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    state.lines = replaceLines(state.lines, found.occ[0]!, o, n, found.tier);
    tree.now.set(path, serializeFile(state));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

const V4A_SECTION = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function trimTrailingBlank(body: string[]): void {
  // A blank line is one that is empty or only whitespace (section 4); blank
  // lines at the end of a section are not part of it (section 8).
  while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    if (V4A_SECTION(line)) {
      const isAdd = line.startsWith('*** Add File: ');
      const isDel = line.startsWith('*** Delete File: ');
      const path = line.slice(isAdd ? 14 : 17).trim();
      let j = i + 1;
      while (j < last && !V4A_SECTION(lines[j]!)) j += 1;
      const content: { line: string; idx: number }[] = [];
      for (let k = i + 1; k < j; k += 1) content.push({ line: lines[k]!, idx: k });
      if (isAdd) {
        // Blank lines at the end of a section are not part of it.
        let end = content.length;
        while (end > 0 && blank(content[end - 1]!.line)) end -= 1;
        const fileLines: string[] = [];
        for (let k = 0; k < end; k += 1) {
          const c = content[k]!;
          if (c.line === '') fileLines.push('');
          else if (c.line.startsWith('+')) fileLines.push(c.line.slice(1));
          else throw new Exit2(`error: parse ${c.idx + 1}`);
        }
        edits.push(v4aAddEdit(path, fileLines));
      } else if (isDel) {
        for (const c of content) {
          if (!blank(c.line)) throw new Exit2(`error: parse ${c.idx + 1}`);
        }
        edits.push(v4aDeleteEdit(path));
      } else {
        edits.push(v4aUpdateEdit(path, content, i, strict));
      }
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, content: { line: string; idx: number }[], updateIdx: number, strict: boolean): Edit {
  // Parse the section's chunks now (parse errors are exit 2, before any file).
  let moveTo: string | null = null;
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let k = 0;
  while (k < content.length) {
    const { line, idx } = content[k]!;
    if (line.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
      trimTrailingBlank(cur.body);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      k += 1;
      continue;
    }
    if (line.startsWith('*** Move to: ')) {
      if (moveTo !== null || chunks.length > 0 || cur !== null) throw new Exit2(`error: parse ${idx + 1}`);
      moveTo = line.slice(13).trim();
      k += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur !== null) {
        trimTrailingBlank(cur.body);
        chunks.push(cur);
        cur = null;
      }
      const anchor = line.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      k += 1;
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (line === '' && cur === null) {
        let nk = k + 1;
        while (nk < content.length && content[nk]!.line === '') nk += 1;
        const nxt = nk < content.length ? content[nk]!.line : null;
        if (nxt === null || nxt.startsWith('@@') || nxt.trim() === '*** End of File' || nxt.startsWith('*** Move to: ')) {
          k += 1;
          continue;
        }
      }
      if (cur === null) cur = { anchor: null, body: [], eof: false };
      cur.body.push(line);
      k += 1;
      continue;
    }
    throw new Exit2(`error: parse ${idx + 1}`);
  }
  if (cur !== null) {
    trimTrailingBlank(cur.body);
    chunks.push(cur);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateIdx + 1}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const state = parseFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findTier(state.lines, [chunk.anchor], strict, cursor, false);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const { o, n } = buildItems(chunk.body);
      if (o.length === 0) {
        const ins = chunk.eof ? state.lines.length : cursor;
        state.lines.splice(ins, 0, ...n.map((it) => it.text));
        cursor = ins + n.length;
      } else {
        const found = findTier(state.lines, o.map((x) => x.text), strict, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.occ[0]!;
        state.lines = replaceLines(state.lines, pos, o, n, found.tier);
        cursor = pos + n.length;
      }
    }
    const text = serializeFile(state);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.registerMove(path, moveTo);
    } else {
      tree.now.set(path, text);
    }
  };
}

// ---------------------------------------------------------------------------
// Run (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      for (const m of beforeMoves) tree.moves.push(m);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: A/D/M by path, R (sorting by its new path) for a move that
  // succeeded with the old path gone and the new path appearing. Rows describe
  // the tree's net change (SPEC section 2: R when <old> existed before the patch
  // and does not after it, and <new> did not exist before it and does after it),
  // so a path moved twice in one patch (A->B, B->C) is one R A -> C, not D A + A C.
  // A cycle (A->B, B->A) resolves back to its start and keeps its original pair.
  const moveTarget = new Map(tree.moves);
  const collapsedMoves: [string, string][] = [];
  for (const [oldP, newP] of tree.moves) {
    const seen = new Set([oldP]);
    let end = newP;
    while (moveTarget.has(end) && !seen.has(end)) {
      seen.add(end);
      end = moveTarget.get(end)!;
    }
    collapsedMoves.push(end === oldP ? [oldP, newP] : [oldP, end]);
  }
  const handledOld = new Set<string>();
  const handledNew = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [oldP, newP] of collapsedMoves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      handledOld.add(oldP);
      handledNew.add(newP);
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  const sortedKeys = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of sortedKeys) {
    if (handledOld.has(p) || handledNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of sortedKeys) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outRows = rows.map((r) => r.line);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
