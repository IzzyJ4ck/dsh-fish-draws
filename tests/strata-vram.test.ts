import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { StrataVram } from '../src/runtime/strata-vram.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))))
})

async function strataFor(handler: Parameters<typeof createServer>[0]): Promise<StrataVram> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not receive a TCP port')
  return new StrataVram(
    new URL(`http://127.0.0.1:${address.port}`),
    'TEST_STRATA_KEY',
    { resolve: async () => ({ value: 'test-only-secret' }) } as any,
  )
}

describe('Strata VRAM handoff', () => {
  it('accepts the documented one-segment shrink shortfall and restores the prior expert cache', async () => {
    let cacheMiB = 18_444
    let reserveMiB = 5_120
    let resizeCalls = 0
    const strata = await strataFor((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/status') {
        return response.end(JSON.stringify({
          loaded: true,
          activity: { in_flight: 0 },
          vram: { elastic: true, reserve_mib: reserveMiB, expert_cache_mib: cacheMiB, expert_cache_full_mib: 18_444 },
        }))
      }
      if (request.url === '/v1/vram' && request.method === 'POST') {
        resizeCalls += 1
        if (resizeCalls === 1) {
          reserveMiB = 21_504
          cacheMiB = 2_500
          return response.end(JSON.stringify({ status: 'ok', reserve_mib: reserveMiB, expert_cache_mib: cacheMiB, vram_free_mib: 21_383 }))
        }
        reserveMiB = 5_120
        cacheMiB = resizeCalls === 2 ? 9_216 : 18_444
        return response.end(JSON.stringify({ status: 'ok', reserve_mib: reserveMiB, expert_cache_mib: cacheMiB, vram_free_mib: resizeCalls === 2 ? 6_300 : 4_400 }))
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'not found' }))
    })

    await expect(strata.release(21_504)).resolves.toBeUndefined()
    await expect(strata.restore(undefined, 250, 5)).resolves.toBe(true)
    expect(resizeCalls).toBe(3)
  })

  it('uses activity.in_flight when waiting for Strata to become idle', async () => {
    let calls = 0
    const strata = await strataFor((_request, response) => {
      calls += 1
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ loaded: true, activity: { in_flight: calls === 1 ? 1 : 0 }, vram: { elastic: true } }))
    })
    await expect(strata.waitIdle(undefined, 100, 5)).resolves.toMatchObject({ activity: { in_flight: 0 } })
    expect(calls).toBe(2)
  })
})
