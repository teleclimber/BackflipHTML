import { buildPartialGraph, callsIn, partialKey } from '../compiler/partial-graph.js';
import type { PartialBodyItem, PartialCall, PartialGraph, PartialGraphNode } from '../compiler/partial-graph.js';
import type { CompiledFile } from '../compiler/types.js';
import { escapeHtml } from '../lib/html-escape.js';

/**
 * The usage tree: how one partial relates to the others.
 *
 * Three views of the same graph, all drawn as trees of partials — elements,
 * `b-if` and `b-for` do not appear, only what calls what and what fills which
 * slot. Every occurrence is expanded: a partial called from five places is
 * drawn five times, because each of those positions is a different context.
 */
export type UsageView = 'trees' | 'callers' | 'callees';

export const USAGE_VIEWS: UsageView[] = ['trees', 'callers', 'callees'];

const VIEW_LABELS: Record<UsageView, string> = {
	trees: 'Whole trees',
	callers: 'Callers',
	callees: 'Callees',
};

/** Rows drawn before expansion gives up. A cycle stops on its own; breadth does not. */
const MAX_ROWS = 4000;

export function usageHref(file: string, name: string, view?: UsageView): string {
	const base = `/__usage/${encodeURIComponent(file)}/${encodeURIComponent(name)}`;
	return view ? `${base}?view=${view}` : base;
}

export function previewHref(file: string, name: string): string {
	return `/preview/${encodeURIComponent(file)}/${encodeURIComponent(name)}`;
}

/** Read a `view` query value, falling back to the default view. */
export function parseUsageView(raw: string | null | undefined): UsageView {
	return USAGE_VIEWS.includes(raw as UsageView) ? raw as UsageView : 'trees';
}

/**
 * What slot declarations resolve against while a partial's body is drawn.
 *
 * A fill is written in the caller, so it carries the caller's own environment
 * with it: a `b-slot` inside a fill forwards to the slot the *caller* was
 * given. That is the same chain `runtime/js/render.ts` walks.
 */
interface Env {
	fills: Map<string, { items: PartialBodyItem[]; hasContent: boolean; env: Env | null }>;
}

interface DrawCtx {
	graph: PartialGraph;
	/** The compiled files, to tell a real file the call names from a placeholder. */
	files: Map<string, CompiledFile>;
	/** The partial the page is about; marked wherever it is drawn. */
	selfKey: string;
	rows: number;
	truncated: boolean;
}

function budgetOk(ctx: DrawCtx): boolean {
	if (ctx.rows >= MAX_ROWS) {
		ctx.truncated = true;
		return false;
	}
	ctx.rows++;
	return true;
}

/** The name, file, badges and links shown for one partial. */
function partialRow(node: PartialGraphNode, ctx: DrawCtx, showFile: boolean, extra = ''): string {
	const refs = node.callers.length;
	const parts = [
		`<a class="pname" href="${escapeHtml(usageHref(node.file, node.name))}">${escapeHtml(node.name)}</a>`,
	];
	if (showFile) parts.push(`<span class="pfile">${escapeHtml(node.file)}</span>`);
	parts.push(`<span class="refs${refs === 0 ? ' none' : ''}">${refs} ref${refs === 1 ? '' : 's'}</span>`);
	if (node.key === ctx.selfKey) parts.push('<span class="self">this partial</span>');
	if (extra) parts.push(extra);
	parts.push(`<a class="prev" href="${escapeHtml(previewHref(node.file, node.name))}">preview</a>`);
	return parts.join(' ');
}

/**
 * A call to a partial with no definition: the name as written, and why it stops.
 *
 * An unresolved custom element carries a placeholder in place of a file, so the
 * file is named only when it is one the project has.
 */
function unresolvedRow(call: PartialCall, ctx: DrawCtx): string {
	const where = call.targetFile && ctx.files.has(call.targetFile)
		? `${call.targetFile}#${call.partialName}`
		: call.partialName;
	return `<span class="pname missing">${escapeHtml(call.partialName)}</span>`
		+ ` <span class="note">unresolved — nothing defines ${escapeHtml(where)}</span>`;
}

