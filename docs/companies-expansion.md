# Companies expansion — registry growth round (2026-07-13)

`monitor/companies.expansion.csv` grows the curated company registry beyond
`companies.seed.csv` (135 companies) and `companies.bigtech.csv` (16): every row
is a company resolved to a working `(ats, slug)` pair that the corresponding
`monitor/fetchers/` adapter can fetch **today** — each probe mirrors the
fetcher's own endpoint, so a row that resolves is a row that monitors.

## Result

- **497 rows** total in `companies.expansion.csv`
  (90 passed through from `candidates_resolved.csv` +
  **407 newly resolved** by `monitor/scripts/expand_companies.py`).
- Zero overlap with `companies.seed.csv`, `companies.bigtech.csv`, or the
  big-tech dedupe list (validated).
- `priority=TRUE` on 11: Bill.com, Capital One, Chainalysis, Circle, Column, Highnote, Melio, Palantir, Paxos, TRM Labs, xAI.

### Rows by ATS family

| ats | rows |
|---|---|
| greenhouse | 214 |
| ashby | 142 |
| workday | 85 |
| lever | 35 |
| smartrec | 12 |
| radancy | 5 |
| oraclehcm | 2 |
| eightfold | 2 |

### Rows by category tag (`notes` column)

| category | rows |
|---|---|
| fintech-infra | 54 |
| consumer-marketplace | 53 |
| enterprise-saas | 53 |
| healthtech | 37 |
| dev-tools | 35 |
| data-infra | 33 |
| bank | 25 |
| ai-infra | 24 |
| fintech | 24 |
| security | 24 |
| fintech-crypto | 22 |
| insurance | 21 |
| ai-labs | 18 |
| f500-tech | 15 |
| ai | 12 |
| climate-frontier | 12 |
| pharma | 11 |
| ai-apps | 10 |
| defense | 6 |
| infra | 5 |
| observability | 3 |

## Sources

1. **candidates_resolved.csv** — 90 pre-verified rows, passed through unchanged
   (category tags joined from `candidate_companies.csv`).
2. **candidates_unresolved.csv** — 41 names re-probed with better slug guesses;
   most resolved or were explained (see the two tables below).
3. **The legacy workbook** *"Jobs Applied -Salman - Sample.xlsx"* (tabs
   `US Banks`, `Largest US Co`, `Chi-100`, `Ins Co (L&H)`, `Pharmac`) — mined
   for employer names and, critically, careers URLs: the Workday hints for the
   bank/insurer/pharma rows come from that sheet's `Career site` column.
   Only employers plausibly hiring product managers at scale were kept
   (large banks yes; meat packers, tiny credit unions, and pure-R&D pharma no).
4. **Curated additions** — AI labs/infra, fintech + payments infrastructure,
   banking-as-a-service, market infrastructure (CME, Nasdaq, Cboe, ICE, DTCC,
   Broadridge), credit bureaus, platform SaaS, dev tools/security/data infra,
   marketplaces, F500 tech, and a Chicago cluster (Enova, Sprout Social, G2,
   Morningstar, Amount, TransUnion) — Salman is a platform/fintech-infra PM,
   0–4 YoE, US.

## How resolution works (`monitor/scripts/expand_companies.py`)

- `resolve` probes each name against greenhouse, ashby, lever, smartrecruiters,
  workday, oraclehcm, eightfold, and radancy, **using the same endpoints the
  fetchers use** (e.g. Workday probes POST `/wday/cxs/{tenant}/{site}/jobs`;
  Oracle probes carry `expand=requisitionList.secondaryLocations` because the
  fetcher verified the response omits requisitions without it).
- Hinted slugs (from careers URLs or research) are verified first — one request
  instead of ~20 guesses. Generic guessing derives slugs from the name.
- **False-positive guard**: a name-derived guess that doesn't encode roughly the
  whole company name is only accepted when the ATS response confirms the org
  identity (greenhouse board name / ashby org name / smartrecruiters company
  name). Lever exposes no org name, so risky lever hits are rejected outright.
- Workday status codes steer the tenant hunt: 422 = tenant not on this wdN
  instance (move on), 404 = right instance / wrong site name (keep guessing).
  `wdN.myworkdaysite.com/recruiting/{tenant}/{site}` URLs are normalized to
  the `{tenant}.wdN.myworkdayjobs.com/{site}` slug form the fetcher expects.
