import { join, basename } from "path";
import { readFile, writeFile } from "fs/promises";

import { fromHtml } from "hast-util-from-html";
import { toMdast } from "hast-util-to-mdast";
import { toMarkdown } from "mdast-util-to-markdown";
import { visit, SKIP } from "unist-util-visit";
import { gfmFootnoteToMarkdown } from "mdast-util-gfm-footnote";

import type { Root as HastRoot } from "hast";
import type {
  FootnoteDefinition,
  FootnoteReference,
  Link,
  Html,
  Text,
  Paragraph,
} from "mdast";

const INPUT_DIR = "input";
const OUTPUT_DIR = "output";

const file1 = "chapter001.xhtml";
const file2 = "chapter001-fn.xhtml";

const chap = await loadMungeConvert(file1);
const footnotes = await loadMungeConvert(file2, true);

// walk the main file, converting links to footnote references. link labels may
// have duplicates but footnote identifiers have to be unique, so we track them
// and rename as we go. for example, there may be several footnotes labelled
// with an asterisk * in the original text -- we have to instead rename them to
// **, ***, and so on.
const usedIdentifiers = new Set<string>();
const targetsToFinalIdentifiers = new Map<string, string>();
visit(chap, "link", (node, index, parent) => {
  if (!parent || typeof index !== "number") return;

  const [file, target] = node.url.split("#");
  if (file !== file2) {
    throw new Error(`External link to unknown file: "${file}"`);
  }
  if (!target) throw new Error(`No target for link: "${node.url}"`);
  if (node.children.length !== 1 && node.children[0].type !== "text") {
    throw new Error(
      `Unexpected children for link node:\n${JSON.stringify(node)}`,
    );
  }

  let desiredIdentifier = (node.children[0] as Text).value;

  // HACK: asterisks have to be escaped, so let's name them this way.
  if (desiredIdentifier === "*") {
    desiredIdentifier = "ast1";
  }

  let finalIdentifier;

  if (!usedIdentifiers.has(desiredIdentifier)) {
    finalIdentifier = desiredIdentifier;
    usedIdentifiers.add(desiredIdentifier);
  } else {
    if (Number.parseInt(desiredIdentifier)) {
      throw new Error(
        `Conflicting numbered footnote identifier: ${desiredIdentifier}`,
      );
    }
    let i = 2;
    finalIdentifier = desiredIdentifier;
    while (usedIdentifiers.has(finalIdentifier)) {
      finalIdentifier = desiredIdentifier.startsWith("ast")
        ? `ast${i}`
        : desiredIdentifier.repeat(i);

      i++;
    }
    usedIdentifiers.add(finalIdentifier);
  }

  targetsToFinalIdentifiers.set(target, finalIdentifier);

  parent.children[index] = {
    type: "footnoteReference",
    identifier: finalIdentifier,
  } as FootnoteReference;

  return SKIP;
});

