/**
 * Role-family presets — the wizard's step 1, and where steps 2-5 get their
 * starting values.
 *
 * The two real ones are copied from the committed profiles
 * (`users/salman/profile.yaml`, `users/dad/profile.yaml`) rather than invented,
 * because those lists are the only ones anybody has tuned against a live feed:
 * Salman's `titles_exclude` has `pmm` and `product analyst` in it for reasons
 * somebody learned the hard way, and Dad's has `financial advisor` and
 * `personal banker` because an FP&A search without them is 60% insurance sales.
 * A wizard that seeds a plausible-looking guess instead teaches the same
 * lessons again from scratch.
 *
 * `tests/monitor/test_profile_presets.py` parses this file against the YAML, so
 * a title added to a committed profile and not here shows up as a failure
 * rather than as a preset that has quietly rotted. The third preset is
 * deliberately empty: "something else" is a real answer and pretending to have
 * a curated list for it would be the worse lie.
 */
import type { ProfileCriteria } from "./criteria";
import { BASE_CRITERIA } from "./criteria";

export type RolePreset = {
  id: string;
  /** What the option says. */
  label: string;
  /** One line under it — what this search actually looks for. */
  blurb: string;
  /** The fields step 1 sets, plus the title lists steps 2 prefills from. */
  criteria: Pick<
    ProfileCriteria,
    "role_family" | "tag_domain" | "board_search_term" | "titles_include" | "titles_exclude"
  >;
};

export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    id: "product-manager",
    label: "Product management",
    blurb: "APM through Director, plus the forward-deployed and product-ops variants.",
    criteria: {
      role_family: "product manager",
      tag_domain: "product-manager",
      board_search_term: "product",
      titles_include: [
        "product manager",
        "associate product manager",
        "senior product manager",
        "group product manager",
        "principal product manager",
        "head of product",
        "director of product",
        "vp of product",
        "technical product manager",
        "deployment strategist",
        "forward deployed",
        "product strategist",
        "product operations",
        "strategic projects",
      ],
      titles_exclude: [
        "product marketing",
        "product designer",
        "product design",
        "product analyst",
        "data analyst",
        "program manager",
        "marketing manager",
        "pmm",
        "intern",
      ],
    },
  },
  {
    id: "fpa",
    label: "Financial planning & analysis",
    blurb:
      "FP&A, reporting, treasury and controllership — employer-agnostic, because hospitals and manufacturers hire these too.",
    criteria: {
      role_family: "financial planning & analysis",
      tag_domain: "finance",
      board_search_term: "financial",
      titles_include: [
        "financial planning",
        "fp&a",
        "financial analyst",
        "senior financial analyst",
        "finance manager",
        "financial reporting",
        "reporting manager",
        "treasury",
        "treasury analyst",
        "treasury manager",
        "controller",
        "assistant controller",
        "accounting manager",
        "budget analyst",
        "corporate finance",
        "finance director",
      ],
      titles_exclude: [
        "financial advisor",
        "financial representative",
        "insurance agent",
        "sales",
        "intern",
        "internship",
        "wealth management",
        "personal banker",
        "teller",
      ],
    },
  },
  {
    id: "other",
    label: "Something else",
    blurb: "Name the role and write your own title list. Nothing is pre-filled.",
    criteria: {
      role_family: "",
      tag_domain: "",
      board_search_term: "",
      titles_include: [],
      titles_exclude: [],
    },
  },
] as const;

export function presetById(id: string): RolePreset | undefined {
  return ROLE_PRESETS.find((p) => p.id === id);
}

/**
 * Which preset a set of criteria came from, or "other".
 *
 * Matched on `role_family` alone: the moment somebody edits one title chip the
 * lists diverge, and the preset is still the right label for where they
 * started. Used to re-select the radio when the wizard is walked backwards.
 */
export function presetFor(criteria: Pick<ProfileCriteria, "role_family">): RolePreset {
  const rf = criteria.role_family.trim().toLowerCase();
  return (
    ROLE_PRESETS.find((p) => p.criteria.role_family && p.criteria.role_family === rf) ??
    (presetById("other") as RolePreset)
  );
}

/** A fresh draft for a preset: the committed baseline with step 1 applied. */
export function draftFromPreset(id: string): ProfileCriteria {
  const preset = presetById(id);
  if (!preset) return { ...BASE_CRITERIA };
  return { ...BASE_CRITERIA, ...preset.criteria };
}
