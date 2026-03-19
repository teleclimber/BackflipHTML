export class BackflipError extends Error {
	filename?: string;
	line?: number;
	col?: number;

	constructor(message: string, loc?: { filename?: string, line?: number, col?: number }) {
		const prefix = loc ? BackflipError.formatLoc(loc) : '';
		super(prefix + message);
		this.filename = loc?.filename;
		this.line = loc?.line;
		this.col = loc?.col;
	}

	static formatLoc(loc: { filename?: string, line?: number, col?: number }): string {
		const parts: string[] = [];
		if (loc.filename) parts.push(loc.filename);
		if (loc.line != null) parts.push(`${loc.line}:${loc.col ?? 1}`);
		return parts.length > 0 ? parts.join(':') + ': ' : '';
	}
}
