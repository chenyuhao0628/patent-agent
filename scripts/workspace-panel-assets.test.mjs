import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

test('global task and transfer panels ship styles before any case panel is loaded', async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    entryPoints: ['src/modules/workspace-panels.tsx'],
    outfile: path.join(os.tmpdir(), 'patent-panel-assets/workspace.js'),
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    external: ['react', 'react-dom', 'lucide-react', 'katex'],
    loader: {'.png': 'dataurl'},
    logLevel: 'silent',
  });
  const entry = Object.values(result.metafile.outputs).find(output => output.entryPoint === 'src/modules/workspace-panels.tsx');
  assert(entry?.cssBundle, 'The global panel entry must load its own stylesheet.');
  const css = result.outputFiles.find(file => path.resolve(file.path) === path.resolve(entry.cssBundle))?.text;
  assert(css, 'The entry stylesheet must be emitted with the global panel bundle.');
  const requiredSelectors = ['.agent-task-list', '.agent-task-actions', '.local-workflow-case', '.workflow-nodes'];
  assert.deepEqual(requiredSelectors.filter(selector => !css.includes(selector)), [], 'A cold global panel must not depend on CSS loaded by a case visit.');
  assert(!Object.keys(result.metafile.inputs).some(input => input.endsWith('/AgentWorkbench.tsx')), 'Loading a global list must not eagerly load the case conversation component.');
});
