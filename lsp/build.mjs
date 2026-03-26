import * as esbuild from 'esbuild';

await esbuild.build({
	entryPoints: ['src/server.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	outfile: 'dist/server.cjs',
	// Use the "browser" field in css-tree's package.json to resolve
	// pre-built dist/ files that don't use createRequire.
	mainFields: ['browser', 'module', 'main'],
});
