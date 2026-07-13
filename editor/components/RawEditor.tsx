"use client";

// Full-text YAML editor (Design tab + Raw tab). Validation feedback comes
// from the parent (live parse on change); the string is committed byte-for-
// byte, so whatever is typed here is exactly what lands in the repo.

export default function RawEditor({
  path,
  text,
  onChange,
  error,
  note,
}: {
  path: string;
  text: string;
  onChange: (v: string) => void;
  error: string | null;
  note?: string | null;
}) {
  return (
    <div>
      {note ? <div className="banner warn">{note}</div> : null}
      <div className="raw-meta">
        <span>{path}</span>
        <span>{text.split("\n").length} lines</span>
      </div>
      <textarea
        className="raw"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="soft"
      />
      {error ? <div className="parse-error">{error}</div> : null}
    </div>
  );
}
