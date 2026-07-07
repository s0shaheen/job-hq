#!/usr/bin/env python3
"""Generate an editable .docx resume from a RenderCV cv.yaml.

Mirrors the harvard-theme layout closely enough for last-mile edits in Word or
Google Docs. The YAML stays the source of record — if a docx edit matters,
backport it to the YAML (see CLAUDE.md).

Usage: uv run --with python-docx --with pyyaml scripts/yaml_to_docx.py <cv.yaml> <out.docx>
"""
import sys
import yaml
from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT
from docx.oxml.ns import qn

FONT = "Charter"          # present on macOS; Georgia is the near-identical fallback
BODY_SIZE = Pt(10.5)
NAME_SIZE = Pt(22)

MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec"]


def fmt_date(d):
    if d is None:
        return None
    s = str(d)
    if s == "present":
        return "present"
    parts = s.split("-")
    if len(parts) >= 2:
        return f"{MONTHS[int(parts[1])]} {parts[0]}"
    return parts[0]


def date_range(e):
    if e.get("date"):
        return fmt_date(e["date"])
    start, end = fmt_date(e.get("start_date")), fmt_date(e.get("end_date") or "present")
    if start:
        return f"{start} – {end}"
    return ""


def set_font(run, size=BODY_SIZE, bold=False, italic=False):
    run.font.name = FONT
    run.font.size = size
    run.font.bold = bold
    run.font.italic = italic
    run.font.color.rgb = RGBColor(0, 0, 0)
    rPr = run._element.get_or_add_rPr()
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = rPr.makeelement(qn("w:rFonts"), {})
        rPr.append(rFonts)
    for attr in ("w:ascii", "w:hAnsi", "w:cs"):
        rFonts.set(qn(attr), FONT)


def para(doc, before=0, after=0):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(before)
    p.paragraph_format.space_after = Pt(after)
    return p


def bottom_border(p):
    pPr = p._p.get_or_add_pPr()
    pbdr = pPr.makeelement(qn("w:pBdr"), {})
    bottom = pPr.makeelement(qn("w:bottom"), {})
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "6")
    bottom.set(qn("w:space"), "2")
    bottom.set(qn("w:color"), "000000")
    pbdr.append(bottom)
    pPr.append(pbdr)


def right_tab(p, width_inches):
    p.paragraph_format.tab_stops.add_tab_stop(Inches(width_inches), WD_TAB_ALIGNMENT.RIGHT)


def section_title(doc, text):
    p = para(doc, before=8, after=2)
    r = p.add_run(text)
    set_font(r, size=Pt(12), bold=True)
    bottom_border(p)


def bullet(doc, text):
    p = doc.add_paragraph(style="List Bullet")
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(2)
    p.paragraph_format.left_indent = Inches(0.2)
    r = p.add_run(text)
    set_font(r)


def main(src, dst):
    cv = yaml.safe_load(open(src))["cv"]
    doc = Document()

    for section in doc.sections:
        section.top_margin = section.bottom_margin = Inches(0.5)
        section.left_margin = section.right_margin = Inches(0.5)
    content_width = 8.5 - 1.0  # letter minus margins

    normal = doc.styles["Normal"]
    normal.font.name = FONT
    normal.font.size = BODY_SIZE

    # Header
    p = para(doc, after=2)
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_font(p.add_run(cv["name"]), size=NAME_SIZE)

    contacts = [cv.get("location"), cv.get("email")]
    for s in cv.get("social_networks") or []:
        if s["network"] == "LinkedIn":
            contacts.append(f"linkedin.com/in/{s['username']}")
    p = para(doc, after=4)
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_font(p.add_run("  •  ".join(c for c in contacts if c)))

    sections = cv.get("sections", {})

    for key, entries in sections.items():
        title = key.replace("_", " ").title() if key == key.lower() else key
        section_title(doc, title)

        for e in entries:
            if isinstance(e, str):  # TextEntry
                p = para(doc, after=2)
                set_font(p.add_run(e))
            elif "company" in e:  # ExperienceEntry
                p = para(doc, before=4, after=1)
                right_tab(p, content_width)
                set_font(p.add_run(e["company"]), bold=True)
                loc = f" – {e['location']}" if e.get("location") else ""
                set_font(p.add_run(f", {e['position']}{loc}"))
                set_font(p.add_run("\t" + date_range(e)))
                for h in e.get("highlights") or []:
                    bullet(doc, h)
            elif "institution" in e:  # EducationEntry
                p = para(doc, before=4, after=1)
                right_tab(p, content_width)
                set_font(p.add_run(e["institution"]), bold=True)
                degree = f"{e['degree']} in " if e.get("degree") else ""
                set_font(p.add_run(f", {degree}{e['area']}"))
                set_font(p.add_run("\t" + date_range(e)))
                if e.get("summary"):
                    p = para(doc, after=1)
                    set_font(p.add_run(e["summary"]))
                for h in e.get("highlights") or []:
                    bullet(doc, h)
            elif "label" in e:  # OneLineEntry
                p = para(doc, after=2)
                set_font(p.add_run(f"{e['label']}: "), bold=True)
                set_font(p.add_run(e["details"]))
            elif "bullet" in e:
                bullet(doc, e["bullet"])

    doc.save(dst)
    print(f"Wrote {dst}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
