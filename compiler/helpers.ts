import { interpretBackcode } from './backcode.js';
import type { Parsed } from './backcode.js';
import { BackflipError } from './errors.js';
import { visitTNodes } from './walk.js';
import { interpolationLoc } from './loc.js';
import type {
	TNode,
	RawTNode,
	PrintTNode,
	IfTNode,
	PartialRefTNode,
	ParentTNode,
} from './types.js';

// Re-export the domain modules helpers.ts was split into, so existing import
// sites (compiler.ts, partials.ts, mod.ts, tests) that reach for these names via
// './helpers.js' keep working unchanged.
export * from './loc.js';
export * from './attrs.js';
export * from './assets.js';

// --- tag sets ---

export const DOCUMENT_LEVEL_TAGS = new Set(['html', 'head', 'body']);

// HTML void elements — no close tag, cannot contain children. Shared by the parser
// (compiler.ts), the partial scanner (partials.ts), and codegen.
export const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// --- parser-state types ---

export type TagMatcher = {
	tag: string,
	tnode?: TNode,
	parent?: ParentTNode | null,   // cur_parent to restore on close (the value at open time, may be null)
	hasParent?: boolean,           // true when `parent` was explicitly saved (distinguishes "no entry" from "saved null")
	slotCollection?: {
		partialRef: PartialRefTNode,
		partialRefParent: ParentTNode,   // container of the partialRef (replaces the dropped node.parent field)
		currentSlot: string   // 'default' or named
	}
}

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
 * Shared by `handleBFor` and the custom-element-call-with-flow handler so the
 * two stay in sync.
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

// --- if-branch lookup ---

// This should be renamed to InPartial?
export function findPrecedingIfInFile(cur: TNode, parent: ParentTNode | null, loc?: { filename?: string, line?: number, col?: number }): IfTNode {
	if (cur.type === 'if') return cur;
	if (parent && 'tnodes' in parent) {
		const siblings = parent.tnodes;
		for (let i = siblings.length - 1; i >= 0; i--) {
			if (siblings[i].type === 'if') return siblings[i] as IfTNode;
			if (siblings[i].type === 'raw' && (siblings[i] as RawTNode).raw.trim() === '') continue;
			break;
		}
	}
	throw new BackflipError("b-else-if/b-else must follow a b-if block", loc);
}

export function findPrecedingIfInSlot(arr: TNode[], loc?: { filename?: string, line?: number, col?: number }): IfTNode {
	for (let i = arr.length - 1; i >= 0; i--) {
		if (arr[i].type === 'if') return arr[i] as IfTNode;
		if (arr[i].type === 'raw' && (arr[i] as RawTNode).raw.trim() === '') continue;
		break;
	}
	throw new BackflipError("b-else-if/b-else must follow a b-if block", loc);
}

// --- text / raw node helpers ---

// Matches a single `{{ expr }}` interpolation. Shared by onText (here) and the
// slot-text handler in compiler.ts. Safe to share the `/g` instance because both
// call sites use `String.prototype.matchAll`, which does not advance the regex's
// `lastIndex`.
export const INTERPOLATION_RE = new RegExp("({{[^{}]*}})", 'g');

export function onText(cur:TNode, parent: ParentTNode, raw :string, textLoc?: {startLine:number;startCol:number;startOffset:number}, errors?: BackflipError[]) :TNode {
	// later match string against {{ }}
	const matches = raw.matchAll(INTERPOLATION_RE);

	let raw_it = 0;
	for( const m of matches ) {
		if( m.index > raw_it ) {
			cur = pushRaw(cur, parent, raw.substring(raw_it, m.index));
		}
		const code_str = m[0].substring(2, m[0].length -2).trim();
		if( !code_str ) {
			// empty {{ }}, treat as raw text
			cur = pushRaw(cur, parent, m[0]);
			raw_it = m.index + m[0].length;
			continue;
		}
		const code_parsed = interpretBackcode(code_str);

		const print_node :PrintTNode = {
			type: 'print',
			data: code_parsed,
		};
		const printLoc = textLoc ? interpolationLoc(textLoc, raw.substring(0, m.index), m[0]) : undefined;
		if (printLoc) print_node.loc = printLoc;
		if (errors) {
			for (const err of code_parsed.errs) {
				errors.push(new BackflipError(err, printLoc));
			}
		}
		if( !parent.tnodes ) throw new BackflipError("expected tnodes here");
		parent.tnodes.push(print_node);
		cur = print_node;

		raw_it = m.index + m[0].length;
	}

	if( raw_it < raw.length ) {
		cur = pushRaw(cur, parent, raw.substring(raw_it, raw.length));
	}

	return cur;
}

export function pushRaw(cur_tnode: TNode, parent: ParentTNode, raw :string) :TNode {
	if( cur_tnode.type === 'raw' ) {
		cur_tnode.raw += raw
	}
	else {
		const raw_node :TNode = {
			type: 'raw',
			raw: raw,
		};
		if( !parent.tnodes ) throw new BackflipError("expected tnodes here");
		parent.tnodes.push(raw_node);
		cur_tnode = raw_node;
	}
	return cur_tnode;
}

// --- slot collection ---

/**
 * Walk the open-tag stack and return the innermost slot-collection context.
 * Stops at any entry with a structural `tnode` first — content inside b-for/b-if
 * should flow into that node's tree, not into the slot above it.
 */
export function getSlotCollection(tag_stack: TagMatcher[]): { partialRef: PartialRefTNode, partialRefParent: ParentTNode, currentSlot: string } | null {
	for (let i = tag_stack.length - 1; i >= 0; i--) {
		if (tag_stack[i].slotCollection) {
			return tag_stack[i].slotCollection!;
		}
		if (tag_stack[i].tnode) {
			return null;
		}
	}
	return null;
}

/**
 * Collect slot names declared (via b-slot) in a list of tnodes.
 *
 * `skipPartialRefSlots` is used because slot content passed to a *child* partial
 * (inside a partial-ref's slots) belongs to that other partial's call, not to
 * this one — so its b-slot declarations must not be collected here.
 */
export function collectSlots(tnodes: TNode[]): string[] {
	const slots: string[] = [];
	visitTNodes(tnodes, (tnode) => {
		if (tnode.type === 'slot') slots.push(tnode.name ?? 'default');
	}, { skipPartialRefSlots: true });
	return slots;
}
