"use client";

// A real line-level diff via LCS: unchanged lines show as context, only changed
// lines are marked - (removed) / + (added). For write_file (no oldText) every
// line is an addition. No external diff library.

type Row = { type: "context" | "removed" | "added"; text: string };

function diffLines(oldText: string, newText: string): Row[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const m = a.length;
  const n = b.length;

  // Guard against pathological O(m*n) memory on huge inputs.
  if (m * n > 400_000) {
    return [
      ...a.map((t) => ({ type: "removed" as const, text: t })),
      ...b.map((t) => ({ type: "added" as const, text: t })),
    ];
  }

  // LCS table.
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ type: "context", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "removed", text: a[i] });
      i++;
    } else {
      rows.push({ type: "added", text: b[j] });
      j++;
    }
  }
  while (i < m) rows.push({ type: "removed", text: a[i++] });
  while (j < n) rows.push({ type: "added", text: b[j++] });
  return rows;
}

const SIGN = { context: " ", removed: "-", added: "+" } as const;

export function DiffView({
  oldText,
  newText,
}: {
  oldText?: string;
  newText?: string;
}) {
  let rows: Row[];
  if (oldText !== undefined && newText !== undefined) {
    rows = diffLines(oldText, newText);
  } else if (newText !== undefined) {
    rows = newText.split("\n").map((text) => ({ type: "added", text }));
  } else {
    rows = (oldText ?? "").split("\n").map((text) => ({ type: "removed", text }));
  }

  return (
    <div className="diff">
      {rows.map((r, i) => (
        <div key={i} className={`diff-line ${r.type}`}>
          <span className="sign">{SIGN[r.type]}</span>
          <span className="code">{r.text || " "}</span>
        </div>
      ))}
    </div>
  );
}
