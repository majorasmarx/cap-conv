# cap-convert

> plug in an epub, get markdown

presently a few manual manipulations are required after conversion runs:

- footnote contents may not be aligned to be "within" the footnote -- this is a
  quirk of github-flavoured markdown (gfm) footnotes. footnotes can technically
  be placed anywhere -- even in the middle of the document -- so in gfm they are
  "containers", like blockquotes.

  the upshot is that **if the footnote contains multiple paragraphs**, **any
  paragraphs after the first paragraphs need to be indented** (four spaces) **to
  be considered part of the footnote**. otherwise those paragraphs will be
  considered part of the main document, and will be shunted upwards (to the end
  of the main document but before the footnotes).

- images from the epub also need to be handled manually:

  - if they are formulae, they should be rewritten with TeX (which can be
    prerendered when rendering markdown; github does this automatically, other
    remark-based renderers can use https://github.com/remarkjs/remark-math).

    **see [formulae.md](formulae.md) for images that have already been converted
    so far.**

  - if they're other images, they should just be moved to correct references.
    haven't seen any of these yet.

- some headings might not have the right weight (eg. `<h5>` instead of `<h2>`) or
  may not be present.

- no frontmatter is created, so any metadata for other sites will need to be
  added.

- the footnotes are simply concatenated to the main chapter to make things work,
  but may contain a duplicate of the chapter title.