function slotRow(name: string, body: string): string {
	return `<li class="slot"><span class="sname">slot "${escapeHtml(name)}"</span>${body}</li>`;
}

/** Wrap drawn rows in a list, or nothing when there are none. */
function list(rows: string[]): string {
	return rows.length > 0 ? `<ul>${rows.join('')}</ul>` : '';
}

/**
 * One partial's body: its slot declarations filled from `env`, and its calls
 * expanded into the partials they name.
 *
 * `stack` is the chain of partials being expanded, so a call that re-enters one
 * stops there — the graph has cycles, the drawing must not.
 */
function drawItems(items: PartialBodyItem[], env: Env | null, parentFile: string, stack: string[], ctx: DrawCtx): string[] {
	const rows: string[] = [];
	for (const item of items) {
		if (!budgetOk(ctx)) break;
		if (item.kind === 'slot') {
			const fill = env?.fills.get(item.name);
			if (!fill || !fill.hasContent) {
				rows.push(slotRow(item.name, ' <span class="note">unfilled</span>'));
			} else if (fill.items.length === 0) {
				// Content, but no partial in it: markup the caller wrote inline.
				rows.push(slotRow(item.name, ' <span class="note">filled with markup</span>'));
			} else {
				rows.push(slotRow(item.name, list(drawItems(fill.items, fill.env, parentFile, stack, ctx))));
			}
			continue;
		}
		rows.push(drawCall(item, env, parentFile, stack, ctx));
	}
	return rows;
}

/** One call: the partial it names, then that partial's body under this call's fills. */
function drawCall(call: PartialCall, env: Env | null, parentFile: string, stack: string[], ctx: DrawCtx): string {
	const target = call.target !== null ? ctx.graph.nodes.get(call.target) : undefined;
	if (!target) return `<li class="call">${unresolvedRow(call, ctx)}</li>`;

	const cls = target.key === ctx.selfKey ? 'call is-self' : 'call';
	if (stack.includes(target.key)) {
		const row = partialRow(target, ctx, target.file !== parentFile, '<span class="cycle">cycle — expanded above</span>');
		return `<li class="${cls}">${row}</li>`;
	}

	// The callee's slots resolve against this call's fills; the fills themselves
	// were written here, so they keep the environment in effect at this level.
	const calleeEnv: Env = { fills: new Map() };
	for (const [slotName, fill] of call.fills) {
		calleeEnv.fills.set(slotName, { ...fill, env });
	}

	const inner = [...stack, target.key];
	const rows = drawItems(target.body, calleeEnv, target.file, inner, ctx);
	// A fill naming a slot the callee does not declare renders nowhere, so it is
	// drawn apart from the body rather than silently dropped.
	for (const [name, fill] of call.fills) {
		if (target.slots.includes(name) || !fill.hasContent) continue;
		rows.push(slotRow(name, ` <span class="note">no matching b-slot in ${escapeHtml(target.name)}</span>`
			+ list(drawItems(fill.items, env, target.file, inner, ctx))));
	}

	return `<li class="${cls}">${partialRow(target, ctx, target.file !== parentFile)}${list(rows)}</li>`;
}

/** A partial drawn as the root of its own tree: no incoming call, so no fills. */
function drawRoot(node: PartialGraphNode, ctx: DrawCtx, badge = ''): string {
	const rows = drawItems(node.body, null, node.file, [node.key], ctx);
	const cls = node.key === ctx.selfKey ? 'call is-self' : 'call';
	return `<ul class="tree"><li class="${cls}">${partialRow(node, ctx, true, badge)}${list(rows)}</li></ul>`;
}

// --- callers ---

