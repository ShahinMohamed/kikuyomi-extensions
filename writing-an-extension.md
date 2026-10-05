# Writing a Kikuyomi source extension

A complete, self-contained guide. Everything an extension needs to know is here: the two files you
write, the contract every method obeys, the host API you are allowed to call, the rules that fail a
call, and the loop for installing and reloading. You should not need to read the app's source to
write an extension, and this document is written so that someone — or something — with no access to
this repository can work from it alone.

The authority for the contract is [`docs/source-api-1.0.md`](source-api-1.0.md). Where this guide and
that document disagree, that document is right. The worked example to copy from is
[`app/assets/extensions/librivox/main.js`](../app/assets/extensions/librivox/main.js), which is a real
extension for a real site, written by hand against this same contract.

---

## 1. What you are building

An extension is a **folder** holding two files:

```
my-extension/
├── manifest.json     what the app knows before running any code
└── main.js           one ES2020 file, no imports, no build step required
```

The app reads the manifest without running a line of your code — that is how it can list hundreds of
sources cheaply — and starts your JavaScript only when someone opens one of your sources. Each
extension runs in its own QuickJS runtime in its own worker isolate, with a 64 MB memory ceiling and a
30-second deadline per call.

One extension may declare several **sources**. A source is one browsable catalogue: one site, or one
language of one site. Most extensions have exactly one.

---

## 2. The five rules that will bite you first

Read these before writing anything. Each one costs an hour if you learn it from a failure instead.

**1. This is QuickJS, not Node and not a browser.** There is no `require`, no `import`, no
`module` system to build against, no filesystem, no `process`, no DOM, and **no global `fetch`**. The
contract guarantees **ES2020 and nothing later**. So `?.`, `??`, `async`/`await`, template literals,
classes, `Promise.allSettled` and `String.matchAll` are all fine. Do **not** use `String.replaceAll`,
`Array.prototype.at`, `Object.hasOwn`, `Array.findLast`, logical assignment (`||=`, `&&=`, `??=`),
top-level `await`, or anything else from ES2021 onward. You will find out at runtime, not at build
time.

**2. Everything you return is validated, strictly.** The app decodes your result into typed Dart
objects. One field that breaks one rule fails that whole call with a `Parse` error and writes nothing
to the library. Section 8 lists every rule. The most common mistakes: a control character in a string,
a fractional number where a whole one is required, a URL whose host is not in your manifest's
`domains`, and two chapters sharing a key.

**3. Only plain data crosses the boundary.** Objects, arrays, strings, finite numbers, booleans and
`null`. No `Date`, no `Map`, no `Set`, no class instances, no functions, and never `undefined` *inside
an array*. `undefined` as the value of an optional field is fine — it arrives as `null`, which means
absent.

**4. You may only contact the domains your manifest declares.** This applies to `http.fetch`, to
every media URL you return, to `coverUrl` and to `webUrl`. IP addresses and `localhost` are never
allowed, in a URL or in `domains`. The domains list is what the app shows a listener before they
install you, so it is a promise, not a hint.

**5. Keys are identities and must never change.** The app identifies a book by `(source, bookKey)`, a
chapter by `(book, chapterKey)` and a file by `(book, fileKey)`. If your keys change between versions,
every listener's progress and bookmarks detach from their books. Use the site's own numeric ids or
stable paths. Never a title. Never a URL that carries a token or an expiry.

---

## 2b. What a package holds

Three files, flat, with no folder around them (§3.3):

```
manifest.json     required
main.js           required, your bundled code
icon.png          optional, and worth doing
```

**`icon.png` is how your extension gets its own face.** Without one the app draws a puzzle piece,
which is the same puzzle piece every other extension without one gets, and a listener with a dozen
installed cannot tell them apart. It is read from the package at install and drawn from disk
afterwards, so it costs no network and works offline.

A square PNG. 512×512 is plenty and 256×256 is enough; the app rounds the corners itself, so supply
a plain square and let it do that. Keep it under a megabyte for a package nobody minds downloading.

If you list it in `files`, it is hashed at install exactly as `main.js` is, and a package that names
an icon it does not contain is refused. Leave it out of `files` while you are developing, as you do
for `main.js`.

---

## 3. `manifest.json`

```json
{
  "id": "org.example.mysite",
  "name": "My Site",
  "version": "1.0.0",
  "versionCode": 1,
  "apiVersion": "1.0",
  "minAppVersion": "1.0.0",
  "author": "Your Name",
  "contentRating": "everyone",
  "domains": ["example.org", "*.example.org", "cdn.example.net"],
  "capabilities": ["latest", "filters", "imageRequest"],
  "sources": [
    { "key": "mysite", "name": "My Site", "lang": "en", "versionId": 1 }
  ]
}
```

