import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { containsSecret, containsSecretValue, redact, redactValue, truncate, sanitizeTool } from "../dist/safety.js";

test("double-star privacy globs match both root-level and nested sensitive paths", () => {
  for (const file of ["secrets/business.json", "nested/secrets/business.json", "credentials-prod", "nested/credentials-prod", "C:\\repo\\secrets\\business.json"]) {
    assert.equal(sanitizeTool({ id: "private", name: "read", status: "completed", input: { file }, output: "business data" },
      { root: "unused", excludeFiles: ["**/secrets/**", "**/credentials*"] }), undefined, file);
  }
  assert.ok(sanitizeTool({ id: "public", name: "read", status: "completed", input: { file: "src/public.json" }, output: "ordinary data" },
    { root: "unused", excludeFiles: ["**/secrets/**", "**/credentials*"] }));
});

test("redacted values and environment references are stable safe placeholders", () => {
  const values = ["[REDACTED]", "<REDACTED>", "<API_KEY>", "$API_KEY", "${API_KEY}", "%API_KEY%", "$env:API_KEY", "process.env.API_KEY", "process.env['API_KEY']"];
  for (const value of values) {
    const input = `api_key=${value}`;
    assert.equal(redact(input), input, value);
    assert.equal(containsSecret(input), false, value);
  }
  const json = JSON.stringify({ password: "[REDACTED]", authorization: "Bearer ${TOKEN}", token: "<ACCESS_TOKEN>" });
  assert.equal(redact(json), json);
  assert.equal(containsSecret(json), false);
});

test("quoted passwords are entirely removed, including spaces and escaped quotes", () => {
  const input = JSON.stringify({ password: 'my unusual "password" with spaces', client_secret: "another secret value" });
  const output = redact(input);
  assert.deepEqual(JSON.parse(output), { password: "[REDACTED]", client_secret: "[REDACTED]" });
  assert.equal(containsSecret(input), true);
  assert.equal(containsSecret(output), false);
  assert.equal(redact(output), output);
  assert.equal(redact("DB_PASSWORD='a password with spaces'"), "DB_PASSWORD='[REDACTED]'");
  assert.equal(redact("pwd=abc"), "pwd=[REDACTED]");
});

test("decoded JSON commands redact quoted credentials without leaking values or breaking serialization", () => {
  const input = { command: 'API_KEY="a secret with spaces" npm run check', metadata: { secretAccessKey: "a-secret-access-key" } };
  const redacted = redactValue(input);
  assert.deepEqual(redacted, { command: 'API_KEY="[REDACTED]" npm run check', metadata: { secretAccessKey: "[REDACTED]" } });
  assert.equal(containsSecretValue(input), true);
  assert.equal(containsSecretValue(redacted), false);
  const serialized = JSON.stringify(input);
  assert.deepEqual(JSON.parse(redact(serialized)), redacted);
  assert.equal(containsSecret(serialized), true);
  assert.equal(containsSecret(redact(serialized)), false);
  const safe = { steps: ['Run with API_KEY="$API_KEY"', "password: ${PASSWORD}"] };
  assert.deepEqual(redactValue(safe), safe);
  assert.equal(redact(JSON.stringify(safe)), JSON.stringify(safe));
  assert.equal(containsSecretValue(safe), false);
  assert.equal(containsSecret(JSON.stringify(safe)), false);
});

test("sensitive structured fields redact entire values and preserve safe placeholders", () => {
  const input = { password: 123456, token: { nested: "sensitive-value" }, other: ["password='more secret'"], api_key: null, enabled: false };
  const output = redactValue(input);
  assert.deepEqual(output, { password: "[REDACTED]", token: "[REDACTED]", other: ["password='[REDACTED]'"], api_key: null, enabled: false });
  assert.equal(containsSecretValue(output), false);
  assert.equal(input.password, 123456);
  assert.equal(redactValue({ path: "d:\\project\\file.ts" }, "D:\\Project").path, "<PROJECT>\\file.ts");
});

test("common provider credentials, basic authentication, and database URLs are removed", () => {
  const secrets = [
    `sk-proj-${"a".repeat(30)}`,
    `ghp_${"b".repeat(36)}`,
    `github_pat_${"c".repeat(32)}`,
    `xoxb-${"d".repeat(24)}`,
    `AKIA${"E".repeat(16)}`,
    `ASIA${"F".repeat(16)}`,
    `AIza${"g".repeat(35)}`,
    `eyJ${"h".repeat(12)}.${"i".repeat(12)}.${"j".repeat(12)}`,
    "Basic dXNlcjpwYXNzd29yZA==",
    "Bearer abcdefghijklmnop",
    "postgresql://alice:super-secret@db.example/test",
    "mongodb+srv://alice:super-secret@db.example/test",
    "-----BEGIN RSA PRIVATE KEY-----\nsecret key body\n-----END RSA PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\ntruncated private key body",
  ];
  for (const secret of secrets) {
    const output = redact(secret);
    assert.notEqual(output, secret, secret.slice(0, 24));
    assert.equal(containsSecret(secret), true);
    assert.equal(containsSecret(output), false, output);
    assert.equal(redact(output), output);
  }
});

