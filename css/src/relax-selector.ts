/**
 * Strip the pseudos Backflip cannot answer out of a selector, so what remains
 * can be matched against the instance forest.
 *
 * Backflip analyzes templates. There is no browser, no user, no session —
 * whether an element is hovered, focused, visited or checked is not a property
 * of the template but a state the page passes through over its life. The only
 * honest static answer is "assume it can be true": remove the pseudo, test what
 * is left, and report the rule as targeting that element. `pseudo-categories.ts`
 * is the criterion for which pseudos those are.
 *
 * Relaxation is a matching-only transform. The selector that gets *reported*,
 * and the specificity it is scored with, stay as authored — `:hover` counts
 * toward specificity and the LSP must show `.card:hover`, not `.card`. See
 * `selector-match.ts`, which is the only caller that matches.
 */

import { isTraversal, parse, stringify, SelectorType } from 'css-what';
import type { Selector } from 'css-what';
import { categoryOf, isStrippable, type PseudoCategory } from './pseudo-categories.js';

/** One pseudo removed from a selector, and why it could not be answered. */
export interface StrippedPseudo {
	/** As authored, with colons: ':hover', '::before'. */
	text: string;
	/** `css-what` token name, lowercased: 'hover', 'before'. */
	name: string;
	category: PseudoCategory;
}

export interface RelaxedSelector {
	/** The selector as authored. Always what gets reported and scored. */
	original: string;
	/** What is handed to `css-select`. Equals `original` when nothing was stripped. */
	relaxed: string;
	/** Empty when nothing was stripped. Order follows the selector left to right. */
	stripped: StrippedPseudo[];
}

/** A pseudo-class or pseudo-element token — the only two kinds relaxation removes. */
type PseudoToken = Extract<Selector, { type: SelectorType.Pseudo | SelectorType.PseudoElement }>;

/** Per-call state: what was stripped, and how the author spelled it. */
interface Relaxation {
	spellings: Map<string, string[]>;
	stripped: StrippedPseudo[];
	/** Set when a pseudo name is not an identifier — see `CSS_IDENT`. */
	malformed: boolean;
}

// --- Authored spelling ---

/**
 * The colon prefixes each pseudo name was written with, in textual order.
 *
 * `css-what` 8 tokenizes `:before` and `::before` identically — both as
 * pseudo-*elements* — so the token cannot say which spelling the author used
 * and the text has to. Quoted strings are skipped, so a `[data-x=":hover"]` or
 * a `:contains(":focus")` contributes nothing.
 */
function authoredSpellings(selector: string): Map<string, string[]> {
	const spellings = new Map<string, string[]>();
	let quote = '';
	for (let i = 0; i < selector.length; i++) {
		const char = selector[i];
		if (quote) {
			if (char === '\\') i++;
			else if (char === quote) quote = '';
			continue;
		}
		if (char === '"' || char === "'") { quote = char; continue; }
		if (char !== ':') continue;
		let colons = ':';
		if (selector[i + 1] === ':') { colons = '::'; i++; }
		const name = /^[\w\u00a0-\uffff-]+/.exec(selector.slice(i + 1))?.[0];
		if (!name) continue;
		i += name.length;
		const seen = spellings.get(name.toLowerCase());
		if (seen) seen.push(colons);
		else spellings.set(name.toLowerCase(), [colons]);
	}
	return spellings;
}

/**
 * Record `token` as stripped, spelled the way the author spelled it.
 *
 * Occurrences of one name are consumed in textual order. That holds even though
 * recording order is not textual order — `:not(:focus)` records `:focus` before
 * `:not` — because each name keeps its own queue.
 */
function record(token: PseudoToken, state: Relaxation): void {
	const name = token.name.toLowerCase();
	const colons = state.spellings.get(name)?.shift()
		?? (token.type === SelectorType.PseudoElement ? '::' : ':');
	state.stripped.push({ text: `${colons}${name}`, name, category: categoryOf(name) });
}

// --- The walk ---

/**
 * A CSS identifier, which is what a pseudo name has to be.
 *
 * `css-what` is lenient where `css-tree` is not: it reads `:::nope` as a
 * pseudo-element *named* `:nope` rather than rejecting it. Stripping a name
 * like that would relax a selector that was never valid into something that
 * matches — `:::nope` into `*` — so a name that is not an identifier aborts
 * relaxation instead, and the selector is reported as unreadable.
 */
const CSS_IDENT = /^-{0,2}[A-Za-z_\u00a0-\uffff][\w\u00a0-\uffff-]*$/;

function universal(): Selector {
	return { type: SelectorType.Universal, namespace: null };
}