/** Who calls this partial, recursively, up to the partials nothing calls. */
function drawCallers(node: PartialGraphNode, stack: string[], ctx: DrawCtx): string[] {
	const rows: string[] = [];
	for (const call of node.callers) {
		if (!budgetOk(ctx)) break;
		const callerKey = partialKey(call.file, call.fromPartial);
		const caller = ctx.graph.nodes.get(callerKey);
		if (!caller) continue;
		const filled = [...call.fills].filter(([, fill]) => fill.hasContent).map(([name]) => name);
		const fills = filled.length > 0
			? `<span class="note">fills ${filled.map(escapeHtml).join(', ')}</span>`
			: '';
		if (stack.includes(callerKey)) {
			rows.push(`<li class="call">${partialRow(caller, ctx, true, `<span class="cycle">cycle — expanded above</span> ${fills}`)}</li>`);
			continue;
		}
		const badge = caller.isEntry ? '<span class="badge">entry</span>' : '';
		const inner = drawCallers(caller, [...stack, callerKey], ctx);
		rows.push(`<li class="call">${partialRow(caller, ctx, true, `${badge} ${fills}`.trim())}${list(inner)}</li>`);
	}
	return rows;
}

// --- whole trees ---

/** Does the tree grown from `rootKey` reach `target`? */
function treeReaches(graph: PartialGraph, rootKey: string, target: string): boolean {
	const seen = new Set<string>();
	const walk = (key: string): boolean => {
		if (key === target) return true;
		if (seen.has(key)) return false;
		seen.add(key);
		const node = graph.nodes.get(key);
		if (!node) return false;
		for (const call of callsIn(node.body)) {
			if (call.target && walk(call.target)) return true;
		}
		return false;
	};
	return walk(rootKey);
}

interface RootChoice {
	node: PartialGraphNode;
	reason: 'entry' | 'unreached';
}

/**
 * The roots of every tree in the project, entry points first.
 *
 * A cycle nothing enters has no entry point, so one of its partials is grown
 * instead. Taking the first and passing over the rest keeps a cycle to one
 * tree rather than one rotation per member.
 */
function projectRoots(graph: PartialGraph): RootChoice[] {
	const roots: RootChoice[] = [];
	for (const key of graph.entries) {
		const node = graph.nodes.get(key);
		if (node) roots.push({ node, reason: 'entry' });
	}
	const covered = new Set<string>();
	for (const key of graph.unreached) {
		if (covered.has(key)) continue;
		const node = graph.nodes.get(key);
		if (!node) continue;
		roots.push({ node, reason: 'unreached' });
		cover(graph, key, covered);
	}
	return roots;
}

/** Mark every partial the tree grown from `key` would draw. */
function cover(graph: PartialGraph, key: string, covered: Set<string>): void {
	if (covered.has(key)) return;
	covered.add(key);
	const node = graph.nodes.get(key);
	if (!node) return;
	for (const call of callsIn(node.body)) {
		if (call.target) cover(graph, call.target, covered);
	}
}

// --- page ---

const STYLES = `
body { font-family: system-ui, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; color: #333; }
h1 { font-size: 1.4em; margin-bottom: 4px; }
h1 code { font-size: 1em; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
.sub { color: #656d76; font-size: 0.9em; margin: 0 0 16px; }
.views { display: flex; gap: 6px; margin: 0 0 20px; }
.views a { border: 1px solid #d0d7de; border-radius: 6px; padding: 4px 10px; font-size: 0.9em; color: #24292f; }
.views a:hover { background: #f6f8fa; text-decoration: none; }
.views a.on { background: #0969da; border-color: #0969da; color: #fff; }
.treehead { font-size: 0.85em; color: #656d76; margin: 22px 0 4px; border-top: 1px solid #eaeef2; padding-top: 10px; }
.treehead:first-of-type { border-top: none; }
ul { list-style: none; padding-left: 0; margin: 0; }
ul ul { padding-left: 14px; border-left: 1px solid #eaeef2; margin-left: 6px; }
li { margin: 3px 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.7; }
.pname { font-weight: 600; }
.pname.missing { color: #cf222e; font-weight: 600; }
.pfile { color: #8c959f; }
.refs { color: #656d76; font-size: 0.85em; }
.refs.none { color: #adb3ba; }
.prev { color: #8c959f; font-size: 0.85em; }
.note { color: #8c959f; font-size: 0.85em; }
.cycle { color: #9a6700; font-size: 0.85em; }
.badge { background: #ddf4ff; color: #0550ae; border-radius: 10px; padding: 0 7px; font-size: 0.8em; }
.self { background: #fff8c5; color: #7d4e00; border-radius: 10px; padding: 0 7px; font-size: 0.8em; }
li.is-self > .pname { background: #fff8c5; }
.slot > .sname { color: #6639ba; }
.empty { color: #656d76; font-style: italic; }
.warn { color: #9a6700; font-size: 0.9em; }
`;