// same for the footnotes, since footnotes contain references to other footnotes.
visit(footnotes, "link", (node, index, parent) => {
  if (!parent || typeof index !== "number") return;

  const [file, target] = node.url.split("#");

  if (file !== file1 && file !== file2) {
    throw new Error(`External link to unknown file: "${file}"`);
  }
  if (!target) throw new Error(`No target for link: "${node.url}"`);
  if (node.children.length !== 1 && node.children[0].type !== "text") {
    throw new Error(
      `Unexpected children for link node:\n${JSON.stringify(node)}`,
    );
  }

  // calibre generates anchors for every footnote ref (nevermind that this is
  // totally unnecessary and redundant -- an <a> link with a href can already be
  // an anchor, it doesn't need to be preceded by a href-less <a>). at this
  // point all links should be preceded by a comment node generated in the
  // hast->mdast pass by our custom handler for href-less <a> nodes.
  //
  // ie.
  //
  // <a id="0001"></a> <a href="file1.html#fn1">footnote 1</a>
  //
  // should now be
  //
  // <!-- 0001 --> [footnote 1](file1.html#fn1)
  //
  // (whitespace added for clarity.)
  //
  // our job now is to distinguish between links *to* footnotes (in mdast
  // nomenclature "footnote references", henceforth "refs"), and footnotes
  // proper (in mdast nomenclature "footnote definitions", henceforth "defs").
  //
  // - refs should have their comment node deleted; then they should be
  //   converted to a ref node. this is the same as in the main chapter file
  //   above.
  //
  // - defs should delete the link -- it's just a backlink to the ref, but gfm
  //   footnotes handle that automatically so it generates garbage to keep them.
  //   the comment should then be converted to a footnote def.
  //
  // the problem is, how do we distinguish between them? as far as i can tell
  // there's two options:
  //
  // - we can look at the positioning of elements -- refs are within a <sup>
  //   element (which the mdast conversion deletes). defs are the first child in
  //   their parent (but refs sometimes are as well). we'd have to do some
  //   additional bookkeeping involving manipulation of parents to mark this up.
  //
  // - we can look at whether an anchor has *already been referred to*. if we
  //   walk the AST in order, refs will always precede their respective def. we
  //   have to keep track of references anyway to ensure identifiers are named
  //   in a consistent way, so we get this for free.
  //
  // we take the second approach here, then.
  if (index < 1) {
    throw new Error(
      `Unexpected position for node: ${index}. Node:\n${JSON.stringify(node)}`,
    );
  }
  const prevSib = parent.children[index - 1];

  let identifier: string | undefined = undefined;

  if (
    prevSib.type === "html" &&
    prevSib.value.startsWith("<!-- ") &&
    prevSib.value.endsWith(" -->")
  ) {
    const maybeId = prevSib.value.slice(5, -4);
    identifier = targetsToFinalIdentifiers.get(maybeId);
  }

  if (identifier) {
    // we are a footnote def.
    parent.children[index] = {
      type: "footnoteDefinition",
      identifier,
      children: [],
    } as FootnoteDefinition;

    parent.children.splice(index - 1, 1);

    return [SKIP, index];
  }

  // we are a footnote ref.

  // this logic is the same as for visitor that walks the main chapter file.
  let desiredIdentifier = (node.children[0] as Text).value;

  // HACK: asterisks have to be escaped, so let's name them this way. in
  // footnotes, we can take the opportunity to name them slightly
  // differently...
  const asteriskPrefix = "fn-ast";
  if (desiredIdentifier === "*") {
    desiredIdentifier = `${asteriskPrefix}1`;
  }

  let finalIdentifier;

  if (!usedIdentifiers.has(desiredIdentifier)) {
    finalIdentifier = desiredIdentifier;
    usedIdentifiers.add(desiredIdentifier);
  } else {
    if (Number.parseInt(desiredIdentifier)) {
      throw new Error(
        `Conflicting numbered footnote identifier: ${desiredIdentifier}`,
      );
    }
    let i = 2;
    finalIdentifier = desiredIdentifier;
    while (usedIdentifiers.has(finalIdentifier)) {
      finalIdentifier = desiredIdentifier.startsWith(asteriskPrefix)
        ? `${asteriskPrefix}${i}`
        : desiredIdentifier.repeat(i);

      i++;
    }
    usedIdentifiers.add(finalIdentifier);
  }

  targetsToFinalIdentifiers.set(target, finalIdentifier);

  parent.children[index] = {
    type: "footnoteReference",
    identifier: finalIdentifier,
  } as FootnoteReference;

  return SKIP;
});

const md1 = toMarkdown(chap, { extensions: [gfmFootnoteToMarkdown()] });
let md2 = toMarkdown(footnotes, { extensions: [gfmFootnoteToMarkdown()] });

// kludge: extra periods are left in the footnote defs and the whitespace can be
// inconsistent.
md2 = md2.replaceAll(/^(\[\^[^\]]+\]:)\.?\s*/gm, (_, group) => `${group} `);

const finalMd = md1.concat("\n\n", md2);

// for debugging
async function writeMd(mdast: ReturnType<typeof toMdast>, filename: string) {
  const md = toMarkdown(mdast, { extensions: [gfmFootnoteToMarkdown()] });
  await writeFile(join(OUTPUT_DIR, `${basename(filename, ".html")}.md`), md);
}
await writeMd(chap, file1);
await writeMd(footnotes, file2);

await writeFile(join(OUTPUT_DIR, `parts-combined.md`), finalMd);

console.log("done.");

