/**
 * A faithful port of CPython's `difflib.SequenceMatcher(None, a, b).ratio()`
 * - the Ratcliff/Obershelp matching-blocks algorithm - rather than an npm
 * dependency. Both `difflib` (npm, last published 2012) and
 * `@ewoudenberg/difflib` (2022, no bundled types, extra `heap` dependency)
 * are unhealthy, and heuristics.ts's fuzzy product-name matching is pinned
 * to an exact 0.92 threshold by the existing test suite - an unverified
 * third-party implementation is a real behavioral risk there.
 *
 * Scope: this intentionally does NOT implement `isjunk` or the `autojunk`
 * heuristic (which only self-triggers for sequences of length >= 200 in
 * CPython) - heuristics.ts always calls this with `isjunk=None` on short,
 * normalized product-name strings, so neither ever applies in practice.
 */

function buildB2j(b: string): Map<string, number[]> {
  const b2j = new Map<string, number[]>();
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    const indices = b2j.get(c);
    if (indices) {
      indices.push(i);
    } else {
      b2j.set(c, [i]);
    }
  }
  return b2j;
}

/** Longest matching block within a[alo:ahi] and b[blo:bhi]. Returns [i, j, size]. */
function findLongestMatch(
  a: string,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
  b2j: Map<string, number[]>,
): [number, number, number] {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map<number, number>();

  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map<number, number>();
    const indices = b2j.get(a[i]) ?? [];
    for (const j of indices) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newj2len.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = newj2len;
  }

  return [besti, bestj, bestsize];
}

function getMatchingBlocks(a: string, b: string): Array<[number, number, number]> {
  const b2j = buildB2j(b);
  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  const blocks: Array<[number, number, number]> = [];

  while (queue.length > 0) {
    const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
    const [i, j, k] = findLongestMatch(a, alo, ahi, blo, bhi, b2j);
    if (k > 0) {
      blocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }

  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return blocks;
}

/** Equivalent to Python's `difflib.SequenceMatcher(None, a, b).ratio()`. */
export function ratio(a: string, b: string): number {
  const blocks = getMatchingBlocks(a, b);
  const matches = blocks.reduce((sum, [, , size]) => sum + size, 0);
  const total = a.length + b.length;
  return total === 0 ? 1.0 : (2.0 * matches) / total;
}
