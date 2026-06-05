import { coordinator, wasmConnector } from '@uwdata/vgplot';
import { fetchAndRegisterMetadata, s3PathToHttps } from './lib/metadata.js';
import { SQUIRREL_URL, S3_REGION } from './constants.js';
import { escHtml, filterRows } from './lib/utils.js';

const PAGE_SIZE = 100;

async function init() {
  const loadingEl = document.getElementById('loading-message');
  const app = document.getElementById('app');
  if (!app) return;

  try {
    coordinator().databaseConnector(wasmConnector());
    const metadata = await fetchAndRegisterMetadata(coordinator(), SQUIRREL_URL);
    if (loadingEl) loadingEl.remove();
    buildView(app, metadata.acorns);
  } catch (err) {
    if (loadingEl) {
      loadingEl.textContent = `Failed to load: ${err?.message ?? err}`;
      loadingEl.className = 'loading-message error';
    }
  }
}

/**
 * Fetch the list of hive-partition values for a partitioned acorn by doing an
 * S3 ListObjectsV2 request against the acorn's directory prefix.
 *
 * @param {string} s3Location  - e.g. "s3://bucket/path/zs_qc/"
 * @param {string} partitionKey - e.g. "subject_id"
 * @returns {Promise<{values:string[], truncated:boolean}|null>}
 *   null when the listing request fails (e.g. CORS not permitted).
 */
async function listS3Partitions(s3Location, partitionKey) {
  const m = s3Location.match(/^s3:\/\/([^/]+)\/?(.*)/);
  if (!m) return null;
  const [, bucket, keyPrefix] = m;
  const prefix = keyPrefix.replace(/\/+$/, '') + '/';
  const listUrl =
    `https://${bucket}.s3.${S3_REGION}.amazonaws.com/` +
    `?list-type=2&prefix=${prefix}&delimiter=/&max-keys=1000`;

  let resp;
  try {
    resp = await fetch(listUrl);
  } catch {
    return null;
  }
  if (!resp.ok) return null;

  const xml = await resp.text();
  // Escape the key so it is safe to use in a RegExp
  const escapedKey = partitionKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyRe = new RegExp(`${escapedKey}=([^/]+)/`);
  const tagRe = /<Prefix>([^<]+)<\/Prefix>/g;
  const values = [];
  let match;
  while ((match = tagRe.exec(xml)) !== null) {
    const partMatch = match[1].match(keyRe);
    if (partMatch) values.push(decodeURIComponent(partMatch[1]));
  }

  const truncated = /<IsTruncated>true<\/IsTruncated>/i.test(xml);
  values.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { values, truncated };
}

