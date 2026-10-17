import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
const directory = new URL('./', import.meta.url);
const read = name => readFileSync(new URL(name, directory), 'utf8');
const compile = name => ts.transpileModule(read(name), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const model = compile('model.ts').replace(/^export /gm, '');
const app = compile('app.ts').replace(/^import[\s\S]*?from ['"]\.\/model\.js['"];\s*/m, '');
const html = read('index.html')
  .replace('<link rel="stylesheet" href="./style.css" />', () => `<style>${read('style.css')}</style>`)
  .replace('<script type="module" src="./app.ts"></script>', () => `<script type="module">${model}\n${app}</script>`);
mkdirSync(new URL('dist/', directory), { recursive: true });
writeFileSync(new URL('dist/index.html', directory), html);
console.log('Built self-contained chart playground: experiments/binary-chart/dist/index.html');
