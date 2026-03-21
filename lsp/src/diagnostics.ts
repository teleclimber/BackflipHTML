import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import type { BackflipError } from '@backflip/html';

export function errorsToDiagnostics(errors: BackflipError[]): Map<string, Diagnostic[]> {
	const byFile = new Map<string, Diagnostic[]>();

	for (const err of errors) {
		const file = err.filename ?? '';
		const line = (err.line ?? 1) - 1; // LSP is 0-based
		const col = (err.col ?? 1) - 1;

		const diag: Diagnostic = {
			severity: DiagnosticSeverity.Error,
			range: {
				start: { line, character: col },
				end: { line, character: col },
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
