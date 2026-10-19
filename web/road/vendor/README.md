`marked.js` is the unchanged ESM distribution of Marked 18.0.11, copied from
`marked/lib/marked.esm.js` in the existing lockfile installation. License: MIT,
see `marked.LICENSE`. Source: https://github.com/markedjs/marked/tree/v18.0.11

It runs locally with the app's existing CSP. `../markdown.js` uses its lexer
only, building allowed DOM elements without inserting the parser's HTML output.
