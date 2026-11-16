#!/usr/bin/env node
import { runCli } from "./cli.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
export { runCli } from "./cli.mjs";
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(`AutoSkill：${error.message}`);
    process.exitCode = 1;
  });
}