- Politeness: ≤1 req/s **per host** (each Workday tenant is its own host),
  browser UA, 10 s timeouts, ≤8 workers across hosts.
- Checkpointing: the output csv is itself the resolved checkpoint; a sidecar
  state json caches unresolved names so an interrupted run resumes where it
  stopped. Transient network errors get cached as misses, so a final
  `--retry-unresolved` pass is part of the normal workflow (it recovered
  Pulumi, whose board 200s but flaked mid-run).
- `validate --sample 0.05` re-checks csv integrity (header, dupes,
  seed/bigtech overlap, flags, slug shapes, priority cap) and live re-probes a
  random 5% sample.

## What we learned probing (2026-07)

- **Greenhouse's v1 Job Board API is disappearing.** A large cohort of
  long-time greenhouse tenants (Groq, Grammarly, Retool, Remitly, Flywire,
  Checkout.com, Tipalti, Recurly, Chargebee, Yelp, Etsy, Opendoor, Turo…) now
  live only on `job-boards.greenhouse.io` with the public
  `boards-api.greenhouse.io/v1` endpoint returning 404. The monitor's
  greenhouse fetcher uses v1, so these are unmonitorable as first-class rows —
  the wide discovery layer still sees their postings.
- **2025–26 M&A moved a lot of boards**: Discover→Capital One,
  Windsurf→Cognition, Moveworks→ServiceNow, Census→Fivetran, Coda→Grammarly,
  Privy→Stripe, W&B→CoreWeave, HashiCorp→IBM, MoneyLion→Gen Digital,
  Amount→FIS (board still live), LendingClub rebranded to **Happen**
  (workday slug unchanged: `lendingclub.wd1`).
