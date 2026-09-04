import type { ExplainPayload } from './collect.js';

/**
 * The same results the page shows, as text for a terminal.
 *
 * The page is for exploring; this is for the common case of running the tool
 * and just wanting to read what came out.
 */

const MAX_ELEMENTS = 40;
const MAX_DIAGNOSTICS = 20;

function pad(text: string, width: number): string {
	return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function widest(values: string[]): number {
	return values.reduce((max, value) => Math.max(max, value.length), 0);
}

export function summarize(payload: ExplainPayload): string {
	const { meta, partials, elements, selectors } = payload;
	const lines: string[] = [];
	const c = meta.counts;

	lines.push(`${meta.project} · ${meta.cssFiles.join(', ') || 'inline CSS'}`);
	// Named up front: a run whose asset dirs are missing reports one diagnostic
	// per asset attribute, and this is the line that explains the pile.
	lines.push(`  assets: ${meta.assetDirs.length > 0
		? meta.assetDirs.map(name => `@${name}`).join(' ')
		: meta.configDir !== undefined
			? `none in ${meta.configDir}/backflip.json — src~ will not compile`
			: 'no backflip.json found — src~ will not compile'}`);
	lines.push(
		`  ${c.files} files · ${c.partials} partials · ${c.rules} rules · ` +
		`${c.instances} instances · ${c.matchedElements} matched elements`
	);
	if (meta.truncated) {
		lines.push(`  ! the ${meta.maxInstances} instance budget ran out — results below are incomplete`);
	}
	if (meta.warnings.length > 0) {
		lines.push('', `COMPILE DIAGNOSTICS (${meta.warnings.length})`);
		for (const warning of meta.warnings.slice(0, MAX_DIAGNOSTICS)) lines.push(`  ${warning}`);
		if (meta.warnings.length > MAX_DIAGNOSTICS) {
			lines.push(`  … and ${meta.warnings.length - MAX_DIAGNOSTICS} more (see the page)`);
		}
	}

	// Roots: why each partial was or was not an expansion entry point. The ones
	// expansion started from lead, because that is the order it happened in.
	lines.push('', 'ROOTS');
	const rank = { entry: 0, unreached: 1 } as const;
	const ordered = [...partials].sort((a, b) =>
		(a.rootReason ? rank[a.rootReason] : 2) - (b.rootReason ? rank[b.rootReason] : 2));
	const nameWidth = widest(partials.map(p => p.name));
	for (const partial of ordered) {
		const role = partial.rootReason === 'entry'
			? 'entry point — nothing calls it'
			: partial.rootReason === 'unreached'
				? 'grown standalone — only reachable through a cycle'
				: `reached from ${partial.calledFrom.length} call site${partial.calledFrom.length === 1 ? '' : 's'}`;
		lines.push(
			`  ${pad(partial.name, nameWidth)}  ${pad(String(partial.instanceCount) + '×', 5)}  ${role}`
		);
	}

	// Matches, one block per source element.
	lines.push('', 'MATCHES');
	if (elements.length === 0) {
		lines.push('  nothing matched');
	}
	const shown = elements.slice(0, MAX_ELEMENTS);
	const labelWidth = widest(shown.map(e => e.label));
	const originWidth = widest(shown.map(e => `${e.file} ${e.partial}:${e.line}`));
	const selectorWidth = widest(
		shown.flatMap(e => e.matches.map(m => selectors[m.selectorId]?.text ?? '?'))
	);
	for (const element of shown) {
		const origin = `${element.file} ${element.partial}:${element.line}`;
		element.matches.forEach((match, i) => {
			const head = i === 0
				? `  ${pad(element.label, labelWidth)}  ${pad(origin, originWidth)}  `
				: `  ${pad('', labelWidth)}  ${pad('', originWidth)}  `;
			const text = selectors[match.selectorId]?.text ?? '?';
			lines.push(
				`${head}${pad(text, selectorWidth)}  ${pad(match.matchType, 11)} ${match.hits}/${match.total}`
			);
		});
	}
	if (elements.length > shown.length) {
		lines.push(`  … and ${elements.length - shown.length} more elements (see the page)`);
	}

	const unmatched = selectors.filter(s => s.hits.length === 0);
	if (unmatched.length > 0) {
		lines.push('', `UNMATCHED SELECTORS (${unmatched.length})`);
		for (const selector of unmatched) {
			lines.push(`  ${selector.text}${selector.valid ? '' : '   (could not be parsed)'}`);
		}
	}

	return lines.join('\n');
}
