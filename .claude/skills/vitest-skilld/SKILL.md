---
name: vitest-skilld
description: "ALWAYS use when writing code importing \"vitest\". Consult for debugging, best practices, or modifying vitest."
metadata:
  version: 3.2.7
  generated_by: Anthropic · Haiku 4.5
  generated_at: 2026-08-20
---

# vitest-dev/vitest `vitest@3.2.7`
**Tags:** V3: 3.2.7, latest: 4.1.11, beta: 5.0.0-beta.7

**References:** [package.json](./.skilld/pkg/package.json) • [README](./.skilld/pkg/README.md) • [Docs](./.skilld/docs/_INDEX.md)

## Search

Use `skilld search "query" -p vitest` instead of grepping `.skilld/` directories. Run `skilld search --guide -p vitest` for full syntax, filters, and operators.

<!-- skilld:api-changes -->
## API Changes

This section documents version-specific API changes — prioritize recent major/minor releases.

- NEW: `annotate()` context method — v3.2 adds annotation API to tests for attaching messages and attachments visible in reporters [source](./.skilld/docs/guide/test-context.md:L82:L103)

- NEW: `signal` — v3.2 provides AbortSignal in test context, aborted on timeout, Ctrl+C, bail, or cancellation [source](./.skilld/docs/guide/test-context.md:L105:L118)

- NEW: `test.extend()` fixture `scope` option — v3.2 allows `{ scope: 'file' | 'worker' }` for per-file or per-worker initialization [source](./.skilld/docs/guide/test-context.md:L376:L414)

- NEW: `locators.extend()` API — v3.2 enables custom browser locators by extending built-in locators with new methods [source](./.skilld/docs/blog/vitest-3-2.md:L111:L175)

- NEW: Explicit Resource Management (`using`) — v3.2 supports `using spy = vi.spyOn(...)` to auto-restore mocks when block exits [source](./.skilld/docs/blog/vitest-3-2.md:L177:L189)

- NEW: `sequence.groupOrder` config — v3.2 controls project execution order in multi-project setups [source](./.skilld/docs/blog/vitest-3-2.md:L268:L323)

- NEW: `Matchers` type for custom matchers — v3.2 provides unified type support for expect extensions across all use cases [source](./.skilld/docs/blog/vitest-3-2.md:L232:L266)

- NEW: `watchTriggerPatterns` option — v3.2 configures which tests rerun when non-imported files change [source](./.skilld/docs/blog/vitest-3-2.md:L211:L230)

- BREAKING: `test()/describe()` third argument must be options object — v3.0 prints warning, v4 will throw if options passed as third argument instead of second [source](./.skilld/docs/guide/migration.md:L10:L30)

- BREAKING: `spy.mockReset()` now restores original implementation — v3.0 changes from noop to restoring actual function instead of undefined return [source](./.skilld/docs/guide/migration.md:L57:L74)

- BREAKING: `vi.spyOn()` reuses mock if already mocked — v3.0 creates single spy per method to prevent restore chain issues [source](./.skilld/docs/guide/migration.md:L76:L86)

- BREAKING: Fake timers mock all available timers by default — v3.0 now mocks `performance.now()` and all timer APIs automatically without `toFake` config [source](./.skilld/docs/guide/migration.md:L88:L117)

- BREAKING: Error equality checks more properties — v3.0 compares `name`, `message`, `cause`, `AggregateError.errors`, and prototypes (TypeError vs Error) [source](./.skilld/docs/guide/migration.md:L119:L138)

- DEPRECATED: `browser.name` and `browser.providerOptions` — v3.0 deprecates in favor of `browser.instances` array, will remove in v4 [source](./.skilld/docs/guide/migration.md:L32:L56)

- DEPRECATED: `workspace` config in favor of `projects` — v3.2 deprecates separate workspace files, use `projects` option in root config [source](./.skilld/docs/blog/vitest-3-2.md:L36:L42)

**Also changed:** `onTestFinished` and `onTestFailed` receive context · `Custom` type alias to `Test` · `WorkspaceSpec` type removed in favor of `TestSpecification` · Snapshot API changes in `@vitest/snapshot` · `resolveConfig` now accepts user config instead of resolved config
<!-- /skilld:api-changes -->

<!-- skilld:best-practices -->
## Vitest 3.2.7 Best Practices

## Best Practices

- Always restore or reset mocks in `beforeEach` or `afterEach` hooks to prevent state leaking between tests — calls to `vi.resetAllMocks()` or `vi.restoreAllMocks()` ensure mock state does not accumulate [source](./.skilld/docs/guide/mocking.md#mocking)

- Use the context-bound `expect()` from test context for concurrent snapshot tests to ensure the right test is detected when running async concurrent tests together [source](./.skilld/docs/guide/snapshot.md:L36:L38)

- Prefer `test.extend()` with fixtures over `beforeEach`/`afterEach` hooks for extending test context — it provides cleaner setup/teardown semantics and lazy initialization [source](./.skilld/docs/guide/test-context.md:L130:L156)

- Define fixture scope as `file` or `worker` in `test.extend()` options to control lifecycle: `file` scope runs once per file (like `beforeAll`/`afterAll`), while `worker` scope runs once per worker when isolation is disabled [source](./.skilld/docs/guide/test-context.md:L376:L414)

- Always destructure context when using `test.extend()` — use `({ todos })` instead of `(context)` to enable proper fixture initialization and tracking [source](./.skilld/docs/guide/test-context.md:L219:L232)

- Disable test isolation with `isolate: false` for projects with proper cleanup and no side effects to improve test speed — isolation adds overhead per test file [source](./.skilld/docs/guide/improving-performance.md:L1:L32)

- Use `pool: 'threads'` instead of the default `'forks'` in large projects for faster execution, though `'forks'` provides better compatibility with hanging processes and segfaults [source](./.skilld/docs/guide/improving-performance.md:L55:L74)

- Avoid barrel file imports (e.g., `import { formatter } from './utils'`) and use direct imports (`import { formatter } from './utils/formatters'`) to reduce unnecessary file transformations and improve test startup time [source](./.skilld/docs/guide/profiling-test-performance.md:L152:L160)

- Use Explicit Resource Management with `using` for automatic mock restoration instead of manual cleanup — when the block exits, `mockRestore()` is called automatically [source](./.skilld/docs/blog/vitest-3-2.md:L177:L189)

- Leverage the test context's `signal` property (AbortSignal) to cancel async operations like fetch requests when tests timeout or are manually cancelled [source](./.skilld/docs/blog/vitest-3-2.md:L191:L203)

- Extend the `Matchers` interface (since 3.2.0) instead of defining separate `Assertion` and `AsymmetricMatchersContaining` interfaces — this single interface now provides type support for all expect forms (`expect().*`, `expect.*`, `expect.extend`) [source](./.skilld/docs/guide/extending-matchers.md:L29:L56)

- Use the module promise syntax with `vi.mock()` for improved IDE support and automatic type inference — pass an import expression and Vitest enforces factory return type compatibility with the original module [source](./.skilld/docs/api/vi.md:L52:L69)

- Use `vi.hoisted()` to define variables that can be referenced inside `vi.mock()` factories — this pattern is required because `vi.mock()` is hoisted and cannot access external scope [source](./.skilld/docs/api/vi.md:L84:L106)
<!-- /skilld:best-practices -->
