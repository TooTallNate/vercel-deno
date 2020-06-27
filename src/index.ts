import fs from 'fs';
import yn from 'yn';
import { join } from 'path';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import once from '@tootallnate/once';
import {
	AnalyzeOptions,
	BuildOptions,
	Env,
	StartDevServerOptions,
	StartDevServerResult,
	createLambda,
	download,
	glob,
	shouldServe,
} from '@vercel/build-utils';

const { stat, readdir, readFile, writeFile } = fs.promises;

const DEFAULT_DENO_VERSION = 'v1.1.1';

interface Graph {
	deps: string[];
	version_hash: string;
}

interface FileInfo {
	version: string;
	signature: string;
	affectsGlobalScope: boolean;
}

interface Program {
	fileInfos: { [name: string]: FileInfo };
	referencedMap: { [name: string]: string[] };
	exportedModulesMap: { [name: string]: string[] };
	semanticDiagnosticsPerFile: string[];
}

interface BuildInfo {
	program: Program;
	version: string;
}

export const version = 3;

export { shouldServe };

export function analyze({ files, entrypoint }: AnalyzeOptions) {
	return files[entrypoint].digest;
}

export async function build({
	workPath,
	files,
	entrypoint,
	meta = {},
	config = {},
}: BuildOptions) {
	//const { devCacheDir = join(workPath, '.vercel', 'cache') } = meta;
	//const distPath = join(devCacheDir, 'deno', entrypoint);

	await download(files, workPath, meta);

	let debug = false;

	if (typeof config.debug === 'boolean') {
		debug = config.debug;
	} else if (
		typeof config.debug === 'string' ||
		typeof config.debug === 'number'
	) {
		const d = yn(config.debug);
		if (typeof d === 'boolean') {
			debug = d;
		}
	} else {
		const debugEnv = process.env.DEBUG;
		if (typeof debugEnv === 'string') {
			const d = yn(debugEnv);
			if (typeof d === 'boolean') {
				debug = d;
			}
		}
	}

	let denoVersion = process.env.DENO_VERSION || DEFAULT_DENO_VERSION;
	if (typeof config.denoVersion === 'string') {
		denoVersion = config.denoVersion;
	}

	if (!denoVersion.startsWith('v')) {
		denoVersion = `v${denoVersion}`;
	}

	const env: typeof process.env = {
		...process.env,
		BUILDER: __dirname,
		ENTRYPOINT: entrypoint,
		DENO_VERSION: denoVersion,
	};

	if (debug) {
		env.DEBUG = '1';
	}

	const builderPath = join(__dirname, 'build.sh');
	const cp = spawn(builderPath, [], {
		env,
		cwd: workPath,
		stdio: 'inherit',
	});
	const code = await once(cp, 'exit');
	if (code !== 0) {
		throw new Error(`Build script failed with exit code ${code}`);
	}

	// Patch the `.graph` files to use file paths beginning with `/var/task`
	// to hot-fix a Deno issue (https://github.com/denoland/deno/issues/6080).
	const workPathUri = `file://${workPath}`;
	const genFileDir = join(workPath, '.deno/gen/file');
	for await (const file of getFilesWithExtension(genFileDir, '.graph')) {
		let needsWrite = false;
		const graph: Graph = JSON.parse(await readFile(file, 'utf8'));
		for (let i = 0; i < graph.deps.length; i++) {
			const dep = graph.deps[i];
			if (dep.startsWith(workPathUri)) {
				const updated = `file:///var/task${dep.substring(
					workPathUri.length
				)}`;
				graph.deps[i] = updated;
				needsWrite = true;
			}
		}
		if (needsWrite) {
			console.log('Patched %j', file);
			await writeFile(file, JSON.stringify(graph, null, 2));
		}
	}

	for await (const file of getFilesWithExtension(genFileDir, '.buildinfo')) {
		let needsWrite = false;
		const buildInfo: BuildInfo = JSON.parse(await readFile(file, 'utf8'));
		const { fileInfos, referencedMap, exportedModulesMap, semanticDiagnosticsPerFile } = buildInfo.program;;

		for (const filename of Object.keys(fileInfos)) {
			if (filename.startsWith(workPathUri)) {
				const updated = `file:///var/task${filename.substring(
					workPathUri.length
				)}`;
				fileInfos[updated] = fileInfos[filename];
				delete fileInfos[filename];
				needsWrite = true;
			}
		}

		for (const [ filename, refs ] of Object.entries(referencedMap)) {
			for (let i = 0; i < refs.length; i++) {
				const ref = refs[i];
				if (ref.startsWith(workPathUri)) {
					const updated = `file:///var/task${ref.substring(
						workPathUri.length
					)}`;
					refs[i] = updated;
					needsWrite = true;
				}
			}

			if (filename.startsWith(workPathUri)) {
				const updated = `file:///var/task${filename.substring(
					workPathUri.length
				)}`;
				referencedMap[updated] = refs;
				delete referencedMap[filename];
				needsWrite = true;
			}
		}

		for (const [ filename, refs ] of Object.entries(exportedModulesMap)) {
			for (let i = 0; i < refs.length; i++) {
				const ref = refs[i];
				if (ref.startsWith(workPathUri)) {
					const updated = `file:///var/task${ref.substring(
						workPathUri.length
					)}`;
					refs[i] = updated;
					needsWrite = true;
				}
			}

			if (filename.startsWith(workPathUri)) {
				const updated = `file:///var/task${filename.substring(
					workPathUri.length
				)}`;
				exportedModulesMap[updated] = refs;
				delete exportedModulesMap[filename];
				needsWrite = true;
			}
		}

		for (let i = 0; i < semanticDiagnosticsPerFile.length; i++) {
			const ref = semanticDiagnosticsPerFile[i];
			if (ref.startsWith(workPathUri)) {
				const updated = `file:///var/task${ref.substring(
					workPathUri.length
				)}`;
				semanticDiagnosticsPerFile[i] = updated;
				needsWrite = true;
			}
		}

		if (needsWrite) {
			console.log('Patched %j', file);
			await writeFile(file, JSON.stringify(buildInfo, null, 2));
		}
	}

	const output = await createLambda({
		files: await glob('**', workPath),
		handler: entrypoint,
		runtime: 'provided',
	});

	return { output };
}

