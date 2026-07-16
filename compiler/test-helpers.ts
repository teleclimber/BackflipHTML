// Shared test helpers for the compiler test suites (compiler_test.ts,
// assets_test.ts, …). Kept out of any single *_test.ts file so tests that
// concern a specific module can live in their own file without duplicating the
// compile harness. This file defines no Deno.test cases, so it is not run on its
// own — it is imported by the test files that need it.

import type {
	TNode, RawTNode, ElementTNode, ForTNode, IfTNode,
	CompiledFile, CompileOptions, PartialDef,
} from "./types.js";
import { compilePartial } from "./compiler.js";
import { flattenStatics } from "./flatten.js";
import type { BackflipError } from "./errors.js";

/**
 * Serialize a TNode subtree back to its expected rendered HTML for *static* content
 * (i.e. content with no dynamic expressions). Used to keep regression assertions
 * concise; throws if it encounters anything that requires runtime evaluation.
 *
 * Delegates to `flattenStatics` — fully-static subtrees collapse to RawTNodes whose
 * `.raw` is the rendered HTML. Anything that doesn't reduce to raw (print, for, if,
 * partial-ref, slot, element with dynamic/asset attrs or non-raw children) throws.
 */
export function renderStatic(tnodes: TNode[]): string {
	const flat = flattenStatics({ type: 'root', kind: 'named', tnodes });
	let out = '';
	for (const node of flat.tnodes) {
		if (node.type !== 'raw') {
			throw new Error(`renderStatic: cannot render ${node.type}`);
		}
		out += (node as RawTNode).raw;
	}
	return out;
}

/** Find the first ElementTNode (depth-first) with the given tag name in a list of TNodes. */
export function findElement(tnodes: TNode[], tagName: string): ElementTNode | undefined {
	for (const n of tnodes) {
		if (n.type === 'element' && (n as ElementTNode).tagName === tagName) return n as ElementTNode;
		if (n.type === 'element') {
			const found = findElement((n as ElementTNode).tnodes, tagName);
			if (found) return found;
		}
		if (n.type === 'for') {
			const found = findElement((n as ForTNode).tnodes, tagName);
			if (found) return found;
		}
		if (n.type === 'if') {
			for (const b of (n as IfTNode).branches) {
				const found = findElement(b.tnodes, tagName);
				if (found) return found;
			}
		}
	}
	return undefined;
}

/**
 * Test helper: compile a single-partial HTML snippet by inferring the partial's
 * name and customElement flag from the source. Mirrors the old `compileFile`
 * signature so test bodies stay terse, but internally drives the new
 * `compilePartial` primitive — i.e. tests using this exercise compilePartial,
 * not scanPartials. Tests that need multi-partial behavior live in
 * partials_test.ts (where compileDirectory / scanPartials live).
 */
export async function compileFile(
	html: string,
	_registry?: unknown,
	filename?: string,
	options?: CompileOptions,
): Promise<{ compiled: CompiledFile, errors: BackflipError[] }> {
	const def = inferPartialDef(html, filename ?? '');
	const { compiled: root, errors } = await compilePartial(html, def, options);
	return { compiled: { partials: new Map([[def.name, root]]) }, errors };
}

export function inferPartialDef(html: string, filename: string): PartialDef {
	// Find the first opening tag in the snippet.
	const m = html.match(/<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/);
	if (!m) throw new Error(`compileFile (test helper): no opening tag in: ${html.slice(0, 80)}`);
	const tagName = m[1];
	const attrText = m[2];
	const bNameMatch = attrText.match(/\bb-name\s*=\s*"([^"]*)"/);
	const exported = /\bb-export(?:\b|=)/.test(attrText);
	const customElement = !bNameMatch && /^[a-z][a-z0-9]*-[a-z0-9-]*$/.test(tagName);
	const name = bNameMatch ? bNameMatch[1] : tagName;
	const lines = html.split('\n').length;
	return {
		name,
		exported,
		customElement,
		loc: { filename, from: 1, to: lines },
	};
}
