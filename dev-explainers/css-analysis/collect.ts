import { parse as parseSelector, stringify as stringifySelector } from 'css-what';
import { calculate } from 'specificity';
import type { CompiledFile, RootTNode, SourceLoc, TNode } from '@backflip/html';
import { resolvePartial, visitTNodes } from '@backflip/html';
// Reaching straight into the analyzer's modules, not its public API. An
// explainer is a dev aid with a short life; the package it explains should not
// grow exports to accommodate it.
import { parseCssFile } from '../../css/src/parse-css.js';
import {
	attrsOf, buildInstanceForest, FOR_REPS, MAX_DEPTH, MAX_INSTANCES,
	type InstanceForest, type InstanceNode,
} from '../../css/src/instance-tree.js';
import { compileSelector, matchSelectors } from '../../css/src/selector-match.js';
import {
	attrIndexOf, isElementLike, tagNameOf, type ElementLikeTNode,
} from '../../css/src/tnode-view.js';
import type { CssRule } from '../../css/src/types.js';

/**
 * Run the CSS analyzer over a compiled directory and record what it did at each
 * stage, as a plain JSON payload for `page.ts` to render.
 *
 * Everything here comes from the analyzer's own exports — `parseCssFile`,
 * `buildInstanceForest`, `compileSelector`, `matchSelectors`. Nothing about the
 * model is re-implemented, because a tool that explains a second implementation
 * explains nothing.
 */

// --- Payload ---

export interface ExplainPayload {
	meta: Meta;
	rules: RuleView[];
	selectors: SelectorView[];
	partials: PartialView[];
	authoring: AuthoringView[];
	trees: TreeView[];
	instances: InstanceView[];
	elements: ElementView[];
}

/**
 * One expansion root's tree. The forest is a set of these, and they are sealed
 * off from each other: `getParent` stops at a top and `getSiblings` returns
 * only the tops of the same tree, so no combinator crosses a boundary.
 */
export interface TreeView {
	id: number;
	/** The partial expansion started from, when it can be attributed — see below. */
	rootPartialId: number | null;
	reason: 'entry' | 'unreached' | null;
	/** Top-level instances, in render order. */
	tops: number[];
	/** Instances in this tree, tops and descendants. */
	size: number;
}

export interface Meta {
	project: string;
	cssFiles: string[];
	generated: string;
	forReps: number;
	maxDepth: number;
	maxInstances: number;
	truncated: boolean;
	/** Asset directory names the templates were compiled against, `@name` order. */
	assetDirs: string[];
	/** Where the backflip.json came from, relative to the cwd; absent when none was used. */
	configDir?: string;
	/** Compile diagnostics for the templates this run analysed. */
	warnings: string[];
	counts: {
		files: number;
		partials: number;
		rules: number;
		selectors: number;
		instances: number;
		matchedElements: number;
	};
	timings: { label: string; ms: number }[];
}

export interface RuleView {
	id: number;
	selectorText: string;
	selectorIds: number[];
	properties: { name: string; value: string }[];
	media: string[];
	line: number;
}

export interface SelectorView {
	id: number;
	text: string;
	ruleId: number;
	specificity: [number, number, number];
	valid: boolean;
	/**
	 * The selector's compound steps, rightmost first: `.item`, then
	 * `.wrap .item`. Each one is compiled and run for real, so the first step
	 * that loses instances is where a selector stops matching.
	 */
	steps: { text: string; hits: number }[];
	/** Instances this selector matched, by id. */
	hits: number[];
}

export interface PartialView {
	id: number;
	file: string;
	name: string;
	kind: 'named' | 'custom-element';
	/** Call sites that target this partial. */
	calledFrom: { file: string; partial: string; line?: number; label: string }[];
	/** Set when expansion started here, with the reason it was chosen. */
	rootReason: 'entry' | 'unreached' | null;
	instanceCount: number;
	authoringId: number | null;
}

