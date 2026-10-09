import * as path from "node:path";
import * as fs from "node:fs/promises";

/**
 * Link `entry` and every file it reaches through its imports into one classic script:
 * each file becomes a block returning its exports, after the files it imports.
 * Relative specifiers resolve against the importing file; an absolute URL resolves
 * through `urlRoots` (URL prefix → directory), the way a server would serve it.
 */
export async function linkAsScript(entry: string, urlRoots: Record<string, string> = {}): Promise<string> {
	const order: string[] = [];
	const sources = new Map<string, string>();
	const importRe = /^import (?:\{([^}]*)\}|(\w+)) from ['"]([^'"]+)['"];$/gm;
	const resolve = (from: string, spec: string): string => {
		if (spec.startsWith(".")) return path.resolve(path.dirname(from), spec);
		const prefix = Object.keys(urlRoots).find(p => spec.startsWith(p));
		if (!prefix) throw new Error(`linkAsScript: no root for ${spec} (imported by ${from})`);
		return path.join(urlRoots[prefix], spec.slice(prefix.length));
	};
	async function visit(file: string): Promise<void> {
		if (sources.has(file)) return;
		const src = await fs.readFile(file, "utf-8");
		sources.set(file, src);
		for (const [, , , spec] of src.matchAll(importRe)) await visit(resolve(file, spec));
		order.push(file);
	}
	await visit(entry);
	const moduleVar = (file: string) => `__module${order.indexOf(file)}`;
	return order.map(file => {
		const src = sources.get(file)!
			.replace(importRe, (_, names, def, spec) => names !== undefined
				? `const {${names}} = ${moduleVar(resolve(file, spec))};`
				: `const ${def} = ${moduleVar(resolve(file, spec))}.default;`)
			.replace(/^export default /m, "const __default = ");
		const exported = [...src.matchAll(/^export (?:function\*?|class|const|let) (\w+)/gm)].map(m => m[1]);
		if (/^const __default = /m.test(src)) exported.push("default: __default");
		return `const ${moduleVar(file)} = (() => {\n${src.replace(/^export /gm, "")}\nreturn { ${exported.join(", ")} };\n})();`;
	}).join("\n");
}
