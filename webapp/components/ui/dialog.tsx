"use client";

import { X } from "lucide-react";
import { Dialog as Primitive } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Modal dialog, on Radix.
 *
 * Hand-rolling this is the classic own-goal: a modal needs a focus trap, focus
 * restoration on close, `aria-modal` wiring, Escape handling, scroll locking,
 * and inert background content. Every one of those is invisible when it works
 * and is a keyboard user's dead end when it does not.
 *
 * Radix requires a Title — an untitled dialog announces as nothing to a screen
 * reader — so `title` is a required prop rather than an option.
 */

export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;

export function DialogContent({
  title,
  description,
  children,
  footer,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-40 bg-black/40" />
      <Primitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
          // Width is viewport-relative with a cap, and the panel scrolls
          // internally: a dialog taller than a phone is otherwise a form whose
          // submit button cannot be reached.
          "w-[calc(100vw-2rem)] max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto",
          "rounded-xl border border-border bg-surface p-4 shadow-xl outline-none sm:p-5",
          className,
        )}
      >
        <div className="mb-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Primitive.Title className="text-base font-semibold text-text">
              {title}
            </Primitive.Title>
            {description ? (
              <Primitive.Description className="mt-1 text-xs text-muted">
                {description}
              </Primitive.Description>
            ) : null}
          </div>
          <Primitive.Close
            aria-label="Close"
            className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-muted hover:bg-raised hover:text-text
                       focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <X aria-hidden="true" className="size-4" />
          </Primitive.Close>
        </div>

        {children}

        {footer ? <div className="mt-4 flex justify-end gap-2">{footer}</div> : null}
      </Primitive.Content>
    </Primitive.Portal>
  );
}
