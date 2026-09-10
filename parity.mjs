// Does the 8th argument change the RESULT, or only its cost?
//
// `loadTSConfig` is reproduced verbatim here -- same argument order, same recursion, same
// `visited` -- and run twice per entry config, differing only in whether an
// `extendedConfigCache` is passed. Resolved `compilerOptions`, `projectReferences` and
// `fileNames` are compared for every parse the traversal produces.
//
// A comparison that always prints zero proves nothing, so two mutation controls are
// built in and both must report mismatches:
//
//   MUTATE=1  the cached arm reads a DIFFERENT config -- catches a harness that is not
//             comparing the arms at all
//   MUTATE=2  one entry of the expanded `paths` map is altered after parsing -- catches a
//             comparator that skips the very field the cache is suspected of sharing
//
// Run: node parity.mjs  /  MUTATE=1 node parity.mjs  /  MUTATE=2 node parity.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import ts from 'typescript'

import { generate } from './generate.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packages = Number(process.env.PACKAGES ?? 40)
const root = join(here, '.tmp-workspace-parity')
generate({
  root,
  packages,
  groupSize: Number(process.env.GROUP_SIZE ?? 10),
  pathEntries: Number(process.env.PATH_ENTRIES ?? 200),
})

const readFile = p => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

function loadTSConfig(configPath, extendedConfigCache, visited = new Set()) {
  const config = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, readFile).config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
    undefined,
    undefined,
    extendedConfigCache,
  )
  const res = [config]
  visited.add(configPath)
  if (config.projectReferences) {
    for (const ref of config.projectReferences) {
      const refPath = ts.resolveProjectReferencePath(ref)
      if (visited.has(refPath) || !ts.sys.fileExists(refPath)) continue
      res.unshift(...loadTSConfig(refPath, extendedConfigCache, visited))
    }
  }
  return res
}

// An array as JSON.stringify's second argument filters keys RECURSIVELY, which would
// serialise the paths map as empty and compare nothing. Hence an explicit stable walk.
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  return `{${Object.keys(v)
    .sort()
    .map(k => `${JSON.stringify(k)}:${stable(v[k])}`)
    .join(',')}}`
}

const entries = []
for (let i = 0; i < packages; i++) {
  entries.push(join(root, 'packages', `pkg-${String(i).padStart(4, '0')}`, 'tsconfig.json'))
}

let compared = 0
let mismatches = 0
let pathKeysCompared = 0

for (let i = 0; i < entries.length; i++) {
  const entry = entries[i]
  const stock = loadTSConfig(entry, undefined)
  const target = process.env.MUTATE === '1' ? entries[(i + 1) % entries.length] : entry
  const cached = loadTSConfig(target, new Map())

  if (process.env.MUTATE === '2' && cached[0]?.options?.paths) {
    const first = Object.keys(cached[0].options.paths)[0]
    if (first) cached[0].options.paths[first] = ['MUTATED']
  }

  if (stock.length !== cached.length) {
    mismatches += 1
    console.log(`config count differs for ${entry}: ${stock.length} vs ${cached.length}`)
    continue
  }
  for (let k = 0; k < stock.length; k++) {
    compared += 1
    const a = stock[k]
    const b = cached[k]
    if (stable(a.options) !== stable(b.options)) {
      mismatches += 1
      if (mismatches <= 3) console.log(`options differ for ${a.options.configFilePath}`)
    }
    if (stable(a.projectReferences ?? null) !== stable(b.projectReferences ?? null)) {
      mismatches += 1
      console.log(`projectReferences differ for ${a.options.configFilePath}`)
    }
    if (stable(a.fileNames) !== stable(b.fileNames)) {
      mismatches += 1
      console.log(`fileNames differ for ${a.options.configFilePath}`)
    }
    if (a.options.paths) pathKeysCompared += Object.keys(a.options.paths).length
  }
}

console.log(
  JSON.stringify(
    {
      mutation: process.env.MUTATE ?? 'none',
      entryConfigs: entries.length,
      parsesCompared: compared,
      pathsEntriesCompared: pathKeysCompared,
      mismatches,
    },
    null,
    2,
  ),
)
