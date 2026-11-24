// Le choix d'un fichier ou d'un dossier par la boîte de dialogue native du système : `osascript` sous macOS,
// PowerShell (System.Windows.Forms) sous Windows, `zenity` puis `kdialog` sous Linux. Aucun autre processus n'est lancé.
// Sans outil de dialogue, la réponse est `picker_unavailable` : le panneau propose alors de coller un chemin.
import { execFile } from 'node:child_process'
import { posix, win32 } from 'node:path'
import type { ApiResult, PickedFile } from '../protocol'

/** Ce que rend un outil lancé : sa sortie standard, son code de sortie et (macOS) sa sortie d'erreur. */
export type ToolOutput = { stdout: string; exitCode: number; stderr?: string }

/**
 * Lance `command` et rend sa sortie, même quand il sort en erreur (le code est dans `exitCode`, ce n'est pas un rejet).
 * Rejette seulement quand la commande ne peut pas être lancée, avec `code: 'ENOENT'` quand elle n'existe pas.
 * `options.env` s'ajoute à l'environnement du worker.
 */
export type RunTool = (command: string, args: string[], options?: { env?: Record<string, string> }) => Promise<ToolOutput>

export type NativePickerDeps = {
  platform: NodeJS.Platform
  run: RunTool
  /** L'environnement qui dit si un affichage existe (Linux) ; celui du worker par défaut. */
  env?: NodeJS.ProcessEnv
}

const UNAVAILABLE: ApiResult<never> = { ok: false, code: 'picker_unavailable', error: 'No file dialog is available on this computer.' }
const COULD_NOT_OPEN: ApiResult<never> = { ok: false, code: 'other', error: 'Could not open the file picker.' }
const CANCELLED: ApiResult<null> = { ok: true, value: null }

/** La variable d'environnement qui porte l'invite vers PowerShell : elle n'est jamais écrite dans le script. */
const PROMPT_VARIABLE = 'PICK_PROMPT'

/** Le script PowerShell, en guillemets simples seulement ; l'invite y arrive par `$env:PICK_PROMPT`. */
const WINDOWS_SCRIPTS = {
  file: [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    `$dialog.Title = $env:${PROMPT_VARIABLE}`,
    "if ($dialog.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($dialog.FileName) }"
  ],
  folder: [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = $env:${PROMPT_VARIABLE}`,
    "if ($dialog.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($dialog.SelectedPath) }"
  ]
} as const

/** Le chemin choisi tel que l'outil l'a écrit, sans le saut de ligne final (les espaces de fin d'un nom restent). */
function chosen(platform: NodeJS.Platform, stdout: string): ApiResult<PickedFile | null> {
  const file = stdout.replace(/\r?\n$/, '')
  if (file === '') {
    return CANCELLED
  }
  return { ok: true, value: { file, name: (platform === 'win32' ? win32 : posix).basename(file) } }
}

const isMissing = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'

/** Une ligne de commande par outil Linux, dans l'ordre d'essai ; le code 1 est l'annulation des deux. */
function linuxTools(kind: 'file' | 'folder', prompt: string): { command: string; args: string[] }[] {
  return [
    { command: 'zenity', args: ['--file-selection', ...(kind === 'folder' ? ['--directory'] : []), `--title=${prompt}`] },
    { command: 'kdialog', args: [kind === 'folder' ? '--getexistingdirectory' : '--getopenfilename', '.', '--title', prompt] }
  ]
}

/**
 * Le choix d'un fichier ou d'un dossier. Annuler la boîte rend `null` sans message ; un outil absent rend
 * `picker_unavailable` ; tout autre échec rend « Could not open the file picker. » (le message de l'outil n'est jamais montré).
 * Une seule boîte à la fois : tant qu'elle est ouverte, un nouvel appel rejoint la même promesse (il reçoit la même
 * réponse). Sans cela, un appui après le délai du panneau empilerait une seconde boîte et la réponse de la première serait perdue.
 */
export function createNativePicker(
  deps: NativePickerDeps,
  options: { kind: 'file' | 'folder'; prompt: string }
): () => Promise<ApiResult<PickedFile | null>> {
  const { platform, run } = deps
  const { kind, prompt } = options

  const pickOnMac = async (): Promise<ApiResult<PickedFile | null>> => {
    // L'invite est le dernier argument, lu par `item 1 of argv` : elle n'entre jamais dans le texte AppleScript.
    const output = await run('osascript', ['-e', 'on run argv', '-e', `POSIX path of (choose ${kind} with prompt (item 1 of argv))`, '-e', 'end run', prompt])
    if (output.exitCode === 0) {
      return chosen(platform, output.stdout)
    }
    // Annuler la boîte : `User canceled. (-128)` sur la sortie d'erreur.
    return output.stderr?.includes('-128') ? CANCELLED : COULD_NOT_OPEN
  }

  const pickOnWindows = async (): Promise<ApiResult<PickedFile | null>> => {
    const script = Buffer.from(WINDOWS_SCRIPTS[kind].join('\n'), 'utf16le').toString('base64')
    const output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', script], { env: { [PROMPT_VARIABLE]: prompt } })
    // Annuler la boîte : rien n'est écrit, sortie 0.
    return output.exitCode === 0 ? chosen(platform, output.stdout) : COULD_NOT_OPEN
  }

  const pickOnLinux = async (): Promise<ApiResult<PickedFile | null>> => {
    // Sans affichage, zenity sort aussi en 1 : ce serait pris pour une annulation, donc aucun outil n'est lancé.
    const env = deps.env ?? process.env
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
      return COULD_NOT_OPEN
    }
    for (const { command, args } of linuxTools(kind, prompt)) {
      let output: ToolOutput
      try {
        output = await run(command, args)
      } catch (error) {
        if (isMissing(error)) {
          continue
        }
        throw error
      }
      if (output.exitCode === 0) {
        return chosen(platform, output.stdout)
      }
      return output.exitCode === 1 ? CANCELLED : COULD_NOT_OPEN
    }
    return UNAVAILABLE
  }

  const pickOnce = async (): Promise<ApiResult<PickedFile | null>> => {
    try {
      switch (platform) {
        case 'darwin':
          return await pickOnMac()
        case 'win32':
          return await pickOnWindows()
        case 'linux':
          return await pickOnLinux()
        default:
          return UNAVAILABLE
      }
    } catch (error) {
      return isMissing(error) ? UNAVAILABLE : COULD_NOT_OPEN
    }
  }

  let inFlight: Promise<ApiResult<PickedFile | null>> | null = null
  return async () => {
    if (inFlight === null) {
      // `pickOnce` ne rejette jamais : la boîte fermée (choix, annulation ou échec), l'appel suivant en ouvre une autre.
      inFlight = pickOnce().finally(() => {
        inFlight = null
      })
    }
    return inFlight
  }
}

/** L'exécution réelle, par `execFile` (sans shell : rien n'est interprété). Les tests injectent la leur, aucun n'ouvre de vraie boîte. */
export const runTool: RunTool = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { encoding: 'utf8', windowsHide: false, env: { ...process.env, ...options?.env } },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, exitCode: 0, stderr })
        } else if (typeof (error as { code?: unknown }).code === 'number') {
          // Sortie non nulle : l'outil a tourné, c'est à l'appelant de lire le code.
          resolve({ stdout, exitCode: (error as { code: number }).code, stderr })
        } else {
          reject(error)
        }
      }
    )
    // Un outil qui lit son entrée standard (PowerShell) ne doit pas attendre un tuyau resté ouvert.
    child.stdin?.end()
  })
