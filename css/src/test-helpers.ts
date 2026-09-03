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

/** Compile the given templates and analyze `cssContent` against them. */
export async function analyzeSource(input: {
	cssContent: string;
	templateFiles: Map<string, string>;
}): Promise<CssAnalysisResult> {
	return analyzeCss({ cssContent: input.cssContent, compiled: await compileTemplates(input.templateFiles) });
}
