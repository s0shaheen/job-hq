import { describe, expect, it } from "vitest";
import {
  ABOUT_YOU,
  ANSWER_SCOPE_COMPANY,
  ANSWER_SCOPE_GLOBAL,
  DEAL_BREAKER,
  DEAL_BREAKER_PLURAL,
  HOW_IT_WAS_FOUND,
  IMPORT_NOUN,
  PANE_ABOUT_THE_ROLE,
  PANE_ACTIVITY,
  PANE_DETAILS,
  decisionLabel,
  dispositionLabel,
  watchingLabel,
} from "@/lib/data/view-models";

describe("the section 4 display dictionary", () => {
  it.each([
    ["decision: waiting", decisionLabel(""), "Needs decision"],
    ["decision: interested", decisionLabel("interested"), "Interested"],
    ["decision: dismissed", decisionLabel("dismissed"), "Passed"],
    ["decision: snoozed", decisionLabel("snoozed"), "Later"],
    ["match: qualified", dispositionLabel("qualified"), "Matches your search"],
    ["match: filtered", dispositionLabel("filtered"), "Didn't match your search"],
    ["match: pending", dispositionLabel("needs-info"), "Checking details"],
    ["scan: included", watchingLabel(true), "Include in scans"],
    ["scan: excluded", watchingLabel(false), "Not included in scans"],
    ["deal-breaker", DEAL_BREAKER, "Deal-breaker"],
    ["deal-breakers", DEAL_BREAKER_PLURAL, "Deal-breaker questions"],
    ["global answers", ANSWER_SCOPE_GLOBAL, "Your answers"],
    ["company answers", ANSWER_SCOPE_COMPANY, "Company-specific answers"],
    ["person facts", ABOUT_YOU, "About you"],
    ["import", IMPORT_NOUN, "import"],
    ["pane facts", PANE_DETAILS, "Details"],
    ["pane focus", PANE_ABOUT_THE_ROLE, "About the role"],
    ["pane history", PANE_ACTIVITY, "Activity"],
    ["resolution method", HOW_IT_WAS_FOUND, "How it was found"],
  ])("%s renders as specified", (_case, actual, expected) => {
    expect(actual).toBe(expected);
  });
});
