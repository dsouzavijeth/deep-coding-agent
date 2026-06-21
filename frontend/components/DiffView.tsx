"use client";

// Minimal stacked diff: removed lines (red) then added lines (green).
// For edit_file we get old_string/new_string snippets; for write_file just the
// new content. No external diff library to keep dependencies light.

export function DiffView({
  oldText,
  newText,
}: {
  oldText?: string;
  newText?: string;
}) {
  const renderBlock = (text: string, kind: "removed" | "added") =>
    text.split("\n").map((line, i) => (
      <div key={`${kind}-${i}`} className={`diff-line ${kind}`}>
        <span className="sign">{kind === "removed" ? "-" : "+"}</span>
        <span className="code">{line || " "}</span>
      </div>
    ));

  return (
    <div className="diff">
      {oldText !== undefined && renderBlock(oldText, "removed")}
      {newText !== undefined && renderBlock(newText, "added")}
    </div>
  );
}
