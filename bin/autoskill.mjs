#!/usr/bin/env node
import { runCli as runLegacyCli } from "./cli.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
/** Keep the historical CLI stable while dispatching explicit portable commands. */
export async function runCli(args, io) {
  if (!args.length || ["help", "--help", "-h"].includes(args[0])) {
    await runLegacyCli(["--help"], io);
    const { runPortableCli } = await import("./portable-cli.mjs");
    return runPortableCli(["--help"], io);
  }
  const portable = args.includes("--host") || args.includes("--all") || ["serve", "hook", "worker", "migrate", "sync", "config"].includes(args[0]);
  if (portable) { const { runPortableCli } = await import("./portable-cli.mjs"); return runPortableCli(args, io); }
  return runLegacyCli(args, io);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(process.argv[2] === "hook" ? "AutoSkill: optional hook unavailable; continuing the host task." : `AutoSkill：${error.message}`);
    // A failed optional hook must let the host task continue. Protocol stdout is
    // still a valid empty response; standalone CLI failures keep a nonzero exit.
    if (process.argv[2] === "hook") { process.stdout.write("{}\n"); process.exitCode = 0; }
    else process.exitCode = 1;
  });
}
