"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
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
  const router = useRouter();
  const [, startTransition] = useTransition();

  useEffect(() => {
    console.error("route error:", error);
  }, [error]);

  /**
   * `reset()` alone re-renders the segment from the router's CACHED payload —
   * it never refetches the server data that threw. So the first time this
   * boundary was driven by a test (the `hq_demo_fail_read` seam,
   * `tests/e2e/error.spec.ts`), Try again could not recover from a failure the
   * server had already stopped having: the button re-showed the same error
   * forever, on desktop and mobile both. The measured fix is Next's own
   * recipe — refresh the server data and reset the boundary in one
   * transition, so the re-render sees the refetched payload rather than the
   * cached rejection.
   */
  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });

  return (
    <div className="mx-auto max-w-md px-6 py-16 text-center">
      <h2 className="text-lg font-semibold">This page didn't load</h2>
      <p className="mt-1.5 text-sm text-muted">
        Something went wrong on our side, not yours. Nothing you've saved is affected.
      </p>
      {error.digest ? (
        <p className="mt-2 font-mono text-2xs text-muted">Reference: {error.digest}</p>
      ) : null}
      <div className="mt-5 flex justify-center gap-2">
        <Button variant="primary" onClick={retry}>
          Try again
        </Button>
        <Button variant="secondary" onClick={() => (window.location.href = "/queue")}>
          Go to Today
        </Button>
      </div>
    </div>
  );
}
