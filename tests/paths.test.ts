import { describe, expect, it } from 'vitest'
import { assertRelativeUserPath, isPathInside } from '../src/runtime/paths.js'

describe('path boundary', () => {
  it('rejects traversal and absolute workspace references', () => {
    expect(() => assertRelativeUserPath('../secret.png')).toThrow()
    expect(() => assertRelativeUserPath('E:\\secret.png')).toThrow()
    expect(() => assertRelativeUserPath('images//x.png')).toThrow()
    expect(() => assertRelativeUserPath('images/x.png')).not.toThrow()
  })
  it('uses containment rather than string prefixes', () => {
    expect(isPathInside('E:\\root\\child\\x.png', 'E:\\root')).toBe(true)
    expect(isPathInside('E:\\root-escape\\x.png', 'E:\\root')).toBe(false)
  })
})
