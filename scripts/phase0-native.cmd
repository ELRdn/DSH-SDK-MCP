@echo off
setlocal
cd /d "%~dp0.."

rem Keep the runtime external to the SDK and pass an argv array to node.
if not defined DSH_MCP_RUNTIME_COMMAND set DSH_MCP_RUNTIME_COMMAND=node
if not defined DSH_MCP_RUNTIME_ARGS set DSH_MCP_RUNTIME_ARGS=["%CD:\=/%/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/bin.js"]

rem Profile and provider can be selected independently; explicit Cordis config still wins.
if not defined DSH_MCP_PROFILE (
  if not defined DSH_MCP_PROVIDER set DSH_MCP_PROVIDER=deepseek-official
  if /I "%DSH_MCP_PROVIDER%"=="opencode-go" set DSH_MCP_PROFILE=opencode-go
  if /I "%DSH_MCP_PROVIDER%"=="deepseek-official" set DSH_MCP_PROFILE=deepseek-official
)
if defined DSH_MCP_PROFILE (
  if not defined DSH_MCP_PROVIDER (
    if /I "%DSH_MCP_PROFILE%"=="opencode-go" set DSH_MCP_PROVIDER=opencode-go
    if /I "%DSH_MCP_PROFILE%"=="deepseek-official" set DSH_MCP_PROVIDER=deepseek-official
  )
)
if not defined DSH_MCP_MODEL set DSH_MCP_MODEL=deepseek-v4-flash

if not defined DSH_MCP_CORDIS_CONFIG (
  if /I "%DSH_MCP_PROFILE%"=="opencode-go" (
    set DSH_MCP_CORDIS_CONFIG=%CD%\runtime\phase0.opencode-go.cordis.yml
  ) else (
    set DSH_MCP_CORDIS_CONFIG=%CD%\runtime\phase0.cordis.yml
  )
)

node dist\phase0.js
exit /b %ERRORLEVEL%
