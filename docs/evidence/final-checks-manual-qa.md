# SafeNight final regression manualQa

## surfaceEvidence

| Scenario | Criterion | Surface | Exact invocation | Verdict | artifactRefs |
|---|---|---|---|---|---|
| C1 | Cloud regression including Python fitting and promotion | cloud CLI | `SAFENIGHT_PIPELINE_PYTHON_QA=1 node --test tests/*.test.mjs` | PASS · 217/217 | A1 |
| C2 | Cloud static check | cloud CLI | `npx tsc --noEmit` | PASS · exit 0 | A2 |
| C3 | Production build | cloud CLI | `npm run build` | PASS · exit 0 | A3 |
| B1 | Backend lint | backend CLI | `uv run --locked ruff check .` | PASS · exit 0 | A4 |
| B2 | Backend types | backend CLI | `uv run --locked basedpyright` | PASS · zero diagnostics | A5 |
| B3 | Backend regression with temporary PostgreSQL | backend CLI | `uv run --locked pytest -q` with SAFENIGHT_TEST_DATABASE_URL set to the verified pgserver socket | PASS · 81/81 | A6 |

## adversarialCases

| Scenario | Criterion | Adversarial class | Expected behavior | Verdict | artifactRefs |
|---|---|---|---|---|---|
| L1 | C1 location sync | malformed source | Reject HTML and invalid Korean coordinates before cloud requests | PASS | A1 lines 152–157 |
| L2 | C1 location sync | interrupted import and new content | Keep partial records private, resume the last page and isolate changed bytes | PASS | A1 lines 152–157 |
| P1 | C1 population | bad upstream refresh | Preserve the previous cache and bound retries | PASS | A1 line 199 |
| P2 | C1 population | storage unavailable | Return retryable failure without contacting the upstream | PASS | A1 lines 204–205 |
| P3 | C1 population | zero versus missing source value | Preserve valid zero and reject missing values | PASS | A1 lines 214, 229 |
| M1 | C1 model promotion | concurrent writes | Serialize active switches and retain a new rollback generation | PASS | A1 line 168 |

## artifactRefs

| ID | Kind | Description | Path |
|---|---|---|---|
| A1 | CLI transcript | Node regression with Python training enabled | final-checks.txt lines 12–268 |
| A2 | CLI transcript | TypeScript compiler and exit status | final-checks.txt lines 269–271 |
| A3 | CLI transcript | Production routes, warnings, completion, output checksum | final-checks.txt lines 8–9 and 272–335 |
| A4 | CLI transcript | Ruff | final-checks.txt lines 336–339 |
| A5 | CLI transcript | basedpyright | final-checks.txt lines 340–343 |
| A6 | CLI transcript | pgserver isolation, pytest, process stop and cleanup receipt | final-checks.txt lines 344–352 |