| Field | Rules |
|---|---|
| `id` | Required. A reversed domain name: lower-case letters, digits, dots, dashes, underscores, at least two dot-separated parts, at most 128 characters. Never changes for the life of the extension. |
| `name` | Required. What the listener sees. |
| `version` | Required. One to four whole numbers, dot-separated, no leading zeros: `1`, `1.4`, `1.4.0`. Shown to the listener. |
| `versionCode` | Required. A whole number ≥ 1. **This**, not `version`, is what orders releases. Bump it on every release. |
| `apiVersion` | Required. `"1.0"` today. `MAJOR.MINOR`, no leading zeros. |
| `minAppVersion` | Required. The oldest Kikuyomi that may run this. `"1.0.0"` unless you need something newer. |
| `author` | Optional. |
| `contentRating` | Optional, defaults to `everyone`. One of `everyone`, `mature`, `adult`. **Anything the app does not recognise is read as `adult`** — the most restrictive value — so spell it correctly. |
| `domains` | Required, a list (may be empty for a source that fetches nothing). Each entry is a host name of **at least two labels**, no scheme, no port, no path. A wildcard is only a leading `*.`, and `*.example.org` matches subdomains at any depth **but not `example.org` itself** — list both if you need both. `*.com` is refused. No IP addresses, no `localhost`. At most 100. Internationalised names must be in `xn--` form. |
| `capabilities` | Optional. Only three mean anything to the app: `latest`, `filters`, `imageRequest`. Declare a capability **only if** the matching optional method exists, and implement the method if you declare it. A manifest that over-claims costs a wasted tab; one that under-claims means the app never calls your method. |
| `sources` | Required, at least one, at most 100. |
| `files` | **Optional, and you can leave it out entirely while developing.** It maps file names to `"sha256-<base64>"`. A folder install does not check it, on purpose: in a folder you are editing, a hash records the `main.js` you had *before* your last save. It starts mattering when a repository serves your extension. |

Each entry in `sources`:

| Field | Rules |
|---|---|
| `key` | Required. The property name your module exports this source under. 1–512 characters, no control characters. Must be unique within the manifest. |
| `name` | Required. What the listener sees in the source list. |
| `lang` | Required. A BCP 47 tag (`en`, `pt-BR`), or `multi` for a catalogue that is not one language. |
| `versionId` | Required. A whole number ≥ 1. **Bump this only when your book or chapter keys stop being compatible** — it changes the source's identity and triggers a migration for anyone's library. Never bump it for an ordinary update. |

---

## 4. `main.js`: the module shape

One file. No imports. Export an object whose `sources` map matches your manifest's source keys.

```js
'use strict';

var mysite = {
  // required
  getPopular: function (page) { /* → PageResult<BookSummary> */ },
  search: function (query, page) { /* → PageResult<BookSummary> */ },
  getBookDetails: function (bookKey) { /* → BookDetails */ },
  getChapters: function (bookKey) { /* → ChapterInfo[] */ },
  resolveMedia: function (chapterRef, ctx) { /* → MediaResolution */ },

  // optional — only if the manifest declares the matching capability
  getLatest: function (page) { /* → PageResult<BookSummary>, capability "latest" */ },
  getFilters: function () { /* → Filter[], capability "filters" */ },
  getImageRequest: function (url) { /* → HttpRequest, capability "imageRequest" */ }
};

module.exports = { sources: { mysite: mysite } };
```

`module.exports` is what the reference extension uses and is known to work. `export default` and
`exports.default` also resolve — the app finds the default export in whichever shape a bundler leaves
it. Any method may return a value or a `Promise` of one; the app awaits either.

Pages are numbered **from 1**.

---

## 5. The host API

Everything your extension can do is on the global `kikuyomi` object. There is nothing else. Every
call is asynchronous except `host`.

```js
var http = kikuyomi.http, html = kikuyomi.html, log = kikuyomi.log;
var storage = kikuyomi.storage, crypto = kikuyomi.crypto, host = kikuyomi.host;
```

### `http`

```ts
http.fetch(request: {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string                  // POST only
  responseType?: 'text' | 'json' | 'bytes'
}): Promise<{
  status: number                 // any status, including 404 and 500
  url: string                    // the final URL after redirects
  headers: Record<string, string>
  body: string | unknown | ArrayBuffer
}>
```

Only a failure to connect throws (as `Network`); a 404 or a 500 comes back for you to interpret. The
app sets the User-Agent and you cannot change it. Each extension gets its own cookie jar and its own
rate limiter. Response bodies are capped at 10 MB. Redirects are followed one hop at a time and every
hop is checked against your `domains`.

### `html`

```ts
html.parse(text: string, baseUrl?: string): Promise<HtmlDocument>

interface HtmlElement {
  select(css: string): HtmlElement[]
  selectFirst(css: string): HtmlElement | null
  text(): string                            // whitespace collapsed
  attr(name: string): string | null
  absUrl(attrName: string): string | null   // resolved against baseUrl
  html(): string
}
```

Page scripts never run; this is parsing, not a browser.

**A parsed document lives only for the call that parsed it.** When your `getChapters` returns, every
document it parsed is let go. Hold one in a variable outside the call and the next call to touch it
fails with *"that document has been let go; a parsed document lives until the call that parsed it
ends"*. This is not negotiable and not a bug: a parsed tree is tens of megabytes of the runtime's
64 MB, and nothing in the contract frees one, so the host frees them all when a call ends.

The consequence for caching: **cache the data you extracted, or the response text — never the
document**. See "the one optimisation worth making early" in §9.

One call may hold **16 documents** at once. A scraper parses a page, reads it and moves on, so this
only binds if you are parsing in a loop and keeping every result.

