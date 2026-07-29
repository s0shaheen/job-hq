# Packet family 05 — Resume product

## Outcome

Every activated user can safely create/import, edit, version, render, select, export,
and delete their own resume and application attachments. No owner-specific content ships.

## Atomic packets

### PKT-05A Private-vault boundary

Inventory and move Salman-specific resume, application, interview-prep, snapshots, and
private source conversations under the approved private-vault plan. Replace product/demo
defaults with synthetic generic fixtures. Audit Git history and deployment artifacts.

### PKT-05B Resume domain

Define tenant-owned resume, source version, render job, artifact, attachment selection,
checksum, and deletion states. Direct browser DML is denied. Immutable artifacts point
to immutable source versions.

### PKT-05C Secure storage

Use non-guessable owner-scoped object keys, signed short-lived access, MIME/signature
validation, size/page limits, malware policy, checksum, retention, export, and deletion.
Two users cannot infer existence or fetch objects.

### PKT-05D Editor/import

Build the design-defined editor with generic user data and supported RenderCV
flexibility. Preserve unsupported imported content honestly; never silently rewrite
claims. Draft/version/conflict/reload behavior is explicit.

### PKT-05E Render service

Sandbox rendering with pinned dependencies, CPU/memory/time/network limits, deterministic
failure states, artifact checksum, preview, and phone/desktop access. No arbitrary file
or network access.

### PKT-05F Application attachment

Autopilot review shows exact resume/artifact version. Before submit, revalidate ownership,
checksum, availability, provider file rules, and size. Stale/deleted/corrupt/wrong-owner
attachments stop safely.

## Evidence

Real storage tests, parser/render adversarial corpus, wrong-owner negatives, concurrent
version/render tests, timeout recovery, restore/delete behavior, visual artifact
inspection, and no private-content scan.
