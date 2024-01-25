import { join } from "path";
import { writeFile } from "fs/promises";

// this man can't stop inventing 10-line npm modules that expose 1/8th of a
// useful function, he is unstoppable, there are hundreds of them pointing at
// each other in a complete rat's nest of dependencies and yet more are needed
// for the user to accomplish a single task
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkStringify from "remark-stringify";
import { read } from "to-vfile";
import { unified } from "unified";
import { fromHtml } from "hast-util-from-html";
import { visit } from "unist-util-visit";

import type { Link } from "mdast";

// import { toMdast } from "hast-util-to-mdast";

const INPUT_DIR = "input";

async function munge(filename: string) {
  const resolvedFilename = join(INPUT_DIR, filename);

  const inFile = await read(resolvedFilename);

  // collect all referenced external urls
  const hast = fromHtml(inFile, { fragment: true });

  console.log();

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

  // const tmp = toMdast(hast);
  // console.log(tmp);

  const footnotesFile = await read(join(INPUT_DIR, urls[0]));
  const footnotesHast = fromHtml(footnotesFile, { fragment: true });
  // visit(hast, "element", (node) => {
  //   if (
  //     node.tagName === "a" &&
  //     typeof node.properties.href === "string" &&
  //     node.properties.href.length > 0 &&
  //     !node.properties.href.startsWith("http")
  //   ) {
  //     referencedUrls.add(node.properties.href.split("#")[0]);
  //   }
  // });

  // console.log(footnotesHast.children.slice(0, 10));

  const processor = unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeRemark, {
      // adapted from
      // https://github.com/syntax-tree/hast-util-to-mdast/tree/52b3d5a715da233d15b711c5475d1cf40480a7cc/lib/handlers
      handlers: {
        // html(state, node) {
        //   console.log(node);
        // },
        a(state, node) {
          const properties = node.properties ?? {};

          // modified from original: drop links without an href
          if (!properties.href) return;

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
    })
    .use(remarkStringify);

  const outFile = await processor.process(inFile);

  await writeFile("cap.md", String(outFile));
}

await munge("part0014.html");

console.log("done.");
