# `@vue/compiler-sfc` re-parses the whole tsconfig `extends` chain for every config it walks

Two independent problems in `resolveType.ts`, in one workspace generator because they share a
fixture. They are separate reports: the first is a one-argument fix, the second is a capacity
question whose answer belongs to the maintainers.

## Defect 1 — `loadTSConfig` never passes `extendedConfigCache`

https://github.com/vuejs/core/blob/main/packages/compiler-sfc/src/script/resolveType.ts

```js
const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, fs.readFile).config,
  parseConfigHost,           // 2
  dirname(configPath),       // 3
  undefined,                 // 4
  configPath,                // 5
)                            // 6, 7, 8 omitted -- the 8th is extendedConfigCache
```

The function then recurses through `projectReferences`:

```js
res.unshift(...loadTSConfig(refPath, ts, fs, visited))
```

So for a workspace of N packages that all `extends` a shared base, the base is re-read and
re-parsed once per config reached, and each parse allocates its own fully expanded `paths` map.
`visited` is a default parameter, so it de-duplicates within a single top-level call and never
across calls.

TypeScript takes an `extendedConfigCache` as its 8th argument for exactly this. With it, the
expanded options object is shared by reference instead of rebuilt.

### Measured

`node --expose-gc measure-extended-config-cache.mjs <stock|cached>`, one arm per process
(`tsConfigCache` is module scope, so a second arm in the same process would read the first one's
entries). The `cached` arm changes nothing but the 8th argument, supplied through the public
`registerTS` hook.

150 packages, 20 per reference group, 1000 padding entries in the shared base; node 22.23.2,
`@vue/compiler-sfc` 3.5.41, `typescript` 5.9:

| arm | config parses | distinct expanded `paths` objects | time | retained heap |
|---|---|---|---|---|
| stock | 2900 | **2900** | 11.1 s | **1346.8 MB** |
| cached | 2900 | **1** | 1.9 s | **30.2 MB** |

The parse count is identical in both arms — the cache does not remove parses, it makes each one
cheap, and it stops the expanded options from being rebuilt. That distinction matters: a fixture
that only parses configs and compiles nothing exaggerates the effect, because "fewer parses" and
"cheaper parses" look the same in it.

`retained heap` is `heapUsed` after a forced GC. `rss` is printed for context only — on macOS it
can read *below* `heapTotal`, because the OS compresses resident pages.

### Does the cache change the result?

`node parity.mjs` reproduces `loadTSConfig` verbatim and runs it twice per entry config, differing
only in the 8th argument, then compares resolved `compilerOptions`, `projectReferences` and
`fileNames` for every parse the traversal produces:

| run | parses compared | `paths` entries compared | mismatches |
|---|---|---|---|
| `node parity.mjs` | 400 | 176 000 | **0** |
| `MUTATE=1 node parity.mjs` | 400 | 176 000 | 336 |
| `MUTATE=2 node parity.mjs` | 400 | 176 000 | 400 |

The two mutation controls are there because a comparator that always prints zero proves nothing:
`MUTATE=1` makes the cached arm read a *different* config, `MUTATE=2` alters one entry of the
expanded `paths` map after parsing. Both must report mismatches for the clean run to mean anything.

`MUTATE=2` reporting 400 rather than 1 is itself worth noting: with the cache, the expanded
options object is shared by reference, so mutating one copy is visible from all of them.
`resolveWithTS` only reads `matchedConfig.config.options`, so this is not a problem today — but it
is the reason the cache must not be handed to a consumer that mutates.

## Defect 2 — the tsconfig LRU holds 500 entries and does not degrade gracefully

```js
const tsConfigCache = createCache<CachedConfig[]>()   // createCache(max = 500)
```

Keyed by the nearest tsconfig of the file being resolved. A workspace whose working set of
distinct nearest configs exceeds 500 does not lose a few percent of hit rate — a repeated
sequential walk evicts exactly the entry it is about to ask for next, so the recursive
`projectReferences` traversal runs again from scratch every round.

`node measure-lru-capacity.mjs 400 480 520 600` — nothing is patched, the observable is
`parseJsonConfigFileContent`, which `loadTSConfig` reaches only on a cache miss. Each package
holds one component per round, so the same key is asked for repeatedly while the *files* differ
(reusing one file would be answered by the per-file scope cache and would measure nothing):

| distinct nearest configs | parses in round 1 | round 2 | round 3 |
|---|---|---|---|
| 400 | 800 | **0** | **0** |
| 480 | 960 | **0** | **0** |
| 520 | 1040 | **1040** | **1040** |
| 600 | 1200 | **1200** | **1200** |

20 % over the cap turns a cache with a 100 % hit rate into one with a 0 % hit rate.

`fileToScopeCache` and `fileToGlobalScopeCache`, three lines below, are also `createCache()` and
so carry the same 500-entry cap. They are not measured here.

## Run it

```sh
npm install
npm run repro        # defect 1, both arms
npm run repro:lru    # defect 2, the capacity table
npm run parity       # defect 1, result parity
```

Scale with `PACKAGES`, `GROUP_SIZE`, `PATH_ENTRIES`:

```sh
PACKAGES=300 GROUP_SIZE=30 node --expose-gc measure-extended-config-cache.mjs stock
```

At 300 packages the stock arm ran out of heap here on the default node heap limit; that is the
effect, not a broken fixture.

## Why a generated workspace, and what makes it valid

Two properties of the generated SFC decide whether this reproduction measures anything at all,
and getting either wrong yields a clean run over an empty code path:

- props must come from a **type that has to be resolved** — `defineProps<Props>()` with `Props`
  declared in another module. Runtime props never reach type resolution.
- the import must be **non-relative**. `importSourceToScope` resolves `./x` and `../x` with its
  own `resolveExt` fast path and only falls back to `resolveWithTS` if that fails, so a fixture
  built from relative imports parses no tsconfig at all.

Both measurement scripts therefore assert the parse count is non-zero and fail loudly otherwise.

## On a real application

A production Vue monorepo (2432 components, 514 tsconfigs, 4051 project references, a 118 KB
shared base with 1342 `paths` entries), compiling 400 of its real components through
`compileScript` with the same two arms:

| arm | config parses | distinct expanded `paths` objects | time | retained heap |
|---|---|---|---|---|
| stock | 7351 | **7350** | 25.4 s | **2615.8 MB** |
| cached | 7351 | **3** | 8.0 s | **188.7 MB** |

Defect 2 does **not** fire on that repository, and the measurement is the reason to say so
rather than assume it: instrumenting `tsConfigCache` over a full compile of all 2432 components
recorded 1270 lookups across **116** distinct keys — nothing was ever evicted. The nearest
tsconfig of a component is its package's, and there are far fewer packages than configs. So
defect 2 is a latent ceiling for large workspaces, not something this application hits.
