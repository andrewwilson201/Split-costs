// Builds dist/index.html for publishing as a shared claude.ai page.
// The host wraps the page in its own <html>/<head>/<body>, so this keeps the
// <title>, stylesheet and body content from index.html and drops the rest.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';

const src = readFileSync('index.html', 'utf8');
const title = src.match(/<title>[\s\S]*?<\/title>/)[0];
const body = src.match(/<body>([\s\S]*)<\/body>/)[1].trim();

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', `${title}\n<link rel="stylesheet" href="styles.css">\n${body}\n`);
for (const f of ['styles.css', 'app.js', 'settle.js', 'store.js', 'currency.js', 'photo.js', 'categories.js', 'households.js', 'firebase-config.js']) copyFileSync(f, `dist/${f}`);
console.log('Built dist/');
