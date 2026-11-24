// Aucun de ces tests n'ouvre une vraie boîte de dialogue : `run` est toujours simulé (sauf les trois derniers,
// qui lancent le runtime courant sur un script sans fenêtre pour prouver `runTool`).
import { expect, test } from 'bun:test'
import { createNativePicker, runTool, type RunTool } from './native-picker'

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
const PROMPT = 'Choose a file to upload'
const CANCELLED = { ok: true, value: null }
const COULD_NOT_OPEN = { ok: false, code: 'other', error: 'Could not open the file picker.' }

/** Le script PowerShell décodé de `-EncodedCommand` (UTF-16LE en base64). */
const decodeScript = (args: string[]): string => Buffer.from(args[args.indexOf('-EncodedCommand') + 1] ?? '', 'base64').toString('utf16le')

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
  const { run, calls } = fakeRun({ 'powershell.exe': { stdout: 'C:\\Users\\romain\\Mes documents\\notes.md' } })
  const pick = createNativePicker({ platform: 'win32', run }, { kind: 'file', prompt: PROMPT })
  expect(await pick()).toEqual({ ok: true, value: { file: 'C:\\Users\\romain\\Mes documents\\notes.md', name: 'notes.md' } })
  expect(calls.length).toBe(1)
  expect(calls[0]?.env).toEqual({ PICK_PROMPT: PROMPT })
  const script = decodeScript(calls[0]?.args ?? [])
  expect(script.includes('$env:PICK_PROMPT')).toBe(true)
  expect(script.includes('OpenFileDialog')).toBe(true)
  expect(script.includes('UTF8')).toBe(true)
})

test('win32 empty output is a cancel', async () => {
  const { run } = fakeRun({ 'powershell.exe': { stdout: '' } })
  expect(await createNativePicker({ platform: 'win32', run }, { kind: 'file', prompt: PROMPT })()).toEqual(CANCELLED)
})

test('linux uses zenity, exit 1 is a cancel', async () => {
  const chosen = fakeRun({ zenity: { stdout: '/home/r/Été/x.md\n' } })
  const pick = createNativePicker({ platform: 'linux', run: chosen.run, env: DISPLAY }, { kind: 'file', prompt: PROMPT })
  expect(await pick()).toEqual({ ok: true, value: { file: '/home/r/Été/x.md', name: 'x.md' } })
  expect(chosen.calls).toEqual([{ command: 'zenity', args: ['--file-selection', `--title=${PROMPT}`] }])

  const cancelled = fakeRun({ zenity: { exitCode: 1 } })
  expect(await createNativePicker({ platform: 'linux', run: cancelled.run, env: DISPLAY }, { kind: 'file', prompt: PROMPT })()).toEqual(CANCELLED)
})

test('linux falls back to kdialog when zenity is missing', async () => {
  const chosen = fakeRun({ kdialog: { stdout: '/home/r/x.md\n' } })
  const pick = createNativePicker({ platform: 'linux', run: chosen.run, env: DISPLAY }, { kind: 'file', prompt: PROMPT })
  expect(await pick()).toEqual({ ok: true, value: { file: '/home/r/x.md', name: 'x.md' } })
  expect(chosen.calls.map((call) => call.command)).toEqual(['zenity', 'kdialog'])
  expect(chosen.calls[1]?.args).toEqual(['--getopenfilename', '.', '--title', PROMPT])

  const cancelled = fakeRun({ kdialog: { exitCode: 1 } })
  expect(await createNativePicker({ platform: 'linux', run: cancelled.run, env: DISPLAY }, { kind: 'file', prompt: PROMPT })()).toEqual(CANCELLED)
})

