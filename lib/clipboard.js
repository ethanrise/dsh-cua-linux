import { call, connect, pressKey, requireFocus } from './x11.js'

async function createClipboard({ X, root, atoms }) {
  const selection = await call(X, 'InternAtom', false, 'CLIPBOARD')
  const targets = await call(X, 'InternAtom', false, 'TARGETS')
  const owner = X.AllocID()
  await call(X, 'CreateWindow', owner, root, 0, 0, 1, 1, 0, 0, 0, 0, {})
  const clipboard = { selection, owner, data: null }
  X.on('event', (event) => {
    if (event.selection !== selection || event.owner !== owner) return
    if (event.name === 'SelectionClear') {
      clipboard.data = null
      return
    }
    if (event.name !== 'SelectionRequest') return
    let property = event.property || event.target
    if (clipboard.data && event.target === atoms.utf8) {
      X.ChangeProperty(0, event.requestor, property, atoms.utf8, 8, clipboard.data)
    } else if (clipboard.data && event.target === targets) {
      const formats = Buffer.alloc(8)
      formats.writeUInt32LE(targets, 0)
      formats.writeUInt32LE(atoms.utf8, 4)
      X.ChangeProperty(0, event.requestor, property, X.atoms.ATOM, 32, formats)
    } else {
      property = 0
    }
    const notify = Buffer.alloc(32)
    notify[0] = 31
    notify.writeUInt32LE(event.time, 4)
    notify.writeUInt32LE(event.requestor, 8)
    notify.writeUInt32LE(selection, 12)
    notify.writeUInt32LE(event.target, 16)
    notify.writeUInt32LE(property, 20)
    X.SendEvent(event.requestor, false, 0, notify)
  })
  return clipboard
}

export async function paste(wid, text) {
  const data = Buffer.from(text, 'utf8')
  if (data.length > 60 * 1024) throw new Error('Clipboard text is limited to 60 KiB.')
  const connection = await connect()
  connection.clipboard ??= await createClipboard(connection)
  const { X, clipboard } = connection
  await requireFocus(wid)
  clipboard.data = data
  await call(X, 'SetSelectionOwner', clipboard.owner, clipboard.selection, 0)
  if (await call(X, 'GetSelectionOwner', clipboard.selection) !== clipboard.owner) {
    clipboard.data = null
    throw new Error('Could not acquire the X11 clipboard.')
  }
  await pressKey('ctrl+v', wid)
}
