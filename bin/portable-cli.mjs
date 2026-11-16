import path from "node:path";
import { installHost, normalizeHost, portableHosts, readPortableConfig } from "../dist/portable/install.js";
import { migrateProject } from "../dist/portable/migration.js";
import { syncNativeSkills } from "../dist/portable/sync.js";
import { doctorHost } from "../dist/portable/doctor.js";

const help = `AutoSkill portable adapters

  autoskill install|uninstall|enable|disable --host <opencode|claude-code|codex|gemini|cursor|generic> [--project <dir>]
  autoskill install|uninstall|enable|disable --all [--project <dir>]
  autoskill migrate [--rollback] [--dry-run] [--project <dir>]
  autoskill sync --host <host> [--prune] [--dry-run] [--project <dir>]
  autoskill doctor --host <host> [--binary <path>] [--project <dir>]
  autoskill status|review|worker --host <host> [--project <dir>]
  autoskill serve --host <host> [--project <dir>]
  autoskill hook --host <host> --event <event> [--project <dir>]

Migration preserves legacy files and refuses active queues. Stop every host first.
--dry-run previews installer, migration and sync operations without writing files.
Host configuration does not establish that hooks are trusted or executing.
`;
function parse(args) {
  const values = new Set(["host", "project", "event", "binary", "package", "opencode"]), flags = new Set(["all", "dry-run", "prune", "rollback", "help"]);
  const options = {}, positional = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]; if (arg === "-h") { options.help = true; continue; }
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const key = arg.slice(2); if (options[key] !== undefined) throw new Error(`Duplicate option: ${arg}`);
    if (flags.has(key)) { options[key] = true; continue; }
    if (!values.has(key)) throw new Error(`Unknown portable option: ${arg}`);
    const value = args[++index]; if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`); options[key] = value;
  }
  const command = positional.shift() ?? "help";
  if (positional.length) throw new Error(`Unexpected arguments: ${positional.join(" ")}`);
  if (options.all && options.host) throw new Error("--all and --host cannot be combined.");
  if (options.all && !["install", "uninstall", "enable", "disable", "doctor", "sync"].includes(command)) throw new Error("--all is not supported for this command.");
  if (options["dry-run"] && !["install", "uninstall", "enable", "disable", "migrate", "sync", "review"].includes(command)) throw new Error("--dry-run is not supported for this command.");
  return { command: options.help ? "help" : command, options };
}
export async function runPortableCli(args, io = { out: value => process.stdout.write(String(value) + "\n"), error: value => process.stderr.write(String(value) + "\n") }) {
  const { command, options } = parse(args), root = path.resolve(options.project ?? process.cwd()), dryRun = options["dry-run"] === true;
  const output = value => { if (value !== undefined) io.out(JSON.stringify(value, null, command === "hook" ? undefined : 2)); };
  if (command === "help") { io.out(help); return 0; }
  if (command === "migrate") { output(await migrateProject({ root, dryRun, rollback: options.rollback === true })); return 0; }
  if (options.rollback) throw new Error("--rollback is only valid for migrate.");
  if (options.prune && command !== "sync") throw new Error("--prune is only valid for sync.");
  const hosts = options.all ? portableHosts : [normalizeHost(options.host ?? "generic")];
  if (["install", "uninstall", "enable", "disable"].includes(command)) {
    const results = [];
    for (const host of hosts) {
      if (host === "opencode") {
        const { runCli } = await import("./cli.mjs");
        const native = [];
        await runCli([command, "--project", root, ...(dryRun ? ["--dry-run"] : []), ...(options.package ? ["--package", options.package] : [])], { out: value => native.push(value), error: io.error });
        results.push({ host, result: native.map(value => { try { return JSON.parse(value); } catch { return value; } }) });
      } else results.push(await installHost({ root, host, action: command, dryRun, packageDir: options.package }));
    }
    output(options.all ? results : results[0]); return 0;
  }
  if (command === "sync") { const results = []; for (const host of hosts) results.push(await syncNativeSkills({ root, host, dryRun, prune: options.prune === true })); output(options.all ? results : results[0]); return 0; }
  if (command === "doctor") { const results = []; for (const host of hosts) results.push(await doctorHost({ root, host, binary: options.binary ?? options.opencode })); output(options.all ? results : results[0]); return 0; }
  if (["hook", "serve", "worker", "review", "status"].includes(command)) {
    if (command === "hook" && !options.event) throw new Error("hook requires --event.");
    const runtime = await import("../dist/portable/runtime.js");
    output(await runtime.runRuntimeCommand({ command, host: hosts[0], root, event: options.event, dryRun })); return 0;
  }
  if (command === "config") { output(await readPortableConfig(root)); return 0; }
  throw new Error(`Unknown portable command: ${command}`);
}