function viewLinks(file: string, name: string, view: UsageView): string {
	return USAGE_VIEWS.map(v =>
		`<a class="${v === view ? 'on' : ''}" href="${escapeHtml(usageHref(file, name, v))}">${VIEW_LABELS[v]}</a>`
	).join('');
}

export interface UsageTreeOptions {
	view?: UsageView;
	liveReload?: boolean;
}

/**
 * The usage tree page for one partial.
 *
 * `trees` draws every project tree that reaches the partial, from its root;
 * `callers` walks up to the partials nothing calls; `callees` draws what the
 * partial itself pulls in.
 */
export function renderUsageTree(
	files: Map<string, CompiledFile>,
	file: string,
	name: string,
	opts: UsageTreeOptions = {},
): string {
	const view = opts.view ?? 'trees';
	const graph = buildPartialGraph(files);
	const selfKey = partialKey(file, name);
	const node = graph.nodes.get(selfKey);
	const ctx: DrawCtx = { graph, files, selfKey, rows: 0, truncated: false };

	let summary = '';
	let body = '';

	if (!node) {
		summary = `No partial <code>${escapeHtml(name)}</code> in ${escapeHtml(file)}.`;
	} else if (view === 'callees') {
		const calls = callsIn(node.body).length;
		summary = calls === 0
			? 'Calls no other partial.'
			: `Calls ${calls} partial${calls === 1 ? '' : 's'}, counting every call site.`;
		body = drawRoot(node, ctx);
	} else if (view === 'callers') {
		summary = node.callers.length === 0
			? 'Nothing calls this partial — it is an entry point.'
			: `Called from ${node.callers.length} call site${node.callers.length === 1 ? '' : 's'}.`;
		const callers = drawCallers(node, [selfKey], ctx);
		body = `<ul class="tree"><li class="call is-self">${partialRow(node, ctx, true)}${list(callers)}</li></ul>`;
	} else {
		const roots = projectRoots(graph);
		const containing = roots.filter(r => treeReaches(graph, r.node.key, selfKey));
		summary = `${containing.length} of ${roots.length} tree${roots.length === 1 ? '' : 's'} in this project reach${containing.length === 1 ? 'es' : ''} it.`;
		body = containing.map((root, i) => {
			const why = root.reason === 'entry' ? 'entry point — nothing calls it' : 'only reachable through a cycle';
			const head = `<p class="treehead">tree ${i + 1} of ${containing.length} · ${escapeHtml(why)}</p>`;
			return head + drawRoot(root.node, ctx);
		}).join('');
		if (containing.length === 0) body = '<p class="empty">No tree reaches this partial.</p>';
	}

	const truncated = ctx.truncated
		? `<p class="warn">Stopped after ${MAX_ROWS} rows — this tree is larger than the page draws.</p>`
		: '';

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Usage · ${escapeHtml(name)}</title>
<style>${STYLES}</style>
</head>
<body>
<h1>Usage · <code>${escapeHtml(name)}</code></h1>
<p class="sub"><a href="/">all partials</a> · ${escapeHtml(file)} · ${summary}</p>
<div class="views">${viewLinks(file, name, view)}</div>
${body}
${truncated}
${opts.liveReload ? '<script>(function(){var es=new EventSource("/__events");es.addEventListener("reload",function(){location.reload()})})();</script>' : ''}
</body>
</html>`;
}
