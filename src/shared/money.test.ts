import { assert, test } from 'orca/testing'
import { dollarsToMinor, formatMoney, sumMinor } from './money'

test('dollarsToMinor converts valid dollar inputs to minor units', () => {
  const cases: [string, string][] = [
    ['5', '500'],
    ['5.00', '500'],
    ['0.5', '50'],
    ['0.02', '2'],
    ['1,50', '150'],
    [' 12.3 ', '1230'],
  ]
  for (const [input, expected] of cases) assert.equal(dollarsToMinor(input), expected, input)
})

test('dollarsToMinor rejects zero, sub-cent, negative and non-numeric inputs', () => {
  for (const input of ['0', '1.234', '-1', 'abc', '']) assert.equal(dollarsToMinor(input), null, input)
})

test('formatMoney renders USD with a dollar sign and other currencies with a suffix', () => {
  assert.equal(formatMoney({ minor: '1', currency: 'USD' }), '$0.01')
  assert.equal(formatMoney({ minor: '2500', currency: 'USD' }), '$25.00')
  assert.equal(formatMoney({ minor: '50', currency: 'EUR' }), '0.50 EUR')
  assert.equal(formatMoney(null), '')
})

test('sumMinor adds with BigInt, without float drift', () => {
  assert.equal(sumMinor(['1', '250', '0']), '251')
  assert.equal(sumMinor([]), '0')
  assert.equal(sumMinor(['9007199254740993', '1']), '9007199254740994')
})
