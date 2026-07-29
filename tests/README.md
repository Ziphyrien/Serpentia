# Test layout

- Unit and module-level tests live beside their source as `name.spec.ts`.
- Cross-module workflows live under `tests/integration` as `name.integration.spec.ts`.
- Shared integration fixtures live under `tests/fixtures`.
- Test-only assertions and harness utilities live under `tests/support`.
- Browser end-to-end tests, when added, belong under `tests/e2e` with a separate runner.

Do not add `__tests__` directories, `.test.ts` files, mirrored `tests/unit/src/...` trees, or scenario arrays wrapped by a custom runner. Large modules should split specs by behavior, such as `engine-food.integration.spec.ts` and `engine-lifecycle.integration.spec.ts`.