test("environment prefixes and sensitive HTTP fields are redacted without swallowing other query values", () => {
  assert.equal(redact("OPENAI_API_KEY=arbitrary-credential\nAWS_SECRET_ACCESS_KEY=another-key"), "OPENAI_API_KEY=[REDACTED]\nAWS_SECRET_ACCESS_KEY=[REDACTED]");
  assert.equal(redact("https://example.test?api_key=realcredential&format=json"), "https://example.test?api_key=[REDACTED]&format=json");
  const output = redact("Cookie: session=real-session; preference=dark\nSet-Cookie: session=other-session; HttpOnly");
  assert.equal(output, "Cookie: [REDACTED]\nSet-Cookie: [REDACTED]");
  assert.equal(containsSecret(output), false);
});

test("Windows project paths match case, slash, and JSON-escaped variants with segment boundaries", () => {
  const root = "D:\\Work\\My Project";
  const values = [root, "d:\\work\\my project", "D:/Work/My Project", "d:/work\\my project", "D:\\\\Work\\\\My Project"];
  for (const value of values) {
    assert.equal(redact(`open "${value}\\src\\index.ts"`, root), 'open "<PROJECT>\\src\\index.ts"', value);
  }
  const sibling = "D:\\Work\\My Project-other\\index.ts";
  assert.equal(redact(sibling, root), sibling);
  assert.equal(redact("see D:\\Work\\My Project.", root), "see <PROJECT>.");
});

test("UNC, POSIX, and home paths preserve path boundaries", () => {
  assert.equal(redact("\\\\server\\share\\repo\\file.ts", "\\\\server\\share\\repo"), "<PROJECT>\\file.ts");
  assert.equal(redact("/srv/repo/file.ts /srv/repo-other/file.ts", "/srv/repo/"), "<PROJECT>/file.ts /srv/repo-other/file.ts");
  assert.equal(redact(`"${os.homedir()}"`), '"<HOME>"');
  assert.equal(redact("https://example.com/path", "/"), "https://example.com/path");
});

test("truncation always respects its character budget while keeping both ends", () => {
  const original = "first-" + "x".repeat(100) + "-last";
  for (let max = 0; max < original.length; max++) assert.ok(truncate(original, max).length <= max);
  const output = truncate(original, 40);
  assert.match(output, /^first-/);
  assert.match(output, /-last$/);
  assert.match(output, /\[truncated\]/);
  assert.equal(truncate("short", 40), "short");
});

test("command credentials and short PASS environment fields are entirely redacted", () => {
  const examples = [
    'mysql --password "SuperSecret_123"', 'mysql --password=SuperSecret_123',
    'curl --user "alice:SuperSecret_123" https://example.test', 'curl -u alice:SuperSecret_123 https://example.test',
    "command --token 'a secret with spaces'", "DB_PASS=SuperSecret_123", "AWS_PASS=SuperSecret_123",
  ];
  for (const input of examples) {
    assert.equal(containsSecret(input), true, input);
    const output = redact(input);
    assert.doesNotMatch(output, /SuperSecret|a secret with spaces/);
    assert.equal(containsSecret(output), false, output);
  }
  assert.equal(redact('curl --token "$TOKEN"'), 'curl --token "$TOKEN"');
  assert.equal(containsSecret('DB_PASS="$DB_PASS"'), false);
});

test("sensitive tools, credential files, and credential commands are excluded entirely", () => {
  const base = { id: "call-example", name: "shell", status: "completed" as const, output: "Potentially sensitive command output" };
  for (const input of [{ command: 'mysql --password "SuperSecret_123"' }, { filePath: "D:\\project\\.env.production" }, { command: "cat ./credentials.json" }, { filePath: "./keys/client.pem" }]) {
    assert.equal(sanitizeTool({ ...base, input }, { root: "D:\\project" }), undefined);
  }
  assert.equal(sanitizeTool({ ...base, input: { command: "read regular-file.ts" } }, { root: "D:\\project", excludeTools: ["shell"] }), undefined);
  assert.equal(sanitizeTool({ ...base, input: { command: "read payroll.csv" } }, { root: "D:\\project", excludeFiles: ["payroll.csv"] }), undefined);
  assert.equal(sanitizeTool({ ...base, input: {} }, { root: "D:\\project", sensitivePatterns: ["Potentially sensitive"] }), undefined);
  const safe = sanitizeTool({ ...base, input: { command: "npm test" }, output: "Tests passed at D:\\project\\tests. api_key=secret-value" }, { root: "D:\\project" });
  assert.ok(safe);
  assert.doesNotMatch(safe.output, /secret-value|D:\\project/);
  assert.match(safe.output, /Tests passed/);
});
