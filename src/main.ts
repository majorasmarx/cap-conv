import { join, basename } from "path";
import { readFile, writeFile } from "fs/promises";

import { fromHtml } from "hast-util-from-html";
import { toMdast } from "hast-util-to-mdast";
import { toMarkdown } from "mdast-util-to-markdown";
import { visit, SKIP } from "unist-util-visit";
import { gfmFootnoteToMarkdown } from "mdast-util-gfm-footnote";

import type { Element, Root as HastRoot } from "hast";
import type {
  FootnoteDefinition,
  FootnoteReference,
  Link,
  Root,
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

  const desiredIdentifier = (node.children[0] as Text).value;

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
      finalIdentifier = desiredIdentifier.repeat(i);
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
// FIXME: mostly duplicated from above, turn into function
visit(footnotes, "link", (node, index, parent) => {
  if (!parent || typeof index !== "number") return;

  const [file, target] = node.url.split("#");

  // FIXME: this block is the only part that's different from the above
  // `visit()` block over the main chapter.
  if (file === file1) {
    // simply remove links that return to the main file.
    parent.children.splice(index, 1);
    return SKIP;
  }

  if (file !== file2) {
    throw new Error(`External link to unknown file: "${file}"`);
  }
  if (!target) throw new Error(`No target for link: "${node.url}"`);
  if (node.children.length !== 1 && node.children[0].type !== "text") {
    throw new Error(
      `Unexpected children for link node:\n${JSON.stringify(node)}`,
    );
  }

  const desiredIdentifier = (node.children[0] as Text).value;

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
      finalIdentifier = desiredIdentifier.repeat(i);
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

// now walk the footnotes file and transform intermediate footnote nodes into
// real footnote definitions using the agreed-upon identifiers.
visit(footnotes, "html", (node, index, parent) => {
  if (!parent || typeof index !== "number") {
    throw new Error(`Unexpected structure:\n${JSON.stringify(node)}`);
  }

  const v = node.value;
  if (!v.startsWith("<!-- ") || !v.endsWith(" -->")) {
    throw new Error(`Unexpected HTML node:\n${JSON.stringify(node)}`);
  }
  const maybeId = v.slice(5, -4);

  const identifier = targetsToFinalIdentifiers.get(maybeId);

  if (!identifier) {
    throw new Error(`No reference found to anchor "${maybeId}"!`);
  }

  parent.children[index] = {
    type: "footnoteDefinition",
    identifier,
    children: [],
  } as FootnoteDefinition;

  return SKIP;
});

await writeMd(chap, file1);
await writeMd(footnotes, file2);

const md1 = toMarkdown(chap, { extensions: [gfmFootnoteToMarkdown()] });
const md2 = toMarkdown(footnotes, { extensions: [gfmFootnoteToMarkdown()] });
await writeFile(`parts-combined.md`, md1.concat("\n\n", md2));

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
          if (
            isFootnotesFile &&
            properties.id &&
            typeof properties.id === "string"
          ) {
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
