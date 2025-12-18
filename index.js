// index.js (ESM style)
// Make sure package.json has: "type": "module"

import Pino from 'pino'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys'

import { ensureDirs } from './utils.js'
import { SESSION_FOLDER, SAVE_INTERVAL_MS, BOT_NAME } from './config.js'
import { onMessageReceived, onGroupParticipantsUpdate } from './msg.js'
import { persistDirtyGroups } from './ranking.js'

// Ensure required directories exist
ensureDirs()

const logger = Pino({ level: 'info' })
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let sock // reuse in pairing endpoints

async function start() {
  const { version } = await fetchLatestBaileysVersion()
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER)

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: !process.env.PAIR_NUMBER,
    logger
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', update => {
    const { connection, lastDisconnect } = update
    logger.info({ connection, lastDisconnect }, 'connection update')
    if (connection === 'open') {
      logger.info(`${BOT_NAME} connected.`)
    }
  })

  // Auto pairing on boot if PAIR_NUMBER set
  let latestPairCode = ''
  let latestPairNumber = ''

  if (process.env.PAIR_NUMBER) {
    try {
      const code = await sock.requestPairingCode(process.env.PAIR_NUMBER)
      logger.info(`Pairing Code for ${process.env.PAIR_NUMBER}: ${code}`)
      latestPairCode = code
      latestPairNumber = process.env.PAIR_NUMBER
    } catch (e) {
      logger.error('Failed to generate pairing code:', e)
    }
  }

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue
      await onMessageReceived({ sock, msg })
    }
  })

  sock.ev.on('group-participants.update', async update => {
    await onGroupParticipantsUpdate({ sock, update })
  })

  setInterval(persistDirtyGroups, SAVE_INTERVAL_MS)

  // Express keep-alive + static + pairing endpoints
  const app = express()

  // Static HTML
  app.use(express.static(path.join(__dirname, 'public')))

  // REST endpoint to issue a fresh pairing code (POST /pair?number=947xxxxxxx)
  app.post('/pair', express.json(), async (req, res) => {
    try {
      const number =
        req.query.number ||
        req.body?.number ||
        process.env.PAIR_NUMBER
      if (!number) {
        return res.status(400).json({ ok: false, error: 'number required (query or body or PAIR_NUMBER env)' })
      }
      if (!sock) {
        return res.status(500).json({ ok: false, error: 'socket not ready' })
      }
      const code = await sock.requestPairingCode(number)
      latestPairCode = code
      latestPairNumber = number
      res.json({ ok: true, number, code })
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) })
    }
  })

  // Simple JSON getter for latest code (GET /pair/status)
  app.get('/pair/status', (req, res) => {
    res.json({
      ok: true,
      number: latestPairNumber || process.env.PAIR_NUMBER || '',
      code: latestPairCode || ''
    })
  })

  app.get('/', (_, res) => res.send(`${BOT_NAME} is running`))

  const port = process.env.PORT || 10000
  app.listen(port, () => logger.info(`HTTP server on :${port}`))
}

start().catch(err => {
  console.error('Fatal start error:', err)
})