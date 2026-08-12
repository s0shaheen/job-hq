---
name: Feature spec
about: The working unit. An agent implements exactly this, nothing more.
labels: spec-needed
---

## What

One paragraph. The user-visible behavior when done.

## Out of scope

Explicit. This is what keeps an implementing agent from wandering.

## Acceptance criteria

<!-- 3–8, each independently testable -->
- WHEN <situation> THE SYSTEM SHALL <behavior>

## Attack list

<!-- Written BEFORE implementation. What the reviewer will try to break. -->

## Files

The exact files to touch. A PR touching unlisted files is rejected unread.

## Verify

The exact command that must pass (change-scoped verify.sh lane, or named specs).

## Tier

T0–T4. Determines who implements (agent-ready vs mine) and who reviews.