async function* getFilesWithExtension(dir: string, ext: string): AsyncIterable<string> {
	const files = await readdir(dir);
	for (const file of files) {
		const absolutePath = join(dir, file);
		if (file.endsWith(ext)) {
			yield absolutePath;
		} else {
			const s = await stat(absolutePath);
			if (s.isDirectory()) {
				yield* getFilesWithExtension(absolutePath, ext);
			}
		}
	}
}

interface PortInfo {
	port: number;
}

function isPortInfo(v: any): v is PortInfo {
	return v && typeof v.port === 'number';
}

function isReadable(v: any): v is Readable {
	return v && v.readable === true;
}

export async function startDevServer(
	opts: StartDevServerOptions
): Promise<StartDevServerResult> {
	const { entrypoint, workPath, meta = {} } = opts;

	const env: typeof process.env = {
		...process.env,
		...meta.env,
		VERCEL_DEV_ENTRYPOINT: join(workPath, entrypoint),
	};

	const args: string[] = [
		'run',
		'--allow-env',
		'--allow-net',
		'--allow-read',
		'--allow-write',
		join(__dirname, 'dev-server.ts'),
	];

	const child = spawn('deno', args, {
		cwd: workPath,
		env,
		stdio: ['ignore', 'inherit', 'inherit', 'pipe'],
	});

	const portPipe = child.stdio[3];
	if (!isReadable(portPipe)) {
		throw new Error('Not readable');
	}

	const onPort = new Promise<PortInfo>((resolve) => {
		portPipe.setEncoding('utf8');
		portPipe.once('data', (d) => {
			resolve({ port: Number(d) });
		});
	});
	const onExit = once.spread<[number, string | null]>(child, 'exit');
	const result = await Promise.race([onPort, onExit]);
	onExit.cancel();

	if (isPortInfo(result)) {
		return {
			port: result.port,
			pid: child.pid,
		};
	} else {
		// Got "exit" event from child process
		throw new Error(
			`Failed to start dev server for "${entrypoint}" (code=${result[0]}, signal=${result[1]})`
		);
	}
}
