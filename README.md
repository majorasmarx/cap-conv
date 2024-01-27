# cap-convert

> plug in an epub, get markdown

presently a few manual manipulations are required after conversion runs:

- footnote contents may not be aligned to be "within" the footnote -- this is a
  quirk of github-flavoured markdown (gfm) footnotes. footnotes can technically
  be placed anywhere -- even in the middle of the document -- so in gfm they are
  "containers", like blockquotes.

  the upshot is that **if the footnote contains multiple paragraphs**, **they
  need to be indented to be considered part of the footnote**. otherwise those
  paragraphs will be considered part of the main document, and will be shunted
  upwards (to the end of the main document but before the footnotes).

- images from the epub also need to be handled manually:

  - if they are formulae, they should be rewritten with TeX (which can be
    prerendered when rendering markdown; github does this automatically, other
    remark-based renderers can use https://github.com/remarkjs/remark-math).

    **see [formulae.md](formulae.md) for images that have already been converted
    so far.**

  - if they're other images, they should just be moved to correct references.
    haven't seen any of these yet.
