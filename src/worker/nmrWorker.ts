/**
 * NMR Web Worker entry point — runs the production OCL predictor off the main thread (with an explicit
 * fixture-provider option for tests). Mirrors the conformer worker's `globalThis` message wiring; all
 * behavior lives in the testable {@link createNmrWorkerHandler} core, so this file is never imported by tests (only instantiated as
 * a worker via `new Worker(new URL("./nmrWorker.ts", import.meta.url))`).
 */
import { createNmrWorkerHandler } from "./nmrWorkerCore";
import type { NmrWorkerRequest, NmrWorkerResponse } from "./protocol";

const post = (response: NmrWorkerResponse): void => {
  (globalThis as unknown as { postMessage(message: NmrWorkerResponse): void }).postMessage(response);
};

const handle = createNmrWorkerHandler(post);

globalThis.addEventListener("message", (event: MessageEvent<NmrWorkerRequest>) => {
  handle(event.data);
});
