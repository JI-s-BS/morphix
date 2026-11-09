// Self-heal building blocks: log classification, secret redaction, Claude diagnosis (fake fetch), disk cleanup.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  buildDiagnosisPrompt, classifyLog, claudeDiagnoserFromEnv, cleanOldFiles, createClaudeDiagnoser, defaultCleanTargets,
  DEFAULT_CLAUDE_MODEL, fingerprint, isUnsafeCleanRoot, parseDiagnosis, redactSecrets, REMEDIATION_IDS, REMEDIATIONS, secretEnvValues, type DiagnoseInput,
} from "@morphix/healer";

describe("classifyLog", () => {
  it("recognises the known failure lines", () => {
    expect(classifyLog({ level: "info", message: "Gemini session closed", extra: { reason: "Session closed due to inactivity" } })).toMatchObject({ kind: "gemini-closed", context: { inactivity: true } });
    expect(classifyLog({ level: "info", message: "Gemini session closed", extra: { reason: "closed (1011)" } })).toMatchObject({ kind: "gemini-closed", context: { inactivity: false } });
    expect(classifyLog({ level: "warn", message: "printer-control", extra: { op: "pause", error: "printer refused control: Control failed." } })).toMatchObject({ kind: "printer-control-refused" });
    expect(classifyLog({ level: "info", message: "printer-control", extra: { op: "recoverControl", outcome: "confirmed" } })).toMatchObject({ kind: "printer-stale-lock-cleared" });
    expect(classifyLog({ level: "info", message: "printer-control", extra: { op: "pause", outcome: "confirmed" } })).toBeNull();
    expect(classifyLog({ level: "info", message: "[guardian] vision worker failed after 5 restarts" })).toMatchObject({ kind: "guardian-worker-down" });
    expect(classifyLog({ level: "error", message: "db close failed", extra: { error: "ENOSPC: no space left on device" } })).toMatchObject({ kind: "disk-low" });
    expect(classifyLog({ level: "error", message: "uncaughtException", extra: { message: "x is undefined" } })).toMatchObject({ kind: "unknown-error", what: "uncaughtException: x is undefined" });
  });

  it("ignores its own lines, renderer console noise and errors handled through jobs", () => {
    expect(classifyLog({ level: "error", message: "self-heal: x → y → failed" })).toBeNull();
    expect(classifyLog({ level: "error", message: "[console] Uncaught TypeError" })).toBeNull();
    expect(classifyLog({ level: "error", message: "generation failed", extra: { error: "fetch failed" } })).toBeNull();
    expect(classifyLog({ level: "warn", message: "voice error shown", extra: { message: "x" } })).toBeNull();
  });

  it("fingerprints messages that differ only in numbers, ids and paths", () => {
    expect(fingerprint("job 3f2a9c1e-1111-2222-3333-444455556666 failed at /home/jd/x.stl after 12 s"))
      .toBe(fingerprint("job 99999999-aaaa-bbbb-cccc-ddddeeeeffff failed at /tmp/y.stl after 7 s"));
  });
});

describe("redactSecrets", () => {
  it("strips keys, tokens, JWTs, passwords, emails and long blobs", () => {
    const raw = [
      'x-api-key: sk-ant-api03-AbCdEfGhIjKlMnOp_qrstuv',
      '{"apiKey":"msy_1234567890abcdef","password":"hunter22","note":"ok"}',
      "GET /v1?key=AIzaSyA1234567890abcdefghijklmnopqrs&alt=json",
      "Authorization: Bearer abc.def.ghi-jkl_mno",
      "id eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "user kid.parent@example.com signed in",
      "PORTAL_SESSION_SECRET=s3cr3tvalue",
      "hash 0123456789abcdef0123456789abcdef0123456789abcdef",
    ].join("\n");
    const out = redactSecrets(raw, ["s3cr3tvalue"]);
    for (const leak of ["sk-ant-api03", "msy_1234567890abcdef", "hunter22", "AIzaSyA", "abc.def.ghi", "eyJhbGci", "kid.parent@example.com", "s3cr3tvalue", "0123456789abcdef0123"]) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain('"note":"ok"');
    expect(out).toContain("signed in");
  });

  it("collects secret-looking env values", () => {
    expect(secretEnvValues({ GEMINI_API_KEY: "abcdefgh", MORPHIX_PRINTER_HOST: "192.168.10.51", AUTH0_CLIENT_SECRET: "zzzzzzzz", X: "" }).sort()).toEqual(["abcdefgh", "zzzzzzzz"]);
  });
});

