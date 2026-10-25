export function color(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}
