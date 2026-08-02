"use client";

import { Download } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { JobView } from "@/lib/data/view-models";
import type { Column } from "@/lib/export/columns";
import { toCsv } from "@/lib/export/delimited";
import { exportFilename, type ExportScope } from "@/lib/export/scope";

/**
 * The grid's Export menu (plan §5, criterion H22). Three scope lines, each
 * stating the exact row count it will produce — the same trust rule the export
 * dialog enforces: "silently exporting only the filtered subset is a top-tier
 * trust bug", and its inverse (exporting MORE than the screen shows) is the
 * same bug pointed the other way. The counts here cannot drift from the file
 * because both are derived from the same arrays in the same render: the scope
 * model is the dialog's (`ExportScope` from lib/export/scope), the payload
 * builder is the export core's `toCsv`, and the column set is the view's
 * visible columns — hidden ones are excluded, and the menu says so.
 *
 * Built client-side, deliberately: these are rows the grid already holds (the
 * server sent them to paint the screen), filtered and sorted by the pure
 * modules the row counts came from. Only the server-rendered surfaces
 * (queue/pipeline dialog) need the server to resolve a scope; here a round
 * trip could only introduce a second answer to "which rows", which is the
 * disagreement this menu exists to rule out.
 */

export type ExportMenuProps = {
  /** The current view: filtered + sorted leaves, in display order. */
  viewRows: JobView[];
  /** The selection, already pruned to visible rows, in display order. */
  selectionRows: JobView[];
  /** Everything the server handed the grid — the escape-hatch scope. */
  allRows: JobView[];
  /** Visible columns in view order, mapped through JOB_COLUMNS (+ URL). */
  columns: Column<JobView>[];
  /** Distinct per mount: the toolbar and the selection bar both carry one. */
  testid: string;
};

function download(rows: JobView[], columns: Column<JobView>[]): void {
  const name = exportFilename("jobs", "csv", new Date().toISOString().slice(0, 10));
  const blob = new Blob([toCsv(rows, columns)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  // The dialog's own copy shape: report what the file contains.
  toast.success(`Exported ${rows.length} ${rows.length === 1 ? "row" : "rows"}, ${name}`);
}

const itemClass =
  "relative flex h-7 min-w-0 cursor-default select-none items-center gap-2 rounded-md px-2 " +
  "text-xs text-text outline-none data-[highlighted]:bg-raised " +
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

export default function ExportMenu(props: ExportMenuProps) {
  const scopes: { scope: ExportScope; label: string; rows: JobView[]; disabled?: boolean }[] = [
    { scope: "view", label: `Current view (${props.viewRows.length} rows)`, rows: props.viewRows },
    {
      scope: "selection",
      label: `Selection (${props.selectionRows.length})`,
      rows: props.selectionRows,
      // A selection of nothing is never what someone meant (lib/export/scope's
      // rule): a header-only file would read as "you have no data", a lie.
      disabled: props.selectionRows.length === 0,
    },
    { scope: "all", label: `All (${props.allRows.length} rows)`, rows: props.allRows },
  ];

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" variant="secondary" data-testid={props.testid}>
          <Download aria-hidden="true" className="size-3.5" />
          Export
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-40 w-64 max-w-[calc(100vw-16px)] rounded-lg border border-border bg-surface
                     p-1 shadow-xl outline-none"
        >
          {scopes.map((s) => (
            <DropdownMenu.Item
              key={s.scope}
              data-testid={`${props.testid}-${s.scope}`}
              disabled={s.disabled}
              className={itemClass}
              onSelect={() => download(s.rows, props.columns)}
            >
              {s.label}
            </DropdownMenu.Item>
          ))}
          {/* The column contract, stated where the choice is made — not in a
              tooltip nobody opens. */}
          <p
            data-testid={`${props.testid}-note`}
            className="px-2 pb-1 pt-1.5 text-2xs text-muted"
          >
            CSV of this view's columns plus the posting URL. Hidden columns are excluded.
          </p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
