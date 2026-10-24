// Đồng bộ thời gian thực giữa các thiết bị: WebRTC P2P (Trystero), tìm nhau qua relay Nostr công cộng.
// Relay chỉ thấy bắt tay đã mã hoá; nội dung đi thẳng giữa các thiết bị, mã hoá thêm một lớp AES-GCM.
import { joinRoom } from 'trystero'
import { seal, unseal, sign, verifySig, randomB64 } from './crypto.js'

const APP_ID = 'couple-space-v1'
export const MAX_BYTES = 40 * 1024 * 1024

export function connect(keys, { onOp, onPeers }) {
  const room = joinRoom({ appId: APP_ID, password: keys.sdpPassword, maxReceiveBytes: MAX_BYTES * 2 }, keys.roomId, {
    // Bắt tay: hai bên ký nonce của nhau bằng khoá HMAC chung → chỉ thiết bị biết mật khẩu mới được vào phòng
    onPeerHandshake: async (_, send, receive, isInitiator) => {
      const me = isInitiator ? 'i' : 'r'
      const them = isInitiator ? 'r' : 'i'
      const nonce = randomB64(16)
      await send({ n: nonce })
      const a = (await receive()).data
      if (typeof a?.n !== 'string') throw new Error('bad handshake')
      await send({ s: await sign(keys.authKey, me + ':' + a.n) })
      const b = (await receive()).data
      if (typeof b?.s !== 'string' || !(await verifySig(keys.authKey, b.s, them + ':' + nonce))) {
        throw new Error('handshake rejected')
      }
    },
    onJoinError: d => console.warn('[space] peer could not connect:', d.error),
  })

  const box = room.makeAction('box', { onReceive: ({ byteLength }) => byteLength <= MAX_BYTES })
  box.onMessage = async (data, { peerId }) => {
    let op
    try {
      op = await unseal(keys.msgKey, data)
    } catch {
      return // không giải mã được → bỏ qua
    }
    onOp(op, peerId)
  }

  const count = () => Object.keys(room.getPeers()).length
  room.onPeerJoin = id => onPeers(count(), id, true)
  room.onPeerLeave = id => onPeers(count(), id, false)

  return {
    async send(op, target, onProgress) {
      const opts = {}
      if (target) opts.target = target
      if (onProgress) opts.onProgress = onProgress
      return box.send(await seal(keys.msgKey, op), opts)
    },
    peers: count,
    leave: () => room.leave(),
  }
}
