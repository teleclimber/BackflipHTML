import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as acorn from 'acorn';
import { BackflipError } from './errors.js';
import { collectFiles } from './files.js';
import type { SourceLoc } from './types.js';

/** A store, as declared by its store file. */
export interface StoreDecl {
	name: string;
	file: string;        // absolute path of the store file
	src?: string;        // "@asset/subpath" of the file when an asset dir serves it
	nameLoc: SourceLoc;  // the constructor's string argument
}

/** Every declared store, by name. */
export type StoreTable = Map<string, StoreDecl>;

/** Members of `BackflipStore` that a store file may not redeclare. */
export const STORE_BASE_MEMBERS = new Set(['data']);

const BASE_CLASS = 'BackflipStore';

/** Read every `*.js` file under the store dirs: absolute path → source. */
export async function readStoreFiles(storeDirs: string[]): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	for (const dir of storeDirs) {
		for (const rel of await collectFiles(dir, '.js')) {
			const abs = path.join(dir, rel);
			files.set(abs, await fs.readFile(abs, 'utf-8'));
		}
	}
	return files;
}

/**
 * Build the store table from store file sources (absolute path → source). A store
 * file inside an asset dir is served, so its store gets a `src`. Two files
 * declaring the same name are an error on both, and neither enters the table.
 */
export function buildStoreTable(files: Map<string, string>, assetDirs?: Map<string, string>): { stores: StoreTable, errors: BackflipError[] } {
	const errors: BackflipError[] = [];
	const byName = new Map<string, StoreDecl[]>();
	for (const [file, source] of files) {
		const read = readStoreFile(source, file);
		errors.push(...read.errors);
		if (!read.decl) continue;
		const src = servedSrc(file, assetDirs);
		const decl: StoreDecl = src ? { ...read.decl, src } : read.decl;
		byName.set(decl.name, [...byName.get(decl.name) ?? [], decl]);
	}
	const stores: StoreTable = new Map();
	for (const [name, decls] of byName) {
		if (decls.length === 1) {
			stores.set(name, decls[0]);
			continue;
		}
		for (const d of decls) {
			const others = decls.filter(o => o !== d).map(o => o.file).join(', ');
			errors.push(new BackflipError(`store "${name}" is also declared in ${others}`, errLoc(d.file, d.nameLoc)));
		}
	}
	return { stores, errors };
}

// "@name/subpath" of `file` under the most specific asset dir that contains it.
function servedSrc(file: string, assetDirs?: Map<string, string>): string | undefined {
	let best: { name: string; dir: string } | undefined;
	for (const [name, dir] of assetDirs ?? []) {
		if (file.startsWith(dir + path.sep) && (!best || dir.length > best.dir.length)) best = { name, dir };
	}
	if (!best) return undefined;
	return `@${best.name}/${path.relative(best.dir, file).split(path.sep).join('/')}`;
}

/**
 * Read one store file without executing it. Its default export must be
 * `new BackflipStore('NAME')`, or `new C('NAME')` with `C` a class declared in the
 * file that extends `BackflipStore`. `decl` is set when the file declares a store
 * (its `src` is left to the caller).
 */
export function readStoreFile(source: string, file: string): { decl?: StoreDecl, errors: BackflipError[] } {
	const errors: BackflipError[] = [];
	const fail = (message: string, node?: acorn.Node) => {
		errors.push(new BackflipError(message, errLoc(file, node ? nodeLoc(node) : undefined)));
		return { errors };
	};

	let program: acorn.Program;
	try {
		program = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
	} catch (e) {
		const pos = (e as { loc?: { line: number; column: number } }).loc;
		const msg = e instanceof Error ? e.message.replace(/ \(\d+:\d+\)$/, '') : String(e);
		errors.push(new BackflipError(`store file does not parse: ${msg}`,
			{ filename: file, line: pos?.line ?? 1, col: (pos?.column ?? 0) + 1 }));
		return { errors };
	}

	const classes = new Map<string, acorn.ClassDeclaration>();
	let exported: acorn.ExportDefaultDeclaration | undefined;
	for (const stmt of program.body) {
		if (stmt.type === 'ClassDeclaration') classes.set(stmt.id.name, stmt);
		else if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration?.type === 'ClassDeclaration') {
			classes.set(stmt.declaration.id.name, stmt.declaration);
		} else if (stmt.type === 'ExportDefaultDeclaration') exported = stmt;
	}

	const expected = `the default export of a store file must be new ${BASE_CLASS}('name') or new C('name') with C a class in the file that extends ${BASE_CLASS}`;
	if (!exported) return fail(`store file has no default export; ${expected}`);
	const created = exported.declaration;
	if (created.type !== 'NewExpression' || created.callee.type !== 'Identifier') return fail(expected, created);

	const callee = created.callee.name;
	if (callee !== BASE_CLASS) {
		const cls = classes.get(callee);
		if (!cls) return fail(`${callee} is not a class declared in this store file; ${expected}`, created.callee);
		if (cls.superClass?.type !== 'Identifier' || cls.superClass.name !== BASE_CLASS) {
			return fail(`class ${callee} must extend ${BASE_CLASS}`, cls.superClass ?? cls.id);
		}
		for (const member of cls.body.body) {
			if (member.type !== 'MethodDefinition' && member.type !== 'PropertyDefinition') continue;
			if (member.static || member.computed || member.key.type !== 'Identifier') continue;
			if (STORE_BASE_MEMBERS.has(member.key.name)) {
				fail(`${callee}.${member.key.name} overrides a ${BASE_CLASS} member`, member.key);
			}
		}
	}

	const arg = created.arguments[0];
	if (created.arguments.length !== 1 || arg.type !== 'Literal' || typeof arg.value !== 'string') {
		return fail(`the store name must be the one argument to the constructor, as a string literal`, arg ?? created);
	}
	const name = arg.value;
	if (!isIdentifier(name)) {
		return fail(`store name "${name}" is not a valid identifier; templates use it as a variable`, arg);
	}
	if (name !== name.toLowerCase()) {
		errors.push(new BackflipError(
			`store name "${name}" contains uppercase letters; HTML lowercases attribute names, so b-store:${name} declares "${name.toLowerCase()}". Use a lowercase name to avoid confusion.`,
			{ ...errLoc(file, nodeLoc(arg)), severity: 'warning' },
		));
	}
	return { decl: { name, file, nameLoc: nodeLoc(arg) }, errors };
}

// True when `name` parses as a lone identifier expression (so not a reserved word
// or a literal like `true`).
function isIdentifier(name: string): boolean {
	if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return false;
	try {
		return acorn.parseExpressionAt(`(${name})`, 0, { ecmaVersion: 'latest' }).type === 'Identifier';
	} catch {
		return false;
	}
}

function nodeLoc(node: acorn.Node): SourceLoc {
	return {
		startLine: node.loc!.start.line, startCol: node.loc!.start.column + 1, startOffset: node.start,
		endLine: node.loc!.end.line, endCol: node.loc!.end.column + 1, endOffset: node.end,
	};
}

function errLoc(file: string, loc: SourceLoc | undefined) {
	if (!loc) return { filename: file, line: 1, col: 1 };
	return { filename: file, line: loc.startLine, col: loc.startCol, endLine: loc.endLine, endCol: loc.endCol };
}
