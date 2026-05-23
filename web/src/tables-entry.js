import { coordinator, wasmConnector } from '@uwdata/vgplot';
import { fetchAndRegisterMetadata } from './lib/metadata.js';
import { SQUIRREL_URL } from './constants.js';
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

function buildView(app, acorns) {
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
  acorns.forEach((a) => {
    const opt = document.createElement('option');
    opt.value = a.name;
    opt.textContent = a.name;
    select.appendChild(opt);
  });
  selectorRow.appendChild(select);

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

  loadBtn.addEventListener('click', async () => {
    const tableName = select.value;
    status.textContent = 'Loading…';
    loadBtn.disabled = true;
    try {
      const result = await coordinator().query(`SELECT * FROM ${tableName}`, { type: 'json' });
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
