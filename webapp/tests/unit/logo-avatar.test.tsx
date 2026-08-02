/**
 * `LogoAvatar` asserts the LADDER'S DECISION, never a remote URL resolving.
 *
 * The distinction is the whole point of this file. A test that checks "Ramp
 * shows a logo" is a test of whatever the fixture universe happens to contain
 * that week, and the fixture universe is being corrected on a parallel branch
 * (four demo companies are absent from it; one is present that should not be).
 * A test that checks "no domain means the monogram" is a test of the contract,
 * and the contract is what production runs on — where most companies carry no
 * domain at all for a while, because the backfill only populates opportunistically.
 *
 * The states that matter, in order of how often production will be in them:
 *   1. no domain at all  → monogram, no <img>, no empty box
 *   2. domain, no key    → the favicon rung only
 *   3. domain and key    → logo.dev first, favicon second
 *   4. every rung failed → monogram, never the browser's broken-image glyph
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogoAvatar, monogram } from "@/components/ds/logo-avatar";

afterEach(() => vi.unstubAllEnvs());

const img = (): HTMLImageElement | null =>
  document.querySelector("img") as HTMLImageElement | null;

describe("LogoAvatar walks the ladder", () => {
  it("renders the monogram and no image when there is no domain", () => {
    // Mutation killed: rendering an <img> with an empty/undefined src, which is
    // what produces the broken-image glyph this component must never show. It
    // is also the ORDINARY state in production, not an error path.
    render(<LogoAvatar name="Modern Treasury" />);
    expect(img()).toBeNull();
    expect(screen.getByText("MT")).toBeTruthy();
  });

  it("treats a null domain exactly like an absent one", () => {
    // Mutation killed: `domain ?? ""` fed into the ladder, which would mint
    // `?domain=&sz=64` and paint a generic globe beside a real company.
    render(<LogoAvatar name="Plaid" domain={null} />);
    expect(img()).toBeNull();
    expect(screen.getByText("PL")).toBeTruthy();
  });

  it("offers the favicon rung when there is a domain but no key", () => {
    // Mutation killed: requiring the key for BOTH rungs, which would leave
    // every company on the monogram even once the domain column lands.
    vi.stubEnv("NEXT_PUBLIC_LOGO_DEV_KEY", "");
    render(<LogoAvatar name="Ramp" domain="ramp.com" />);
    const el = img();
    expect(el).not.toBeNull();
    expect(el!.getAttribute("src")).toContain("google.com/s2/favicons");
    expect(el!.getAttribute("src")).not.toContain("logo.dev");
  });

  it("puts logo.dev first when both a domain and a key exist", () => {
    // Mutation killed: a swapped ladder. Both URLs load, so nothing fails
    // visibly — you just never see the real mark, on every row, forever.
    vi.stubEnv("NEXT_PUBLIC_LOGO_DEV_KEY", "pk_test");
    render(<LogoAvatar name="Ramp" domain="ramp.com" />);
    expect(img()!.getAttribute("src")).toContain("img.logo.dev");
  });

  it("falls from logo.dev to the favicon to the monogram, one error at a time", () => {
    // Mutation killed: an `onError` that resets to 0 (an infinite retry loop) or
    // that jumps straight past the favicon. The ladder has to be walked, and its
    // last step has to be the monogram rather than a dead <img>.
    vi.stubEnv("NEXT_PUBLIC_LOGO_DEV_KEY", "pk_test");
    render(<LogoAvatar name="Ramp" domain="ramp.com" />);
    expect(img()!.getAttribute("src")).toContain("img.logo.dev");

    fireEvent.error(img()!);
    expect(img()!.getAttribute("src")).toContain("google.com/s2/favicons");

    fireEvent.error(img()!);
    expect(img()).toBeNull();
    expect(screen.getByText("RA")).toBeTruthy();
  });

  it("re-enters the ladder when a recycled row is handed a new company", () => {
    // Mutation killed: dropping the render-time rung reset. Rows recycle in the
    // virtualized table, so a company whose logo 404'd would poison the next
    // company to land in that element — it would show ITS monogram.
    vi.stubEnv("NEXT_PUBLIC_LOGO_DEV_KEY", "");
    const { rerender } = render(<LogoAvatar name="Ramp" domain="ramp.com" />);
    fireEvent.error(img()!);
    expect(img()).toBeNull();

    rerender(<LogoAvatar name="Vanta" domain="vanta.com" />);
    expect(img()).not.toBeNull();
    expect(img()!.getAttribute("src")).toContain("vanta.com");
  });

  it("renders a quiet neutral square rather than an image for a nameless row", () => {
    // Mutation killed: rendering an <img> (or throwing) for the slug-only
    // universe rows that carry no name at all. The square keeps the column's
    // rhythm; inventing initials would be inventing data.
    render(<LogoAvatar name="" />);
    expect(img()).toBeNull();
    expect(monogram("")).toBe("");
  });
});
