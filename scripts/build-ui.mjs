// Bundles the configure page into a module of strings, so it is served without reading files.
import { build, transform } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const target = ['chrome111', 'safari16.4', 'firefox115'];
const [script, style] = await Promise.all([
  build({
    entryPoints: [fileURLToPath(new URL('ui/configure.tsx', root))],
    bundle: true,
    minify: true,
    write: false,
    format: 'iife',
    target,
    jsx: 'automatic',
    jsxImportSource: 'preact',
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat' },
    legalComments: 'none',
  }).then((result) => result.outputFiles[0].text),
  readFile(new URL('ui/configure.css', root), 'utf8').then(
    async (css) =>
      (await transform(css, { loader: 'css', minify: true, target })).code
  ),
]);

const inline = (text, tag) => text.replaceAll(`</${tag}`, `<\/${tag}`).trim();
await writeFile(
  new URL('src/configure-ui.generated.ts', root),
  `// Built by scripts/build-ui.mjs from ui/.
export const UI_SCRIPT = ${JSON.stringify(inline(script, 'script'))};
export const UI_STYLE = ${JSON.stringify(inline(style, 'style'))};
`
);
console.log(
  `configure page: script ${(script.length / 1024).toFixed(1)} KB, style ${(style.length / 1024).toFixed(1)} KB`
);
