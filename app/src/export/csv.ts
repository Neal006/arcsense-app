/** RFC 4180 CSV writer (CRLF line endings, quotes only where needed). */
export type Cell = string | number | boolean | null | undefined;

export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    return String(v);
  }
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(header: readonly string[], rows: readonly (readonly Cell[])[]): string {
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    if (r.length !== header.length) {
      throw new Error(`CSV row has ${r.length} cells, header has ${header.length}`);
    }
    lines.push(r.map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
