import { Suspense } from "react";
import Link from "next/link";
import { getDataSource } from "@/lib/data/get-source";
import { AnswersSkeleton } from "./answers-skeleton";
import { AnswersSurface } from "./answers-surface";

export const metadata = { title: "Application answers" };
export const dynamic = "force-dynamic";

/**
 * /settings/answers — the answer library and the rules behind it.
 *
 * A sub-route rather than another block on `/settings`, for one reason worth
 * stating: `/settings`'s section ids are a CONTRACT (`reasonSetting()` outputs,
 * linked to from the queue's why-popover, with `routing.spec.ts` deriving its
 * list from that function). Sixteen more sections in that namespace would be
 * sixteen ids nothing links to, sitting among ids everything links to.
 *
 * The two reads are the ones `lib/apply/index.ts` specifies, and they are the
 * same two the prepare engine takes — one place to look at what an application
 * would be answered with, and one place to change it.
 */
export default function AnswersPage() {
  return (
    <div className="min-w-0">
      <header className="border-b border-border px-4 py-3 sm:px-6">
        <h1 className="text-lg font-semibold">Application answers</h1>
        <p className="text-xs text-muted">
          What an application form can be filled in with, and what only you can answer. A
          question nothing here answers is left blank and shown to you, never guessed.
        </p>
        <p className="mt-1 text-xs text-muted">
          <Link href="/settings" className="underline">
            Search profile
          </Link>{" "}
          is the other half: that one decides which jobs reach you, this one decides what
          this app can say on your behalf once you apply.
        </p>
      </header>

      {/* The header above stays outside the boundary — it says where you are
          and its Search profile link still works while the read is slow, which
          is the same division of labour as the rail on the five shell
          sections. A route-level `loading.tsx` would blank it. */}
      <Suspense fallback={<AnswersSkeleton />}>
        <AnswersSection />
      </Suspense>
    </div>
  );
}

async function AnswersSection() {
  const src = await getDataSource();
  const [answers, rules] = await Promise.all([src.answers(), src.policyRules()]);

  return <AnswersSurface answers={answers} rules={rules} />;
}
