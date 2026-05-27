/**
 * Cross-language runtime equivalence for compiled backcode expressions.
 *
 * JS is the reference: every test first runs the case through the JS adapter
 * and asserts the result against `expected`. A JS failure means the test
 * itself is wrong (since backcode is a subset of JS). Then each non-JS
 * runtime evaluates the same case; mismatches are reported per-runtime as
 * "<lang> returned X, expected Y".
 *
 * To add a new target language: create backcode_runtime_<lang>.ts exporting a
 * `Runtime`, import it below, and push it into `runtimes`. No other changes
 * are required.
 */

import { assertEquals } from "jsr:@std/assert";
import { interpretBackcode } from "../backcode.ts";
import { cases, type TestCase } from "./backcode_cases.ts";
import type { Runtime } from "./backcode_runtime.ts";
import { jsRuntime } from "./backcode_runtime_js.ts";
import { phpRuntime } from "./backcode_runtime_php.ts";

const runtimes: Runtime[] = [phpRuntime];

function describe(value: unknown): string {
	return JSON.stringify(value) ?? String(value);
}

async function runCase(tc: TestCase) {
	const parsed = interpretBackcode(tc.code);
	if (parsed.errs.length) {
		throw new Error(`interpretBackcode errors for \`${tc.code}\`: ${parsed.errs.join("; ")}`);
	}
	const args = parsed.vars.map((v) => tc.inputs[v]);

	// JS reference: assertion failure here is a test-fixture bug.
	const jsResult = await jsRuntime.evaluate(parsed, args);
	assertEquals(
		jsResult,
		tc.expected,
		`JS reference mismatch for \`${tc.code}\`: JS returned ${describe(jsResult)}, expected ${describe(tc.expected)}`,
	);

	// Other runtimes: failures here are real divergences to fix later.
	for (const rt of runtimes) {
		if (!(await rt.available())) continue;
		let got: unknown;
		try {
			got = await rt.evaluate(parsed, args);
		} catch (e) {
			throw new Error(`${rt.name} threw for \`${tc.code}\`: ${e instanceof Error ? e.message : String(e)}`);
		}
		assertEquals(
			got,
			tc.expected,
			`${rt.name} returned ${describe(got)}, expected ${describe(tc.expected)} for \`${tc.code}\``,
		);
	}
}

for (const tc of cases) {
	Deno.test(`backcode equivalence: ${tc.name}`, () => runCase(tc));
}