**These selectors throw, they do not return a wrong answer:** `:has()`, `:nth-child()`,
`:nth-last-child()`, `:nth-of-type()`, `:only-of-type`, `:empty`. The app's HTML parser gets them
silently wrong, so the contract refuses them outright. Everything else in normal CSS selector use
works: tags, `.class`, `#id`, `[attr]`, `[attr="value"]`, `[attr^=`/`$=`/`*=`, descendant, child
(`>`), sibling (`+`, `~`), `:first-child`, `:last-child`, `:not()`, and comma-separated lists.

Pass `baseUrl` — usually the response's `url` — so `absUrl('href')` resolves relative links for you.

### `storage`

```ts
storage.get(key: string): Promise<string | null>
storage.set(key: string, value: string): Promise<void>
storage.remove(key: string): Promise<void>
```

Strings only, 1 MB total per extension, and `set` throws when that would be exceeded. It survives
restarts. Use it for a cached category list or a site token; do not use it as a database, and never
put a secret in it that you would mind being read off the device.

### `log`

```ts
log.debug(message: string); log.info(message: string)
log.warn(message: string); log.error(message: string)
```

Goes to the in-app extension console (Browse → Extensions → the terminal icon), which is your primary
debugging tool. Rate-limited to 100 messages per 10 seconds per extension; over that, messages are
dropped and one line says how many. Strings only — stringify objects yourself.

### `crypto`

```ts
crypto.hash(alg: 'md5'|'sha1'|'sha256'|'sha512', data: string | ArrayBuffer): Promise<string>
crypto.hmac(alg: 'sha1'|'sha256'|'sha512', key, data): Promise<string>
crypto.base64Encode(data: string | ArrayBuffer): Promise<string>
crypto.base64Decode(text: string): Promise<ArrayBuffer>
crypto.aesDecrypt({ mode: 'cbc'|'gcm'|'ctr', key, iv, data }): Promise<ArrayBuffer>
```

For reading a site's own obfuscated responses. **Never for media, and never for DRM.**

### `host`

```ts
host.apiVersion: string    // "1.0"
host.appVersion: string
host.has(feature: string): boolean
```

Synchronous. Use `host.has()` to probe for a feature a later minor version added, rather than assuming
it exists.

### The prelude

The app also gives you `setTimeout`, `clearTimeout`, `TextEncoder`, `TextDecoder`, `URL`,
`URLSearchParams`, `atob`, `btoa` and a `console` that writes to the extension log. `URL` and
`URLSearchParams` are the app's own, so they parse the way the app parses — use them for building
query strings rather than concatenating.

---

## 6. The data you return

### `BookSummary` — for lists

```ts
{
  key: string            // required, stable
  title: string          // required
  coverUrl?: string
  authors?: string[]
  narrators?: string[]
  durationMs?: number
}
```

### `PageResult<T>` — what every list method returns

```ts
{ items: T[], hasNextPage: boolean }
```

`hasNextPage` is what drives infinite scroll. Get it right: `true` when there is another page,
`false` on the last one. At most 200 items per page; 30–50 is a sensible page size.

### `BookDetails` — for one book

```ts
{
  key: string                  // required
  title: string                // required
  subtitle?: string
  authors: string[]            // REQUIRED (may be empty), in credit order
  narrators: string[]          // REQUIRED (may be empty), in credit order
  series?: { name: string, index?: number }    // index may be fractional: 2.5
  description?: string         // plain text, line breaks kept — unwind HTML yourself
  coverUrl?: string
  genres: string[]             // REQUIRED (may be empty)
  language?: string            // BCP 47 tag; a site's "English" is dropped, so map it
  publisher?: string
  publishedDate?: string       // as the site writes it: "1851", "1851-10", "1851-10-18"
  isbn?: string
  abridged?: boolean
  totalDurationMs?: number
  status: 'complete' | 'ongoing' | 'unknown'   // REQUIRED
  contentRating?: 'everyone' | 'mature' | 'adult'
  webUrl?: string              // the book's page, for "open in browser"
}
```

`authors`, `narrators`, `genres` and `status` are **required** — use `[]` and `'unknown'` rather than
leaving them out. Note that `status: 'unknown'` is read as *the source did not say*, so a book that
was `complete` before stays `complete`; you cannot take a status back once you have given one.

### `ChapterInfo[]` — the book's contents

```ts
{
  key: string            // required, stable, unique within the book
  title: string          // required
  durationMs?: number    // give it whenever you know it — see below
  publishedAt?: number   // epoch ms, for serials
  group?: string         // a part or volume heading: "Part One"
}
```

**Return them in listening order.** The array's order *is* the book's order.

**Give `durationMs` if you possibly can.** Before a chapter is resolved, the app treats it as one file
of `durationMs`, marked an estimate, which is what lets the whole book be shown, scrubbed and resumed
before anything has been fetched. A chapter with no duration still plays, but the book's total length
and every chapter after it are unknown until it has been resolved.

### `MediaResolution` — where the audio actually is

`resolveMedia({ bookKey, chapterKey }, { purpose, network })` is called **just in time**, when the app
is about to play or download that chapter. `purpose` is `'stream'` or `'download'`; `network` is
`'wifi'`, `'cellular'` or `'unknown'`.

