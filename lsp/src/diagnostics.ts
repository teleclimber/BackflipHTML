import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import type { BackflipError } from '@backflip/html';
import type { AnalysisFailure } from '@backflip/css';

export function errorsToDiagnostics(errors: BackflipError[]): Map<string, Diagnostic[]> {
	const byFile = new Map<string, Diagnostic[]>();

	for (const err of errors) {
		const file = err.filename ?? '';
		const line = (err.line ?? 1) - 1; // LSP is 0-based
		const col = (err.col ?? 1) - 1;
		const endLine = err.endLine != null ? err.endLine - 1 : line;
		const endCol = err.endCol != null ? err.endCol - 1 : col + 1;

		const diag: Diagnostic = {
			severity: err.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
			range: {
				start: { line, character: col },
				end: { line: endLine, character: endCol },
			},
			message: err.message,
			source: 'backflip',
		};

		const existing = byFile.get(file);
		if (existing) {
			existing.push(diag);
		} else {
			byFile.set(file, [diag]);
		}
	}

	return byFile;
}

/**
 * Turn CSS analysis failures into diagnostics, keyed by absolute stylesheet path.
 *
 * These are warnings, not errors: the CSS itself still ships and still works in
 * a browser. What is degraded is Backflip's view of it, so the message leads
 * with the cause and then says what was lost — a bare "Identifier is expected"
 * tells an author nothing about why their selectors stopped matching.
 *
 * The range covers what stopped being analyzed, so the underline shows it: the
 * whole discarded region for a parse failure, and the one selector for a
 * selector the matcher cannot read. Overlapping parse regions are already merged
 * in `parseCssFile`, so two reports never underline the same text twice.
 */
export function cssFailuresToDiagnostics(failures: AnalysisFailure[]): Map<string, Diagnostic[]> {
	const byFile = new Map<string, Diagnostic[]>();

	for (const failure of failures) {
		// LSP is 0-based; css-tree is 1-based on both axes.
		const startLine = failure.lostStartLine - 1;
		const startCol = failure.lostStartCol - 1;
		let endLine = failure.lostEndLine - 1;
		let endCol = failure.lostEndCol - 1;

		// A zero-width range renders as no underline at all. Only reachable if
		// css-tree hands back an empty region, but the cost of guarding is one
		// comparison and the cost of not guarding is an invisible warning.
		if (endLine < startLine || (endLine === startLine && endCol <= startCol)) {
			endLine = startLine;
			endCol = startCol + 1;
		}

		// A selector is not a region, so it gets no line count — the underline is
		// already the whole of what was lost, and only its own rule is affected.
		const lostLines = failure.lostEndLine - failure.lostStartLine + 1;
		const extent = lostLines === 1 ? '1 line' : `${lostLines} lines`;
		const message = failure.reason === 'selector-parse'
			? `${failure.message}, so this rule will not report matches.`
			: `${failure.message}. Backflip skipped this CSS (${extent}), so rules in it will not report matches.`;

		const diag: Diagnostic = {
			severity: DiagnosticSeverity.Warning,
			range: {
				start: { line: startLine, character: startCol },
				end: { line: endLine, character: endCol },
			},
			message,
			source: 'backflip',
		};

		const existing = byFile.get(failure.sourceFile);
		if (existing) {
			existing.push(diag);
		} else {
			byFile.set(failure.sourceFile, [diag]);
		}
	}

	return byFile;
}
