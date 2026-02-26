export interface Axial {
  q: number;
  r: number;
}

const DIRECTIONS: Axial[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function axialToCube(a: Axial): { q: number; r: number; s: number } {
  return { q: a.q, r: a.r, s: -a.q - a.r };
}

export function cubeToAxial(c: { q: number; r: number; s: number }): Axial {
  return { q: c.q, r: c.r };
}

export function axialDistance(a: Axial, b: Axial): number {
  const ca = axialToCube(a);
  const cb = axialToCube(b);
  return (Math.abs(ca.q - cb.q) + Math.abs(ca.r - cb.r) + Math.abs(ca.s - cb.s)) / 2;
}

export function axialNeighbors(a: Axial): Axial[] {
  return DIRECTIONS.map((d) => ({ q: a.q + d.q, r: a.r + d.r }));
}

export function axialEquals(a: Axial, b: Axial): boolean {
  return a.q === b.q && a.r === b.r;
}

export function axialKey(a: Axial): string {
  return `${a.q},${a.r}`;
}
