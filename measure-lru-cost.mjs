// What does the LRU thrash of defect 2 actually COST, and does the fix for defect 1
// change the answer?
//
// `measure-lru-capacity.mjs` shows the thrash exists: past 500 distinct nearest configs
// every round re-parses. It counts parses and stops there. But a parse is only expensive
// because `loadTSConfig` omits the 8th argument of `parseJsonConfigFileContent`
// (defect 1), so each one re-reads the whole `extends` chain and re-expands `paths`.
//
// So the two defects are coupled, and the coupling decides whether defect 2 is worth a
// change at all: if supplying `extendedConfigCache` makes a miss cheap, the cap can stay
// where it is and the LRU degrades the way a cache is supposed to -- a lower hit rate,
// not a cliff.
//
// Four cells, one process each (`tsConfigCache` is module scope, and a second cell in the
// same process would read the first one's entries):
//
//                | stock            | cached
//   under the cap| rounds 2,3 free  | rounds 2,3 free
//   over the cap | rounds 2,3 pay   | rounds 2,3 pay -- how much?
//
// The `cached` arm supplies the shared `extendedConfigCache` through the public
// `registerTS` hook, which is exactly what PR #15480 threads into the same argument.
// Nothing else differs between the arms.
//
// Run: node measure-lru-cost.mjs [underCap overCap]

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { generate } from './generate.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// Five rather than three: the first round pays for JIT warmup and the second still shows
// it, so a steady-state figure needs a couple of rounds past them.
const ROUNDS = Number(process.env.ROUNDS ?? 5)
const GROUP_SIZE = Number(process.env.GROUP_SIZE ?? 2)
// The shared base carries `packages` + 2 * PATH_ENTRIES aliases. The app this was found
// on has 1342 in a 118 KB base; the default here lands in the same order.
const PATH_ENTRIES = Number(process.env.PATH_ENTRIES ?? 400)

if (process.env.LRU_COST_CHILD) {
  const { parse, compileScript, registerTS } = await import('@vue/compiler-sfc')
  const ts = (await import('typescript')).default

  // The fixture is the same size in every cell; only how much of it a round WALKS
  // changes. Generating a smaller workspace for the under-cap cell instead would make
  // the two cells different workspaces -- different base, different alias count -- and
  // the heap column could then not be read across the cap boundary at all.
  const packages = Number(process.env.LRU_COST_CHILD)
  const walk = Number(process.env.WALK ?? packages)
  const arm = process.env.ARM === 'cached' ? 'cached' : 'stock'

  const root = join(here, `.tmp-workspace-lru-cost-${packages}`)
  const byPackage = generate({
    root,
    packages,
    groupSize: GROUP_SIZE,
    pathEntries: PATH_ENTRIES,
    componentsPerPackage: ROUNDS,
  }).slice(0, walk)

  let parseCalls = 0
  // A plain Set here would be a strong reference to every expanded `paths` object, and
  // the retained-heap figure below would then be measuring the instrument rather than the
  // package -- in the stock arm that is thousands of maps of a thousand-odd entries each.
  // A WeakSet counts the same distinct objects and holds none of them.
  const seenPaths = new WeakSet()
  let distinctPathsCount = 0
  const extendedConfigCache = new Map()

  registerTS(
    () =>
      new Proxy(ts, {
        get(target, prop, receiver) {
          if (prop === 'parseJsonConfigFileContent') {
            return (...args) => {
              parseCalls += 1
              const result =
                arm === 'cached'
                  ? // 6th and 7th stay undefined, as in the package; only the 8th differs.
                    target.parseJsonConfigFileContent(
                      args[0],
                      args[1],
                      args[2],
                      args[3],
                      args[4],
                      args[5],
                      args[6],
                      extendedConfigCache,
                    )
                  : target.parseJsonConfigFileContent(...args)
              const paths = result?.options?.paths
              if (paths && !seenPaths.has(paths)) {
                seenPaths.add(paths)
                distinctPathsCount += 1
              }
              return result
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      }),
  )

  function liveSet() {
    if (!globalThis.gc) throw new Error('run with --expose-gc')
    for (let i = 0; i < 4; i++) globalThis.gc()
    return process.memoryUsage().heapUsed
  }

  const before = liveSet()
  const perRound = []

  for (let round = 0; round < ROUNDS; round++) {
    const parsesBefore = parseCalls
    const started = Date.now()
    for (const perPackage of byPackage) {
      const file = perPackage[round]
      const source = readFileSync(file, 'utf8')
      const { descriptor } = parse(source, { filename: file })
      compileScript(descriptor, { id: 'repro' })
    }
    perRound.push({
      parses: parseCalls - parsesBefore,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    })
  }

  const after = liveSet()
  const mb = bytes => Math.round((bytes / 1024 / 1024) * 10) / 10

  // A run that never reached tsconfig resolution would report zeros while looking healthy.
  if (perRound[0].parses === 0) {
    throw new Error(
      'nothing was parsed: the fixture never reached resolveWithTS, so this run measures nothing',
    )
  }

  console.log(
    JSON.stringify({
      packages,
      walk,
      arm,
      perRound,
      totalParses: parseCalls,
      distinctExpandedPathsObjects: distinctPathsCount,
      retainedHeapMb: mb(after - before),
      rssAtEndMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    }),
  )
  process.exit(0)
}

const args = process.argv.slice(2).map(Number)
const walks = args.length ? args : [400, 600]
// One workspace for every cell, sized to the largest walk.
const fixture = Number(process.env.PACKAGES ?? Math.max(...walks))

const rows = []
for (const walk of walks) {
  for (const arm of ['stock', 'cached']) {
    const out = execFileSync(
      process.execPath,
      ['--expose-gc', '--max-old-space-size=8192', fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          LRU_COST_CHILD: String(fixture),
          WALK: String(walk),
          ARM: arm,
        },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    )
    rows.push(JSON.parse(out.trim().split('\n').pop()))
  }
}

console.log(
  `\ncap is 500 (createCache(max = 500)); ${ROUNDS} rounds, groupSize ${GROUP_SIZE}, ` +
    `one workspace of ${fixture} packages throughout, ` +
    `${PATH_ENTRIES * 2} padding aliases in the shared base plus one per package\n`,
)
const roundLabels = Array.from({ length: ROUNDS }, (_, i) => `r${i + 1}`).join(' / ')
console.log(
  `| nearest configs walked | arm | parses ${roundLabels} | seconds ${roundLabels} | distinct expanded \`paths\` | retained heap |`,
)
console.log('|---|---|---|---|---|---|')
for (const r of rows) {
  const parses = r.perRound.map(x => x.parses).join(' / ')
  const secs = r.perRound.map(x => x.seconds).join(' / ')
  console.log(
    `| ${r.walk} | ${r.arm} | ${parses} | ${secs} | ${r.distinctExpandedPathsObjects} | ${r.retainedHeapMb} MB |`,
  )
}
