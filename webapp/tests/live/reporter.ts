/**
 * THE BANNER THAT STOPS A FIXTURE RUN READING AS FULL COVERAGE.
 *
 * `tests/conftest.py` is the precedent and it is the only mechanism in this repo
 * that has demonstrably stopped a silent skip from being reported as a pass:
 * `tests/db` self-skipped without `DATABASE_URL` and pytest exited 0, so 588
 * cases covering RLS and entitlement went unrun inside a green "full gate".
 *
 * The live lane has exactly that shape and a worse consequence, because it is
 * the ONLY thing that can prove the `live` mode of the coverage ledger. So every
 * Playwright run that was not the live lane ends by saying, in the summary a
 * person actually reads, that the live mode was not covered.
 *
 * It does not fail the run. A laptop without the test project's credentials must
 * still be able to run the fixture suite — the same trade `conftest.py` makes,
 * for the same reason. `HQ_LIVE_E2E=1` is the spelling that turns absence into
 * an error, and `env.ts` owns that half.
 */
import type { Reporter, FullConfig, FullResult } from "@playwright/test/reporter";
import { liveLaneAbsentNotice, ENV_NAMES } from "./env";

export default class LiveLaneNoticeReporter implements Reporter {
  private ranLive = false;

  onBegin(config: FullConfig): void {
    this.ranLive = config.projects.some((p) => p.name.startsWith("live-"));
  }

  onEnd(_result: FullResult): void {
    if (this.ranLive) return;
    const missing = [ENV_NAMES.url, ENV_NAMES.anonKey, ENV_NAMES.serviceKey, ENV_NAMES.password]
      .filter((name) => !process.env[name]);
    // Even with every credential present, a run without a live project did not
    // cover the live mode — the notice is about what RAN, not about what could
    // have. `missing` is reported when it explains why.
    process.stderr.write(
      `\n${liveLaneAbsentNotice(missing.length > 0 ? missing : [`${ENV_NAMES.enable} (not requested)`])}\n`,
    );
  }
}
