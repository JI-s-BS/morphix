# Jobs: one progress model for every pipeline

`packages/jobs` (`@morphix/jobs`) gives the touchscreen and the web portal the same view of
everything Morphix is doing: a job with ordered stages, kid-friendly labels and one weighted
progress bar. Jobs are plain JSON, so they cross IPC and HTTP as they are, and they can be saved
and restored across an app restart. Failures carry a serialised `MorphixError` (see
[ERRORS.md](ERRORS.md)).

## Model

```ts
interface Job {
  id: string;
  kind: "text-to-print" | "photo-to-print" | "prepare" | "print";
  title: string;                 // "Little dinosaur"
  status: "pending" | "running" | "waiting_for_user" | "done" | "failed" | "cancelled" | "interrupted";
  stages: JobStage[];            // ordered
  percent: number;               // 0-100, weighted; 100 only when every stage is done/skipped
  currentStage: string | null;   // stage to highlight (running/waiting/failed, else next pending)
  createdAt: string; startedAt?: string; finishedAt?: string; updatedAt: string;  // ISO times
  owner?: string;                // "touchscreen", "voice" or a portal user id (Auth0 sub)
  error?: SerializedMorphixError; // first failure, for a one-line banner
  meta?: Record<string, unknown>; // app data: project id, model id, file paths…
}

interface JobStage {
  key: string;                   // "generate", "prepare.slice", …
  label: string;                 // "Creating your 3D model"
  group?: string; groupLabel?: string;  // "prepare" / "Getting it ready to print"
  weight: number;                // share of the bar; skipped stages leave the total
  status: "pending" | "running" | "done" | "skipped" | "failed" | "waiting_for_user";
  progress: number;              // 0-100 within the stage
  detail?: string;               // "Meshy: 2 ahead in the queue"
  error?: SerializedMorphixError;
  question?: { prompt: string; options?: string[] };  // while waiting_for_user
  interrupted?: boolean;         // was running at an app restart
  startedAt?: string; finishedAt?: string;
}
```

**Overall percent** = Σ weight × fraction / Σ weight over the stages that are not skipped, where
fraction is 1 for done, 0 for pending and `progress / 100` otherwise. It is floored and capped at
99 until every stage is done or skipped. When every weight is 0, each stage counts equally.

**Status** is derived from the stages: any failed stage → `failed` (or `interrupted` if every
failed stage was interrupted by a restart), otherwise any waiting stage → `waiting_for_user`,
otherwise all done/skipped → `done`, otherwise anything started → `running`. `cancelled` is set by
`cancel()`. A failed or interrupted stage can be retried with `startStage()`; the job goes back to
`running` and its error is cleared.

## Standard stages

| Kind | Stages (key: label, weight) |
| --- | --- |
| `text-to-print` | `understand` Understanding your idea (4) → `generate` Creating your 3D model (30) → `download` Bringing the model home (3) → *prepare* → `approval` Waiting for your OK (1) → `send` Sending it to the printer (4) → `print` Printing (40) → `done` All done! (0) |
| `photo-to-print` | `photos` Looking at your photos (8) → `questions` A few quick questions (2) → `build` Creating your 3D model (30) / Building your model from shapes (10, OpenSCAD) → `download` (Meshy only) → same tail |
| `prepare` | *prepare* → `done` |
| `print` | `approval` → `send` → `print` → `done` |

*prepare* is the `prepare` group: `prepare.check` Checking the model (2), `prepare.repair` Fixing
little problems (2), `prepare.orient` Finding the best way to stand it up (2), `prepare.slice`
Cutting it into thin layers (8), `prepare.gx` Making the printer file (1).

Template options (`stageTemplate(kind, options)` or `create({ template })`): `approval: false`
drops the approval stage, `print: false` stops after preparation, `builder: "openscad"` for
photo jobs (no download stage), `questions: false` drops the questions stage (or `skip()` it at
run time). Custom stage lists can be passed as `create({ stages: [...] })`.

The zero-weight `done` stage completes itself once every other stage is done or skipped.

## API

