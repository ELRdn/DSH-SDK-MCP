#!/usr/bin/env node

import { runMcpServer } from './mcp-server.js'
import { secretValuesFromEnvironment } from './config.js'
import { safeError } from './report.js'

try {
  await runMcpServer()
} catch (error) {
  process.stderr.write(
    `[dsh-sdk-mcp] ${safeError(error, secretValuesFromEnvironment(process.env)).message}\n`,
  )
  process.exitCode = 1
}