- **Vanity careers domains hide the real family**: TalentBrew asset URLs
  (`tbcdn.talentbrew.com`) mean Radancy (Jack Henry, BlackRock, Citizens);
  `/job-search-results/` or `/us/en/search-results` means Phenom (unsupported:
  UnitedHealth, Cigna's front, Allstate, Remitly, Synovus, Frost…).
- **Workday site names are the failure point**, not tenants: USAA's is
  `USAAJOBSWD`, Moderna's `M_tx`, BMS's `BMS`, Q2's `Q2` — unguessable, so the
  resolver fetches the careers page when a major target misses.
- **Empty lever boards lie.** Lever answers 200 + `[]` for boards whose owner
  migrated ATS years ago (Kraken, Clari, Varo, AllTrails, Color…) and exposes
  no org name to check. Ten such rows were caught in a post-run sweep and
  removed; `probe_lever` now requires ≥1 live posting.

## Deliberately skipped (verified dead ends — `SKIP_KNOWN`)

These are never probed; reasons verified 2026-07-13. The wide layer still
covers their postings.

| name | reason |
|---|---|
| adept | team acqui-hired into Amazon (2024); no independent job board |
| ai21 labs | hires via Comeet (unsupported ATS family) |
| bamboohr | runs hiring on its own ATS product (unsupported) |
| bilt rewards | hires via Gem (jobs.gem.com/bilt) — unsupported family |
| census | acquired by Fivetran (2025); Fivetran already in the registry |
| coda | merged into Grammarly (2024); Grammarly row covers it |
| discover | acquired by Capital One (2025); the Capital One row covers it |
| eigenlayer | no API-accessible board (greenhouse eigenlabs/eigenlayer 404) |
| goodrx | no API-accessible board found on any supported family |
| grammarly | greenhouse v1 API disabled (job-boards only; now under Superhuman) |
| groq | greenhouse board live but public Job Board API disabled (v1 404) |
| hashicorp | acquired by IBM (2025); hiring moved into IBM Avature (unsupported) |
| hugging face | hires via Workable (unsupported family) |
| increase | tiny team (~15) with an empty lever board — no active API-visible hiring |
| joby aviation | hires via iCIMS (careers-jobyaviation.icims.com) — unsupported |
| klarna | hires via Deel-hosted careers (jobs.deel.com/klarna) — unsupported |
| liveblocks | no standard board found (tiny team, custom careers page) |
| metlife | only a LatAm agent-recruiting lever board is API-visible; US careers on unsupported platform |
| modular | greenhouse board (modularai) live but public Job Board API disabled |
| monday.com | hires via Comeet (unsupported family) |
| moneylion | acquired by Gen Digital (2025); no API-accessible board |
| moveworks | acquired by ServiceNow (2025); ServiceNow already in seed |
| outerbounds | no standard board found (tiny team) |
| patronus ai | no API-accessible board found |
| plenty | wound down (Chapter 11, 2025) |
| privy | acquired by Stripe (2025); Stripe already in the seed registry |
| qdrant | hires via join.com (unsupported family) |
| replicate | no API-accessible board found (custom careers page) |
| retool | greenhouse board (retool) live on job-boards but public v1 API disabled |
| rippling | runs hiring on its own ATS (unsupported) |
| sakana ai | Japan-based, hires via Herp (unsupported; non-US) |
| shopify | moved off SmartRecruiters to a custom careers platform |
| tome | pivoted + tiny; former ashby board gone |
| turso | no standard board found (tiny team) |
| verily | no API-accessible board found (greenhouse verily 404) |
| weights & biases | acquired by CoreWeave (2025); CoreWeave already in seed |
| windsurf | acquired by Cognition (2025); Cognition already in seed |
| xata | no standard board found (tiny team) |

## Probed but unresolved

Names probed against every supported family without a hit. Mostly: greenhouse
v1-API sunset victims, Phenom/iCIMS/Avature/ADP/Taleo shops, or custom career
sites. They stay out of the registry (fail-loud beats a broken row); the wide
layer covers them.

| Company | Category | Why |
|---|---|---|
| ASAPP | ai-apps | hint+generic probes missed |
| Aisera | ai-apps | hint+generic probes missed |
| Captions | ai-apps | hint+generic probes missed |
| Clari | ai-apps | former lever board is empty (ATS migrated); no live board on supported families |
| Copy.ai | ai-apps | no standard ATS match |
| Forethought | ai-apps | hint+generic probes missed |
| Jasper | ai-apps | hint+generic probes missed |
| Lindy | ai-apps | hint+generic probes missed |
| People.ai | ai-apps | hint+generic probes missed |
| CrewAI | ai-infra | hint+generic probes missed |
| Voltage Park | ai-infra | hint+generic probes missed |
| Allen Institute for AI | ai-labs | hint+generic probes missed |
| Skild AI | ai-labs | hint+generic probes missed |
| Comerica | bank | hint+generic probes missed |
| FNB Corp | bank | hint+generic probes missed |
| First Citizens Bank | bank | hint+generic probes missed |
| HSBC US | bank | hint+generic probes missed |
| Huntington National Bank | bank | hint+generic probes missed |
| Regions Bank | bank | hint+generic probes missed |
| Sallie Mae | bank | hint+generic probes missed |
| State Street | bank | hint+generic probes missed |
| Synchrony | bank | hint+generic probes missed |
| Vanguard | bank | hint+generic probes missed |
| AllTrails | consumer-marketplace | former lever board is empty (ATS migrated); no live board on supported families |
| Apartment List | consumer-marketplace | hint+generic probes missed |
| Care.com | consumer-marketplace | hint+generic probes missed |
| Etsy | consumer-marketplace | hint+generic probes missed |
| Gametime | consumer-marketplace | hint+generic probes missed |
| Grubhub | consumer-marketplace | hint+generic probes missed |
| Lime | consumer-marketplace | hint+generic probes missed |
| Opendoor | consumer-marketplace | hint+generic probes missed |
| Redfin | consumer-marketplace | hint+generic probes missed |
| StubHub | consumer-marketplace | hint+generic probes missed |
| ThredUp | consumer-marketplace | hint+generic probes missed |
| Turo | consumer-marketplace | hint+generic probes missed |
| Vivid Seats | consumer-marketplace | hint+generic probes missed |
| Whatnot | consumer-marketplace | hint+generic probes missed |
| Wonder | consumer-marketplace | hint+generic probes missed |
| Yelp | consumer-marketplace | hint+generic probes missed |
| Zillow | consumer-marketplace | hint+generic probes missed |
| ezCater | consumer-marketplace | former lever board is empty (ATS migrated); no live board on supported families |
| DataRobot | data-infra | hint+generic probes missed |
| Firebolt | data-infra | hint+generic probes missed |
| H2O.ai | data-infra | hint+generic probes missed |
| Redpanda | data-infra | hint+generic probes missed |
| Tecton | data-infra | former lever board is empty (ATS migrated); no live board on supported families |
| Timescale | data-infra | hint+generic probes missed |
| BrowserStack | dev-tools | hint+generic probes missed |
| Harness | dev-tools | hint+generic probes missed |
| Hasura | dev-tools | hint+generic probes missed |
| Optimizely | dev-tools | hint+generic probes missed |
| Spacelift | dev-tools | hint+generic probes missed |
| Spectro Cloud | dev-tools | hint+generic probes missed |
| Superblocks | dev-tools | hint+generic probes missed |
| Telnyx | dev-tools | hint+generic probes missed |
| Unity | dev-tools | hint+generic probes missed |
| Clockwise | enterprise-saas | hint+generic probes missed |
| Dayforce | enterprise-saas | hint+generic probes missed |
| Egnyte | enterprise-saas | hint+generic probes missed |
| Eightfold AI | enterprise-saas | hint+generic probes missed |
| Fountain | enterprise-saas | hint+generic probes missed |
| Gem | enterprise-saas | hint+generic probes missed |
| Motion | enterprise-saas | hint+generic probes missed |
| Paylocity | enterprise-saas | hint+generic probes missed |
| Phenom | enterprise-saas | hint+generic probes missed |
| RingCentral | enterprise-saas | hint+generic probes missed |
| SevenRooms | enterprise-saas | hint+generic probes missed |
| UKG | enterprise-saas | hint+generic probes missed |
| Velocity Global | enterprise-saas | former lever board is empty (ATS migrated); no live board on supported families |
| Workiva | enterprise-saas | hint+generic probes missed |
| AMD | f500-tech | hint+generic probes missed |
| Arm | f500-tech | hint+generic probes missed |
| Best Buy | f500-tech | hint+generic probes missed |
| Electronic Arts | f500-tech | hint+generic probes missed |
| HPE | f500-tech | hint+generic probes missed |
| McDonald's | f500-tech | hint+generic probes missed |
| NetApp | f500-tech | hint+generic probes missed |
| Nike | f500-tech | hint+generic probes missed |
| Nutanix | f500-tech | hint+generic probes missed |
| Rivian | f500-tech | hint+generic probes missed |
| Sonos | f500-tech | hint+generic probes missed |
| Starbucks | f500-tech | hint+generic probes missed |
| United Airlines | f500-tech | hint+generic probes missed |
| Verizon | f500-tech | hint+generic probes missed |
| Walgreens | f500-tech | hint+generic probes missed |
| Warner Bros. Discovery | f500-tech | hint+generic probes missed |
| Albert | fintech | hint+generic probes missed |
| AvidXchange | fintech | hint+generic probes missed |
| Empower Finance | fintech | hint+generic probes missed |
| Flywire | fintech | hint+generic probes missed |
| Green Dot | fintech | hint+generic probes missed |
| Payhawk | fintech | no standard ATS match |
| Remitly | fintech | hint+generic probes missed |
| Stampli | fintech | hint+generic probes missed |
| Step | fintech | hint+generic probes missed |
| Tipalti | fintech | hint+generic probes missed |
| Varo Bank | fintech | former lever board is empty (ATS migrated); no live board on supported families |
| Zepz | fintech | hint+generic probes missed |
| Kraken | fintech-crypto | former lever board is empty (ATS migrated); no live board on supported families |
| ACI Worldwide | fintech-infra | hint+generic probes missed |
| Apex Fintech Solutions | fintech-infra | hint+generic probes missed |
| Argyle | fintech-infra | hint+generic probes missed |
| Avalara | fintech-infra | hint+generic probes missed |
| CME Group | fintech-infra | hint+generic probes missed |
| Cboe Global Markets | fintech-infra | hint+generic probes missed |
| Chargebee | fintech-infra | hint+generic probes missed |
| Checkout.com | fintech-infra | hint+generic probes missed |
| Corpay | fintech-infra | hint+generic probes missed |
| DTCC | fintech-infra | hint+generic probes missed |
| Intercontinental Exchange | fintech-infra | hint+generic probes missed |
| MSCI | fintech-infra | hint+generic probes missed |
| MX | fintech-infra | hint+generic probes missed |
| Method Financial | fintech-infra | hint+generic probes missed |
| Moody's | fintech-infra | hint+generic probes missed |
| Moov | fintech-infra | hint+generic probes missed |
| PayNearMe | fintech-infra | hint+generic probes missed |
| Rapyd | fintech-infra | hint+generic probes missed |
| Recurly | fintech-infra | hint+generic probes missed |
| S&P Global | fintech-infra | hint+generic probes missed |
| Shift4 | fintech-infra | hint+generic probes missed |
| Signifyd | fintech-infra | hint+generic probes missed |
| Tradeweb | fintech-infra | hint+generic probes missed |
| Unit21 | fintech-infra | hint+generic probes missed |
| Worldpay | fintech-infra | hint+generic probes missed |
| Alma | healthtech | hint+generic probes missed |
| Carbon Health | healthtech | former lever board is empty (ATS migrated); no live board on supported families |
| Cardinal Health | healthtech | hint+generic probes missed |
| Cityblock Health | healthtech | hint+generic probes missed |
| Color Health | healthtech | former lever board is empty (ATS migrated); no live board on supported families |
| Datavant | healthtech | hint+generic probes missed |
| Function Health | healthtech | hint+generic probes missed |
| Headspace | healthtech | hint+generic probes missed |
| K Health | healthtech | hint+generic probes missed |
| Noom | healthtech | hint+generic probes missed |
| Transcarent | healthtech | former lever board is empty (ATS migrated); no live board on supported families |
| Akamai | infra | hint+generic probes missed |
| Fly.io | infra | hint+generic probes missed |
| Centene | insurance | hint+generic probes missed |
| Clearcover | insurance | hint+generic probes missed |
| Elevance Health | insurance | hint+generic probes missed |
| Hippo Insurance | insurance | hint+generic probes missed |
| Humana | insurance | hint+generic probes missed |
| Jerry | insurance | hint+generic probes missed |
| Kin Insurance | insurance | hint+generic probes missed |
| Ladder Life | insurance | hint+generic probes missed |
| Lincoln Financial | insurance | hint+generic probes missed |
| Nationwide | insurance | hint+generic probes missed |
| Next Insurance | insurance | hint+generic probes missed |
| Snapsheet | insurance | hint+generic probes missed |
| The Hartford | insurance | hint+generic probes missed |
| Chronosphere | observability | hint+generic probes missed |
| Dynatrace | observability | hint+generic probes missed |
| Observe Inc | observability | hint+generic probes missed |
| Biogen | pharma | hint+generic probes missed |
| Eli Lilly | pharma | hint+generic probes missed |
| Merck | pharma | hint+generic probes missed |
| Vertex Pharmaceuticals | pharma | hint+generic probes missed |
| Aqua Security | security | hint+generic probes missed |
| Arctic Wolf | security | hint+generic probes missed |
| CyberArk | security | hint+generic probes missed |
| Palo Alto Networks | security | hint+generic probes missed |
| Rapid7 | security | hint+generic probes missed |
| Tenable | security | hint+generic probes missed |

## Screened from the xlsx but not added

Whole classes intentionally not carried over: Chicago-100 industrials/food/
logistics (Conagra, Navistar, Brunswick…), pure-R&D pharma without US digital
product orgs (the `Pharmac` tab's long tail), micro banks and credit unions,
and insurers on Phenom/iCIMS/Taleo (UnitedHealth, Allstate, Progressive,
Principal, Molina, Unum, W.R. Berkley, Equitable…) — either not plausible
PM-at-scale employers or not on a supported ATS family.

## Re-running

```
python -m monitor.scripts.expand_companies resolve   [--workers 8] [--retry-unresolved]
python -m monitor.scripts.expand_companies validate  [--sample 0.05]
```

Both are safe to re-run any time; `resolve` only probes names not already in
the csv/state, and `--retry-unresolved` re-probes past misses (do this after
adding hints for newly researched careers URLs).
