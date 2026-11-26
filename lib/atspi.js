import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('./atspi.py', import.meta.url))

export function requestAtspi(request, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/python3', [helper], {
      timeout: 6000, maxBuffer: 1024 * 1024, signal,
    }, (error, stdout) => {
      if (error) {
        reject(new Error(error.code === 'ENOENT'
          ? 'AT-SPI requires system Python 3 and its GObject bindings.'
          : 'AT-SPI request failed or timed out. Observe the window before retrying.'))
        return
      }
      try {
        const result = JSON.parse(stdout)
        if (result.error) throw new Error(result.error)
        resolve(result)
      } catch (error) {
        reject(error)
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
  })
}
