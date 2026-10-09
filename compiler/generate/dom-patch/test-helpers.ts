// Helpers for tests that inspect what a generated dom-patch module hands the runtime.
import { classNameFor } from './codegen.js';

/**
 * Evaluate a generated module (whole, or the body `generateClassForPartial` returns)
 * with stand-in runtime base classes, and return what the runtime would be handed:
 * the shell's statics and every name the module defines. Imports and the define line
 * are dropped; there is no runtime or registry here. Each `bfstore_NAME` a shell
 * names is bound to `{ storeFile: NAME }`.
 */
export function evalModule(js: string, partialName: string) {
	class BackflipShell {}
	class BackflipElement {}
	const src = js
		.replace(/^import .*$/gm, '')
		.replaceAll('export class', 'class')
		.replace(/^if \(!customElements.*$/m, '');
	const names = [...src.matchAll(/^(?:const|class) (\w+)/gm)].map(m => m[1]);
	const storeNames = [...new Set([...src.matchAll(/\bbfstore_(\w+)/g)].map(m => m[1]))];
	// deno-lint-ignore no-explicit-any
	const defined: Record<string, any> = new Function('BackflipShell', 'BackflipElement', ...storeNames.map(n => `bfstore_${n}`),
		`${src}\nreturn { ${names.join(', ')} };`)(BackflipShell, BackflipElement, ...storeNames.map(n => ({ storeFile: n })));
	const shell = defined[classNameFor(partialName)];
	return { shell, bfAttrs: shell.bfAttrs, bfStores: shell.bfStores, bfRoot: shell.bfRoot, defined, BackflipShell, BackflipElement };
}

/**
 * A descriptor with every expression replaced by its vars and the value it returns
 * for `sample`, so descriptors compare with assertEquals. Snapshots are left as-is
 * (compare them by identity).
 */
// deno-lint-ignore no-explicit-any
export function plain(desc: any, sample: Record<string, unknown> = {}): any {
	if (Array.isArray(desc)) return desc.map(d => plain(d, sample));
	if (desc === null || typeof desc !== 'object') return desc;
	if (typeof desc.fn === 'function' && Array.isArray(desc.vars)) {
		return { vars: desc.vars, value: desc.fn(...desc.vars.map((v: string) => sample[v])) };
	}
	// deno-lint-ignore no-explicit-any
	const out: any = {};
	for (const [k, v] of Object.entries(desc)) out[k] = k === 'snapshot' ? v : plain(v, sample);
	return out;
}
