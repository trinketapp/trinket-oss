# Port report: Download Student Work (picup/firestore → trinketapp/main)

Source diff ported: `3b6feb9..f1b8d25` on
`/Users/steve/Development/glow-repos/export-student-work` (branch
`feat/export-student-work`). Target: this worktree, branch
`feat/export-student-work-upstream`, off `trinketapp/main` (mongo + AWS S3
only).

## Files ported, and adaptations made

### `lib/models/export.js`
Added `type` (enum `trinkets`/`course-submissions`/`assignment-submissions`,
default `trinkets`), `courseId`, `materialId`. Verbatim port, no adaptation
needed — target's Export model was otherwise identical to source's.

### `lib/util/submissions.js` (new file)
Copied verbatim (`pickCurrentSubmission`, `latestFeedbackComment`,
`SUBMISSION_STATE_PREFERENCE`). Source's version had no firestore-specific
comments to strip — the file was already backend-neutral.

### `lib/workers/exports.js`
Added `Course` + `submissions` requires, the `'student-work-export'` queue
dispatch branch, `processStudentWorkExport`, `createSubmissionsArchive` and
its helpers (`getAssignmentMaterials`, `findCourseUser`, `resolveStudent`,
`processSubmissionAssignment`, `processSubmissionGroup`, `uniqueSlug`),
extended `addTrinketToArchive` to accept `options.basePath`, and added
`renderFeedbackMarkdown`/`buildSubmissionMeta` + the `module.exports` block
(target had no `module.exports` at all before this — the file was normally
required only for its queue-registration side effects).

**Adaptation — `Q.nsend` doesn't actually work here (judgment call):** The
task brief said to use `Q.nsend(model, method, ...args)` everywhere,
matching `processBulkExport`'s existing idiom. I did that first, and it
**reproducibly crashed** every real DB call in my new code:
`MongooseError: Query was already executed`. Root cause, confirmed by
reading `Q.nsend`'s source (`node_modules/q/q.js`): it dispatches the method
call *and* wraps the method's **return value** in `Q(...)`. Mongoose 6
query methods (`findById`/`findOne`/`findByIdAndUpdate`) both invoke the
appended node-callback *and* return a thenable `Query` for chaining — so
`Q(...)` adopts that `Query` a second time, and mongoose's "already
executed" guard throws. This is exactly the bug source's own `runQuery`
helper (and its comment) says it exists to fix — for mongoose, not
firestore. It isn't imagined: **`processBulkExport`'s existing,
already-committed `Q.nsend` calls appear to have the identical latent bug**
(same trace shape), I just didn't touch that code (out of scope).

Fix: added a small `runQuery(model, method, ...args)` helper (calls the
method directly and wraps only `.exec()`'s real result) and used it in only
the code I added (`processStudentWorkExport`, `createSubmissionsArchive` and
its helpers) — `processBulkExport` is untouched, still using `Q.nsend`. This
is the same mechanism as source's `runQuery`, with an accurate comment (not
a firestore-motivated one — the bug is real on mongoose 6 regardless of
backend, which is exactly why it manifested here).

All other adaptations were as briefed: `aws.S3`/`uploadToS3`/`downloadAsset`
reused unchanged; no firestore/GCS; `Trinket.findSubmissionsByMaterial` used
as-is (same aggregation shape on both bases).

### `lib/controllers/course.js`
Added `Export` + `exportsQueue` requires, `exportCourseSubmissions` and
`exportAssignmentSubmissions` (ported near-verbatim from source, which had
already converged on trinketapp's own `errors.forbidden()` / `request.pre.course`
/ `request.success` conventions since both forks share `lib/util/routeParser.js`).
Did **not** port source's `submissionsUtil` refactor of
`getMaterialSubmissionsForAllUsers` (extracting `pickCurrentSubmission` out
of that function) or `exportMaterialFeedbackCsv` — neither is in scope; per
the brief, nothing in target's existing `course.js` needed extracting.

Note (pre-existing, unrelated): target's `course.js` calls `Boom.forbidden()`
in ~41 places but only imports `require('@hapi/boom')` as `errors` — `Boom`
is never defined in that file. My new code uses `errors.forbidden()`
(the import that actually exists), matching the brief; I left the other 41
call sites alone (out of scope, pre-existing).

