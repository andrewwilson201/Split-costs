# Split Costs

A small web app for tracking shared spending on a trip and working out who owes whom at the end.

## Features

- **Multiple trips**, each with its own people, expenses and currency symbol.
- **People**: add, rename, or remove the people on the trip.
- **Expenses**: record what it was, the amount, who paid, the date, and
  **which people it is split between**. Tick only the people who shared it,
  e.g. a taxi that only two people took. Expenses can be edited or deleted.
- **Settle up**: shows what each person paid, their fair share and their
  balance, then lists the fewest payments needed to even everything out
  (at most *n − 1* payments for *n* people). Use "Copy summary" to paste it
  into a group chat.
- Data is saved automatically in the browser (`localStorage`).

Amounts are calculated in whole cents, so the results never drift from
rounding. When an amount doesn't divide evenly, the leftover cents are spread
one each across the people sharing it.

## Running it

It's plain HTML, CSS and JavaScript with no build step and no dependencies.
Browsers won't load ES modules from `file://`, so serve the folder:

```sh
npm start            # or: python3 -m http.server 8000
```

Then open http://localhost:8000. It can also be hosted as-is on any static
host, such as GitHub Pages.

## Tests

```sh
npm test
```

The split and settle-up logic lives in `settle.js` and is covered by
`tests/settle.test.js`, using Node's built-in test runner (Node 18+).
