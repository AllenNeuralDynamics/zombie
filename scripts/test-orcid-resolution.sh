#!/usr/bin/env bash
set -euo pipefail

zombie_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
backend_root="${AIND_METADATA_VIZ_DIR:-"${zombie_root}/../aind-metadata-viz"}"
backend_python="${AIND_METADATA_VIZ_PYTHON:-}"

if [[ ! -d "${backend_root}" ]]; then
  echo "Backend repository not found: ${backend_root}" >&2
  echo "Set AIND_METADATA_VIZ_DIR to its checkout path." >&2
  exit 2
fi

if [[ -z "${backend_python}" ]]; then
  if [[ -x "${backend_root}/.venv/bin/python" ]]; then
    backend_python="${backend_root}/.venv/bin/python"
  else
    backend_python="python3"
  fi
fi

echo "Running ORCID UI flow tests with mocked login and API responses..."
(
  cd "${zombie_root}/web"
  npm test -- --run \
    src/__tests__/orcid-identity.test.js \
    src/__tests__/contributions-add-page.test.js \
    src/__tests__/contributions-view.test.js \
    --reporter=dot
)

echo "Running ORCID API, ownership, and record-linking tests with mocked ORCID/S3..."
(
  cd "${backend_root}"
  "${backend_python}" -m pytest tests/test_contributions.py -q \
    -k 'TestOrcidNameLookupHandler or TestAuthorPostAuth or TestAuthorLinkPostAuth'
)

echo "ORCID resolution checks passed. No live ORCID login or API access was used."
