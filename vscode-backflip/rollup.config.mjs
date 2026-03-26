import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import swc from 'rollup-plugin-swc3';
import { builtinModules } from 'node:module';

export default {
	input: 'src/extension.ts',
	output: {
		file: 'dist/extension.js',
		format: 'cjs',
	},
	external: (id) =>
		id === 'vscode' ||
		builtinModules.includes(id) ||
		id.startsWith('node:'),
	plugins: [
		resolve({ preferBuiltins: true, extensions: ['.ts', '.js'] }),
		commonjs(),
		swc({ tsconfig: false, jsc: { parser: { syntax: 'typescript' } } }),
	],
};
