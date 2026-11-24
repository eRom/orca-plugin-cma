// Aucun de ces tests n'ouvre une vraie boîte de dialogue : `run` est toujours simulé (sauf les trois derniers,
// qui lancent le runtime courant sur un script sans fenêtre pour prouver `runTool`).
import { expect, test } from 'bun:test'
import { win32 } from 'node:path'
import { createNativePicker, runTool, type RunTool } from './native-picker'

/**
 * PowerShell est lancé par chemin absolu sous le dossier système, jamais par recherche dans le PATH. Chaque test
 * injecte son `env` : sans `SystemRoot` le chemin est celui-ci, quel que soit l'hôte qui exécute la suite.
 */
const POWERSHELL = win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

type Call = { command: string; args: string[]; env?: Record<string, string> }
type Answer = { stdout?: string; exitCode?: number; stderr?: string } | Error

/** Un `run` simulé : chaque commande a sa réponse, une commande inconnue est absente (ENOENT). */
function fakeRun(answers: Record<string, Answer>): { run: RunTool; calls: Call[] } {
  const calls: Call[] = []
  const run: RunTool = async (command, args, options) => {
    calls.push({ command, args, ...(options?.env && { env: options.env }) })
    const answer = answers[command]
    if (answer === undefined) {
      throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' })
    }
    if (answer instanceof Error) {
      throw answer
    }
    return { stdout: answer.stdout ?? '', exitCode: answer.exitCode ?? 0, ...(answer.stderr !== undefined && { stderr: answer.stderr }) }
  }
  return { run, calls }
}

const DISPLAY = { DISPLAY: ':0' }
const HOME = '/home/r'
const PROMPT = 'Choose a file to upload'
const CANCELLED = { ok: true, value: null }
const UNAVAILABLE = { ok: false, code: 'picker_unavailable', error: 'No file dialog is available on this computer.' }
const COULD_NOT_OPEN = { ok: false, code: 'other', error: 'Could not open the file picker.' }

/** Le script PowerShell passé à `-Command`. */
const decodeScript = (args: string[]): string => args[args.indexOf('-Command') + 1] ?? ''

test('darwin uses osascript and maps -128 to cancel', async () => {
  const chosen = fakeRun({ osascript: { stdout: '/Users/test/Documents/notes today.md\n' } })
  const pick = createNativePicker({ platform: 'darwin', run: chosen.run }, { kind: 'file', prompt: PROMPT })
  expect(await pick()).toEqual({ ok: true, value: { file: '/Users/test/Documents/notes today.md', name: 'notes today.md' } })
  expect(chosen.calls.length).toBe(1)
  expect(chosen.calls[0]?.command).toBe('osascript')
  expect(chosen.calls[0]?.args.join(' ')).toContain('choose file')

  const cancelled = fakeRun({ osascript: { exitCode: 1, stderr: '0:49: execution error: User canceled. (-128)' } })
  expect(await createNativePicker({ platform: 'darwin', run: cancelled.run }, { kind: 'file', prompt: PROMPT })()).toEqual(CANCELLED)
})

