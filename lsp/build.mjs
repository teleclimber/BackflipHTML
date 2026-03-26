import { rollup } from 'rollup';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import swc from 'rollup-plugin-swc3';
import json from '@rollup/plugin-json';
import { builtinModules } from 'node:module';

// css-tree's ESM entry uses createRequire(import.meta.url) to load JSON data
// files. Rollup converts import.meta.url to __filename for CJS output, but
// the relative paths then resolve against the bundle location instead of the
// original source. Replace the createRequire pattern with static imports so
// Rollup can resolve and inline the JSON at build time.
const csstreeStaticJson = {
	name: 'csstree-static-json',
	transform(code, id) {
		if (!id.includes('css-tree') || !code.includes('createRequire')) {
			return null;
		}
		const transformed = code
			.replace(
				/import\s*\{\s*createRequire\s*\}\s*from\s*'module';\s*/g,
				'',
			)
			.replace(
				/const\s+require\s*=\s*createRequire\(import\.meta\.url\);\s*/g,
				'',
			)
			.replace(
				/(?:export\s+)?const\s+(\{[^}]+\}|\w+)\s*=\s*require\(('[^']+')\);?/g,
				(_, binding, specifier) =>
					`import ${binding.startsWith('{') ? binding + ' from' : binding + ' from'} ${specifier};`,
			);
		return { code: transformed, map: null };
	},
};

const bundle = await rollup({
	input: 'src/server.ts',
	external: (id) => builtinModules.includes(id) || id.startsWith('node:'),
	plugins: [
		csstreeStaticJson,
		resolve({ preferBuiltins: true, extensions: ['.ts', '.js'] }),
		json(),
		commonjs(),
		swc({ tsconfig: false, jsc: { parser: { syntax: 'typescript' } } }),
	],
});

await bundle.write({
	file: 'dist/server.cjs',
	format: 'cjs',
});

await bundle.close();