function buildView(app, acorns) {
  const acornMap = new Map(acorns.map((a) => [a.name, a]));

  const container = document.createElement('div');
  container.className = 'assets-view';
  container.style.padding = '1.5rem';

  const heading = document.createElement('h2');
  heading.textContent = 'Tables';
  container.appendChild(heading);

  // Table selector
  const selectorRow = document.createElement('div');
  selectorRow.style.cssText = 'display:flex;gap:0.75rem;align-items:center;margin-bottom:1rem;flex-wrap:wrap;';

  const select = document.createElement('select');
  select.style.cssText = 'font-size:1rem;padding:0.3rem 0.5rem;';
  for (const a of acorns) {
    const opt = document.createElement('option');
    opt.value = a.name;
    opt.textContent = a.partitioned ? `${a.name} (partitioned by ${a.partition_key})` : a.name;
    select.appendChild(opt);
  }
  selectorRow.appendChild(select);

  // Partition selector — shown only when a partitioned table is selected
  const partWrap = document.createElement('span');
  partWrap.style.display = 'none';

  const partLabel = document.createElement('label');
  partLabel.style.cssText = 'font-size:0.9rem;color:var(--text-secondary);white-space:nowrap;';
  partWrap.appendChild(partLabel);

  // Inner container replaced with either a <select> or <input> dynamically
  const partInputWrap = document.createElement('span');
  partWrap.appendChild(partInputWrap);
  selectorRow.appendChild(partWrap);

  const loadBtn = document.createElement('button');
  loadBtn.className = 'page-btn';
  loadBtn.textContent = 'Load';
  selectorRow.appendChild(loadBtn);

  const status = document.createElement('span');
  status.style.cssText = 'color:var(--text-muted,#888);font-size:0.9rem;';
  selectorRow.appendChild(status);

  container.appendChild(selectorRow);

  // Filter bar (hidden until table loaded)
  const filterBar = document.createElement('div');
  filterBar.style.cssText = 'display:none;margin-bottom:0.75rem;';
  const filterInput = document.createElement('input');
  filterInput.type = 'text';
  filterInput.placeholder = 'Filter all columns…';
  filterInput.className = 'col-filter';
  filterInput.style.cssText = 'width:100%;max-width:400px;font-size:0.9rem;padding:0.3rem 0.5rem;';
  filterBar.appendChild(filterInput);
  container.appendChild(filterBar);

  // Table area
  const tableWrap = document.createElement('div');
  tableWrap.style.cssText = 'overflow-x:auto;';
  const table = document.createElement('table');
  table.className = 'assets-table';
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  table.appendChild(thead);
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  container.appendChild(tableWrap);

  const pagingBar = document.createElement('div');
  pagingBar.className = 'assets-paging';
  container.appendChild(pagingBar);

  app.appendChild(container);

  let allRows = [];
  let columns = [];
  let filterText = '';
  let page = 0;

  function filteredRows() {
    if (!filterText) return allRows;
    const lower = filterText.toLowerCase();
    return allRows.filter((row) =>
      columns.some((col) => String(row[col] ?? '').toLowerCase().includes(lower))
    );
  }

  function render() {
    const rows = filteredRows();
    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (page >= totalPages) page = totalPages - 1;

    const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    tbody.innerHTML = pageRows.map((row) =>
      `<tr>${columns.map((col) => `<td>${escHtml(String(row[col] ?? ''))}</td>`).join('')}</tr>`
    ).join('');

    const start = rows.length === 0 ? 0 : page * PAGE_SIZE + 1;
    const end = Math.min((page + 1) * PAGE_SIZE, rows.length);
    pagingBar.innerHTML = `
      <button class="page-btn" id="tbl-prev" ${page === 0 ? 'disabled' : ''}>‹ Prev</button>
      <span class="page-info">${start}–${end} of ${rows.length.toLocaleString()}</span>
      <button class="page-btn" id="tbl-next" ${page >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>
    `;
    pagingBar.querySelector('#tbl-prev').addEventListener('click', () => { page--; render(); });
    pagingBar.querySelector('#tbl-next').addEventListener('click', () => { page++; render(); });
  }

  filterInput.addEventListener('input', () => {
    filterText = filterInput.value;
    page = 0;
    render();
  });

  // When the table selection changes, show/hide the partition selector
  async function onTableChange() {
    const acorn = acornMap.get(select.value);
    if (!acorn) return;

    // Clear any existing table output
    thead.innerHTML = '';
    tbody.innerHTML = '';
    filterBar.style.display = 'none';
    filterInput.value = '';
    filterText = '';
    allRows = [];
    columns = [];
    pagingBar.innerHTML = '';

    if (acorn.partitioned) {
      partLabel.textContent = `${acorn.partition_key}:`;
      partInputWrap.innerHTML =
        '<span style="font-size:0.9rem;color:var(--text-muted,#888);margin-left:0.4rem;">Loading…</span>';
      partWrap.style.display = '';
      loadBtn.disabled = true;
      status.textContent = '';

      const result = await listS3Partitions(acorn.location, acorn.partition_key);

      if (result && result.values.length > 0) {
        const partSelect = document.createElement('select');
        partSelect.style.cssText = 'font-size:1rem;padding:0.3rem 0.5rem;margin-left:0.4rem;';
        for (const v of result.values) {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = v;
          partSelect.appendChild(opt);
        }
        partInputWrap.innerHTML = '';
        partInputWrap.appendChild(partSelect);
        status.textContent =
          `${result.values.length} partition${result.values.length !== 1 ? 's' : ''}` +
          (result.truncated ? ' (first 1000 shown)' : '');
        loadBtn.disabled = false;
      } else {
        // S3 listing failed or empty — show a text input as fallback
        const partInput = document.createElement('input');
        partInput.type = 'text';
        partInput.placeholder = `Enter ${acorn.partition_key} value`;
        partInput.style.cssText =
          'font-size:1rem;padding:0.3rem 0.5rem;margin-left:0.4rem;width:200px;';
        partInputWrap.innerHTML = '';
        partInputWrap.appendChild(partInput);
        status.textContent = result ? 'No partitions found' : 'Could not list partitions';
        loadBtn.disabled = true;
        partInput.addEventListener('input', () => {
          loadBtn.disabled = !partInput.value.trim();
        });
      }
    } else {
      partWrap.style.display = 'none';
      loadBtn.disabled = false;
      status.textContent = '';
    }
  }

  select.addEventListener('change', onTableChange);
  onTableChange();

  loadBtn.addEventListener('click', async () => {
    const acorn = acornMap.get(select.value);
    if (!acorn) return;

    let sql;
    if (acorn.partitioned) {
      const input = partInputWrap.querySelector('select, input');
      const partValue = input ? input.value.trim() : '';
      if (!partValue) {
        status.textContent = 'Please select a partition';
        return;
      }
      const base = s3PathToHttps(acorn.location.replace(/\/+$/, ''));
      // Escape single quotes in path components to prevent SQL injection
      const safePath =
        `${base}/${acorn.partition_key}=${partValue}/*.pqt`.replace(/'/g, "''");
      sql = `SELECT * FROM read_parquet('${safePath}', hive_partitioning=true, union_by_name=true)`;
    } else {
      const httpsUrl = s3PathToHttps(acorn.location).replace(/'/g, "''");
      sql = `SELECT * FROM read_parquet('${httpsUrl}')`;
    }

    status.textContent = 'Loading…';
    loadBtn.disabled = true;
    try {
      const result = await coordinator().query(sql, { type: 'json' });
      allRows = Array.isArray(result) ? result
        : Array.isArray(result?.data) ? result.data
        : Array.from(result ?? []);
      columns = allRows.length > 0 ? Object.keys(allRows[0]) : [];
      thead.innerHTML = `<tr>${columns.map((c) => `<th><span class="col-label">${escHtml(c)}</span></th>`).join('')}</tr>`;
      filterBar.style.display = '';
      filterInput.value = '';
      filterText = '';
      page = 0;
      status.textContent = `${allRows.length.toLocaleString()} rows`;
      render();
    } catch (err) {
      status.textContent = `Error: ${err?.message ?? err}`;
    }
    loadBtn.disabled = false;
  });
}

init();
