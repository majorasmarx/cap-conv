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
} from "mdast";

const INPUT_DIR = "input";

const file1 = "part0014.html";
const file2 = "part0070.html";

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

  // early out: simply remove links that return to the main file. they are
  // always backlinks.
  // if (file === file1) {
  //   parent.children.splice(index, 1);
  //   return SKIP;
  // }

  if (file !== file1 && file !== file2) {
    throw new Error(`External link to unknown file: "${file}"`);
  }
  if (!target) throw new Error(`No target for link: "${node.url}"`);
  if (node.children.length !== 1 && node.children[0].type !== "text") {
    throw new Error(
      `Unexpected children for link node:\n${JSON.stringify(node)}`,
    );
  }

  // HACK: calibre generates an incorrect link to the first chapter
  if ((node.children[0] as Text).value === "Chapter 1") {
    parent.children[index] = node.children[0];
    return SKIP;
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
  if (prevSib.type !== "html") {
    throw new Error(
      `Unexpected previous sibling type: ${prevSib.type}. Node:\n${JSON.stringify(node)}`,
    );
  }

  const v = prevSib.value;
  if (!v.startsWith("<!-- ") || !v.endsWith(" -->")) {
    throw new Error(
      `Unexpected non-comment HTML node:\n${JSON.stringify(prevSib)}`,
    );
  }
  const maybeId = v.slice(5, -4);

  const identifier = targetsToFinalIdentifiers.get(maybeId);

  if (identifier) {
    // we are a footnote def.
    parent.children[index] = {
      type: "footnoteDefinition",
      identifier,
      children: [],
    } as FootnoteDefinition;
  } else {
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
  }
  parent.children.splice(index - 1, 1);

  return [SKIP, index];
});

const md1 = toMarkdown(chap, { extensions: [gfmFootnoteToMarkdown()] });
let md2 = toMarkdown(footnotes, { extensions: [gfmFootnoteToMarkdown()] });

// kludge: extra periods are left in the footnote defs.
md2 = md2.replaceAll(/^(\[\^[^\]]+\]:)\./gm, (_, group) => group);

const finalMd = md1.concat("\n\n", md2);

// for debugging
await writeMd(chap, file1);
await writeMd(footnotes, file2);

await writeFile(`parts-combined.md`, finalMd);

console.log("done.");

async function loadMungeConvert(filename: string, isFootnotesFile = false) {
  console.log("munging", filename);

  const resolvedFilename = join(INPUT_DIR, filename);

  const inFile = await readFile(resolvedFilename, "utf8");

  const hast = fromHtml(inFile, { fragment: true });

  // the opening namespace tag <?xml... doesn't appear to get handled by
  // hast-util-to-mdast, so we clean it up by hand.
  if (hast.children[0].type === "comment") {
    hast.children.splice(0, 1);
  }

  // retained for testing, but we no longer need the return value.
  collectReferencedUrls(hast, isFootnotesFile);

  // const footnoteIdsToElements = await collectFootnotes(urls[0]);

  return convertToMdast(hast, isFootnotesFile);
}

async function writeMd(mdast: ReturnType<typeof toMdast>, filename: string) {
  const md = toMarkdown(mdast, { extensions: [gfmFootnoteToMarkdown()] });
  await writeFile(`${basename(filename, ".html")}.md`, md);
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
      a(state, node) {
        const properties = node.properties ?? {};

        // links without an href:
        if (!properties.href || typeof properties.href !== "string") {
          // if we're in a footnotes file and it's an anchor (ie. it has an id)
          // convert it to a comment. we'll use that in the next ast pass.
          //
          // we don't convert them to footnote definitions immediately since it
          // involves manipulating more than one node (the href-less,
          // content-less <a> tag, where we are now, and its immediate sibling,
          // which is an <a> tag with an href).
          //
          // the handler definition we're in right now doesn't allow
          // manipulating multiple nodes at once -- it's only concerned with how
          // to convert the node it's presently visiting.
          //
          // on the other hand, we can't just skip this step -- otherwise the
          // conversion from html ast to md ast will generate nonsense for these
          // <a> tags without hrefs. so we need to convert them to an
          // intermediate format for now.
          if (
            isFootnotesFile &&
            properties.id &&
            typeof properties.id === "string"
          ) {
            // this is a huge headache. we need to preserve all anchors since
            // some of them will be converted to footnote definitions.
            //
            // but there are also some anchors that are useless, since they are
            // not footnote defitions and instead precede footnote *references*
            // (that is, they are a link to a footnote, not a footnote itself).
            //
            // we don't have enough context to determine which is which right
            // now -- footnote definition anchors are the first sibling in the
            // group, but some footnote reference anchors are the first sibling
            // in a group as well.
            //
            // the only way to determine whether something is a footnote
            // definition is to see whether something has *already referenced
            // its id* -- whether there's a footnote ref above it that is
            // pointing to it.
            // const sibs = parent!.children;
            // const next = sibs[sibs.indexOf(node) + 1];
            // if (
            //   next.type !== "element" ||
            //   next.tagName !== "a" ||
            //   typeof next.properties.href !== "string"
            // ) {
            //   throw new Error(
            //     `Unexpected anchor without link sibling:\n${JSON.stringify(node)}`,
            //   );
            // }

            // const [file, target] = next.properties.href.split("#");

            // const result = {
            //   type: "html",
            //   value: `<!-- ref[${properties.id},${file},${target}] -->`,
            // } as Html;
            const result = {
              type: "html",
              value: `<!-- ${properties.id} -->`,
            } as Html;
            state.patch(node, result);
            return result;
          }
          // otherwise drop it.
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
