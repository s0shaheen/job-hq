# Build the base resume:        make
# Build a tailored resume:      make CV=tailored/<company>-<role>/cv.yaml
# Live-preview while editing:   make watch [CV=...]
# Output lands in <cv dir>/out/ (PDF + per-page PNGs). "Pages:" must print 1.
export PATH := $(HOME)/.local/bin:$(PATH)
CV ?= resume/base.yaml

.PHONY: render watch
render:
	rendercv render $(CV) --design resume/design.yaml --output-folder out --dont-generate-html --dont-generate-markdown
	@echo "Pages: $$(ls $(dir $(CV))out/*.png | wc -l | tr -d ' ')"

watch:
	rendercv render $(CV) --design resume/design.yaml --output-folder out --dont-generate-html --dont-generate-markdown --watch
