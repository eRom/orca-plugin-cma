// Lecture, côté worker, de ce que le panneau envoie à l'API : un dossier de skill ou un fichier.
// Le panneau ne passe qu'un chemin ; le contenu ne traverse jamais le pont, il est lu ici.
import { toFile } from '@anthropic-ai/sdk'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { FILE_MAX_BYTES, SKILL_MAX_BYTES } from '../protocol'

/** `files` sont prêts pour le SDK ; `label` est le nom de base, repris dans les messages. */
export type ReadUploads = { ok: true; files: File[]; label: string } | { ok: false; error: string }

export const NO_SKILL_MD = 'This folder has no SKILL.md at its root.'
export const SKILL_TOO_LARGE = 'Skills over 30 MB cannot be uploaded.'
export const FILE_TOO_LARGE = 'Files over 100 MB cannot be uploaded from Orca.'

const unreadable = (label: string): ReadUploads => ({ ok: false, error: `Could not read ${label}.` })

type Entry = { absolute: string; name: string; size: number }

/** Les fichiers réguliers sous `dir`, sans les entrées en point ni les liens symboliques ; tailles par `lstat`, contenu non lu. */
async function walk(root: string, dir: string, found: Entry[]): Promise<void> {
  for (const name of await readdir(dir)) {
    if (name.startsWith('.')) {
      continue
    }
    const absolute = join(dir, name)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) {
      continue
    }
    if (info.isDirectory()) {
      await walk(root, absolute, found)
    } else if (info.isFile()) {
      found.push({ absolute, name: relative(root, absolute).split(sep).join('/'), size: info.size })
    }
  }
}

/**
 * Lit un dossier de skill : chaque fichier est envoyé sous `<dossier>/<chemin relatif>`. `SKILL.md` doit être à la
 * racine, jugé sur les noms que `readdir` rend et jamais par un `stat` : APFS ignore la casse, un `stat('SKILL.md')`
 * réussirait sur `skill.md`. La taille totale est sommée avant toute lecture de contenu.
 */
export async function readSkillFolder(folder: string, maxBytes: number = SKILL_MAX_BYTES): Promise<ReadUploads> {
  const label = basename(folder)
  try {
    const rootNames = await readdir(folder)
    if (!rootNames.includes('SKILL.md')) {
      return { ok: false, error: NO_SKILL_MD }
    }
    const found: Entry[] = []
    await walk(folder, folder, found)
    if (found.reduce((total, entry) => total + entry.size, 0) > maxBytes) {
      return { ok: false, error: SKILL_TOO_LARGE }
    }
    const files: File[] = []
    for (const entry of found) {
      files.push(await toFile(await readFile(entry.absolute), `${label}/${entry.name}`))
    }
    return { ok: true, files, label }
  } catch {
    return unreadable(label)
  }
}

/** Lit un fichier régulier sous son nom de base ; plus gros que `maxBytes`, il n'est pas lu. */
export async function readUploadFile(file: string, maxBytes: number = FILE_MAX_BYTES): Promise<ReadUploads> {
  const label = basename(file)
  try {
    const info = await stat(file)
    if (!info.isFile()) {
      return unreadable(label)
    }
    if (info.size > maxBytes) {
      return { ok: false, error: FILE_TOO_LARGE }
    }
    return { ok: true, files: [await toFile(await readFile(file), label)], label }
  } catch {
    return unreadable(label)
  }
}
