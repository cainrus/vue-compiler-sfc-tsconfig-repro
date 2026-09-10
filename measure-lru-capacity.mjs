// Defect 2: `tsConfigCache` is `createCache()`, i.e. an LRU capped at 500 entries, keyed
// by the nearest tsconfig of the file being resolved. A workspace whose working set of
// distinct nearest configs exceeds that cap does not degrade gracefully -- on a repeated
// sequential walk it thrashes, and every lookup re-runs the recursive
// `projectReferences` traversal from scratch.
//
// Nothing is patched here. The observable is `ts.parseJsonConfigFileContent`, which
// `loadTSConfig` calls only on a cache miss: with the working set inside the cap the
// parses all happen in the first round and later rounds are free, and past the cap every
// round pays again.
//
// Each package holds several components so the same cache key is asked for repeatedly
// while the *files* differ -- reusing one file per package would be answered by the
// per-file scope cache and would measure nothing.
//
// Run: node measure-lru-capacity.mjs [packages...]

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { generate } from './generate.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// One workspace size per process: `tsConfigCache` is module scope, so a second size in
// the same process would read the first one's entries.
if (process.env.LRU_CHILD) {
  const { parse, compileScript, registerTS } = await import('@vue/compiler-sfc')
  const ts = (await import('typescript')).default

  const packages = Number(process.env.LRU_CHILD)
  const rounds = Number(process.env.ROUNDS ?? 3)
  const root = join(here, '.tmp-workspace-lru')
  const byPackage = generate({
    root,
    packages,
    groupSize: Number(process.env.GROUP_SIZE ?? 2),
    pathEntries: Number(process.env.PATH_ENTRIES ?? 50),
    componentsPerPackage: rounds,
  })

  let parseCalls = 0
  const perRound = []
  registerTS(
    () =>
      new Proxy(ts, {
        get(target, prop, receiver) {
          if (prop === 'parseJsonConfigFileContent') {
            return (...args) => {
              parseCalls += 1
              return target.parseJsonConfigFileContent(...args)
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      }),
  )

  for (let round = 0; round < rounds; round++) {
    const before = parseCalls
    for (const perPackage of byPackage) {
      const file = perPackage[round]
      const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file })
      compileScript(descriptor, { id: 'repro' })
    }
    perRound.push(parseCalls - before)
  }

  if (perRound[0] === 0) {
    throw new Error('nothing was parsed: the fixture never reached resolveWithTS')
  }

  console.log(JSON.stringify({ packages, perRound, total: parseCalls }))
  process.exit(0)
}

const sizes = process.argv.slice(2).map(Number)
const workingSets = sizes.length ? sizes : [400, 480, 520, 600]

console.log('cache capacity is 500 (createCache(max = 500))\n')
console.log('| distinct nearest configs | parses in round 1 | round 2 | round 3 |')
console.log('|---|---|---|---|')
for (const packages of workingSets) {
  const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, LRU_CHILD: String(packages) },
    encoding: 'utf8',
  })
  const { perRound } = JSON.parse(out.trim().split('\n').pop())
  console.log(`| ${packages} | ${perRound[0]} | ${perRound[1]} | ${perRound[2]} |`)
}