test('linux without zenity nor kdialog answers picker_unavailable', async () => {
  const { run, calls } = fakeRun({})
  const answer = await createNativePicker({ platform: 'linux', run, env: DISPLAY }, { kind: 'file', prompt: PROMPT })()
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

  const win = fakeRun({ 'powershell.exe': { stdout: 'C:\\skills\\teach' } })
  expect(await createNativePicker({ platform: 'win32', run: win.run }, folder)()).toEqual({ ok: true, value: { file: 'C:\\skills\\teach', name: 'teach' } })
  expect(decodeScript(win.calls[0]?.args ?? [])).toContain('FolderBrowserDialog')

  const zenity = fakeRun({ zenity: { stdout: '/home/r/skills/teach\n' } })
  expect(await createNativePicker({ platform: 'linux', run: zenity.run, env: DISPLAY }, folder)()).toEqual({ ok: true, value: { file: '/home/r/skills/teach', name: 'teach' } })
  expect(zenity.calls[0]?.args).toEqual(['--file-selection', '--directory', `--title=${folder.prompt}`])

  const kdialog = fakeRun({ kdialog: { stdout: '/home/r/skills/teach\n' } })
  await createNativePicker({ platform: 'linux', run: kdialog.run, env: DISPLAY }, folder)()
  expect(kdialog.calls[1]?.args).toEqual(['--getexistingdirectory', '.', '--title', folder.prompt])
})

test('a path with spaces, accents and a quote comes back intact', async () => {
  const unix = "/home/r/Été/l'été notes .md"
  const linux = fakeRun({ zenity: { stdout: `${unix}\n` } })
  expect(await createNativePicker({ platform: 'linux', run: linux.run, env: DISPLAY }, { kind: 'file', prompt: PROMPT })()).toEqual({
    ok: true,
    value: { file: unix, name: "l'été notes .md" }
  })
  const windows = "C:\\Users\\romain\\Mes documents\\l'été.md"
  const win = fakeRun({ 'powershell.exe': { stdout: windows } })
  expect(await createNativePicker({ platform: 'win32', run: win.run }, { kind: 'file', prompt: PROMPT })()).toEqual({
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

  const win = fakeRun({ 'powershell.exe': { stdout: 'C:\\x.md' } })
  await createNativePicker({ platform: 'win32', run: win.run }, { kind: 'file', prompt })()
  expect(win.calls[0]?.env).toEqual({ PICK_PROMPT: prompt })
  expect((win.calls[0]?.args ?? []).some((arg) => arg.includes('quoted'))).toBe(false)
  expect(decodeScript(win.calls[0]?.args ?? []).includes('quoted')).toBe(false)

  const linux = fakeRun({ zenity: { stdout: '/x.md\n' } })
  await createNativePicker({ platform: 'linux', run: linux.run, env: DISPLAY }, { kind: 'file', prompt })()
  expect(linux.calls[0]?.args).toEqual(['--file-selection', `--title=${prompt}`])
})

test('a dialog tool that fails says it could not open', async () => {
  const cases: { platform: NodeJS.Platform; answers: Record<string, Answer> }[] = [
    { platform: 'darwin', answers: { osascript: { exitCode: 1, stderr: 'execution error: Not authorized to send Apple events. (-1743)' } } },
    { platform: 'win32', answers: { 'powershell.exe': { exitCode: 1, stderr: 'Exception: ShowDialog' } } },
    { platform: 'linux', answers: { zenity: { exitCode: 5, stderr: 'Gtk-WARNING **: cannot open display' } } },
    { platform: 'linux', answers: { zenity: new Error('spawn zenity EACCES') } },
    { platform: 'linux', answers: { kdialog: { exitCode: 2 } } }
  ]
  for (const entry of cases) {
    const { run } = fakeRun(entry.answers)
    const answer = await createNativePicker({ platform: entry.platform, run, env: DISPLAY }, { kind: 'file', prompt: PROMPT })()
    expect({ platform: entry.platform, answer }).toEqual({ platform: entry.platform, answer: COULD_NOT_OPEN })
    // Le message de l'outil n'est jamais montré brut.
    expect(JSON.stringify(answer).includes('Gtk')).toBe(false)
  }
})

test('linux without a display fails instead of looking like a cancel, and runs no tool', async () => {
  const { run, calls } = fakeRun({ zenity: { exitCode: 1 } })
  const answer = await createNativePicker({ platform: 'linux', run, env: {} }, { kind: 'file', prompt: PROMPT })()
  expect(answer).toEqual(COULD_NOT_OPEN)
  expect(calls).toEqual([])
  const wayland = fakeRun({ zenity: { stdout: '/x.md\n' } })
  expect((await createNativePicker({ platform: 'linux', run: wayland.run, env: { WAYLAND_DISPLAY: 'wayland-0' } }, { kind: 'file', prompt: PROMPT })()).ok).toBe(true)
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
