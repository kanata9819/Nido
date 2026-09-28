export interface DiffLine {
  number: number;
  text: string;
  changed?: boolean;
}

export interface DiffRow {
  before?: DiffLine;
  after?: DiffLine;
  heading?: string;
}

export function splitDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let before = 0;
  let after = 0;
  let inHunk = false;
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = (): void => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      rows.push({ before: removed[i], after: added[i] });
    }
    removed = [];
    added = [];
  };

  for (const line of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flush();
      before = Number(hunk[1]);
      after = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (inHunk && line.startsWith('-')) {
      removed.push({ number: before++, text: line.slice(1), changed: true });
    } else if (inHunk && line.startsWith('+')) {
      added.push({ number: after++, text: line.slice(1), changed: true });
    } else if (inHunk && line.startsWith(' ')) {
      flush();
      rows.push({ before: { number: before++, text: line.slice(1) }, after: { number: after++, text: line.slice(1) } });
    } else if (line.startsWith('\\')) {
      // Git's missing-newline marker is metadata, not a source line.
      continue;
    } else {
      flush();
      inHunk = false;
      if (line && !/^(diff --git |index |--- |\+\+\+ )/.test(line)) {
        rows.push({ heading: line });
      }
    }
  }
  flush();
  return rows;
}
