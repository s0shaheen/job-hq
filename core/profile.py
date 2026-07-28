"""Search Profile — what a user is looking for, in one declarative object.

The engine used to encode ONE person's search in code: a tagging prompt that
says "product-manager job postings", a title list in the committed defaults,
a company universe curated for fintech PM roles. That is fine for one user
and a wall for three. A profile makes the search data:

    role_family     "product manager" | "financial planning & analysis" | ...
    titles_include/exclude, seniority_exclude
    countries, metros, remote policy, yoe range
    industries, comp_floor

Where a profile lives, in precedence order:
  1. the user's Config TAB (per-key, phone-editable, validated) — wins
  2. users/<name>/profile.yaml (committed; the operator sets it up once)
  3. core/config_defaults.yaml (the committed fallback)

That ordering is deliberate: a user can always adjust their own search from
the spreadsheet without a commit, and the committed file is the durable
record the operator maintains. Nothing here talks to a sheet or a network —
callers pass in the already-loaded UserConfig.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from core.config import REPO_ROOT

PROFILE_DIRNAME = "users"


@dataclass
class Profile:
    name: str = ""
    role_family: str = "product manager"
    # what the tagger is told it is reading; keeps the LLM prompt honest for
    # non-PM searches without a code change
    tag_domain: str = "product-manager"
    titles_include: list[str] = field(default_factory=list)
    titles_exclude: list[str] = field(default_factory=list)
    seniority_exclude: list[str] = field(default_factory=list)
    countries: list[str] = field(default_factory=lambda: ["United States"])
    metros: list[str] = field(default_factory=list)   # empty = anywhere in countries
    yoe_max: int = 4
    comp_min: float = 0
    comp_unknown: str = "keep"
    work_model_exclude: list = field(default_factory=list)
    geo_unknown: str = "filter"
    yoe_unknown: str = "seniority-proxy"
    board_search_term: str = "product"    # corpus-wide boards (Workday et al)
    # The coarse notification CEILING: `email` means this person never gets an
    # ntfy push, whatever the per-event matrix below says (core/channels.py).
    notify_channel: str = "ntfy"          # ntfy | email | none
    notify_email: str = ""
    # Per-event refinement, push | email | both | none. Blank inherits the
    # ceiling, so an existing profile.yaml that names none of these keeps
    # behaving exactly as it did.
    notify_digest: str = ""
    notify_new_roles: str = ""
    notify_status_change: str = ""
    notify_oa_interview: str = ""
    notify_stale_nudge: str = ""
    # quiet hours: a LOCAL wall-clock window in which a non-urgent push is
    # deferred to its end, never dropped (core/channels.py)
    timezone: str = "America/Chicago"
    quiet_hours: str = "21:00-06:30"

    @classmethod
    def load(cls, user: str = "", cfg=None) -> "Profile":
        """Three layers, lowest first:

          1. core/config_defaults.yaml — the committed baseline. Without this
             a deployment that has no profile file at all (the original
             single-user setup) would come back with EMPTY titles and match
             nothing.
          2. users/<name>/profile.yaml — what this person is looking for.
          3. their Config tab, but only the cells they actually changed
             (see overlay_config).

        A NAMED user with no profile file is the one case that does not simply
        fall through to the defaults: `notify_channel` drops to `none`. The
        committed default is `ntfy`, so falling through would start pushing
        somebody's job search at a person who has never stated a preference —
        and on a flat registry it lands on the OPERATOR's topic, not theirs.
        `core/channels.py` already resolves an unreadable ceiling to silence for
        the same reason; a missing one is less readable, not more. Single-user
        mode (`user=""`) is untouched: there is no file to miss.
        """
        from core.config import defaults as _committed
        base = _committed()
        prof = cls(name=user)
        for cfg_key, attr in cls.OVERLAY:
            if cfg_key in base and base[cfg_key] not in (None, "", []):
                setattr(prof, attr, base[cfg_key])

        if user:
            p = REPO_ROOT / PROFILE_DIRNAME / user / "profile.yaml"
            if p.exists():
                with open(p) as f:
                    data = yaml.safe_load(f) or {}
                for k, v in data.items():
                    if k in cls.__dataclass_fields__ and k != "name":
                        setattr(prof, k, v)
            else:
                prof.notify_channel = "none"
                print(f"::warning title=No profile for {user}::"
                      f"{PROFILE_DIRNAME}/{user}/profile.yaml is missing — running the "
                      f"committed default search and sending {user} NO pushes. Add the "
                      f"file (and rebuild the Lambda image, which copies users/).",
                      file=sys.stderr)

        if cfg is not None:
            prof.overlay_config(cfg)
        return prof

    # Config key -> Profile attribute
    OVERLAY = (("titles_include", "titles_include"),
               ("titles_exclude", "titles_exclude"),
               ("filter_seniority_exclude", "seniority_exclude"),
               ("filter_countries", "countries"),
               ("filter_metros", "metros"),
               ("filter_yoe_max", "yoe_max"),
               ("filter_comp_min", "comp_min"),
               ("filter_comp_unknown", "comp_unknown"),
               ("filter_work_model_exclude", "work_model_exclude"),
               ("filter_geo_unknown", "geo_unknown"),
               ("filter_yoe_unknown", "yoe_unknown"),
               ("workday_search", "board_search_term"),
               # notification matrix — same key name on both sides, so the
               # Config tab, profile.yaml and the committed defaults all spell
               # it identically (core/channels.py resolves it)
               ("notify_digest", "notify_digest"),
               ("notify_new_roles", "notify_new_roles"),
               ("notify_status_change", "notify_status_change"),
               ("notify_oa_interview", "notify_oa_interview"),
               ("notify_stale_nudge", "notify_stale_nudge"),
               ("notify_timezone", "timezone"),
               ("notify_quiet_hours", "quiet_hours"))

    def overlay_config(self, cfg) -> None:
        """Apply ONLY the knobs this user actually changed in their sheet.

        The subtlety that makes this necessary: `UserConfig` starts from
        core/config_defaults.yaml and bootstrap materializes every default as
        a real Config row, so `cfg[key]` always has a value. Treating any
        value as an override would mean the committed defaults (which encode
        ONE person's PM search) silently overwrite every other user's
        profile — their instance would quietly run somebody else's search.

        So a Config value only wins when it DIFFERS from the committed
        default, i.e. when a human deliberately changed that cell. Values
        that still equal the default leave the profile alone.
        """
        from core.config import defaults as _committed
        base = _committed()
        for key, attr in self.OVERLAY:
            try:
                val = cfg[key]
            except (KeyError, TypeError):
                continue
            if val is None or val == "" or val == []:
                continue
            if key in base and val == base[key]:
                continue          # untouched default — the profile is the truth
            setattr(self, attr, val)

    def notice_email(self, user: str = "") -> str:
        """Where this person's engine email goes, or `""`.

        `notify_email` has existed on this dataclass since the profile landed
        and until Phase C3 **nothing in the repo read it** — the digest was
        mailed by an Apps Script with `shaheensalmant@gmail.com` as a literal.
        This is the reader, and the fallback chain is deliberately two links
        long and no longer:

          1. `notify_email` from the profile, when the operator set one;
          2. the registry's `owner_email` for that instance, which every user
             block already carries because bootstrap needs it to share the
             sheet. A user whose mail is simply their account address should
             not have to state it twice.

        Returns `""` rather than guessing when neither exists. The caller's job
        is to refuse loudly: mailing a briefing to the wrong person is worse
        than not mailing it, and mailing it to a blank address just fails at
        the provider with a less readable message.
        """
        mine = str(self.notify_email or "").strip()
        if mine:
            return mine
        try:
            from core.config import registry
            return str(registry(user or self.name or None).get("owner_email", "") or "").strip()
        except Exception:
            return ""

    def gate_config(self):
        """The intake gates for this profile (monitor.gates.GateConfig)."""
        from monitor.gates import GateConfig
        return GateConfig(countries=list(self.countries),
                          metros=list(self.metros),
                          geo_unknown=self.geo_unknown,
                          yoe_max=int(self.yoe_max),
                          comp_min=float(self.comp_min or 0),
                          comp_unknown=self.comp_unknown,
                          work_model_exclude=list(self.work_model_exclude),
                          yoe_unknown=self.yoe_unknown,
                          seniority_exclude=list(self.seniority_exclude))
