"use client";

// Auto-growing textarea via the hidden-replica grid trick — pure CSS, no
// resize listeners, no layout jump when lines wrap. 16px font (iOS no-zoom).

export default function GrowTextarea({
  value,
  onChange,
  autoFocus,
  placeholder,
  wrapClassName,
}: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
  wrapClassName?: string;
}) {
  return (
    <div className={wrapClassName ? `grow-wrap ${wrapClassName}` : "grow-wrap"} data-replica={value}>
      <textarea
        rows={1}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        autoCapitalize="sentences"
        spellCheck
      />
    </div>
  );
}
