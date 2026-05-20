#!/usr/bin/env bash
set -euo pipefail

# test-region-download.sh — smoke test for the /api/extract/:jobId/region/:name route.
#
# Boots `npm run dev`, uploads a sample PDF, follows the SSE stream to completion,
# then downloads each detected region as PNG and JPEG and verifies the magic bytes.
#
# This is a manual-verification helper, not a substitute for unit/integration tests.
# Run from the repo root: ./scripts/test-region-download.sh

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_URL="http://localhost:3000"
SAMPLE_PDF="/Users/xian/document-extractor/samples/clean-letter.pdf"
SERVER_READY_TIMEOUT=30   # seconds to wait for dev server
SSE_TIMEOUT=120           # seconds to wait for `event: done`
REGIONS=("letterhead" "footer" "signature")

# Temp files we create — tracked for cleanup.
TMP_DIR="$(mktemp -d -t region-smoke-XXXXXX)"
SERVER_LOG="${TMP_DIR}/dev-server.log"
SSE_LOG="${TMP_DIR}/sse.log"
RESPONSE_JSON="${TMP_DIR}/upload-response.json"
SERVER_PID=""

# Track whether *we* started the dev server (if one was already running we leave it).
WE_STARTED_SERVER=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
banner() {
  printf '\n==== Step %s: %s ====\n' "$1" "$2"
}

info() {
  printf '  [info] %s\n' "$*"
}

fail() {
  printf '\n[FAIL] %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local exit_code=$?
  printf '\n==== Cleanup ====\n'
  if [[ "${WE_STARTED_SERVER}" -eq 1 && -n "${SERVER_PID}" ]]; then
    if kill -0 "${SERVER_PID}" 2>/dev/null; then
      info "killing dev server (pid ${SERVER_PID})"
      # Kill the whole process group so child node processes die too.
      kill -- "-${SERVER_PID}" 2>/dev/null || kill "${SERVER_PID}" 2>/dev/null || true
      # Give it a moment to exit; force-kill if it lingers.
      sleep 1
      if kill -0 "${SERVER_PID}" 2>/dev/null; then
        kill -9 "${SERVER_PID}" 2>/dev/null || true
      fi
    fi
  fi
  if [[ -d "${TMP_DIR}" ]]; then
    info "removing temp dir ${TMP_DIR}"
    rm -rf "${TMP_DIR}"
  fi
  if [[ "${exit_code}" -eq 0 ]]; then
    printf '\n[OK] smoke test passed\n'
  fi
  exit "${exit_code}"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Pre-flight: required tools and inputs
# ---------------------------------------------------------------------------
banner 0 "Pre-flight checks"

command -v curl >/dev/null 2>&1 || fail "curl is required but not installed"
command -v npm  >/dev/null 2>&1 || fail "npm is required but not installed"

HAVE_JQ=0
if command -v jq >/dev/null 2>&1; then
  HAVE_JQ=1
  info "jq available — using jq for JSON parsing"
else
  info "jq not found — falling back to grep/sed (install jq for more robust parsing)"
fi

# `file` is BSD/POSIX on macOS; `xxd` ships with macOS by default. Prefer xxd.
HAVE_XXD=0
if command -v xxd >/dev/null 2>&1; then
  HAVE_XXD=1
fi

[[ -f "${SAMPLE_PDF}" ]] || fail "sample PDF not found: ${SAMPLE_PDF}"
info "sample PDF: ${SAMPLE_PDF}"
info "temp dir:   ${TMP_DIR}"

# ---------------------------------------------------------------------------
# Step 1: start dev server (or reuse a running one) and wait for it to be ready
# ---------------------------------------------------------------------------
banner 1 "Start dev server and wait for ${BASE_URL}"

# If something is already listening on :3000, assume the caller wants us to use it.
if curl -fsS -o /dev/null --max-time 2 "${BASE_URL}/" 2>/dev/null; then
  info "dev server already running — reusing it (will not kill on exit)"
  WE_STARTED_SERVER=0
else
  info "launching \`npm run dev\` in background; logs -> ${SERVER_LOG}"
  # `setsid` would be ideal for process-group isolation but isn't on macOS by default.
  # Instead, we run in a new session via `set -m` + background; cleanup falls back
  # to killing just the PID if process-group kill fails.
  (
    cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)" 2>/dev/null \
      || cd "$(dirname "$0")/.."
    npm run dev >"${SERVER_LOG}" 2>&1
  ) &
  SERVER_PID=$!
  WE_STARTED_SERVER=1
  info "dev server pid: ${SERVER_PID}"

  # Poll the root URL until it responds or we time out.
  ready=0
  for i in $(seq 1 "${SERVER_READY_TIMEOUT}"); do
    if curl -fsS -o /dev/null --max-time 2 "${BASE_URL}/" 2>/dev/null; then
      ready=1
      info "server responded after ${i}s"
      break
    fi
    # If the background process died, bail early with the log tail.
    if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
      printf -- '--- dev server log (tail) ---\n' >&2
      tail -n 50 "${SERVER_LOG}" >&2 || true
      fail "dev server exited before becoming ready"
    fi
    sleep 1
  done
  [[ "${ready}" -eq 1 ]] || fail "dev server did not respond on ${BASE_URL} within ${SERVER_READY_TIMEOUT}s"
