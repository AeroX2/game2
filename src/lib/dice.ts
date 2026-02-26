export function diceFace(value: number): string {
  switch (value) {
    case 1: return '⚀';
    case 2: return '⚁';
    case 3: return '⚂';
    case 4: return '⚃';
    case 5: return '⚄';
    case 6: return '⚅';
    default: return `${value}`;
  }
}

export function diceFaces(values: number[]): string {
  if (!values?.length) return '—';
  return values.map(diceFace).join(' ');
}