export interface AuthoringView {
	id: number;
	partialId: number;
	/**
	 * `b-name` / `ce-partial` head a partial's own tree; every other kind is a
	 * node written inside one. The two definition kinds are kept apart because
	 * they place their tag differently — see `rule`.
	 */
	kind: 'b-name' | 'ce-partial' | 'element' | 'custom-element' | 'b-part' | 'slot' | 'for' | 'if' | 'branch' | 'print' | 'text';
	/** What the node is, e.g. `div.wrap`, `b-part`, `b-for`. */
	label: string;
	/** The rule the expander applies to it. */
	rule: string;
	/** Source text for the node's own tag or directive, when it has a location. */
	source: string | null;
	line: number | null;
	/** The partial a `b-part` / custom-element call resolves to. */
	targetPartialId: number | null;
	/** Slot names this call fills. */
	fills: string[];
	children: number[];
	/** Instances whose source node this is. Empty for containers, which render nothing. */
	instances: number[];
}

export interface InstanceView {
	id: number;
	authoringId: number;
	tag: string;
	classes: string[];
	elementId: string | null;
	attrs: { name: string; value: string | null }[];
	file: string;
	partial: string;
	depth: number;
	conditional: boolean;
	via: string;
	/** Index into `trees`. Instances of different trees never match together. */
	treeId: number;
	parent: number | null;
	children: number[];
	/** Slot bindings in scope for this instance's children. */
	slots: { name: string; fills: number; from: string }[];
	/** Selectors that matched this instance. */
	matched: number[];
}

export interface ElementView {
	authoringId: number;
	file: string;
	partial: string;
	line: number;
	label: string;
	instances: number[];
	matches: {
		selectorId: number;
		hits: number;
		total: number;
		conditionalHit: boolean;
		matchType: 'definite' | 'conditional' | 'dynamic';
	}[];
}

export interface ExplainInput {
	/** Label for the analysed project, shown in the header. */
	project: string;
	/** Compiled trees, exactly what `analyzeCss` would receive. */
	compiled: Map<string, CompiledFile>;
	/** Template sources, keyed the same way, for quoting source text. */
	sources: Map<string, string>;
	cssContent: string;
	cssFiles: string[];
	/**
	 * Asset directory names the templates were compiled against. Reported on the
	 * page so a run missing its asset configuration — which makes the compiler
	 * drop every `src~` attribute — is visible rather than inferred from the
	 * diagnostics it causes.
	 */
	assetDirs?: string[];
	/** Where the backflip.json came from, relative to the cwd. */
	configDir?: string;
	/** Compile diagnostics to surface alongside the results. */
	warnings?: string[];
}

// --- Small helpers ---

function sliceSource(sources: Map<string, string>, file: string, loc?: SourceLoc): string | null {
	if (!loc) return null;
	const text = sources.get(file);
	if (!text) return null;
	const raw = text.slice(loc.startOffset, loc.endOffset);
	if (!raw) return null;
	const oneLine = raw.replace(/\s+/g, ' ').trim();
	return oneLine.length > 160 ? `${oneLine.slice(0, 157)}…` : oneLine;
}

function describe(node: ElementLikeTNode): { tag: string; classes: string[]; id: string | null } {
	const index = attrIndexOf(node);
	const classValue = index.values.get('class') ?? '';
	return {
		tag: tagNameOf(node),
		classes: classValue.split(/\s+/).filter(Boolean),
		id: index.values.get('id') ?? null,
	};
}

function label(node: ElementLikeTNode): string {
	const { tag, classes, id } = describe(node);
	return tag + (id ? `#${id}` : '') + classes.map(c => `.${c}`).join('');
}

/**
 * A selector's compound steps, rightmost first — `.item`, then `.wrap .item`.
 *
 * Compiling and running each step in turn says where a selector stops
 * reaching, which is what a reader wants when a rule misses what they expected.
 * Splitting follows css-what's grammar rather than a regex, so `:has(> .x)` and
 * attribute values containing combinators survive.
 */
function selectorSteps(selector: string): string[] {
	const COMBINATORS = new Set([
		'descendant', 'child', 'parent', 'sibling', 'adjacent',
		'columnCombinator', '_flexibleDescendant',
	]);
	try {
		const parsed = parseSelector(selector);
		if (parsed.length !== 1) return [selector];
		const tokens = parsed[0];
		const starts = [0];
		tokens.forEach((token, i) => {
			if (COMBINATORS.has(token.type)) starts.push(i + 1);
		});
		const steps = starts
			.map(start => stringifySelector([tokens.slice(start)]))
			.filter(Boolean)
			.reverse();
		// A one-compound selector is its own only step; don't report it twice.
		return steps.length > 1 ? steps : [selector];
	} catch {
		return [selector];
	}
}

