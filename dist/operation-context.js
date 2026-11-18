import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
// Hooks traverse several stores during initialization. One async scope gives all
// of their lock waits the same deadline without changing long-lived SDK callers.
const operations = new AsyncLocalStorage();
export function operationSignal() { return operations.getStore(); }
export function checkOperation() { operationSignal()?.throwIfAborted(); }
export async function operationDelay(ms) {
    await delay(ms, undefined, { signal: operationSignal() });
}
export async function withOperationDeadline(ms, work) {
    const controller = new AbortController();
    const parent = operationSignal();
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error("AutoSkill hook deadline exceeded.")), ms);
    try {
        return await operations.run(signal, work);
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=operation-context.js.map