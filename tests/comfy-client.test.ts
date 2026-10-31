import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { FishDrawsError } from '../src/errors.js'
import { ComfyClient } from '../src/runtime/comfy-client.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))))
})

async function clientFor(handler: Parameters<typeof createServer>[0]): Promise<ComfyClient> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not receive a TCP port')
  return new ComfyClient(new URL(`http://127.0.0.1:${address.port}`))
}

describe('ComfyClient response handling', () => {
  it('accepts an empty successful response from the /free control endpoint', async () => {
    const client = await clientFor((request, response) => {
      if (request.url === '/queue' && request.method === 'GET') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ queue_running: [], queue_pending: [] }))
        return
      }
      if (request.url === '/free' && request.method === 'POST') {
        response.statusCode = 200
        response.end()
        return
      }
      if (request.url === '/system_stats' && request.method === 'GET') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ devices: [{ type: 'cuda', torch_vram_total: 64 * 1024 * 1024 }] }))
        return
      }
      response.statusCode = 404
      response.end()
    })
    await expect(client.freeModels()).resolves.toBe(true)
  })

  it('waits for Torch VRAM to be released instead of treating an idle queue as an unload', async () => {
    let statsCalls = 0
    const client = await clientFor((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/queue') return response.end(JSON.stringify({ queue_running: [], queue_pending: [] }))
      if (request.url === '/free') return response.end()
      if (request.url === '/system_stats') {
        statsCalls += 1
        const bytes = statsCalls < 3 ? 12 * 1024 * 1024 * 1024 : 64 * 1024 * 1024
        return response.end(JSON.stringify({ devices: [{ type: 'cuda', torch_vram_total: bytes }] }))
      }
      response.statusCode = 404
      response.end()
    })
    await expect(client.freeModels(undefined, 250, 5)).resolves.toBe(true)
    expect(statsCalls).toBeGreaterThanOrEqual(3)
  })

  it('reports failure when ComfyUI stays idle but retains model VRAM', async () => {
    const client = await clientFor((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/queue') return response.end(JSON.stringify({ queue_running: [], queue_pending: [] }))
      if (request.url === '/free') return response.end()
      if (request.url === '/system_stats') return response.end(JSON.stringify({ devices: [{ type: 'cuda', torch_vram_total: 12 * 1024 * 1024 * 1024 }] }))
      response.statusCode = 404
      response.end()
    })
    await expect(client.freeModels(undefined, 40, 5)).resolves.toBe(false)
  })

  it('keeps JSON-bearing endpoints strict when ComfyUI returns an empty body', async () => {
    const client = await clientFor((_request, response) => {
      response.statusCode = 200
      response.end()
    })
    await expect(client.online()).rejects.toMatchObject<FishDrawsError>({
      code: 'COMFY_INVALID_JSON',
      failureClass: 'technical',
      retryable: true,
    })
  })

  it('wraps malformed JSON as a structured retryable ComfyUI error', async () => {
    const client = await clientFor((_request, response) => {
      response.statusCode = 200
      response.end('{not-json')
    })
    await expect(client.online()).rejects.toMatchObject<FishDrawsError>({ code: 'COMFY_INVALID_JSON', retryable: true })
  })
})
