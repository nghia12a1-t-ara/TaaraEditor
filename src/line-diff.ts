// Line diff (Myers' O(ND) algorithm) for the editor's git gutter.

export interface Hunk {
  /** 0-based start and length in the original (old) lines. */
  oldStart: number;
  oldLen: number;
  /** 0-based start and length in the modified (new) lines. */
  newStart: number;
  newLen: number;
}

/** Changed regions between `a` (old) and `b` (new). */
export function diffLines(a: string[], b: string[]): Hunk[] {
  // Common prefix / suffix make typical edits cheap.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  if (!A.length && !B.length) return [];
  if (!A.length || !B.length) return [{ oldStart: pre, oldLen: A.length, newStart: pre, newLen: B.length }];

  // Very large rewrites: one hunk is good enough for a gutter.
  if (A.length * B.length > 4e7) return [{ oldStart: pre, oldLen: A.length, newStart: pre, newLen: B.length }];

  const n = A.length;
  const m = B.length;
  const max = n + m;
  const off = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  // Backtrack to a list of matched (x, y) pairs, then turn gaps into hunks.
  const matches: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      matches.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    matches.push([x, y]);
  }
  matches.reverse();

  const hunks: Hunk[] = [];
  let ax = 0;
  let by = 0;
  for (const [mx, my] of [...matches, [n, m] as [number, number]]) {
    if (mx > ax || my > by) hunks.push({ oldStart: pre + ax, oldLen: mx - ax, newStart: pre + by, newLen: my - by });
    ax = mx + 1;
    by = my + 1;
  }
  return hunks;
}

export type GutterKind = "added" | "modified" | "deleted";

/** Gutter markers on the new lines (1-based line numbers). */
export function gutterMarks(oldText: string, newText: string): { line: number; endLine: number; kind: GutterKind }[] {
  const split = (t: string) => t.replace(/\r\n/g, "\n").split("\n");
  const out: { line: number; endLine: number; kind: GutterKind }[] = [];
  for (const h of diffLines(split(oldText), split(newText))) {
    if (h.newLen === 0) out.push({ line: Math.max(1, h.newStart), endLine: Math.max(1, h.newStart), kind: "deleted" });
    else if (h.oldLen === 0) out.push({ line: h.newStart + 1, endLine: h.newStart + h.newLen, kind: "added" });
    else out.push({ line: h.newStart + 1, endLine: h.newStart + h.newLen, kind: "modified" });
  }
  return out;
}
