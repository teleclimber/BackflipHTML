export type BfidGen = () => string;

// Text placed inside a marker comment that brackets a patchable child range
// (e.g. a `{{ print }}`). The `bfid:` prefix distinguishes machine-generated
// markers from author-written comments. The browser routine matches on the
// resulting `Comment.nodeValue` (e.g. `bfid:bf3`).
export function commentMarker(id: string): string {
	return 'bfid:' + id;
}

export interface BfidOptions {
	prefix?: string;
}

const DEFAULT_PREFIX = 'bf';
const RANDOM_BYTES = 5;

export function makeBfidGen(opts?: BfidOptions): BfidGen {
	const prefix = opts?.prefix ?? DEFAULT_PREFIX;
	return () => prefix + randomSuffix();
}

export function makeSequentialBfidGen(prefix: string = DEFAULT_PREFIX): BfidGen {
	let i = 0;
	return () => prefix + (i++);
}

function randomSuffix(): string {
	const bytes = new Uint8Array(RANDOM_BYTES);
	crypto.getRandomValues(bytes);
	let n = 0n;
	for (const b of bytes) n = (n << 8n) | BigInt(b);
	return n.toString(36);
}
