# Greenhouse `?questions=true` payloads — recorded, not written

Three real boards, fetched once from a residential Mac IP on **2026-07-27**, GET only:

| File | URL | Why this one |
|---|---|---|
| `coinbase-7822885.json` | `https://boards-api.greenhouse.io/v1/boards/coinbase/jobs/7822885?questions=true` | 19 questions; work authorization AND sponsorship AND prior employment on one form, plus the two conflict-of-interest questions (`close relative of a government official`, `referred … by a senior leader … vendor`) that a naive keyword classifier answers wrongly. Also carries `location_questions` and a U+2011 non-breaking hyphen mid-word. |
| `anthropic-5101378008.json` | `https://boards-api.greenhouse.io/v1/boards/anthropic/jobs/5101378008?questions=true` | 19 questions; asks visa sponsorship **twice in two different sentences** — the case topic classification exists for. Also relocation, start date, an onsite-percentage commitment, an address free-text, and two free-response textareas. |
| `discord-8485797002.json` | `https://boards-api.greenhouse.io/v1/boards/discord/jobs/8485797002?questions=true` | 14 questions; the only one of the three with a populated `demographic_questions` block (EEO self-identification, with `decline_to_answer` options). Also the near-miss pair "authorized to work in the United States" vs "currently located in the US". |

## The one edit

`content` — the job description, 10–40 kB of escaped HTML per file — is replaced with
`"<stripped: job description HTML, not read by the parser>"`. The key is kept rather than
deleted so the payload stays truthful about what the API returns. Everything else, including
key order, is verbatim after `json.dumps(json.loads(raw), indent=2)`; the reformat is for
review, and it is lossless for anything the parser reads.

## The rule

**No test fetches.** These files are the ATS. A live GET inside a test suite makes CI depend
on three companies' hiring calendars — the postings will close, and a suite that goes red
because Coinbase filled a role is a suite people learn to ignore. Refreshing them is a
deliberate act: re-run the three URLs, re-run `webapp/tests/unit/apply-greenhouse.test.ts`,
and read what changed. A shape change here is real news about the ATS, which is exactly what
it should take a human to look at.

Fetch-side grounding and the tier math: `docs/research/ats-apply-mechanics.md`.
