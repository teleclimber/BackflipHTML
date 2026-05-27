import type { Parsed } from "../backcode.ts";

/**
 * Adapter interface for a target language runtime.
 *
 * To add a language X, create backcode_runtime_<x>.ts exporting a Runtime,
 * then import it from backcode_test.ts and push it into the runtimes list.
 *
 * - `available()` should return false (and log a warning) when the language
 *   toolchain isn't installed; the harness will skip rather than fail.
 * - `evaluate()` receives the parsed backcode expression and the input values
 *   already reordered to match `parsed.vars`. It must return a JS-native
 *   value comparable to the JS reference via assertEquals.
 */
export type Runtime = {
	name: string;
	available(): Promise<boolean>;
	evaluate(parsed: Parsed, args: unknown[]): Promise<unknown>;
};