```ts
{
  segments: MediaSegment[]    // required, at least one, played in order
  expiresAt?: number          // epoch ms; after this the app resolves again
}

MediaSegment = {
  fileKey: string             // required, stable; chapters sharing a file share this key
  request: HttpRequest        // required
  format?: 'mp3'|'m4a'|'m4b'|'aac'|'flac'|'ogg'|'opus'|'hls'|'unknown'
  range?: { startMs: number, endMs?: number }   // this chapter's part of the file
  durationMs?: number         // the whole file's length
  sizeBytes?: number
  variants?: { label: string, bitrateKbps?: number, request: HttpRequest }[]
}
```

This one shape covers every audiobook layout:

| The book is… | What you return |
|---|---|
| one file per chapter | one segment, no `range` |
| one M4B with 30 chapters | 30 chapters, each one segment with **the same `fileKey`** and a different `range`. The app downloads the file once. |
| a chapter split over 3 files | three segments, in order, no `range` |
| a single file with no chapter list | one chapter covering the whole file. After probing, the app shows the file's embedded markers as chapters. |
| URLs that expire | set `expiresAt`; the app re-resolves rather than failing |

Use `headers` on the `request` when the site needs a referer or a token. Do not put an expiring URL in
a `fileKey`.

### `ChapterContent` — what a chapter says, for a text source (1.1)

A source can offer books to **read** instead of books to listen to. Declare it in the manifest, and
target 1.1 — a `"text"` source is refused in a manifest that targets 1.0, because a 1.0 app would
call `resolveMedia` on it:

```json
"apiVersion": "1.1",
"sources": [
  { "key": "novels", "name": "Novels", "lang": "en", "versionId": 1, "kind": "text" }
]
```

A text source implements everything an audio source does **except `resolveMedia`**, and implements
`getChapterContent` instead:

```js
async getChapterContent({ bookKey, chapterKey }) {
  const page = await http.fetch({ url: chapterUrl(bookKey, chapterKey), responseType: 'text' });
  const doc = await html.parse(page.body, page.url);
  return { html: doc.selectFirst('.chapter-body').html(), baseUrl: page.url };
}
```

Return exactly one of:

```ts
{ html: string, baseUrl?: string }   // the chapter's markup, and the page it came from
{ text: string }                     // plain text
```

**You hand over markup; the app does not show it.** It is converted, in the app, into paragraphs,
headings, quotations, lists, scene breaks, preformatted text and images, with bold, italic and line
breaks inside them. Everything else is dropped — scripts, styles, forms, frames and navigation go
entirely, content included, and every other element keeps only its text. No attribute is read but an
image's `src`, `data-src` and `alt` and a list's `start`. So strip the page's chrome if you like, but
there is nothing to gain from sanitising: it is done for you, and it is not optional.

- A paragraph that is only `* * *`, `***`, `#` or `~ ~ ~` becomes a scene break.
- An image is kept only if its address — resolved against `baseUrl` when you give one — is on a host
  you declared. One that is not is quietly left out; the chapter's words are kept.
- Plain text with blank lines between paragraphs is read as hard-wrapped, so single newlines become
  spaces. Plain text with no blank lines at all is read as one paragraph per line.
- A chapter may be at most 4 MB of characters and make at most 20,000 blocks.

An empty chapter is `{ html: '' }`, not an error. Throw `NotFound` for a chapter that is gone.

### `resolveBook(bookKey)` — a book that is one file (1.2)

Most free-ebook sites publish a book as one EPUB and nothing else: a page about the book, a download
link, and no per-chapter text anywhere. There is nothing for `getChapterContent` to fetch. Such a
source says where the file is instead, and the app reads it with the same reader it uses for a book
added from the device.

Declare it in the manifest, and target 1.2 — `bookFile` is refused in an older manifest, because an
app that ignored it would read your source as one whose chapters it can ask for and find none:

```json
{
  "apiVersion": "1.2",
  "capabilities": ["bookFile"],
  "sources": [{ "key": "novels", "name": "Novels", "lang": "en", "versionId": 1, "kind": "text" }]
}
```