fi

# ---------------------------------------------------------------------------
# Step 2: upload the sample PDF and capture the jobId
# ---------------------------------------------------------------------------
banner 2 "POST sample PDF to /api/extract"

http_status=$(
  curl -sS -o "${RESPONSE_JSON}" -w '%{http_code}' \
    -F "file=@${SAMPLE_PDF};type=application/pdf" \
    "${BASE_URL}/api/extract"
) || fail "curl failed when POSTing to /api/extract"

info "HTTP ${http_status}"
if [[ "${http_status}" != "200" && "${http_status}" != "201" && "${http_status}" != "202" ]]; then
  printf -- '--- response body ---\n' >&2
  cat "${RESPONSE_JSON}" >&2 || true
  fail "upload returned non-2xx status: ${http_status}"
fi

if [[ "${HAVE_JQ}" -eq 1 ]]; then
  JOB_ID=$(jq -r '.jobId // empty' "${RESPONSE_JSON}")
else
  # Fallback: pull the first "jobId":"..." occurrence. Works for flat JSON.
  JOB_ID=$(
    grep -o '"jobId"[[:space:]]*:[[:space:]]*"[^"]*"' "${RESPONSE_JSON}" \
      | head -n 1 \
      | sed -E 's/.*"jobId"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/'
  )
fi

[[ -n "${JOB_ID}" ]] || {
  printf -- '--- response body ---\n' >&2
  cat "${RESPONSE_JSON}" >&2 || true
  fail "could not parse jobId from upload response"
}
info "jobId: ${JOB_ID}"

# ---------------------------------------------------------------------------
# Step 3: stream SSE events until `event: done`
# ---------------------------------------------------------------------------
banner 3 "Stream /api/extract/${JOB_ID}/stream until event: done"

# We use curl with -N (no buffering) and --max-time as a safety net.
# Pipe through awk that prints each line and exits when it sees `event: done`.
# We must run curl in its own process group so awk can close the pipe cleanly.
#
# Trick: `awk` exits on the `done` event, which causes SIGPIPE on the curl side,
# which terminates the connection. We then check the awk exit status.
set +e
curl -sS -N --max-time "${SSE_TIMEOUT}" \
  -H 'Accept: text/event-stream' \
  "${BASE_URL}/api/extract/${JOB_ID}/stream" \
  | awk -v logfile="${SSE_LOG}" '
      {
        print "  [sse] " $0
        print $0 >> logfile
        if ($0 ~ /^event:[[:space:]]*done[[:space:]]*$/) {
          # Drain one or two more lines (data + blank) then exit cleanly.
          getline next1; print "  [sse] " next1; print next1 >> logfile
          exit 0
        }
        if ($0 ~ /^event:[[:space:]]*error[[:space:]]*$/) {
          getline next1; print "  [sse] " next1; print next1 >> logfile
          exit 2
        }
      }
    '
