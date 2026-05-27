import { generateStatement } from "../generate/js/generatejs.ts";
import type { Runtime } from "./backcode_runtime.ts";

/**
 * JS is the reference runtime. The harness asserts its result against the
 * test's `expected` first; a mismatch indicates a wrong test fixture, not a
 * runtime bug (backcode is a subset of JS).
 */
export const jsRuntime: Runtime = {
	name: "JS",
	available: () => Promise.resolve(true),
	evaluate(parsed, args) {
		const body = generateStatement(parsed.expr!);
		const fn = new Function(...parsed.vars, `return ${body};`);
		return Promise.resolve(fn(...args));
	},
};
