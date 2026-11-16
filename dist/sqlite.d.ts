export interface SqlStatement {
    get(...values: unknown[]): unknown;
    all(...values: unknown[]): unknown[];
    run(...values: unknown[]): unknown;
}
export interface SqlDatabase {
    exec(sql: string): unknown;
    prepare(sql: string): SqlStatement;
    close(): void;
}
export declare function sqliteBusy(error: unknown): boolean;
/** Reject links before letting SQLite access its database or WAL sidecars. */
export declare function assertSqliteFiles(file: string): Promise<void>;
/** Uses only the built-in driver verified in Node 24 and OpenCode 2.2.7 / Bun 1.4.4. */
export declare function openSqlite(file: string, prepare: () => Promise<unknown>): Promise<SqlDatabase>;
export declare function beginImmediate(database: SqlDatabase, waitMs?: number): Promise<boolean>;
export declare function realDirectoryTree(root: string, directory: string): Promise<void>;
