import { join } from "path";
import { readFile, writeFile } from "fs/promises";

import { fromHtml } from "hast-util-from-html";
import { toMdast } from "hast-util-to-mdast";
import { toMarkdown } from "mdast-util-to-markdown";
import { visit } from "unist-util-visit";
import { gfmFootnoteToMarkdown } from "mdast-util-gfm-footnote";

import type { Element } from "hast";
import type { FootnoteDefinition, FootnoteReference, Link, Root } from "mdast";

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

  const footnoteDefinitions: FootnoteDefinition[] = [];

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
          const identifier = String(footnoteDefinitions.length + 1);

          const result = {
            type: "footnoteReference",
            identifier,
          } as FootnoteReference;

          footnoteDefinitions.push({
            type: "footnoteDefinition",
            identifier,
            children: state.all(footnoteIdsToElements[footnoteId]) as any,
          });

          state.patch(node, result);
          return result;
        }

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
      },
    },
  });

  (mdast as Root).children.push(...footnoteDefinitions);

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

    const i = n.children.findIndex((fc) => fc.type === "element");

    if (i === -1) return null;

    const firstChild = n.children[i] as Element;

    if (
      !firstChild ||
      firstChild.tagName !== "a" ||
      firstChild.properties.href !== undefined ||
      typeof firstChild.properties.id !== "string" ||
      !firstChild.properties.id
    ) {
      return null;
    }

    const identifier = firstChild.properties.id;

    const newNode = { ...n };

    // remove whitespace
    const children = newNode.children
      .filter((c) => c.type !== "text" || c.value.trim().length > 0)
      .map((c) => {
        if (c.type !== "text") return c;

        let value = c.value.trim();
        if (value.startsWith(".")) {
          value = value.slice(1);
        }

        return {
          ...c,
          value: value
            .split("\n")
            .map((l) => l.trim())
            .join(" "),
        };
      });
    newNode.children = children;

    // FIXME: this is wrong and fragile, happens to work because footnotes all
    // open with whitespace nodes that are filtered in the previous step
    children.splice(i, 1);

    return [identifier, newNode] as const;
  });

  const filtered = footnoteNodes.filter((n) => n) as [string, Element][];
  const footnoteIdsToElements = Object.fromEntries(filtered);

  return footnoteIdsToElements;
}
