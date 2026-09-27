Firebase JS SDK 12.19.0 browser builds (`firebase-app.js`, `firebase-firestore.js`),
copied from the `firebase` npm package so the site doesn't depend on Google's CDN.
The one change: `firebase-firestore.js` imports `./firebase-app.js` instead of the
gstatic URL.

To update, run `npm install firebase@<version>` and repeat the copy:

    for f in firebase-app.js firebase-firestore.js; do
      sed -e 's#"https://www.gstatic.com/firebasejs/[0-9.]*/firebase-app.js"#"./firebase-app.js"#g' \
          -e '/^\/\/# sourceMappingURL=/d' node_modules/firebase/$f > vendor/firebase/$f
    done
