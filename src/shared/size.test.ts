import { assert, test } from 'orca/testing'
import { formatDecimalSize } from './size'

test('formats sizes in powers of 1000 with one decimal', () => {
  const cases: [number, string][] = [
    [0, '0 B'],
    [512, '512 B'],
    [999, '999 B'],
    [1000, '1.0 kB'],
    [9441, '9.4 kB'],
    [12_000_000, '12.0 MB'],
    [100_000_000, '100.0 MB'],
    [1_500_000_000, '1.5 GB']
  ]
  for (const [bytes, expected] of cases) assert.equal(formatDecimalSize(bytes), expected)
})

test('a value that rounds up to the next unit is written in that unit', () => {
  assert.equal(formatDecimalSize(999_960), '1.0 MB')
  assert.equal(formatDecimalSize(999_960_000), '1.0 GB')
})