test('win32 runs powershell with the prompt in the environment and returns the path', async () => {
  const { run, calls } = fakeRun({ [POWERSHELL]: { stdout: 'C:\\Users\\romain\\Mes documents\\notes.md' } })
  const pick = createNativePicker({ platform: 'win32', run, env: {} }, { kind: 'file', prompt: PROMPT })
  expect(await pick()).toEqual({ ok: true, value: { file: 'C:\\Users\\romain\\Mes documents\\notes.md', name: 'notes.md' } })
  expect(calls.length).toBe(1)
  expect(calls[0]?.env).toEqual({ PICK_PROMPT: PROMPT })
  const script = decodeScript(calls[0]?.args ?? [])
  expect(script.includes('$env:PICK_PROMPT')).toBe(true)
  expect(script.includes('OpenFileDialog')).toBe(true)
  expect(script.includes('UTF8')).toBe(true)
  // Le script voyage en clair dans `-Command` (pas de base64) et sans guillemet double, que Windows doublerait en ligne de commande.
  expect(calls[0]?.args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-STA', '-Command'])
  expect(calls[0]?.args.length).toBe(5)
  expect(script.includes('"')).toBe(false)
  expect(script.includes('\n')).toBe(false)
  expect(script.startsWith('[Console]::OutputEncoding')).toBe(true)
})

test('both PowerShell scripts carry no double quote and no line break', async () => {
  for (const kind of ['file', 'folder'] as const) {
    const { run, calls } = fakeRun({ [POWERSHELL]: { stdout: '' } })
    await createNativePicker({ platform: 'win32', run, env: {} }, { kind, prompt: PROMPT })()
    const script = decodeScript(calls[0]?.args ?? [])
    expect({ kind, quote: script.includes('"'), newline: /[\r\n]/.test(script) }).toEqual({ kind, quote: false, newline: false })
  }
})

test('win32 empty output is a cancel', async () => {
  const { run } = fakeRun({ [POWERSHELL]: { stdout: '' } })
  expect(await createNativePicker({ platform: 'win32', run, env: {} }, { kind: 'file', prompt: PROMPT })()).toEqual(CANCELLED)
})

test('linux uses zenity, exit 1 is a cancel', async () => {
  const chosen = fakeRun({ zenity: { stdout: '/home/r/Été/x.md\n' } })
  const pick = createNativePicker({ platform: 'linux', run: chosen.run, env: DISPLAY, home: HOME }, { kind: 'file', prompt: PROMPT })
  expect(await pick()).toEqual({ ok: true, value: { file: '/home/r/Été/x.md', name: 'x.md' } })
  expect(chosen.calls).toEqual([{ command: 'zenity', args: ['--file-selection', '--filename=/home/r/', `--title=${PROMPT}`] }])

  const cancelled = fakeRun({ zenity: { exitCode: 1 } })
  expect(await createNativePicker({ platform: 'linux', run: cancelled.run, env: DISPLAY, home: HOME }, { kind: 'file', prompt: PROMPT })()).toEqual(CANCELLED)
})

test('linux falls back to kdialog when zenity is missing', async () => {
  const chosen = fakeRun({ kdialog: { stdout: '/home/r/x.md\n' } })
  const pick = createNativePicker({ platform: 'linux', run: chosen.run, env: DISPLAY, home: HOME }, { kind: 'file', prompt: PROMPT })
  expect(await pick()).toEqual({ ok: true, value: { file: '/home/r/x.md', name: 'x.md' } })
  expect(chosen.calls.map((call) => call.command)).toEqual(['zenity', 'kdialog'])
  expect(chosen.calls[1]?.args).toEqual(['--getopenfilename', '/home/r/', `--title=${PROMPT}`])

  const cancelled = fakeRun({ kdialog: { exitCode: 1 } })
  expect(await createNativePicker({ platform: 'linux', run: cancelled.run, env: DISPLAY, home: HOME }, { kind: 'file', prompt: PROMPT })()).toEqual(CANCELLED)
})

test('linux without zenity nor kdialog answers picker_unavailable', async () => {
  const { run, calls } = fakeRun({})
  const answer = await createNativePicker({ platform: 'linux', run, env: DISPLAY, home: HOME }, { kind: 'file', prompt: PROMPT })()
  expect(answer.ok).toBe(false)
  expect(answer).toEqual({ ok: false, code: 'picker_unavailable', error: 'No file dialog is available on this computer.' })
  expect(calls.map((call) => call.command)).toEqual(['zenity', 'kdialog'])
})

test('an unknown platform answers picker_unavailable without running anything', async () => {
  const { run, calls } = fakeRun({ osascript: { stdout: '/x' } })
  const answer = await createNativePicker({ platform: 'freebsd', run }, { kind: 'file', prompt: PROMPT })()
  expect(answer).toEqual({ ok: false, code: 'picker_unavailable', error: 'No file dialog is available on this computer.' })
  expect(calls).toEqual([])
})

test('a folder pick passes the folder flag to each tool', async () => {
  const mac = fakeRun({ osascript: { stdout: '/Users/x/skills/teach/\n' } })
  const folder = { kind: 'folder', prompt: 'Choose a skill folder (it must contain SKILL.md)' } as const
  expect(await createNativePicker({ platform: 'darwin', run: mac.run }, folder)()).toEqual({ ok: true, value: { file: '/Users/x/skills/teach/', name: 'teach' } })
  expect(mac.calls[0]?.args.join(' ')).toContain('choose folder')

  const win = fakeRun({ [POWERSHELL]: { stdout: 'C:\\skills\\teach' } })
  expect(await createNativePicker({ platform: 'win32', run: win.run, env: {} }, folder)()).toEqual({ ok: true, value: { file: 'C:\\skills\\teach', name: 'teach' } })
  expect(decodeScript(win.calls[0]?.args ?? [])).toContain('FolderBrowserDialog')

  const zenity = fakeRun({ zenity: { stdout: '/home/r/skills/teach\n' } })
  expect(await createNativePicker({ platform: 'linux', run: zenity.run, env: DISPLAY, home: HOME }, folder)()).toEqual({ ok: true, value: { file: '/home/r/skills/teach', name: 'teach' } })
  expect(zenity.calls[0]?.args).toEqual(['--file-selection', '--directory', '--filename=/home/r/', `--title=${folder.prompt}`])

  const kdialog = fakeRun({ kdialog: { stdout: '/home/r/skills/teach\n' } })
  await createNativePicker({ platform: 'linux', run: kdialog.run, env: DISPLAY, home: HOME }, folder)()
  expect(kdialog.calls[1]?.args).toEqual(['--getexistingdirectory', '/home/r/', `--title=${folder.prompt}`])
})

test('a path with spaces, accents and a quote comes back intact', async () => {
  const unix = "/home/r/Été/l'été notes .md"
  const linux = fakeRun({ zenity: { stdout: `${unix}\n` } })
  expect(await createNativePicker({ platform: 'linux', run: linux.run, env: DISPLAY, home: HOME }, { kind: 'file', prompt: PROMPT })()).toEqual({
    ok: true,
    value: { file: unix, name: "l'été notes .md" }
  })
  const windows = "C:\\Users\\romain\\Mes documents\\l'été.md"
  const win = fakeRun({ [POWERSHELL]: { stdout: windows } })
  expect(await createNativePicker({ platform: 'win32', run: win.run, env: {} }, { kind: 'file', prompt: PROMPT })()).toEqual({
    ok: true,
    value: { file: windows, name: "l'été.md" }
  })
  // Seul le saut de ligne final est retiré : les espaces de fin du nom restent, comme un CRLF s'en va entièrement.
  const mac = fakeRun({ osascript: { stdout: '/Users/test/notes .md \r\n' } })
  expect(await createNativePicker({ platform: 'darwin', run: mac.run }, { kind: 'file', prompt: PROMPT })()).toEqual({
    ok: true,
    value: { file: '/Users/test/notes .md ', name: 'notes .md ' }
  })
})

test('prompt with quotes is passed safely', async () => {
  const prompt = `It's "quoted" \`n $(Get-Date) \\ end`
  const mac = fakeRun({ osascript: { stdout: '/x.md\n' } })
  await createNativePicker({ platform: 'darwin', run: mac.run }, { kind: 'file', prompt })()
  const macArgs = mac.calls[0]?.args ?? []
  // L'invite voyage comme dernier argument, jamais dans le texte de l'AppleScript.
  expect(macArgs[macArgs.length - 1]).toBe(prompt)
  expect(macArgs.slice(0, -1).some((arg) => arg.includes('quoted'))).toBe(false)

  const win = fakeRun({ [POWERSHELL]: { stdout: 'C:\\x.md' } })
  await createNativePicker({ platform: 'win32', run: win.run, env: {} }, { kind: 'file', prompt })()
  expect(win.calls[0]?.env).toEqual({ PICK_PROMPT: prompt })
  expect((win.calls[0]?.args ?? []).some((arg) => arg.includes('quoted'))).toBe(false)
  expect(decodeScript(win.calls[0]?.args ?? []).includes('quoted')).toBe(false)

  const linux = fakeRun({ zenity: { stdout: '/x.md\n' } })
  await createNativePicker({ platform: 'linux', run: linux.run, env: DISPLAY, home: HOME }, { kind: 'file', prompt })()
  expect(linux.calls[0]?.args).toEqual(['--file-selection', '--filename=/home/r/', `--title=${prompt}`])
})

test('a dialog tool that fails says it could not open', async () => {
  const cases: { platform: NodeJS.Platform; answers: Record<string, Answer> }[] = [
    { platform: 'darwin', answers: { osascript: { exitCode: 1, stderr: 'execution error: Not authorized to send Apple events. (-1743)' } } },
    { platform: 'win32', answers: { [POWERSHELL]: { exitCode: 1, stderr: 'Exception: ShowDialog' } } },
    { platform: 'linux', answers: { zenity: { exitCode: 5, stderr: 'Gtk-WARNING **: cannot open display' } } },
    { platform: 'linux', answers: { zenity: new Error('spawn zenity EACCES') } },
    { platform: 'linux', answers: { kdialog: { exitCode: 2 } } }
  ]
  for (const entry of cases) {
    const { run } = fakeRun(entry.answers)
    const answer = await createNativePicker({ platform: entry.platform, run, env: DISPLAY, home: HOME }, { kind: 'file', prompt: PROMPT })()
    expect({ platform: entry.platform, answer }).toEqual({ platform: entry.platform, answer: COULD_NOT_OPEN })
    // Le message de l'outil n'est jamais montré brut.
    expect(JSON.stringify(answer).includes('Gtk')).toBe(false)
  }
})

/** Un faux système de fichiers : seuls les chemins donnés sont des sockets, le reste n'existe pas. Les chemins sondés sont notés. */
function fakeSockets(sockets: string[] = []): { isSocket: (path: string) => Promise<boolean>; probed: string[] } {
  const probed: string[] = []
  return {
    isSocket: async (path) => {
      probed.push(path)
      return sockets.includes(path)
    },
    probed
  }
}

const LINUX = { platform: 'linux', home: HOME } as const
const FILE = { kind: 'file', prompt: PROMPT } as const

test('linux without any display answers picker_unavailable, with or without a tool, and runs no tool', async () => {
  const withTool = fakeRun({ zenity: { exitCode: 1 } })
  expect(await createNativePicker({ ...LINUX, run: withTool.run, env: {}, ...fakeSockets() }, FILE)()).toEqual(UNAVAILABLE)
  const noTool = fakeRun({})
  expect(await createNativePicker({ ...LINUX, run: noTool.run, env: {}, ...fakeSockets() }, FILE)()).toEqual(UNAVAILABLE)
  expect([...withTool.calls, ...noTool.calls]).toEqual([])
  const wayland = fakeRun({ zenity: { stdout: '/x.md\n' } })
  expect((await createNativePicker({ ...LINUX, run: wayland.run, env: { WAYLAND_DISPLAY: 'wayland-0' } }, FILE)()).ok).toBe(true)
})

test('linux without any display socket answers picker_unavailable', async () => {
  // Une entrée de même nom qui n'est pas un socket (un fichier, un `.lock`) n'en est pas un : `isSocket` dit non, rien à trouver.
  const files = fakeSockets(['/run/user/1000/wayland-0.lock', '/tmp/.X11-unix/X0.lock', '/tmp/.X11-unix/X10'])
  const { run, calls } = fakeRun({ zenity: { stdout: '/x.md\n' } })
  expect(await createNativePicker({ ...LINUX, run, env: { XDG_RUNTIME_DIR: '/run/user/1000' }, ...files }, FILE)()).toEqual(UNAVAILABLE)
  expect(calls).toEqual([])
  // Seuls les numéros 0 à 9 sont sondés, jamais un dossier listé.
  expect(files.probed.length).toBe(20)
  expect(files.probed[0]).toBe('/run/user/1000/wayland-0')
  expect(files.probed.includes('/tmp/.X11-unix/X10')).toBe(false)
})

test('linux discovers the lowest X11 display when DISPLAY is missing, and adds nothing but DISPLAY', async () => {
  const files = fakeSockets(['/tmp/.X11-unix/X1', '/tmp/.X11-unix/X0'])
  const { run, calls } = fakeRun({ zenity: { stdout: '/home/r/x.md\n' } })
  const answer = await createNativePicker({ ...LINUX, run, env: { PATH: '/usr/bin' }, ...files }, FILE)()
  expect(answer).toEqual({ ok: true, value: { file: '/home/r/x.md', name: 'x.md' } })
  // Pas de XAUTHORITY : Xlib retrouve `$HOME/.Xauthority` seul, Orca passe HOME.
  expect(calls[0]?.env).toEqual({ DISPLAY: ':0' })

  const higher = fakeRun({ zenity: { stdout: '/x.md\n' } })
  await createNativePicker({ ...LINUX, run: higher.run, env: {}, ...fakeSockets(['/tmp/.X11-unix/X3', '/tmp/.X11-unix/X9']) }, FILE)()
  expect(higher.calls[0]?.env).toEqual({ DISPLAY: ':3' })
})

test('linux prefers a wayland socket from XDG_RUNTIME_DIR', async () => {
  const files = fakeSockets(['/run/user/1000/wayland-1', '/run/user/1000/wayland-0', '/tmp/.X11-unix/X0'])
  const { run, calls } = fakeRun({ zenity: { stdout: '/x.md\n' }, kdialog: { stdout: '/x.md\n' } })
  await createNativePicker({ ...LINUX, run, env: { XDG_RUNTIME_DIR: '/run/user/1000' }, ...files }, FILE)()
  expect(calls[0]?.env).toEqual({ WAYLAND_DISPLAY: 'wayland-0' })

  // Le même environnement sert à chaque outil essayé (zenity absent, kdialog trouvé).
  const fallback = fakeRun({ kdialog: { stdout: '/x.md\n' } })
  await createNativePicker({ ...LINUX, run: fallback.run, env: { XDG_RUNTIME_DIR: '/run/user/1000' }, ...files }, FILE)()
  expect(fallback.calls.map((call) => call.env)).toEqual([{ WAYLAND_DISPLAY: 'wayland-0' }, { WAYLAND_DISPLAY: 'wayland-0' }])
})

test('a DISPLAY already in the environment wins and nothing is probed or added', async () => {
  const files = fakeSockets(['/tmp/.X11-unix/X7'])
  const { run, calls } = fakeRun({ zenity: { stdout: '/x.md\n' } })
  await createNativePicker({ ...LINUX, run, env: DISPLAY, ...files }, FILE)()
  expect(calls[0]?.env).toBe(undefined)
  expect(files.probed).toEqual([])
})

test('discovering a display never changes the process environment', async () => {
  const before = JSON.stringify(process.env)
  const { run } = fakeRun({ zenity: { stdout: '/x.md\n' } })
  await createNativePicker({ ...LINUX, run, env: {}, ...fakeSockets(['/tmp/.X11-unix/X0']) }, FILE)()
  expect(JSON.stringify(process.env)).toBe(before)
})

test('a discovered display that cannot be opened answers picker_unavailable', async () => {
  const files = fakeSockets(['/tmp/.X11-unix/X0'])
  const stale = ['Gtk-WARNING **: cannot open display: :0', 'kdialog: Could not connect to display :0', 'Failed to open display', 'cannot connect to display :0']
  for (const stderr of stale) {
    const logs: string[] = []
    const { run } = fakeRun({ zenity: { exitCode: 1, stderr } })
    const answer = await createNativePicker({ ...LINUX, run, env: {}, ...files, log: (message) => logs.push(message) }, FILE)()
    expect({ stderr, answer }).toEqual({ stderr, answer: UNAVAILABLE })
    expect(logs.length).toBe(1)
    expect(logs[0]).toContain('discovered display')
  }
  // Un vrai refus d'ouvrir sur un affichage donné par l'environnement reste une annulation : seul l'affichage découvert est suspect.
  const given = fakeRun({ zenity: { exitCode: 1, stderr: 'cannot open display' } })
  expect(await createNativePicker({ ...LINUX, run: given.run, env: DISPLAY }, FILE)()).toEqual(CANCELLED)
  // Une annulation sans ce message, sur l'affichage découvert, reste une annulation.
  const cancelled = fakeRun({ zenity: { exitCode: 1, stderr: '' } })
  expect(await createNativePicker({ ...LINUX, run: cancelled.run, env: {}, ...files }, FILE)()).toEqual(CANCELLED)
  const quiet = fakeRun({ zenity: { exitCode: 1 } })
  expect(await createNativePicker({ ...LINUX, run: quiet.run, env: {}, ...files }, FILE)()).toEqual(CANCELLED)
})

test('a prompt starting with a dash is not read as an option', async () => {
  const prompt = '-e tell application "Finder" to quit'
  const mac = fakeRun({ osascript: { stdout: '/x.md\n' } })
  await createNativePicker({ platform: 'darwin', run: mac.run }, { kind: 'file', prompt })()
  const macArgs = mac.calls[0]?.args ?? []
  expect(macArgs.slice(-2)).toEqual(['--', prompt])

  const zenity = fakeRun({ zenity: { stdout: '/x.md\n' } })
  await createNativePicker({ platform: 'linux', run: zenity.run, env: DISPLAY, home: HOME }, { kind: 'file', prompt })()
  expect(zenity.calls[0]?.args).toEqual(['--file-selection', '--filename=/home/r/', `--title=${prompt}`])

  const kdialog = fakeRun({ kdialog: { stdout: '/x.md\n' } })
  await createNativePicker({ platform: 'linux', run: kdialog.run, env: DISPLAY, home: HOME }, { kind: 'file', prompt })()
  expect(kdialog.calls[1]?.args).toEqual(['--getopenfilename', '/home/r/', `--title=${prompt}`])
})

test('win32 starts PowerShell by its absolute path under the system folder', async () => {
  const { run, calls } = fakeRun({ 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe': { stdout: 'C:\\x.md' } })
  await createNativePicker({ platform: 'win32', run, env: { SystemRoot: 'D:\\Win' } }, { kind: 'file', prompt: PROMPT })()
  expect(calls.map((call) => call.command)).toEqual(['D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'])
  const fallback = fakeRun({ 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe': { stdout: 'C:\\x.md' } })
  await createNativePicker({ platform: 'win32', run: fallback.run, env: {} }, { kind: 'file', prompt: PROMPT })()
  expect(fallback.calls.map((call) => call.command)).toEqual(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'])
})

test('a missing osascript or PowerShell answers picker_unavailable, another spawn error says it could not open', async () => {
  const noMac = fakeRun({})
  expect(await createNativePicker({ platform: 'darwin', run: noMac.run }, { kind: 'file', prompt: PROMPT })()).toEqual(UNAVAILABLE)
  const noWin = fakeRun({})
  expect(await createNativePicker({ platform: 'win32', run: noWin.run, env: {} }, { kind: 'file', prompt: PROMPT })()).toEqual(UNAVAILABLE)
  const brokenMac = fakeRun({ osascript: new Error('spawn osascript EACCES') })
  expect(await createNativePicker({ platform: 'darwin', run: brokenMac.run }, { kind: 'file', prompt: PROMPT })()).toEqual(COULD_NOT_OPEN)
  const brokenWin = fakeRun({ [POWERSHELL]: new Error('spawn powershell.exe EPERM') })
  expect(await createNativePicker({ platform: 'win32', run: brokenWin.run, env: {} }, { kind: 'file', prompt: PROMPT })()).toEqual(COULD_NOT_OPEN)
})

test('a tool failure is logged with its exit code and the start of its error output, and never shown to the panel', async () => {
  const logs: string[] = []
  const stderr = `Gtk-WARNING secret-detail ${'x'.repeat(400)}`
  const { run } = fakeRun({ zenity: { exitCode: 5, stderr } })
  const answer = await createNativePicker({ platform: 'linux', run, env: DISPLAY, home: HOME, log: (message) => logs.push(message) }, { kind: 'file', prompt: PROMPT })()
  expect(answer).toEqual(COULD_NOT_OPEN)
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('zenity')
  expect(logs[0]).toContain('5')
  expect(logs[0]).toContain('Gtk-WARNING secret-detail')
  expect(logs[0]?.includes('x'.repeat(201))).toBe(false)
  expect(JSON.stringify(answer).includes('secret-detail')).toBe(false)

  const spawnLogs: string[] = []
  const broken = fakeRun({ osascript: new Error('spawn osascript EACCES') })
  await createNativePicker({ platform: 'darwin', run: broken.run, log: (message) => spawnLogs.push(message) }, { kind: 'file', prompt: PROMPT })()
  expect(spawnLogs.length).toBe(1)
  expect(spawnLogs[0]).toContain('EACCES')

  // Une annulation n'est pas un échec : rien n'est journalisé.
  const cancelLogs: string[] = []
  const cancelled = fakeRun({ zenity: { exitCode: 1 } })
  await createNativePicker({ platform: 'linux', run: cancelled.run, env: DISPLAY, home: HOME, log: (message) => cancelLogs.push(message) }, { kind: 'file', prompt: PROMPT })()
  expect(cancelLogs).toEqual([])
})

test('one dialog at a time: a second call joins the first', async () => {
  let runs = 0
  let release: (answer: { stdout: string; exitCode: number }) => void = () => {}
  const run: RunTool = () => {
    runs++
    return new Promise((resolve) => {
      release = resolve
    })
  }
  const pick = createNativePicker({ platform: 'darwin', run }, { kind: 'file', prompt: PROMPT })
  const first = pick()
  const second = pick()
  expect(runs).toBe(1)
  release({ stdout: '/Users/test/late.md\n', exitCode: 0 })
  const expected = { ok: true, value: { file: '/Users/test/late.md', name: 'late.md' } }
  expect(await first).toEqual(expected)
  expect(await second).toEqual(expected)
  // La boîte est fermée : un nouvel appel en ouvre une autre.
  const third = pick()
  expect(runs).toBe(2)
  release({ stdout: '/Users/test/other.md', exitCode: 0 })
  expect(await third).toEqual({ ok: true, value: { file: '/Users/test/other.md', name: 'other.md' } })
})

test('a cancelled or failed dialog is not kept: the next pick runs again', async () => {
  let runs = 0
  const run: RunTool = async () => {
    runs++
    return { stdout: '', exitCode: 1, stderr: 'User canceled. (-128)' }
  }
  const pick = createNativePicker({ platform: 'darwin', run }, { kind: 'file', prompt: PROMPT })
  expect(await pick()).toEqual(CANCELLED)
  expect(await pick()).toEqual(CANCELLED)
  expect(runs).toBe(2)
})

test('runTool resolves a non-zero exit with its code and output, and passes the environment', async () => {
  const script = 'process.stdout.write(process.env.PICK_PROMPT ?? ""); process.stderr.write("oops"); process.exit(3)'
  const result = await runTool(process.execPath, ['-e', script], { env: { PICK_PROMPT: 'Été l\'été' } })
  expect(result).toEqual({ stdout: "Été l'été", exitCode: 3, stderr: 'oops' })
})

test('runTool merges the given environment over the worker one: PATH stays', async () => {
  const script = 'process.stdout.write(JSON.stringify([process.env.PATH === ' + JSON.stringify(process.env.PATH ?? '') + ', process.env.DISPLAY]))'
  const result = await runTool(process.execPath, ['-e', script], { env: { DISPLAY: ':0' } })
  expect(result.stdout).toBe('[true,":0"]')
})

test('runTool rejects with ENOENT when the command does not exist', async () => {
  let code: unknown = null
  try {
    await runTool('no-such-dialog-tool-for-tests', [])
  } catch (error) {
    code = (error as { code?: unknown }).code
  }
  expect(code).toBe('ENOENT')
})

test('runTool does not wait for a tool that reads its standard input', async () => {
  const result = await runTool(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("done"))'])
  expect(result).toEqual({ stdout: 'done', exitCode: 0, stderr: '' })
})