describe("Claude diagnosis", () => {
  const input: DiagnoseInput = {
    incident: { kind: "unknown-error", key: "k", what: "uncaughtException: boom", context: { detail: "token=abc123secret" } },
    logLines: ['{"level":"error","message":"boom","extra":{"apiKey":"sk-ant-api03-LEAKLEAKLEAK"}}', '{"message":"MESHY msy_abcdefgh12345"}'],
    remediations: REMEDIATION_IDS.map((id) => ({ id, label: REMEDIATIONS[id].label })),
  };
  const answer = { summary: "The app hit a bug.", likely_cause: "null deref", user_hint: "Restart Morphix.", suggested_remediation: "restart-guardian-worker", confidence: "medium" };
  const okFetch = (body: unknown) =>
    vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

  it("calls the Messages API with JSON output, the default model and no secrets", async () => {
    const f = okFetch({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answer) }] });
    const d = createClaudeDiagnoser({ apiKey: "sk-ant-api03-REALKEY123456", fetch: f as unknown as typeof fetch, secrets: ["abc123secret"] });
    const r = await d(input);
    expect(r).toEqual({ summary: "The app hit a bug.", likelyCause: "null deref", userHint: "Restart Morphix.", suggestedRemediation: "restart-guardian-worker", confidence: "medium", model: "claude-opus-5-5" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-api03-REALKEY123456");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.output_config.format.schema.properties.suggested_remediation.enum).toEqual([...REMEDIATION_IDS, "none"]);
    const sent = String(init.body);
    for (const leak of ["REALKEY123456", "LEAKLEAKLEAK", "msy_abcdefgh12345", "abc123secret"]) expect(sent).not.toContain(leak);
  });

  it("maps anything outside the whitelist to 'none' and handles refusals and HTTP errors", async () => {
    expect(parseDiagnosis(JSON.stringify({ ...answer, suggested_remediation: "start-print" }))?.suggestedRemediation).toBe("none");
    expect(parseDiagnosis(JSON.stringify({ ...answer, suggested_remediation: "rm -rf /" }))?.suggestedRemediation).toBe("none");
    expect(parseDiagnosis("not json")).toBeNull();
    const refused = createClaudeDiagnoser({ apiKey: "k-123456", fetch: okFetch({ stop_reason: "refusal", content: [] }) as unknown as typeof fetch });
    expect(await refused(input)).toBeNull();
    const failing = createClaudeDiagnoser({
      apiKey: "sk-ant-api03-KEYKEYKEY",
      fetch: (async () => new Response("bad key sk-ant-api03-KEYKEYKEY", { status: 401 })) as unknown as typeof fetch,
    });
    await expect(failing(input)).rejects.toThrow(/Claude HTTP 401/);
    await expect(failing(input)).rejects.not.toThrow(/KEYKEYKEY/);
  });

  it("is configured from the environment (off without a key)", () => {
    expect(claudeDiagnoserFromEnv({})).toBeNull();
    expect(claudeDiagnoserFromEnv({ ANTHROPIC_API_KEY: "x-123456", MORPHIX_SELF_HEAL_AI: "0" })).toBeNull();
    expect(typeof claudeDiagnoserFromEnv({ ANTHROPIC_API_KEY: "x-123456" })).toBe("function");
  });

  it("uses MORPHIX_CLAUDE_MODEL when set", async () => {
    const f = okFetch({ content: [{ type: "text", text: JSON.stringify(answer) }] });
    const d = claudeDiagnoserFromEnv({ ANTHROPIC_API_KEY: "x-123456", MORPHIX_CLAUDE_MODEL: "claude-sonnet-5-5" }, { fetch: f as unknown as typeof fetch })!;
    await d(input);
    expect(JSON.parse(String(f.mock.calls[0][1].body)).model).toBe("claude-sonnet-5-5");
  });

  it("keeps the prompt to the last log lines", () => {
    const many = { ...input, logLines: Array.from({ length: 200 }, (_, i) => `line ${i}`) };
    const p = buildDiagnosisPrompt(many, [], 60);
    expect(p).toContain("line 199");
    expect(p).not.toContain("line 139\n");
  });
});

