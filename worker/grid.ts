import type { Axial } from './hex';
import type { Cell } from './types';

/** Number of hexes in a hex-shaped region of radius r (inclusive). */
function hexRegionCount(r: number): number {
  return 1 + 3 * r * (r + 1);
}

/** All axial coords in a hex region of given radius (center 0,0). */
function hexRegion(radius: number): Axial[] {
  const out: Axial[] = [];
  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r++) {
      out.push({ q, r });
    }
  }
  return out;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Generate a full hex-shaped grid with at least minCells non-blocked cells.
 * We pick the smallest radius that can hold (minCells + blockedCount), then
 * keep the entire hex region so the board is always a complete hex shape.
 * Each cell: diceValue 1-6, producer 1-9, seller 1-9.
 */
export function generateGrid(
  minCells: number,
  blockedCount: number
): Cell[] {
  const totalNeeded = minCells + blockedCount;
  let radius = 1;
  while (hexRegionCount(radius) < totalNeeded) radius++;
  const coords = hexRegion(radius);
  const totalCells = coords.length;
  const effectiveBlockedCount = Math.min(blockedCount, Math.max(0, totalCells - 1));

  const shuffledIndices = shuffle(Array.from({ length: totalCells }, (_, i) => i));
  const blockedSet = new Set<number>();
  for (const idx of shuffledIndices.slice(0, effectiveBlockedCount)) blockedSet.add(idx);
  const playableIndices = Array.from({ length: totalCells }, (_, i) => i).filter((i) => !blockedSet.has(i));
  const diceValues = Array.from({ length: totalCells }, () => randomInt(1, 6));
  if (playableIndices.length >= 6) {
    const shuffledPlayable = shuffle(playableIndices);
    for (let face = 1; face <= 6; face += 1) {
      diceValues[shuffledPlayable[face - 1]] = face;
    }
  }

  return coords.map((axial, i) => ({
    id: `cell-${axial.q}-${axial.r}`,
    q: axial.q,
    r: axial.r,
    diceValue: diceValues[i],
    producer: randomInt(1, 9),
    seller: randomInt(1, 9),
    blocked: blockedSet.has(i),
    owners: [],
  }));
}