sse_status=$?
set -e

case "${sse_status}" in
  0) info "received event: done" ;;
  2) fail "SSE stream emitted event: error (see output above)" ;;
  *) fail "SSE stream ended without event: done (awk exit ${sse_status})" ;;
esac

# ---------------------------------------------------------------------------
# Step 4 + 5: download each region as PNG (default) and JPEG (?format=jpeg)
# ---------------------------------------------------------------------------
banner 4 "Download regions as PNG and verify magic bytes"

# Magic byte checks. Both modes return 0 on match, non-zero on mismatch.
# PNG: 89 50 4E 47   JPEG: FF D8 FF
check_magic() {
  local file="$1" expected="$2"
  if [[ "${HAVE_XXD}" -eq 1 ]]; then
    local head_hex
    head_hex=$(xxd -p -l 4 "${file}" | tr -d '\n' | tr '[:lower:]' '[:upper:]')
    case "${expected}" in
      PNG)  [[ "${head_hex}" == 89504E47* ]] ;;
      JPEG) [[ "${head_hex}" == FFD8FF* ]] ;;
      *) return 2 ;;
    esac
  else
    # Fallback: rely on `file --mime-type`.
    local mime
    mime=$(file --mime-type -b "${file}" 2>/dev/null || echo "")
    case "${expected}" in
      PNG)  [[ "${mime}" == "image/png" ]] ;;
      JPEG) [[ "${mime}" == "image/jpeg" ]] ;;
      *) return 2 ;;
    esac
  fi
}

download_and_check() {
  local region="$1" format="$2" expected_magic="$3" query="$4"
  local out_file="${TMP_DIR}/${JOB_ID}-${region}.${format}"
  local url="${BASE_URL}/api/extract/${JOB_ID}/region/${region}${query}"
  local headers_file="${TMP_DIR}/${region}-${format}.headers"

  info "GET ${url}"
  local http_status
  http_status=$(
    curl -sS -o "${out_file}" -D "${headers_file}" -w '%{http_code}' "${url}"
  ) || fail "curl failed for region '${region}' (${format})"

  # Extract Content-Type. macOS sed handles -E; grep -i for case-insensitive header name.
  local content_type
  content_type=$(
    grep -i '^content-type:' "${headers_file}" \
      | tail -n 1 \
      | sed -E 's/^[Cc]ontent-[Tt]ype:[[:space:]]*//; s/[[:space:]]*$//' \
      | tr -d '\r'
  )
  local byte_size
  byte_size=$(wc -c <"${out_file}" | tr -d ' ')

  info "status=${http_status} content-type=${content_type:-<none>} bytes=${byte_size}"

  if [[ "${http_status}" != "200" ]]; then
    fail "region '${region}' (${format}): expected HTTP 200, got ${http_status}"
  fi
  if ! check_magic "${out_file}" "${expected_magic}"; then
    fail "region '${region}' (${format}): file at ${out_file} is not a valid ${expected_magic}"
  fi
  info "${expected_magic} magic bytes verified"
}

# PNG (default format, no query string)
for region in "${REGIONS[@]}"; do
  download_and_check "${region}" "png" "PNG" ""
done

banner 5 "Download regions as JPEG (?format=jpeg&quality=50) and verify magic bytes"
for region in "${REGIONS[@]}"; do
  download_and_check "${region}" "jpg" "JPEG" "?format=jpeg&quality=50"
done

# Cleanup happens via the EXIT trap.
