# Capability specs

The living truth of the system, one file per capability. Each is ≤2 pages:
what the entity is, where it is stored, who reads and writes it, and its
invariants. Distilled from the data dictionary and contract v2 (see the
"Archive docs corpus; distill six capability specs" issue).

The drift rule, enforced by the PR template: a PR that changes a capability's
behavior updates its spec **in the same PR**. A spec nobody updates is worse
than no spec — delete it before letting it lie.

These are not feature specs. Features live as GitHub issues using the
feature-spec template and die when the PR merges. These files persist.

| Spec | Covers |
|---|---|
| `job.md` | the job posting entity: sources, dedup, storage, consumers |
| `application.md` | application lifecycle; manual status is authoritative |
| `user-entitlement.md` | identity, activation states, default-deny ownership |
| `write-path.md` | RPC command pattern: idempotency, CAS, audit, no browser DML |
| `coverage.md` | company coverage model and sweep semantics |
| `resume.md` | resume storage and render pipeline as a product capability |
