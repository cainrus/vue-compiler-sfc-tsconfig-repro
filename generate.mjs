// Generates a workspace shaped like a real monorepo: N packages, each with its own
// tsconfig.json that `extends` one large shared base and declares `references` to its
// neighbours, plus one SFC per package whose props type is imported from ANOTHER package
// through a `paths` alias.
//
// Both properties of that import matter, and getting either wrong produces a
// reproduction that runs clean while measuring nothing:
//
//   * it has to be a TYPE import that compiler-sfc must follow -- `defineProps<T>()` with
//     `T` declared elsewhere. Runtime props never reach type resolution at all.
//   * it has to be NON-RELATIVE. `importSourceToScope` resolves `./x` and `../x` with its
//     own `resolveExt` fast path and only falls back to `resolveWithTS` if that fails, so
//     a fixture built from relative imports never parses a tsconfig.
//
// `measure-*.mjs` asserts the parse count is non-zero for exactly this reason.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const pkgName = i => `pkg-${String(i).padStart(4, '0')}`

export function generate({ root, packages, groupSize, pathEntries, componentsPerPackage = 1 }) {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })

  // The shared base every package extends. A real one carries a large `paths` map -- the
  // app this was found on has 1342 entries in a 118 KB base -- and the expanded map is
  // what the missing cache re-allocates on every parse.
  const paths = {}
  for (let i = 0; i < packages; i++) {
    paths[`@pkg/${pkgName(i)}`] = [`./packages/${pkgName(i)}/src/index.ts`]
  }
  // Padding so the base has the bulk a real one has; these are never imported.
  for (let i = 0; i < pathEntries; i++) {
    paths[`@generated/module-${i}`] = [`./generated/module-${i}/src/index.ts`]
    paths[`@generated/module-${i}/*`] = [`./generated/module-${i}/src/*`]
  }
  writeFileSync(
    join(root, 'tsconfig.base.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          skipLibCheck: true,
          baseUrl: '.',
          paths,
        },
      },
      null,
      2,
    ),
  )

  const files = []
  for (let i = 0; i < packages; i++) {
    const dir = join(root, 'packages', pkgName(i))
    mkdirSync(join(dir, 'src'), { recursive: true })

    // References inside a group only. A fully connected graph would make one entry walk
    // every package in the workspace -- not what a real repository looks like, and it
    // would drown the numbers in one pathological traversal.
    const group = Math.floor(i / groupSize)
    const first = group * groupSize
    const last = Math.min(first + groupSize, packages)
    const references = []
    for (let j = first; j < last; j++) {
      if (j !== i) references.push({ path: `../${pkgName(j)}` })
    }

    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify(
        {
          extends: '../../tsconfig.base.json',
          compilerOptions: { composite: true, rootDir: 'src', outDir: 'dist' },
          include: ['src/**/*.ts', 'src/**/*.vue'],
          references,
        },
        null,
        2,
      ),
    )

    writeFileSync(
      join(dir, 'src', 'props.ts'),
      `export interface Props {\n  id: string\n  index: number\n  label?: string\n}\n`,
    )
    writeFileSync(join(dir, 'src', 'index.ts'), `export type { Props } from './props'\n`)

    // Imports the type from the NEXT package by alias -- non-relative, so resolution goes
    // through `resolveWithTS` and therefore through `loadTSConfig`.
    const from = `@pkg/${pkgName((i + 1) % packages)}`
    const perPackage = []
    for (let c = 0; c < componentsPerPackage; c++) {
      const vue = join(dir, 'src', `Component${c}.vue`)
      writeFileSync(
        vue,
        `<script setup lang="ts">\nimport type { Props } from '${from}'\n\ndefineProps<Props>()\nconst which = ${c}\n</script>\n\n<template>\n  <div>{{ id }}{{ which }}</div>\n</template>\n`,
      )
      perPackage.push(vue)
    }
    files.push(perPackage)
  }

  // Grouped by package. Callers that want a flat list flatten it; the LRU measurement
  // needs the grouping to walk one component per package per round.
  return files
}
