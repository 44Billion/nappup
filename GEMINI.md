# Project

## General Instructions:

- Use vanilla Javascript.
- Use package.json "imports" aliases for importing files.
- Ensure all new functions and classes have regular comments instead of JSDoc with a brief description.
- Prefer functional programming paradigms where appropriate.
- Use kebab-case for filenames.

## Coding Style:

- Read and use current eslint.config.js rules.
- Avoid using semicolons.
- Prefer single quotes for strings.
- Use camel-case, but regarding JSON fields, you may keep the original key name
when turning it into a variable, even if it's not in camel-case.
- When declaring a function, object/class method or constructor. Add a space between its name and the parentheses.
- When declaring a generator, add a space between the function keyword and its asterisk.
- When using core node imports, add the "node:" prefix, e.g.: `import fs from 'node:fs'`.
- Prefer using promises instead of callbacks.

## Regarding Dependencies:

- Avoid introducing new external dependencies unless absolutely necessary.
- If a new dependency is required, please state the reason.