/** Specificity for a selector, including ones that matched nothing. */
function specificityOf(selector: string): [number, number, number] {
	try {
		const result = calculate(selector);
		return [result.A, result.B, result.C];
	} catch {
		return [0, 0, 0];  // an invalid selector has no specificity to report
	}
}

// --- Authoring tree ---

interface AuthoringBuild {
	views: AuthoringView[];
	byTNode: Map<ElementLikeTNode, number>;
}

function buildAuthoring(
	input: ExplainInput,
	partials: PartialView[],
	partialIdOf: Map<RootTNode, number>,
): AuthoringBuild {
	const views: AuthoringView[] = [];
	const byTNode = new Map<ElementLikeTNode, number>();

	const add = (fields: Omit<AuthoringView, 'id' | 'children' | 'instances'>): AuthoringView => {
		const view: AuthoringView = { ...fields, id: views.length, children: [], instances: [] };
		views.push(view);
		return view;
	};

	for (const partial of partials) {
		const compiled = input.compiled.get(partial.file)!;
		const root = compiled.partials.get(partial.name)!;
		const partialView = add({
			partialId: partial.id,
			kind: partial.kind === 'custom-element' ? 'ce-partial' : 'b-name',
			label: partial.name,
			rule: partial.kind === 'custom-element'
				? 'custom-element definition — the tag is rendered by the call site, so this node has no instances of its own'
				: 'b-name definition — its own tag is the element below, which carries the instances',
			source: null,
			line: root.meta?.startLine ?? null,
			targetPartialId: null,
			fills: [],
		});
		partial.authoringId = partialView.id;

		const walk = (tnodes: TNode[], into: number[]): void => {
			for (const n of tnodes) {
				const line = 'loc' in n && n.loc ? n.loc.startLine : null;
				switch (n.type) {
					case 'element': {
						const view = add({
							partialId: partial.id,
							kind: 'element',
							label: label(n),
							rule: 'one instance, in place',
							source: sliceSource(input.sources, partial.file, n.openTagLoc ?? n.loc),
							line: n.openTagLoc?.startLine ?? line,
							targetPartialId: null,
							fills: [],
						});
						byTNode.set(n, view.id);
						into.push(view.id);
						walk(n.tnodes, view.children);
						break;
					}
					case 'partial-ref': {
						const target = resolvePartial(n, compiled, input.compiled);
						const targetId = target ? partialIdOf.get(target) ?? null : null;
						const fills = Object.keys(n.slots);
						const custom = n.kind === 'custom-element';
						const view = add({
							partialId: partial.id,
							kind: custom ? 'custom-element' : 'b-part',
							label: custom
								? `<${n.callerTagName ?? n.partialName}>`
								: `b-part="${n.file ? `${n.file}#` : '#'}${n.partialName}"`,
							rule: custom
								? (target
									? 'one instance: caller attrs ++ definition attrs, children = the target body'
									: 'unknown element: one instance with caller attrs, children = the default slot')
								: (target
									? 'no instance of its own — the target body is spliced in here'
									: 'unresolved: renders nothing'),
							source: sliceSource(input.sources, partial.file, n.loc),
							line,
							targetPartialId: targetId,
							fills,
						});
						if (custom) byTNode.set(n, view.id);
						into.push(view.id);
						for (const [slotName, slotNodes] of Object.entries(n.slots)) {
							if (slotNodes.length === 0) continue;
							const fill = add({
								partialId: partial.id,
								kind: 'slot',
								label: `b-in="${slotName}"`,
								rule: 'fill: renders where the target\'s matching b-slot sits',
								source: null,
								line: null,
								targetPartialId: null,
								fills: [],
							});
							view.children.push(fill.id);
							walk(slotNodes, fill.children);
						}
						break;
					}
					case 'slot': {
						const view = add({
							partialId: partial.id,
							kind: 'slot',
							label: `b-slot="${n.name ?? 'default'}"`,
							rule: 'the caller\'s fill, expanded in the environment it was written in',
							source: sliceSource(input.sources, partial.file, n.loc),
							line,
							targetPartialId: null,
							fills: [],
						});
						into.push(view.id);
						break;
					}
					case 'for': {
						const view = add({
							partialId: partial.id,
							kind: 'for',
							label: `b-for ${n.valName}`,
							rule: 'body repeated FOR_REPS times',
							source: sliceSource(input.sources, partial.file, n.loc),
							line,
							targetPartialId: null,
							fills: [],
						});
						into.push(view.id);
						walk(n.tnodes, view.children);
						break;
					}
					case 'if': {
						const view = add({
							partialId: partial.id,
							kind: 'if',
							label: `b-if · ${n.branches.length} branch${n.branches.length === 1 ? '' : 'es'}`,
							rule: 'every branch expanded, each marked conditional',
							source: null,
							line: null,
							targetPartialId: null,
							fills: [],
						});
						into.push(view.id);
						n.branches.forEach((branch, i) => {
							const name = i === 0 ? 'b-if' : (branch.condition ? 'b-else-if' : 'b-else');
							const branchView = add({
								partialId: partial.id,
								kind: 'branch',
								label: name,
								rule: 'conditional',
								source: sliceSource(input.sources, partial.file, branch.loc),
								line: branch.loc?.startLine ?? null,
								targetPartialId: null,
								fills: [],
							});
							view.children.push(branchView.id);
							walk(branch.tnodes, branchView.children);
						});
						break;
					}
					case 'print': {
						const view = add({
							partialId: partial.id,
							kind: 'print',
							label: '{{ … }}',
							rule: 'text: renders no element',
							source: sliceSource(input.sources, partial.file, n.loc),
							line,
							targetPartialId: null,
							fills: [],
						});
						into.push(view.id);
						break;
					}
					case 'raw': {
						if (!n.raw.trim()) break;
						const text = n.raw.replace(/\s+/g, ' ').trim();
						const view = add({
							partialId: partial.id,
							kind: 'text',
							label: text.length > 40 ? `${text.slice(0, 37)}…` : text,
							rule: 'text: renders no element',
							source: null,
							line: null,
							targetPartialId: null,
							fills: [],
						});
						into.push(view.id);
						break;
					}
					// comment / attr-bind: no element, no useful detail
				}
			}
		};

		walk(root.tnodes, partialView.children);
	}

	return { views, byTNode };
}

