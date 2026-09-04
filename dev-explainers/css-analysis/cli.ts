import * as fs from 'node:fs';
import * as http from 'node:http';
import { renderBody, renderDocument } from './page.js';
import { buildPayload, type ProjectArgs } from './project.js';
import { summarize } from './summary.js';

/**
 * Generate a page showing what the CSS analyzer did to a project, stage by
 * stage. Run it from the repo root:
 *
 *   npm --prefix css run explain -- --project ../my-site
 *   npm --prefix css run explain -- --templates ./templates --css ./styles.css
 */

const USAGE = `
backflip css explain — trace CSS analysis over a project

  --demo              run against the bundled demo project, which exercises
                      every expansion rule; needs no other argument
  --project <dir>     a directory with a backflip.json; templates and CSS are
                      resolved from it
  --templates <dir>   template directory (overrides --project)
  --css <file>        stylesheet; repeatable (overrides --project)
  -o, --out <file>    output path (default: css-explain.html in the cwd)
  --fragment          emit title + style + markup with no document wrapper,
                      for embedding or publishing
  --serve             serve the page on localhost; every reload re-runs the
                      whole analysis against the files as they are now
  --port <n>          port for --serve (default 4000)
  --no-html           print the results only; write no page
  -q, --quiet         write the page only; print no results
  -h, --help          this text

One of --demo, --project and --templates is required.
`.trim();

interface Args extends ProjectArgs {
	out: string;
	fragment: boolean;
	html: boolean;
	quiet: boolean;
	serve: boolean;
	port: number;
	help: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		demo: false, css: [], out: 'css-explain.html',
		fragment: false, html: true, quiet: false, serve: false, port: 4000, help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = (): string => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			return value;
		};
		switch (arg) {
			case '--demo': args.demo = true; break;
			case '--project': args.project = next(); break;
			case '--templates': args.templates = next(); break;
			case '--css': args.css.push(next()); break;
			case '-o': case '--out': args.out = next(); break;
			case '--fragment': args.fragment = true; break;
			case '--no-html': args.html = false; break;
			case '-q': case '--quiet': args.quiet = true; break;
			case '--serve': args.serve = true; break;
			case '--port': {
				const port = Number(next());
				if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port ${port}`);
				args.port = port;
				break;
			}
			case '-h': case '--help': args.help = true; break;
			default: throw new Error(`unknown option ${arg}`);
		}
	}
	return args;
}

function errorPage(message: string): string {
	const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;');
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Backflip CSS Trace — error</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; padding: 48px 24px; background: #f5f6f8; color: #12161d;
  font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; }
main { max-width: 62ch; margin: 0 auto; }
h1 { font-size: 16px; margin: 0 0 12px; }
pre { background: #fff; border-left: 3px solid #9c6208; border-radius: 0 4px 4px 0;
  padding: 12px 14px; overflow-x: auto; font-family: ui-monospace, monospace; font-size: 12.5px; }
p { color: #5b6472; }
@media (prefers-color-scheme: dark) {
  body { background: #0e1115; color: #e7ebf1; }
  pre { background: #161a20; }
  p { color: #8992a1; }
}
</style></head><body><main>
<h1>The analysis could not run</h1>
<pre>${escaped}</pre>
<p>Fix it and reload — nothing is cached.</p>
</main></body></html>`;
}

async function serve(args: Args): Promise<void> {
	const server = http.createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? '/', 'http://localhost');
			if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
			if (url.pathname !== '/') { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n'); return; }

			const started = performance.now();
			try {
				const payload = await buildPayload(args);
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
				res.end(renderDocument(payload));
				const { counts, warnings } = payload.meta;
				console.log(
					`${new Date().toLocaleTimeString()}  rebuilt in ${(performance.now() - started).toFixed(0)}ms — ` +
					`${counts.instances} instances, ${counts.matchedElements} matched elements` +
					(warnings.length ? `, ${warnings.length} compile diagnostic${warnings.length === 1 ? '' : 's'}` : '')
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				res.writeHead(500, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
				res.end(errorPage(message));
				console.error(`${new Date().toLocaleTimeString()}  failed — ${message}`);
			}
		})();
	});

	server.on('error', (err: NodeJS.ErrnoException) => {
		if (err.code === 'EADDRINUSE') {
			console.error(`port ${args.port} is in use — pass --port <n>`);
			process.exit(1);
		}
		throw err;
	});

	await new Promise<void>(resolve => server.listen(args.port, resolve));
	console.log(`http://localhost:${args.port}  — reload to re-run the analysis; ctrl-c to stop`);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || (!args.demo && !args.project && !args.templates)) {
		console.log(USAGE);
		process.exit(args.help ? 0 : 1);
	}

	if (args.serve) {
		// Run once up front so a broken setup — no templates, no stylesheet, no
		// backflip.json — is reported here rather than only in the browser.
		const first = await buildPayload(args);
		const { counts, warnings, assetDirs, configDir } = first.meta;
		console.log(
			`${counts.files} files · ${counts.partials} partials · ${counts.rules} rules · ` +
			`${counts.instances} instances · ${counts.matchedElements} matched elements` +
			(warnings.length ? ` · ${warnings.length} compile diagnostic${warnings.length === 1 ? '' : 's'}` : '')
		);
		// Named up front: a run whose asset dirs are missing reports one diagnostic
		// per asset attribute, and this is the line that explains the pile.
		console.log(`assets: ${assetDirs.length > 0
			? assetDirs.map(name => `@${name}`).join(' ')
			: configDir !== undefined
				? `none in ${configDir}/backflip.json — src~ will not compile`
				: 'no backflip.json found — src~ will not compile'}`);
		return serve(args);
	}

	const payload = await buildPayload(args);
	// `summarize` already lists them; printing here too would say everything twice.
	if (args.quiet) {
		for (const warning of payload.meta.warnings) console.warn(`[compile] ${warning}`);
	} else {
		console.log(summarize(payload));
	}

	if (args.html) {
		fs.writeFileSync(args.out, args.fragment ? renderBody(payload) : renderDocument(payload), 'utf-8');
		const kb = Math.round(fs.statSync(args.out).size / 1024);
		console.log(`${args.quiet ? '' : '\n'}wrote ${args.out} (${kb} KB)`);
	}
	if (payload.meta.truncated && args.quiet) {
		console.warn('the instance budget ran out; the page says so and shows what was built');
	}
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
