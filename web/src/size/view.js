import { escHtml, formatDatetime } from '../lib/utils.js';
import { queryRows } from '../lib/arrow.js';
import { getResolvedBaseUrl } from '../lib/metadata.js';
import { ensureTable } from '../lib/registry.js';
import { buildS3ConsoleUrl, buildQcLink, buildMetadataLink, buildCoLink } from '../assets/links.js';
import * as Plot from '@observablehq/plot';

const STORAGE_LENS_URL = () => {
  const base = getResolvedBaseUrl();
  return base
    ? `${base}/storage_lens.pqt`
    : 'https://allen-data-views.s3.us-west-2.amazonaws.com/data-asset-cache/bdc-v0.37/storage_lens.pqt';
};

function formatBytes(bytes) {
  if (bytes == null) return '—';
  const b = Number(bytes);
  if (isNaN(b)) return '—';
  if (b >= 1e12) return (b / 1e12).toFixed(1) + 'TB';
  if (b >= 1e9)  return (b / 1e9).toFixed(1) + 'GB';
  if (b >= 1e6)  return (b / 1e6).toFixed(1) + 'MB';
  if (b >= 1e3)  return (b / 1e3).toFixed(1) + 'KB';
  return b + 'B';
}

function linkHtml(href, label) {
  if (!href) return '<span class="no-link">—</span>';
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

const ALL_COLUMNS = [
  'size_bytes',
  'subject_id',
  'acquisition_start_time',
  'process_date',
  'project_name',
  'modalities',
  'data_level',
  'acquisition_type',
  'genotype',
  'age',
  'experimenters',
  'instrument_id',
  'location',
  'num_files',
  'storage_class',
  'name',
];

const DEFAULT_COLUMNS = [
  'size_bytes',
  'subject_id',
  'acquisition_start_time',
  'process_date',
  'project_name',
  'modalities',
  'data_level',
  'location',
];

const COLUMN_LABELS = {
  size_bytes: 'Size',
  subject_id: 'Subject',
  acquisition_start_time: 'Acquired (UTC)',
  process_date: 'Processed',
  project_name: 'Project',
  modalities: 'Modalities',
  data_level: 'Level',
  acquisition_type: 'Acquisition Type',
  genotype: 'Genotype',
  age: 'Age (days)',
  experimenters: 'Experimenters',
  instrument_id: 'Instrument ID',
  location: 'Location',
  num_files: 'Files',
  storage_class: 'Storage Class',
  name: 'Asset Name',
};

const SORTABLE_COLS = new Set(ALL_COLUMNS);

export function createSizeView(coord) {
  const container = document.createElement('div');
  container.className = 'assets-view size-view';

  const header = document.createElement('div');
  header.className = 'assets-header';
  header.innerHTML = '<h2>Storage Sizes</h2>';

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'assets-settings-btn icon-btn';
  settingsBtn.setAttribute('aria-label', 'Column settings');
  settingsBtn.innerHTML = '<img src="/icons/gear.svg" alt="Settings" />';
  header.appendChild(settingsBtn);
  container.appendChild(header);

  const loadingEl = document.createElement('p');
  loadingEl.className = 'loading-message';
  loadingEl.textContent = 'Loading storage data…';
  container.appendChild(loadingEl);

  _loadData(coord).then(({ rows, sourceMap }) => {
    loadingEl.remove();
    _buildTable(container, settingsBtn, rows, sourceMap);
  }).catch((err) => {
    loadingEl.textContent = `Failed to load: ${err?.message ?? err}`;
    loadingEl.className = 'loading-message error';
  });

  return container;
}

async function _loadData(coord) {
  const url = STORAGE_LENS_URL();
  const registerSql = `
    CREATE OR REPLACE TABLE storage_lens AS
    SELECT bucket, prefix, storage_class, SUM(size_in_bytes) AS size_in_bytes, SUM(number_of_files) AS number_of_files
    FROM read_parquet('${url}')
    GROUP BY bucket, prefix, storage_class
  `;
  await coord.query(registerSql);
  await ensureTable(coord, 'source_data');

  const sql = `
    SELECT
      ab.name,
      ab.subject_id,
      ab.acquisition_start_time,
      ab.acquisition_end_time,
      ab.project_name,
      ab.modalities,
      ab.data_level,
      ab.acquisition_type,
      ab.genotype,
      ab.age,
      ab.experimenters,
      ab.instrument_id,
      COALESCE(ab.location, 's3://' || sl.bucket || '/' || sl.prefix) AS location,
      ab.code_ocean,
      ab.process_date,
      sl.size_in_bytes AS size_bytes,
      sl.number_of_files AS num_files,
      sl.storage_class,
      sd.source_data
    FROM asset_basics ab
    FULL OUTER JOIN storage_lens sl
      ON ab.location = 's3://' || sl.bucket || '/' || sl.prefix
    LEFT JOIN source_data sd
      ON sd.name = ab.name AND sd.source_data IS NOT NULL AND sd.source_data != ''
    ORDER BY sl.size_in_bytes DESC NULLS LAST
  `;
  const rows = await queryRows(coord, sql);

  const sourceMap = {};
  const cleanRows = rows.map(({ source_data, ...rest }) => {
    if (source_data) {
      sourceMap[rest.name] = String(source_data).split(', ').filter(Boolean);
    }
    return rest;
  });

  return { rows: cleanRows, sourceMap };
}

function _buildProjectChart(allRows) {
  const totals = new Map();
  for (const row of allRows) {
    if (row.size_bytes == null) continue;
    const project = row.project_name || '(no project)';
    totals.set(project, (totals.get(project) ?? 0) + Number(row.size_bytes));
  }

  const data = [...totals.entries()]
    .map(([project, bytes]) => ({ project, bytes }))
    .sort((a, b) => b.bytes - a.bytes);

  const wrapper = document.createElement('div');
  wrapper.className = 'size-chart';

  const heading = document.createElement('h3');
  heading.className = 'size-chart-title';
  heading.textContent = 'Data usage by project';
  wrapper.appendChild(heading);

  if (data.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'loading-message';
    empty.textContent = 'No storage data available.';
    wrapper.appendChild(empty);
    return wrapper;
  }

  const marginBottom = 250;
  const width = container_width(wrapper);
  const chart = Plot.plot({
    width,
    height: Math.round(window.innerHeight * 0.15) + marginBottom,
    marginLeft: 80,
    marginBottom,
    style: { background: 'transparent', fontFamily: 'inherit' },
    x: {
      label: null,
      tickRotate: -45,
    },
    y: {
      label: 'Total size (bytes)',
      tickFormat: (d) => formatBytes(d),
      grid: true,
    },
    marks: [
      Plot.barY(data, {
        x: 'project',
        y: 'bytes',
        sort: { x: 'y', reverse: true },
        fill: 'var(--color-accent, #000000)',
        title: (d) => `${d.project}\n${formatBytes(d.bytes)}`,
      }),
      Plot.ruleY([0]),
    ],
  });
  wrapper.appendChild(chart);
  return wrapper;
}

function container_width(el) {
  const w = el.getBoundingClientRect().width;
  return w > 0 ? w : (document.getElementById('app')?.getBoundingClientRect().width || 900);
}

const UNKNOWN_PROJECTS = new Set(['', '(no project)', 'unknown']);

function isUnknownProject(row) {
  const p = (row.project_name ?? '').toString().trim().toLowerCase();
  return UNKNOWN_PROJECTS.has(p);
}

function _readSimpleCookie(name) {
  const m = ('; ' + document.cookie).split(`; ${name}=`);
  if (m.length < 2) return null;
  return decodeURIComponent(m.pop().split(';')[0]);
}

function _writeSimpleCookie(name, value) {
  const exp = new Date(Date.now() + 365 * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${exp}; path=/; SameSite=Lax`;
}

function _procDateValue(v) {
  if (v == null) return null;
  const t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}

function _findReprocessedAssets(rows) {
  const derived = rows.filter(r => (r.data_level ?? '').toString().toLowerCase() === 'derived');
  const groups = new Map();
  for (const row of derived) {
    const mods = Array.isArray(row.modalities) ? [...row.modalities].sort().join(',') : String(row.modalities ?? '');
    const key = `${row.subject_id ?? ''}|${mods}|${row.acquisition_start_time ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const superseded = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const dated = group.map(r => ({ row: r, t: _procDateValue(r.process_date) }));
    const times = dated.map(d => d.t).filter(t => t != null);
    if (times.length < 2) continue;
    const distinct = new Set(times);
    if (distinct.size < 2) continue;
    const latest = Math.max(...times);
    for (const d of dated) {
      if (d.t != null && d.t < latest) {
        superseded.push({ ...d.row, _latest_process: latest });
      }
    }
  }
  superseded.sort((a, b) => {
    const av = a.size_bytes != null ? Number(a.size_bytes) : -1;
    const bv = b.size_bytes != null ? Number(b.size_bytes) : -1;
    return bv - av;
  });
  return superseded;
}

function _buildReprocessingSection(getRows) {
  let collapsed = true;

  const section = document.createElement('div');
  section.className = 'platform-overview size-reprocess';

  const toggle = document.createElement('button');
  toggle.className = 'platform-qc-toggle';
  toggle.setAttribute('aria-expanded', 'false');

  const arrow = document.createElement('span');
  arrow.className = 'platform-qc-toggle-arrow';
  arrow.textContent = '▶';
  toggle.appendChild(arrow);
  toggle.appendChild(document.createTextNode(' Reprocessed (superseded) derived assets'));
  section.appendChild(toggle);

  const body = document.createElement('div');
  body.className = 'platform-overview-body';
  body.hidden = true;
  section.appendChild(body);

  let page = 0;
  const PAGE_SIZE = 50;

  function renderTable(rows) {
    body.innerHTML = '';

    const info = document.createElement('div');
    info.className = 'assets-count';
    info.textContent = `${rows.length.toLocaleString()} superseded derived asset(s)`;
    body.appendChild(info);

    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'loading-message';
      empty.textContent = 'No reprocessed assets found in the current view.';
      body.appendChild(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'assets-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr>' +
      '<th>Size</th><th>Subject</th><th>Modalities</th>' +
      '<th>Processed</th><th>Latest processed</th><th>Asset Name</th><th class="col-links">Links</th></tr>';
    const tbody = document.createElement('tbody');
    table.appendChild(thead);
    table.appendChild(tbody);
    body.appendChild(table);

    const paging = document.createElement('div');
    paging.className = 'assets-paging';
    body.appendChild(paging);

    function draw() {
      const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      if (page >= totalPages) page = totalPages - 1;
      if (page < 0) page = 0;
      const slice = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
      tbody.innerHTML = slice.map(row => {
        const s3Href = buildS3ConsoleUrl(row.location ?? null);
        const qcHref = buildQcLink(row.name ?? null);
        const metaHref = buildMetadataLink(row.name ?? null);
        const coHref = buildCoLink(row.code_ocean ?? null);
        const sizeBytes = row.size_bytes != null ? Number(row.size_bytes) : null;
        const mods = Array.isArray(row.modalities) ? row.modalities.join(', ') : (row.modalities ?? '');
        return '<tr>' +
          `<td>${sizeBytes != null ? `<span data-bytes="${sizeBytes}">${escHtml(formatBytes(sizeBytes))}</span>` : '<span class="no-link">—</span>'}</td>` +
          `<td><a href="/view?subject_id=${encodeURIComponent(row.subject_id ?? '')}">${escHtml(row.subject_id ?? '')}</a></td>` +
          `<td>${escHtml(mods)}</td>` +
          `<td>${formatDatetime(row.process_date ?? null)}</td>` +
          `<td>${formatDatetime(row._latest_process ?? null)}</td>` +
          `<td><a href="/view?subject_id=${encodeURIComponent(row.subject_id ?? '')}&asset=${encodeURIComponent(row.name ?? '')}">${escHtml(row.name ?? '')}</a></td>` +
          `<td class="link-cell">${linkHtml(s3Href, 'S3')} ${linkHtml(coHref, 'CO')} ${linkHtml(metaHref, 'Meta')} ${linkHtml(qcHref, 'QC')}</td>` +
          '</tr>';
      }).join('');

      paging.innerHTML = '';
      if (totalPages > 1) {
        const prev = document.createElement('button');
        prev.textContent = '← Prev';
        prev.disabled = page === 0;
        prev.addEventListener('click', () => { page--; draw(); });
        const label = document.createElement('span');
        label.textContent = ` Page ${page + 1} of ${totalPages} `;
        const next = document.createElement('button');
        next.textContent = 'Next →';
        next.disabled = page === totalPages - 1;
        next.addEventListener('click', () => { page++; draw(); });
        paging.appendChild(prev);
        paging.appendChild(label);
        paging.appendChild(next);
      }
    }
    draw();
  }

  function build() {
    body.innerHTML = '<p class="loading-message">Scanning for reprocessed assets…</p>';
    page = 0;
    const rows = _findReprocessedAssets(getRows());
    renderTable(rows);
  }

  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    body.hidden = collapsed;
    arrow.textContent = collapsed ? '▶' : '▼';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    if (!collapsed) build();
  });

  return section;
}

function _buildTable(container, settingsBtn, allRows, sourceMap) {
  let sortCol = 'size_bytes';
  let sortDir = 'desc';
  let visibleColumns = [...DEFAULT_COLUMNS, 'links'];
  const filters = Object.fromEntries(ALL_COLUMNS.map(c => [c, '']));
  let page = 0;
  const PAGE_SIZE = 100;

  const HIDE_UNKNOWN_COOKIE = 'size_hide_unknown_projects';
  let hideUnknownProjects = _readSimpleCookie(HIDE_UNKNOWN_COOKIE) === '1';

  let currentChartEl = _buildProjectChart(hideUnknownProjects ? allRows.filter(r => !isUnknownProject(r)) : allRows);
  container.appendChild(currentChartEl);

  function rebuildChart() {
    const next = _buildProjectChart(hideUnknownProjects ? allRows.filter(r => !isUnknownProject(r)) : allRows);
    currentChartEl.replaceWith(next);
    currentChartEl = next;
  }

  // Seed filters from the URL so shared links reproduce the filtered view.
  const urlParams = new URLSearchParams(window.location.search);
  for (const col of ALL_COLUMNS) {
    const v = urlParams.get(`f_${col}`);
    if (v) filters[col] = v;
  }

  function writeFiltersToUrl() {
    const params = new URLSearchParams(window.location.search);
    for (const col of ALL_COLUMNS) {
      if (filters[col]) params.set(`f_${col}`, filters[col]);
      else params.delete(`f_${col}`);
    }
    const qs = params.toString();
    history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }

  // Precomputed lowercased string per column (aligned to allRows index) so
  // per-column filtering doesn't rebuild strings on every keystroke.
  const colStringCache = new Map();
  function getColStrings(col) {
    if (!colStringCache.has(col)) {
      const arr = allRows.map(row => {
        const val = row[col];
        if (val == null) return '';
        return (Array.isArray(val) ? val.join(' ') : String(val)).toLowerCase();
      });
      colStringCache.set(col, arr);
    }
    return colStringCache.get(col);
  }

  const COOKIE = 'size_cols';

  function readCookie() {
    const entry = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`));
    if (!entry) return null;
    const cols = decodeURIComponent(entry.slice(COOKIE.length + 1)).split(',').filter(c => ALL_COLUMNS.includes(c));
    return cols.length > 0 ? cols : null;
  }

  function writeCookie(cols) {
    if (JSON.stringify(cols) === JSON.stringify(DEFAULT_COLUMNS)) {
      document.cookie = `${COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=Lax`;
    } else {
      const exp = new Date(Date.now() + 365 * 864e5).toUTCString();
      document.cookie = `${COOKIE}=${encodeURIComponent(cols.join(','))}; expires=${exp}; path=/; SameSite=Lax`;
    }
  }

  const savedCols = readCookie();
  if (savedCols) visibleColumns = [...savedCols, 'links'];

  const reprocessSection = _buildReprocessingSection(() => getFilteredRows());
  container.appendChild(reprocessSection);

  const countEl = document.createElement('div');
  countEl.className = 'assets-count';
  container.appendChild(countEl);

  const table = document.createElement('table');
  table.className = 'assets-table';
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  table.appendChild(thead);
  table.appendChild(tbody);
  container.appendChild(table);

  const pagingBar = document.createElement('div');
  pagingBar.className = 'assets-paging';
  container.appendChild(pagingBar);

  function getFilteredRows() {
    const active = Object.entries(filters).filter(([, v]) => v);
    const caches = active.map(([col, v]) => [getColStrings(col), v.toLowerCase()]);
    return allRows.filter((row, i) => {
      if (hideUnknownProjects && isUnknownProject(row)) return false;
      return caches.every(([arr, q]) => arr[i].includes(q));
    });
  }

  function sortRowList(rows) {
    return [...rows].sort((a, b) => {
      let av = a[sortCol];
      let bv = b[sortCol];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'bigint') av = Number(av);
      if (typeof bv === 'bigint') bv = Number(bv);
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      const as = Array.isArray(av) ? av.join(', ') : String(av);
      const bs = Array.isArray(bv) ? bv.join(', ') : String(bv);
      return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as);
    });
  }

  function buildGroupedRows(rows) {
    const nameSet = new Set(rows.map(r => r.name));
    const rawRows = [];
    const derivedByRaw = {};

    for (const row of rows) {
      const sources = sourceMap[row.name];
      const knownSources = sources ? sources.filter(s => nameSet.has(s)) : [];
      if (!sources || sources.length === 0 || knownSources.length === 0) {
        rawRows.push(row);
      } else {
        for (const src of knownSources) {
          if (!derivedByRaw[src]) derivedByRaw[src] = [];
          derivedByRaw[src].push(row);
        }
      }
    }

    const assignedDerived = new Set(
      Object.values(derivedByRaw).flat().map(r => r.name)
    );
    const orphans = rows.filter(r => !rawRows.includes(r) && !assignedDerived.has(r.name));

    const sortedRaw = sortRowList(rawRows);
    const groups = [];
    for (const raw of sortedRaw) {
      const group = [{ row: raw, isChild: false }];
      const children = sortRowList(derivedByRaw[raw.name] ?? []);
      for (const child of children) {
        group.push({ row: child, isChild: true });
      }
      groups.push(group);
    }
    for (const orphan of sortRowList(orphans)) {
      groups.push([{ row: orphan, isChild: false }]);
    }
    return groups;
  }

  function renderHeader() {
    const cols = [...visibleColumns];
    thead.innerHTML = `<tr>${cols.map(col => {
      if (col === 'links') return `<th class="col-links"><span class="col-label">Links</span></th>`;
      const label = COLUMN_LABELS[col] ?? col;
      const sortable = SORTABLE_COLS.has(col) ? ' sortable' : '';
      const arrow = sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th class="col-head${sortable}" data-col="${col}">` +
        `<span class="col-label">${label}${arrow}</span>` +
        `<input class="col-filter" type="text" data-col="${col}" placeholder="filter…" value="${escHtml(filters[col] ?? '')}" />` +
        `</th>`;
    }).join('')}</tr>`;

    thead.querySelectorAll('th.sortable').forEach(th => {
      th.querySelector('.col-label').addEventListener('click', () => {
        const col = th.dataset.col;
        if (sortCol === col) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortCol = col;
          sortDir = col === 'size_bytes' ? 'desc' : 'asc';
        }
        page = 0;
        refresh();
      });
    });

    let debounce = null;
    thead.querySelectorAll('.col-filter').forEach(input => {
      input.addEventListener('input', () => {
        filters[input.dataset.col] = input.value.trim();
        clearTimeout(debounce);
        debounce = setTimeout(() => { page = 0; writeFiltersToUrl(); refresh(); }, 200);
      });
    });
  }

  function updateSortArrows() {
    thead.querySelectorAll('th[data-col]').forEach(th => {
      const col = th.dataset.col;
      const labelEl = th.querySelector('.col-label');
      if (!labelEl) return;
      const base = COLUMN_LABELS[col] ?? col;
      const arrow = sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      labelEl.textContent = base + arrow;
    });
  }

  function renderRow(row, isChild = false) {
    const s3Href = buildS3ConsoleUrl(row.location ?? null);
    const qcHref = buildQcLink(row.name ?? null);
    const metaHref = buildMetadataLink(row.name ?? null);
    const coHref = buildCoLink(row.code_ocean ?? null);

    const sizeBytes = row.size_bytes != null ? Number(row.size_bytes) : null;

    const cellValues = {
      size_bytes: sizeBytes != null
        ? `<span data-bytes="${sizeBytes}">${escHtml(formatBytes(sizeBytes))}</span>`
        : '<span class="no-link">—</span>',
      name: row.name
        ? `<a href="/view?subject_id=${encodeURIComponent(row.subject_id ?? '')}&asset=${encodeURIComponent(row.name)}">${isChild ? '↳ ' : ''}${escHtml(row.name)}</a>`
        : '',
      subject_id: `<a href="/view?subject_id=${encodeURIComponent(row.subject_id ?? '')}">${escHtml(row.subject_id ?? '')}</a>`,
      acquisition_start_time: formatDatetime(row.acquisition_start_time ?? null),
      process_date: formatDatetime(row.process_date ?? null),
      project_name: row.project_name
        ? `<a href="/view?project=${encodeURIComponent(row.project_name)}">${escHtml(row.project_name)}</a>`
        : '',
      modalities: Array.isArray(row.modalities) ? escHtml(row.modalities.join(', ')) : escHtml(row.modalities ?? ''),
      data_level: escHtml(row.data_level ?? ''),
      acquisition_type: escHtml(row.acquisition_type ?? ''),
      genotype: escHtml(row.genotype ?? ''),
      age: row.age != null ? String(row.age) : '',
      experimenters: escHtml(Array.isArray(row.experimenters) ? row.experimenters.join(', ') : (row.experimenters ?? '')),
      instrument_id: escHtml(row.instrument_id ?? ''),
      location: escHtml(row.location ?? ''),
      num_files: row.num_files != null ? Number(row.num_files).toLocaleString() : '—',
      storage_class: escHtml(row.storage_class ?? ''),
    };

    const cells = visibleColumns.map(col => {
      if (col === 'links') {
        return `<td class="link-cell">${linkHtml(s3Href, 'S3')} ${linkHtml(coHref, 'CO')} ${linkHtml(metaHref, 'Meta')} ${linkHtml(qcHref, 'QC')}</td>`;
      }
      return `<td>${cellValues[col] ?? ''}</td>`;
    });
    const trClass = isChild ? ' class="asset-derived-row"' : '';
    return `<tr${trClass}>${cells.join('')}</tr>`;
  }

  function refresh() {
    const filtered = getFilteredRows();
    const groups = buildGroupedRows(filtered);
    const total = filtered.length;

    // Paginate over whole groups so a raw + its derived children are never
    // split across a page boundary. Each page holds up to ~PAGE_SIZE rows,
    // but always keeps a group intact.
    const pages = [];
    let current = [];
    for (const group of groups) {
      if (current.length > 0 && current.length + group.length > PAGE_SIZE) {
        pages.push(current);
        current = [];
      }
      current.push(...group);
    }
    if (current.length > 0) pages.push(current);

    const totalPages = pages.length || 1;
    if (page >= totalPages) page = totalPages - 1;
    if (page < 0) page = 0;

    const pageItems = pages[page] ?? [];

    countEl.textContent = `${total.toLocaleString()} assets`;

    updateSortArrows();
    tbody.innerHTML = pageItems.map(({ row, isChild }) => renderRow(row, isChild)).join('');

    pagingBar.innerHTML = '';
    if (totalPages > 1) {
      const prev = document.createElement('button');
      prev.textContent = '← Prev';
      prev.disabled = page === 0;
      prev.addEventListener('click', () => { page--; refresh(); });

      const info = document.createElement('span');
      info.textContent = ` Page ${page + 1} of ${totalPages} `;

      const next = document.createElement('button');
      next.textContent = 'Next →';
      next.disabled = page === totalPages - 1;
      next.addEventListener('click', () => { page++; refresh(); });

      pagingBar.appendChild(prev);
      pagingBar.appendChild(info);
      pagingBar.appendChild(next);
    }
  }

  let settingsOpen = false;

  settingsBtn.addEventListener('click', () => {
    if (settingsOpen) return;
    settingsOpen = true;

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';

    const modal = document.createElement('div');
    modal.className = 'settings-modal';
    modal.innerHTML = `<h3>Visible Columns</h3>`;

    const dataCols = visibleColumns.filter(c => c !== 'links');

    const list = document.createElement('div');
    list.className = 'settings-col-list';

    for (const col of ALL_COLUMNS) {
      const label = COLUMN_LABELS[col] ?? col;
      const checked = dataCols.includes(col);
      const item = document.createElement('label');
      item.className = 'settings-col-item';
      item.innerHTML = `<input type="checkbox" value="${escHtml(col)}" ${checked ? 'checked' : ''} /> ${escHtml(label)}`;
      list.appendChild(item);
    }
    modal.appendChild(list);

    const optHeading = document.createElement('h3');
    optHeading.textContent = 'Options';
    modal.appendChild(optHeading);

    const optList = document.createElement('div');
    optList.className = 'settings-col-list';
    const hideItem = document.createElement('label');
    hideItem.className = 'settings-col-item';
    hideItem.innerHTML = `<input type="checkbox" class="opt-hide-unknown" ${hideUnknownProjects ? 'checked' : ''} /> Hide "(no project)" / "unknown" projects`;
    optList.appendChild(hideItem);
    modal.appendChild(optList);

    const btnRow = document.createElement('div');
    btnRow.className = 'settings-btn-row';

    const applyBtn = document.createElement('button');
    applyBtn.className = 'btn-primary';
    applyBtn.textContent = 'Apply';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';

    btnRow.appendChild(applyBtn);
    btnRow.appendChild(cancelBtn);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
      settingsOpen = false;
    }

    applyBtn.addEventListener('click', () => {
      const selected = [...list.querySelectorAll('input[type=checkbox]:checked')].map(el => el.value);
      const nextHideUnknown = modal.querySelector('.opt-hide-unknown').checked;
      if (nextHideUnknown !== hideUnknownProjects) {
        hideUnknownProjects = nextHideUnknown;
        _writeSimpleCookie(HIDE_UNKNOWN_COOKIE, hideUnknownProjects ? '1' : '0');
        rebuildChart();
      }
      if (selected.length > 0) {
        visibleColumns = [...selected, 'links'];
        writeCookie(selected);
        renderHeader();
      }
      page = 0;
      refresh();
      close();
    });

    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  });

  renderHeader();
  refresh();
}