describe("disk cleanup", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const DAY = 24 * 3600 * 1000;
  const touch = (p: string, ageDays: number, bytes = 1000) => {
    writeFileSync(p, Buffer.alloc(bytes));
    const t = (Date.now() - ageDays * DAY) / 1000;
    utimesSync(p, t, t);
  };

  it("deletes only old, re-creatable files", () => {
    const root = mkdtempSync(join(tmpdir(), "healer-root-"));
    const tmp = mkdtempSync(join(tmpdir(), "healer-tmp-"));
    dirs.push(root, tmp);
    for (const d of ["prints/job1", "logs", "cache/recordings", "models/p/v", "database"]) mkdirSync(join(root, d), { recursive: true });
    touch(join(root, "prints/job1/model.gcode"), 20, 5000);
    touch(join(root, "prints/job1/model.gx"), 20, 5000);
    touch(join(root, "logs/morphix-2026-09-01.log"), 60);
    touch(join(root, "logs/morphix-2026-11-07.log"), 1);
    touch(join(root, "cache/old.bin"), 30);
    touch(join(root, "cache/recordings/turn.wav"), 90);
    touch(join(root, "models/p/v/model.stl"), 365);
    touch(join(root, "database/morphix.sqlite"), 365);
    mkdirSync(join(tmp, "morphix-prepare-abc"));
    touch(join(tmp, "morphix-prepare-abc/model.stl"), 3);
    utimesSync(join(tmp, "morphix-prepare-abc"), (Date.now() - 3 * DAY) / 1000, (Date.now() - 3 * DAY) / 1000);
    mkdirSync(join(tmp, "morphix-prepare-new"));
    touch(join(tmp, "other-app.tmp"), 30);

    const r = cleanOldFiles(defaultCleanTargets(root, tmp));
    expect(r.removed).toBe(4);
    expect(r.freedBytes).toBe(5000 + 1000 + 1000 + 1000);
    expect(existsSync(join(root, "prints/job1/model.gcode"))).toBe(false);
    expect(existsSync(join(root, "prints/job1/model.gx"))).toBe(true);
    expect(existsSync(join(root, "logs/morphix-2026-09-01.log"))).toBe(false);
    expect(existsSync(join(root, "logs/morphix-2026-11-07.log"))).toBe(true);
    expect(existsSync(join(root, "cache/old.bin"))).toBe(false);
    expect(existsSync(join(root, "cache/recordings/turn.wav"))).toBe(true);
    expect(existsSync(join(root, "models/p/v/model.stl"))).toBe(true);
    expect(existsSync(join(root, "database/morphix.sqlite"))).toBe(true);
    expect(existsSync(join(tmp, "morphix-prepare-abc"))).toBe(false);
    expect(existsSync(join(tmp, "morphix-prepare-new"))).toBe(true);
    expect(existsSync(join(tmp, "other-app.tmp"))).toBe(true);
  });

  it("refuses to clean the filesystem root or the home directory", () => {
    expect(isUnsafeCleanRoot("/")).toBe(true);
    expect(isUnsafeCleanRoot(homedir())).toBe(true);
    expect(isUnsafeCleanRoot("/usr")).toBe(true);
    expect(isUnsafeCleanRoot(tmpdir())).toBe(false); // the default target for morphix-* temp dirs
    expect(isUnsafeCleanRoot(join(tmpdir(), "x"))).toBe(false);
  });
});
