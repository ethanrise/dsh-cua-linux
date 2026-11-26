import { readFile } from 'node:fs/promises'

const version = process.argv[2]?.replace(/^v/, '')
if (!version) throw new Error('Pass the release version or tag.')

const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const sections = changelog.split(/^## /m).slice(1)
const section = sections.find((entry) => entry.split('\n', 1)[0].split(/\s+/)[0] === version)
const notes = section?.slice(section.indexOf('\n') + 1).trim().replace(/\n---$/, '').trimEnd()
if (!notes) throw new Error(`No release notes for ${version} in CHANGELOG.md.`)
process.stdout.write(notes + '\n')
