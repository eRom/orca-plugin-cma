// Le choix d'un fichier ou d'un dossier par la boîte de dialogue native du système : `osascript` sous macOS,
// PowerShell (System.Windows.Forms) sous Windows, `zenity` puis `kdialog` sous Linux. Aucun autre processus n'est lancé.
// Sans outil de dialogue, la réponse est `picker_unavailable` : le panneau propose alors de coller un chemin.
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
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
  /** L'environnement qui dit si un affichage existe (Linux) et où est le dossier système (Windows) ; celui du worker par défaut. */
  env?: NodeJS.ProcessEnv
  /** Le dossier personnel, où s'ouvrent les boîtes Linux ; celui de l'utilisateur par défaut. */
  home?: string
  /** Vrai si le chemin existe et est un socket ; sert à chercher l'affichage Linux (par défaut le vrai système de fichiers). */
  isSocket?: (path: string) => Promise<boolean>
  /** Le journal du worker : l'échec d'un outil y est écrit (code de sortie, début de sa sortie d'erreur), jamais montré au panneau. */
  log?: (message: string) => void
}

const UNAVAILABLE: ApiResult<never> = { ok: false, code: 'picker_unavailable', error: 'No file dialog is available on this computer.' }
const COULD_NOT_OPEN: ApiResult<never> = { ok: false, code: 'other', error: 'Could not open the file picker.' }
const CANCELLED: ApiResult<null> = { ok: true, value: null }

/** La variable d'environnement qui porte l'invite vers PowerShell : elle n'est jamais écrite dans le script. */
const PROMPT_VARIABLE = 'PICK_PROMPT'

/**
 * Le script PowerShell, en guillemets simples seulement (aucun guillemet double : il voyage tel quel dans `-Command`) ;
 * l'invite y arrive par `$env:PICK_PROMPT`. Les lignes sont jointes par `; `.
 */
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

/**
 * Une ligne de commande par outil Linux, dans l'ordre d'essai ; le code 1 est l'annulation des deux. L'invite est
 * collée à son option (`--title=<invite>`) : une invite qui commence par un tiret n'est jamais lue comme une option.
 * La boîte s'ouvre dans le dossier personnel (`start` finit par `/`).
 */
function linuxTools(kind: 'file' | 'folder', prompt: string, start: string): { command: string; args: string[] }[] {
  return [
    { command: 'zenity', args: ['--file-selection', ...(kind === 'folder' ? ['--directory'] : []), `--filename=${start}`, `--title=${prompt}`] },
    { command: 'kdialog', args: [kind === 'folder' ? '--getexistingdirectory' : '--getopenfilename', start, `--title=${prompt}`] }
  ]
}

/** Le dossier système de Windows, où vit PowerShell : lancé par chemin absolu, jamais par recherche dans le PATH. */
const windowsPowerShell = (env: NodeJS.ProcessEnv): string =>
  win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** Combien de numéros d'affichage on essaie (`wayland-0` à `wayland-9`, `X0` à `X9`) : jamais un dossier n'est listé. */
const DISPLAY_NUMBERS = 10

/** Le premier numéro (le plus bas) dont `<dossier>/<prefix><n>` est un socket, ou null. */
async function lowestSocket(isSocket: (path: string) => Promise<boolean>, folder: string, prefix: string): Promise<number | null> {
  for (let n = 0; n < DISPLAY_NUMBERS; n++) {
    if (await isSocket(posix.join(folder, `${prefix}${n}`))) {
      return n
    }
  }
  return null
}

/**
 * L'affichage de la session quand le worker n'en reçoit pas (Orca ne lui donne ni DISPLAY ni WAYLAND_DISPLAY) :
 * d'abord un socket Wayland `wayland-<n>` dans `XDG_RUNTIME_DIR`, sinon le plus petit socket X11 `/tmp/.X11-unix/X<n>`
 * (`DISPLAY=:<n>` ; Xlib retrouve `~/.Xauthority` par `HOME`). Rend les seules variables à ajouter, vides si rien ne se trouve.
 */
async function discoverDisplay(env: NodeJS.ProcessEnv, isSocket: (path: string) => Promise<boolean>): Promise<Record<string, string>> {
  if (env.XDG_RUNTIME_DIR) {
    const wayland = await lowestSocket(isSocket, env.XDG_RUNTIME_DIR, 'wayland-')
    if (wayland !== null) {
      return { WAYLAND_DISPLAY: `wayland-${wayland}` }
    }
  }
  const x11 = await lowestSocket(isSocket, '/tmp/.X11-unix', 'X')
  return x11 === null ? {} : { DISPLAY: `:${x11}` }
}

