import { writeFile } from "fs/promises";

// import {toHtml} from 'hast-util-to-html'
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkStringify from "remark-stringify";
import { read } from "to-vfile";
import { unified } from "unified";

const processor = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeRemark, {
    handlers: {
      // svg(state, node) {
      //   const result = { type: "html", value: toHtml(node) };
      //   state.patch(node, result);
      //   return result;
      // },
    },
  })
  .use(remarkStringify);

const inFile = await read("example.html");
const outFile = await processor.process(inFile);

await writeFile("cap.md", String(outFile));
