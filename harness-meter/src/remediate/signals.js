// Editorial content: which files justify keeping which plugin enabled.
//
// Deliberately conservative. A plugin is dropped only when it appears HERE and
// none of its signals are present — a plugin absent from this table is always
// kept. Adding an entry makes a plugin droppable, so add one only when the
// signals genuinely settle the question.
// sentry is deliberately absent: .sentryclirc/sentry.properties are CI/build
// tooling artifacts, not evidence of use. An app instrumented purely via the
// SDK (Sentry.init() with a DSN from the environment) has neither file, so
// this signal would mark the common integration pattern droppable. Do not
// add it back without a signal that also catches SDK-only usage.
// playwright is deliberately absent, by the same standard applied to sentry
// above: playwright.config.{ts,js} misses the .mjs/.cjs/.mts config forms
// (this table has no { ext } fallback for them), and playwright's dominant
// use here is as an MCP browser-automation surface, which needs no config
// file at all. A config-file signal would systematically miss real usage.
// Do not add it back without a signal that also catches config-less/MCP-only
// usage. (Note: azure is NOT affected by this reasoning — its signals stand.)
export const SIGNALS = {
  azure: [{ file: 'azure.yaml' }, { ext: '.bicep' }, { ext: '.csproj' }],
  'svelte-skills': [{ file: 'svelte.config.js' }, { ext: '.svelte' }],
  'pydantic-ai': [{ file: 'pyproject.toml' }, { ext: '.py' }],
  'typescript-lsp': [{ file: 'tsconfig.json' }, { ext: '.ts' }],
  'pyright-lsp': [{ file: 'pyrightconfig.json' }, { ext: '.py' }]
}
