// A collector's deadline covers all HTTP requests and adapter retries in that attempt.
import { AsyncLocalStorage } from "node:async_hooks";
const scope = new AsyncLocalStorage<AbortSignal>();
export const currentRequestSignal = () => scope.getStore();
export function withRequestDeadline<T>(
  milliseconds: number,
  shutdown: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  return scope.run(
    AbortSignal.any([shutdown, AbortSignal.timeout(milliseconds)]),
    fn,
  );
}
