import { generatePhpFunction } from "../generate/php/generatephp.ts";
import type { Runtime } from "./backcode_runtime.ts";

/**
 * PHP runtime adapter.
 *
 * Spawns one `php -r` subprocess per case. The subprocess emits a typed
 * self-describing string (not json_encode) so the wire format preserves type
 * tags explicitly:
 *
 *   null            literal "null"
 *   bool            "true" / "false"
 *   int             "int:<digits>"
 *   float           "float:<digits>" / "nan" / "inf" / "-inf"
 *   string          "str:" + JSON-encoded string body
 *   array/object    "arr:" + json_encode (rare; not in current corpus)
 *
 * This avoids JSON syntax ambiguities (e.g. PHP `5.0` and `5` both rendering
 * as `5`, or `null` vs literal string `"null"` distinguishable only by quotes).
 */

const PHP_DUMP_FN = `
function bf_dump($v) {
	if ($v === null) return 'null';
	if ($v === true) return 'true';
	if ($v === false) return 'false';
	if (is_int($v)) return 'int:' . $v;
	if (is_float($v)) {
		if (is_nan($v)) return 'nan';
		if (is_infinite($v)) return $v > 0 ? 'inf' : '-inf';
		return 'float:' . $v;
	}
	if (is_string($v)) return 'str:' . json_encode($v);
	if (is_array($v)) return 'arr:' . json_encode($v);
	return 'unknown:' . gettype($v);
}
`.replace(/\s+/g, " ").trim();

function decodePhpDump(s: string): unknown {
	if (s === "null") return null;
	if (s === "true") return true;
	if (s === "false") return false;
	if (s === "nan") return NaN;
	if (s === "inf") return Infinity;
	if (s === "-inf") return -Infinity;
	if (s.startsWith("int:")) return parseInt(s.slice(4), 10);
	if (s.startsWith("float:")) return parseFloat(s.slice(6));
	if (s.startsWith("str:")) return JSON.parse(s.slice(4));
	if (s.startsWith("arr:")) return JSON.parse(s.slice(4));
	throw new Error(`unrecognized PHP dump: ${JSON.stringify(s)}`);
}

let phpAvailability: Promise<boolean> | null = null;
function checkPhpAvailable(): Promise<boolean> {
	if (phpAvailability) return phpAvailability;
	phpAvailability = (async () => {
		try {
			const out = await new Deno.Command("php", {
				args: ["-v"],
				stdout: "piped",
				stderr: "piped",
			}).output();
			if (!out.success) {
				console.warn("PHP binary returned non-zero; skipping PHP runtime equivalence tests");
				return false;
			}
			return true;
		} catch {
			console.warn("PHP binary not found in PATH; skipping PHP runtime equivalence tests");
			return false;
		}
	})();
	return phpAvailability;
}

export const phpRuntime: Runtime = {
	name: "PHP",
	available: checkPhpAvailable,
	async evaluate(parsed, args) {
		const closure = generatePhpFunction("", parsed);
		const script =
			PHP_DUMP_FN +
			` $args = json_decode(getenv('BF_INPUTS'), true);` +
			` $fn = ${closure};` +
			` echo bf_dump($fn(...$args));`;
		const out = await new Deno.Command("php", {
			args: ["-r", script],
			env: { BF_INPUTS: JSON.stringify(args) },
			stdout: "piped",
			stderr: "piped",
		}).output();
		if (!out.success) {
			throw new Error(`php exited non-zero: ${new TextDecoder().decode(out.stderr)}`);
		}
		return decodePhpDump(new TextDecoder().decode(out.stdout));
	},
};
