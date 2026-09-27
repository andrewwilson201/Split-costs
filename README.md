# Split Costs

A small web app for tracking shared spending on a trip and working out who owes whom at the end.

## Features

- **Multiple trips**, each with its own people, expenses and currency symbol.
- **People**: add, rename, or remove the people on the trip.
- **Expenses**: record what it was, the amount, who paid, the date, and
  **which people it is split between**. Tick only the people who shared it,
  e.g. a taxi that only two people took. Expenses can be edited or deleted.
- **Currencies**: each trip has a main currency, and each expense can be in
  any currency. Expenses in another currency are converted at the market
  rate for the day they were paid, which is filled in automatically and can
  be edited. Balances and payments are shown in the main currency. Changing
  the main currency converts existing expenses; rates entered by hand are
  kept and converted through the old main currency.
- **Cover photos**: each trip can have a photo, which fills the background
  whenever the trip is open. Photos are shrunk on the phone to about 200 KB
  and stored with the trip, so no separate file storage is needed.
- **Categories and spending chart**: each expense is sorted into Food,
  Drinks, Activities, Transport, Accommodation, Shopping or Other from its
  description ("Dinner" is Food, "Terrace beer" is Drinks), and the category
  can be changed on the expense. The Spending tab shows a stacked bar per day
  split by category, with category totals and a table view.
- **Settle up**: shows what each person paid, their fair share and their
  balance, then lists the fewest payments needed to even everything out
  (at most *n − 1* payments for *n* people). Use "Copy summary" to paste it
  into a group chat.
- **Shared live**: everyone on the trip sees the same data and can add
  expenses from their own phone. Changes show up for everyone straight away.
  This works either on GitHub Pages with Firebase (no accounts needed) or as
  a shared claude.ai page.

Amounts are calculated in whole cents, so the results never drift from
rounding. When an amount doesn't divide evenly, the leftover cents are spread
one each across the people sharing it.

## Hosting on GitHub Pages with Firebase

The app is hosted free on GitHub Pages and stores trips in Cloud Firestore on
Firebase's free plan. Nobody needs an account: each trip has a long random
link, and anyone who has the link can view and edit that trip. Treat the link
like a shared password and only send it to people on the trip.

### 1. Create the Firebase project (about 5 minutes)

1. Go to https://console.firebase.google.com and click **Create a project**.
   Google Analytics isn't needed.
2. In the left menu, open **Build → Firestore Database** and click **Create
   database**. Pick a location near you and start in **production mode**.
3. Open the **Rules** tab, replace everything with the contents of
   [`firestore.rules`](firestore.rules), and click **Publish**.
   Do this again whenever `firestore.rules` changes.
4. Go to **Project settings** (the gear icon) → **Your apps** and click the
   **Web** icon (`</>`). Register the app with any nickname. Firebase Hosting
   isn't needed.
5. Copy the `firebaseConfig` values it shows into
   [`firebase-config.js`](firebase-config.js), replacing `null`.

These config values aren't secret. They only identify your project, and the
rules decide what anyone can do.

### 2. Turn on GitHub Pages

1. In the GitHub repository, go to **Settings → Pages** and set **Source** to
   **GitHub Actions**.
2. Push to the default branch. The **Deploy to GitHub Pages** workflow runs
   the tests and publishes the site. You can also run it from the **Actions**
   tab. The site address appears in the workflow run and on the Pages
   settings page.

### 3. Share a trip

Open the site, create a trip, and tap **Copy invite link**. Send the link to
everyone on the trip. Each phone remembers the trips it has opened, so after
the first visit the plain site address works too. The address bar always
shows the current trip's link.

Exchange rates are daily mid-market rates from the free
[currency-api](https://github.com/fawazahmed0/exchange-api) project, fetched
from jsDelivr with a Cloudflare Pages mirror as backup. If neither can be
reached, the app asks for the rate to be entered by hand.

The app keeps a copy of the data on each phone, so expenses added without
signal appear straight away and sync once the phone is back online.

## Sharing it as a claude.ai page

The app can also be published as a private claude.ai page with a shared
database (`store.js` uses it automatically when available). To update the published
page after changing the code:

```sh
npm run build:artifact   # writes dist/ in the shape the host expects
```

then republish `dist/index.html` with `styles.css`, `app.js`, `settle.js` and
`store.js` alongside it.

Everyone who uses it needs a Claude account, and the owner shares the page
from its Share menu. People from outside the owner's organization must be
invited by email as **Editors**; with other access levels they can only view.

## Running it locally

It's plain HTML, CSS and JavaScript with no build step and no dependencies.
Browsers won't load ES modules from `file://`, so serve the folder:

```sh
npm start            # or: python3 -m http.server 8000
```

Then open http://localhost:8000. With `firebase-config.js` left as `null`,
the app saves to the browser's `localStorage`, so data stays on that one
device.

## Tests

```sh
npm test
```

The split and settle-up logic lives in `settle.js` and is covered by
`tests/settle.test.js`, using Node's built-in test runner (Node 18+). It
needs no install.

The Firestore security rules have their own tests, which run against the
Firestore emulator (needs Java 11+):

```sh
npm install
npm run test:rules
```