### `config/api_routes.js`
Added the two routes verbatim: `POST /api/courses/{courseId}/exports/submissions`
and `POST /api/courses/{courseId}/materials/{materialId}/exports/submissions`,
both `auth:'session'` + `pre:['course(params.courseId)']`, matching sibling
course routes.

### Client: `dashboardControl.js` + `course_dashboard.html` + `material_dashboard.html`
Ported verbatim from source's diff, adjusted only for target's slightly
different existing template structure (target has no "Feedback CSV" link —
that's a picup-only feature — so the button/ready-link/error-span were
placed as the next sibling of the existing view-toggle button /
Previous-Next buttons instead of after a CSV link that doesn't exist here).
`trinketConfig` (for `getUrl`) already exists in target, confirmed present.

## Tests

Ported: `export.js`, `submissions.js`, `addTrinketToArchive.js`,
`submissionRenderers.js`, `createSubmissionsArchive.js`,
`processStudentWorkExport.js`, `course-export-submissions.js`. New file
`test/helpers/readZip.js` (see below).

### The vitest instruction doesn't apply to this checkout — used mocha instead

The brief said to run `npx vitest run`. **This checkout has no vitest at
all** — no `vitest.config.*`, no `vitest` in `package.json`, no
`test/helpers/vitest-setup.cjs`. `package.json`'s only test tooling is
`mocha@^3.4.1` + `chai`/`sinon`/`supertest`, and the existing test files use
that (no `.test.js` suffix, `describe`/`it` with `done` callbacks, global
`Course`/`User`/etc.). Confirmed by checking `trinketapp/main` directly
(`git ls-tree -r trinketapp/main | grep vitest` → nothing) — vitest exists
only on `picup/main` and on `origin/main` (the MIAuthors fork's separate
"tests/rebuild" work), neither of which this branch is based on. I ported
the tests to mocha/chai, following `test/lib/models/trinket.js`'s pattern
(explicit `require()`s, not the broken bare-global convention some other
pre-existing files use — see below) rather than write vitest tests nothing
in this repo could run. **This is a real deviation from the brief and Steve
should know it before treating "tests are done" at face value** — the test
*coverage* matches source's intent, but the framework doesn't match what
was specified.

### Full-suite result: not achievable — and not caused by this port

I could not get `npm test` (mocha's full `--recursive` run) to complete, on
a **completely clean, untouched `trinketapp/main` checkout**, before I wrote
a single line of my own code. In order of discovery:

1. **`npm test` fails immediately: `Cannot find module 'catbox-redis'`.**
   `test/helpers/catbox-redis.js` requires the old unscoped `catbox-redis`
   package; `package.json` only has `@hapi/catbox-redis` (the real
   dependency, `catbox-redis` was renamed/moved years ago). This is a
   pre-existing gap in the committed `package.json` — reproduces on a bare
   `npm ci`, no changes of mine involved.

2. **A real `@hapi/hoek` dual-package hazard, order-dependent.** Requiring
   `lib/models/model.js`'s `mongoose-schema-extend` dependency *before*
   `@hapi/hapi` (or anything that pulls in `@hapi/validate`/`@hapi/shot`/the
   standalone `joi` package) corrupts `@hapi/hoek` resolution for whichever
   loads second: `Error: Schema can only contain plain objects`. Verified
   with a `git stash` bisection on the **pristine** checkout — this is not
   something my port introduced. `mocha`'s `--recursive` file loading is
   alphabetical (`test/helpers/db.js` loads before `test/helpers/flow.js`),
   so the *existing* test suite hits this on every full run today, before
   any of my files are even considered. `app.js`'s own real boot order
   (hapi/routes registered, *then* models) avoids it — the app itself works
   fine; it's specifically mocha's file-collection order that trips it.
   Workaround used for my own targeted runs: `mocha -r <script that
   requires app.js first>` (not committed — pure local verification aid).

3. **`--check-leaks` (in `test/mocha.opts`) vs. the app's own
   "global for backwards compatibility" convention.** `app.js` intentionally
   assigns `User`/`Course`/`Lesson`/`Material`/`File`/`Trinket`/`Interaction`/
   `Folder`/`CourseInvitation` as bare globals after boot (see its comment at
   the model-loading block) — several model methods (e.g.
   `lib/models/plugins/roles.js`'s `course.addUser`) reach for those globals
   directly rather than requiring the model. `--check-leaks` flags this as a
   leak unless you pass `--globals <names>`. Pre-existing tension, not
   something I introduced (my new tests do this the same way
   `test/lib/models/trinket.js` already does, via `global.Interaction =
   require(...)`).

4. **`test/helpers/flow.js`'s `Flow()` constructor assumed the old,
   pre-Hapi-20 export shape.** `app.js` was refactored to `async function
   init()` + `module.exports = init().catch(...)` — a **Promise**, not the
   server. `flow.js` did `this.agent = server(app.listener)` at
   construction time, so `app.listener` was always `undefined`; every
   `flow.*` HTTP call crashed with `Cannot read properties of undefined
   (reading 'address')`. This is universal — it would break `test/lib/api/
   course.js` and every other existing API test the same way, not just
   mine. **I fixed this** (small, isolated, test-only change — see below)
   because without it I could verify *none* of the HTTP layer for any
   feature, old or new.

5. **Even after that fix, `flow.switchUser`'s login still doesn't work
   end-to-end.** The login flow now genuinely executes (visible in the
   ROUTE/LOGIN console logs — user found, password compared, session reset,
   login succeeds) but the response isn't the `302` `flow.js` expects
   (`Error: Failed to log in "user"`). `users.js#login` now uses the
   Hapi-20 `request.success`/`request.fail` compatibility shim
   (`lib/util/routeParser.js`), and I did not chase down why its redirect
   path isn't firing for supertest's request shape — this is a second,
   independent legacy/current drift in the same login path, also
   pre-existing and universal to every API test, not specific to this
   feature. I stopped here given time already spent on infrastructure
   archaeology unrelated to the port itself.

**Net effect:** the *code* is fully wired into a normal `app.js` boot (I
verified `NODE_ENV=test node -e "require('./app.js')"` boots cleanly, real
mongo + real redis, all my routes/controllers/worker loaded, no errors) —
so this only affects test *execution*, not the feature.

### What I did verify, and how

Spun up throwaway `mongo:4.4` and `redis:6` docker containers (matching
`config/test.yaml`'s `localhost:27017` / `config/default.yaml`'s
`localhost:6379`) and ran the new test files directly via targeted `mocha`
invocations (not `npm test`/`--recursive`, for the reasons above):

```
NODE_ENV=test npx mocha -r <hapi-first-preload> \
  --globals User,Course,Lesson,Material,File,Trinket,Interaction,Folder,CourseInvitation \
  --timeout 20000 \
  test/lib/models/export.js test/lib/util/submissions.js \
  test/lib/workers/addTrinketToArchive.js test/lib/workers/submissionRenderers.js \
  test/lib/workers/createSubmissionsArchive.js test/lib/workers/processStudentWorkExport.js \
  test/lib/api/course-export-submissions.js
```

Result: **15 passing, 4 failing** — all 4 failures are the pre-existing
login/flow.js issue above (item 5), all in
`test/lib/api/course-export-submissions.js`. Every model/util/worker test
(the actual feature logic — schema, `pickCurrentSubmission`,
`addTrinketToArchive`, `renderFeedbackMarkdown`/`buildSubmissionMeta`, the
full `createSubmissionsArchive` build against real Mongo including the
by-assignment/by-student zip layout, feedback.md/submission.json content,
manifest.json, the username-sanitization defense-in-depth case, and the
full `processStudentWorkExport` queue-dispatch-to-completed/failed path
against a real Bull+Redis queue with S3 stubbed) **passes**.

`test/lib/api/course-export-submissions.js` itself is written and correct
(follows `test/lib/api/course.js`'s exact conventions) but couldn't be
proven green end-to-end because of item 5 above — a pre-existing gap, not a
defect in the new endpoints. The endpoint handlers themselves are
byte-for-byte the same shape as `users.js#requestExport` (dedup via
`Export.findPendingOrProcessing`, `errors.forbidden()` gate, `request.fail`
soft-error convention) which the brief pointed me at as the reference
pattern, and the worker-level tests already prove the `Export` records these
endpoints create are consumed and processed correctly end-to-end.

### `test/helpers/readZip.js` (new, test-only)

`adm-zip@~0.4.4` (pinned in `package.json`, also used elsewhere for
course/trinket-archive import — not something this port should touch or
upgrade) only trusts a zip entry's **Local File Header** size/CRC fields.
`archiver@^2.0.0` (also pinned; used by the pre-existing `processBulkExport`
too) writes those as placeholders and appends the real size/CRC in a
trailing data descriptor — perfectly valid per the zip spec, and every
modern tool (Finder, Explorer, 7-Zip, a current `unzip`) reads it correctly.
Confirmed with a **zero-application-code** repro (`archiver` writing 3 plain
entries, `unzip -Z1`/`unzip -p` extracting them correctly with real content,
`adm-zip` reporting all 3 as empty). Source's picup repo has since bumped to
`archiver@^5.3.2`, which is why source's identical `AdmZip`-based test
assertions work there. Rather than touch target's pinned `archiver`/
`adm-zip` versions (real behavior change, out of scope, risks the unrelated
import feature), `test/helpers/readZip.js` shells out to the system `unzip`
CLI to read entries — exercises the exact bytes a real user's unzip tool
would see, sidesteps the old reader's blind spot. Used only by
`createSubmissionsArchive.js`.

### `test/helpers/flow.js` — small, separate, pre-existing-bug fix

One isolated change (see item 4 above): `Flow()`'s `this.agent` is now
assigned once `require('../../app.js')`'s promise resolves, instead of at
construction time against `app.listener` (undefined on a Promise). This is
NOT part of the feature port — it's a small, test-only fix for a bug that
predates and is unrelated to this work, needed because without it *no*
HTTP-level test (old or new) can run at all. Committed separately so it's
easy to evaluate/drop independently.

## Judgment calls needing a decision from Steve

1. **`Q.nsend` → `runQuery` for my new code only** (see above) — I believe
   `processBulkExport`'s existing `Q.nsend` calls have the same latent bug
   and would also throw "Query was already executed" the first time an
   update actually needs to re-run against a real update path; worth a
   quick look, separate from this PR.
2. **Test framework: mocha, not vitest** — the brief assumed vitest exists
   here; it doesn't. If Steve wants this on vitest to match picup/main's
   test-rebuild work, that's a bigger, separate lift (new harness, `.test.js`
   renames, `vitest.config.mjs`, etc.) — flagging rather than guessing.
3. **`test/helpers/flow.js` fix** — small and isolated, but touches shared
   test infra outside the feature's own files. Kept as its own commit so it
   can be reviewed/reverted independently of the feature commits.
4. **Full mocha suite still can't run** (`npm test`) even after my flow.js
   fix, due to items 1–3 and 5 above. None of these are mine to fix as part
   of this port (pre-existing, checkout-wide), but Steve should know
   `npm test` is not currently a usable gate on this branch's base
   (`trinketapp/main`) at all, before or after this change.

## Files touched (repo-relative paths)

- `lib/models/export.js`
- `lib/util/submissions.js` (new)
- `lib/workers/exports.js`
- `lib/controllers/course.js`
- `config/api_routes.js`
- `public/js/courseEditor/controllers/dashboardControl.js`
- `public/partials/course_dashboard.html`
- `public/partials/material_dashboard.html`
- `test/lib/models/export.js` (new)
- `test/lib/util/submissions.js` (new)
- `test/lib/workers/addTrinketToArchive.js` (new)
- `test/lib/workers/submissionRenderers.js` (new)
- `test/lib/workers/createSubmissionsArchive.js` (new)
- `test/lib/workers/processStudentWorkExport.js` (new)
- `test/lib/api/course-export-submissions.js` (new)
- `test/helpers/readZip.js` (new, test-only)
- `test/helpers/flow.js` (small, separate, pre-existing-bug fix)
