// Shared helpers for the CSS test suites. Not part of the package's public API
// and not reachable from `index.ts`, so the analyzer itself keeps no runtime
// dependency on the compiler — only these helpers do, to turn template sources
// into the compiled trees `analyzeCss` matches against.
//
// `@backflip/html` resolves to the built `dist/`, so run `npm run build` at the
// repo root before the CSS tests (the integration suite already requires it).

import { compileFiles } from '@backflip/html';
import type { CompiledFile } from '@backflip/html';
import { analyzeCss } from './index.js';
import type { CssAnalysisResult } from './types.js';

/** Compile template sources into the trees `analyzeCss` consumes. */
export async function compileTemplates(
	templateFiles: Map<string, string>,
): Promise<Map<string, CompiledFile>> {
	const { directory } = await compileFiles(templateFiles);
	return directory.files;
}

/**
 * Compile the given templates and analyze `cssContent` against them.
 *
 * `analyzeCss` works per stylesheet, so the content is given a path. Tests that
 * do not care about provenance can leave `cssPath` alone.
 */
export async function analyzeSource(input: {
	cssContent: string;
	cssPath?: string;
	templateFiles: Map<string, string>;
}): Promise<CssAnalysisResult> {
	return analyzeCss({
		files: [{ path: input.cssPath ?? VIRTUAL_CSS_PATH, content: input.cssContent }],
		compiled: await compileTemplates(input.templateFiles),
	});
}

/** Stand-in path for tests that analyze a CSS string with no file behind it. */
export const VIRTUAL_CSS_PATH = '/virtual/styles.css';
