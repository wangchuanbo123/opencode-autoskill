import * as fs from "node:fs/promises";
import * as path from "node:path";
/** Read only bounded project manifests; no shell, home search, environment values or recursive scan. */
export async function detectReuseEnvironment(root, signal) {
    const technologies = new Set(), facts = new Set();
    async function read(name) {
        signal?.throwIfAborted();
        const file = path.join(root, name);
        try {
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256_000)
                return;
            const content = await fs.readFile(file, "utf8");
            signal?.throwIfAborted();
            facts.add(`Project file exists: ${name}`);
            return content;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    const manifest = await read("package.json");
    if (manifest) {
        try {
            const value = JSON.parse(manifest);
            technologies.add("node");
            const dependencies = [...Object.keys(value.dependencies ?? {}), ...Object.keys(value.devDependencies ?? {})];
            const known = { next: "nextjs", react: "react", vue: "vue", svelte: "svelte", "@angular/core": "angular", express: "express",
                pg: "postgresql", mysql: "mysql", mysql2: "mysql", "better-sqlite3": "sqlite", sqlite3: "sqlite", redis: "redis", ioredis: "redis", mongodb: "mongodb", typescript: "typescript" };
            for (const dependency of dependencies)
                if (known[dependency])
                    technologies.add(known[dependency]);
        }
        catch { /* Invalid manifests supply no stack facts. */ }
    }
    for (const [marker, technology] of [["pyproject.toml", "python"], ["requirements.txt", "python"], ["go.mod", "go"], ["Cargo.toml", "rust"], ["pom.xml", "java"], ["Gemfile", "ruby"], ["composer.json", "php"], ["deno.json", "deno"], ["bun.lock", "bun"]]) {
        const content = await read(marker);
        if (content === undefined)
            continue;
        technologies.add(technology);
        if (technology === "python")
            for (const framework of ["django", "fastapi", "flask"])
                if (new RegExp(`\\b${framework}\\b`, "i").test(content))
                    technologies.add(framework);
    }
    // Plugin runtime versions are not assumed to be the project's subprocess runtime.
    return { technologies: [...technologies].sort(), platform: process.platform, facts: [...facts].sort() };
}
//# sourceMappingURL=reuse-environment.js.map