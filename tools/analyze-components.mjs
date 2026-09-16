/**
 * Component analysis for the source illustrations.
 *
 * Answers a question the raw metadata cannot: does this file contain ONE
 * figure or a sheet of several? Each connected opaque region is listed with its
 * bounding box and rendered as ASCII, so a multi-figure source can be sliced
 * into separate pet sprites without ever seeing the file.
 *
 * Usage: node tools/analyze-components.mjs "<file.png>" [--min-area 400] [--top 8]
 */

import { readFileSync } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asciiComponent, decodePng, isolateSubject, labelComponents } from './lib/png.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node tools/analyze-components.mjs <file.png> [--min-area N] [--top N] [--step N] [--seed N]')
  process.exit(2)
}
const argOf = (flag, fallback) => {
  const at = process.argv.indexOf(flag)
  return at === -1 ? fallback : Number(process.argv[at + 1])
}
const minArea = argOf('--min-area', 1500)
const top = argOf('--top', 8)

const image = decodePng(readFileSync(join(root, file)))
console.log(`FILE     ${basename(file)}   ${image.width} x ${image.height}`)
const { backgroundShare } = isolateSubject(image.rgba, image.width, image.height, {
  stepTolerance: argOf('--step', 30),
  seedTolerance: argOf('--seed', 118),
})
console.log(`ISOLATED background removed ${(backgroundShare * 100).toFixed(1)}%`)

const components = labelComponents(image.rgba, image.width, image.height, minArea)
console.log(`FOUND    ${components.length} region(s) above ${minArea}px  (showing top ${top})\n`)

for (const component of components.slice(0, top)) {
  const pctW = (component.width / image.width * 100).toFixed(1)
  const pctH = (component.height / image.height * 100).toFixed(1)
  console.log(`#${component.rank}  area ${component.count}px  bbox x ${component.minX}..${component.maxX} y ${component.minY}..${component.maxY}`)
  console.log(`    size ${component.width} x ${component.height}  (${pctW}% x ${pctH}% of canvas)  aspect ${(component.width / component.height).toFixed(3)}`)
  console.log(asciiComponent(image.rgba, image.width, component, 44))
  console.log('')
}
