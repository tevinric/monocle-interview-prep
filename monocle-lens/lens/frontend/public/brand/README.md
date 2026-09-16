# Brand assets

`logo.svg` is the Monocle Solutions corporate mark, taken from monoclesolutions.com. The
letterforms are set to `currentColor`, so the same file reads correctly on the navy rail
(white) and on light surfaces (navy) without shipping two variants. The diagonal keeps the
brand red `#E82B2B` in both.

The diagonal is reused as a motif across the interface — the marker before a section
heading, the rule under the landing headline, the wash behind the navy blocks — but it is
drawn in CSS (`.brand-rule` and skewed spans) rather than loaded as a file, so it takes
the brand red from the theme and costs no request.

The mark is rendered by `src/components/MonocleMark.jsx`, which inlines those paths —
an `<img>` would load the SVG as its own document, and `currentColor` would resolve
against the file's own black instead of the navy rail. `src/components/Brand.jsx` sets the Monocle mark beside the
**Lens** product name with a hairline between them. The lockup is deliberately built so a
viewer reads "Lens, styled in the Monocle brand" rather than "a Monocle product" — the
strap beneath it says so in words.