```ts
async resolveBook(bookKey) {
  return {
    request: { url: `https://example.org/books/${bookKey}.epub` },
    format: 'epub',       // the only one so far; left out means the same
    sizeBytes: 482113     // optional, so the size can be shown before the download
  }
}
```

- Only a **text** source may declare it, and such a source implements `resolveBook` **instead of**
  `getChapterContent`, not as well.
- **`getChapters` is not called for your source.** The chapters are the ones inside the file, read
  from its spine, so a list of your own would be a list whose entries could not be opened. You still
  implement `getBookDetails`, and the title, author, cover and description come from you.
- The URL is held to your `domains` like every other one you hand over.
- A book locked with DRM is refused when the file is read, the same way a locked file added from the
  device is. There is no way in through this door either.

### `Filter[]` — the search controls, if you declare `filters`

```ts
{ kind: 'header', label }
{ kind: 'separator' }
{ kind: 'text', key, label, default? }
{ kind: 'checkbox', key, label, default? }
{ kind: 'tristate', key, label, default? }        // 'ignore' | 'include' | 'exclude'
{ kind: 'select', key, label, options, default? }  // options: { value, label }[]
{ kind: 'sort', key, label, options, default? }    // default: { value, ascending }
{ kind: 'group', label, filters }                 // one level deep only
```

`search(query, page)` receives `query.text` (possibly empty) and `query.filters`, **keyed by your
filter keys, holding only the filters the listener changed from their defaults.** At most 100 filters
counting headers, separators, groups and their contents; at most 1,000 options each; a select and a
sort each need at least one option, and a `default` must be one of them.

### `getImageRequest(url)` — if you declare `imageRequest`

Return an `HttpRequest` for fetching a cover: the same URL plus whatever referer, token or cookie the
site demands. Declare the capability only if you need it; without it, covers are fetched plainly and
your code is never called.

---

## 7. Errors

Throw an object carrying a `kind`. The app reacts to the kind; your `message` is shown underneath as
detail, never as the explanation, because it comes from a third party and is written for whoever is
debugging the extension.

```js
function sourceError(kind, message, extra) {
  var error = new Error(message);
  error.kind = kind;
  if (extra) {
    for (var field in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, field)) error[field] = extra[field];
    }
  }
  return error;
}

// throw sourceError('NotFound', 'book 42 is gone');
// throw sourceError('RateLimited', 'slow down', { retryAfterMs: 30000 });
// throw sourceError('ChallengeRequired', 'captcha', { url: 'https://example.org/check' });
```

| `kind` | Extra fields | What the app does |
|---|---|---|
| `Network` | | Retries with backoff; counts against your extension's health |
| `Parse` | | Retries once; counts against health |
| `NotFound` | | Marks that book or chapter unavailable |
| `RateLimited` | `retryAfterMs?` | Backs off and pauses this source's download queue |
| `SourceOutdated` | | Tells the listener the extension needs updating |
| `ChallengeRequired` | `url` (required) | Offers "open in browser" so the listener can pass the check |
| `LoginRequired` | | Says the source needs a login the app cannot do yet |

**Anything else thrown — including a plain `Error` — is treated as `Parse`.** A `ChallengeRequired`
without a usable `url` becomes `Parse`, because the app could not act on it.

Two judgement calls worth getting right:

- An empty result is **not** an error. A search that matches nothing is `{ items: [], hasNextPage:
  false }`. Throwing `NotFound` for an empty search page makes the app mark things unavailable.
- A site that answers `200` with an error body is still that site's answer. Decide per endpoint what
  it means: an empty page for a list, `NotFound` when you asked for one specific book.

---

## 8. What fails a call

These are the decoder's rules, beyond the types above. Every one of them fails the whole call with
`Parse` and writes nothing.

**Absent vs missing.** An optional field may be omitted, `undefined` or `null` — all three mean
absent. A **required** field that is missing or `null` fails the call.

**Unknown fields are ignored**, so extra properties are harmless.

**Text.** Lengths count UTF-16 code units (JavaScript's `.length`). Text is trimmed. Short text is one
line — tabs and newlines fold to single spaces. A description keeps line breaks (`\r\n` and `\r`
become `\n`). **Any other control character — U+0000–U+001F or U+007F — fails the call.** Strip them.
Characters above that are kept, mojibake included. Optional text that is empty after trimming is
treated as absent; required text may not be empty. Empty entries in `authors`, `narrators` or `genres`
are dropped rather than failing.

**Keys** — book, chapter, file, filter `key`, option `value` — are taken **exactly** as written: never
trimmed, never case-folded. A key may hold **no** control character, tabs and newlines included.

**Numbers.** Every number is a whole number except `series.index`. It must be finite and within
±(2^53 − 1); a fraction, `NaN`, `Infinity` or anything larger fails the call. Durations, sizes,
bitrates and positions may not be negative, and **`0` is read as "not known"** — so leave a field out
rather than sending `0`. Times must be within ±8,640,000,000,000,000 ms. `series.index` is finite,
non-negative, and may be fractional.

**Enumerations.** An unknown `format` reads as `unknown`, an unknown `status` as `unknown`, an unknown
`contentRating` as **`adult`**. Every *other* unknown enumerated value — a filter `kind`, a `method`, a
tri-state — fails the call.

**Duplicates.** Two chapters of one book may not share a key (progress would land on whichever was
written last). A book key repeated within one page keeps its first appearance and drops the rest. Two
filters may not share a key, groups included; two options of one filter may not share a value; two
header names may not differ only in case.

**Language.** A `language` that is not shaped like a BCP 47 tag is **dropped, not failed** — so a
site's `"English"` simply vanishes. Map site language names to tags yourself. What survives is
normalised: `en-US`, `pt-BR`.

**URLs.** Absolute, `http` or `https`, no username or password, no control characters, no backslash,
no leading or trailing space, port 1–65535 if present, and a host your `domains` allow. Never an IP
address or `localhost`. This covers `coverUrl`, `webUrl`, every `request.url` including variants and
`getImageRequest`, and `ChallengeRequired.url`. A bad URL in `coverUrl` or `webUrl` fails the call —
the domain rule is the promise the permissions screen makes, so it is not softened.

**Headers.** A name is an HTTP token, 1–256 characters; a value is at most 8,192 characters with no
control character but tab. `Host`, `Content-Length`, `Connection` and `Transfer-Encoding` are
forbidden, case-insensitively. At most 50 headers.

**Media.** At least one segment. `range.endMs` must be after `range.startMs`. A `body` belongs only to
a `POST`.

### Limits

| What | Limit |
|---|---|
| Any key | 1–512 characters |
| Title, label, name, other short text | 1,000 characters |
| Description | 20,000 characters |
| Items in one page | 200 |
| Authors, narrators or genres per book | 200 each |
| Chapters per book | 20,000 |
| Segments per chapter | 2,000 |
| Variants per segment | 10 |
| Filters (including inside groups) | 100 |
| Options per select/sort | 1,000 |
| Headers per request | 50 |
| Request body | 1 MB of text |
| Response body | 10 MB |
| One call to the extension | 30 seconds |
| Runtime memory | 64 MB |
| `storage` per extension | 1 MB |

---

## 9. A complete skeleton

This is a working shape for an HTML site. Replace the selectors and the URL building; the structure,
the error handling and the shapes are the parts to keep.

```js
'use strict';