/**
 * Relax one token, returning null when it is stripped.
 *
 * Rule 2 lives here: a functional pseudo recurses into its argument, drops any
 * alternative that empties, and — if every alternative goes — is itself
 * dropped, recorded after its contents. Keeping `:not()` while dropping its
 * inside would invert the meaning, and an empty `:not()` is invalid anyway.
 */
function relaxToken(token: Selector, state: Relaxation): Selector | null {
	if (token.type !== SelectorType.Pseudo && token.type !== SelectorType.PseudoElement) {
		return token;
	}
	if (!CSS_IDENT.test(token.name)) {
		state.malformed = true;
		return token;
	}
	if (isStrippable(token.name)) {
		record(token, state);
		return null;
	}
	// Only `css-what`'s "unpacked" pseudos — `:is`, `:not`, `:where`, `:has`,
	// `:host`, … — carry a parsed selector list. Everything else is a raw string.
	if (token.type !== SelectorType.Pseudo || !Array.isArray(token.data)) return token;

	const alternatives: Selector[][] = [];
	for (const alternative of token.data) {
		const relaxed = relaxComplex(alternative, state);
		if (relaxed.length > 0) alternatives.push(relaxed);
	}
	if (alternatives.length === 0) {
		record(token, state);
		return null;
	}
	return { ...token, data: alternatives };
}

/**
 * Relax one complex selector — a compound sequence with combinators between.
 *
 * Rule 1 lives here: a compound that had tokens and lost every one becomes `*`,
 * never the invalid `.a > `. The exception is a complex made of a single
 * compound: emptying that means the whole thing relaxed away, and what to put
 * in its place depends on where it sits, so `[]` comes back and the caller
 * decides — `*` at the top level, a dropped alternative inside a functional
 * pseudo. A compound that was empty to begin with stays empty, which is what
 * keeps a relative selector like `:has(> .b)` from becoming `:has(* > .b)`.
 */
function relaxComplex(tokens: Selector[], state: Relaxation): Selector[] {
	const compounds: Selector[][] = [[]];
	const combinators: Selector[] = [];
	for (const token of tokens) {
		if (isTraversal(token)) {
			combinators.push(token);
			compounds.push([]);
		} else {
			compounds[compounds.length - 1].push(token);
		}
	}

	const relaxed = compounds.map(compound => {
		const kept: Selector[] = [];
		for (const token of compound) {
			const result = relaxToken(token, state);
			if (result) kept.push(result);
		}
		if (kept.length === 0 && compound.length > 0 && combinators.length > 0) return [universal()];
		return kept;
	});

	const out: Selector[] = [];
	for (let i = 0; i < relaxed.length; i++) {
		if (i > 0) out.push(combinators[i - 1]);
		out.push(...relaxed[i]);
	}
	return out;
}

function relax(selector: string): RelaxedSelector {
	let parsed: Selector[][];
	try {
		parsed = parse(selector);
	} catch {
		// `css-tree` accepted something `css-what` will not parse. Hand the
		// selector on untouched; `compileSelector` reports it as unreadable.
		return { original: selector, relaxed: selector, stripped: [] };
	}

	const state: Relaxation = {
		spellings: authoredSpellings(selector),
		stripped: [],
		malformed: false,
	};
	const alternatives = parsed.map(alternative => {
		const relaxed = relaxComplex(alternative, state);
		// Rule 1 at the top level: `::selection { }` becomes `*`, reporting as
		// targeting every element. That is faithful — the rule really does apply
		// everywhere — and `stripped` is what lets a consumer present it as
		// "applies globally" instead of enumerating the whole tree.
		return relaxed.length > 0 ? relaxed : [universal()];
	});

	// A name css-what read but CSS would not: relax nothing, and let the
	// selector be reported as unreadable rather than relaxed into matching.
	if (state.malformed) return { original: selector, relaxed: selector, stripped: [] };

	// Rule 3: nothing stripped means nothing rewritten. Returning `original`
	// rather than a `stringify` round-trip keeps the common path from perturbing
	// a selector at all.
	if (state.stripped.length === 0) return { original: selector, relaxed: selector, stripped: [] };

	return { original: selector, relaxed: stringify(alternatives), stripped: state.stripped };
}

// --- Public entry point ---

const relaxCache = new Map<string, RelaxedSelector>();

/**
 * Remove every pseudo `pseudo-categories.ts` says Backflip cannot answer,
 * leaving a selector `css-select` can run against the instance forest.
 *
 * Memoized: the same selector text always gives back the same object.
 */
export function relaxSelector(selector: string): RelaxedSelector {
	let cached = relaxCache.get(selector);
	if (!cached) {
		cached = relax(selector);
		relaxCache.set(selector, cached);
	}
	return cached;
}
