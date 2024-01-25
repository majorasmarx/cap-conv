import { join } from "path";
import { readFile, writeFile } from "fs/promises";

import { fromHtml } from "hast-util-from-html";
import { toMdast } from "hast-util-to-mdast";
import { toMarkdown } from "mdast-util-to-markdown";
import { visit } from "unist-util-visit";
import { gfmFootnoteToMarkdown } from "mdast-util-gfm-footnote";

import type { Element } from "hast";
import type { Link } from "mdast";

const INPUT_DIR = "input";

async function munge(filename: string) {
  const resolvedFilename = join(INPUT_DIR, filename);

  const inFile = await readFile(resolvedFilename, "utf8");

  const hast = fromHtml(inFile, { fragment: true });

  // this doesn't appear to get handled by hast-util-to-mdast, so we clean it up
  // by hand.
  if (hast.children[0].type === "comment") {
    hast.children.splice(0, 1);
  }

  // collect referenced external urls
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

  if (urls.length > 1) {
    throw new Error(
      `More than one referenced url found in chapter:\n${urls.join(", ")}`,
    );
  }
  const footnoteIdsToElements = await collectFootnotes(urls[0]);

  const footnoteDefinitions = [];

  const mdast = toMdast(hast, {
    // adapted from
    // https://github.com/syntax-tree/hast-util-to-mdast/tree/52b3d5a715da233d15b711c5475d1cf40480a7cc/lib/handlers
    handlers: {
      a(state, node) {
        const properties = node.properties ?? {};

        // drop links without an href
        if (!properties.href || typeof properties.href !== "string") return;

        const footnoteId = properties.href.split("#")[1];

        if (footnoteId && Object.hasOwn(footnoteIdsToElements, footnoteId)) {
          console.log("it's a footnote!!");
        } else {
          // regular link
          const children = state.all(node);
          const result = {
            type: "link",
            url: state.resolve(String(properties.href ?? "") || null),
            title: properties.title ? String(properties.title) : null,
            children,
          } as Link;

          state.patch(node, result);
          return result;
        }
      },
    },
  });

  const md = toMarkdown(mdast, { extensions: [gfmFootnoteToMarkdown()] });

  await writeFile("cap.md", md);
}

await munge("part0014.html");

console.log("done.");

async function collectFootnotes(filename: string) {
  const fnFile = await readFile(join(INPUT_DIR, filename), "utf8");

  // note fragment: false -- we want to traverse the <body>
  const fnHast = fromHtml(fnFile, { fragment: false });
  const fnHtmlNode = fnHast.children.find(
    (n) => n.type === "element" && n.tagName === "html",
  ) as Element;
  const fnBodyNode = fnHtmlNode.children.find(
    (n) => n.type === "element" && n.tagName === "body",
  ) as Element;

  const footnoteNodes = fnBodyNode.children.map((n) => {
    // example structure:
    //   <p class="EB03BodyTextIndented" id="cap0008005">
    //   <a id="cap0008006" class="calibre1"></a>
    //   <a id="cap0008007" href="part0014.html#cap0001184" class="calibre1">
    //     4
    //   </a>. [[footnote contents]]
    // </p>
    // the <a> without href is the footnote id.
    if (n.type !== "element" || n.tagName !== "p") return null;

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const firstChild = n.children.find(
      (fc) => fc.type === "element",
      // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
    ) as Element | undefined;

    if (
      !firstChild ||
      firstChild.tagName !== "a" ||
      firstChild.properties.href !== undefined ||
      typeof firstChild.properties.id !== "string" ||
      !firstChild.properties.id
    ) {
      return null;
    }

    return [firstChild.properties.id, n] as const;
  });

  const filtered = footnoteNodes.filter((n) => n) as [string, Element][];
  const footnoteIdsToElements = Object.fromEntries(filtered);

  return footnoteIdsToElements;
}
