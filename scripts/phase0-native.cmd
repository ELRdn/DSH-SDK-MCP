@echo off
setlocal
cd /d "%~dp0.."

rem DSH 0.1.2+ is launched from the SDK client's same-version dependency.
rem DSH_MCP_RUNTIME_COMMAND/ARGS remain optional external-runtime overrides.

rem Provider selection chooses the matching profile patch; an explicit patch still wins.
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