// --- Collection ---

export function collectExplain(input: ExplainInput): ExplainPayload {
	const timings: { label: string; ms: number }[] = [];
	const timed = <T>(label: string, fn: () => T): T => {
		const start = performance.now();
		const value = fn();
		timings.push({ label, ms: Math.round((performance.now() - start) * 10) / 10 });
		return value;
	};

	// Step 1 — parse CSS.
	// The explainer still analyses the concatenated stylesheets as one buffer;
	// its `line` fields are offsets into that join, not into any single file.
	const { rules } = timed('parse CSS', () => parseCssFile(input.cssContent));

	// Step 2 — expand the render forest.
	const forest = timed('expand forest', () => buildInstanceForest(input.compiled));

	// Step 3/4 — the analyzer's own aggregate, used verbatim for match types.
	const aggregate = timed('match + aggregate', () => matchSelectors(rules, forest));

	const partials = collectPartials(input, forest);
	const partialIdOf = new Map<RootTNode, number>();
	for (const partial of partials) {
		partialIdOf.set(input.compiled.get(partial.file)!.partials.get(partial.name)!, partial.id);
	}

	// The authoring tree: every TNode a partial is written from, containers
	// included, each labelled with the expansion rule that applies to it.
	const build = timed('read authoring trees', () => buildAuthoring(input, partials, partialIdOf));
	const authoring = build.views;
	const authoringIdOf = build.byTNode;

	// Instances, with their source node and their place in the tree.
	const instanceIdOf = new Map<InstanceNode, number>();
	forest.all.forEach((node, i) => instanceIdOf.set(node, i));

	// `all` is materialized depth-first per root, so a tree's instances are the
	// contiguous run of `size` starting at its first top.
	const trees = collectTrees(forest, partialIdOf);
	const treeIdOf = new Map<InstanceNode, number>();
	for (const tree of trees) {
		const first = tree.tops[0];
		for (let i = first; i < first + tree.size; i++) treeIdOf.set(forest.all[i], tree.id);
	}

	const instances: InstanceView[] = forest.all.map((node, i) => {
		const index = attrsOf(node);
		const classValue = index.values.get('class') ?? '';
		const attrs = [
			...[...index.values].map(([name, value]) => ({ name, value })),
			...[...index.dynamic].map(name => ({ name, value: null })),
		];
		const authoringId = authoringIdOf.get(node.tnode) ?? -1;
		if (authoringId >= 0) authoring[authoringId].instances.push(i);
		return {
			id: i,
			authoringId,
			tag: tagNameOf(node.tnode),
			classes: classValue.split(/\s+/).filter(Boolean),
			elementId: index.values.get('id') ?? null,
			attrs,
			file: node.file,
			partial: node.partialName,
			depth: node.depth,
			conditional: node.conditional,
			via: node.via,
			treeId: treeIdOf.get(node) ?? 0,
			parent: node.parent ? instanceIdOf.get(node.parent) ?? null : null,
			children: [],
			slots: Object.entries(node.env.slots).map(([name, entry]) => ({
				name,
				fills: entry.tnodes.length,
				from: `${entry.env.partialName} · ${entry.env.file}`,
			})),
			matched: [],
		};
	});
	for (const instance of instances) {
		if (instance.parent !== null) instances[instance.parent].children.push(instance.id);
	}

	// Step 3 in detail — every selector against every instance, with the real
	// matcher, plus the same run for each compound step of the selector.
	const selectors: SelectorView[] = [];
	const ruleViews: RuleView[] = [];
	const selectorIdByRuleAndText = new Map<string, number>();

	timed('per-instance trace', () => {
		rules.forEach((rule, ruleId) => {
			const selectorIds: number[] = [];
			for (const text of rule.selectors) {
				const id = selectors.length;
				const test = compileSelector(forest, text);
				const hits: number[] = [];
				if (test) {
					forest.all.forEach((node, i) => {
						if (test(node)) {
							hits.push(i);
							instances[i].matched.push(id);
						}
					});
				}
				const steps = selectorSteps(text).map(stepText => {
					const stepTest = stepText === text ? test : compileSelector(forest, stepText);
					return {
						text: stepText,
						hits: stepTest ? forest.all.reduce((n, node) => n + (stepTest(node) ? 1 : 0), 0) : 0,
					};
				});
				selectors.push({
					id, text, ruleId, valid: test !== null,
					specificity: specificityOf(text),
					steps, hits,
				});
				selectorIds.push(id);
				selectorIdByRuleAndText.set(`${ruleId} ${text}`, id);
			}
			ruleViews.push({
				id: ruleId,
				selectorText: rule.selectorText,
				selectorIds,
				properties: rule.properties,
				media: rule.mediaConditions,
				line: rule.sourceLine,
			});
		});
	});

	// Step 4 — fold the analyzer's aggregate back onto the source elements.
	const elements: ElementView[] = [];
	const ruleIdOf = new Map<CssRule, number>();
	rules.forEach((rule, i) => ruleIdOf.set(rule, i));

	for (const entries of aggregate.values()) {
		for (const entry of entries) {
			const authoringId = authoringIdOf.get(entry.element) ?? -1;
			const own = authoringId >= 0 ? authoring[authoringId].instances : [];
			elements.push({
				authoringId,
				file: entry.file,
				partial: entry.partialName,
				line: entry.startLine,
				label: isElementLike(entry.element) ? label(entry.element) : entry.file,
				instances: own,
				matches: entry.matches.map(match => {
					const ruleId = ruleIdOf.get(match.rule) ?? -1;
					const selectorId = selectorIdByRuleAndText.get(`${ruleId} ${match.selector}`) ?? -1;
					const hitIds = selectorId >= 0 ? selectors[selectorId].hits : [];
					const ownSet = new Set(own);
					const hitting = hitIds.filter(id => ownSet.has(id));
					return {
						selectorId,
						hits: hitting.length,
						total: own.length,
						conditionalHit: hitting.some(id => instances[id].conditional),
						matchType: match.matchType,
					};
				}),
			});
		}
	}

	return {
		meta: {
			project: input.project,
			cssFiles: input.cssFiles,
			generated: new Date().toISOString(),
			forReps: FOR_REPS,
			maxDepth: MAX_DEPTH,
			maxInstances: MAX_INSTANCES,
			truncated: forest.truncated,
			assetDirs: input.assetDirs ?? [],
			configDir: input.configDir,
			warnings: input.warnings ?? [],
			counts: {
				files: input.compiled.size,
				partials: partials.length,
				rules: rules.length,
				selectors: selectors.length,
				instances: instances.length,
				matchedElements: elements.length,
			},
			timings,
		},
		rules: ruleViews,
		selectors,
		partials,
		authoring,
		trees,
		instances,
		elements,
	};
}