var BASE = 'https://example.org';
var PAGE_SIZE = 40;

var http = kikuyomi.http;
var html = kikuyomi.html;
var log = kikuyomi.log;

// ------------------------------------------------------------------ helpers

function sourceError(kind, message, extra) {
  var error = new Error(message);
  error.kind = kind;
  if (extra) {
    for (var field in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, field)) error[field] = extra[field];
    }
  }
  return error;
}

/** Trimmed text with control characters removed, or '' — safe to hand to the app. */
function clean(value) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
              .replace(/[\t\n\r]+/g, ' ')
              .trim();
}

/** Seconds to whole milliseconds, or undefined when there is no usable figure. */
function msFromSeconds(value) {
  var seconds = typeof value === 'number' ? value : parseInt(clean(value), 10);
  if (!isFinite(seconds) || seconds <= 0) return undefined;
  return Math.round(seconds) * 1000;
}

/** "1:23:45" or "12:34" to milliseconds. */
function msFromClock(text) {
  var parts = clean(text).split(':').map(function (p) { return parseInt(p, 10); });
  if (!parts.length || parts.some(function (p) { return !isFinite(p); })) return undefined;
  var seconds = parts.reduce(function (total, p) { return total * 60 + p; }, 0);
  return seconds > 0 ? seconds * 1000 : undefined;
}

/** Fetches a page and parses it, turning the site's failures into the contract's kinds. */
async function page(url) {
  var response = await http.fetch({ url: url, responseType: 'text' });
  if (response.status === 404) throw sourceError('NotFound', url + ' is gone');
  if (response.status === 429) {
    var after = parseInt(response.headers['retry-after'] || '', 10);
    throw sourceError('RateLimited', 'the site asked for a pause',
      isFinite(after) ? { retryAfterMs: after * 1000 } : undefined);
  }
  if (response.status >= 500) throw sourceError('Network', 'the site answered ' + response.status);
  if (response.status !== 200) throw sourceError('Parse', 'unexpected status ' + response.status);
  return html.parse(response.body, response.url);
}

/** One card in a list, as a BookSummary, or null when it cannot be read. */
function summaryOf(card) {
  var link = card.selectFirst('a.book-link');
  var key = link && link.attr('href');
  var title = clean(card.selectFirst('.title') ? card.selectFirst('.title').text() : '');
  if (!key || !title) return null;              // skip it rather than fail the page
  var cover = card.selectFirst('img');
  var summary = { key: key, title: title };
  if (cover) {
    var src = cover.absUrl('src');
    if (src) summary.coverUrl = src;
  }
  var author = card.selectFirst('.author');
  if (author) {
    var name = clean(author.text());
    if (name) summary.authors = [name];
  }
  var length = card.selectFirst('.duration');
  if (length) {
    var ms = msFromClock(length.text());
    if (ms) summary.durationMs = ms;
  }
  return summary;
}

async function listing(url) {
  var document = await page(url);
  var items = [];
  var cards = document.select('.book-card');
  for (var i = 0; i < cards.length; i++) {
    var summary = summaryOf(cards[i]);
    if (summary) items.push(summary);
  }
  return { items: items, hasNextPage: document.selectFirst('a.next-page') !== null };
}

// ------------------------------------------------------------------ the source