```ts
import { JobManager, createJobFileStore, trackPrepare } from "@morphix/jobs";

const store = createJobFileStore(join(morphixHome, "data", "jobs.json"));
const jobs = new JobManager({ persist: (s) => store.save(s), persistDebounceMs: 500, onPersistError: log.warn });
jobs.restore(await store.load());           // after a restart: running stages -> interrupted

const job = jobs.create({ kind: "text-to-print", title: "Little dinosaur", owner: "voice", meta: { projectId } });
jobs.startStage(job.id, "understand");
jobs.advance(job.id, "generate");          // completes the running stage, starts the next
jobs.updateStage(job.id, "generate", { progress: 42, detail: "Meshy: 2 ahead in the queue" });
jobs.failStage(job.id, "generate", err, "MX-GEN-005");   // any thrown value -> MorphixError
jobs.skip(job.id, "questions", "No questions needed");
jobs.waitForUser(job.id, "approval", { prompt: "Shall I print it?", options: ["Print", "Not now"] });
jobs.completeStage(job.id, "approval", "Approved on the touchscreen");
jobs.cancel(job.id, "user said stop");      // running/waiting stages fail with MX-SYS-004

jobs.get(id); jobs.list({ owner, active: true, kind });
const off = jobs.subscribe(job.id, (e) => …);   // or jobs.subscribeAll(listener) / subscribe("*", …)
```

Events are `{ type: "created" | "updated" | "finished" | "removed" | "restored", job, stageKey? }`.
`job` is a copy, so listeners can forward it straight to `webContents.send` or an SSE stream. A
listener that throws is ignored, so a closed portal connection cannot break a print.

Other helpers: `computeJobPercent(stages)`, `deriveJobStatus(stages)`, `isJobFinished(job)`,
`restoreJobs(snapshot, { interruptWaiting })` (pure), `setMeta(id, patch)`, `remove(id)`,
`serialize()`, `flush()` (forces a pending debounced save) and `dispose()`. The oldest finished
jobs beyond `maxFinishedJobs` (default 50) are dropped.

### Persistence and restarts

`persist(snapshot)` is called after every change (or coalesced with `persistDebounceMs`).
`createJobFileStore(path)` writes atomically (temp file + rename) and serialises writes. A missing
or corrupt file loads as `null`.

`restore(snapshot)` marks every **running** stage `failed` with `interrupted: true` and the
error `MX-SYS-006` ("Morphix restarted while this was running"). The job then reads
`interrupted`. Stages **waiting for the user** are kept by default, so a pending approval survives
a restart. Pass `{ interruptWaiting: true }` when the app cannot resume them.

### Preparation progress

`trackPrepare(jobs, jobId)` turns `preparePrint` / `prepareWithAdvice` progress into the
`prepare.*` stages:

```ts
const t = trackPrepare(jobs, job.id);
try {
  const r = await prepareWithAdvice({ inputPath, targetHeightMm: 80, description, onProgress: t.onProgress, options: { outputDir } });
  t.finish(r);    // completes, skips (slicing off) or fails (MX-SLICE-xxx at the stage that failed)
} catch (e) {
  t.fail(e);      // e.g. MeshFormatError -> MX-GEN-008 on the current stage
}
```

Mapping: `load`, `validate` → `prepare.check`; `repair` → `prepare.repair`; `place` →
`prepare.orient`; `advise`, `slice` → `prepare.slice`; `gx` → `prepare.gx`.

## Integration steps (coordinator)

1. **Main process**: create one `JobManager` with `createJobFileStore(~/Morphix/data/jobs.json)`.
   Call `restore(await store.load())` before any pipeline starts.
2. **Pipelines**: create a job at the start of each voice/touch/photo request, then call
   `advance` / `updateStage` from the existing Meshy `onUpdate`, the guardian and the print
   tracker. Use `trackPrepare` for preparation. On any catch, call
   `failStage(id, stage, e, "<fallback code>")`.
3. **Approval**: `waitForUser(id, "approval", …)` when the print is ready. Only the main process
   completes it, after the touch confirmation or the spoken "yes" that mints `authorizePrint`.
4. **IPC**: `jobs.subscribeAll((e) => win.webContents.send("jobs:event", e))`, plus
   `jobs:list` / `jobs:get` handlers that return `jobs.list()` / `jobs.get(id)`.
5. **Portal**: serve `jobs.list({ owner })` over HTTP and stream `subscribeAll` events over SSE.
   Filter by owner unless the user is an admin.
6. **UI**: draw one bar from `job.percent`. Show `stages[*].label` (optionally grouped by
   `groupLabel`), `detail` under the current stage, and for errors `error.title` + `error.hint`.