/**
 * Split the forest's tops into the trees they grew as.
 *
 * `expandRoot` hands every top of one root the same `_roots` array, so array
 * identity is the reliable grouping — a root that renders no element (a
 * text-only partial) contributes no group at all.
 *
 * That is also why the root's *name* is not always recoverable. Each root
 * yields exactly zero or one group, so when the counts are equal every root
 * yielded one and the i-th group is the i-th root's — sound. When they differ,
 * some root rendered nothing and there is no way to tell which, so the trees
 * are reported unattributed rather than mislabelled.
 */
function collectTrees(forest: InstanceForest, partialIdOf: Map<RootTNode, number>): TreeView[] {
	const groups: InstanceNode[][] = [];
	let previous: unknown;
	forest.tops.forEach((top, i) => {
		if (i === 0 || top._roots !== previous) groups.push([]);
		previous = top._roots;
		groups[groups.length - 1].push(top);
	});

	const attributable = groups.length === forest.roots.length;
	const indexOfTop = new Map<InstanceNode, number>();
	forest.all.forEach((node, i) => { if (node.parent === null) indexOfTop.set(node, i); });

	return groups.map((tops, id) => {
		const selection = attributable ? forest.roots[id] : null;
		const first = indexOfTop.get(tops[0])!;
		const nextTree = groups[id + 1];
		const end = nextTree ? indexOfTop.get(nextTree[0])! : forest.all.length;
		return {
			id,
			rootPartialId: selection ? partialIdOf.get(selection.root) ?? null : null,
			reason: selection ? selection.reason : null,
			tops: tops.map(top => indexOfTop.get(top)!),
			size: end - first,
		};
	});
}