var mysite = {
  getPopular: function (page_) {
    return listing(BASE + '/popular?page=' + page_ + '&per_page=' + PAGE_SIZE);
  },

  getLatest: function (page_) {
    return listing(BASE + '/latest?page=' + page_ + '&per_page=' + PAGE_SIZE);
  },

  getFilters: function () {
    return [
      { kind: 'text', key: 'author', label: 'Author' },
      {
        kind: 'select', key: 'genre', label: 'Genre', default: 'any',
        options: [
          { value: 'any', label: 'Any' },
          { value: 'fiction', label: 'Fiction' },
          { value: 'history', label: 'History' }
        ]
      },
      {
        kind: 'sort', key: 'order', label: 'Sort by',
        default: { value: 'relevance', ascending: false },
        options: [
          { value: 'relevance', label: 'Relevance' },
          { value: 'title', label: 'Title' },
          { value: 'added', label: 'Date added' }
        ]
      }
    ];
  },

  search: function (query, page_) {
    var url = new URL(BASE + '/search');
    url.searchParams.set('page', String(page_));
    url.searchParams.set('per_page', String(PAGE_SIZE));
    if (query.text) url.searchParams.set('q', query.text);

    var filters = query.filters || {};        // only what the listener changed
    if (typeof filters.author === 'string' && filters.author) {
      url.searchParams.set('author', filters.author);
    }
    if (typeof filters.genre === 'string' && filters.genre !== 'any') {
      url.searchParams.set('genre', filters.genre);
    }
    if (filters.order && typeof filters.order === 'object') {
      url.searchParams.set('sort', filters.order.value);
      url.searchParams.set('dir', filters.order.ascending ? 'asc' : 'desc');
    }
    return listing(url.toString());
  },

  getBookDetails: async function (bookKey) {
    var document = await page(BASE + bookKey);
    var title = clean(document.selectFirst('h1') ? document.selectFirst('h1').text() : '');
    if (!title) throw sourceError('Parse', 'no title on ' + bookKey);

    var details = {
      key: bookKey,
      title: title,
      authors: [],
      narrators: [],
      genres: [],
      status: 'complete',
      webUrl: BASE + bookKey
    };

    var authors = document.select('.author a');
    for (var i = 0; i < authors.length; i++) {
      var author = clean(authors[i].text());
      if (author) details.authors.push(author);
    }
    var readers = document.select('.reader a');
    for (var j = 0; j < readers.length; j++) {
      var reader = clean(readers[j].text());
      if (reader) details.narrators.push(reader);
    }
    var genres = document.select('.genre');
    for (var k = 0; k < genres.length; k++) {
      var genre = clean(genres[k].text());
      if (genre) details.genres.push(genre);
    }

    var blurb = document.selectFirst('.description');
    if (blurb) {
      // Keep paragraph breaks, drop the markup, strip control characters.
      var text = blurb.html()
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]*>/g, '')
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .trim();
      if (text) details.description = text.slice(0, 20000);
    }

    var cover = document.selectFirst('.cover img');
    if (cover) {
      var src = cover.absUrl('src');
      if (src) details.coverUrl = src;
    }

    var language = document.selectFirst('.language');
    if (language) {
      var tag = { English: 'en', French: 'fr', German: 'de', Spanish: 'es' }[clean(language.text())];
      if (tag) details.language = tag;          // a name the app cannot read is simply dropped
    }

    var year = document.selectFirst('.published');
    if (year) {
      var published = clean(year.text());
      if (published) details.publishedDate = published;
    }

    return details;
  },

  getChapters: async function (bookKey) {
    var document = await page(BASE + bookKey);
    var rows = document.select('.chapter-row');
    var chapters = [];
    var seen = {};
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var link = row.selectFirst('a');
      var key = link && link.attr('href');
      if (!key || seen[key]) continue;          // two chapters may not share a key
      seen[key] = true;
      var chapter = {
        key: key,
        title: clean(row.selectFirst('.chapter-title').text()) || 'Chapter ' + (i + 1)
      };
      var length = row.selectFirst('.chapter-duration');
      if (length) {
        var ms = msFromClock(length.text());
        if (ms) chapter.durationMs = ms;        // give this whenever you can
      }
      var part = row.selectFirst('.part-heading');
      if (part) {
        var group = clean(part.text());
        if (group) chapter.group = group;
      }
      chapters.push(chapter);
    }
    if (!chapters.length) throw sourceError('Parse', 'no chapters listed for ' + bookKey);
    return chapters;
  },

  resolveMedia: async function (ref, ctx) {
    log.debug('resolving ' + ref.chapterKey + ' for ' + ctx.purpose);
    var document = await page(BASE + ref.chapterKey);
    var audio = document.selectFirst('audio source, a.download');
    var url = audio && (audio.absUrl('src') || audio.absUrl('href'));
    if (!url) throw sourceError('NotFound', 'no audio on ' + ref.chapterKey);

    var extension = (url.split('?')[0].split('.').pop() || '').toLowerCase();
    var formats = { mp3: 'mp3', m4a: 'm4a', m4b: 'm4b', aac: 'aac',
                    flac: 'flac', ogg: 'ogg', opus: 'opus', m3u8: 'hls' };

    return {
      segments: [{
        // A stable id for the physical file. Never the expiring part of a URL.
        fileKey: ref.chapterKey,
        request: { url: url },
        format: formats[extension] || 'unknown'
      }]
    };
  }
};

