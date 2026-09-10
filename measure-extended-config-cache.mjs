// Defect 1: `loadTSConfig` calls `ts.parseJsonConfigFileContent` without the 8th argument
// (`extendedConfigCache`), so every config re-reads and re-parses its whole `extends`
// chain and allocates a fresh expanded `paths` map.
//
// Two arms, one per process (`tsConfigCache` is module scope -- a second arm in the same
// process reads the first arm's entries and measures nothing):
//
//   stock  -- the package as published
//   cached -- the same run with a shared `extendedConfigCache` supplied through the
//             public `registerTS` hook, which is exactly the 8th argument the package
//             leaves undefined. Nothing else differs.
//
// Run: node --expose-gc measure-extended-config-cache.mjs <stock|cached>

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { parse, compileScript, registerTS } from '@vue/compiler-sfc'
import ts from 'typescript'

import { generate } from './generate.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const arm = process.argv[2] === 'cached' ? 'cached' : 'stock'
const packages = Number(process.env.PACKAGES ?? 150)
const groupSize = Number(process.env.GROUP_SIZE ?? 20)
const pathEntries = Number(process.env.PATH_ENTRIES ?? 1000)

const root = join(here, '.tmp-workspace')
const files = generate({ root, packages, groupSize, pathEntries }).flat()

let parseCalls = 0
let readConfigCalls = 0
const distinctPaths = new Set()
const extendedConfigCache = new Map()

const tsProxy = new Proxy(ts, {
  get(target, prop, receiver) {
    if (prop === 'parseJsonConfigFileContent') {
      return (...args) => {
        parseCalls += 1
        const result =
          arm === 'cached'
            ? // 6th and 7th stay undefined, as in the package; only the 8th is supplied.
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
        if (result?.options?.paths) distinctPaths.add(result.options.paths)
        return result
      }
    }
    if (prop === 'readConfigFile') {
      return (...args) => {
        readConfigCalls += 1
        return target.readConfigFile(...args)
      }
    }
    return Reflect.get(target, prop, receiver)
  },
})

registerTS(() => tsProxy)

function liveSet() {
  if (!globalThis.gc) throw new Error('run with --expose-gc')
  for (let i = 0; i < 4; i++) globalThis.gc()
  return process.memoryUsage().heapUsed
}

const before = liveSet()
const started = Date.now()

let compiled = 0
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const { descriptor } = parse(source, { filename: file })
  compileScript(descriptor, { id: 'repro' })
  compiled += 1
}

const elapsed = Date.now() - started
const after = liveSet()
const mb = bytes => Math.round((bytes / 1024 / 1024) * 10) / 10

// A reproduction that cannot fail proves nothing: an SFC whose props are not an imported
// type never reaches tsconfig resolution, and every number below would be zero while the
// run still looked healthy.
if (parseCalls === 0) {
  throw new Error(
    'no tsconfig was parsed: the fixture never reached resolveWithTS, so this run measures nothing',
  )
}

console.log(
  JSON.stringify(
    {
      arm,
      packages,
      groupSize,
      pathEntriesInBase: pathEntries,
      componentsCompiled: compiled,
      parseJsonConfigFileContentCalls: parseCalls,
      readConfigFileCalls: readConfigCalls,
      distinctExpandedPathsObjects: distinctPaths.size,
      seconds: Math.round(elapsed / 100) / 10,
      // Retained heap after a forced GC -- what is still reachable, not garbage. This is
      // the figure to compare. `rss` is reported for context only: on macOS it can read
      // *below* `heapTotal` because the OS compresses resident pages, so it understates.
      retainedHeapMb: mb(after - before),
      heapTotalMb: mb(process.memoryUsage().heapTotal),
      rssAtEndMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    null,
    2,
  ),
)
