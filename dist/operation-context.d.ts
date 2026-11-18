export declare function operationSignal(): AbortSignal | undefined;
export declare function checkOperation(): void;
export declare function operationDelay(ms: number): Promise<void>;
export declare function withOperationDeadline<T>(ms: number, work: () => Promise<T>): Promise<T>;