module.exports = { sources: { mysite: mysite } };
```

### If the site has a JSON API instead

Simpler, and preferable when it exists:

```js
async function json(url) {
  var response = await http.fetch({ url: url, responseType: 'json' });
  if (response.status === 404) throw sourceError('NotFound', url);
  if (response.status !== 200) throw sourceError('Network', 'status ' + response.status);
  var body = response.body;
  if (!body || typeof body !== 'object') throw sourceError('Parse', 'not an object: ' + url);
  return body;
}
```

Watch for the pattern the reference extension documents: an API that reports "nothing found" as a
`200` with an error field. That is an empty page for a list, and `NotFound` when you asked for one
book by id.

### The one optimisation worth making early

If one request returns a book's details *and* its chapter list *and* the audio URLs — which is common
— then `getBookDetails`, `getChapters` and every `resolveMedia` for that book all want the same page.
Cache it in memory, keyed by book, for a few minutes, with a small bound (four books is plenty) and
least-recently-used eviction.

**Cache the extracted data, not the parsed document.** A document from `html.parse` is let go when the
call that parsed it returns, so a cached handle is dead by the time the next call reaches it (§5). Two
shapes work: parse once and keep the plain objects you pulled out of it — `{ details, chapters }`, the
audio URL per chapter — which is what the LibriVox extension does with its JSON; or keep the response
*text* and re-parse it in each call, which costs CPU but no network. The first is better; the second is
the easy retrofit if you have already written the parsing three times. Opening and playing a whole book then costs the site one
request instead of one per chapter. Do not let such a cache grow with the catalogue: the runtime lives
as long as the app does, so an unbounded cache is a leak inside a 64 MB ceiling.

---

## 10. Installing and iterating

Do this on Windows or Linux desktop, not on a phone. The loop is much faster.

1. Put `manifest.json` and `main.js` in a folder.
2. **Either** launch the app with the folder: `--extension=C:\path\to\my-extension` (with
   `flutter run -d windows`, pass it as `--dart-entrypoint-args="--extension=C:\path\to\my-extension"`).
   **Or** in the app: Browse → the extension icon → *Install from a folder*.
3. Your source appears in Browse. Open it.
4. Edit `main.js`, then Extensions → your extension's menu → **Reload from its folder**. The runtime
   stops and the next use runs your new code. No restart.
5. Watch Browse → Extensions → the terminal icon: the console shows what you logged and what the app
   says about you — a manifest that would not read, a package that would not load, a call that failed.

A folder install is marked **Unverified**, which is normal and expected: nothing checked the code
against a hash. Removing your extension deletes its code and nothing else — books added from it keep
their progress and come back when you install it again.

On iOS the only door is the Files app: tap *Install from Extensions* once to create Kikuyomi's
`Extensions` folder, copy your folder into it, then tap it again.

> **How well trodden this path is.** Installing from a folder, reloading, removing and the console have
> been driven on an iPhone, and LibriVox browses and streams there. What has *not* been exercised
> outside tests: the desktop folder picker, Android's Storage Access Framework tree, and Android at
> all. The first real run found three bugs in the app rather than in the extension, so if something
> fails in a way this guide does not explain, suspect the app, check the console, and say so.

---

## 11. Checklist before you call it done

- [ ] All five required methods implemented: `getPopular`, `search`, `getBookDetails`, `getChapters`,
      `resolveMedia`.
- [ ] Every declared capability has its method, and every optional method is declared.
- [ ] `hasNextPage` is `false` on the last page and `true` before it. Scrolling stops.
- [ ] Book, chapter and file keys are the site's stable ids — no titles, no expiring URLs — and no
      chapter key repeats within a book.
- [ ] `authors`, `narrators`, `genres` and `status` are present on `BookDetails`, even if empty.
- [ ] `durationMs` is given on chapters wherever the site reveals it.
- [ ] Descriptions are plain text with no HTML and no control characters, under 20,000 characters.
- [ ] Every host you contact — pages, audio, covers — is in the manifest's `domains`, and every
      wildcard you need lists the bare domain too if you use it.
- [ ] Failures throw a kind: `NotFound` for gone, `RateLimited` for 429, `Network` for 5xx, `Parse`
      for a page you could not read. An empty result is not a failure.
- [ ] No ES2021+ syntax (`replaceAll`, `at`, `Object.hasOwn`, `||=`, top-level `await`).
- [ ] No `undefined` inside an array, no `Date`, `Map` or class instance in a returned value.
- [ ] Nothing returns `0` for a duration or size to mean "unknown" — leave the field out.
- [ ] An M4B-style book shares one `fileKey` across chapters with `range`s, rather than pretending to
      be one file per chapter.
- [ ] Any in-memory cache is bounded, and holds extracted data or response text — never a parsed
      document, which is let go when the call that parsed it returns.

---

## 12. Where the rest of the answers are

- [`docs/source-api-1.0.md`](source-api-1.0.md) — the contract itself, and the authority.
- [`app/assets/extensions/librivox/main.js`](../app/assets/extensions/librivox/main.js) — a real
  extension, 616 lines, with a long comment on everything its site forced on it.
- [`docs/architecture.md`](architecture.md) §3.3–§3.11 — the package format, the runtime, trust, and
  the developer experience this guide stands in for until the TypeScript SDK exists.
- [`docs/adr/0017-installing-extensions-from-a-folder.md`](adr/0017-installing-extensions-from-a-folder.md)
  — why a folder install is unverified, and what removing one does.

There is no SDK yet: no typings, no `HttpSourceBase`, no `kikuyomi build`, no contract test runner.
§3.11 describes all of it and it lives in a repository that does not exist. Until it does, one
hand-written ES2020 file is the whole toolchain, and this document is the type system.