const socketExists = (path: string): Promise<boolean> =>
  stat(path).then((entry) => entry.isSocket(), () => false)

/** Ce que dit un outil qui n'arrive pas à se connecter à l'affichage découvert : sortie 1 comme une annulation, mais ce n'en est pas une. */
const DISPLAY_REFUSED = /cannot open display|failed to open display|could not connect to display|cannot connect to display/i

/** Le début de la sortie d'erreur d'un outil, pour le journal seulement. */
const ERROR_OUTPUT_LOG_LIMIT = 200

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
  const env = deps.env ?? process.env
  const log = deps.log ?? (() => {})

  /** Un outil qui a tourné et échoué : le détail va au journal, le panneau ne reçoit que le message fixe. */
  const failed = (command: string, output: ToolOutput): ApiResult<never> => {
    log(`file picker: ${command} exited ${output.exitCode}: ${(output.stderr ?? '').trim().slice(0, ERROR_OUTPUT_LOG_LIMIT)}`)
    return COULD_NOT_OPEN
  }

  const pickOnMac = async (): Promise<ApiResult<PickedFile | null>> => {
    // L'invite est le dernier argument, après `--` (une invite qui commence par un tiret n'est pas une option) et
    // lue par `item 1 of argv` : elle n'entre jamais dans le texte AppleScript.
    const output = await run('osascript', ['-e', 'on run argv', '-e', `POSIX path of (choose ${kind} with prompt (item 1 of argv))`, '-e', 'end run', '--', prompt])
    if (output.exitCode === 0) {
      return chosen(platform, output.stdout)
    }
    // Annuler la boîte : `User canceled. (-128)` sur la sortie d'erreur.
    return output.stderr?.includes('-128') ? CANCELLED : failed('osascript', output)
  }

  const pickOnWindows = async (): Promise<ApiResult<PickedFile | null>> => {
    const script = WINDOWS_SCRIPTS[kind].join('; ')
    const command = windowsPowerShell(env)
    const output = await run(command, ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { env: { [PROMPT_VARIABLE]: prompt } })
    // Annuler la boîte : rien n'est écrit, sortie 0.
    return output.exitCode === 0 ? chosen(platform, output.stdout) : failed('powershell', output)
  }

  const pickOnLinux = async (): Promise<ApiResult<PickedFile | null>> => {
    const home = deps.home ?? homedir()
    // Orca ne donne pas DISPLAY au worker : on cherche l'affichage de la session, pour le seul outil lancé.
    const hasDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
    const discovered = hasDisplay ? {} : await discoverDisplay(env, deps.isSocket ?? socketExists)
    // Sans affichage aucune boîte ne peut s'ouvrir, et zenity sortirait en 1 comme pour une annulation : le panneau passe à la saisie du chemin.
    if (!hasDisplay && Object.keys(discovered).length === 0) {
      return UNAVAILABLE
    }
    const toolOptions = Object.keys(discovered).length === 0 ? undefined : { env: discovered }
    const start = home.endsWith('/') ? home : `${home}/`
    for (const { command, args } of linuxTools(kind, prompt, start)) {
      let output: ToolOutput
      try {
        output = await run(command, args, toolOptions)
      } catch (error) {
        if (isMissing(error)) {
          continue
        }
        throw error
      }
      if (output.exitCode === 0) {
        return chosen(platform, output.stdout)
      }
      if (output.exitCode !== 1) {
        return failed(command, output)
      }
      // Sortie 1 : l'annulation, sauf si l'affichage découvert n'a pas pu être ouvert (socket resté d'une session morte).
      if (!hasDisplay && DISPLAY_REFUSED.test(output.stderr ?? '')) {
        log(`file picker: ${command} could not open the discovered display: ${(output.stderr ?? '').trim().slice(0, ERROR_OUTPUT_LOG_LIMIT)}`)
        return UNAVAILABLE
      }
      return CANCELLED
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
      if (isMissing(error)) {
        return UNAVAILABLE
      }
      log(`file picker: could not start the dialog tool: ${error instanceof Error ? error.message : String(error)}`)
      return COULD_NOT_OPEN
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
