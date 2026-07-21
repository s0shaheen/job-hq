"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary.
 *
 * Without this, one thrown component is a WHITE SCREEN — the single worst
 * frontend failure, because the user cannot tell a crash from a slow network
 * and has nowhere to go. Every route keeps its shell, states what failed in
 * plain language, and offers the two actions that ever help: try again, or
 * leave.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("route error:", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-md px-6 py-16 text-center">
      <h2 className="text-lg font-semibold">This page didn&rsquo;t load</h2>
      <p className="mt-1.5 text-sm text-muted">
        Something went wrong on our side, not yours. Nothing you&rsquo;ve saved is affected.
      </p>
      {error.digest ? (
        <p className="mt-2 font-mono text-2xs text-muted">Reference: {error.digest}</p>
      ) : null}
      <div className="mt-5 flex justify-center gap-2">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <Button variant="secondary" onClick={() => (window.location.href = "/queue")}>
          Back to triage
        </Button>
      </div>
    </div>
  );
}
