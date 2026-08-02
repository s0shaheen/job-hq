"use client";

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { buttonClass, type ButtonVariant } from "./button-class";

import { Kbd } from "./kbd";

export type { ButtonVariant };

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  variant?: ButtonVariant;
  disabled?: boolean;
  /** Renders a trailing key hint, e.g. "i". The shortcut itself is the caller's. */
  keyHint?: string;
  children: ReactNode;
  type?: "button" | "submit" | "reset";
  className?: string;
  ref?: Ref<HTMLButtonElement>;
};

/**
 * One button, three intents, one size.
 *
 * No `size` prop and no `danger` variant. Both were pared away deliberately:
 * a second size is how two buttons standing side by side end up a pixel out of
 * line, and a red button invites colour to carry the warning instead of the
 * verb. A destructive action says what it destroys, in a dialog.
 *
 * `type` defaults to "button" because the browser's default is "submit", and a
 * button inside a form that quietly submits it is a bug nobody sees until a
 * page reloads under them.
 *
 * The look lives in `button-class.ts` rather than here so a `Link` can wear it
 * from a server component; see that file for why it cannot live in this one.
 *
 * **The remaining props pass through, and that is load-bearing rather than
 * convenience.** A closed prop list looked tidier until this button became a
 * `Popover.Trigger asChild`: radix composes a trigger by CLONING its child with
 * `aria-expanded`, `aria-controls` and `data-state`, and a component that
 * accepts only the props it names drops all three on the floor. The result is a
 * popover trigger that never announces whether it is open — an axe failure on a
 * control this surface has two of.
 */
export function Button({
  variant = "secondary",
  disabled = false,
  keyHint,
  children,
  type = "button",
  className,
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled}
      className={buttonClass({ variant, disabled, className })}
    >
      {children}
      {keyHint ? <Kbd>{keyHint}</Kbd> : null}
    </button>
  );
}
