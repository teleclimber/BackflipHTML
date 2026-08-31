import { interpretBackcode } from './backcode.js';
import type { Parsed } from './backcode.js';
import { visitTNodes } from './walk.js';
import type { TNode } from './types.js';

// Re-export the domain modules helpers.ts was split into, so existing import
// sites (partials.ts, mod.ts, tests) that reach for these names via
// './helpers.js' keep working unchanged.
export * from './loc.js';
export * from './attrs.js';
export * from './assets.js';

// --- tag sets ---

export const DOCUMENT_LEVEL_TAGS = new Set(['html', 'head', 'body']);

// HTML void elements — no close tag, cannot contain children. Shared by the parser
// (parse-tree.ts), the partial scanner (partials.ts), and codegen.
export const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/**
 * Parse a `b-part` attribute value into its file/partialName components.
 *
 * Formats:
 *   "#name"           → same-file reference (file: null)
 *   "file.html#name"  → cross-file reference
 *   "name"            → bare name, same-file reference (file: null)
 */
export function parseBPartValue(value: string): { partialName: string; file: string | null } {
	if (value.startsWith('#')) {
		return { partialName: value.slice(1), file: null };
	}
	const hashIdx = value.indexOf('#');
	if (hashIdx > 0) {
		return { partialName: value.slice(hashIdx + 1), file: value.slice(0, hashIdx) };
	}
	return { partialName: value, file: null };
}

/**
 * Parse a `b-for` attribute value of the form `"item in items"` into
 * `{ valName, iterable }` (where `iterable` is the interpreted expression),
 * or return `{ error }` with a human-readable message describing what's wrong.
 *
 * Shared by the regular flow handler and the custom-element-call-with-flow
 * handler (lower.ts) so the two stay in sync.
 */
export function parseBForValue(value: string):
	| { valName: string; iterable: Parsed }
	| { error: string }
{
	const pieces = value.split(" in ");
	if (pieces.length !== 2) {
		return { error: `b-for value must be in the form "item in items", got: "${value}"` };
	}
	const valName = pieces[0].trim();
	if (!valName) {
		return { error: `got bad iter value name: ${valName}` };
	}
	return { valName, iterable: interpretBackcode(pieces[1].trim()) };
}

/**
 * True when `name` is a hyphenated tag that should be treated as a custom element
 * partial — i.e. it follows the HTML custom element naming rule (lowercase letter
 * start, contains a hyphen) but is NOT a backflip directive tag (b-*).
 */
export function isCustomElementTagName(name: string): boolean {
	if (!name) return false;
	if (name.startsWith('b-')) return false;
	return /^[a-z][a-z0-9]*-[a-z0-9-]*$/.test(name);
}

// --- text interpolation ---

// Matches a single `{{ expr }}` interpolation. Consumed by the text lowering
// in lower.ts (the single splitting implementation). Safe to share the `/g`
// instance because call sites use `String.prototype.matchAll`, which does not
// advance the regex's `lastIndex`.
export const INTERPOLATION_RE = new RegExp("({{[^{}]*}})", 'g');

// --- slot collection ---

/**
 * Collect slot names declared (via b-slot) in a list of tnodes.
 *
 * Includes b-slot declarations written inside a call body (a partial-ref's slot
 * content): those are lexically part of *this* partial and resolve against this
 * partial's slot map at render time — that is what makes slot forwarding work.
 */
export function collectSlots(tnodes: TNode[]): string[] {
	const slots: string[] = [];
	visitTNodes(tnodes, (tnode) => {
		if (tnode.type === 'slot') slots.push(tnode.name ?? 'default');
	});
	return slots;
}
