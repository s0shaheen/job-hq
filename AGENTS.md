# Job HQ agent instructions

This repository has one constitution and it is **[CLAUDE.md](CLAUDE.md)**. Read it before
you touch anything. Product authority, the negative invariants, the merge and deploy
rules, the review tiers, and the verification lanes all live there, and they bind every
harness regardless of which vendor's filename brought you to this file.

This file holds no rules of its own, deliberately. Until 2026-08-14 it was a
byte-identical copy of CLAUDE.md as of 2026-08-02, and it went stale the moment CLAUDE.md
changed: for weeks after `main` became a protected branch it still taught the
pre-protection merge rule, which named `scripts/land.sh` as the one way onto `main`
because GitHub was not yet refusing red merges itself. Agents read this file and followed
it. A second copy is the drift generator, not the drift. If a rule belongs to agents, it
belongs in CLAUDE.md, where there is exactly one place to change it.

Start here:

1. `CLAUDE.md` — the constitution.
2. `product.md` — one page on what this product is.
3. `gh issue list` — the roadmap. Live state beats any plan document.
