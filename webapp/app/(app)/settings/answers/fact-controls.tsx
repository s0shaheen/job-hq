"use client";

import * as React from "react";
import { ChipList, MoneyField, NumberField, PolicyChoice } from "../fields";
import { RECOGNISED_COUNTRIES } from "@/lib/apply/policy";
import type { TopicField } from "@/lib/apply/topics";
import type { SituationFact } from "@/lib/apply/types";

/**
 * One control per kind of situation, and the draft/commit boundary around it.
 *
 * Two commit models, chosen per control rather than uniformly:
 *
 *   A radio commits IMMEDIATELY. One click is one decision, and a Yes that needs
 *   a second click to count is how somebody leaves a rule half-set.
 *
 *   Everything you type — a number, an address, a country list, a date — commits
 *   on an explicit Save that appears only once the draft differs from what is
 *   stored. `MoneyField` fires on every keystroke that parses, and a write per
 *   keystroke against a version token means every keystroke after the first
 *   conflicts with the one before it.
 *
 * Everything here is a native control or one of `../fields`' — the same hard
 * constraint the profile form is written to. No hand-rolled dropdown, no
 * hand-rolled focus trap.
 */

export type FactDraft = SituationFact | null;

/** Does this control commit on change, or on an explicit Save? */
export function commitsImmediately(field: TopicField): boolean {
  return field === "boolean" || field === "history";
}

export function sameFact(a: FactDraft, b: FactDraft): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function FactControl({
  idPrefix,
  field,
  draft,
  disabled,
  onChange,
}: {
  idPrefix: string;
  field: TopicField;
  draft: FactDraft;
  disabled: boolean;
  onChange: (next: FactDraft) => void;
}) {
  switch (field) {
    case "boolean": {
      const value = draft?.kind === "boolean" ? (draft.value ? "yes" : "no") : "";
      return (
        <div data-testid={`${idPrefix}-boolean`}>
          <PolicyChoice
            name={idPrefix}
            legend="Your answer"
            value={value}
            onChange={(next) => onChange({ kind: "boolean", value: next === "yes" })}
            options={[
              { value: "yes", label: "Yes", body: "" },
              { value: "no", label: "No", body: "" },
            ]}
          />
        </div>
      );
    }

    case "history": {
      const value = draft?.kind === "enum" ? draft.value : "";
      return (
        <div data-testid={`${idPrefix}-history`}>
          <PolicyChoice
            name={idPrefix}
            legend="Your answer"
            value={value}
            onChange={(next) => onChange({ kind: "enum", value: next })}
            options={[
              {
                value: "none",
                label: "Nothing to disclose",
                body: "A question asking whether you have one is answered No.",
              },
              {
                value: "has",
                label: "There is something to disclose",
                body: "Answered Yes, and the detail stays yours to write on the board.",
              },
            ]}
          />
        </div>
      );
    }

    case "money":
      return (
        <MoneyField
          id={`${idPrefix}-money`}
          label="The number you put"
          dollars={draft?.kind === "money" ? draft.value : 0}
          hint="Stored as dollars and submitted as a plain number, the way a board's box expects it."
          // An empty box parses as 0, and a pay expectation of nothing is not a
          // pay expectation — `parseSituationFact` refuses it, so emitting it as a
          // draft would enable a Save the door then rejects. `null` is "not set",
          // which is what an empty box means.
          onChange={(next) =>
            onChange(next > 0 ? { kind: "money", value: next, currency: "USD" } : null)
          }
        />
      );

    case "text":
      return (
        <div>
          <label
            htmlFor={`${idPrefix}-text`}
            className="block text-xs font-medium text-text-2"
          >
            Your answer
          </label>
          <input
            id={`${idPrefix}-text`}
            data-testid={`${idPrefix}-text`}
            type="text"
            disabled={disabled}
            maxLength={200}
            value={draft?.kind === "text" ? draft.value : ""}
            onChange={(e) => onChange({ kind: "text", value: e.target.value })}
            className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          />
        </div>
      );

    case "countries":
      return (
        <div>
          <ChipList
            id={`${idPrefix}-countries`}
            label="Countries"
            values={draft?.kind === "countries" ? draft.value : []}
            placeholder="united states"
            // The names the question reader knows, offered rather than enforced.
            // A country outside this list can still be stored and can still match
            // — a posting that states its own country resolves against that — but
            // a question naming a country nobody can recognise is left for you.
            suggestions={RECOGNISED_COUNTRIES}
            onChange={(next) =>
              onChange(next.length === 0 ? null : { kind: "countries", value: next })
            }
          />
          <p className="mt-1 text-xs text-muted">
            Lower case, and spelled the way the list below spells them. A name we do not
            recognise is stored and only matches a posting that states the same country.
          </p>
        </div>
      );

    case "start-date": {
      const weeks = /^monday-weeks-out:(\d+)$/.exec(
        draft?.kind === "directive" ? draft.value : "",
      );
      const mode = draft?.kind === "date" ? "fixed" : "computed";
      return (
        <div className="space-y-2" data-testid={`${idPrefix}-start-date`}>
          <PolicyChoice
            name={`${idPrefix}-mode`}
            legend="How to answer it"
            value={mode}
            onChange={(next) =>
              onChange(
                next === "fixed"
                  ? { kind: "date", value: new Date().toISOString().slice(0, 10) }
                  : { kind: "directive", value: "monday-weeks-out:3" },
              )
            }
            options={[
              {
                value: "computed",
                label: "The first Monday a few weeks out",
                body: "Worked out when the application is prepared, so it never goes stale.",
              },
              {
                value: "fixed",
                label: "A date",
                body: "The same day every time, until you change it.",
              },
            ]}
          />
          {mode === "computed" ? (
            <NumberField
              id={`${idPrefix}-weeks`}
              label="Weeks out"
              value={weeks ? Number(weeks[1]) : 3}
              min={0}
              max={52}
              suffix="weeks, then the next Monday"
              onChange={(n) => onChange({ kind: "directive", value: `monday-weeks-out:${n}` })}
            />
          ) : (
            <div>
              <label htmlFor={`${idPrefix}-date`} className="block text-xs font-medium text-text-2">
                Date
              </label>
              <input
                id={`${idPrefix}-date`}
                data-testid={`${idPrefix}-date`}
                type="date"
                disabled={disabled}
                value={draft?.kind === "date" ? draft.value : ""}
                onChange={(e) => onChange({ kind: "date", value: e.target.value })}
                className="mt-1 rounded-md border border-border-strong bg-surface px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              />
            </div>
          )}
        </div>
      );
    }

    default:
      return null;
  }
}