function collectPartials(input: ExplainInput, forest: InstanceForest): PartialView[] {
	const partials: PartialView[] = [];
	const idOf = new Map<RootTNode, number>();

	for (const [file, compiled] of input.compiled) {
		for (const [name, root] of compiled.partials) {
			idOf.set(root, partials.length);
			partials.push({
				id: partials.length,
				file,
				name,
				kind: root.kind,
				calledFrom: [],
				rootReason: null,
				instanceCount: 0,
				authoringId: null,
			});
		}
	}

	// Call sites, attributed to the partial they are written in.
	for (const [file, compiled] of input.compiled) {
		for (const [partialName, root] of compiled.partials) {
			visitTNodes(root.tnodes, (n) => {
				if (n.type !== 'partial-ref') return;
				const target = resolvePartial(n, compiled, input.compiled);
				if (!target) return;
				const id = idOf.get(target);
				if (id === undefined) return;
				partials[id].calledFrom.push({
					file,
					partial: partialName,
					line: n.loc?.startLine,
					label: n.kind === 'custom-element'
						? `<${n.callerTagName ?? n.partialName}>`
						: `b-part="${n.file ? `${n.file}#` : '#'}${n.partialName}"`,
				});
			});
		}
	}

	for (const selection of forest.roots) {
		const id = idOf.get(selection.root);
		if (id !== undefined) partials[id].rootReason = selection.reason;
	}

	const byFileAndName = new Map<string, PartialView>();
	for (const partial of partials) byFileAndName.set(`${partial.file}\u0000${partial.name}`, partial);
	for (const node of forest.all) {
		const partial = byFileAndName.get(`${node.file}\u0000${node.partialName}`);
		if (partial) partial.instanceCount++;
	}

	return partials;
}
