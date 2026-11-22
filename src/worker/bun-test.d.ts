// Types minimaux de `bun:test` pour les fichiers `*.spec.ts` du worker : `@types/bun` casse le
// typecheck sous TypeScript 7 (identifiants dupliqués dans ffi.d.ts), on ne déclare donc que
// ce que les specs utilisent.
declare module 'bun:test' {
  export function test(name: string, fn: () => unknown): void
  export function expect(actual: unknown): {
    toEqual(expected: unknown): void
    toBe(expected: unknown): void
    toThrow(): void
  }
}