async function loadMungeConvert(filename: string, isFootnotesFile = false) {
  console.log("munging", filename);

  const resolvedFilename = join(INPUT_DIR, filename);

  let inFile = await readFile(resolvedFilename, "utf8");

  // i truly despise this: hast uses parse5, which refuses to tolerate xhtml.
  //
  // at first we were working with a calibre-generated epub, which was more or
  // less normal html (albeit with suboptimal, noisy output).
  //
  // but epubs seem to generally be in xhtml format, which notably supports
  // self-closing tags for all elements. for example, this is valid in xhtml:
  //
  // <a id="whatever" />
  //
  // see discussion here: https://stackoverflow.com/a/206409
  //
  // but parse5 interprets the above example <a> as an opening tag (that is, it
  // ignores the slash at the end), leading to elements that follow the <a>
  // being placed inside of it until the parser encounters a closing </a>.
  // obviously, this leads to a malformed ast.
  //
  // see discussion here: https://github.com/inikulin/parse5/issues/597
  //
  // as a workaround, we can use htmlparser2, which can parse in a tolerant way
  // more similar to a real browser, to roundtrip xhtml to html.
  if (filename.endsWith(".xhtml")) {
    const { parseDocument } = await import("htmlparser2");
    const { default: serialize } = await import("dom-serializer");

    inFile = serialize(parseDocument(inFile, { xmlMode: true }), {
      xmlMode: false,
      selfClosingTags: true,
    });

    // debug
    // await writeFile(
    //   join(OUTPUT_DIR, `${basename(filename, ".xhtml")}.html`),
    //   inFile,
    // );
  }

  const hast = fromHtml(inFile, { fragment: true });

  // retained for testing, but we no longer need the return value.
  collectReferencedUrls(hast, isFootnotesFile);

  // const footnoteIdsToElements = await collectFootnotes(urls[0]);

  return convertToMdast(hast, isFootnotesFile);
}

function collectReferencedUrls(hast: HastRoot, isFootnotesFile = false) {
  const referencedUrls = new Set<string>();
  visit(hast, "element", (node) => {
    if (
      node.tagName === "a" &&
      typeof node.properties.href === "string" &&
      node.properties.href.length > 0 &&
      !node.properties.href.startsWith("http")
    ) {
      referencedUrls.add(node.properties.href.split("#")[0]);
    }
  });

  const urls = [...referencedUrls];
  console.log("referenced urls in file:", urls.join(", "));

  if (isFootnotesFile) {
    if (urls.length > 2) {
      throw new Error(
        `More than two referenced urls found in footnotes file:\n${urls.join(", ")}`,
      );
    }
  } else if (urls.length > 1) {
    throw new Error(
      `More than one referenced url found in chapter:\n${urls.join(", ")}`,
    );
  }

  return urls;
}

function convertToMdast(hast: HastRoot, isFootnotesFile = false) {
  return toMdast(hast, {
    // adapted from
    // https://github.com/syntax-tree/hast-util-to-mdast/tree/52b3d5a715da233d15b711c5475d1cf40480a7cc/lib/handlers
    handlers: {
      p(state, node) {
        const children = state.all(node);

        const cn = node.properties.className;
        if (
          isFootnotesFile &&
          ((typeof cn === "string" && cn.startsWith("footnote")) ||
            (Array.isArray(cn) &&
              cn.some(
                (c) => typeof c === "string" && c.startsWith("footnote"),
              )))
        ) {
          if (typeof node.properties.id !== "string") {
            throw new Error(`unexpected type for id\n${JSON.stringify(node)}`);
          }

          children.unshift({
            type: "html",
            value: `<!-- ${node.properties.id} -->`,
          } as Html);
        }

        if (children.length > 0) {
          const result = {
            type: "paragraph",
            children,
          } as Paragraph;
          state.patch(node, result);
          return result;
        }
      },
      a(state, node) {
        const properties = node.properties ?? {};

        // drop links without an href.
        if (!properties.href || typeof properties.href !== "string") {
          return;
        }

        // the rest of this is the same as the normal handler for `a` nodes.
        const children = state.all(node);
        const result = {
          type: "link",
          url: state.resolve(String(properties.href ?? "") || null),
          title: properties.title ? String(properties.title) : null,
          children,
        } as Link;
        state.patch(node, result);
        return result;
      },
    },
  });
}
