import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FILE_TOO_LARGE, NO_SKILL_MD, readSkillFolder, readUploadFile, SKILL_TOO_LARGE } from './resource-files'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cma-resource-files-'))
  dirs.push(dir)
  return dir
}
function cleanup(): void {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Un dossier de skill nommé `teach` dans un dossier temporaire ; `files` : chemin relatif -> contenu. */
function skillFolder(files: Record<string, string>): string {
  const folder = join(tempDir(), 'teach')
  mkdirSync(folder)
  for (const [relative, content] of Object.entries(files)) {
    const target = join(folder, relative)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  return folder
}

test('reads every file of a skill folder under its folder name, nested paths included', async () => {
  const folder = skillFolder({ 'SKILL.md': '# Teach\n', 'refs/note.md': 'a note\n' })
  const read = await readSkillFolder(`${folder}/`)
  expect(read.ok).toBe(true)
  if (!read.ok) return
  expect(read.label).toBe('teach')
  expect(read.files.map((file) => file.name).sort()).toEqual(['teach/SKILL.md', 'teach/refs/note.md'])
  const skill = read.files.find((file) => file.name === 'teach/SKILL.md')
  expect(await skill?.text()).toBe('# Teach\n')
  cleanup()
})

test('skips dot entries and symbolic links', async () => {
  const folder = skillFolder({ 'SKILL.md': '# Teach\n', '.DS_Store': 'junk', '.git/HEAD': 'ref: x\n' })
  symlinkSync(join(folder, 'SKILL.md'), join(folder, 'link.md'))
  const read = await readSkillFolder(folder)
  expect(read.ok).toBe(true)
  if (!read.ok) return
  expect(read.files.map((file) => file.name)).toEqual(['teach/SKILL.md'])
  cleanup()
})

test('refuses a folder without SKILL.md at its root, even with a nested one', async () => {
  const nested = skillFolder({ 'sub/SKILL.md': '# Nested\n' })
  expect(await readSkillFolder(nested)).toEqual({ ok: false, error: NO_SKILL_MD })
  const lower = skillFolder({ 'skill.md': '# Lower\n' })
  expect(await readSkillFolder(lower)).toEqual({ ok: false, error: NO_SKILL_MD })
  cleanup()
})

test('refuses a skill over the limit before reading it into memory', async () => {
  const folder = skillFolder({ 'SKILL.md': '12345678901' })
  expect(await readSkillFolder(folder, 10)).toEqual({ ok: false, error: SKILL_TOO_LARGE })
  expect((await readSkillFolder(folder, 11)).ok).toBe(true)
  cleanup()
})

test('reads a file under its base name and refuses one over the limit', async () => {
  const path = join(tempDir(), 'notes.md')
  writeFileSync(path, 'four')
  const read = await readUploadFile(path)
  expect(read.ok).toBe(true)
  if (!read.ok) return
  expect(read.label).toBe('notes.md')
  expect(read.files.map((file) => file.name)).toEqual(['notes.md'])
  expect(await read.files[0]?.text()).toBe('four')
  expect(await readUploadFile(path, 3)).toEqual({ ok: false, error: FILE_TOO_LARGE })
  cleanup()
})

test('a missing path or a directory given as a file says it cannot be read', async () => {
  const dir = tempDir()
  expect(await readSkillFolder(join(dir, 'absent'))).toEqual({ ok: false, error: 'Could not read absent.' })
  expect(await readUploadFile(join(dir, 'gone.md'))).toEqual({ ok: false, error: 'Could not read gone.md.' })
  expect(await readUploadFile(dir)).toEqual({ ok: false, error: `Could not read ${dir.split('/').pop()}.` })
  cleanup()
})
